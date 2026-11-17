import { ensureSyntaxTree } from "@codemirror/language";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import { backtickFence, codeSpan, formatField, formatKeys, inlineCodeChange, toggleFormatting } from "./formatting.js";
import { createLinkForm, markdownLink } from "./link-editing.js";
import { blockShortcut, continuationPrefix, listIndent, listPrefixAt, removeListPrefix } from "./list-editing.js";
import { followLink } from "./navigation.js";
import { previewSourceMap, tableRows } from "./source-map.js";
import { addColumn, addRow, cellChange } from "./table-editing.js";
import { caretRectangle, codeCaretRectangle, pointAt, verticalDestination } from "./vertical-caret.js";
import { highlightInto } from "./upstream/code-highlight.ts";
import { renderMarkdown } from "./upstream/openidea-render.ts";

const blockCommands = [
  { id: "code", label: "Code block", shortcut: "⌘⇧⌥C", search: "code block код блок" },
  { id: "table", label: "Table", search: "table таблица" },
  { id: "task", label: "Checklist", search: "checklist task checkbox список чекбокс задача" },
];

function caretIn(element, point) {
  if (!point || !element.contains(point.node)) return element.textContent.length;
  const prefix = element.ownerDocument.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(point.node, point.offset);
  return prefix.toString().length;
}

