import { syntaxTree } from "@codemirror/language";
import { ChangeSet, EditorSelection, EditorState, Transaction } from "@codemirror/state";

export const formatKeys = Object.freeze({ b: "**", i: "*" });

export function backtickFence(text, minimum) {
  let size = minimum;
  for (const [run] of text.matchAll(/`+/g)) size = Math.max(size, run.length + 1);
  return "`".repeat(size);
}

export function codeSpan(text) {
  const value = text.replace(/\r?\n/g, " ");
  const fence = backtickFence(value, 1);
  const pad = /^`|`$/.test(value) || /^ .* $/s.test(value) && /[^ ]/.test(value) ? " " : "";
  return { before: fence + pad, value, after: pad + fence };
}

export function inlineCodeChange(doc, tree, { from, to }, displayed) {
  for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
    if (node.name !== "InlineCode" || to > node.to) continue;
    const [open, close] = node.getChildren("CodeMark");
    const raw = doc.sliceString(open.to, close.from);
    const padded = /^ .* $/s.test(raw) && /[^ ]/.test(raw);
    const start = open.to + Number(padded);
    const insert = raw.slice(Number(padded), raw.length - Number(padded));
    const map = (pos) => node.from + Math.max(0, Math.min(pos - start, insert.length));
    return { change: { from: node.from, to: node.to, insert }, map };
  }
  if (from === to) return;
  const { before, value, after } = codeSpan(displayed ?? doc.sliceString(from, to));
  return { change: { from, to, insert: before + value + after },
    map: (pos) => from + before.length + (pos === to ? value.length : pos - from) };
}

export function formatField(field, marker, parser) {
  const { selectionStart: from, selectionEnd: to, selectionDirection, value } = field;
  const backward = selectionDirection === "backward";
  const state = EditorState.create({ doc: value, selection: {
    anchor: backward ? to : from, head: backward ? from : to,
  } });
  const type = marker.length === 2 ? "StrongEmphasis" : "Emphasis";
  toggleFormatting(marker, type, parser.parse(value))({
    state,
    dispatch(spec) {
      const transaction = state.update(spec);
      const selection = transaction.newSelection.main;
      field.setRangeText(transaction.newDoc.toString(), 0, value.length);
      field.setSelectionRange(selection.from, selection.to, selectionDirection);
    },
  });
}

function applyFormatting(state, tree, marker, type, { from, to, head, anchor }) {
  if (from === to) return { changes: { from, insert: marker + marker },
    range: EditorSelection.cursor(from + marker.length) };

  const raw = state.doc.sliceString(from, to);
  if (!raw.trim()) return { range: EditorSelection.range(anchor, head) };
  let start = from + raw.length - raw.trimStart().length;
  let end = from + raw.trimEnd().length;
  [start, end] = expandInlineEdges(tree, type, start, end);
  const oldMarkers = [];
  tree.iterate({ from: start, to: end, enter({ name, node }) {
    if (name !== type) return;
    const [open, close] = node.getChildren("EmphasisMark");
    if (!open || !close || open.to >= end || close.from <= start) return;
    oldMarkers.push({ from: open.from, to: open.to }, { from: close.from, to: close.to });
    start = Math.min(start, node.from);
    end = Math.max(end, node.to);
  } });

  // Same-style delimiters inside the selection would close the new span.
  // Merge overlapping spans and keep the selection at its original text.
  const stripped = state.changes(oldMarkers);
  const wrapping = ChangeSet.of([
    { from: stripped.mapPos(start), insert: marker },
    { from: stripped.mapPos(end), insert: marker },
  ], stripped.newLength);
  const changes = stripped.compose(wrapping);
  const left = changes.mapPos(from, 1);
  const right = changes.mapPos(to, -1);
  return { changes, range: head < anchor ? EditorSelection.range(right, left) : EditorSelection.range(left, right) };
}

function expandInlineEdges(tree, type, start, end) {
  const indivisible = new Set(["Link", "InlineCode", "Emphasis", "StrongEmphasis", "Strikethrough"]);
  for (let node = tree.resolveInner(start, 1); node; node = node.parent) {
    if (node.name !== type && indivisible.has(node.name) && start > node.from && end >= node.to) start = node.from;
  }
  for (let node = tree.resolveInner(end, -1); node; node = node.parent) {
    if (node.name !== type && indivisible.has(node.name) && start <= node.from && end < node.to) end = node.to;
  }
  return [start, end];
}

function selectedBlocks(doc, tree, from, to) {
  if (from === to) return [{ from, to }];
  const blocks = [];
  tree.iterate({ from, to, enter({ name, node }) {
    if (!/^(?:Paragraph|Task|TableCell|(?:ATX|Setext)Heading[1-6])$/.test(name)) return;
    const start = Math.max(from, node.getChild("TaskMarker")?.to ?? node.from,
      name.startsWith("ATX") ? node.getChild("HeaderMark")?.to ?? node.from : node.from);
    const close = node.getChildren("HeaderMark").at(-1);
    const end = Math.min(to, close && close.from > node.from ? close.from : node.to);
    if (start < end && doc.sliceString(start, end).trim()) blocks.push({ from: start, to: end });
    return false;
  } });
  return blocks;
}

function containingStyle(tree, type, from, to) {
  for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
    if (node.name !== type || to > node.to) continue;
    const [open, close] = node.getChildren("EmphasisMark");
    if (open && close) return [open, close];
  }
}

export function toggleFormatting(marker, nodeType, parsedTree) {
  return (view) => {
    if (view.state.readOnly) return false;
    const selection = view.state.selection.main;
    const tree = parsedTree ?? syntaxTree(view.state);
    for (let node = tree.resolveInner(selection.from, 1); node; node = node.parent) {
      if (["FencedCode", "CodeBlock", "InlineCode"].includes(node.name) && selection.to <= node.to) return false;
    }
    view.dispatch({
      ...view.state.changeByRange(({ from, to, head, anchor }) => {
        const blocks = selectedBlocks(view.state.doc, tree, from, to);
        const styles = blocks.map((block) => containingStyle(tree, nodeType, block.from, block.to));
        if (styles.length === 1 && styles[0]) {
          const [open, close] = styles[0];
          const changes = view.state.changes([{ from: open.from, to: open.to }, { from: close.from, to: close.to }]);
          return { changes, range: EditorSelection.range(changes.mapPos(anchor), changes.mapPos(head)) };
        }
        if (blocks.length === 1 && blocks[0].from === from && blocks[0].to === to) {
          return applyFormatting(view.state, tree, marker, nodeType, { from, to, head, anchor });
        }
        const edits = [];
        if (styles.every(Boolean)) {
          for (const marks of styles) for (const { from, to } of marks) edits.push({ from, to });
        } else {
          blocks.forEach((block, index) => {
            if (styles[index]) return;
            const { changes } = applyFormatting(view.state, tree, marker, nodeType,
              { ...block, anchor: block.from, head: block.to });
            changes?.iterChanges((from, to, _start, _end, insert) => edits.push({ from, to, insert }));
          });
        }
        const changes = view.state.changes(edits);
        const left = changes.mapPos(from, 1);
        const right = changes.mapPos(to, -1);
        return { changes, range: head < anchor ? EditorSelection.range(right, left) : EditorSelection.range(left, right) };
      }),
      annotations: Transaction.userEvent.of("input.format"),
    });
    return true;
  };
}
