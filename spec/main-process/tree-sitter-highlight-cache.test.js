const assert = require("node:assert/strict");
const { test } = require("node:test");
const Point = require("../../src/point");
const HighlightCache = require("../../src/tree-sitter-highlight-cache");

const point = (row, column = 0) => new Point(row, column);

test("coverage follows replacement, eviction and edits without mixing syntax generations", () => {
  const cache = new HighlightCache();
  const old = { revision: 1, generation: 0, presentation: 0 };
  const current = { revision: 2, generation: 0, presentation: 1 };
  const tile = (start, end) => ({ start: point(start), end: point(end), scopes: [1], events: [] });
  cache.replace([tile(40, 50), tile(10, 20)], current);
  cache.replace([tile(0, 10)], old);
  assert.equal(cache.covers(point(0), point(20)), true);
  assert.equal(cache.covers(point(0), point(20), current), false);
  assert.deepEqual(cache.uncoveredRanges(point(0), point(50), current), [
    [point(0), point(10)],
    [point(20), point(40)],
  ]);
  cache.replace([tile(8, 45)], current);
  assert.equal(cache.covers(point(8), point(50), current), true);
  assert.equal(cache.covers(point(8), point(50), { ...current, presentation: 2 }), false);
  cache.removeSnapshot(cache.snapshots.findIndex((item) => item.start.row === 8));
  assert.equal(cache.covers(point(0), point(50)), false);
  assert.deepEqual(cache.uncoveredRanges(point(0), point(50)), [[point(8), point(45)]]);
  cache.edit({ oldRange: { start: point(0), end: point(0) }, newRange: { end: point(1) } });
  assert.deepEqual(cache.uncoveredRanges(point(0), point(51)), [[point(9), point(46)]]);
  cache.clear();
  assert.equal(cache.covers(point(0), point(1)), false);
});

test("coverage follows a live recording and its eviction limits", () => {
  const cache = new HighlightCache({ maxSnapshots: 1, maxEvents: 4 });
  record(cache, point(0), point(1), [1], []);
  assert.equal(cache.covers(point(0), point(1)), true);
  let column = 1;
  const iterator = cache.record(
    {
      seek: () => [1],
      getPosition: () => (column <= 4 ? point(10, column) : Point.INFINITY),
      getOpenScopeIds: () => [],
      getCloseScopeIds: () => [],
      moveToSuccessor: () => column++,
    },
    { clipPosition: () => point(11) },
  );
  iterator.seek(point(10), 10);
  assert.equal(cache.covers(point(0), point(1)), false);
  assert.equal(cache.covers(point(10), point(10, 1)), true);
  assert.equal(cache.covers(point(10), point(10, 2)), false);
  iterator.moveToSuccessor();
  assert.equal(cache.covers(point(10), point(10, 2)), true);
  iterator.moveToSuccessor();
  iterator.moveToSuccessor();
  assert.equal(cache.covers(point(10), point(10, 1)), false);
});

test("eviction stays visible when the retention callback reads coverage", () => {
  const cache = new HighlightCache({ maxSnapshots: 2 });
  const tile = (row) => ({ start: point(row), end: point(row + 1), scopes: [1], events: [] });
  cache.replace([tile(0), tile(10)], {});
  cache.replace([tile(20)], {}, () => {
    assert.equal(cache.covers(point(0), point(1)), true);
    return false;
  });
  assert.equal(cache.covers(point(0), point(1)), false);
  assert.equal(cache.covers(point(10), point(11)), true);
  assert.equal(cache.covers(point(20), point(21)), true);
});

test("subtracts prepared ranges without repainting the middle of a larger tile", () => {
  const cache = new HighlightCache();
  const old = { revision: 1, generation: 0, presentation: 0 };
  const current = { revision: 2, generation: 0, presentation: 1 };
  cache.replace([{ start: point(0), end: point(128), scopes: [], events: [] }], old);
  cache.replace([{ start: point(40), end: point(80), scopes: [], events: [] }], current);
  assert.deepEqual(cache.uncoveredRanges(point(0), point(128)), []);
  assert.deepEqual(cache.uncoveredRanges(point(0), point(128), current), [
    [point(0), point(40)],
    [point(80), point(128)],
  ]);
  assert.deepEqual(cache.uncoveredRanges(point(45), point(70), current), []);
  assert.deepEqual(cache.uncoveredRanges(point(140), point(150), current), [
    [point(140), point(150)],
  ]);
});
function record(cache, start, end, scopes, events, complete = false) {
  let index;
  const iterator = cache.record(
    {
      seek: () => {
        index = 0;
        return scopes;
      },
      getPosition: () => events[index]?.position ?? Point.INFINITY,
      getOpenScopeIds: () => events[index]?.open ?? [],
      getCloseScopeIds: () => events[index]?.close ?? [],
      moveToSuccessor: () => {
        index++;
      },
    },
    { clipPosition: () => end },
    { complete },
  );
  iterator.seek(start, end.row);
  while (iterator.getPosition() !== Point.INFINITY) iterator.moveToSuccessor();
}
function at(cache, position, end = point(position.row + 1)) {
  const { scopes, iterator } = cache.read(position, end, [1]);
  while (iterator.getPosition().compare(position) <= 0) {
    for (const id of iterator.getCloseScopeIds()) {
      const index = scopes.lastIndexOf(id);
      if (index !== -1) scopes.splice(index, 1);
    }
    scopes.push(...iterator.getOpenScopeIds());
    iterator.moveToSuccessor();
  }
  return scopes;
}

