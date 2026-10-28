const assert = require("node:assert/strict");
const { test } = require("node:test");
const Point = require("../../src/point");
const HighlightCache = require("../../src/tree-sitter-highlight-cache");
const { TextChangeMap } = require("../../src/text-model");

const point = (row, column = 0) => new Point(row, column);

test("paint differences detect corrected provisional and limited results at the same stamp", () => {
  const cache = new HighlightCache();
  const stamp = { revision: 4, generation: 2, presentation: 7 };
  const tile = {
    start: point(100),
    end: point(104),
    scopes: [1],
    events: [
      { position: point(101, 2), open: [2], close: [] },
      { position: point(101, 8), open: [], close: [2] },
    ],
  };
  for (const quality of ["provisional", "limited", "exact"]) {
    cache.clear();
    cache.replace([{ ...tile, quality }], stamp);
    const corrected = {
      ...tile,
      quality: "exact",
      events: [
        ...tile.events,
        { position: point(103, 3), open: [3], close: [] },
        { position: point(103, 9), open: [], close: [3] },
      ],
    };
    assert.deepEqual(cache.changedRanges(corrected, [1]), [[point(103, 3), point(103, 9)]]);
    cache.replace([corrected], stamp);
    assert.deepEqual(cache.changedRanges(corrected, [1]), []);
    assert.deepEqual(cache.changedRanges(tile, [1]), [[point(103, 3), point(103, 9)]]);
  }
});

test("paint differences compare effective scopes across shifted fragments and redundant boundaries", () => {
  const cache = new HighlightCache();
  cache.replace(
    [
      { start: point(100), end: point(102), scopes: [1, 2], events: [] },
      { start: point(102), end: point(104), scopes: [1, 2], events: [] },
    ],
    {},
  );
  cache.edit({ oldRange: { start: point(0), end: point(0) }, newRange: { end: point(2) } });
  const tile = {
    start: point(102),
    end: point(106),
    scopes: [1],
    events: [
      { position: point(102), open: [2], close: [] },
      { position: point(104), open: [2], close: [2] },
      { position: point(106), open: [], close: [2] },
    ],
  };
  assert.deepEqual(cache.changedRanges(tile, [1]), []);
  tile.events.splice(1, 1, { position: point(104), open: [3], close: [2] });
  assert.deepEqual(cache.changedRanges(tile, [1]), [[point(104), point(106)]]);
});

test("repeated source transfers retain colors, reverse exactly and stay bounded", () => {
  const cache = new HighlightCache();
  cache.replace(
    Array.from({ length: 3 }, (_, row) => ({
      start: point(row),
      end: point(row + 1),
      scopes: [1],
      events: [
        { position: point(row), open: [row + 2], close: [] },
        { position: point(row, 4), open: [], close: [row + 2] },
      ],
    })),
    { revision: 0 },
  );
  const map = TextChangeMap.transfer(
    TextChangeMap.fromChanges([
      { oldStart: point(1), oldEnd: point(2), newStart: point(1), newEnd: point(1) },
      { oldStart: point(0), oldEnd: point(0), newStart: point(0), newEnd: point(1) },
    ]),
    [{ start: point(1), end: point(2), target: point(0) }],
  );
  const scopesAt = (position) => {
    const { scopes, iterator } = cache.read(position, position.translate([0, 1]), []);
    while (iterator.getPosition().compare(position) <= 0) {
      for (const id of iterator.getCloseScopeIds()) {
        const index = scopes.lastIndexOf(id);
        if (index >= 0) scopes.splice(index, 1);
      }
      scopes.push(...iterator.getOpenScopeIds());
      if (!iterator.moveToSuccessor()) break;
    }
    return scopes;
  };
  for (let i = 0; i < 100; i++) {
    cache.edit({ coordinateMap: map });
    assert.deepEqual(scopesAt(point(0, 1)), [1, 3]);
    assert.deepEqual(scopesAt(point(1, 1)), [1, 2]);
    cache.edit({ coordinateMap: map.invert() });
    assert.deepEqual(scopesAt(point(0, 1)), [1, 2]);
    assert.deepEqual(scopesAt(point(1, 1)), [1, 3]);
    assert(cache.eventCount <= 18, `${cache.eventCount} retained events after ${i} moves`);
  }
});

