function listItemAt(doc, tree, position) {
  for (let node = tree.resolveInner(position, -1); node; node = node.parent) {
    if (node.name === "ListItem") return node;
  }
  // A caret on a list marker's trailing space can sit outside the syntax node.
  const line = doc.lineAt(position);
  if (!doc.sliceString(line.from, position).trim()) return;
  for (let node = tree.resolveInner(doc.sliceString(line.from, position).trimEnd().length + line.from, -1); node; node = node.parent) {
    if (node.name === "ListItem") return node;
  }
}

export function listPrefixAt(doc, tree, position) {
  const item = listItemAt(doc, tree, position);
  const marker = item?.getChild("ListMark");
  if (!marker) return;
  const line = doc.lineAt(marker.from);
  if (line.number !== doc.lineAt(position).number) return;
  const tail = doc.sliceString(marker.to, line.to);
  const prefix = /^(?:[ \t]+\[[ xX]\](?=[ \t]|$))?[ \t]*/.exec(tail)[0];
  const contentFrom = marker.to + prefix.length;
  return { item, marker, line, contentFrom, empty: contentFrom === line.to };
}

export function removeListPrefix(doc, { item, marker, line, contentFrom }) {
  const prefix = doc.sliceString(line.from, marker.from);
  const blank = prefix.trimEnd();
  const before = line.number > 1 && /[^\s>]/.test(doc.line(line.number - 1).text) ? blank + "\n" : "";
  const last = doc.lineAt(item.to);
  const after = last.number < doc.lines && /[^\s>]/.test(doc.line(last.number + 1).text) ? "\n" + blank : "";
  const changes = [{ from: line.from, to: contentFrom, insert: before + prefix }];
  if (after && last.to === contentFrom) changes[0].insert += after;
  else if (after) changes.push({ from: last.to, insert: after });
  return { changes, caret: line.from + before.length + prefix.length };
}

export function continuationPrefix(doc, tree, position) {
  const line = doc.lineAt(position);
  const quotes = /^ *(?:> *)+/.exec(line.text)?.[0] ?? "";
  const item = listItemAt(doc, tree, position);
  const marker = item?.getChild("ListMark");
  if (!marker) return quotes;
  if (marker.from < line.from) return quotes + (/^[ \t]*/.exec(line.text.slice(quotes.length))?.[0] ?? "");
  const before = doc.sliceString(line.from, marker.from);
  const spaces = /^[ \t]*/.exec(doc.sliceString(marker.to, line.to))[0].length;
  return before + " ".repeat(marker.to - marker.from + (spaces >= 1 && spaces <= 4 ? spaces : 1));
}

export function listIndent(doc, tree, position, outdent) {
  const item = listItemAt(doc, tree, position);
  const marker = item?.getChild("ListMark");
  if (!marker) return;
  const first = doc.lineAt(marker.from);
  const prefix = doc.sliceString(first.from, marker.from);
  if (!/^ *(?:> *)*$/.test(prefix)) return;
  let width;
  if (outdent) {
    const parentMarker = item.parent?.parent?.getChild("ListMark");
    if (!parentMarker) return;
    const parentIndent = parentMarker.from - doc.lineAt(parentMarker.from).from;
    width = prefix.length - parentIndent;
  } else {
    const previous = item.prevSibling?.getChild("ListMark");
    if (!previous) return;
    const whitespace = doc.sliceString(previous.to, doc.lineAt(previous.to).to).match(/^ */)[0].length;
    width = previous.to - previous.from + (whitespace >= 1 && whitespace <= 4 ? whitespace : 1);
  }
  if (width <= 0) return;
  const changes = [];
  const numberMarker = doc.sliceString(marker.from, marker.to);
  // CommonMark allows only an ordered marker starting at 1 to interrupt a
  // paragraph. Preserve other starting numbers by separating the nested list.
  const emptyMarker = !doc.sliceString(marker.to, first.to).trim();
  const needsSeparator = !outdent && (emptyMarker || /^\d/.test(numberMarker) && !/^0*1[.)]$/.test(numberMarker)) &&
    first.number > 1 && !!doc.line(first.number - 1).text.trim();
  const last = doc.lineAt(item.to).number;
  for (let number = first.number; number <= last; number++) {
    const line = doc.line(number);
    const quote = /^ *(?:> *)+/.exec(line.text)?.[0].trimEnd();
    const at = line.from + (quote ? quote.length + Number(line.text[quote.length] === " ") : 0);
    const content = doc.sliceString(at, line.to);
    if (!content.trim()) continue;
    if (outdent) {
      const size = Math.min(width, content.match(/^ */)[0].length);
      if (size) changes.push({ from: at, to: at + size });
    } else {
      const blank = needsSeparator && number === first.number ? (quote ?? "") + "\n" : "";
      changes.push(blank ? { from: line.from, insert: blank + doc.sliceString(line.from, at) + " ".repeat(width),
        to: at } : { from: at, insert: " ".repeat(width) });
    }
  }
  return changes.length ? changes : undefined;
}

export function blockShortcut(prefix) {
  const task = /^( *)((?:[-+*]) +)?\[([ xX]?)\]$/.exec(prefix);
  if (task) return task[1] + (task[2] ?? "- ") + "[" + (task[3] || " ") + "] ";
  if (/^ {0,3}(?:[-+*>]|[1-9]\d{0,8}[.)]|#{1,6})$/.test(prefix)) return prefix + " ";
}
