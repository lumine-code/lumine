const assert = require("node:assert/strict");
const Cache = require("../../src/tree-sitter-highlight-cache");
const Point = require("../../src/point");
const { test } = require("node:test");
test("lazy scope translations and checkpoints match eager materialization through randomized edits and replacements", () => {
  let seed = 75611;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const fast = new Cache({ maxSnapshots: 256, maxEvents: 200000, maxBytes: 32 * 1024 * 1024 }),
    slow = new Cache({ maxSnapshots: 256, maxEvents: 200000, maxBytes: 32 * 1024 * 1024 });
  const point = (r, c = 0) => new Point(r, c);
  const read = (cache, start, end) => {
    const r = cache.read(start, end, [1]),
      out = [];
    const scopes = r.scopes;
    while (r.iterator.getPosition().compare(end) < 0) {
      const p = r.iterator.getPosition();
      for (const id of r.iterator.getCloseScopeIds()) {
        const i = scopes.lastIndexOf(id);
        if (i >= 0) scopes.splice(i, 1);
      }
      scopes.push(...r.iterator.getOpenScopeIds());
      out.push([p.row, p.column, [...scopes]]);
      if (!r.iterator.moveToSuccessor()) break;
    }
    return out;
  };
  for (let step = 0; step < 1000; step++) {
    if (step % 3 === 0) {
      const first = random(180),
        end = first + 1 + random(20),
        events = [];
      for (let r = first; r < end; r++) {
        events.push(
          { position: point(r, 2), open: [2 + (r % 5)], close: [] },
          { position: point(r, 8), open: [], close: [2 + (r % 5)] },
        );
      }
      for (const cache of [fast, slow])
        cache.replace(
          [
            {
              start: point(first),
              end: point(end),
              scopes: [1],
              events: events.map((e) => ({
                ...e,
                position: point(e.position.row, e.position.column),
              })),
            },
          ],
          { revision: step },
          () => true,
        );
    } else {
      const row = random(180),
        col = random(10),
        remove = random(4),
        add = random(4),
        edit = {
          oldRange: { start: point(row, col), end: point(row + remove, remove ? random(10) : col) },
          newRange: { end: point(row + add, add ? random(10) : col + random(5)) },
        };
      fast.edit(edit);
      slow.edit(edit);
      slow.rebase();
      for (const s of slow.snapshots) {
        slow.materialize(s);
        slow.dropCheckpoints(s);
      }
    }
    for (let n = 0; n < 10; n++) {
      const row = random(200);
      assert.deepEqual(
        read(fast, point(row), point(row + 3)),
        read(slow, point(row), point(row + 3)),
        `step ${step}, row ${row}`,
      );
    }
  }
});
