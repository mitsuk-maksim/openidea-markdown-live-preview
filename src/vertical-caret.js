export function caretRectangle(node, offset) {
  if (!node) return;
  const range = node.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const rect = range.getClientRects?.()[0];
  if (rect?.height) return rect;
  if (!node.textContent) return (node.nodeType === 1 ? node : node.parentElement)?.getBoundingClientRect();
}

export function pointAt(document, { clientX: x, clientY: y } = {}) {
  if (x === undefined) return null;
  const point = document.caretPositionFromPoint?.(x, y);
  if (point) return { node: point.offsetNode, offset: point.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function center(rect) {
  return (rect.top + rect.bottom) / 2;
}

function lineDistance(rect, origin, upwards) {
  const distance = (center(rect) - center(origin)) * (upwards ? -1 : 1);
  return distance > Math.min(rect.height, origin.height) * 0.55 ? distance : Infinity;
}

function textDestination(node, rect, x) {
  const y = center(rect);
  const inside = Math.max(rect.left + 0.05, Math.min(rect.right - 0.05, x));
  const point = pointAt(node.ownerDocument, { clientX: inside, clientY: y });
  if (point?.node === node) return point.offset;
  // Off-screen lines cannot be hit-tested until scrolled into view. Use range
  // geometry, which is available above and below the current viewport.
  let from = 0;
  let to = node.length;
  while (from < to) {
    const mid = (from + to) >> 1;
    const caret = caretRectangle(node, mid);
    if (caret && (center(caret) < rect.top || center(caret) <= rect.bottom && caret.left < x)) from = mid + 1;
    else to = mid;
  }
  const previous = from > 0 && caretRectangle(node, from - 1);
  const current = caretRectangle(node, from);
  if (previous && (center(previous) >= rect.top && center(previous) <= rect.bottom) &&
      (!current || center(current) > rect.bottom || Math.abs(previous.left - x) < Math.abs(current.left - x))) return from - 1;
  return from;
}

export function codeCaretRectangle(code, offset) {
  const walker = code.ownerDocument.createTreeWalker(code, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (offset <= node.length) return caretRectangle(node, offset);
    offset -= node.length;
  }
  return code.parentElement.getBoundingClientRect();
}

export function verticalDestination(group, source, origin, x, upwards, skip) {
  let best;
  function consider(rect, target) {
    if (!rect?.height) return;
    const dy = lineDistance(rect, origin, upwards);
    if (!Number.isFinite(dy)) return;
    const dx = Math.max(0, rect.left - x, x - rect.right);
    if (!best || dy < best.dy - 3 || Math.abs(dy - best.dy) <= 3 && dx < best.dx) {
      best = { rect, target, dx, dy };
    }
  }
  for (const range of source.textRanges) {
    const node = range.node;
    if (!group.contains(node) || node.parentElement.closest("td, th")) continue;
    const box = node.ownerDocument.createRange();
    box.selectNodeContents(node);
    for (const rect of box.getClientRects?.() ?? []) consider(rect, { range });
  }
  for (const range of source.codeBlocks) {
    const code = range.element;
    if (code === skip || !group.contains(code)) continue;
    const at = upwards ? range.text.lastIndexOf("\n") + 1 : 0;
    const caret = codeCaretRectangle(code, at);
    const bounds = code.closest("pre").getBoundingClientRect();
    if (caret) consider({ top: caret.top, bottom: caret.bottom, height: caret.height,
      left: bounds.left, right: bounds.right }, { code, at });
  }
  for (const table of source.tables) {
    if (table.element === skip || !group.contains(table.element)) continue;
    for (const row of table.element.rows) for (const cell of row.cells) {
      consider(cell.getBoundingClientRect(), { cell });
    }
  }
  for (const item of source.emptyItems.keys()) {
    if (item !== skip && group.contains(item)) consider(item.getBoundingClientRect(), { item });
  }
  if (!best) return;
  const { range, code, at, cell, item } = best.target;
  if (range) return { range, offset: textDestination(range.node, best.rect, x) };
  const point = pointAt(group.ownerDocument, { clientX: Math.max(best.rect.left + 1, Math.min(best.rect.right - 1, x)),
    clientY: center(best.rect) });
  return { code, at, cell, item, point };
}