test("recording preserves provisional quality and its limitation reason", () => {
  const cache = new HighlightCache();
  const record = cache.record(
    {
      quality: "provisional",
      limitedReason: "source-window",
      seek: () => [1],
      getPosition: () => Point.INFINITY,
    },
    { clipPosition: () => point(1) },
  );
  record.seek(point(0), 0);
  assert.equal(cache.snapshots[0].quality, "provisional");
  assert.equal(cache.snapshots[0].reason, "source-window");
  assert.equal(record.quality, "provisional");
  assert.equal(record.limitedReason, "source-window");
});

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

const insertion = (row, column, length = 1) => ({
  oldRange: { start: point(row, column), end: point(row, column) },
  newRange: { start: point(row, column), end: point(row, column + length) },
});

test("extends only the requested closing stack and postpones boundary openings", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(1),
    [1, 2, 3],
    [{ position: point(0, 5), close: [3, 2, 1], open: [9] }],
  );
  const stack = [1, 2];
  cache.edit(insertion(0, 5, 2), { extendScopes: stack });
  stack.length = 0;
  assert.deepEqual(at(cache, point(0, 4)), [1, 2, 3]);
  assert.deepEqual(at(cache, point(0, 5)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 6)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 7)), [9]);
  assert.deepEqual(cache.snapshots[0].events, [
    { position: point(0, 5), close: [3], open: [] },
    { position: point(0, 7), close: [2, 1], open: [9] },
  ]);
});

test("without the option insertion keeps the existing left boundary affinity", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(1),
    [1, 2, 3],
    [{ position: point(0, 5), close: [3, 2], open: [9] }],
  );
  cache.edit(insertion(0, 5, 2));
  assert.deepEqual(at(cache, point(0, 5)), [1, 9]);
  assert.deepEqual(cache.snapshots[0].events[0].position, point(0, 5));
});

test("accepts array coordinates when extending an insertion boundary", () => {
  const cache = new HighlightCache();
  record(cache, point(0), point(1), [1, 2], [{ position: point(0, 5), close: [2], open: [] }]);
  cache.edit(
    { oldRange: { start: [0, 5], end: [0, 5] }, newRange: { start: [0, 5], end: [0, 7] } },
    { extendScopes: [1, 2] },
  );
  assert.deepEqual(at(cache, point(0, 6)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 7)), [1]);
});

test("keeps zero-width scopes together when several events share the boundary", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(1),
    [1, 2, 3],
    [
      { position: point(0, 5), close: [3], open: [4] },
      { position: point(0, 5), close: [4, 2], open: [9] },
    ],
  );
  cache.edit(insertion(0, 5), { extendScopes: [1, 2] });
  assert.deepEqual(at(cache, point(0, 5)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 6)), [1, 9]);
  assert.deepEqual(
    cache.snapshots[0].events.map((event) => event.position.column),
    [5, 6, 6],
  );
});

test("extends cached coverage at a fragment end without borrowing a following fragment's scopes", () => {
  const cache = new HighlightCache();
  const stamp = { revision: 1, generation: 1 };
  cache.replace(
    [
      { start: point(0), end: point(0, 5), scopes: [1, 2], events: [] },
      { start: point(0, 5), end: point(1), scopes: [1, 9], events: [] },
    ],
    stamp,
  );
  cache.edit(insertion(0, 5, 2), { extendScopes: [1, 2] });
  assert.deepEqual(at(cache, point(0, 6)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 7)), [1, 9]);
  assert.equal(cache.covers(point(0), point(1)), true);
  assert.equal(cache.covers(point(0, 5), point(0, 7), { revision: 2, generation: 1 }), false);
  assert.deepEqual(cache.snapshots[1].start, point(0, 7));
});

test("keeps a fragment beginning inside the retained stack and leaves uncached gaps uncovered", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0, 5),
    point(0, 8),
    [1, 2, 3],
    [{ position: point(0, 5), close: [3, 2], open: [9] }],
  );
  cache.edit(insertion(0, 5, 2), { extendScopes: [1, 2] });
  assert.deepEqual(at(cache, point(0, 5)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 7)), [1, 9]);
  assert.deepEqual(cache.uncoveredRanges(point(0), point(0, 10)), [[point(0), point(0, 5)]]);
});