test("copied paint follows edits but cannot satisfy current syntax coverage", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(2),
    [1],
    [
      { position: point(0, 2), open: [2], close: [] },
      { position: point(0, 4), open: [], close: [2] },
      { position: point(1), open: [3], close: [] },
      { position: point(1, 4), open: [], close: [3] },
    ],
  );
  const current = { revision: 2, generation: 1, presentation: 1 };
  assert.equal(cache.copyRange(point(0, 1), point(1, 3), point(5, 2), [1]), true);
  assert.deepEqual(at(cache, point(5, 3)), [1, 2]);
  assert.deepEqual(at(cache, point(6, 1)), [1, 3]);
  assert.equal(cache.covers(point(5, 2), point(6, 3)), true);
  assert.equal(cache.covers(point(5, 2), point(6, 3), current), false);
  cache.edit({ oldRange: { start: point(5), end: point(5) }, newRange: { end: point(6) } });
  assert.deepEqual(at(cache, point(6, 3)), [1, 2]);
  cache.replace([{ start: point(6, 2), end: point(7, 3), scopes: [1, 4], events: [] }], current);
  assert.deepEqual(at(cache, point(6, 3)), [1, 4]);
  assert.deepEqual(at(cache, point(0, 3)), [1, 2]);
});

test("copying partial paint preserves its gaps and empty copies do not claim coverage", () => {
  const cache = new HighlightCache();
  record(cache, point(0), point(1), [1], []);
  record(cache, point(2), point(3), [1, 2], []);
  assert.equal(cache.copyRange(point(0), point(3), point(5), [1]), true);
  assert.equal(cache.copyRange(point(0), point(0), point(5), [1]), false);
  assert.equal(cache.copyRange(point(20), point(21), point(30), [1]), false);
  assert.equal(cache.covers(point(5), point(6)), true);
  assert.equal(cache.covers(point(6), point(7)), false);
  assert.deepEqual(at(cache, point(7)), [1, 2]);
});
test("rebases painted scope boundaries through insert, delete and undo geometry", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(2),
    [1],
    [
      { position: point(0, 1), open: [2], close: [] },
      { position: point(0, 3), open: [], close: [2] },
      { position: point(1), open: [3], close: [] },
      { position: point(1, 4), open: [], close: [3] },
    ],
  );
  cache.edit({ oldRange: { start: point(0), end: point(0) }, newRange: { end: point(0, 2) } });
  assert.deepEqual(at(cache, point(0, 3)), [1, 2]);
  assert.deepEqual(at(cache, point(1, 1)), [1, 3]);
  cache.edit({ oldRange: { start: point(0), end: point(0, 2) }, newRange: { end: point(0) } });
  assert.deepEqual(at(cache, point(0, 1)), [1, 2]);
  cache.edit({ oldRange: { start: point(0), end: point(1) }, newRange: { end: point(0) } });
  assert.deepEqual(at(cache, point(0, 1)), [1, 3]);
});

test("shifts cold fragments without visiting their events and resolves later partial edits", () => {
  const cache = new HighlightCache();
  let reads = 0;
  const events = [];
  for (let row = 100; row < 128; row++) {
    for (const column of [0, 1])
      events.push({
        get position() {
          reads++;
          return point(row, column);
        },
        open: column === 0 ? [2] : [],
        close: column === 1 ? [2] : [],
      });
  }
  cache.replace([{ start: point(100), end: point(128), scopes: [1], events }], {});
  for (const count of [2, 3])
    cache.edit({
      oldRange: { start: point(0), end: point(0) },
      newRange: { end: point(count) },
    });
  cache.rebase();
  assert.equal(reads, 0);
  assert.deepEqual(at(cache, point(106)), [1, 2]);
  assert.deepEqual(at(cache, point(106, 1)), [1]);
  cache.replace([{ start: point(106), end: point(107), scopes: [1, 3], events: [] }], {});
  assert.deepEqual(at(cache, point(105)), [1, 2]);
  assert.deepEqual(at(cache, point(106)), [1, 3]);
  assert.deepEqual(at(cache, point(107)), [1, 2]);
  cache.edit({
    oldRange: { start: point(107), end: point(107) },
    newRange: { end: point(107, 2) },
  });
  assert.deepEqual(at(cache, point(107, 2)), [1, 2]);
  assert.deepEqual(at(cache, point(107, 3)), [1]);
  assert.deepEqual(at(cache, point(108)), [1, 2]);
});
test("uses the newest overlapping paint and retains neighboring cached scopes", () => {
  const cache = new HighlightCache();
  record(cache, point(0), point(10), [1, 2], []);
  record(cache, point(3), point(5), [1, 3], []);
  assert.deepEqual(at(cache, point(2)), [1, 2]);
  assert.deepEqual(at(cache, point(4)), [1, 3]);
  assert.deepEqual(at(cache, point(6)), [1, 2]);
});

