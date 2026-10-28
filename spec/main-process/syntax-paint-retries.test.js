const assert = require("node:assert/strict");
const { test } = require("node:test");
const Retries = require("../../src/syntax-paint-retries");
const Point = require("../../src/point");
const stamp = { revision: 1, generation: 0, presentation: 0 };
const tile = {
  start: new Point(0, 0),
  end: new Point(10, 0),
  quality: "limited",
  reason: "timeout",
};
function fixture() {
  let now = 0,
    wanted = true,
    wakes = 0,
    next = 0;
  const jobs = new Map();
  const retries = new Retries({
    ready: () => wakes++,
    wanted: () => wanted,
    now: () => now,
    schedule: (fn, ms) => {
      jobs.set(++next, { fn, at: now + ms });
      return next;
    },
    cancel: (id) => jobs.delete(id),
  });
  return {
    retries,
    jobs,
    get wakes() {
      return wakes;
    },
    advance(ms) {
      now += ms;
      for (const [id, job] of [...jobs])
        if (job.at <= now) {
          jobs.delete(id);
          job.fn();
        }
    },
    wanted(value) {
      wanted = value;
      retries.update();
    },
  };
}
test("timeouts retry with bounded backoff and successful paint retires the attempt", () => {
  const f = fixture();
  f.retries.observe(tile, stamp);
  for (const delay of [100, 500, 2000]) {
    f.advance(delay - 1);
    assert.equal(f.retries.next(), null);
    f.advance(1);
    assert.ok(f.retries.next());
    f.retries.observe(tile, stamp);
  }
  assert.equal(f.wakes, 3);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.retries.next(), null);
  f.retries.update();
  assert.equal(f.jobs.size, 0);
  f.wanted(false);
  f.wanted(true);
  f.advance(100);
  assert.ok(f.retries.next());
  assert.equal(f.wakes, 4);
  f.retries.observe({ ...tile, quality: "exact", reason: null }, stamp);
  assert.equal(f.retries.entries.size, 0);
});
test("hidden owners, revision changes and structural failures cannot keep retrying", () => {
  const f = fixture();
  f.retries.observe(tile, stamp);
  f.wanted(false);
  assert.equal(f.jobs.size, 0);
  f.advance(500);
  assert.equal(f.wakes, 0);
  f.wanted(true);
  f.advance(0);
  assert.equal(f.wakes, 1);
  f.retries.observe({ ...tile, reason: "source-window" }, stamp);
  assert.equal(f.retries.next(), null);
  assert.equal(f.jobs.size, 0);
  f.retries.observe(tile, stamp);
  f.retries.clear();
  f.advance(5000);
  assert.equal(f.wakes, 1);
  f.retries.observe(tile, { ...stamp, revision: 2 });
  assert.equal([...f.retries.entries.values()][0].attempt, 0);
});
test("the retry ledger is bounded and never budgets retries for non-timeout failures", () => {
  const f = fixture();
  for (let row = 0; row < 100; row++)
    f.retries.observe({ ...tile, start: new Point(row, 0), end: new Point(row + 1, 0) }, stamp);
  assert.equal(f.retries.entries.size, 64);
  f.retries.clear();
  for (const reason of ["source-window", "capture-limit", "predicate-text-limit", "cancelled"])
    f.retries.observe({ ...tile, reason }, stamp);
  assert.equal(f.retries.entries.size, 0);
  assert.equal(f.jobs.size, 0);
});
