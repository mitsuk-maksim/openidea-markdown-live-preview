function labelOf(node, doc) {
  const [open, close] = node?.getChildren("LinkMark") ?? [];
  if (node?.name === "Link" && open && close) return doc.sliceString(open.to, close.from);
  return null;
}

export function markdownLink({ node, doc, anchor, text, href, originalText }) {
  const originalLabel = labelOf(node, doc);
  const label = text === originalText && originalLabel !== null
    ? originalLabel : text.replace(/[\\[\]]/g, "\\$&");
  const url = href.replace(/[\s<>()\\]/g, (character) => encodeURIComponent(character).replace(/[()]/g, (p) =>
    p === "(" ? "%28" : "%29"));
  const titleNode = node?.getChild("LinkTitle");
  const title = titleNode ? doc.sliceString(titleNode.from, titleNode.to) :
    anchor?.title && `"${anchor.title.replace(/["\\]/g, "\\$&")}"`;
  return url ? `[${label}](${url}${title ? ` ${title}` : ""})` : label;
}

export function createLinkForm(root, { text, href, onSave, onClose }) {
  const document = root.ownerDocument;
  const form = document.createElement("form");
  form.className = "md-link-form";
  form.setAttribute("aria-label", "Edit link");
  form.innerHTML = `<label>Text <input name="label" required></label>
    <label>URL <input name="href"></label>
    <div><button type="submit">Save</button><button type="button">Cancel</button></div>`;
  const label = form.elements.namedItem("label");
  const url = form.elements.namedItem("href");
  label.value = text;
  url.value = href;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!label.value.trim()) return;
    onSave(label.value, url.value.trim());
  });
  form.querySelector('button[type="button"]').addEventListener("click", onClose);
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  });
  root.append(form);
  const field = text ? url : label;
  field.focus({ preventScroll: true });
  field.select();
  return form;
}
