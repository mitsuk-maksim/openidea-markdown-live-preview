import { history, historyField } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { mountNativePreview } from "./native-preview.js";
import { revealAnchor } from "./navigation.js";
import { connectPreviewZoom } from "./preview-zoom.js";
import { connectDocument } from "./sync.js";

const root = document.querySelector("#preview");
const status = document.querySelector("#status");
const draft = document.querySelector("#draft");
const access = new Compartment();
const historyFields = { history: historyField };

function attachPreview(host, onAnchor) {
  const token = globalThis.crypto.randomUUID?.() ?? String(Math.random());
  let path;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({}), 750);
    host.onMessage((message) => {
      let update;
      try { update = JSON.parse(message); } catch { return; }
      if (update?.kind === "preview-context" && update.token === token) {
        clearTimeout(timeout);
        path = update.path;
        resolve(update);
        if (update.anchor) onAnchor(update.anchor);
      } else if (update?.kind === "preview-anchor" && path === update.path) {
        onAnchor(update.anchor);
      }
    });
    host.postMessage(JSON.stringify({ kind: "attach", token }));
  });
}

async function start() {
  const host = window.openidea;
  connectPreviewZoom(host, root, status);
  let preview;
  let anchor;
  const [initial, bytes, context] = await Promise.all([
    host.document.get(),
    host.document.bytes(),
    attachPreview(host, (next) => {
      anchor = next;
      if (preview) requestAnimationFrame(() => revealAnchor(root, next));
    }),
    document.fonts?.load('13px "Inter Variable"', "Markdown Текст").catch(() => {}),
  ]);
  const language = markdown({ extensions: GFM, addKeymap: false });
  let connection;
  const extensions = [language, history(), access.of(EditorState.readOnly.of(initial.readOnly))];
  let state;
  if (context.state?.doc === initial.text) {
    try { state = EditorState.fromJSON(context.state, { extensions }, historyFields); }
    catch { /* An incompatible history snapshot does not prevent opening the document. */ }
  }

  // Keep one CodeMirror document for its Markdown editing commands and history.
  // The DOM is the rendered preview, with OpenIDEA's text editor available via Open as Text.
  const view = {
    state: state ?? EditorState.create({ doc: initial.text, extensions }),
    dispatch(spec) {
      const startState = view.state;
      const transaction = spec instanceof Transaction ? spec : startState.update(spec);
      view.state = transaction.state;
      if (transaction.docChanged && transaction.annotation(Transaction.addToHistory) !== false) {
        connection.edit(transaction.changes);
        const message = JSON.stringify({ kind: "store-history", state: view.state.toJSON(historyFields) });
        if (message.length <= 262_144) host.postMessage(message);
      }
      preview?.update({ startState, state: view.state, docChanged: transaction.docChanged });
    },
  };
  preview = mountNativePreview(root, view, language.language.parser);
  connection = connectDocument(host.document, initial, {
    apply(changes, readOnly) {
      view.dispatch({
        changes,
        effects: access.reconfigure(EditorState.readOnly.of(readOnly)),
        annotations: Transaction.addToHistory.of(false),
      });
    },
    status(message, failed) {
      status.textContent = message;
      draft.hidden = !failed;
    },
  }, new Uint8Array(bytes));
  if (anchor) requestAnimationFrame(() => revealAnchor(root, anchor));
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) ||
        event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    const { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat } = event;
    void connection.save(() => {
      window.parent.postMessage({ tag: "openidea-view", key: { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat } }, "*");
    });
  });
  draft.addEventListener("click", async () => {
    try {
      const name = initial.name.replace(/\.(md|markdown)$/i, "");
      await host.saveFile({ name: `${name}.draft.md`, data: view.state.doc.toString() });
    } catch (error) {
      status.textContent = `Could not save draft: ${error.message}`;
    }
  });
}

start().catch((error) => {
  status.textContent = `Could not open Markdown: ${error.message}`;
});
