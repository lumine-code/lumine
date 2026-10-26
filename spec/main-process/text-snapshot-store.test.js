const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { constants } = require("node:buffer");
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { DatabaseSync } = require("node:sqlite");
const PieceTree = require("../../src/piece-tree");
const TextBuffer = require("../../src/text-buffer");
const TextStore = require("../../src/text-store");
const SQL = require("../../src/sql");
const { cloneSessionSnapshot } = require("../../src/serialized-text");
const { pruneUnreferencedText } = require("../../src/text-snapshot-store");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-text-snapshots-"));
  const store = new SQL("Snapshots", 1, { storagePath: directory });
  t.after(() => {
    store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}

function hugeTree() {
  let tree = new PieceTree("0123456789\r\n😀\ud800\0".repeat(1024));
  while (tree.length <= constants.MAX_STRING_LENGTH)
    tree = tree.replace(tree.length, tree.length, tree);
  return tree;
}

test("large package strings use durable chunks without expanding the session JSON", async (t) => {
  const { store } = fixture(t);
  const text = '\u0000"\\\ud800😀\r\n'.repeat(150000);
  const state = { notebook: { source: text, duplicate: text }, short: "ordinary" };
  assert.deepEqual(cloneSessionSnapshot(state), state);
  await store.save("package-state", state);
  const encoded = store.db
    .prepare('SELECT value FROM "Snapshots1" WHERE key = ?')
    .get("package-state").value;
  assert(encoded.length < 2048);
  assert.match(encoded, /"representation":"string"/);
  assert.deepEqual(await store.load("package-state"), state);
  assert.deepEqual(store.loadSync("package-state"), state);
});

test("snapshot initialization failure closes the partially opened SQL connection", (t) => {
  const { store, directory } = fixture(t);
  store.close();
  const database = new DatabaseSync(path.join(directory, "session-store.db"));
  database.exec(
    "DROP TABLE TextSnapshotNodes1; CREATE TABLE TextSnapshotNodes1 (hash TEXT PRIMARY KEY)",
  );
  database.close();

  const originalClose = DatabaseSync.prototype.close;
  let closed = 0,
    notified = 0;
  t.mock.method(DatabaseSync.prototype, "close", function () {
    closed++;
    return originalClose.call(this);
  });
  t.mock.method(console, "error", () => {});
  const previousEnvironment = globalThis.lumine;
  globalThis.lumine = {
    notifications: {
      addFatalError() {
        notified++;
      },
    },
  };
  t.after(() => {
    globalThis.lumine = previousEnvironment;
  });

  const failed = new SQL("Snapshots", 1, { storagePath: directory });
  assert.equal(failed.isConnected(), false);
  assert.equal(failed.db, undefined);
  assert.equal(closed, 1);
  assert.equal(notified, 1);
});

test("session text larger than V8 strings round trips as shared rope nodes with bounded allocations", async (t) => {
  const { store } = fixture(t);
  const tree = hugeTree();
  const source = new TextBuffer({ text: tree });
  t.after(() => source.destroy());
  source.insert([0, 0], "unsaved\n", { normalizeLineEndings: false });
  const flatten = PieceTree.prototype.toString;
  t.mock.method(PieceTree.prototype, "toString", function () {
    assert.ok(this.length <= 1048576, "document-sized flatten");
    return flatten.call(this);
  });
  t.mock.method(source, "getText", () => {
    throw new Error("Unexpected getText");
  });
  const state = cloneSessionSnapshot(source.serialize({ textSnapshots: true }));
  await store.save("large", state);
  const row = store.db.prepare("SELECT value FROM Snapshots1 WHERE key = 'large'").get();
  assert.ok(row.value.length < 10000);
  const beforeNodes = store.db
    .prepare("SELECT count(*) AS count, max(length(text)) AS bytes FROM TextSnapshotNodes1")
    .get();
  assert.ok(beforeNodes.count < 100);
  assert.ok(beforeNodes.bytes <= 65536);
  const restored = await TextBuffer.deserialize(await store.load("large"));
  t.after(() => restored.destroy());
  assert.equal(restored.getLength(), source.getLength());
  assert.equal(restored.getTextSnapshot().slice(0, 8), "unsaved\n");
  assert.equal(restored.undo(), true);
  assert.equal(restored.getLength(), tree.length);
  assert.equal(restored.redo(), true);
  restored.insert([0, 0], "next\n");
  await store.save("large", restored.serialize({ textSnapshots: true }));
  const afterNodes = store.db.prepare("SELECT count(*) AS count FROM TextSnapshotNodes1").get();
  assert.ok(afterNodes.count - beforeNodes.count < 100, "one edit stores only changed paths");
  pruneUnreferencedText(store.db);
  assert.equal((await store.load("large")).textSnapshot.length, restored.getLength());
  await store.delete("large");
  assert.ok(pruneUnreferencedText(store.db).removedTextNodes > 0);
  // A live editor can retain roots after the last durable session reference is
  // retired. Collection invalidates persistence identities before resaving it.
  await store.save("large", restored.serialize({ textSnapshots: true }));
  assert.equal((await store.load("large")).textSnapshot.length, restored.getLength());
});

test("standalone segmented serialization and modern recovery preserve exact text and undo after disk changes", async (t) => {
  const { store, directory } = fixture(t);
  const file = path.join(directory, "source.txt");
  fs.writeFileSync(file, "base\n");
  const fileWatchClient = {
    watchFile: () => ({
      ready: new Promise(() => {}),
      dispose() {},
      onDidChange: () => ({ dispose() {} }),
      onDidInvalidate: () => ({ dispose() {} }),
      onDidError: () => ({ dispose() {} }),
    }),
  };
  const source = await TextBuffer.load(file, { fileWatchClient });
  t.after(() => source.destroy());
  source.insert([0, 0], "user 😀\ud800\0\r\n", { normalizeLineEndings: false });
  await store.save("conflict", source.serialize({ textSnapshots: true }));
  fs.writeFileSync(file, "external\n");
  const restored = await TextBuffer.deserialize({
    ...(await store.load("conflict")),
    fileWatchClient,
  });
  t.after(() => restored.destroy());
  assert.equal(restored.getText(), source.getText());
  assert.equal(restored.getFileState(), "conflicted");
  assert.equal(restored.undo(), true);
  assert.equal(restored.getText(), "base\n");
  assert.equal(restored.getFileState(), "conflicted");
  assert.equal(fs.readFileSync(file, "utf8"), "external\n");

  const large = new TextBuffer("a\r\n😀\ud800\0".repeat(180000));
  t.after(() => large.destroy());
  const state = large.serialize({ history: false });
  assert.equal(state.text, undefined);
  assert.equal(state.textSnapshot.type, "LumineText");
  const copy = await TextBuffer.deserialize(JSON.parse(JSON.stringify(state)));
  t.after(() => copy.destroy());
  assert.equal(copy.getTextSnapshot().equals(large.getTextSnapshot()), true);
});

test("a deletion larger than V8 strings retains durable undo and redo without materialized patch text", async (t) => {
  const { store } = fixture(t);
  const tree = hugeTree();
  const source = new TextBuffer({ text: tree });
  t.after(() => source.destroy());
  source.delete(source.getRange());
  assert.equal(source.getLength(), 0);
  const history = source.getHistory();
  assert.equal(history.baseTextSnapshot.length, tree.length);
  await store.save("deleted", source.serialize({ textSnapshots: true }));
  const restored = await TextBuffer.deserialize(await store.load("deleted"));
  t.after(() => restored.destroy());
  assert.equal(restored.undo(), true);
  assert.equal(restored.getLength(), tree.length);
  assert.equal(restored.getTextSnapshot().slice(0, 10), "0123456789");
  assert.equal(restored.redo(), true);
  assert.equal(restored.getLength(), 0);
});

test("failed session publication retains the previous complete snapshot and releases orphan nodes", async (t) => {
  const { store } = fixture(t);
  await store.save("state", { text: new PieceTree("original\ud800\r\n") });
  const roots = store.db.prepare("SELECT * FROM TextSnapshotRoots1").all();
  store.db.exec(
    "CREATE TRIGGER fail_session BEFORE INSERT ON Snapshots1 BEGIN SELECT RAISE(ABORT, 'interrupted publication'); END",
  );
  await assert.rejects(
    store.save("state", { text: new PieceTree("replacement") }),
    /interrupted publication/,
  );
  assert.deepEqual(store.db.prepare("SELECT * FROM TextSnapshotRoots1").all(), roots);
  assert.equal((await store.load("state")).text.toString(), "original\ud800\r\n");
  assert.ok(pruneUnreferencedText(store.db).removedTextNodes > 0);
  assert.equal((await store.load("state")).text.toString(), "original\ud800\r\n");
});

test("cancellation after asynchronous node preparation prevents session publication", async (t) => {
  const { store } = fixture(t);
  await store.save("state", { text: new PieceTree("previous") });
  const cancelled = Object.assign(new Error("Session cancelled"), { code: "ABORT_ERR" });
  await assert.rejects(
    store.save(
      "state",
      { text: new PieceTree("late".repeat(400000)) },
      {
        beforeCommit() {
          throw cancelled;
        },
      },
    ),
    (error) => error === cancelled,
  );
  assert.equal((await store.load("state")).text.toString(), "previous");
  assert.ok(pruneUnreferencedText(store.db).removedTextNodes > 0);
});

test("closing a store during preparation retires live-process leases and preserves the previous session", async (t) => {
  const { store, directory } = fixture(t);
  await store.save("state", { text: new PieceTree("previous") });
  const saving = store.save("state", { text: new PieceTree("alpha beta gamma\n".repeat(150000)) });
  const closed = new Promise((resolve) =>
    setImmediate(() => {
      store.close();
      resolve();
    }),
  );
  await assert.rejects(saving, /closed|unavailable|exited/);
  await closed;
  const reopened = new SQL("Snapshots", 1, { storagePath: directory });
  try {
    expectNoLeases(reopened);
    pruneUnreferencedText(reopened.db);
    assert.equal((await reopened.load("state")).text.toString(), "previous");
  } finally {
    reopened.close();
  }
  function expectNoLeases(current) {
    assert.equal(
      current.db.prepare("SELECT count(*) AS count FROM TextSnapshotWriters1").get().count,
      0,
    );
  }
});

test("a process interrupted between node writes and publication leaves reclaimable orphan nodes", async (t) => {
  const { store, directory } = fixture(t);
  await store.save("state", { text: new PieceTree("safe") });
  const script = `const SQL = require(${JSON.stringify(require.resolve("../../src/sql"))});
    const PieceTree = require(${JSON.stringify(require.resolve("../../src/piece-tree"))});
    const store = new SQL('Snapshots', 1, {storagePath: process.argv[1]});
    store.textSnapshots.prepare({text:new PieceTree('orphan'.repeat(200000))}).then(() => process.exit(9));`;
  const child = spawnSync(process.execPath, ["-e", script, directory], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(child.status, 9, child.stderr);
  assert.ok(pruneUnreferencedText(store.db).removedTextNodes > 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM TextSnapshotWriters1").get().n, 0);
  assert.equal((await store.load("state")).text.toString(), "safe");
});

test("live leases and older referenced sessions protect text until successful replacement", async (t) => {
  const { store } = fixture(t);
  await store.save("older", { text: new PieceTree("old text") });
  await store.save("newer", { text: new PieceTree("new text") });
  const pending = await store.textSnapshots.prepare({ text: new PieceTree("unpublished") });
  assert.equal(pruneUnreferencedText(store.db).removedTextNodes, 0);
  pending.release();
  assert.equal(pruneUnreferencedText(store.db).removedTextNodes, 1);
  assert.equal((await store.load("older")).text.toString(), "old text");
  await store.delete("older");
  assert.equal(pruneUnreferencedText(store.db).removedTextNodes, 1);
  assert.equal((await store.load("newer")).text.toString(), "new text");
});

test("retiring a clean window snapshot removes its text roots in the same transaction", async (t) => {
  const { directory } = fixture(t);
  const snapshots = new SQL("Environments", 2, { storagePath: directory });
  const index = new SQL("ProjectStateIndex", 2, { storagePath: directory });
  try {
    const key = `editor-11111111-1111-4111-8111-111111111111-${"a".repeat(40)}`;
    await snapshots.save(key, {
      version: 2,
      project: {
        buffers: [
          {
            filePath: "clean.txt",
            fileState: "unmodified",
            history: { base: new PieceTree("past undo text") },
          },
        ],
      },
      workspace: {},
      documentStates: {},
    });
    const {
      collectRetiredSnapshots,
      pruneRetiredSnapshots,
    } = require("../../src/session-state-retention");
    const candidates = collectRetiredSnapshots(snapshots.db);
    assert.equal(candidates.length, 1);
    assert.equal(pruneRetiredSnapshots(snapshots.db, candidates).removed, 1);
    assert.equal(snapshots.db.prepare("SELECT count(*) AS n FROM TextSnapshotRoots1").get().n, 0);
    assert.equal(pruneUnreferencedText(snapshots.db).removedTextNodes, 1);
  } finally {
    snapshots.close();
    index.close();
  }
});

test("concurrent snapshot preparations cannot publish another save's uncommitted node identities", async (t) => {
  const { store } = fixture(t);
  const tree = new PieceTree("streaming row 😀\r\n".repeat(150000));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    await Promise.all([store.save("first", { text: tree }), store.save("second", { text: tree })]);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 1, "bulk writes yield to the event loop");
  assert.equal((await store.load("first")).text.equals(tree), true);
  assert.equal((await store.load("second")).text.equals(tree), true);
});

test("saved-base conflict checks decode a stream without constructing a second document", async () => {
  const { Readable } = require("node:stream");
  const text = "before 😀\r\nafter\0";
  const bytes = Buffer.from(text);
  const store = new TextStore(text);
  const stream = () => Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])));
  assert.equal(await store.baseTextMatchesFile(stream(), "utf8"), true);
  assert.equal(await new TextStore(text + "tail").baseTextMatchesFile(stream(), "utf8"), false);
  assert.equal(await new TextStore(text.slice(0, -1)).baseTextMatchesFile(stream(), "utf8"), false);
  assert.equal(
    await new TextStore(text.replace("before", "BEFORE")).baseTextMatchesFile(stream(), "utf8"),
    false,
  );
});

