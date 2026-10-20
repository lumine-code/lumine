const { test } = require("node:test");
const assert = require("node:assert/strict");
const Patch = require("../../src/text-patch");
const { Patch: NativePatch } = require("../../script/native-superstring-reference").load();
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

test("bulk independent patches match incremental native patches and keep persistent copies", () => {
  const changes = Array.from({ length: 500 }, (_, row) => ({
    oldStart: { row: row * 2, column: 1 },
    oldEnd: { row: row * 2, column: 3 },
    newStart: { row: row * 2, column: 1 },
    newEnd: { row: row * 2, column: 4 },
    oldText: "xx",
    newText: "new",
  }));
  const js = Patch.fromIndependentChanges(changes),
    native = new NativePatch();
  for (const change of changes)
    native.splice(
      change.newStart,
      { row: 0, column: 2 },
      { row: 0, column: 3 },
      change.oldText,
      change.newText,
    );
  assert.deepEqual(clean(js.getChanges()), clean(native.getChanges()));
  const copy = js.copy();
  js.splice({ row: 0, column: 0 }, { row: 0, column: 0 }, { row: 1, column: 0 }, "", "\n");
  native.splice({ row: 0, column: 0 }, { row: 0, column: 0 }, { row: 1, column: 0 }, "", "\n");
  assert.deepEqual(clean(js.getChanges()), clean(native.getChanges()));
  assert.deepEqual(clean(copy.getChanges()), changes);
  assert.deepEqual(Patch.compose([copy, copy.invert()]).getChanges(), []);
  assert.equal(Patch.fromIndependentChanges([changes[0], changes[0]]), null);
});

test("same-row independent patches merge adjacent changes exactly like native", () => {
  let seed = 991;
  const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  for (let sample = 0; sample < 50; sample++) {
    const changes = [],
      native = new NativePatch();
    for (let row = 0; row < 5; row++) {
      let column = 0,
        delta = 0;
      for (let i = 0; i < 16; i++) {
        const oldLength = random(3),
          newLength = random(4);
        const oldText = "a".repeat(oldLength),
          newText = "b".repeat(newLength);
        const change = {
          oldStart: { row, column },
          oldEnd: { row, column: column + oldLength },
          newStart: { row, column: column + delta },
          newEnd: { row, column: column + delta + newLength },
          oldText,
          newText,
        };
        changes.push(change);
        native.splice(
          change.newStart,
          { row: 0, column: oldLength },
          { row: 0, column: newLength },
          oldText,
          newText,
        );
        delta += newLength - oldLength;
        column += oldLength + (oldLength ? random(2) : 1);
      }
    }
    const patch = Patch.fromIndependentChanges(changes);
    assert(patch);
    assert.deepEqual(clean(patch.getChanges()), clean(native.getChanges()));
    assert.deepEqual(Patch.compose([patch, patch.invert()]).getChanges(), []);
  }
});

test("multiline independent patches match native through adjacent edits and row shifts", () => {
  let seed = 1701;
  const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  const position = (text, offset) => {
    const prefix = text.slice(0, offset);
    return { row: prefix.split("\n").length - 1, column: offset - prefix.lastIndexOf("\n") - 1 };
  };
  for (let sample = 0; sample < 100; sample++) {
    const source = "ab😀\r\ncd\nef\n".repeat(100),
      changes = [],
      native = new NativePatch();
    let output = source,
      cursor = 0,
      delta = 0;
    for (let i = 0; i < 50; i++) {
      const start = cursor + random(3),
        end = start + random(9);
      const text = ["", "x\ny", "😀\r\nZ\n", "ending", "\n"][random(5)];
      const oldText = source.slice(start, end);
      const newStart = position(output, start + delta);
      output = output.slice(0, start + delta) + text + output.slice(end + delta);
      const newEnd = position(output, start + delta + text.length);
      changes.push({
        oldStart: position(source, start),
        oldEnd: position(source, end),
        newStart,
        newEnd,
        oldText,
        newText: text,
      });
      native.splice(
        newStart,
        position(oldText, oldText.length),
        position(text, text.length),
        oldText,
        text,
      );
      delta += text.length - oldText.length;
      cursor = end + (start === end ? 1 : 0);
    }
    const patch = Patch.fromIndependentChanges(changes);
    assert(patch);
    assert.deepEqual(clean(patch.getChanges()), clean(native.getChanges()));
    assert.deepEqual(Patch.compose([patch, patch.invert()]).getChanges(), []);
  }
});

test("composing canonical patches removes identities and preserves independent roots", () => {
  for (const mergeAdjacentChanges of [true, false]) {
    const js = new Patch({ mergeAdjacentChanges }),
      native = new NativePatch({ mergeAdjacentChanges });
    for (const patch of [js, native]) {
      patch.splice({ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 1 }, "a", "a");
      patch.splice({ row: 1, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }, "x", "XX");
      patch.splice({ row: 1, column: 2 }, { row: 0, column: 1 }, { row: 0, column: 1 }, "y", "Y");
      patch.splice({ row: 2, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 1 }, "b", "b");
    }
    const result = Patch.compose([js]);
    const reference = NativePatch.compose([native]);
    assert.deepEqual(clean(result.getChanges()), clean(reference.getChanges()));
    const saved = clean(result.getChanges());
    js.splice({ row: 0, column: 0 }, { row: 0, column: 0 }, { row: 1, column: 0 }, "", "\n");
    assert.deepEqual(clean(result.getChanges()), saved);
    const original = clean(js.getChanges());
    result.splice({ row: 0, column: 0 }, { row: 0, column: 0 }, { row: 0, column: 1 }, "", "!");
    assert.deepEqual(clean(js.getChanges()), original);
  }
});

test("composing many ordered selection patches matches native and falls back for overlaps", () => {
  for (const overlap of [false, true]) {
    const patches = [],
      native = new NativePatch();
    for (let i = 0; i < 200; i++) {
      const start = { row: overlap ? 0 : i * 3, column: 2 };
      const oldExtent = { row: 0, column: 1 },
        newExtent = { row: 1, column: 1 };
      const patch = new Patch();
      patch.splice(start, oldExtent, newExtent, "a", "x\ny");
      native.splice(start, oldExtent, newExtent, "a", "x\ny");
      patches.push(patch);
    }
    const before = patches.map((patch) => clean(patch.getChanges()));
    const combined = Patch.compose(patches);
    assert.deepEqual(clean(combined.getChanges()), clean(native.getChanges()));
    assert.deepEqual(
      patches.map((patch) => clean(patch.getChanges())),
      before,
    );
    assert.deepEqual(Patch.compose([combined, combined.invert()]).getChanges(), []);
  }
});
