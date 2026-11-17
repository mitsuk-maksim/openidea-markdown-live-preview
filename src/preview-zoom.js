export function connectPreviewZoom(host, root, status) {
  const window = root.ownerDocument.defaultView;
  const send = (kind, step) => host.postMessage(JSON.stringify({ kind, step }));
  const read = () => send("read-zoom");

  host.onMessage((message) => {
    let update;
    try { update = JSON.parse(message); } catch { /* Native navigation errors are plain text. */ }
    if (update?.kind === "preview-zoom" && Number.isInteger(update.size) && update.size >= 8 && update.size <= 40) {
      root.style.setProperty("--markdown-preview-font-size", `${update.size}px`);
    } else if (!update?.kind) {
      status.textContent = message;
    }
  });

  window.addEventListener("keydown", (event) => {
    if (root.hidden || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
    const step = event.key === "-" ? -1 : event.key === "=" || event.key === "+" ? 1 : event.key === "0" ? 0 : null;
    if (step === null) return;
    event.preventDefault();
    send("adjust-zoom", step);
  }, { capture: true });

  // The workbench also sends zoom commands when the tab has host focus.
  // Route those to the same setting before the frame applies its local zoom.
  window.addEventListener("message", (event) => {
    const step = event.data?.fontZoomDelta;
    if (root.hidden || event.source !== window.parent || event.data?.tag !== "openidea-view" || ![-1, 0, 1].includes(step)) return;
    event.stopImmediatePropagation();
    send("adjust-zoom", step);
  }, { capture: true });
  window.addEventListener("focus", read);
  read();
}
