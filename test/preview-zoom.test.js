import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { connectPreviewZoom } from "../src/preview-zoom.js";

test("zoom keys apply the stored font size to every preview and newly opened files", () => {
  const listeners = [];
  const windows = [];
  let size = 13;
  const broadcast = () => {
    for (const callback of listeners) callback(JSON.stringify({ kind: "preview-zoom", size }));
  };
  function open() {
    const { window } = new JSDOM("<main></main><span></span>");
    windows.push(window);
    const root = window.document.querySelector("main");
    connectPreviewZoom({
      onMessage: (callback) => listeners.push(callback),
      postMessage(raw) {
        const { kind, step } = JSON.parse(raw);
        if (kind === "adjust-zoom") size = step === 0 ? 13 : size + step;
        broadcast();
      },
    }, root, window.document.querySelector("span"));
    return { window, root, actual: () => root.style.getPropertyValue("--markdown-preview-font-size") };
  }
  function press({ root, window }, key) {
    return root.dispatchEvent(new window.KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true }));
  }
  try {
    const first = open();
    const second = open();
    assert.equal(press(first, "-"), false);
    const third = open();
    assert.deepEqual([first.actual(), second.actual(), third.actual()], ["12px", "12px", "12px"]);
    press(second, "+");
    press(second, "+");
    assert.equal(first.actual(), "14px");
    press(third, "0");
    assert.equal(first.actual(), "13px");
    first.root.hidden = true;
    assert.equal(press(first, "-"), true);
    assert.equal(second.actual(), "13px");
  } finally {
    windows.forEach((window) => window.close());
  }
});