test("deleting inserted paint rolls back the boundary and current worker paint replaces it", () => {
  const cache = new HighlightCache();
  record(cache, point(0), point(0, 5), [1, 2], [{ position: point(0, 5), close: [2], open: [] }]);
  cache.edit(insertion(0, 5, 2), { extendScopes: [1, 2] });
  assert.deepEqual(at(cache, point(0, 6)), [1, 2]);
  cache.edit({
    oldRange: { start: point(0, 5), end: point(0, 7) },
    newRange: { end: point(0, 5) },
  });
  assert.equal(cache.covers(point(0), point(0, 5)), true);
  assert.equal(cache.covers(point(0, 5), point(0, 6)), false);
  assert.deepEqual(cache.snapshots[0].events[0].position, point(0, 5));
  cache.replace([{ start: point(0), end: point(1), scopes: [1, 8], events: [] }], { revision: 3 });
  assert.deepEqual(at(cache, point(0, 4)), [1, 8]);
});

test("invalidates dense scope checkpoints after boundary splitting with unchanged event count", () => {
  const cache = new HighlightCache();
  const events = [];
  for (let row = 0; row < 40; row++) {
    events.push({ position: point(row, 0), open: [2, 3], close: [] });
    events.push({ position: point(row, 5), open: [], close: [3] });
    events.push({ position: point(row, 5), open: [], close: [2] });
  }
  record(cache, point(0), point(40), [1], events);
  assert.deepEqual(at(cache, point(39, 6)), [1]);
  cache.edit({ oldRange: { start: point(0), end: point(0) }, newRange: { end: point(2) } });
  cache.edit(insertion(23, 5, 2), { extendScopes: [1, 2] });
  assert.deepEqual(at(cache, point(23, 5)), [1, 2]);
  assert.deepEqual(at(cache, point(23, 7)), [1]);
  assert.deepEqual(at(cache, point(41, 3)), [1, 2, 3]);
  assert.deepEqual(at(cache, point(41, 6)), [1]);
});

test("does not extend scopes for replacement or multiline edits", () => {
  for (const change of [
    { oldRange: { start: point(0, 5), end: point(0, 6) }, newRange: { end: point(0, 7) } },
    { oldRange: { start: point(0, 5), end: point(0, 5) }, newRange: { end: point(1) } },
  ]) {
    const cache = new HighlightCache();
    record(cache, point(0), point(2), [1, 2], [{ position: point(0, 5), close: [2], open: [] }]);
    cache.edit(change, { extendScopes: [1, 2] });
    assert.deepEqual(at(cache, point(0, 5)), [1]);
  }
});

test("insertion scopes retain a string across its begin and end punctuation", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(0, 2),
    [1, 2, 3],
    [
      { position: point(0, 1), close: [3], open: [4] },
      { position: point(0, 2), close: [4, 2], open: [] },
    ],
  );
  const context = cache.insertionScopes(point(0, 1), [1]);
  assert.deepEqual(context, { left: [1, 2, 3], continuous: [1, 2] });
  cache.edit(insertion(0, 1), { extendScopes: context.continuous });
  assert.deepEqual(at(cache, point(0, 1)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 2)), [1, 2, 4]);
  context.left.length = context.continuous.length = 0;
  assert.deepEqual(at(cache, point(0, 1)), [1, 2]);
});

test("insertion scopes distinguish adjacent literals with the same scope ID", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(0, 6),
    [1, 2, 4],
    [{ position: point(0, 3), close: [4, 2], open: [2, 3] }],
  );
  assert.deepEqual(cache.insertionScopes(point(0, 3), [1]), {
    left: [1, 2, 4],
    continuous: [1],
  });
  cache.edit(insertion(0, 3), { extendScopes: [1] });
  assert.deepEqual(at(cache, point(0, 3)), [1]);
  assert.deepEqual(at(cache, point(0, 4)), [1, 2, 3]);
});

test("insertion scopes track every same-position event without mistaking new occurrences for ancestors", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(1),
    [1, 2, 3],
    [
      { position: point(0, 5), close: [3], open: [3] },
      { position: point(0, 5), close: [3], open: [8] },
    ],
  );
  assert.deepEqual(cache.insertionScopes(point(0, 5), [1]), {
    left: [1, 2, 3],
    continuous: [1, 2],
  });
});

test("insertion scopes expose leaf affinity without inheriting the following delimiter or comment", () => {
  for (const next of [7, 8]) {
    const cache = new HighlightCache();
    record(
      cache,
      point(0),
      point(1),
      [1, 2],
      [{ position: point(0, 3), close: [2], open: [next] }],
    );
    assert.deepEqual(cache.insertionScopes(point(0, 3), [1]), {
      left: [1, 2],
      continuous: [1],
    });
    cache.edit(insertion(0, 3), { extendScopes: [1] });
    assert.deepEqual(at(cache, point(0, 3)), [1]);
    assert.deepEqual(at(cache, point(0, 4)), [1, next]);
  }
});

