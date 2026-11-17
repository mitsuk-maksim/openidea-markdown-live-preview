// Changes use CodeMirror's UTF-16 offsets, the same coordinates as the IDE.
export function connectDocument(host, initial, ui, initialDisk) {
  let current = initial;
  let disk = initialDisk;
  let diskText = decodeDisk(initialDisk);
  let pending;
  let running;
  let failed = false;
  let external;
  let ownedVersion;

  function idle() {
    ui.status(current.readOnly ? "Read-only" : "", false);
  }

  function receive(snapshot) {
    if (failed || snapshot.version < current.version) return;
    if (running) {
      if (!external || snapshot.version >= external.version) external = snapshot;
      return;
    }
    const changes = difference(current.text, snapshot.text);
    current = { ...current, ...snapshot };
    ui.apply(changes, current.readOnly);
    idle();
  }

  function fail(error) {
    failed = true;
    ui.status(error.message === "stale"
      ? "The file changed elsewhere. Edits in this tab are now a local draft."
      : `Edits are local only: ${error.message}`, true);
  }

  async function checkDisk() {
    const bytes = new Uint8Array(await host.bytes());
    if (sameBytes(bytes, disk)) return;
    const text = decodeDisk(bytes);
    if (disk && current.text !== text) {
      const snapshot = await host.get();
      if ((pending && !pending.empty) || snapshot.text !== text) {
        // Save All can still write the IDE buffer behind this frame. Keep
        // the preview's draft, and only displace a buffer version we wrote.
        if (text !== undefined && snapshot.version === ownedVersion && snapshot.text === current.text &&
            sameBytes(new Uint8Array(await host.bytes()), bytes)) {
          await host.edit(ownedVersion, [difference(snapshot.text, text)]).catch(() => {});
        }
        throw new Error("stale");
      }
      if (!external || snapshot.version >= external.version) external = snapshot;
    }
    disk = bytes;
    diskText = text;
  }

  function run(operation) {
    running = operation().catch(fail).finally(() => {
      running = undefined;
      if (failed) return;
      if (pending && !pending.empty) {
        void flush();
      } else {
        const snapshot = external;
        external = undefined;
        if (snapshot && snapshot.version >= current.version) receive(snapshot);
        else idle();
      }
    });
    return running;
  }

  function flush() {
    if (running || failed || !pending || pending.empty) return;
    return run(async () => {
      ui.status("Syncing…", false);
      await checkDisk();
      const edits = [];
      pending.iterChanges((from, to, _start, _end, text) => {
        edits.push({ from, to, insert: text.toString() });
      });
      pending = undefined;
      const solelyFromPreview = current.version === ownedVersion || current.text === diskText;
      const { version } = await host.edit(current.version, edits);
      ownedVersion = solelyFromPreview ? version : undefined;
      current = { ...current, version, text: applyEdits(current.text, edits) };
    });
  }

  host.onChange(receive);
  idle();
  // Catch a host edit that arrived between initial loading and subscription.
  host.get().then(receive, () => {});
  return {
    edit(changes) {
      if (failed) return;
      pending = pending ? pending.compose(changes) : changes;
      void flush();
    },
    async save(requestSave) {
      do {
        while (running) await running;
        if (failed) return;
        await run(checkDisk);
      } while (running);
      if (!failed) requestSave();
    },
  };
}

function sameBytes(left, right) {
  return right && left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function decodeDisk(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    return undefined;
  }
}

function applyEdits(text, edits) {
  let position = 0;
  let result = "";
  for (const { from, to, insert } of edits) {
    result += text.slice(position, from) + insert;
    position = to;
  }
  return result + text.slice(position);
}

function difference(before, after) {
  if (before === after) return [];
  let from = 0;
  const length = Math.min(before.length, after.length);
  while (from < length && before[from] === after[from]) from++;
  let to = before.length;
  let end = after.length;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  return { from, to, insert: after.slice(from, end) };
}