function colorCode(code, text) {
  const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9);
  // Highlight on a detached node. An older grammar result must not replace a newer edit.
  const copy = code.ownerDocument.createElement("code");
  code.textContent = text;
  void highlightInto(copy, text, language ?? null).then(() => {
    if (copy.hasChildNodes() && code.textContent === text) code.replaceChildren(...copy.childNodes);
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const proseBlockSelector = "p, li, h1, h2, h3, h4, h5, h6";

function textBlockAt(tree, position, side) {
  for (let node = tree.resolveInner(position, side); node; node = node.parent) {
    if (/^(?:Paragraph|Task|(?:ATX|Setext)Heading[1-6])$/.test(node.name)) return node;
  }
}

function sameBlock(left, right) {
  return left && right && left.from === right.from && left.to === right.to;
}

function tableAt(tree, position, side) {
  for (let node = tree.resolveInner(position, side); node; node = node.parent) {
    if (node.name === "Table") return node;
  }
}

function selectionMarks(doc, tree, from, to, hasText) {
  let left = "";
  let right = "";
  for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
    const marks = inlineMarks(node);
    if (!marks || from < marks[0].to || from > marks[1].from) continue;
    if (!hasText && from === marks[0].to && to >= marks[1].from) {
      from = node.from;
      if (to === marks[1].from) to = node.to;
    } else if (to >= node.to) left += doc.sliceString(marks[1].from, marks[1].to);
  }
  for (let node = tree.resolveInner(to, -1); node; node = node.parent) {
    const marks = inlineMarks(node);
    if (!marks || to < marks[0].to || to > marks[1].from || from > node.from) continue;
    if (to === marks[1].from) to = node.to;
    else right = doc.sliceString(marks[0].from, marks[0].to) + right;
  }
  return { from, to, left, right };
}

function inlineMarks(node) {
  const which = { Strikethrough: "StrikethroughMark", InlineCode: "CodeMark" }[node.name] ?? "EmphasisMark";
  const marks = node.getChildren(which);
  if (marks.length === 2) return marks;
  if (node.name !== "Link") return null;
  const [open, close] = node.getChildren("LinkMark");
  return open && close ? [open, { from: close.from, to: node.to }] : null;
}

function trailingParagraphPrefix(doc, position) {
  if (!position) return "";
  const line = doc.lineAt(position);
  if (line.text.trim()) return "\n\n";
  return line.number > 1 && doc.line(line.number - 1).text.trim() ? "\n" : "";
}

function inputEventName(event) {
  const type = event.inputType ?? "";
  if (type === "insertCompositionText") return "input.type.compose";
  if (type.startsWith("delete")) return "delete";
  if (type === "insertFromPaste") return "input.paste";
  return "input.type";
}

function growCodeFences({ fence, field, to }, changes) {
  let length = fence.openLength;
  // Tabs can count as fewer than four columns after a list or quote prefix.
  for (const [, run] of field.value.matchAll(/^(?: {0,3}|[ \t]*\t[ \t]*)(`+|~+)[ \t]*$/gm)) {
    if (run[0] === fence.marker) length = Math.max(length, run.length + 1);
  }
  const growth = length - fence.openLength;
  if (!growth) return 0;

  changes.unshift({ from: fence.openFrom, insert: fence.marker.repeat(growth) });
  if (fence.closeLength && length > fence.closeLength) {
    changes.push({ from: to + fence.closeGap, insert: fence.marker.repeat(length - fence.closeLength) });
    fence.closeLength = length;
  }
  fence.openLength = length;
  return growth;
}

function moveFieldCaret(field, event) {
  if (!(event.metaKey || event.altKey) || !/^Arrow/.test(event.key)) return false;
  const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
  const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
  const { selectionStart: start, selectionEnd: end, selectionDirection, value } = field;
  const head = selectionDirection === "backward" ? start : end;
  const anchor = selectionDirection === "backward" ? end : start;
  let next;
  if (event.metaKey && vertical) next = backward ? 0 : value.length;
  else if (event.metaKey) {
    next = backward ? (head === 0 ? 0 : value.lastIndexOf("\n", head - 1) + 1) : value.indexOf("\n", head);
    if (next < 0) next = value.length;
  } else if (!vertical) {
    const run = backward ? value.slice(0, head).match(/[\p{L}\p{N}_]+[^\p{L}\p{N}_]*$|[^\p{L}\p{N}_]+$/u)
      : value.slice(head).match(/^[^\p{L}\p{N}_]*[\p{L}\p{N}_]+|^[^\p{L}\p{N}_]+/u);
    next = head + (backward ? -1 : 1) * (run?.[0].length ?? 0);
  } else return false;
  event.preventDefault();
  const other = event.shiftKey ? anchor : next;
  field.setSelectionRange(Math.min(next, other), Math.max(next, other), next < other ? "backward" : "forward");
  return true;
}

export function mountNativePreview(root, view, parser) {
  const document = root.ownerDocument;
  let renderedDoc;
  let source;
  let active;
  let writing = false;
  let linkForm;
  let selectedBlock = false;
  let selectedDocument = false;
  let columnX;
  let verticalSelection;
  let slash;
  let pointerEdit;
  const details = new Map();

  function render() {
    if (root.hidden) return;
    const oldBlocks = [...root.querySelectorAll("pre")];
    const scrolled = oldBlocks.map((block) => block.scrollLeft);
    const top = root.scrollTop;
    root.innerHTML = renderMarkdown(view.state.doc.toString());
    slash = undefined;
    linkForm = undefined;
    selectedDocument = false;
    renderedDoc = view.state.doc;
    source = previewSourceMap(root, renderedDoc, parser.parse(renderedDoc.toString()));
    [...root.querySelectorAll("details")].forEach((element, index) => {
      if (details.has(index)) element.open = details.get(index);
    });
    root.querySelectorAll("pre > code").forEach((code) => {
      if (!code.closest("[data-mermaid]")) colorCode(code, code.textContent.replace(/\n+$/, ""));
    });
    root.querySelectorAll("img[data-src]").forEach((image) => {
      if (/^data:image\/(?:png|gif|jpe?g|webp|avif);base64,/i.test(image.dataset.src)) image.src = image.dataset.src;
      else image.classList.add("blocked");
    });
    if (!view.state.readOnly) {
      for (const [item, { task, content }] of source.emptyItems) {
        item.classList.add("md-empty-item");
        if (!task) continue;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = /x/i.test(renderedDoc.sliceString(task.from, task.to));
        content.replaceChildren(box, " ");
        source.tasks.push({ box, at: task.from + 1 });
      }
      source.tasks.forEach(({ box, at }) => {
        box.disabled = false;
        box.setAttribute("aria-label", "Toggle task");
        box.addEventListener("change", () => {
          const checked = box.checked;
          const edit = active;
          const oldLength = renderedDoc.length;
          finish();
          const end = edit?.kind === "cell" ? edit.row.end : edit?.originalTo;
          const position = at + (end !== undefined && at >= end ? view.state.doc.length - oldLength : 0);
          if (!/^\[[ xX]\]$/.test(view.state.doc.sliceString(position - 1, position + 2))) return;
          dispatch({ from: position, to: position + 1, insert: checked ? "x" : " " });
          render();
          source.tasks.find(({ at }) => at === position)?.box.focus({ preventScroll: true });
        });
      });
      source.tables.forEach((table, index) => {
        for (const row of table.element.rows) for (const cell of row.cells) cell.tabIndex = 0;
        const controls = document.createElement("div");
        controls.className = "md-table-controls";
        controls.innerHTML = '<button type="button" title="Add table row">+ Row</button>' +
          '<button type="button" title="Add table column">+ Column</button>' +
          '<button type="button">Delete Table</button>';
        const [row, column, remove] = controls.children;
        row.addEventListener("click", () => extendTable(index, false));
        column.addEventListener("click", () => extendTable(index, true));
        remove.addEventListener("click", () => {
          finish();
          const table = source.tables[index];
          if (table && !view.state.readOnly) removeBlock(table.node);
        });
        table.element.after(controls);
      });
    }
    if (!view.state.readOnly) source.codeBlocks.forEach(({ element }) => { element.parentElement.tabIndex = 0; });
    root.scrollTop = top;
    root.querySelectorAll("pre").forEach((block, index) => { block.scrollLeft = scrolled[index] ?? 0; });
  }

  function dispatch(changes, userEvent = "input.preview", caret) {
    writing = true;
    try {
      view.dispatch({ changes, selection: caret === undefined ? undefined : { anchor: caret },
        annotations: userEvent === "delete.block"
          ? [Transaction.userEvent.of(userEvent), isolateHistory.of("full")]
          : Transaction.userEvent.of(userEvent) });
    } finally {
      writing = false;
    }
  }

  function extendTable(index, column) {
    finish();
    const table = source.tables[index];
    if (!table || view.state.readOnly || view.state.doc !== renderedDoc) return;
    const lastColumn = table.element.rows[0].cells.length;
    dispatch(column ? addColumn(table, renderedDoc) : addRow(table, renderedDoc));
    render();
    const updated = source.tables[index]?.element;
    const cell = column ? updated?.rows[0]?.cells[lastColumn] : updated?.rows[updated.rows.length - 1]?.cells[0];
    if (cell) enterCell(cell, null);
  }

  function finish({ cancel = false, redraw = true } = {}) {
    const edit = active;
    if (!edit) return;
    closeSlash();
    active = undefined;
    if (edit.kind === "cell" && !cancel && !view.state.readOnly && view.state.doc === renderedDoc &&
        edit.field.value !== edit.original) {
      dispatch(cellChange(edit.row, edit.column, edit.field.value, view.state.doc));
    }
    // Retain the active DOM on an unchanged text edit so a subsequent click can
    // still find its text node. Table and code overlays always need removal.
    if (edit.kind === "text" && !edit.placeholder && view.state.doc === renderedDoc) {
      const text = edit.field.firstChild;
      if (text) source.ranges.set(text, { from: edit.from, to: edit.to });
      edit.field.replaceWith(text ?? document.createTextNode(""));
    } else if (redraw) {
      render();
    }
  }

  function activate(field, edit) {
    active = { ...edit, field };
    field.addEventListener("beforeinput", () => {
      if (active?.field !== field) return;
      if (edit.kind === "code" && active.last === field.value) {
        active.changedAt = field.selectionStart;
      } else if (edit.kind === "text") {
        const selection = document.getSelection();
        const before = selection.rangeCount ? selection.getRangeAt(0) : null;
        if (before && field.contains(before.startContainer)) {
          active.changedAt = caretIn(field, { node: before.startContainer, offset: before.startOffset });
        }
      }
    });
    field.addEventListener("blur", (event) => {
      // A table control attached to the current render needs to receive its
      // click before the table is re-rendered with the edited cell.
      if (event.relatedTarget?.closest(".md-table-controls")) return;
      if (active?.field === field && pointerEdit !== active) finish();
    });
  }

  function editValue(edit, insert, event) {
    if (view.state.readOnly || view.state.doc.sliceString(edit.from, edit.to) !== edit.last) return;
    const before = edit.last;
    if (before === insert) return;
    if (edit.kind === "text" && !insert && event.inputType?.startsWith("delete")) {
      replaceSelection(edit, "", "delete");
      return;
    }
    if (edit.pending) {
      const { before: prefix, value, after: suffix } = edit.pending(insert);
      dispatch({ from: edit.from, insert: prefix + value + suffix }, inputEventName(event),
        edit.from + prefix.length + value.length);
      edit.from += prefix.length;
      edit.to = edit.from + value.length;
      edit.last = value;
      edit.pending = undefined;
      return;
    }
    // Diff only the edited span, so undo and other views receive precise changes.
    let start = 0;
    let limit = edit.changedAt ?? before.length;
    edit.changedAt = undefined;
    if (event.inputType?.startsWith("delete")) {
      if (edit.kind === "code" && edit.field.value === insert) limit = Math.min(limit, edit.field.selectionStart);
      else if (edit.kind === "text") {
        const selection = document.getSelection();
        if (edit.field.contains(selection.focusNode)) {
          limit = Math.min(limit, caretIn(edit.field, { node: selection.focusNode, offset: selection.focusOffset }));
        }
      }
    }
    while (start < limit && start < before.length && start < insert.length && before[start] === insert[start]) start++;
    let end = before.length;
    let newEnd = insert.length;
    while (end > start && newEnd > start && before[end - 1] === insert[newEnd - 1]) { end--; newEnd--; }
    const changes = [{ from: edit.from + start, to: edit.from + end, insert: insert.slice(start, newEnd) }];
    const growth = edit.fence ? growCodeFences(edit, changes) : 0;
    dispatch(changes, inputEventName(event), edit.from + growth + newEnd);
    edit.from += growth;
    edit.to = edit.from + insert.length;
    edit.last = insert;
  }

  function makeField(label, value) {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("aria-label", label);
    field.spellcheck = false;
    return field;
  }

  function enterCell(cell, point) {
    const table = source.tables.find(({ element }) => element === cell.closest("table"));
    const row = table?.rows[cell.parentElement.rowIndex];
    if (!row) return;
    const column = cell.cellIndex;
    const range = row.cells[column];
    const original = range ? view.state.doc.sliceString(range.from, range.to) : "";
    const mapped = point && source.ranges.get(point.node);
    const caret = mapped && range ? mapped.from - range.from + point.offset :
      (original === cell.textContent ? caretIn(cell, point) : original.length);
    const field = makeField("Edit table cell Markdown", original);
    field.className = "md-cell-editor";
    const displayed = document.createElement("span");
    displayed.hidden = true;
    displayed.append(...cell.childNodes);
    const mirror = document.createElement("span");
    mirror.className = "md-cell-mirror";
    mirror.setAttribute("aria-hidden", "true");
    const layer = document.createElement("span");
    layer.className = "md-cell-input";
    layer.append(mirror, field);
    cell.classList.add("md-cell-active");
    cell.append(displayed, layer);
    const sizeCell = () => {
      mirror.textContent = field.value + "\u200b";
      field.style.height = "0";
      field.style.height = `${field.scrollHeight}px`;
    };
    field.addEventListener("input", sizeCell);
    sizeCell();
    activate(field, { kind: "cell", row, column, original });
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, caret);
    field.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const marker = formatKeys[key];
        if (event.shiftKey && (key === "c" || event.code === "KeyC")) {
          event.preventDefault();
          const { selectionStart: from, selectionEnd: to, selectionDirection, value } = field;
          const doc = { sliceString: (start, end) => value.slice(start, end) };
          const result = inlineCodeChange(doc, parser.parse(value), { from, to });
          if (result) {
            const { change, map } = result;
            field.setRangeText(change.insert, change.from, change.to);
            field.setSelectionRange(map(from), map(to), selectionDirection);
          }
        } else if (marker) {
          event.preventDefault();
          formatField(field, marker, parser);
        } else if (key === "s" || key === "w") {
          finish();
          if (key === "s") root.focus({ preventScroll: true });
        }
        sizeCell();
        return;
      }
      if (key !== "escape" && key !== "tab" && (key !== "enter" || event.shiftKey)) return;
      const tableIndex = source.tables.indexOf(table);
      const cellIndex = [...table.element.querySelectorAll("th, td")].indexOf(cell);
      const next = key === "tab" ? cellIndex + (event.shiftKey ? -1 : 1) : -1;
      event.preventDefault();
      finish({ cancel: key === "escape" });
      const nextCell = source.tables[tableIndex]?.element.querySelectorAll("th, td")[next];
      if (nextCell) enterCell(nextCell, null);
      else root.focus({ preventScroll: true });
    });
  }

  function enterCode(code, point, restoredOffset) {
    const range = source.codeBlocks.find(({ element }) => element === code);
    if (!range) return;
    const pre = code.parentElement;
    const scroll = pre.scrollLeft;
    const caret = restoredOffset ?? caretIn(code, point);
    const original = view.state.doc.sliceString(range.from, range.to);
    const [open, close] = range.node.getChildren("CodeMark");
    const fence = open && {
      marker: view.state.doc.sliceString(open.from, open.from + 1),
      openFrom: open.from,
      openLength: open.to - open.from,
      closeGap: close && close.from - range.to,
      closeLength: close && close.to - close.from,
    };
    const field = makeField("Edit code block", range.text);
    field.wrap = "off";
    const layer = document.createElement("div");
    layer.className = "md-code-editor";
    layer.style.lineHeight = document.defaultView.getComputedStyle(pre).lineHeight;
    code.before(layer);
    layer.append(code, field);
    activate(field, { kind: "code", from: range.from, to: range.to, originalTo: range.to, last: original, fence,
      codeIndex: source.codeBlocks.indexOf(range) });
    view.dispatch({ selection: { anchor: range.from + Math.min(caret, original.length) },
      annotations: Transaction.addToHistory.of(false) });
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, caret);
    pre.scrollLeft = scroll;
    const revealCaret = () => {
      if (active?.field !== field) return;
      const offset = field.selectionDirection === "backward" ? field.selectionStart : field.selectionEnd;
      const caret = codeCaretRectangle(code, offset);
      if (!caret) return;
      const bounds = pre.getBoundingClientRect();
      if (caret.left < bounds.left + 12) pre.scrollLeft += caret.left - bounds.left - 12;
      else if (caret.right > bounds.right - 12) pre.scrollLeft += caret.right - bounds.right + 12;
    };
    field.addEventListener("select", revealCaret);
    field.addEventListener("keyup", revealCaret);
    field.addEventListener("input", (event) => {
      if (active?.field !== field) return;
      editValue(active, range.serialize(field.value), event);
      colorCode(code, field.value + (field.value.endsWith("\n") ? "\n" : ""));
      revealCaret();
    });
    field.addEventListener("keydown", (event) => {
      if (!event.isComposing && event.key === "Escape") {
        event.preventDefault();
        finish();
        root.focus({ preventScroll: true });
      }
    });
  }

  function enterText(range, point, { placeholder = false, pending } = {}) {
    const field = document.createElement("span");
    field.setAttribute("contenteditable", "plaintext-only");
    field.setAttribute("aria-label", "Edit Markdown text");
    field.spellcheck = false;
    point.node.before(field);
    field.append(point.node);
    if (placeholder) {
      field.className = "md-empty-caret";
      field.append(document.createElement("br"));
    }
    activate(field, { kind: "text", ...range, originalFrom: range.from, originalTo: range.to, last: point.node.data, placeholder, pending });
    view.dispatch({ selection: { anchor: range.from + point.offset }, annotations: Transaction.addToHistory.of(false) });
    field.focus({ preventScroll: true });
    document.getSelection().collapse(placeholder ? field : point.node, Math.min(point.offset, point.node.data.length));
    field.addEventListener("beforeinput", (event) => {
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") event.preventDefault();
    });
    field.addEventListener("input", (event) => {
      if (active?.field !== field) return;
      editValue(active, field.textContent, event);
      if (active?.field === field) {
        if (field.textContent) field.classList.remove("md-empty-caret");
        if (!event.isComposing) updateSlash();
      }
    });
    field.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && !slash && document.getSelection().isCollapsed) {
        event.preventDefault();
        const inline = active?.field === field && active.pending && field.closest("code, strong, em");
        const position = active?.from;
        finish();
        if (inline) placeCaret(position);
        else root.focus({ preventScroll: true });
        return;
      }
    });
  }

  function sourcePosition(node, offset) {
    if (!node || !root.contains(node)) return undefined;
    if (node === root && (offset === 0 || offset === root.childNodes.length)) {
      return offset === 0 ? 0 : view.state.doc.length;
    }
    if (active?.kind === "text" && active.field.contains(node)) {
      return active.from + caretIn(active.field, { node, offset });
    }
    const direct = source.ranges.get(node);
    if (direct) return currentPosition(direct.offsets?.[offset] ?? direct.from + offset);
    const element = node.nodeType === 1 ? node : node.parentElement;
    const emptyItem = source.emptyItems.get(element?.closest(".md-empty-item"));
    if (emptyItem) return currentPosition(emptyItem.at);
    const pre = element?.closest("pre");
    const code = pre && source.codeBlocks.find(({ element }) => element.closest("pre") === pre);
    if (code) {
      if (node === pre) return currentPosition(offset ? code.node.to : code.node.from);
      if (code.element.contains(node)) return currentPosition(code.sourcePosition(caretIn(code.element, { node, offset })));
    }
    const table = element?.closest("table");
    const mappedTable = table && source.tables.find(({ element }) => element === table);
    if (mappedTable) {
      if (node === table) return currentPosition(offset ? mappedTable.node.to : mappedTable.node.from);
      const cell = element.closest("td, th");
      const range = cell && mappedTable.rows[cell.parentElement.rowIndex]?.cells[cell.cellIndex];
      if (range && !cell.textContent.trim()) return currentPosition(range.from);
    }
    if (node.nodeType !== 1) return undefined;
    const child = node.childNodes[offset] ?? node.lastChild;
    const atEnd = offset >= node.childNodes.length;
    const candidates = [
      ...source.textRanges.filter(({ node }) => child?.contains(node)),
      ...source.tables.filter(({ element }) => child?.contains(element)).map(({ node }) => node),
      ...source.codeBlocks.filter(({ element }) => child?.contains(element)).map(({ node }) => node),
    ].sort((a, b) => (atEnd ? a.to - b.to : a.from - b.from));
    return currentPosition(atEnd ? candidates.at(-1)?.to : candidates[0]?.from);
  }

  function currentPosition(position) {
    return position !== undefined && active?.originalTo !== undefined && position >= active.originalTo
      ? position + view.state.doc.length - renderedDoc.length
      : position;
  }

  function currentSelection() {
    const selection = document.getSelection();
    if (selectedDocument && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
      return { anchor: 0, head: view.state.doc.length, from: 0, to: view.state.doc.length, wholeDocument: true };
    }
    const anchor = sourcePosition(selection.anchorNode, selection.anchorOffset);
    const head = sourcePosition(selection.focusNode, selection.focusOffset);
    if (anchor === undefined || head === undefined) return undefined;
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    const displayed = source.selectionOnly.some((range) => range.from < to && range.to > from)
      ? selection.toString() : undefined;
    return { anchor, head, from, to, displayed };
  }

  function pointFromSource(position, end = false) {
    const range = source.textRanges.find(({ from, to }) => end ? position > from && position <= to : position >= from && position < to)
      ?? source.textRanges.find(({ from, to }) => position >= from && position <= to);
    if (range) return { range, node: range.node, offset: position - range.from };
  }

  function selectionPoint(position, end, preferTextEdges = false) {
    if (position === 0 || position === view.state.doc.length) {
      const text = preferTextEdges && (pointFromSource(position, end) ?? selectionOnlyPoint(position));
      if (text) return text;
      return { node: root, offset: position === 0 ? 0 : root.childNodes.length };
    }
    for (const { node, element } of [...source.tables, ...source.codeBlocks]) {
      if (position !== node.from && position !== node.to) continue;
      const block = element.closest("pre, table");
      return { node: block, offset: position === node.from ? 0 : block.childNodes.length };
    }
    const point = pointFromSource(position, end) ?? selectionOnlyPoint(position);
    if (point) return point;
    for (const [item, { at, content }] of source.emptyItems) {
      if (at === position) return { node: content ?? item, offset: 0 };
    }
    const code = source.codeBlocks.find(({ from, to }) => position >= from && position <= to);
    if (!code) return;
    const walker = document.createTreeWalker(code.element, 4);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (code.sourcePosition(offset + node.length) >= position) {
        let low = 0;
        let high = node.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (code.sourcePosition(offset + middle) < position) low = middle + 1;
          else high = middle;
        }
        return { node, offset: low };
      }
      offset += node.length;
    }
    return { node: code.element, offset: code.element.childNodes.length };
  }

  function selectionOnlyPoint(position) {
    for (const range of source.selectionOnly) {
      const offset = range.offsets.indexOf(position);
      if (offset >= 0) return { range, node: range.node, offset };
    }
  }

  function restoreSelection({ anchor, head }, preferTextEdges = false) {
    const start = selectionPoint(anchor, anchor > head, preferTextEdges);
    const end = selectionPoint(head, head > anchor, preferTextEdges);
    if (!start || !end) return;
    root.focus({ preventScroll: true });
    document.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    highlightSelectedBlocks();
    return true;
  }

  function highlightSelectedBlocks(selection = currentSelection()) {
    const whole = selection && wholeBlockEdges(selection);
    for (const { node, element } of [...source.tables, ...source.codeBlocks]) {
      element.closest("pre, table").classList.toggle("md-block-selected",
        !!whole && whole.from <= node.from && whole.to >= node.to);
    }
  }

  function wholeBlockEdges({ from, to }) {
    if (from === to) return { from, to };
    for (const block of [...source.tables, ...source.codeBlocks]) {
      const start = currentPosition(block.node.from);
      const end = currentPosition(block.node.to);
      if (from >= end || to <= start) continue;
      const first = block.rows ? block.rows[0].cells[0]?.from : block.sourcePosition(0);
      const last = block.rows ? block.rows.at(-1).cells.at(-1)?.to : block.sourcePosition(block.text.length);
      if (from >= start && from <= currentPosition(first) && to >= currentPosition(last)) from = start;
      if (to <= end && to >= currentPosition(last) && from <= start) to = end;
    }
    return { from, to };
  }

  function formatText(selection, marker) {
    finish();
    const tree = parser.parse(view.state.doc.toString());
    const type = marker.length === 2 ? "StrongEmphasis" : "Emphasis";
    let formatted = false;
    for (let node = tree.resolveInner(selection.from, 1); node; node = node.parent) {
      if (node.name === "InlineCode" && selection.to <= node.to) return;
      if (node.name === type) formatted = true;
    }
    if (!formatted && selection.from === selection.to) {
      return startInlineEdit(selection.from, marker.length === 2 ? "strong" : "em",
        (value) => ({ before: marker, value, after: marker }));
    }
    view.dispatch({ selection: { anchor: selection.anchor, head: selection.head } });
    if (!toggleFormatting(marker, type, tree)(view)) return;
    const range = view.state.selection.main;
    if (range.empty) placeCaret(range.head);
    else restoreSelection(range);
  }

  function formatInlineCode(selection) {
    finish();
    const doc = view.state.doc;
    const raw = doc.sliceString(selection.from, selection.to);
    if (selection.from !== selection.to) {
      const tree = parser.parse(doc.toString());
      const start = textBlockAt(tree, selection.from, 1);
      const end = textBlockAt(tree, selection.to, -1);
      if (/\n[ \t]*\n/.test(raw) || !sameBlock(start, end)) return;
    }
    const change = inlineCodeChange(doc, parser.parse(doc.toString()), selection,
      selection.displayed);
    if (change) {
      const anchor = change.map(selection.anchor);
      const head = change.map(selection.head);
      dispatch(change.change, "input.format", head);
      render();
      if (anchor === head) placeCaret(head);
      else restoreSelection({ anchor, head });
    } else startInlineEdit(selection.from, "code", codeSpan);
  }

  function startInlineEdit(position, tag, pending) {
    const point = pointFromSource(position);
    if (!point) return placeCaret(position, false, { pending, tag });
    const tail = point.node.splitText(point.offset);
    const wrapper = document.createElement(tag);
    const node = document.createTextNode("");
    tail.before(wrapper);
    wrapper.append(node);
    enterText({ from: position, to: position }, { node, offset: 0 }, { placeholder: true, pending });
  }

  function editEmptyItem(item) {
    const { at, space, content } = source.emptyItems.get(item);
    const node = document.createTextNode("");
    content.append(node);
    enterText({ from: at, to: at }, { node, offset: 0 }, { placeholder: true,
      pending: space ? (value) => ({ before: " ", value, after: "" }) : undefined });
  }

  function replaceSelection(selection, text, userEvent = "input.preview") {
    const doc = view.state.doc;
    const tree = parser.parse(doc.toString());
    if (selection.from !== selection.to && !selection.wholeDocument) {
      const { from, to } = wholeBlockEdges(selection);
      const blockAt = (position, side) => {
        for (let node = tree.resolveInner(position, side); node; node = node.parent) {
          if (node.name === "Table" || node.name === "FencedCode" || node.name === "CodeBlock") return node;
        }
      };
      const start = blockAt(from, 1);
      const end = blockAt(to, -1);
      if (sameBlock(start, end) && from === start.from && to === start.to && !text) {
        return removeBlock(start);
      }
      const partialStart = start && from > start.from;
      const partialEnd = end && to < end.to;
      if (partialStart || partialEnd) {
        if (!sameBlock(start, end)) return;
        if (start.name === "Table") return replaceTableSelection(start, selection, text, doc, tree, userEvent);
        if (start.parent?.name !== "Document") return;
      }
      selection = { ...selection, from, to };
      const first = textBlockAt(tree, from, 1);
      const last = textBlockAt(tree, to, -1);
      if (!sameBlock(first, last)) {
        for (const edge of [first, last]) {
          if (!edge || !edge.name.includes("Heading")) continue;
          const [opening, closing] = edge.getChildren("HeaderMark");
          if (edge === first && opening?.from === edge.from &&
              opening.to <= from && !doc.sliceString(opening.to, from).trim()) selection.from = edge.from;
          const suffix = closing ?? (opening?.from > edge.from ? opening : undefined);
          if (edge === last && suffix && to <= suffix.from && !doc.sliceString(to, suffix.from).trim()) selection.to = edge.to;
        }
      }
      if (!text && [...source.tables, ...source.codeBlocks].some(({ node }) =>
        currentPosition(node.from) >= selection.from && currentPosition(node.to) <= selection.to)) {
        const opening = doc.lineAt(selection.from);
        const closing = doc.lineAt(selection.to);
        const firstLine = selection.from === opening.to && opening.text.trim() ? opening.number + 1 : opening.number;
        const lastLine = selection.to === closing.from ? closing.number - 1 : closing.number;
        if (firstLine <= lastLine &&
          (firstLine !== opening.number || !doc.sliceString(opening.from, selection.from).trim()) &&
          (lastLine !== closing.number || !doc.sliceString(selection.to, closing.to).trim())) {
          return removeBlockLines(doc.line(firstLine), doc.line(lastLine));
        }
      }
    }
    finish({ redraw: false });
    const { from, to, left, right } = selectionMarks(doc, tree, selection.from, selection.to, !!text);
    let insert = text.replace(/\r\n?/g, "\n");
    if (from === to && !insert) return;
    if (!insert && !left && !right && from > 0 && to < doc.length && [...source.tables, ...source.codeBlocks]
      .some(({ node }) => node.to === from || node.from === to)) {
      const before = doc.sliceString(0, from).match(/\n[ \t]*(?:\n[ \t]*)?$/)?.[0];
      const after = doc.sliceString(to).match(/^[ \t]*\n(?:[ \t]*\n)?/)?.[0];
      const lines = ((before ?? "") + (after ?? "")).match(/\n/g)?.length ?? 0;
      insert = "\n".repeat(Math.max(0, 2 - lines));
    }
    dispatch({ from, to, insert: insert + left + right }, userEvent, from + insert.length);
    render();
    placeCaret(from + insert.length);
  }

  function replaceTableSelection(table, selection, text, doc, tree, userEvent) {
    const changes = [];
    let first;
    tableRows(table, doc).forEach((row, rowIndex) => row.cells.forEach((cell, column) => {
      const from = Math.max(cell.from, selection.from);
      const to = Math.min(cell.to, selection.to);
      if (from >= to) return;
      const insert = first ? "" : text;
      const part = selectionMarks(doc, tree, from, to, !!insert);
      const value = doc.sliceString(cell.from, part.from) + insert + part.left + part.right +
        doc.sliceString(part.to, cell.to);
      changes.push(cellChange(row, column, value, doc));
      first ??= { rowIndex, column };
    }));
    if (!first) return;
    finish({ redraw: false });
    dispatch(changes, userEvent, changes[0].from);
    render();
    const element = source.tables.find(({ node }) => node.from === table.from)?.element;
    const cell = element?.rows[first.rowIndex]?.cells[first.column];
    if (cell) enterCell(cell, null);
  }

  function leaveListItem(context, userEvent, outdent) {
    const doc = view.state.doc;
    if (outdent && indentList({ head: context.contentFrom }, true)) return true;
    const { changes, caret } = removeListPrefix(doc, context);
    finish({ redraw: false });
    dispatch(changes, userEvent, caret);
    render();
    placeCaret(caret);
    return true;
  }

  function focusBlockEdge(before, after) {
    const targets = [
      ...source.textRanges.filter(({ node }) => !node.parentElement.closest("table"))
        .map((range) => ({ from: range.from, to: range.to, range })),
      ...source.codeBlocks.map((code) => ({ from: code.node.from, to: code.node.to, code })),
      ...[...source.emptyItems].map(([item, { at }]) => ({ from: at, to: at, item })),
      ...source.tables.map((table) => ({ from: table.node.from, to: table.node.to, table })),
    ].sort((a, b) => a.from - b.from);
    const previous = targets.filter(({ to }) => to <= before).at(-1);
    const target = previous ?? targets.find(({ from }) => from >= after);
    if (target?.item) editEmptyItem(target.item);
    else if (target?.code) enterCode(target.code.element, null, previous ? target.code.text.length : 0);
    else if (target?.table) {
      const cells = [...target.table.element.querySelectorAll("th, td")];
      enterCell(previous ? cells.at(-1) : cells[0], null);
      if (!previous) active.field.setSelectionRange(0, 0);
    } else if (target?.range) {
      const { range } = target;
      enterText(range, { node: range.node, offset: previous ? range.node.length : 0 });
    } else placeCaret(Math.min(before, view.state.doc.length));
    active?.field.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  function removeBlockLines(first, last) {
    const doc = view.state.doc;
    let prior = first.number - 1;
    let next = last.number + 1;
    while (prior > 0 && !doc.line(prior).text.trim()) prior--;
    while (next <= doc.lines && !doc.line(next).text.trim()) next++;
    const from = prior ? doc.line(prior).to : 0;
    const to = next <= doc.lines ? doc.line(next).from : doc.length;
    const insert = !prior ? "" : next <= doc.lines ? "\n\n" : doc.line(doc.lines).text ? "" : "\n";
    finish({ redraw: false });
    if (doc.sliceString(from, to) !== insert) dispatch({ from, to, insert }, "delete.block", from);
    render();
    focusBlockEdge(from, from + insert.length);
  }

  function removeBlock(node, end = node.to) {
    const doc = view.state.doc;
    const first = doc.lineAt(node.from);
    const last = doc.lineAt(end);
    if (node.parent?.name === "Document") return removeBlockLines(first, last);
    // Preserve an enclosing list marker on the opening line.
    const sharesListLine = /[^\s>]/.test(doc.sliceString(first.from, node.from));
    const from = sharesListLine ? node.from : first.from;
    const to = sharesListLine || last.number === doc.lines ? last.to : last.to + 1;
    finish({ redraw: false });
    dispatch({ from, to }, "delete.block", from);
    render();
    focusBlockEdge(first.from, from);
  }

  function removeEmptyCode(target) {
    const editing = active?.kind === "code";
    const code = editing ? source.codeBlocks[active.codeIndex] :
      source.codeBlocks.find(({ element }) => element.parentElement === target);
    if (!code || (editing ? active.field.value : code.text).trim()) return false;
    removeBlock(code.node, editing ? currentPosition(code.node.to) : code.node.to);
    return true;
  }

  function boundaryDelete(selection, backward, word) {
    const position = selection.from;
    const doc = view.state.doc;
    const tree = parser.parse(doc.toString());
    const item = listPrefixAt(doc, tree, position);
    if (item && position <= item.contentFrom && (item.empty || backward && !word)) {
      return leaveListItem(item, "delete.structure", backward);
    }
    if (active.placeholder && active.from === active.to) {
      const line = doc.lineAt(position);
      if (active.pending) {
        const inline = active.field.closest("code, strong, em");
        finish();
        if (inline) placeCaret(position);
        else focusBlockEdge(position, position);
        return true;
      }
      const quote = active.field.closest("blockquote");
      if (!line.text.trim() || /^ {0,3}#{1,6}[ \t]*$/.test(line.text) ||
          quote && !quote.textContent.trim() && /^ {0,3}(?:> *)+[ \t]*$/.test(line.text)) {
        removeBlockLines(line, line);
        return true;
      }
    }
    if (word) return false;
    if (position !== (backward ? active.from : active.to)) return false;
    if (view.state.doc !== renderedDoc) finish();
    const adjacent = backward
      ? source.textRanges.filter(({ to }) => to <= position).at(-1)
      : source.textRanges.find(({ from }) => from >= position);
    if (!adjacent) {
      if (!active) placeCaret(position);
      return true;
    }
    const edge = backward ? adjacent.to : adjacent.from;
    const gap = doc.sliceString(Math.min(edge, position), Math.max(edge, position));
    const current = textBlockAt(tree, position, backward ? 1 : -1);
    const other = textBlockAt(tree, edge, backward ? -1 : 1);
    if (!current || !other) {
      if (!active) placeCaret(position);
      return true;
    }
    const same = sameBlock(current, other);
    const joinable = same || [current, other].every((node) => node.name === "Paragraph" && node.parent?.name === "Document");
    if (joinable && /^\s*\\?\n\s*$/.test(gap)) {
      replaceSelection({ from: Math.min(edge, position), to: Math.max(edge, position) }, " ", "delete.structure");
    } else if (same && !gap.includes("\n")) {
      const parts = [...graphemes.segment(adjacent.node.data)];
      const length = (backward ? parts.at(-1) : parts[0]).segment.length;
      const from = backward ? edge - length : edge;
      replaceSelection({ from, to: from + length }, "", "delete");
    } else if (!backward && item && other.parent?.name === "ListItem" &&
      item.item.nextSibling?.from === other.parent.from) {
      const next = listPrefixAt(doc, tree, edge);
      if (next && doc.lineAt(position).to === position && edge <= next.contentFrom) {
        replaceSelection({ from: position, to: next.contentFrom }, " ", "delete.structure");
      }
    }
    if (!active) placeCaret(position);
    return true;
  }

  function moveHorizontally(selection, backward, extend, word) {
    if (!selection || !extend && selection.from !== selection.to) return false;
    const { head, anchor } = selection;
    if (active && active.kind !== "text") return false;
    const focus = document.getSelection().focusNode;
    const element = focus?.nodeType === 1 ? focus : focus?.parentElement;
    const selector = "p, li, h1, h2, h3, h4, h5, h6";
    const block = element?.closest(selector);
    if (!block || active?.pending) return !!extend && !!block;
    const spans = [...source.textRanges, ...source.selectionOnly]
      .filter(({ node }) => node.parentElement?.closest(selector) === block)
      .map(({ node, from, offsets }) => ({ node, from: currentPosition(from), offsets }));
    if (active?.field.closest(selector) === block) {
      const { field, from, originalFrom, originalTo } = active;
      const index = spans.findIndex(({ node }) => field.contains(node));
      if (index >= 0) spans[index] = { node: field, from };
      else {
        const at = spans.findIndex(({ from }) => from >= originalTo);
        if (originalFrom === originalTo || at < 0) spans.push({ node: field, from });
        else spans.splice(at, 0, { node: field, from });
      }
    }
    spans.sort((a, b) => a.from - b.from);
    const points = [];
    let previous;
    for (const { node, from, offsets } of spans) {
      if (word && previous) {
        const gap = document.createRange();
        gap.setStartAfter(previous);
        gap.setEndBefore(node);
        if (/\s/.test(gap.toString())) points.push({ from, to: from, segment: " " });
      }
      for (const { segment, index } of graphemes.segment(node.textContent)) {
        points.push({
          from: offsets ? currentPosition(offsets[index]) : from + index,
          to: offsets ? currentPosition(offsets[index + segment.length]) : from + index + segment.length,
          segment,
        });
      }
      previous = node;
    }
    const next = backward ? points.filter(({ to }) => to <= head).reverse() : points.filter(({ from }) => from >= head);
    if (!next.length) return extend;
    let count = 1;
    if (word) {
      count = 0;
      const letter = ({ segment }) => /[\p{L}\p{N}_]/u.test(segment);
      while (count < next.length && !letter(next[count])) count++;
      while (count < next.length && letter(next[count])) count++;
    }
    const target = backward ? next[count - 1].from : next[count - 1].to;
    if (!extend && active && target >= active.from && target <= active.to) return false;
    finish();
    if (extend) restoreSelection({ anchor, head: target });
    else placeCaret(target, false, { end: !backward });
    return true;
  }

  function placeCaret(position, inline = false, { pending, after, before, tag, end: preferEnd } = {}) {
    const doc = view.state.doc;
    const end = doc.lineAt(position).to;
    const nextRange = source.textRanges.find(({ from }) => from > position && from <= end &&
      !doc.sliceString(position, from).trim());
    const point = !pending && (pointFromSource(position, preferEnd) ?? (nextRange && pointFromSource(nextRange.from)));
    if (point) {
      enterText(point.range, point);
      return;
    }
    const line = view.state.doc.lineAt(position).number - 1;
    const blocks = [...root.children].filter((element) => element.hasAttribute("data-line"));
    const next = blocks.find((element) => Number(element.dataset.line) >= line);
    const previous = next ? next.previousElementSibling : blocks.at(-1);
    const emptyItem = !pending && [...source.emptyItems].find(([, { at }]) => at === position)?.[0];
    if (emptyItem) return editEmptyItem(emptyItem);
    const emptyBlock = !pending && Number(next?.dataset.line) === line &&
      [...next.children].find((child) => child.matches("h1,h2,h3,h4,h5,h6,blockquote") && !child.textContent.trim());
    const betweenItems = !pending && !inline && [...source.listNodes].find(([element, item]) => {
      const prior = source.listNodes.get(element.previousElementSibling);
      return item.from > position && prior?.to < position &&
        /^[\s>]*$/.test(doc.sliceString(prior.to, item.from));
    })?.[0];
    const block = emptyBlock || document.createElement(inline ? "span" : "p");
    if (before) before.before(block);
    else if (after) after.after(block);
    else if (betweenItems) {
      block.style.marginInlineStart = "-" + document.defaultView.getComputedStyle(betweenItems.parentElement).paddingInlineStart;
      betweenItems.before(block);
    }
    else if (!emptyBlock) {
      if (inline && previous) previous.append(block);
      else if (next) next.before(block);
      else root.append(block);
    }
    const node = document.createTextNode("");
    if (tag) block.append(document.createElement(tag));
    (tag ? block.firstChild : block).append(node);
    enterText({ from: position, to: position }, { node, offset: 0 }, { placeholder: true, pending });
    block.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  function lineBreak(selection, soft) {
    const { from, to } = selection;
    if (!soft && from === to && active?.kind === "text" && !active.pending) {
      const paragraph = active.field.closest("p");
      const group = paragraph?.parentElement;
      const first = source.textRanges.find(({ node }) => paragraph?.contains(node));
      const tree = parser.parse(view.state.doc.toString());
      const block = textBlockAt(tree, from, 1);
      if (from === (first && (active.field.contains(first.node) ? active.from : first.from)) &&
          block?.name === "Paragraph" && block.parent?.name === "Document" && group?.parentElement === root) {
        const at = block.from;
        const line = view.state.doc.lineAt(at);
        finish();
        const before = [...root.children].find(({ dataset }) => Number(dataset.line) === line.number - 1);
        if (before) return placeCaret(line.from, false, { before,
          pending: (value) => ({ before: "", value, after: "\n\n" }) });
      }
    }
    if (from !== to) {
      const tree = parser.parse(view.state.doc.toString());
      if (tableAt(tree, from, 1) || tableAt(tree, to, -1)) return replaceSelection(selection, "\n", "input.structure");
    }
    if (!soft && from === to && active?.kind === "text") {
      const doc = view.state.doc;
      const tree = parser.parse(doc.toString());
      const item = listPrefixAt(doc, tree, from);
      if (active.last && smartSpace(selection)) return;
      if (item?.empty && from === item.contentFrom) {
        if (active.justStarted) {
          active.justStarted = false;
          return;
        }
        return leaveListItem(item, "input.structure", true);
      }
    }
    finish({ redraw: false });
    const doc = view.state.doc;
    const tree = parser.parse(doc.toString());
    let splitAt = from;
    let close = "";
    let open = "";
    for (let node = tree.resolveInner(from, -1); node; node = node.parent) {
      if (!soft && /^(?:ATX|Setext)Heading[1-6]$/.test(node.name) && from === to) {
        const lastMark = node.getChildren("HeaderMark").at(-1);
        if (lastMark && lastMark.from >= from && !doc.sliceString(from, lastMark.from).trim()) splitAt = node.to;
      }
      if (soft && node.name !== "InlineCode") continue;
      const [start, end] = inlineMarks(node) ?? [];
      if (!start || !end || from < start.to || to > end.from) continue;
      if (from === to && from === end.from) splitAt = Math.max(splitAt, end.to);
      else {
        close += doc.sliceString(end.from, end.to);
        open = doc.sliceString(start.from, start.to) + open;
      }
    }
    const end = Math.max(to, splitAt);
    if (!soft && continueMarkdown(splitAt, end, close, open)) return;
    const insert = close + (soft ? "\\\n" + continuationPrefix(doc, tree, from) : "\n\n") + open;
    dispatch({ from: splitAt, to: end, insert }, "input.structure", splitAt + insert.length);
    render();
    placeCaret(splitAt + insert.length, soft);
  }

  function continueMarkdown(from, to, close, open) {
    const removed = view.state.changes({ from, to });
    const { state } = view.state.update({ changes: removed, selection: { anchor: from } });
    if (!ensureSyntaxTree(state, state.doc.lineAt(from).to, 30)) return false;
    return insertNewlineContinueMarkup({ state, dispatch(transaction) {
      let caret = transaction.newSelection.main.head;
      let changes = removed.compose(transaction.changes);
      if (close || open) {
        const start = transaction.changes.mapPos(from, -1);
        const marks = transaction.state.changes([{ from: start, insert: close }, { from: caret, insert: open }]);
        changes = changes.compose(marks);
        caret = marks.mapPos(caret, 1);
      }
      dispatch(changes, "input.structure", caret);
      render();
      placeCaret(caret);
    } });
  }

  function smartSpace(selection) {
    if (selection?.from !== selection?.to || !selection) return false;
    const doc = view.state.doc;
    const { from } = doc.lineAt(selection.from);
    const prefix = doc.sliceString(from, selection.from);
    const insert = blockShortcut(prefix);
    if (!insert) return false;
    finish({ redraw: false });
    const at = from + insert.length;
    dispatch({ from, to: selection.from, insert }, "input.format", at);
    render();
    placeCaret(at);
    if (active) active.justStarted = true;
    return true;
  }

  function indentList(selection, outdent) {
    if (!selection) return false;
    const doc = view.state.doc;
    const changes = listIndent(doc, parser.parse(doc.toString()), selection.head, outdent);
    if (!changes) return false;
    const at = view.state.changes(changes).mapPos(selection.head);
    finish({ redraw: false });
    dispatch(changes, "input.format", at);
    render();
    placeCaret(at);
    return true;
  }

  function insertBlock(id, selection) {
    finish();
    const doc = view.state.doc;
    const { from, to } = selection;
    const tree = parser.parse(doc.toString());
    if (from !== to && !selection.wholeDocument && (tableAt(tree, from, 1) || tableAt(tree, to, -1))) return;
    const { from: start, to: end, left, right } = selectionMarks(doc, tree, from, to, true);
    const previous = doc.sliceString(0, start) + left;
    const next = right + doc.sliceString(end);
    const before = previous ? /\n[ \t]*\n[ \t]*$/.test(previous) ? "" : /\n[ \t]*$/.test(previous) ? "\n" : "\n\n" : "";
    const after = next ? /^[ \t]*\n[ \t]*\n/.test(next) ? "" : /^[ \t]*\n/.test(next) ? "\n" : "\n\n" : "";
    const value = id === "code" ? doc.sliceString(start, end) : "";
    const fence = id === "code" ? backtickFence(value, 3) : "";
    const block = id === "code" ? fence + "\n" + (value ? value + "\n" : "") + fence :
      id === "table" ? "|  |  |\n| --- | --- |\n|  |  |" : "- [ ] ";
    const at = start + left.length + before.length;
    dispatch({ from: start, to: end, insert: left + before + block + after + right }, "input.format", at);
    render();
    if (id === "code") {
      const code = source.codeBlocks.find(({ node }) => node.from === at);
      if (code) {
        enterCode(code.element, null, 0);
        if (value) active.field.select();
        code.element.scrollIntoView?.({ block: "nearest" });
      }
    } else if (id === "table") {
      const cell = source.tables.find(({ node }) => node.from === at)?.element.rows[0].cells[0];
      if (cell) {
        enterCell(cell, null);
        cell.scrollIntoView?.({ block: "nearest" });
      }
    } else placeCaret(at + block.length);
  }

  function paragraphAfterCode(index) {
    finish();
    const range = source.codeBlocks[index];
    if (!range) return;
    const doc = view.state.doc;
    let owner = range.node;
    while (owner.parent?.name !== "Document" && owner.parent) owner = owner.parent;
    const at = doc.lineAt(owner.to).to;
    const [open, close] = range.node.getChildren("CodeMark");
    const closing = owner === range.node && open && !close ? "\n" + doc.sliceString(open.from, open.to) : "";
    const after = doc.sliceString(at).trim() ? (/^\n[ \t]*\n/.test(doc.sliceString(at)) ? "" : "\n") : "";
    const group = range.element.closest("[data-line]");
    placeCaret(at, false, { after: group, pending: (value) => ({ before: closing + "\n\n", value, after }) });
  }

  function closeSlash() {
    slash?.menu.remove();
    slash = undefined;
  }

  function chooseSlash(command) {
    if (!active || !command) return;
    const { from, to } = active;
    closeSlash();
    insertBlock(command.id, { from, to });
  }

  function updateSlash() {
    const field = active.field;
    const query = field.textContent;
    if (active.kind !== "text" || field.closest("code, li, blockquote, h1, h2, h3, h4, h5, h6") ||
        !/^\/[^/\r\n]*$/.test(query) || active.slashDismissed) return closeSlash();
    const doc = view.state.doc;
    const line = doc.lineAt(active.from);
    if (doc.sliceString(line.from, active.from).trim() || doc.sliceString(active.to, line.to).trim()) return closeSlash();
    const matching = blockCommands.filter(({ search }) => search.includes(query.slice(1).trim().toLowerCase()));
    if (!slash) {
      const menu = document.createElement("div");
      menu.className = "md-slash-menu";
      menu.setAttribute("role", "group");
      menu.setAttribute("aria-label", "Insert Markdown block");
      menu.addEventListener("mousedown", (event) => event.preventDefault());
      const box = field.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(box.left, document.defaultView.innerWidth - 225)) + "px";
      menu.style.top = Math.max(8, Math.min(box.bottom + 4, document.defaultView.innerHeight - 110)) + "px";
      root.append(menu);
      slash = { menu, index: 0 };
    }
    slash.items = matching;
    slash.index = 0;
    slash.menu.replaceChildren(...matching.map((command, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.textContent = command.label;
      if (command.shortcut) {
        const shortcut = document.createElement("kbd");
        shortcut.textContent = command.shortcut;
        button.append(shortcut);
      }
      if (!index) button.classList.add("selected");
      button.addEventListener("click", () => chooseSlash(command));
      return button;
    }));
    slash.menu.hidden = !matching.length;
  }

  function slashKey(key) {
    if (!slash) return false;
    if (key === "escape") {
      active.slashDismissed = true;
      closeSlash();
      return true;
    }
    if (!slash.items.length) return false;
    if (key === "enter") {
      chooseSlash(slash.items[slash.index]);
      return true;
    }
    if (key === "arrowup" || key === "arrowdown") {
      slash.menu.children[slash.index].classList.remove("selected");
      const { length } = slash.items;
      slash.index = (slash.index + length + (key === "arrowup" ? -1 : 1)) % length;
      slash.menu.children[slash.index].classList.add("selected");
      return true;
    }
    return false;
  }

  function editLink(anchor, selection = currentSelection()) {
    if (view.state.readOnly || !source) return;
    const node = anchor && source.links.get(anchor);
    if (anchor && !node) return;
    if (!node && !selection) return;
    const from = node?.from ?? selection.from;
    const to = node?.to ?? selection.to;
    const text = anchor?.textContent ?? document.getSelection().toString();
    const href = anchor?.getAttribute("href") ?? "";
    const snapshot = view.state.doc;
    finish();
    linkForm?.remove();
    const close = () => {
      linkForm?.remove();
      linkForm = undefined;
      if (selection) restoreSelection(selection);
      else root.focus({ preventScroll: true });
    };
    linkForm = createLinkForm(root, { text, href, onClose: close, onSave(label, destination) {
      if (snapshot !== view.state.doc || label === text && destination === href) return close();
      const insert = markdownLink({ node, doc: snapshot, anchor, text: label, href: destination, originalText: text });
      dispatch({ from, to, insert });
      render();
      root.focus({ preventScroll: true });
    } });
  }

  function editTarget(target, point) {
    if (view.state.readOnly || active || !source || target.closest("summary, button, input, textarea")) return;
    const cell = target.closest("th, td");
    const pre = target.closest("pre");
    if (cell) enterCell(cell, point);
    else if (pre) {
      const code = pre.querySelector("code");
      if (code) enterCode(code, point);
    } else {
      const item = target.closest(".md-empty-item");
      if (source.emptyItems.has(item)) editEmptyItem(item);
      else {
        const range = point && source.ranges.get(point.node);
        if (range && !range.offsets) enterText(range, point);
      }
    }
  }

  function proseEdge(block, upwards) {
    if (!block) return;
    const ranges = [...source.textRanges, ...source.selectionOnly]
      .filter(({ node }) => node.parentElement?.closest(proseBlockSelector) === block)
      .map(({ node, from, to }) => active?.kind === "text" && active.field.contains(node)
        ? active : { from: currentPosition(from), to: currentPosition(to) });
    if (active?.kind === "text" && active.field.closest(proseBlockSelector) === block) ranges.push(active);
    if (!ranges.length) return;
    return upwards ? Math.min(...ranges.map(({ from }) => from)) : Math.max(...ranges.map(({ to }) => to));
  }

  function restoreVerticalSelection(anchor, head) {
    if (!restoreSelection({ anchor, head }, true)) return false;
    selectionPoint(head, head > anchor, true)?.node.parentElement?.scrollIntoView?.({ block: "nearest" });
    return true;
  }

  function extendVertically(anchor, head, upwards, previous) {
    if (!restoreVerticalSelection(anchor, head)) return false;
    if (previous?.anchor === anchor) {
      const path = verticalSelection?.heads ?? [previous.head];
      path.push(head);
      verticalSelection = { doc: view.state.doc, anchor, upwards, heads: path };
    }
    return true;
  }

  function moveFromSelection(towardsStart, vertical) {
    const selection = document.getSelection();
    if (selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return false;
    const { startContainer, startOffset, endContainer, endOffset } = selection.getRangeAt(0);
    const node = towardsStart ? startContainer : endContainer;
    const offset = towardsStart ? startOffset : endOffset;
    const position = sourcePosition(node, offset);
    const staysInField = active?.kind === "text" && active.field.contains(node);
    if (!staysInField) finish();
    selectedDocument = false;
    highlightSelectedBlocks(null);
    columnX = undefined;

    const point = root.contains(node) && node !== root ? { node, offset } : selectionPoint(position, !towardsStart, true);
    if (!point || point.node === root) {
      if (position !== undefined) focusBlockEdge(position, position);
      else selection.removeAllRanges();
      return true;
    }
    selection.collapse(point.node, point.offset);
    if (vertical && moveVertically(towardsStart, false)) return true;
    if (staysInField) return true;

    const target = point.node.nodeType === 1 ? point.node : point.node.parentElement;
    if (position !== undefined && target.matches("pre, table")) {
      // A whole-block selection ends on the container, outside the code or cell text.
      focusBlockEdge(towardsStart ? -1 : position, position);
    } else {
      editTarget(target, point);
    }
    (active?.field ?? target).scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return true;
  }

  function moveVertically(upwards, extend) {
    const edit = active;
    const selection = document.getSelection();
    const previous = extend && currentSelection();
    if (extend) {
      const path = verticalSelection;
      if (path && (path.doc !== view.state.doc || path.anchor !== previous?.anchor ||
          path.heads.at(-1) !== previous?.head)) verticalSelection = undefined;
      if (verticalSelection && path.upwards !== upwards) {
        path.heads.pop();
        const head = path.heads.at(-1);
        if (path.heads.length === 1) verticalSelection = undefined;
        if (head === path.anchor) {
          highlightSelectedBlocks(null);
          placeCaret(head, false, { end: path.upwards });
        } else restoreVerticalSelection(path.anchor, head);
        return true;
      }
    }
    let origin;
    let current;
    let skip;
    let anchor;
    if (edit?.kind === "code") {
      const { field } = edit;
      if (!extend && field.selectionStart !== field.selectionEnd) return false;
      const backwards = field.selectionDirection === "backward";
      const at = backwards ? field.selectionStart : field.selectionEnd;
      if (upwards ? field.value.slice(0, at).includes("\n") : field.value.slice(at).includes("\n")) return false;
      const code = source.codeBlocks[edit.codeIndex];
      skip = code.element;
      current = skip;
      origin = codeCaretRectangle(skip, at);
      if (extend) anchor = upwards ? currentPosition(code.node.to) : code.node.from;
    } else if (edit?.kind === "cell") {
      const { field } = edit;
      const edge = upwards ? 0 : field.value.length;
      const head = field.selectionDirection === "backward" ? field.selectionStart : field.selectionEnd;
      if (extend ? (upwards ? field.value.slice(0, head) : field.value.slice(head)).includes("\n") :
        field.selectionStart !== edge || field.selectionEnd !== edge) return false;
      current = field.closest("td, th");
      skip = current.closest("table");
      const row = skip.rows[current.parentElement.rowIndex + (upwards ? -1 : 1)];
      const next = row?.cells[current.cellIndex];
      if (next && !extend) {
        const index = source.tables.findIndex(({ element }) => element === skip);
        const rowIndex = row.rowIndex;
        const column = next.cellIndex;
        finish();
        const cell = source.tables[index]?.element.rows[rowIndex]?.cells[column];
        if (cell) {
          enterCell(cell, null);
          if (!upwards) active.field.setSelectionRange(0, 0);
          cell.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        }
        return true;
      }
      origin = current.getBoundingClientRect();
      if (extend) {
        const table = source.tables.find(({ element }) => element === skip);
        if (!table) return false;
        anchor = upwards ? table.node.to : table.node.from;
      }
    } else {
      if (!extend && !selection.isCollapsed || !root.contains(selection.focusNode)) return false;
      current = selection.focusNode.nodeType === 1 ? selection.focusNode : selection.focusNode.parentElement;
      if (!current || current.closest("a:focus, summary:focus")) return false;
      const block = current.matches("pre, table") ? current : null;
      origin = block?.getBoundingClientRect() ?? caretRectangle(selection.focusNode, selection.focusOffset);
      skip = block?.matches("pre") ? block.querySelector("code") : block ?? current.closest(".md-empty-item");
      if (extend) anchor = sourcePosition(selection.anchorNode, selection.anchorOffset);
      if (block && anchor !== undefined && (upwards ? selection.focusOffset > 0 : selection.focusOffset === 0)) {
        return extendVertically(anchor, sourcePosition(block, upwards ? 0 : block.childNodes.length), upwards, previous);
      }
    }
    if (!origin?.height) return false;
    columnX ??= origin.left;
    let group = current.closest("[data-line]");
    if (!group) {
      group = [...root.children].find((element) => upwards ?
        element.getBoundingClientRect().bottom >= origin.top : element.getBoundingClientRect().top >= origin.top);
      group ??= root.lastElementChild;
    }
    let destination;
    for (; group && !destination; group = upwards ? group.previousElementSibling : group.nextElementSibling) {
      if (group.hasAttribute("data-line")) destination = verticalDestination(group, source, origin, columnX, upwards, skip);
    }
    const currentProse = extend && !skip && current.closest(proseBlockSelector);
    const nextProse = extend && destination?.range?.node.parentElement.closest(proseBlockSelector);
    if (currentProse && currentProse !== nextProse && previous) {
      const edge = proseEdge(currentProse, upwards);
      if (edge !== undefined && (upwards ? previous.head > edge : previous.head < edge)) {
        finish();
        return extendVertically(anchor, edge, upwards, previous);
      }
    }
    if (!destination) {
      if (!extend && !upwards && edit?.kind === "code" && isLastCode(edit.codeIndex)) {
        paragraphAfterCode(edit.codeIndex);
        return true;
      }
      return false;
    }

    const { range, offset, code, at, cell, point, item } = destination;
    if (extend) {
      if (anchor === undefined) return false;
      const block = code ? source.codeBlocks.find(({ element }) => element === code) :
        cell && source.tables.find(({ element }) => element === cell.closest("table"));
      let head = block ? currentPosition(upwards ? block.node.from : block.node.to) :
        range ? sourcePosition(range.node, offset) : currentPosition(source.emptyItems.get(item)?.at);
      if (nextProse && currentProse !== nextProse) head = proseEdge(nextProse, upwards) ?? head;
      if (head === undefined) return false;
      const oldLength = view.state.doc.length;
      const oldCell = edit?.kind === "cell" ? edit.row.cells[edit.column]?.to ?? edit.row.end : undefined;
      const table = oldCell !== undefined && source.tables.find(({ element }) => element === skip);
      finish();
      if (oldCell !== undefined) {
        const delta = view.state.doc.length - oldLength;
        if (upwards) anchor = table.node.to + delta;
        if (head > oldCell) head += delta;
      }
      return extendVertically(anchor, head, upwards, previous);
    }
    if (range && edit?.kind === "text" && edit.field.contains(range.node)) {
      selection.collapse(range.node, offset);
      range.node.parentElement.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return true;
    }
    const oldLength = renderedDoc.length;
    const oldEnd = edit?.kind === "cell" ? edit.row.end : edit?.originalTo;
    const codeIndex = code && source.codeBlocks.findIndex(({ element }) => element === code);
    const codeOffset = code && (point && code.contains(point.node) ? caretIn(code, point) : at);
    const tableIndex = cell && source.tables.findIndex(({ element }) => element === cell.closest("table"));
    const itemIndex = item && [...source.emptyItems.keys()].indexOf(item);
    finish();
    if (range) {
      const shift = oldEnd !== undefined && range.from >= oldEnd ? view.state.doc.length - oldLength : 0;
      placeCaret(range.from + offset + shift);
    }
    else if (code) {
      const updated = source.codeBlocks[codeIndex]?.element;
      if (updated) {
        enterCode(updated, null, codeOffset);
        updated.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
    } else if (cell) {
      const updated = source.tables[tableIndex]?.element.rows[cell.parentElement.rowIndex]?.cells[cell.cellIndex];
      if (updated) {
        enterCell(updated, updated === cell ? point : null);
        updated.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
    } else if (item) {
      const updated = [...source.emptyItems.keys()][itemIndex];
      if (updated) editEmptyItem(updated);
    }
    active?.field.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return true;
  }

  function isLastCode(index) {
    const range = source.codeBlocks[index];
    if (!range) return false;
    return !renderedDoc.sliceString(range.node.to).trim();
  }

  function historyStep(forward) {
    const edit = active;
    finish();
    if ((forward ? redo : undo)(view) && edit) {
      const offset = view.state.selection.main.head;
      const range = source.codeBlocks.find(({ from, to }) => from <= offset && offset <= to);
      if (range) {
        enterCode(range.element, null, Math.min(offset - range.from, range.text.length));
        return;
      }
      if (edit.kind === "text" || edit.kind === "code") {
        placeCaret(offset);
        return;
      }
    }
    root.focus({ preventScroll: true });
  }

  function selectAll() {
    const selection = document.getSelection();
    if (active && !selectedBlock) {
      const field = active.field;
      if (field.tagName === "TEXTAREA") field.select();
      else {
        const block = field.closest("p, li, h1, h2, h3, h4, h5, h6") ?? field;
        const ranges = source.textRanges.filter(({ node }) => node.parentElement?.closest("p, li, h1, h2, h3, h4, h5, h6") === block);
        const first = ranges[0]?.node;
        const last = ranges.at(-1)?.node;
        if (first && last && (first !== last || !field.contains(first))) {
          const from = sourcePosition(first, 0);
          const to = sourcePosition(last, last.length);
          finish();
          restoreSelection({ anchor: from, head: to });
        } else selection.selectAllChildren(field);
      }
      selectedBlock = true;
      return;
    }
    finish();
    root.focus({ preventScroll: true });
    selection.selectAllChildren(root);
    selectedDocument = true;
  }

  function finishPointerEdit() {
    const edit = pointerEdit;
    pointerEdit = undefined;
    if (!edit || edit !== active) return false;
    const selection = document.getSelection();
    const range = !selection.isCollapsed && currentSelection();
    finish();
    if (range) restoreSelection(range);
    return true;
  }

  root.addEventListener("pointerdown", (event) => {
    selectedBlock = selectedDocument = false;
    columnX = undefined;
    verticalSelection = undefined;
    highlightSelectedBlocks(null);
    if (event.shiftKey && event.button === 0 && !event.target.closest("textarea, input, button, summary")) {
      const selection = currentSelection();
      const point = pointAt(document, event);
      const head = point && sourcePosition(point.node, point.offset);
      if (selection && head !== undefined) {
        event.preventDefault();
        finish();
        restoreSelection({ anchor: selection.anchor, head });
        return;
      }
    }
    if (!active) return;
    if (active.field.contains(event.target)) {
      startSelectionDrag(event);
      return;
    }
    const edit = pointerEdit = active;
    // Keep the old tree through mouseup. Replacing it during blur removes
    // the destination of the click or the other end of a drag selection.
    const gesture = new document.defaultView.AbortController();
    const release = () => {
      gesture.abort();
      setTimeout(() => {
        if (pointerEdit === edit) finishPointerEdit();
      }, 0);
    };
    document.addEventListener("pointerup", release, { signal: gesture.signal });
    document.addEventListener("pointercancel", release, { signal: gesture.signal });
  });

  function startSelectionDrag(event) {
    if (event.button !== 0 || event.shiftKey) return;
    const edit = active;
    const start = pointAt(document, event);
    let anchor = start && sourcePosition(start.node, start.offset);
    const gesture = new document.defaultView.AbortController();
    const options = { signal: gesture.signal };
    let crossing = false;
    document.addEventListener("pointermove", (move) => {
      const point = pointAt(document, move);
      if (!point || !root.contains(point.node)) return;
      if (!crossing && edit.field.contains(point.node)) return;
      let head = sourcePosition(point.node, point.offset);
      if (head === undefined) return;
      if (!crossing) {
        const block = edit.kind === "code" ? source.codeBlocks[edit.codeIndex] : edit.kind === "cell" &&
          source.tables.find(({ element }) => element === edit.field.closest("table"));
        if (block) anchor = currentPosition(head < block.node.from ? block.node.to : block.node.from);
        if (anchor === undefined) return;
        const length = view.state.doc.length;
        finish();
        if (edit.kind === "cell" && block) {
          const delta = view.state.doc.length - length;
          if (head >= block.node.to) head += delta;
          if (anchor === block.node.to) anchor += delta;
        }
        crossing = true;
      }
      restoreSelection({ anchor, head });
      move.preventDefault();
    }, options);
    document.addEventListener("pointerup", () => gesture.abort(), options);
    document.addEventListener("pointercancel", () => gesture.abort(), options);
  }

  root.addEventListener("click", (event) => {
    if (event.shiftKey && !document.getSelection().isCollapsed) {
      event.preventDefault();
      return;
    }
    let target = event.target;
    if (target.closest('input[type="checkbox"], .md-table-controls, .md-slash-menu')) return;
    let point = pointAt(document, event);
    if (pointerEdit) {
      // Redraw can remove an empty caret line or rewrap a block. Resolve the
      // clicked position in the old layout before committing the earlier edit.
      const empty = source.emptyItems.get(target.closest(".md-empty-item"));
      const prose = target !== root && !target.closest("a, summary, pre, td, th") &&
        point && source.ranges.has(point.node);
      const position = empty ? currentPosition(empty.at) : prose ? sourcePosition(point.node, point.offset) : undefined;
      const oldLink = target.closest("a[href]");
      const linkFrom = currentPosition(oldLink ? source.links.get(oldLink)?.from : undefined);
      const pre = target.closest("pre");
      const code = pre && source.codeBlocks.find(({ element }) => element.closest("pre") === pre);
      const codeFrom = currentPosition(code?.node.from);
      const codeOffset = code && caretIn(code.element, point);
      const cell = target.closest("th, td");
      const table = cell && source.tables.find(({ element }) => element === cell.closest("table"));
      const tableFrom = currentPosition(table?.node.from);
      const cellPosition = cell?.contains(point?.node) ? sourcePosition(point.node, point.offset) : undefined;
      if (finishPointerEdit()) {
        if (position !== undefined && document.getSelection().isCollapsed) return placeCaret(position);
        if (document.getSelection().isCollapsed && code) {
          const relocated = source.codeBlocks.find(({ node }) => node.from === codeFrom)?.element;
          if (relocated) return enterCode(relocated, null, codeOffset);
        }
        if (document.getSelection().isCollapsed && table) {
          const relocated = source.tables.find(({ node }) => node.from === tableFrom)?.element
            .rows[cell.parentElement.rowIndex]?.cells[cell.cellIndex];
          if (relocated) return enterCell(relocated, cellPosition === undefined ? null : pointFromSource(cellPosition));
        }
        if (oldLink && !root.contains(oldLink)) {
          target = [...root.querySelectorAll("a[href]")].find((anchor) => linkFrom !== undefined &&
            source.links.get(anchor)?.from === linkFrom && anchor.getAttribute("href") === oldLink.getAttribute("href"));
          if (!target) {
            event.preventDefault();
            return;
          }
        } else if (!root.contains(target)) {
          target = document.elementFromPoint(event.clientX, event.clientY) ?? root;
          point = pointAt(document, event);
        }
      }
    }
    const link = target.closest("a[href]");
    if (link) {
      event.preventDefault();
      if (event.altKey && !view.state.readOnly) editLink(link);
      else if (document.getSelection().isCollapsed) followLink(root, link.getAttribute("href"));
      return;
    }
    if (target.closest("summary")) {
      const disclosure = target.closest("details");
      const index = [...root.querySelectorAll("details")].indexOf(disclosure);
      details.set(index, !disclosure.open);
    }
    if (!document.getSelection().isCollapsed) return;
    if (!view.state.readOnly && target === root) {
      if (!root.firstChild) return placeCaret(0);
      const last = source.codeBlocks.length - 1;
      if (isLastCode(last) && event.clientY >= source.codeBlocks[last].element.closest("pre").getBoundingClientRect().bottom) {
        if (!active?.pending) paragraphAfterCode(last);
        return;
      }
      const lastBlock = [...root.children].filter((element) => element.hasAttribute("data-line")).at(-1);
      if (lastBlock && event.clientY > lastBlock.getBoundingClientRect().bottom && !active?.pending) {
        const at = view.state.doc.length;
        const before = trailingParagraphPrefix(view.state.doc, at);
        return placeCaret(at, false, { after: lastBlock, pending: (value) => ({ before, value, after: "" }) });
      }
    }
    editTarget(target, point);
  });
  root.addEventListener("mouseup", () => {
    const selection = document.getSelection();
    if (selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode) || active) return;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
    root.focus({ preventScroll: true });
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    highlightSelectedBlocks();
  });
  root.addEventListener("paste", (event) => {
    if (view.state.readOnly || event.target.closest("textarea, input") || !event.clipboardData) return;
    const selection = currentSelection();
    if (!selection) return;
    const text = event.clipboardData.getData("text/plain");
    event.preventDefault();
    if (active?.pending) {
      editValue(active, text.replace(/\r\n?/g, "\n"), { inputType: "insertFromPaste" });
      finish();
      placeCaret(view.state.selection.main.head);
    } else replaceSelection(selection, text);
  });
  root.addEventListener("cut", (event) => {
    if (view.state.readOnly || event.target.closest("textarea, input") || !event.clipboardData) return;
    const selection = currentSelection();
    if (!selection || selection.from === selection.to) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedDocument ? view.state.doc.toString() : document.getSelection().toString());
    selectedDocument = false;
    replaceSelection(selection, "");
  });
  root.addEventListener("copy", (event) => {
    if (!selectedDocument || !currentSelection() || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", view.state.doc.toString());
  });
  root.addEventListener("keydown", (event) => {
    if (event.isComposing || event.target.closest(".md-link-form")) return;
    const key = event.key.toLowerCase();
    const modified = event.metaKey || event.ctrlKey;
    const plain = !modified && !event.altKey && !event.shiftKey;
    const deleting = key === "backspace" || key === "delete";
    const vertical = !modified && !event.altKey && (key === "arrowup" || key === "arrowdown");
    if (!vertical && !["meta", "control", "alt", "shift"].includes(key)) columnX = undefined;
    if ((!vertical || !event.shiftKey) && !["meta", "control", "alt", "shift"].includes(key)) verticalSelection = undefined;
    if (plain && slashKey(key)) {
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "a") {
      event.preventDefault();
      if (!event.repeat) selectAll();
      return;
    }
    if (!["meta", "control", "shift", "alt"].includes(key)) selectedBlock = false;
    if (key === "escape" && !event.defaultPrevented && !document.getSelection().isCollapsed &&
        !event.target.matches("textarea")) {
      const selection = currentSelection();
      if (!selection) return;
      event.preventDefault();
      selectedDocument = false;
      finish();
      document.getSelection().removeAllRanges();
      highlightSelectedBlocks(null);
      if (selection.head === 0 || selection.head === view.state.doc.length) {
        focusBlockEdge(selection.head, selection.head);
      } else placeCaret(selection.head);
      return;
    }
    if (view.state.readOnly) return;
    if (plain && (vertical || key === "arrowleft" || key === "arrowright") &&
        !event.target.closest("textarea, input, button, summary") &&
        moveFromSelection(key === "arrowup" || key === "arrowleft", vertical)) {
      event.preventDefault();
      return;
    }
    if (vertical && moveVertically(key === "arrowup", event.shiftKey)) {
      event.preventDefault();
      return;
    }
    if (modified && !event.altKey && !event.shiftKey && key === "enter") {
      const index = active?.kind === "code" ? active.codeIndex : source.codeBlocks.findIndex(({ element }) => element.closest("pre") === event.target);
      if (index >= 0) {
        event.preventDefault();
        paragraphAfterCode(index);
        return;
      }
    }
    if (event.target.matches("textarea") && moveFieldCaret(event.target, event)) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "z" &&
        (active?.kind !== "cell" || active.field.value === active.original)) {
      event.preventDefault();
      historyStep(event.shiftKey);
      return;
    }
    if (!modified && !event.shiftKey && deleting && removeEmptyCode(event.target)) {
      event.preventDefault();
      return;
    }
    if (event.target.closest("textarea")) return;
    const selection = currentSelection();
    const isEditing = active?.kind === "text";
    const typing = !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1;
    if (selection && modified && !event.altKey && /^(arrowup|arrowdown)$/.test(key)) {
      event.preventDefault();
      const target = key === "arrowup" ? 0 : view.state.doc.length;
      finish();
      if (event.shiftKey) restoreSelection({ anchor: selection.anchor, head: target });
      else {
        root.scrollTop = target ? root.scrollHeight : 0;
        focusBlockEdge(target, target);
      }
      return;
    }
    if (!modified && /^arrow(left|right)$/.test(key) &&
        moveHorizontally(selection, key === "arrowleft", event.shiftKey, event.altKey)) {
      event.preventDefault();
      return;
    }
    if (isEditing && plain && key === " " && !active.field.closest("code") && smartSpace(selection) ||
        !modified && !event.altKey && key === "tab" && indentList(selection, event.shiftKey)) {
      event.preventDefault();
      return;
    }
    if (modified && event.shiftKey && (key === "c" || event.code === "KeyC") && selection) {
      event.preventDefault();
      if (event.altKey) insertBlock("code", selection);
      else if (!selectedDocument) formatInlineCode(selection);
      return;
    }
    if (selection && selection.from !== selection.to && !modified && (deleting || !isEditing && typing)) {
      event.preventDefault();
      replaceSelection(selection, typing ? event.key : "", deleting ? "delete" : "input.preview");
      return;
    }
    if (isEditing && deleting && !modified && selection?.anchor === selection?.head &&
        selection &&
        boundaryDelete(selection, key === "backspace", event.altKey)) {
      event.preventDefault();
      return;
    }
    if (isEditing && deleting && modified && !event.altKey && selection) {
      event.preventDefault();
      if (selection.from !== selection.to) replaceSelection(selection, "", "delete");
      else {
        const { head } = selection;
        const line = view.state.doc.lineAt(head);
        const block = active.field.closest("p, li, h1, h2, h3, h4, h5, h6");
        const ranges = source.textRanges.filter(({ node }) => block?.contains(node))
          .map(({ node, from, to }) => active.field.contains(node) ? active :
            { from: currentPosition(from), to: currentPosition(to) });
        const edge = key === "backspace"
          ? Math.max(line.from, ranges[0]?.from ?? active.from)
          : Math.min(line.to, ranges.at(-1)?.to ?? active.to);
        replaceSelection({ from: Math.min(head, edge), to: Math.max(head, edge) }, "", "delete");
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (key === "k" && (selection || event.target.closest("a"))) {
        event.preventDefault();
        editLink(event.target.closest("a"), selection);
      } else if (selection && !selectedDocument && formatKeys[key]) {
        event.preventDefault();
        formatText(selection, formatKeys[key]);
      }
    }
    if (event.altKey && key === "enter" && event.target.matches("a[href]")) {
      event.preventDefault();
      editLink(event.target);
    } else if (key === "enter" && event.target.matches("td, th, pre")) {
      event.preventDefault();
      editTarget(event.target, null);
    } else if (key === "enter" && selection && !event.target.closest("a, summary, button")) {
      event.preventDefault();
      lineBreak(selection, event.shiftKey);
    }
  });

  render();
  return {
    update(update) {
      if (writing || !update.docChanged && update.startState.readOnly === update.state.readOnly) return;
      // A host edit or undo is already applied. Discard offsets from the old render.
      active = undefined;
      render();
    },
  };
}
