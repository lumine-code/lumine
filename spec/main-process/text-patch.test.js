const { test } = require("node:test");
const assert = require("node:assert/strict");
const Patch = require("../../src/text-patch");
// Native patches can retain zero-width identity records. They have no text or
// coordinate effect; the new contract elides them rather than exposing an
// implementation-dependent change count.
const clean = (value) => {
  const result = JSON.parse(JSON.stringify(value));
  return Array.isArray(result)
    ? result.filter(
        (h) =>
          h.oldStart.row !== h.oldEnd.row ||
          h.oldStart.column !== h.oldEnd.column ||
          h.newStart.row !== h.newEnd.row ||
          h.newStart.column !== h.newEnd.column,
      )
    : result;
};
const position = (text, index = text.length) => {
  const prefix = text.slice(0, index);
  return { row: prefix.split("\n").length - 1, column: index - prefix.lastIndexOf("\n") - 1 };
};
const rng = (seed) => (limit) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % limit;
};

function replay(source, patch) {
  const offset = (point) =>
    source
      .split("\n")
      .slice(0, point.row)
      .reduce((sum, line) => sum + line.length + 1, 0) + point.column;
  for (const change of patch.getChanges().reverse()) {
    const start = offset(change.oldStart),
      end = offset(change.oldEnd);
    assert.equal(source.slice(start, end), change.oldText);
    source = source.slice(0, start) + change.newText + source.slice(end);
  }
  return source;
}

test("composed edits and inverse patches replay exactly against flat strings", () => {
  for (const mergeAdjacentChanges of [false, true]) {
    for (let seed = 1; seed <= 25; seed++) {
      const random = rng(seed),
        patch = new Patch({ mergeAdjacentChanges });
      const original = "first\r\nsecond😀\nthird\r".repeat(6);
      let text = original;
      for (let step = 0; step < 100; step++) {
        const start = random(text.length + 1);
        const end = Math.min(text.length, start + random(10));
        const inserted = ["", "\n", "\r\n", "😀", "\ud800", "text"][random(6)];
        const removed = text.slice(start, end);
        patch.splice(
          position(text, start),
          position(removed),
          position(inserted),
          removed,
          inserted,
        );
        text = text.slice(0, start) + inserted + text.slice(end);
        assert.equal(replay(original, patch), text);
        assert.equal(replay(text, patch.invert()), original);
      }
      assert.equal(replay(original, Patch.deserialize(patch.serialize())), text);
      const composed = Patch.compose([patch, patch.invert()]);
      assert.deepEqual(composed.getChanges(), []);
    }
  }
});

test("bulk independent changes preserve source text and saved roots", () => {
  const original = "a xx z\n".repeat(500);
  const changes = Array.from({ length: 500 }, (_, row) => ({
    oldStart: { row, column: 2 },
    oldEnd: { row, column: 4 },
    newStart: { row, column: 2 },
    newEnd: { row, column: 5 },
    oldText: "xx",
    newText: "new",
  }));
  const patch = Patch.fromIndependentChanges(changes);
  const copy = patch.copy();
  assert.equal(replay(original, patch), "a new z\n".repeat(500));
  patch.splice({ row: 0, column: 0 }, position(""), position("\n"), "", "\n");
  assert.equal(replay(original, patch), "\n" + "a new z\n".repeat(500));
  assert.equal(replay(original, copy), "a new z\n".repeat(500));
  assert.equal(Patch.fromIndependentChanges([changes[0], changes[0]]), null);
});

test("retained geometry copies survive lazy suffix shifts and independent edits", () => {
  const patch = new Patch({ mergeAdjacentChanges: false });
  for (let row = 0; row < 10000; row++)
    patch.splice({ row, column: 4 }, { row: 0, column: 0 }, { row: 0, column: 1 });
  const original = clean(patch.getChanges());
  const copy = patch.copy();
  for (let edit = 0; edit < 100; edit++)
    patch.splice({ row: 0, column: 0 }, { row: 0, column: 0 }, { row: 1, column: 0 });
  // Read alternating roots to force resolution of shared lazy paths.
  assert.equal(patch.getChanges().at(-1).newStart.row, 10099);
  assert.deepEqual(clean(copy.getChanges()), original);
  copy.splice({ row: 5000, column: 0 }, { row: 0, column: 0 }, { row: 1, column: 0 });
  assert.equal(copy.getChanges().at(-1).newStart.row, 10000);
  assert.equal(patch.getChanges().at(-1).newStart.row, 10099);
});
