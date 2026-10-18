const assert = require("node:assert/strict");
const { test } = require("node:test");
const Point = require("../../src/point");
const HighlightCache = require("../../src/tree-sitter-highlight-cache");

const point = (row, column = 0) => new Point(row, column);
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
test("uses the newest overlapping paint and retains neighboring cached scopes", () => {
  const cache = new HighlightCache();
  record(cache, point(0), point(10), [1, 2], []);
  record(cache, point(3), point(5), [1, 3], []);
  assert.deepEqual(at(cache, point(2)), [1, 2]);
  assert.deepEqual(at(cache, point(4)), [1, 3]);
  assert.deepEqual(at(cache, point(6)), [1, 2]);
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
