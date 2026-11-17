import { ANCHOR_PREFIX, slugify } from "./upstream/openidea-render.ts";

export function revealAnchor(root, anchor) {
  const id = ANCHOR_PREFIX + slugify(anchor);
  const target = root.ownerDocument.getElementById(id);
  if (root.contains(target)) target.scrollIntoView();
}

export function followLink(root, href) {
  const host = root.ownerDocument.defaultView?.openidea;
  if (!href || !host) return;
  try {
    if (/^https?:\/\//i.test(href)) {
      const url = new URL(href);
      host.postMessage(JSON.stringify({ kind: "url", href: url.href }));
      return;
    }
    if (href.startsWith("#")) {
      revealAnchor(root, decodeURIComponent(href.slice(1)));
      return;
    }
    const [path, ...fragment] = href.split("#");
    const relative = decodeURIComponent(path.split("?")[0]);
    if (!relative || /[\\:\u0000-\u001f]/.test(relative) || relative.startsWith("/")) return;
    host.postMessage(JSON.stringify({ kind: "file", path: relative, anchor: decodeURIComponent(fragment.join("#")) }));
  } catch {
    // A malformed percent escape or URI is plain text, never a navigation.
  }
}
