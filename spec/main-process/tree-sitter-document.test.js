const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DocumentCore, PieceTree } = require("../../src/text-model");
const TreeSitterDocument = require("../../src/tree-sitter-document");
const { TreeSitterScheduler } = require("../../src/tree-sitter-scheduler");
const TextBuffer = require("../../src/text-buffer");

function source(initial = "") {
  let text = initial,
    revision = 0,
    listener,
    reads = 0;
  return {
    getTextRevision: () => revision,
    getTextSnapshot: () => {
      reads++;
      return new PieceTree(text);
    },
    getText: () => {
      throw new Error("Parser capture must use snapshots");
    },
    onDidApplyChanges(callback) {
      listener = callback;
      return {
        dispose() {
          listener = null;
        },
      };
    },
    edit(startIndex, oldEndIndex, newText, notify = true) {
      const beforeRevision = revision,
        oldText = text.slice(startIndex, oldEndIndex);
      text = text.slice(0, startIndex) + newText + text.slice(oldEndIndex);
      revision++;
      const batch = Object.freeze({
        beforeRevision,
        afterRevision: revision,
        changes: Object.freeze([Object.freeze({ startIndex, oldEndIndex, oldText, newText })]),
        isCurrent: () => revision === batch.afterRevision,
      });
      if (notify) listener?.(batch);
      return batch;
    },
    emit(batch) {
      listener?.(batch);
    },
    get reads() {
      return reads;
    },
  };
}

test("parser document captures live revisions and replays exact sequential offsets", () => {
  const buffer = source("a\r\nb🦉"),
    document = new TreeSitterDocument(buffer);
  const first = document.capture();
  assert.equal(document.capture().text, first.text);
  assert.equal(buffer.reads, 1);
  buffer.edit(2, 2, "x"); // Inside CRLF: point clipping must not enter this path.
  buffer.edit(0, 1, "\ud800");
  const next = document.capture(first);
  let replayed = first.text.toString();
  for (const edit of next.edits)
    replayed = replayed.slice(0, edit.startIndex) + edit.newText + replayed.slice(edit.oldEndIndex);
  assert.equal(next.previous, first);
  assert.equal(replayed, next.text.toString());
  assert.equal(document.isCurrent(first), false);
  assert.equal(document.isCurrent(next), true);
  assert.equal(first.text.toString(), "a\r\nb🦉");
  document.close();
  assert.equal(document.isCurrent(next), false);
  assert.throws(() => document.capture(), /closed/);
});

test("source-backed applied and pending edits retain snapshots without reading lazy strings", () => {
  const buffer = new TextBuffer({ text: "before" });
  const document = new TreeSitterDocument(buffer);
  const first = document.capture();
  const batches = [];
  const subscription = buffer.onDidApplyChanges((batch) => batches.push(batch));
  try {
    buffer.transact(() => {
      buffer.setText(new PieceTree("after 🦉\r\n"));
      const pending = document.capture(first);
      assert.equal(pending.previous, first);
      assert.equal(pending.edits[0].newText instanceof PieceTree, true);
      assert.equal(pending.edits[0].newText.toString(), "after 🦉\r\n");
    });
    const change = batches[0].changes[0];
    assert.equal(change.oldTextSource instanceof PieceTree, true);
    assert.equal(change.newTextSource instanceof PieceTree, true);
    const lazy = Object.create(change, {
      oldText: { get: () => assert.fail("old text must remain a source") },
      newText: { get: () => assert.fail("new text must remain a source") },
    });
    document.apply({ ...batches[0], changes: [lazy] });
    const captured = document.capture(first);
    assert.equal(captured.edits[0].newText, change.newTextSource);
    assert.equal(document.textUnits, "before".length + "after 🦉\r\n".length);
  } finally {
    subscription.dispose();
    document.close();
    buffer.destroy();
  }
});

