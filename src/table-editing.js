export function cellChange(row, column, value, doc) {
  const escaped = value.replace(/(\\*)\|/g, (pipe, slashes) =>
    slashes.length % 2 ? pipe : "\\" + pipe).replace(/\r\n?|\n/g, "<br>").trim();
  const range = row.cells[column];
  if (range) {
    const beforePipe = doc.sliceString(range.to, range.to + 1) === "|";
    const trailingSlashes = escaped.match(/\\+$/)?.[0].length ?? 0;
    return { ...range, insert: escaped + (beforePipe && trailingSlashes % 2 ? " " : "") };
  }
  const gap = column - row.cells.length;
  return { from: row.end, insert: (row.trailing ? " " : " | ") +
    "| ".repeat(gap) + escaped + (row.trailing ? " |" : " ") };
}

export function addRow(table, doc) {
  const last = table.rows.at(-1);
  const line = doc.lineAt(last.from);
  const prefix = doc.sliceString(line.from, last.from);
  const end = table.node.to;
  const cells = "  |".repeat(table.rows[0].cells.length);
  return { from: end, insert: "\n" + prefix + "|" + cells };
}

export function addColumn(table, doc) {
  const columns = table.rows[0].cells.length;
  const delimiter = table.node.getChild("TableDelimiter");
  const changes = table.rows.map((row) => {
    if (row.cells.length > columns) {
      // GFM ignores extra body cells. Keep them after the new visible column.
      const separator = row.delimiters[columns - Number(!row.leading)];
      return { from: separator.from + 1, insert: "  |" };
    }
    const padding = "  |".repeat(columns + 1 - row.cells.length);
    return { from: row.end, insert: (row.trailing ? "" : " |") + padding };
  });
  const trailing = doc.sliceString(delimiter.from, delimiter.to).trimEnd().endsWith("|");
  changes.push({ from: delimiter.to, insert: trailing ? " --- |" : " | --- |" });
  return changes;
}
