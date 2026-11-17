import assert from "node:assert/strict";
import test from "node:test";
import { ChangeSet } from "@codemirror/state";
import { connectDocument } from "../src/sync.js";

const encode = (text) => new TextEncoder().encode(text);

function documentSession(original) {
  let snapshot = { version: 1, text: original, readOnly: false };
  let listener;
  const events = [];
  const session = {
    events,
    disk: original,
    document: {
      bytes: async () => encode(session.disk),
      get: async () => snapshot,
      onChange(fn) { listener = fn; },
      async edit(version, edits) {
        assert.equal(version, snapshot.version);
        const text = edits.reduceRight((value, { from, to, insert }) =>
          value.slice(0, from) + insert + value.slice(to), snapshot.text);
        snapshot = { ...snapshot, version: version + 1, text };
        events.push({ edit: text });
        return { version: snapshot.version };
      },
    },
    receive(text) {
      snapshot = { ...snapshot, text, version: snapshot.version + 1 };
      listener(snapshot);
    },
  };
  session.connection = connectDocument(session.document, snapshot, {
    apply(changes) { events.push({ changes }); },
    status(message, failed) { if (failed) events.push({ failed: message }); },
  }, encode(original));
  return session;
}

test("QA F04: save drains pending local edits before forwarding the IDE shortcut", async () => {
  const session = documentSession("Original");
  await Promise.resolve();
  session.connection.edit(ChangeSet.of({ from: 8, insert: " first" }, 8));
  session.connection.edit(ChangeSet.of({ from: 14, insert: " second" }, 14));
  await session.connection.save(() => session.events.push("save"));
  assert.deepEqual(session.events.filter((event) => event.edit || event === "save"), [
    { edit: "Original first second" }, "save",
  ]);
});

test("QA F04: external bytes protect the file both before an edit and before save", async () => {
  for (const dirtyAlready of [false, true]) {
    const session = documentSession("Original");
    await Promise.resolve();
    const first = ChangeSet.of({ from: 8, insert: " local" }, 8);
    if (dirtyAlready) {
      session.connection.edit(first);
      await session.connection.save(() => {});
    }
    session.disk = "External edit";
    if (!dirtyAlready) session.connection.edit(first);
    await session.connection.save(() => assert.fail("an external change must not be overwritten"));
    assert.deepEqual(session.events.filter((event) => event.edit), dirtyAlready
      ? [{ edit: "Original local" }, { edit: "External edit" }] : []);
    assert.equal((await session.document.get()).text, dirtyAlready ? "External edit" : "Original");
    assert.match(session.events.find((event) => event.failed)?.failed, /local draft/);
    assert.equal(session.disk, "External edit");
  }
});

test("QA F04: conflict resolution leaves a separately edited IDE buffer alone", async () => {
  const session = documentSession("Original");
  await Promise.resolve();
  session.connection.edit(ChangeSet.of({ from: 8, insert: " preview" }, 8));
  await session.connection.save(() => {});
  session.receive("Original preview and text editor");
  session.disk = "External edit";
  await session.connection.save(() => assert.fail("external conflict must block Save All"));
  assert.equal((await session.document.get()).text, "Original preview and text editor");
  assert.equal(session.disk, "External edit");
});

test("QA F04: an edit building on another editor's unsaved text does not own the buffer", async () => {
  const session = documentSession("Original");
  await Promise.resolve();
  session.receive("Original from another editor");
  const length = "Original from another editor".length;
  session.connection.edit(ChangeSet.of({ from: length, insert: " and preview" }, length));
  await session.connection.save(() => {});
  session.disk = "External edit";
  await session.connection.save(() => assert.fail("external conflict must block Save All"));
  assert.equal((await session.document.get()).text, "Original from another editor and preview");
});

test("QA F04: host reloads and previous IDE saves advance the disk baseline", async () => {
  const session = documentSession("Original");
  await Promise.resolve();
  session.disk = "Reloaded";
  session.receive("Reloaded");
  session.connection.edit(ChangeSet.of({ from: 8, insert: " local" }, 8));
  await session.connection.save(() => { session.disk = "Reloaded local"; });
  session.connection.edit(ChangeSet.of({ from: 14, insert: " again" }, 14));
  await session.connection.save(() => { session.disk = "Reloaded local again"; });
  assert.equal(session.disk, "Reloaded local again");
  assert.ok(!session.events.some((event) => event.failed));
});
