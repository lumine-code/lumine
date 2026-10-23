const { test } = require("node:test");
const assert = require("node:assert/strict");
const MarkerIndex = require("../../src/marker-index");
const point = (row, column = 0) => ({ row, column });
const compare = (a, b) => a.row - b.row || a.column - b.column;

test("lazy translations and bounded queries agree with a flat coordinate list", () => {
  const index = new MarkerIndex();
  const entries = Array.from({ length: 1000 }, (_, id) => ({
    id,
    start: point(100 + (id % 100), id % 7),
    end: point(102 + (id % 100), 9),
  }));
  for (const entry of entries) index.insert(entry.id, entry.start, entry.end);
  for (let step = 0; step < 100; step++) {
    const removedRows = step % 3,
      insertedRows = (step + 1) % 3;
    index.splice(point(0), point(removedRows, 1), point(insertedRows, 4));
    for (const entry of entries) {
      entry.start.row += insertedRows - removedRows;
      entry.end.row += insertedRows - removedRows;
    }
    for (const [start, end] of [
      [point(0), point(Infinity, Infinity)],
      [point(130, 2), point(170, 5)],
      [point(10000), point(10001)],
    ]) {
      const expected = entries
        .filter((e) => compare(e.start, start) >= 0 && compare(e.start, end) <= 0)
        .map((e) => e.id);
      for (const limit of [0, 1, 32, 1000]) {
        const actual = index.findStartingInLimited(start, end, limit);
        if (expected.length > limit) assert.equal(actual, null);
        else
          assert.deepEqual(
            actual.sort((a, b) => a - b),
            expected,
          );
      }
      const overlapping = entries
        .filter((e) => compare(e.end, start) >= 0 && compare(e.start, end) <= 0)
        .map((e) => e.id);
      assert.deepEqual([...index.findIntersecting(start, end)], overlapping);
    }
    // Partial reads leave unresolved suffixes to exercise the lazy index.
    for (const id of [199, 1, 700, 50])
      assert.deepEqual(index.getRange(id), { start: entries[id].start, end: entries[id].end });
  }
});

test("endpoint affinity and covering deletions follow the marker contract", () => {
  for (const [exclusive, at, oldLength, newLength, expected] of [
    [false, 2, 0, 2, [2, 7]],
    [true, 2, 0, 2, [4, 7]],
    [false, 5, 0, 2, [2, 7]],
    [true, 5, 0, 2, [2, 5]],
    [false, 3, 1, 3, [2, 7]],
    [true, 3, 1, 3, [2, 7]],
    [false, 0, 7, 1, [1, 1]],
    [true, 0, 7, 1, [1, 1]],
  ]) {
    const index = new MarkerIndex();
    index.insert(1, point(0, 2), point(0, 5));
    index.setExclusive(1, exclusive);
    const flags = index.splice(point(0, at), point(0, oldLength), point(0, newLength));
    assert.deepEqual(index.getRange(1), {
      start: point(0, expected[0]),
      end: point(0, expected[1]),
    });
    assert(flags.touch.has(1));
    if (oldLength === 7) {
      for (const name of ["inside", "overlap", "surround"]) assert(flags[name].has(1));
    }
  }
});

test("returned ranges are detached and duplicate identities reject", () => {
  const index = new MarkerIndex();
  index.insert(1, point(1), point(3));
  assert.throws(() => index.insert(1, point(9), point(10)), /Duplicate/);
  index.getRange(1).start.row = 99;
  index.getRanges([1]).fill(999);
  assert.deepEqual(index.getStart(1), point(1));
  index.remove(1);
  index.remove(1);
  assert.equal(index.has(1), false);
});

test("queries clip negative and fractional probes without mutating caller positions", () => {
  const index = new MarkerIndex();
  index.insert(1, point(2, 0), point(3, 4));
  const probe = Object.freeze(point(2, -1));
  assert.deepEqual([...index.findContaining(probe)], [1]);
  assert.deepEqual([...index.findStartingAt(point(2.5, -0.5))], [1]);
  assert.equal(probe.column, -1);
  assert.throws(() => index.insert(2, point(2, -1), point(3)), RangeError);
});

