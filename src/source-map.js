const hidden = new Set([
  "CodeMark", "EmphasisMark", "HeaderMark", "HTMLTag", "Image", "LinkLabel",
  "LinkMark", "LinkTitle", "QuoteMark", "StrikethroughMark", "TaskMarker", "HardBreak",
]);
const prose = /^(Paragraph|Task|(?:ATX|Setext)Heading[1-6])$/;
const code = new Set(["FencedCode", "CodeBlock"]);

export function tableRows(node, doc) {
  return [node.getChild("TableHeader"), ...node.getChildren("TableRow")].filter(Boolean).map((row) => {
    const delimiters = row.getChildren("TableDelimiter");
    const leading = delimiters[0]?.from === row.from;
    const trailing = delimiters.at(-1)?.to === row.to;
    let start = row.from + Number(leading);
    const ends = delimiters.slice(leading ? 1 : 0, trailing ? -1 : undefined).map(({ from }) => from);
    ends.push(row.to - Number(trailing));
    const cells = ends.map((end) => {
      const raw = doc.sliceString(start, end);
      const text = raw.trim();
      const from = start + (text ? raw.length - raw.trimStart().length : Math.min(1, raw.length));
      const to = from + text.length;
      start = end + 1;
      return { from, to };
    });
    return { cells, from: row.from, end: row.to, trailing, delimiters, leading };
  });
}

function significant(source, from, skip) {
  const positions = [];
  let range = 0;
  for (let i = 0; i < source.length; i++) {
    const pos = from + i;
    while (skip[range]?.to <= pos) range++;
    if (skip[range]?.from === pos && skip[range].visible) {
      for (const char of skip[range].visible.split("")) {
        if (!/\s/.test(char)) positions.push({ char, pos });
      }
    }
    if (skip[range]?.from <= pos || /\s/.test(source[i])) continue;
    positions.push({ char: source[i], pos });
  }
  return positions;
}

function inlineTextPositions(node, doc, browserDocument) {
  const skip = [];
  node.cursor().iterate((part) => {
    if (hidden.has(part.name) || part.name === "URL" && part.node.parent?.name === "Link") {
      skip.push({ from: part.from, to: part.to });
      return false;
    }
    if (part.name === "Escape") {
      skip.push({ from: part.from, to: part.from + 1 });
      return false;
    }
    if (part.name === "Entity") {
      const decoder = browserDocument.createElement("textarea");
      decoder.innerHTML = doc.sliceString(part.from, part.to);
      skip.push({ from: part.from, to: part.to, visible: decoder.value });
      return false;
    }
    if (part.name === "Link") {
      const marks = part.node.getChildren("LinkMark");
      if (marks.length >= 3) {
        // Only visit the label; destinations and reference labels are invisible.
        const label = { from: marks[0].to, to: marks[1].from };
        part.node.cursor().iterate((child) => {
          if (child.name !== "Link" && child.from >= label.from && child.to <= label.to && hidden.has(child.name)) {
            skip.push({ from: child.from, to: child.to });
            return false;
          }
        });
        skip.push({ from: part.from, to: label.from }, { from: label.to, to: part.to });
        return false;
      }
    }
  });
  skip.sort((a, b) => a.from - b.from);
  return significant(doc.sliceString(node.from, node.to), node.from, skip);
}

function textNodes(element, excludeBlocks, emptyItems) {
  const unrendered = excludeBlocks ? "pre, table, summary, [data-front-matter]" : "";
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.data.trim() || unrendered && node.parentElement.closest(unrendered) ||
        emptyItems?.has(node.parentElement.closest("li"))) continue;
    nodes.push(node);
  }
  return nodes;
}

