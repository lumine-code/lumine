const { test } = require("node:test");
const assert = require("node:assert/strict");
const TreeSitterDocument = require("../../src/tree-sitter-document");
const { TreeSitterScheduler } = require("../../src/tree-sitter-scheduler");

function source(initial = "") {
  let text = initial,
    revision = 0,
    listener,
    reads = 0;
  return {
    getTextRevision: () => revision,
    getText: () => {
      reads++;
      return text;
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
  let replayed = first.text;
  for (const edit of next.edits)
    replayed = replayed.slice(0, edit.startIndex) + edit.newText + replayed.slice(edit.oldEndIndex);
  assert.equal(next.previous, first);
  assert.equal(replayed, next.text);
  assert.equal(document.isCurrent(first), false);
  assert.equal(document.isCurrent(next), true);
  assert.equal(first.text, "a\r\nb🦉");
  document.close();
  assert.equal(document.isCurrent(next), false);
  assert.throws(() => document.capture(), /closed/);
});

test("gaps, unfinished transactions and bounded history choose a fresh parse", () => {
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
  assert.equal(document.capture().text, "e");
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
