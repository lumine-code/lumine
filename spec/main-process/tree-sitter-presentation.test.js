const assert = require("node:assert/strict");
const { test } = require("node:test");
const Point = require("../../src/point");
const HighlightCache = require("../../src/tree-sitter-highlight-cache");
const Presentation = require("../../src/tree-sitter-presentation");

function fixture() {
  let revision = 1;
  const cache = new HighlightCache();
  const published = [];
  let preparations = 0;
  const presentation = new Presentation({
    buffer: {
      getLastRow: () => 1000,
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
    assert.ok(f.cache.snapshots.every((snapshot) => snapshot.stamp.revision === 2));
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
