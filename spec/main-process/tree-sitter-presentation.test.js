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

test("queues new view requests made synchronously by a publication observer", async () => {
  const f = fixture();
  const owner = {};
  let nestedPreparations;
  try {
    f.presentation.hasBudget = () => true;
    f.presentation.publish = () => {
      if (nestedPreparations !== undefined) return;
      nestedPreparations = f.preparations();
      f.presentation.requestRanges(owner, [[800, 810]], false);
      f.presentation.flush();
      assert.equal(f.preparations(), nestedPreparations);
    };
    f.presentation.flush();
    assert.ok(f.presentation.timer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.preparations() > nestedPreparations);
    assert.ok(f.cache.covers(new Point(800, 0), new Point(810, 0)));
  } finally {
    f.presentation.destroy();
  }
});

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

test("a viewport change discards partly prepared tiles before publishing the new visible ranges", async () => {
  const f = fixture();
  try {
    await f.presentation.flush();
    const old = [...f.cache.snapshots];
    const published = f.published.length;
    const prepared = f.preparations();
    f.presentation.request(500, 700, false);
    const obsolete = f.presentation.flush();
    // Let one tile finish, leaving the rest of this viewport behind a yield.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.preparations(), prepared + 1);
    f.presentation.request(512, 600, false);
    await obsolete;
    assert.deepEqual(f.cache.snapshots, old);
    assert.equal(f.published.length, published);
    await f.presentation.flush();
    assert.ok(f.cache.covers(new Point(512, 0), new Point(600, 0)));
    assert.equal(f.cache.covers(new Point(704, 0), new Point(720, 0)), false);
    assert.ok(f.published.slice(published).every((range) => range.end.row <= 640));
  } finally {
    f.presentation.destroy();
  }
});

test("a query-generation change rejects staged paint even when document text is unchanged", async () => {
  const f = fixture();
  let syntaxGeneration = 1;
  f.presentation.capture = () => ({ revision: 1, generation: syntaxGeneration });
  f.presentation.isCurrent = (stamp) => stamp.generation === syntaxGeneration;
  try {
    await f.presentation.flush();
    const old = [...f.cache.snapshots];
    const published = f.published.length;
    f.presentation.request(500, 700, false);
    const obsolete = f.presentation.flush();
    await new Promise((resolve) => setImmediate(resolve));
    syntaxGeneration++;
    f.presentation.invalidate();
    await obsolete;
    assert.deepEqual(f.cache.snapshots, old);
    assert.equal(f.published.length, published);
    await f.presentation.flush();
    const stamp = { revision: 1, generation: syntaxGeneration };
    assert.ok(f.cache.covers(new Point(500, 0), new Point(700, 0), stamp));
    assert.equal(f.cache.covers(new Point(0, 0), new Point(20, 0), stamp), false);
    f.presentation.request(0, 20, false);
    await f.presentation.flush();
    assert.ok(f.cache.covers(new Point(0, 0), new Point(20, 0), stamp));
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
