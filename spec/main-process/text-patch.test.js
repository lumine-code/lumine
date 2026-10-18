const { test } = require("node:test");
const assert = require("node:assert/strict");
const Patch = require("../../src/text-patch");
const { Patch: NativePatch } = require("@lumine-code/superstring");
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

test("text patches compose sequential UTF-16 edits like the native oracle", () => {
  for (const mergeAdjacentChanges of [true, false]) {
    for (let seed = 1; seed <= 25; seed++) {
      const random = rng(seed),
        js = new Patch({ mergeAdjacentChanges }),
        native = new NativePatch({ mergeAdjacentChanges });
      const original = "first\r\nsecond😀\nthird line\n".repeat(6);
      let text = original;
      for (let edit = 0; edit < 100; edit++) {
        const start = random(text.length + 1),
          end = Math.min(text.length, start + random(10));
        const inserted = ["", "\n", "a\r\nB", "😀", "z", "\ud800"][random(6)];
        const deleted = text.slice(start, end);
        const args = [
          position(text, start),
          position(deleted),
          position(inserted),
          deleted,
          inserted,
        ];
        js.splice(...args);
        native.splice(...args);
        text = text.slice(0, start) + inserted + text.slice(end);
        assert.deepEqual(
          clean(js.getChanges()),
          clean(native.getChanges()),
          `seed ${seed} edit ${edit} merge ${mergeAdjacentChanges}`,
        );
        assert.deepEqual(clean(js.invert().getChanges()), clean(native.invert().getChanges()));
        let replay = original;
        const offset = (value, point) =>
          value
            .split("\n")
            .slice(0, point.row)
            .reduce((sum, line) => sum + line.length + 1, 0) + point.column;
        for (const h of js.getChanges().reverse())
          replay =
            replay.slice(0, offset(replay, h.oldStart)) +
            h.newText +
            replay.slice(offset(replay, h.oldEnd));
        assert.equal(replay, text);
        for (const p of [
          position(text, 0),
          position(text, random(text.length + 1)),
          position(text),
        ]) {
          const expected = clean(native.getChanges())
            .filter(
              (h) =>
                h.newStart.row < p.row ||
                (h.newStart.row === p.row && h.newStart.column <= p.column),
            )
            .at(-1);
          assert.deepEqual(
            js.changeForNewPosition(p) && clean(js.changeForNewPosition(p)),
            expected,
          );
        }
      }
      assert.deepEqual(
        clean(Patch.deserialize(js.serialize()).getChanges()),
        clean(js.getChanges()),
      );
      assert.deepEqual(Patch.compose([js, js.invert()]).getChanges(), []);
    }
  }
});

test("geometry patches and old-coordinate invalidation match the native map", () => {
  for (const mergeAdjacentChanges of [true, false]) {
    for (let seed = 1; seed <= 30; seed++) {
      const random = rng(seed),
        js = new Patch({ mergeAdjacentChanges }),
        native = new NativePatch({ mergeAdjacentChanges });
      for (let edit = 0; edit < 200; edit++) {
        const method = random(4) === 0 ? "spliceOld" : "splice";
        const args = [
          { row: random(30), column: random(20) },
          { row: random(3), column: random(8) },
          { row: random(3), column: random(8) },
        ];
        js[method](...args);
        native[method](...args);
        assert.deepEqual(
          clean(js.getChanges()),
          clean(native.getChanges()),
          `seed ${seed} edit ${edit} ${method} merge ${mergeAdjacentChanges} ${JSON.stringify(args)}`,
        );
        const a = { row: random(10), column: random(15) },
          b = { row: 25, column: random(20) };
        assert.deepEqual(
          clean(js.getChangesInNewRange(a, b)),
          clean(native.getChangesInNewRange(a, b)),
        );
        assert.deepEqual(
          clean(js.getChangesInOldRange(a, b)),
          clean(native.getChangesInOldRange(a, b)),
        );
      }
    }
  }
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
