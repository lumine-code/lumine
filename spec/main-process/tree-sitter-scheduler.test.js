const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const { TreeSitterScheduler } = require("../../src/tree-sitter-scheduler");

function clock(options = {}) {
  let now = 0;
  const deferred = [];
  const scheduler = new TreeSitterScheduler(2, {
    ...options,
    now: () => now,
    defer: (callback) => deferred.push(callback),
  });
  return {
    scheduler,
    advance(milliseconds) {
      now += milliseconds;
    },
    turn() {
      for (const callback of deferred.splice(0)) callback();
    },
    finish() {
      for (let turns = 0; deferred.length; turns++) {
        assert.ok(turns < 1000, "Scheduler must finish finite work");
        this.turn();
      }
    },
    get now() {
      return now;
    },
  };
}

test("a newly focused third document runs before two large parses complete", async () => {
  const time = clock();
  const { scheduler } = time;
  const visited = [];
  let focused = null;
  const parse = (name, slices) =>
    scheduler.runSlices(
      (deadline) => {
        assert.ok(deadline > time.now);
        visited.push(name);
        time.advance(2);
        return { done: --slices === 0, value: name };
      },
      { priority: () => (focused === name ? 0 : 100) },
    );
  const a = parse("large a", 20);
  const b = parse("large b", 20);
  time.turn();
  assert.deepEqual(visited, ["large a", "large b"]);
  focused = "small";
  const small = parse("small", 1);
  time.turn();
  assert.equal(await small, "small");
  assert.equal(visited[2], "small");
  assert.ok(scheduler.slices.length > 0, "Large parses must still be incomplete");
  time.finish();
  assert.deepEqual(await Promise.all([a, b]), ["large a", "large b"]);
});

test("priority is reread between slices and equal-priority jobs alternate", async () => {
  const time = clock({ maxCallbacksPerTurn: 1 });
  const visited = [];
  let focused = "a";
  const run = (name) => {
    let remaining = 3;
    return time.scheduler.runSlices(
      () => {
        visited.push(name);
        return { done: --remaining === 0 };
      },
      { priority: () => (name === focused ? 0 : 100) },
    );
  };
  const a = run("a");
  const b = run("b");
  time.turn();
  focused = "b";
  time.turn();
  focused = null;
  time.finish();
  await Promise.all([a, b]);
  assert.deepEqual(visited, ["a", "b", "a", "b", "a", "b"]);
});

test("aging gives background documents bounded service under continuous foreground work", async () => {
  const time = clock();
  const backgroundTimes = [];
  let foregroundRemaining = 90;
  let backgroundRemaining = 3;
  const foreground = time.scheduler.runSlices(
    () => {
      time.advance(4);
      return { done: --foregroundRemaining === 0 };
    },
    { priority: () => 0 },
  );
  const background = time.scheduler.runSlices(
    () => {
      backgroundTimes.push(time.now);
      time.advance(4);
      return { done: --backgroundRemaining === 0 };
    },
    { priority: () => 100 },
  );
  time.finish();
  await Promise.all([foreground, background]);
  assert.deepEqual(backgroundTimes, [100, 204, 308]);
});

test("zero-duration slices and completed jobs cannot monopolize one event loop turn", async () => {
  const time = clock({ maxCallbacksPerTurn: 3 });
  let calls = 0;
  const jobs = Array.from({ length: 10 }, () =>
    time.scheduler.runSlices(() => {
      calls++;
      return { done: true };
    }),
  );
  time.turn();
  assert.equal(calls, 3);
  time.turn();
  assert.equal(calls, 6);
  time.finish();
  await Promise.all(jobs);
  assert.equal(calls, 10);
});