test("insertion scopes use detached fallbacks at row start and EOF, and reject uncached left gaps", () => {
  const cache = new HighlightCache();
  const fallback = [1];
  record(cache, point(0, 2), point(0, 5), [1, 2], []);
  const first = cache.insertionScopes([0, 0], fallback);
  assert.deepEqual(first, { left: [1], continuous: [1] });
  first.left.push(9);
  assert.deepEqual(first.continuous, [1]);
  assert.deepEqual(fallback, [1]);
  assert.equal(cache.insertionScopes(point(0, 2), fallback), null);
  assert.deepEqual(cache.insertionScopes(point(0, 5), fallback), {
    left: [1, 2],
    continuous: [1],
  });
});

test("a following fragment cannot leak its existing token into a shared root insertion", () => {
  const cache = new HighlightCache();
  cache.replace(
    [
      { start: point(0), end: point(0, 5), scopes: [1, 2], events: [] },
      { start: point(0, 5), end: point(1), scopes: [1, 9], events: [] },
    ],
    { revision: 1 },
  );
  cache.edit(insertion(0, 5), { extendScopes: [1] });
  assert.deepEqual(at(cache, point(0, 4)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 5)), [1]);
  assert.deepEqual(at(cache, point(0, 6)), [1, 9]);
  assert.equal(cache.snapshots.length, 2);
});

test("an interpolation boundary preserves only continuous enclosing scopes", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(1),
    [1, 2, 5, 6],
    [{ position: point(0, 5), close: [6, 5], open: [7] }],
  );
  const { continuous } = cache.insertionScopes(point(0, 5), [1]);
  assert.deepEqual(continuous, [1, 2]);
  cache.edit(insertion(0, 5), { extendScopes: continuous });
  assert.deepEqual(at(cache, point(0, 5)), [1, 2]);
  assert.deepEqual(at(cache, point(0, 6)), [1, 2, 7]);
});

test("repeated typing at a fragment boundary drops incidental inner scopes without growing snapshots or events", () => {
  const cache = new HighlightCache();
  record(cache, point(0), point(0, 5), [1, 2, 3], []);
  for (let column = 5; column < 105; column++) {
    cache.edit(insertion(0, column), { extendScopes: [1, 2] });
    assert.deepEqual(at(cache, point(0, column)), [1, 2]);
  }
  assert.equal(cache.snapshots.length, 1);
  assert.equal(cache.snapshots[0].events.length, 2);
  assert.equal(cache.covers(point(0), point(0, 105)), true);
  assert.equal(cache.covers(point(0, 105), point(0, 106)), false);
});

test("scope extension does not manufacture events in a later uncovered fragment", () => {
  const cache = new HighlightCache();
  record(cache, point(0, 8), point(0, 12), [1, 9], []);
  cache.edit(insertion(0, 5), { extendScopes: [1] });
  assert.deepEqual(at(cache, point(0, 9)), [1, 9]);
  assert.deepEqual(cache.snapshots[0].events, []);
  assert.equal(cache.covers(point(0, 5), point(0, 6)), false);
});

test("row-start insertion retains a multiline string already covering that row", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(4),
    [1],
    [
      { position: point(0, 3), close: [], open: [2] },
      { position: point(3, 3), close: [2], open: [] },
    ],
  );
  const context = cache.insertionScopes(point(2), [1]);
  assert.deepEqual(context, { left: [1, 2], continuous: [1, 2] });
  cache.edit(insertion(2, 0), { extendScopes: context.continuous });
  assert.deepEqual(at(cache, point(2)), [1, 2]);
});

test("a cold row-start fragment retains its initial context after a lazy row translation", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(10),
    point(12),
    [1, 2],
    [
      { position: point(10), close: [], open: [3] },
      { position: point(10, 1), close: [3], open: [] },
    ],
  );
  cache.edit({ oldRange: { start: point(0), end: point(0) }, newRange: { end: point(2) } });
  const context = cache.insertionScopes(point(12), [1]);
  assert.deepEqual(context, { left: [1, 2], continuous: [1, 2] });
  cache.edit(insertion(12, 0), { extendScopes: context.continuous });
  assert.deepEqual(at(cache, point(12)), [1, 2]);
  assert.deepEqual(at(cache, point(12, 1)), [1, 2, 3]);
  assert.equal(cache.covers(point(11), point(12)), false);
});