test("seeks dense scope histories across edits and partial replacements", () => {
  const cache = new HighlightCache();
  const events = [];
  for (let row = 0; row < 400; row++) {
    const id = (row % 2) + 2;
    events.push({ position: point(row, 1), open: [id], close: [] });
    events.push({ position: point(row, 8), open: [], close: [id] });
  }
  record(cache, point(0), point(400), [1], events);
  for (let row = 399; row >= 0; row--) {
    assert.deepEqual(at(cache, point(row, 3)), [1, (row % 2) + 2]);
    assert.deepEqual(at(cache, point(row, 9)), [1]);
  }
  cache.edit({ oldRange: { start: point(10), end: point(10) }, newRange: { end: point(15) } });
  for (let row = 15; row < 405; row++)
    assert.deepEqual(at(cache, point(row, 3)), [1, ((row - 5) % 2) + 2]);
  cache.replace([{ start: point(150), end: point(160), scopes: [1, 8], events: [] }], {});
  assert.deepEqual(at(cache, point(149, 3)), [1, 2]);
  assert.deepEqual(at(cache, point(155, 3)), [1, 8]);
  assert.deepEqual(at(cache, point(160, 3)), [1, 3]);
});

test("partial replacements preserve surrounding scopes and do not accumulate shadowed windows", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(100),
    [1, 2],
    [
      { position: point(5), open: [3], close: [] },
      { position: point(20), open: [], close: [3] },
    ],
  );
  const expected = Array.from({ length: 100 }, (_, row) =>
    row >= 5 && row < 20 ? [1, 2, 3] : [1, 2],
  );
  for (let i = 0; i < 100; i++) {
    const row = 10 + (i % 20);
    const scopes = [1, 1000 + i];
    const staged = new HighlightCache();
    record(staged, point(row), point(row + 2), scopes, [], true);
    cache.replace(staged.snapshots, { revision: i }, () => true);
    expected[row] = expected[row + 1] = scopes;
    const ordered = [...cache.snapshots].sort((a, b) => a.start.compare(b.start));
    for (let index = 1; index < ordered.length; index++)
      assert.ok(ordered[index - 1].end.compare(ordered[index].start) <= 0);
  }
  assert.ok(cache.snapshots.length <= 23);
  for (let row = 0; row < 100; row++) assert.deepEqual(at(cache, point(row, 1)), expected[row]);
});
test("retains paint across whole-document comment edits with a bounded edit log", () => {
  const cache = new HighlightCache({ maxEdits: 8 });
  record(cache, point(0), point(2000), [1, 2], []);
  for (let row = 0; row < 2000; row++)
    cache.edit({
      oldRange: { start: point(row), end: point(row) },
      newRange: { end: point(row, 2) },
    });
  assert.ok(cache.edits.length < 8);
  assert.deepEqual(at(cache, point(1500, 5)), [1, 2]);
});
test("caps retained events and clears all presentation state on teardown", () => {
  const cache = new HighlightCache({ maxSnapshots: 3, maxEvents: 4 });
  for (let row = 0; row < 20; row++)
    record(
      cache,
      point(row),
      point(row + 1),
      [1],
      [
        { position: point(row, 1), open: [2], close: [] },
        { position: point(row, 2), open: [], close: [2] },
      ],
    );
  assert.ok(cache.snapshots.length <= 3);
  assert.ok(cache.snapshots.reduce((count, item) => count + item.events.length, 0) <= 4);
  cache.clear();
  assert.deepEqual(at(cache, point(19, 1)), [1]);
});

test("evicts old windows without truncating a dense current presentation batch", () => {
  const cache = new HighlightCache({ maxEvents: 4 });
  record(cache, point(0), point(1), [1, 9], []);
  const staged = new HighlightCache({ maxEvents: 4 });
  const events = Array.from({ length: 10 }, (_, column) => ({
    position: point(2, column),
    open: column % 2 === 0 ? [2] : [],
    close: column % 2 ? [2] : [],
  }));
  record(staged, point(2), point(3), [1], events, true);
  cache.replace(staged.snapshots, { revision: 2 });
  assert.equal(cache.snapshots.length, 1);
  assert.equal(cache.snapshots[0].events.length, 10);
  assert.deepEqual(at(cache, point(2, 8)), [1, 2]);
  assert.deepEqual(at(cache, point(2, 9)), [1]);
});