test("an insertion beyond the string limit evicts parser history without flattening its source", () => {
  const { constants } = require("node:buffer");
  let huge = new PieceTree("x".repeat(4096));
  while (huge.length <= constants.MAX_STRING_LENGTH)
    huge = huge.replace(huge.length, huge.length, huge);
  const buffer = new TextBuffer({ text: "before" });
  const document = new TreeSitterDocument(buffer);
  const first = document.capture();
  try {
    buffer.setText(huge);
    assert.equal(document.changeCount, 0);
    assert.equal(document.textUnits, 0);
    const current = document.capture(first);
    assert.equal(current.previous, null);
    assert.deepEqual(current.edits, []);
    assert.equal(current.text.length, huge.length);
    assert.equal(current.text.slice(0, 4), "xxxx");
  } finally {
    document.close();
    buffer.destroy();
  }
});

test("gaps, unavailable pending changes and bounded history choose a fresh parse", () => {
  const buffer = source("a"),
    document = new TreeSitterDocument(buffer, { maxChanges: 1 });
  const first = document.capture();
  const pending = buffer.edit(0, 1, "b", false);
  assert.equal(document.capture(first).previous, null);
  buffer.emit(pending);
  assert.equal(document.capture(first).edits.length, 1);
  buffer.edit(0, 1, "c");
  assert.equal(document.capture(first).previous, null);
  const latest = document.capture();
  buffer.edit(0, 1, "d", false);
  buffer.edit(0, 1, "e");
  assert.equal(document.capture(latest).previous, null);
  assert.equal(document.capture().text.toString(), "e");
  document.close();
});

test("pending changes must connect the complete revision chain and obey history bounds", () => {
  const buffer = source("a"),
    document = new TreeSitterDocument(buffer, { maxChanges: 2, maxTextUnits: 10 });
  const first = document.capture();
  const a = buffer.edit(0, 1, "ab");
  const b = buffer.edit(2, 2, "c", false);
  buffer.getPendingAppliedChanges = () => b;
  const combined = document.capture(first);
  assert.equal(combined.previous, first);
  assert.equal(combined.edits.length, 2);
  assert.equal(combined.text.toString(), "abc");
  const c = buffer.edit(3, 3, "d", false);
  buffer.getPendingAppliedChanges = () => c;
  assert.equal(document.capture(first).previous, null); // Missing b.
  buffer.getPendingAppliedChanges = () => ({
    beforeRevision: b.beforeRevision,
    afterRevision: c.afterRevision,
    changes: [...b.changes, ...c.changes],
  });
  assert.equal(document.capture(first).previous, null); // Three edits exceed the limit.
  buffer.emit(b);
  buffer.emit(c);
  buffer.getPendingAppliedChanges = () => null;
  const current = document.capture();
  const large = buffer.edit(4, 4, "x".repeat(11), false);
  buffer.getPendingAppliedChanges = () => large;
  assert.equal(document.capture(current).previous, null);
  assert.equal(combined.text.toString(), "abc");
  assert.equal(a.afterRevision, b.beforeRevision);
  document.close();
});

test("stale event delivery never labels live text with the event revision", () => {
  const buffer = source("old"),
    document = new TreeSitterDocument(buffer);
  const first = document.capture();
  const a = buffer.edit(0, 3, "middle", false);
  const b = buffer.edit(0, 6, "new", false);
  buffer.emit(a);
  assert.equal(a.isCurrent(), false);
  const during = document.capture(first);
  assert.equal(during.revision, b.afterRevision);
  assert.equal(during.previous, null);
  buffer.emit(b);
  assert.equal(document.capture(first).edits.length, 2);
  document.close();
});

test("parser scheduler bounds concurrency and prioritizes queued work", async () => {
  const scheduler = new TreeSitterScheduler(1),
    started = [],
    releases = [];
  const run = (name, priority) =>
    scheduler.run(
      () => {
        started.push(name);
        return new Promise((resolve) => releases.push(resolve));
      },
      { priority: () => priority },
    );
  const first = run("first", 9),
    low = run("low", 9),
    high = run("high", 0);
  await new Promise(setImmediate);
  assert.deepEqual(started, ["first"]);
  assert.equal(scheduler.active, 1);
  releases.shift()();
  await first;
  await new Promise(setImmediate);
  assert.deepEqual(started, ["first", "high"]);
  releases.shift()();
  await high;
  await new Promise(setImmediate);
  releases.shift()();
  await low;
  await new Promise(setImmediate);
  assert.deepEqual(started, ["first", "high", "low"]);
  assert.equal(scheduler.active, 0);
});