test("row-start insertion does not inherit a preceding comment or a newly opening string", () => {
  const cache = new HighlightCache();
  record(
    cache,
    point(0),
    point(3),
    [1, 2],
    [
      { position: point(1), close: [2], open: [3] },
      { position: point(2), close: [3], open: [] },
    ],
  );
  const context = cache.insertionScopes(point(1), [1]);
  assert.deepEqual(context, { left: [1, 2], continuous: [1] });
  cache.edit(insertion(1, 0), { extendScopes: context.continuous });
  assert.deepEqual(at(cache, point(1)), [1]);
  assert.deepEqual(at(cache, point(1, 1)), [1, 3]);
});

test("row-start insertion prefers the newest fragment and never crosses an uncovered gap", () => {
  const cache = new HighlightCache();
  record(cache, point(0), point(1), [1, 2], []);
  record(cache, point(3), point(5), [1, 8], []);
  record(cache, point(3), point(4), [1, 9], []);
  assert.deepEqual(cache.insertionScopes(point(1), [1]), { left: [1], continuous: [1] });
  assert.deepEqual(cache.insertionScopes(point(2), [1]), { left: [1], continuous: [1] });
  const context = cache.insertionScopes(point(3), [1]);
  assert.deepEqual(context, { left: [1, 9], continuous: [1, 9] });
  context.left.push(10);
  context.continuous.push(11);
  assert.deepEqual(cache.insertionScopes(point(3), [1]), { left: [1, 9], continuous: [1, 9] });
});

test("adjacent fragments cannot prove continuity between different literals with the same scope ID", () => {
  for (const events of [[{ position: point(0, 3), close: [2], open: [2] }], []]) {
    const cache = new HighlightCache();
    cache.replace(
      [
        { start: point(0), end: point(0, 3), scopes: [1, 2], events },
        { start: point(0, 3), end: point(0, 6), scopes: [1, 2], events: [] },
      ],
      { revision: 1 },
    );
    const context = cache.insertionScopes(point(0, 3), [1]);
    assert.deepEqual(context, { left: [1, 2], continuous: [1] });
    cache.edit(insertion(0, 3), { extendScopes: context.continuous });
    assert.deepEqual(at(cache, point(0, 3)), [1]);
    assert.deepEqual(at(cache, point(0, 4)), [1, 2]);
  }
});

test("byte limits evict scope-heavy cold windows even when event counts are tiny", () => {
  const cache = new HighlightCache({ maxBytes: 5000 });
  const tile = (row) => ({
    start: point(row),
    end: point(row + 1),
    scopes: [1],
    events: [
      { position: point(row, 1), open: Array.from({ length: 400 }, (_, i) => i + 2), close: [] },
    ],
  });
  cache.replace([tile(0)], {});
  cache.replace([tile(10)], {});
  assert.equal(cache.eventCount, 1);
  assert.equal(cache.covers(point(0), point(1)), false);
  assert.equal(cache.covers(point(10), point(11)), true);
  assert.ok(cache.estimatedBytes < cache.maxBytes);
  assert.ok(cache.estimatedBytes > 3000);
});

test("protected visible coverage and the newest required tile survive a byte-budget excess", () => {
  const cache = new HighlightCache({ maxBytes: 4000 });
  const scopes = Array.from({ length: 300 }, (_, i) => i);
  const tile = (row) => ({ start: point(row), end: point(row + 1), scopes, events: [] });
  cache.replace([tile(0)], {});
  const visible = cache.snapshots[0];
  cache.replace([tile(10)], {}, (snapshot) => snapshot === visible);
  assert.equal(cache.covers(point(0), point(1)), true);
  assert.equal(cache.covers(point(10), point(11)), true);
  assert.equal(cache.getStats().overBudget, true);
  cache.replace([tile(20)], {});
  assert.equal(cache.covers(point(0), point(1)), false);
  assert.equal(cache.covers(point(10), point(11)), false);
  assert.equal(cache.covers(point(20), point(21)), true);
  assert.equal(cache.getStats().overBudget, false);
});

test("recording cannot retain arbitrarily large initial or event scope arrays", () => {
  const cache = new HighlightCache({ maxBytes: 1000 });
  const scopes = Array.from({ length: 300 }, (_, i) => i);
  record(cache, point(0), point(1), scopes, []);
  assert.equal(cache.snapshots.length, 0);
  assert.equal(cache.estimatedBytes, 0);
  record(cache, point(0), point(1), [1], [{ position: point(0, 1), open: scopes, close: [] }]);
  assert.equal(cache.snapshots.length, 0);
  assert.equal(cache.eventCount, 0);
  assert.equal(cache.estimatedBytes, 0);
});