test("checksum, missing nodes and metadata corruption reject restoration without changing saved state", async (t) => {
  const { store } = fixture(t);
  await store.save("state", { text: new PieceTree("precious") });
  const raw = store.readValue("state");
  const invalid = structuredClone(raw);
  invalid.text.length++;
  await assert.rejects(store.textSnapshots.restore(invalid), /metadata/);
  store.db
    .prepare("UPDATE TextSnapshotNodes1 SET text = ? WHERE hash = ?")
    .run(Buffer.from("corrupt", "utf16le"), raw.text.hash);
  await assert.rejects(store.load("state"), /checksum/);
  store.db.prepare("DELETE FROM TextSnapshotNodes1 WHERE hash = ?").run(raw.text.hash);
  await assert.rejects(store.load("state"), /Missing text snapshot/);
  assert.deepEqual(store.readValue("state"), raw);
});

test("snapshot preparation preserves reserved-looking keys as ordinary JSON data", async (t) => {
  const { store } = fixture(t);
  const value = JSON.parse('{"__proto__":{"x":1},"constructor":{"prototype":"value"},"ok":2}');
  await store.save("json", value);
  const restored = await store.load("json");
  assert.deepEqual(restored, value);
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(Object.hasOwn(restored, "__proto__"), true);
});

test("diff rejects expensive allocation before flattening and retains exact coarse patch sources", (t) => {
  const before = new PieceTree("A".repeat(2 * 1024 * 1024));
  const after = new PieceTree("B".repeat(2 * 1024 * 1024));
  t.mock.method(PieceTree.prototype, "toString", () => {
    throw new Error("Unexpected flatten");
  });
  const patch = new TextStore(before).diff(after);
  assert.equal(patch.isCoarse, true);
  const [change] = patch.getChanges();
  assert.equal(change.oldTextSource.equals(before), true);
  assert.equal(change.newTextSource.equals(after), true);
});

test("oversized explicit text reads reject before traversing or joining chunks", () => {
  const tree = hugeTree();
  for (const materialize of [() => tree.toString(), () => tree.slice()]) {
    assert.throws(
      materialize,
      (error) =>
        error instanceof RangeError &&
        error.code === "ERR_TEXT_MATERIALIZATION_LIMIT" &&
        error.limit === constants.MAX_STRING_LENGTH,
    );
  }
  assert.equal(tree.slice(0, 10), "0123456789");
});