test("cancelled queued parser jobs never run and errors release capacity", async () => {
  const scheduler = new TreeSitterScheduler(1),
    controller = new AbortController();
  let release,
    ran = false;
  const active = scheduler.run(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const queued = scheduler.run(
    () => {
      ran = true;
    },
    { signal: controller.signal },
  );
  const rejection = assert.rejects(queued, { name: "AbortError" });
  controller.abort();
  await rejection;
  await new Promise(setImmediate);
  release();
  await active;
  await assert.rejects(
    scheduler.run(() => {
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.equal(await scheduler.run(() => 42), 42);
  assert.equal(ran, false);
});

function verifyReplay(first, capture) {
  let text = first.text;
  for (const edit of capture.edits) {
    assert.deepEqual(edit.startPosition, text.positionAt(edit.startIndex));
    assert.deepEqual(edit.oldEndPosition, text.positionAt(edit.oldEndIndex));
    assert.equal(edit.newEndIndex, edit.startIndex + edit.newText.length);
    text = text.replace(edit.startIndex, edit.oldEndIndex, edit.newText);
    assert.deepEqual(edit.newEndPosition, text.positionAt(edit.startIndex + edit.newText.length));
    assert.ok(Object.isFrozen(edit));
    for (const point of [edit.startPosition, edit.oldEndPosition, edit.newEndPosition])
      assert.ok(Object.isFrozen(point));
  }
  assert.equal(text.toString(), capture.text.toString());
}

test("long adjacent typing, replacement and backspace journals coalesce without flattening", () => {
  const buffer = new DocumentCore("prefix\r\nold text\r\nsuffix");
  const reader = new TreeSitterDocument(buffer);
  const first = reader.capture();
  let at = 8;
  for (let i = 0; i < 240; i++) {
    const inserted = i % 7 === 0 ? "😀\r\n" : "x";
    buffer.transact((draft) => draft.replace(at, at, inserted));
    at += inserted.length;
  }
  for (let i = 0; i < 90; i++) buffer.transact((draft) => draft.replace(--at, at + 1, ""));
  buffer.transact((draft) => draft.replace(6, at + 4, "joined\n"));
  const flatten = PieceTree.prototype.toString;
  let capture;
  try {
    PieceTree.prototype.toString = () => {
      throw Error("Unexpected flattening");
    };
    capture = reader.capture(first);
  } finally {
    PieceTree.prototype.toString = flatten;
  }
  assert.equal(capture.edits.length, 1);
  verifyReplay(first, capture);
  assert.equal(reader.capture(first).edits, capture.edits);
  reader.close();
});

test("coalesced journals replay random multiline edits, disjoint changes and undo exactly", () => {
  let seed = 0x8fe120;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const inserts = ["", "a", "\r", "\n", "\r\n", "😀", "\ud800", "xy\n終"];
  for (let round = 0; round < 100; round++) {
    const buffer = new DocumentCore("left\r\n😀middle\nright".repeat(12));
    const reader = new TreeSitterDocument(buffer);
    const first = reader.capture();
    for (let i = 0; i < 180; i++) {
      if (i % 17 === 16) {
        buffer.undo();
        continue;
      }
      const length = buffer.getTextSnapshot().length;
      const start = random(length + 1);
      const end = start + random(Math.min(10, length - start) + 1);
      buffer.transact((draft) => draft.replace(start, end, inserts[random(inserts.length)]));
    }
    const capture = reader.capture(first);
    assert.equal(capture.previous, first);
    verifyReplay(first, capture);
    reader.close();
  }
});