test("byte accounting follows checkpoint creation, boundary splits, replacement, copy and clear", () => {
  const cache = new HighlightCache();
  const events = [];
  for (let row = 0; row < 100; row++) {
    events.push({ position: point(row, 0), open: [2, 3], close: [] });
    events.push({ position: point(row, 5), open: [], close: [3, 2] });
  }
  cache.replace([{ start: point(0), end: point(100), scopes: [1], events }], {});
  const beforeRead = cache.estimatedBytes;
  at(cache, point(99, 4));
  assert.ok(cache.checkpointBytes > 0);
  assert.ok(cache.estimatedBytes > beforeRead);
  const beforeEdit = cache.estimatedBytes;
  cache.edit(insertion(10, 5), { extendScopes: [1, 2] });
  assert.ok(cache.editBytes > 0);
  assert.ok(cache.estimatedBytes > beforeEdit);
  cache.rebase();
  assert.equal(cache.editBytes, 0);
  assert.equal(cache.checkpointBytes, 0);
  assert.equal(cache.eventCount, events.length);
  assert.deepEqual(at(cache, point(10, 5)), [1, 2]);
  cache.replace([{ start: point(20), end: point(80), scopes: [1], events: [] }], {});
  assert.ok(cache.eventCount < 100);
  const beforeCopy = cache.estimatedBytes;
  assert.equal(cache.copyRange(point(0), point(10), point(120), [1]), true);
  assert.ok(cache.estimatedBytes > beforeCopy);
  while (cache.snapshots.length) cache.removeSnapshot(0);
  assert.equal(cache.estimatedBytes, 0);
  assert.equal(cache.checkpointBytes, 0);
  assert.equal(cache.eventCount, 0);
  cache.edit(insertion(0, 0));
  cache.clear();
  assert.equal(cache.estimatedBytes, 0);
  assert.equal(cache.editBytes, 0);
});

test("optional checkpoint stacks remain bounded and preserve forward and backward reads", () => {
  const cache = new HighlightCache({ maxBytes: 100000 });
  const scopes = Array.from({ length: 300 }, (_, i) => i);
  const events = Array.from({ length: 512 }, (_, column) => ({
    position: point(0, column),
    open: [],
    close: [],
  }));
  cache.replace([{ start: point(0), end: point(1), scopes, events }], {});
  for (const column of [64, 128, 192, 256, 320, 384, 448, 500, 130, 400]) {
    assert.deepEqual(at(cache, point(0, column)), scopes);
    assert.ok(cache.checkpointBytes <= cache.maxCheckpointBytes);
    assert.ok(cache.estimatedBytes <= cache.maxBytes);
  }
  cache.removeSnapshot(0);
  assert.equal(cache.checkpointBytes, 0);
});

test("diagnostic reads and lazy row shifts do not recount event scope arrays", () => {
  const cache = new HighlightCache();
  let reads = 0;
  const event = {
    position: point(100),
    get open() {
      reads++;
      return [2];
    },
    get close() {
      reads++;
      return [];
    },
  };
  cache.replace([{ start: point(100), end: point(101), scopes: [1], events: [event] }], {});
  const bytes = cache.estimatedBytes;
  reads = 0;
  for (let i = 0; i < 100; i++) cache.getStats();
  cache.edit({ oldRange: { start: point(0), end: point(0) }, newRange: { end: point(1) } });
  cache.rebase();
  assert.equal(reads, 0);
  assert.equal(cache.estimatedBytes, bytes);
});

test("boundary edit growth evicts cold bytes while retaining the latest required coverage", () => {
  const cache = new HighlightCache({ maxBytes: 500 });
  cache.replace([{ start: point(0), end: point(1), scopes: [1, 2, 3], events: [] }], {});
  cache.replace([{ start: point(10), end: point(11), scopes: [1], events: [] }], {});
  assert.equal(cache.snapshots.length, 2);
  cache.edit(insertion(0, 0), { extendScopes: [1] });
  cache.rebase();
  assert.equal(cache.covers(point(0), point(1)), false);
  assert.equal(cache.covers(point(10), point(11)), true);
  assert.ok(cache.estimatedBytes <= cache.maxBytes);
  assert.equal(cache.editBytes, 0);
});