test("all slices share the synchronous allowance and receive bounded deadlines", async () => {
  const time = clock();
  const { scheduler } = time;
  const deadlines = [];
  let remaining = 4;
  const work = scheduler.runSlices(
    (deadline) => {
      deadlines.push(deadline);
      time.advance(1);
      return { done: --remaining === 0 };
    },
    { timeoutMicros: 2000 },
  );
  // The synchronous path has already spent half this task's shared budget.
  assert.equal(scheduler.deadline(4000), 4);
  time.advance(2);
  assert.equal(scheduler.deadline(5000), 4);
  time.turn();
  assert.deepEqual(deadlines, [4, 4]);
  time.finish();
  await work;
  assert.deepEqual(deadlines, [4, 4, 6, 7]);
  assert.equal(scheduler.hasBudget(1000), true);
  time.advance(1);
  assert.equal(scheduler.hasBudget(1000), false);
  time.finish();
  assert.equal(scheduler.hasBudget(1000), true);
  time.finish();
});

test("cancellation before admission and between slices never executes queued work", async () => {
  const time = clock({ maxCallbacksPerTurn: 1 });
  const before = new AbortController();
  before.abort();
  const never = () => assert.fail("Cancelled parser callback must not execute");
  await assert.rejects(time.scheduler.runSlices(never, { signal: before.signal }), {
    name: "AbortError",
  });
  const queued = new AbortController();
  const waiting = time.scheduler.runSlices(never, { signal: queued.signal });
  const waitingRejected = assert.rejects(waiting, { name: "AbortError" });
  queued.abort();
  await waitingRejected;
  const running = new AbortController();
  let calls = 0;
  const work = time.scheduler.runSlices(
    () => {
      calls++;
      return { done: false };
    },
    { signal: running.signal },
  );
  time.turn();
  assert.equal(calls, 1);
  const rejected = assert.rejects(work, { name: "AbortError" });
  running.abort();
  time.finish();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(time.scheduler.slices.length, 0);
});

test("cancellation inside a slice cannot publish its result or prevent another job", async () => {
  const time = clock();
  const controller = new AbortController();
  const cancelled = time.scheduler.runSlices(
    () => {
      controller.abort();
      return { done: true, value: "stale" };
    },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  const next = time.scheduler.runSlices(() => ({ done: true, value: "current" }));
  time.finish();
  await rejected;
  assert.equal(await next, "current");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("invalid priorities, callback failures and invalid results release queued resources", async () => {
  const time = clock();
  const cases = [
    [
      () => {
        throw new Error("parse failed");
      },
      undefined,
      /parse failed/,
    ],
    [() => assert.fail("Bad priority must not execute"), { priority: () => NaN }, /priority/],
    [
      () => assert.fail("Failed priority must not execute"),
      {
        priority: () => {
          throw new Error("priority failed");
        },
      },
      /priority failed/,
    ],
    [
      () => {
        throw null;
      },
      undefined,
      (error) => error === null,
    ],
    [() => null, undefined, /IteratorResult/],
    [
      async () => {
        throw new Error("async callback failed");
      },
      undefined,
      /synchronous/,
    ],
  ];
  const rejections = cases.map(([callback, options, expected]) =>
    assert.rejects(time.scheduler.runSlices(callback, options), expected),
  );
  const success = time.scheduler.runSlices(() => ({ done: true, value: null }));
  time.finish();
  await Promise.all(rejections);
  assert.equal(await success, null);
  assert.equal(time.scheduler.slices.length, 0);
});

test("completion removes cancellation listeners and settles once", async () => {
  const time = clock();
  const controller = new AbortController();
  let calls = 0;
  const work = time.scheduler.runSlices(
    () => {
      calls++;
      return { done: true, value: 42 };
    },
    { signal: controller.signal },
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  time.finish();
  assert.equal(await work, 42);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  time.finish();
  assert.equal(calls, 1);
  assert.equal(await work, 42);
});

test("sliced work cannot deadlock behind legacy concurrency permits", async () => {
  const time = clock();
  let entered = 0;
  const jobs = Array.from({ length: 2 }, () =>
    time.scheduler.run(() => {
      entered++;
      return time.scheduler.runSlices(() => ({ done: true, value: entered }));
    }),
  );
  await Promise.resolve();
  assert.equal(time.scheduler.active, 2);
  const focused = time.scheduler.runSlices(() => ({ done: true, value: "focused" }), {
    priority: () => -1,
  });
  time.finish();
  assert.equal(await focused, "focused");
  await Promise.all(jobs);
  await Promise.resolve();
  assert.equal(time.scheduler.active, 0);
});
