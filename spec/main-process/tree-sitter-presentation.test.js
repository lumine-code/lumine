const assert = require("node:assert/strict");
const { test } = require("node:test");
const Point = require("../../src/point");
const HighlightCache = require("../../src/tree-sitter-highlight-cache");
const Presentation = require("../../src/tree-sitter-presentation");

function fixture(lastRow = 1000) {
  let revision = 1;
  const cache = new HighlightCache();
  const published = [];
  let preparations = 0;
  const presentation = new Presentation({
    buffer: {
      getLastRow: () => lastRow,
      clipPosition: (point) => Point.fromObject(point),
    },
    cache,
    capture: () => ({ revision, generation: presentation.generation }),
    isCurrent: (stamp) => stamp.revision === revision,
    hasBudget: () => false,
    iterator: () => ({
      seek: () => {
        preparations++;
        return [revision];
      },
      getPosition: () => Point.INFINITY,
    }),
    publish: (range) => published.push(range),
  });
  return {
    presentation,
    cache,
    published,
    advance: () => {
      revision++;
      presentation.invalidate();
    },
    preparations: () => preparations,
  };
}

test("prepares requested fragments cooperatively and publishes only a complete batch", async () => {
  const f = fixture();
  try {
    f.presentation.request(500, 600, false);
    const pending = f.presentation.flush();
    assert.equal(f.preparations(), 0);
    assert.equal(f.published.length, 0);
    await pending;
    assert.ok(f.published.length > 1);
    assert.ok(f.cache.covers(new Point(500, 0), new Point(600, 0)));
    assert.ok(f.cache.snapshots.every((snapshot) => snapshot.stamp.revision === 1));
    assert.equal(f.presentation.flush(), null);
  } finally {
    f.presentation.destroy();
  }
});

test("superseded preparation neither publishes nor replaces the retained presentation", async () => {
  const f = fixture();
  try {
    await f.presentation.flush();
    const old = [...f.cache.snapshots];
    f.presentation.request(500, 600, false);
    const pending = f.presentation.flush();
    f.advance();
    await pending;
    assert.deepEqual(f.cache.snapshots, old);
    await f.presentation.flush();
    assert.ok(
      f.cache.snapshots
        .filter((snapshot) => snapshot.start.row >= 448)
        .every((snapshot) => snapshot.stamp.revision === 2),
    );
  } finally {
    f.presentation.destroy();
  }
});

test("prepares current views while retaining older paints only as a cache", async () => {
  const f = fixture();
  const firstView = {},
    secondView = {};
  try {
    f.presentation.requestRanges(firstView, [[0, 10]]);
    f.presentation.requestRanges(secondView, [[500, 510]]);
    await f.presentation.flush();
    const previous = f.preparations();
    f.presentation.requestRanges(firstView, [[700, 710]]);
    f.advance();
    await f.presentation.flush();
    assert.equal(f.preparations() - previous, 4);
    assert.equal(f.cache.snapshots.find((snapshot) => snapshot.start.row === 0).stamp.revision, 1);
    assert.ok(f.cache.covers(new Point(500, 0), new Point(510, 0)));
    assert.ok(f.cache.covers(new Point(700, 0), new Point(710, 0)));
    secondView.destroyed = true;
    f.presentation.requestRanges(firstView, [[700, 710]]);
    assert.ok([...f.presentation.tiles.keys()].every((row) => row >= 640));
  } finally {
    f.presentation.destroy();
  }
});

test("destruction cancels yielded presentation work without publishing", async () => {
  const f = fixture();
  const pending = f.presentation.flush();
  f.presentation.destroy();
  await pending;
  assert.equal(f.preparations(), 0);
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.cache.snapshots, []);
});

test("returning to a cached view reuses current scopes but rejects an older generation", async () => {
  const f = fixture();
  try {
    f.presentation.request(100, 110, false);
    await f.presentation.flush();
    f.presentation.request(500, 510, false);
    await f.presentation.flush();
    const calls = f.preparations();
    f.presentation.request(100, 110, false);
    assert.equal(f.presentation.flush(), null);
    assert.equal(f.preparations(), calls);
    f.advance();
    await f.presentation.flush();
    f.presentation.request(500, 510, false);
    await f.presentation.flush();
    assert.ok(f.preparations() > calls + 1);
    assert.equal(f.cache.snapshots.at(-1).stamp.revision, 2);
  } finally {
    f.presentation.destroy();
  }
});

test("keeps every visible fragment when folds spread a view beyond the cold cache allowance", async () => {
  const f = fixture(10000),
    view = {};
  try {
    const ranges = Array.from({ length: 20 }, (_, i) => [i * 128, i * 128 + 1]);
    f.presentation.requestRanges(view, ranges);
    await f.presentation.flush();
    for (const [row] of ranges) assert.ok(f.cache.covers(new Point(row, 0), new Point(row + 1, 0)));
    f.presentation.invalidate({ start: new Point(0, 0), end: new Point(0, 1) });
    await f.presentation.flush();
    for (const [row] of ranges) assert.ok(f.cache.covers(new Point(row, 0), new Point(row + 1, 0)));
  } finally {
    f.presentation.destroy();
  }
});

test("a synchronous preparation error retains presentation and does not spin retries", async (t) => {
  const f = fixture();
  try {
    await f.presentation.flush();
    const old = [...f.cache.snapshots];
    const iterator = f.presentation.iterator;
    f.presentation.hasBudget = () => true;
    f.presentation.iterator = () => {
      throw new Error("query failed");
    };
    const report = t.mock.method(console, "error", () => {});
    f.advance();
    await assert.rejects(f.presentation.flush(), /query failed/);
    assert.deepEqual(f.cache.snapshots, old);
    assert.equal(f.presentation.flush(), null);
    assert.equal(report.mock.callCount(), 1);
    f.presentation.iterator = iterator;
    f.advance();
    await f.presentation.flush();
    assert.ok(f.cache.snapshots.every((snapshot) => snapshot.stamp.revision === 3));
  } finally {
    f.presentation.destroy();
  }
});