test("suffix-only splices invalidate resolved reads even when no marker flags are returned", () => {
  const index = new MarkerIndex();
  for (let id = 1; id <= 200; id++) index.insert(id, point(id * 3), point(id * 3 + 1, 4));
  for (const id of [199, 1, 100, 50]) assert.deepEqual(index.getStart(id), point(id * 3));

  assert.equal(index.splicePacked(point(0), point(0), point(2, 5)), null);
  assert.deepEqual(index.getStart(199), point(599));
  assert.deepEqual(index.getEnd(1), point(6, 4));
  assert.deepEqual(index.getStart(100), point(302));

  assert.equal(index.splicePacked(point(0), point(1), point(0)), null);
  assert.deepEqual(index.getStart(199), point(598));
  assert.deepEqual(index.getStart(1), point(4));
});

test("resolved reads survive structural insertions and removals after a lazy suffix shift", () => {
  const index = new MarkerIndex();
  for (let id = 1; id <= 200; id++) index.insert(id, point(id * 3), point(id * 3, 2));
  index.splicePacked(point(0), point(0), point(2));
  assert.deepEqual(index.getStart(100), point(302));

  index.insert(201, point(150, 1), point(151));
  index.remove(50);
  index.remove(150);
  index.splicePacked(point(1), point(0), point(1));

  assert.deepEqual(index.getStart(201), point(151, 1));
  assert.deepEqual(index.getEnd(201), point(152));
  assert.deepEqual(index.getStart(100), point(303));
  assert.deepEqual(index.getStart(200), point(603));
  assert.throws(() => index.getStart(50), /Unknown marker/);
  assert.throws(() => index.getRange(150), /Unknown marker/);
});

test("cached scalar reads retain detached copies and unknown-id errors", () => {
  const index = new MarkerIndex();
  index.insert(1, point(1, 2), point(3, 4));
  index.getStart(1);
  const start = index.getStart(1);
  const end = index.getEnd(1);
  const range = index.getRange(1);
  start.row = 99;
  end.column = 99;
  range.start.column = 99;
  range.end.row = 99;
  index.getRanges([1]).fill(99);

  assert.deepEqual(index.getStart(1), point(1, 2));
  assert.deepEqual(index.getEnd(1), point(3, 4));
  for (const method of ["getStart", "getEnd", "getRange"]) {
    assert.throws(() => index[method](999), /Unknown marker/);
  }
  assert.throws(() => index.getRanges([1, 999]), /Unknown marker/);
});

test("affinity changes and cached or unresolved removals preserve lazy coordinates", () => {
  const index = new MarkerIndex();
  for (let id = 1; id <= 64; id++) index.insert(id, point(id * 2, 1), point(id * 2, 3));
  assert.equal(index.splicePacked(point(0), point(0), point(2, 5)), null);

  // Neither affinity write needs to materialize the pending row translation.
  index.setExclusive(32, true);
  index.setExclusive(33, false);
  assert.deepEqual(index.getRange(31), { start: point(64, 1), end: point(64, 3) });
  index.remove(31);
  index.remove(40);
  assert.throws(() => index.setExclusive(31, false), /Unknown marker 31/);
  assert.throws(() => index.setExclusive(999, true), /Unknown marker 999/);

  index.splicePacked(point(66, 1), point(0), point(0, 2));
  assert.deepEqual(index.getRange(32), { start: point(66, 3), end: point(66, 5) });
  index.splicePacked(point(68, 1), point(0), point(0, 2));
  assert.deepEqual(index.getRange(33), { start: point(68, 1), end: point(68, 5) });
  assert.deepEqual(index.getRange(64), { start: point(130, 1), end: point(130, 3) });
  assert.deepEqual(
    [...index.findStartingIn(point(0), point(Infinity, Infinity))],
    Array.from({ length: 64 }, (_, i) => i + 1).filter((id) => id !== 31 && id !== 40),
  );
});