// A candidate only becomes editable if the entire visible sequence agrees.
// The final contiguous-source check protects escaped/entity text and Markdown
// dialect differences from producing an edit of the wrong bytes.
function bindText(nodes, positions, doc, ranges, textRanges, selectionOnly) {
  const visible = nodes.map((node) => node.data.replace(/\s/g, ""));
  if (visible.join("") !== positions.map(({ char }) => char).join("")) return;

  let offset = 0;
  nodes.forEach((node, index) => {
    const count = visible[index].length;
    const from = positions[offset].pos - (node.data.length - node.data.trimStart().length);
    const to = positions[offset + count - 1].pos + 1 + (node.data.length - node.data.trimEnd().length);
    offset += count;
    if (from >= 0 && doc.sliceString(from, to) === node.data &&
        !/^[\\][!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(doc.sliceString(Math.max(0, from - 1), from + 1))) {
      const range = { from, to };
      ranges.set(node, range);
      textRanges.push({ node, ...range });
    } else if (from >= 0) {
      // Markdown escapes have a visible caret on either side of two source
      // characters. Map selection endpoints without editing the decoded run.
      for (const start of [from - 1, from]) {
        if (start < 0) continue;
        const raw = doc.sliceString(start, to);
        if (raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1") !== node.data) continue;
        const offsets = [start];
        for (const part of raw.matchAll(/\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|[\s\S]/g)) {
          offsets.push(start + part.index + part[0].length);
        }
        const range = { node, from: start, to, offsets };
        ranges.set(node, range);
        selectionOnly.push(range);
        break;
      }
    }
  });
}

function bindLinks(element, sourceNodes, links) {
  const anchors = [...element.querySelectorAll("a[href]")];
  const candidates = [];
  for (const node of sourceNodes) node.cursor().iterate((part) => {
    if (part.name === "Link" || part.name === "Autolink" ||
        part.name === "URL" && !["Link", "Autolink", "Image"].includes(part.node.parent?.name)) {
      candidates.push(part.node);
      return false;
    }
  });
  if (anchors.length === candidates.length) {
    anchors.forEach((anchor, index) => links.set(anchor, candidates[index]));
  }
}

function codeRange(element, node, doc) {
  if (element.closest("[data-mermaid]")) return;
  const text = element.textContent.replace(/\n+$/, "");
  const content = node.getChildren("CodeText");
  const [open, close] = node.getChildren("CodeMark");
  if (!content.length) {
    if (node.name !== "FencedCode" || !open) return;
    const from = close ? doc.lineAt(close.from).from : node.to;
    const opening = doc.lineAt(open.from);
    const prefix = doc.sliceString(opening.from, open.from);
    return { element, from, to: from, text, sourcePosition: () => from, serialize: (value) => value ?
      (close ? "" : "\n") + value.split("\n").map((line) => prefix + line).join("\n") + (close ? "\n" : "") : "" };
  }
  const start = doc.lineAt(content[0].from);
  const prefixes = [];
  const offsets = [];
  let displayed = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (start.number + index > doc.lines) return;
    const line = doc.line(start.number + index);
    const source = line.text;
    if (!source.endsWith(lines[index])) return;
    const prefix = source.slice(0, source.length - lines[index].length);
    if (!/^[\t >]*$/.test(prefix)) return;
    prefixes.push(prefix);
    offsets.push({ from: displayed, source: line.from + prefix.length });
    displayed += lines[index].length + 1;
  }
  const last = doc.line(start.number + lines.length - 1);
  const prefixForNewLine = prefixes.find(Boolean) ?? "";
  // Existing blank lines may omit the enclosing indentation entirely. Keep
  // their source prefixes unless the user adds visible text to that line.
  return { element, from: start.from, to: last.to, text, sourcePosition(offset) {
    const position = Math.min(offset, text.length);
    const line = offsets.findLast(({ from }) => from <= position);
    return line.source + position - line.from;
  }, serialize: (value) => {
    return value.split("\n").map((line, index) => {
      const prefix = prefixes[index] ?? prefixForNewLine;
      return (prefix || (lines[index] === "" && line ? prefixForNewLine : "")) + line;
    }).join("\n");
  } };
}

export function previewSourceMap(root, doc, tree) {
  const ranges = new WeakMap();
  const textRanges = [];
  const selectionOnly = [];
  const links = new WeakMap();
  const tasks = [];
  const tables = [];
  const codeBlocks = [];
  const emptyItems = new Map();
  const listNodes = new Map();
  const groups = [...root.children].flatMap((element) => {
    const line = Number(element.dataset.line) + 1;
    if (!Number.isInteger(line) || line < 1 || line > doc.lines) return [];
    return [{ element, from: doc.line(line).from, nodes: [], items: [] }];
  });
  let groupIndex = 0;
  tree.iterate({
    enter({ name, from, node }) {
      if (name !== "ListItem" && name !== "Table" && !code.has(name) && !prose.test(name)) return;
      while (groups[groupIndex + 1]?.from <= from) groupIndex++;
      const group = groups[groupIndex];
      if (name === "ListItem") {
        if (group && from >= group.from) group.items.push(node);
        return;
      }
      if (group && from >= group.from) group.nodes.push(node);
      return false;
    },
  });

  for (const { element, nodes, items } of groups) {
    if (element.querySelector("[data-front-matter]")) continue;
    const listItems = [...element.querySelectorAll("li")];
    const emptyTaskText = new Set();
    if (listItems.length === items.length) items.forEach((item, index) => {
      const li = listItems[index];
      const marker = item.getChild("ListMark");
      if (!marker) return;
      listNodes.set(li, item);
      const emptyTask = /^[ \t]+\[[ xX]\](?=[ \t]*$)/.exec(doc.sliceString(marker.to, doc.lineAt(marker.to).to));
      const task = item.getChild("Task")?.getChild("TaskMarker") ?? (emptyTask && {
        from: marker.to + emptyTask[0].length - 3, to: marker.to + emptyTask[0].length,
      });
      const box = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
      if (task && box && box.checked === /[xX]/.test(doc.sliceString(task.from, task.to))) {
        tasks.push({ box, at: task.from + 1 });
      }
      const content = li.children.length === 1 && li.firstElementChild.matches("p") ? li.firstElementChild : li;
      if (content.children.length) return;
      const prefix = task ?? marker;
      const tail = doc.lineAt(prefix.to);
      if ((task ? /^\[[ xX]\]$/.test(content.textContent.trim()) : !content.textContent.trim()) &&
          !doc.sliceString(prefix.to, tail.to).trim()) {
        emptyItems.set(li, { at: tail.to, space: prefix.to === tail.to, task, content });
        const text = item.getChild("Task") ?? item.getChild("Paragraph");
        if (text) emptyTaskText.add(text.from);
      }
    });
    const inline = nodes.filter(({ name, from }) => prose.test(name) && !emptyTaskText.has(from))
      .flatMap((node) => inlineTextPositions(node, doc, root.ownerDocument));
    bindText(textNodes(element, true, emptyItems), inline, doc, ranges, textRanges, selectionOnly);
    bindLinks(element, nodes.filter(({ name }) => !code.has(name)), links);

    const renderedTables = [...element.querySelectorAll("table")];
    const sourceTables = nodes.filter(({ name }) => name === "Table");
    if (renderedTables.length === sourceTables.length) {
      renderedTables.forEach((table, index) => {
        const node = sourceTables[index];
        const rows = tableRows(node, doc);
        if (rows.length !== table.rows.length || rows[0].cells.length !== table.rows[0].cells.length) return;
        const rowNodes = [node.getChild("TableHeader"), ...node.getChildren("TableRow")];
        rowNodes.forEach((row, rowIndex) => {
          const cells = row.getChildren("TableCell");
          [...table.rows[rowIndex].cells].forEach((cell, column) => {
            const source = cells[column];
            if (source) bindText(textNodes(cell, false), inlineTextPositions(source, doc, root.ownerDocument),
              doc, ranges, textRanges, selectionOnly);
          });
        });
        tables.push({ element: table, node, rows });
      });
    }

    const renderedCode = [...element.querySelectorAll("pre > code")];
    const sourceCode = nodes.filter(({ name }) => code.has(name));
    if (renderedCode.length === sourceCode.length) {
      renderedCode.forEach((element, index) => {
        const range = codeRange(element, sourceCode[index], doc);
        if (range) codeBlocks.push({ ...range, node: sourceCode[index] });
      });
    }
  }
  textRanges.sort((left, right) => left.from - right.from || left.to - right.to);
  return { ranges, textRanges, selectionOnly, links, tasks, tables, codeBlocks, emptyItems, listNodes };
}
