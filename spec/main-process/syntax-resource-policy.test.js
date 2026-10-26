const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SyntaxResourcePolicy } = require("../../src/syntax-resource-policy");

function fixture(options = {}) {
  let time = 0;
  const policy = new SyntaxResourcePolicy({
    maximumMemoryBytes: 1000,
    parseTimeLimitMs: 100,
    recycleMemoryBytes: 500,
    recycleGrowthBytes: 100,
    now: () => time,
    ...options,
  });
  return { policy, advance: (elapsed) => (time += elapsed) };
}

test("parser time accumulates across layers of one revision but excludes yields", () => {
  const { policy, advance } = fixture();
  const first = policy.beginParse({ session: 1, revision: 4, scopeName: "source.html" }, 100);
  advance(40);
  assert.equal(policy.endParse(first, 100), null);
  advance(10000);
  const second = policy.beginParse({ session: 1, revision: 4, scopeName: "source.js" }, 100);
  advance(59);
  assert.equal(policy.shouldStopParse(second, 100), false);
  advance(1);
  assert.equal(policy.shouldStopParse(second, 100), true);
  const failure = policy.endParse(second, 100);
  assert.equal(failure.code, "parse-budget");
  assert.equal(failure.activeParseMs, 100);
  assert.equal(failure.scopeName, "source.js");
  assert.equal(failure.fatal, false);
  assert.equal(failure.recycle, false);
  assert.equal(policy.state().recycleRequested, false);
});

test("a new revision and an unrelated document receive independent parsing budgets", () => {
  const { policy, advance } = fixture();
  const first = policy.beginParse({ session: 1, revision: 4 }, 100);
  advance(101);
  assert.equal(policy.endParse(first, 100).code, "parse-budget");
  const changed = policy.beginParse({ session: 1, revision: 5 }, 100);
  advance(2);
  assert.equal(policy.endParse(changed, 100), null);
  const other = policy.beginParse({ session: 2, revision: 4 }, 100);
  advance(2);
  assert.equal(policy.endParse(other, 100), null);
});

test("anonymous parser calls cannot accumulate a shared document budget or phantom memory pressure", () => {
  const { policy, advance } = fixture();
  for (let index = 0; index < 10; index++) {
    const slice = policy.beginParse(index % 2 ? { revision: 0 } : undefined, undefined);
    advance(1000);
    assert.equal(policy.shouldStopParse(slice, undefined), false);
    assert.equal(policy.endParse(slice, undefined), null);
  }
  assert.equal(policy.state().trackedSessions, 0);
  assert.equal(policy.state().allocatedMemoryBytes, 0);
});

test("an obsolete revision cannot reset the current revision's budget", () => {
  const { policy, advance } = fixture();
  const first = policy.beginParse({ session: 1, revision: 5 }, 100);
  advance(90);
  policy.endParse(first, 100);
  const stale = policy.beginParse({ session: 1, revision: 4 }, 100);
  advance(1);
  policy.endParse(stale, 100);
  const current = policy.beginParse({ session: 1, revision: 5 }, 100);
  advance(10);
  assert.equal(policy.endParse(current, 100).code, "parse-budget");
});

test("memory pressure describes shared allocated capacity and requests recycling", () => {
  const { policy, advance } = fixture();
  const slice = policy.beginParse({ session: 1, revision: 2 }, 800);
  advance(1);
  assert.equal(policy.shouldStopParse(slice, 849), false);
  assert.equal(policy.shouldStopParse(slice, 850), true);
  const failure = policy.endParse(slice, 850);
  assert.equal(failure.code, "memory-pressure");
  assert.equal(failure.fatal, false);
  assert.equal(failure.recycle, true);
  assert.equal(failure.memoryMeasurement, "allocated-wasm-capacity");
  assert.equal(failure.allocatedMemoryBytes, 850);
  assert.equal(failure.memoryLimitBytes, 1000);
  assert.equal(policy.state().underMemoryPressure, true);
  assert.equal(policy.state().recycleRequested, true);
});

test("pre-existing shared capacity also prevents unsafe new parsing without claiming live ownership", () => {
  const { policy } = fixture();
  policy.sampleMemory(100);
  const slice = policy.beginParse({ session: 2, revision: 1 }, 900);
  assert.equal(policy.shouldStopParse(slice, 900), true);
  assert.equal(policy.endParse(slice, 900).memoryMeasurement, "allocated-wasm-capacity");
  assert.equal(policy.sessions.get(2).allocatedGrowthBytes, 0);
});

test("an initial reservation at the maximum does not claim soft pressure without observable growth", () => {
  const { policy } = fixture();
  const slice = policy.beginParse({ session: 1, revision: 1 }, 1000);
  assert.equal(policy.shouldStopParse(slice, 1000), false);
  assert.equal(policy.endParse(slice, 1000), null);
  assert.equal(policy.state().initialAllocatedMemoryBytes, 1000);
  assert.equal(policy.state().underMemoryPressure, false);
});

test("closing a growth contributor requests high-water recycling while keeping other session budgets", () => {
  const { policy, advance } = fixture();
  const large = policy.beginParse({ session: 1, revision: 1 }, 100);
  advance(2);
  policy.endParse(large, 600);
  const small = policy.beginParse({ session: 2, revision: 1 }, 600);
  advance(80);
  policy.endParse(small, 600);
  assert.equal(policy.state().recycleRequested, false);
  assert.equal(policy.releaseSession(1, 600), true);
  assert.equal(policy.state().trackedSessions, 1);
  const next = policy.beginParse({ session: 2, revision: 1 }, 600);
  advance(20);
  assert.equal(policy.endParse(next, 600).code, "parse-budget");
});

test("closing a small document does not recycle merely because another grew the shared heap", () => {
  const { policy } = fixture();
  policy.endParse(policy.beginParse({ session: 1, revision: 1 }, 100), 600);
  policy.endParse(policy.beginParse({ session: 2, revision: 1 }, 600), 600);
  assert.equal(policy.releaseSession(2, 600), false);
  assert.equal(policy.releaseSession("missing", 600), false);
  assert.equal(policy.state().trackedSessions, 1);
});

test("a measured 96 MiB growth contributor triggers recycling of a retained 686 MiB heap", () => {
  const mib = 1024 * 1024;
  const policy = new SyntaxResourcePolicy();
  const slice = policy.beginParse({ session: 1, revision: 1 }, 590 * mib);
  assert.equal(policy.endParse(slice, 686 * mib), null);
  assert.equal(policy.releaseSession(1, 686 * mib), true);
});

test("finishing a slice twice does not charge its time or capacity growth twice", () => {
  const { policy, advance } = fixture();
  const slice = policy.beginParse({ session: 1, revision: 1 }, 100);
  advance(40);
  assert.equal(policy.endParse(slice, 140), null);
  advance(1000);
  assert.equal(policy.endParse(slice, 800), null);
  assert.equal(policy.sessions.get(1).revision.activeParseMs, 40);
  assert.equal(policy.sessions.get(1).allocatedGrowthBytes, 40);
});

test("operation diagnostics are bounded, copied and explicit about synchronous time", () => {
  const { policy } = fixture();
  policy.recordOperation("parse", 4, 200);
  policy.recordOperation("parse", 6, 250);
  for (let index = 0; index < 100; index++) policy.recordOperation(`operation-${index}`, 1, 250);
  const state = policy.state();
  assert.equal(Object.keys(state.operations).length, 32);
  assert.deepEqual(state.operations.parse, {
    calls: 2,
    synchronousMs: 10,
    longestSynchronousMs: 6,
  });
  state.operations.parse.calls = 900;
  assert.equal(policy.state().operations.parse.calls, 2);
  assert.equal(state.peakAllocatedMemoryBytes, 250);
});

test("revision turnover and released sessions retain only live scalar accounting", () => {
  const { policy, advance } = fixture();
  const unrelatedNode = { tree: { source: "must not be retained" } };
  for (let revision = 0; revision < 1000; revision++) {
    const slice = policy.beginParse({ session: 1, revision, node: unrelatedNode }, 100);
    assert.equal(slice.context.node, undefined);
    advance(1);
    policy.endParse(slice, 100);
  }
  for (let session = 2; session < 1000; session++) {
    policy.endParse(policy.beginParse({ session, revision: 1 }, 100), 100);
    policy.releaseSession(session, 100);
  }
  const state = policy.state();
  assert.equal(state.trackedSessions, 1);
  assert.deepEqual(state.sessions, [
    {
      id: 1,
      revision: 999,
      activeParseMs: 1,
      observedCapacityGrowthBytes: 0,
    },
  ]);
  state.sessions[0].activeParseMs = 900;
  assert.equal(policy.state().sessions[0].activeParseMs, 1);
});

test("invalid safety policy values are rejected", () => {
  for (const options of [
    { maximumMemoryBytes: 0 },
    { memoryPressureRatio: 1 },
    { memoryPressureRatio: 0 },
    { parseTimeLimitMs: -1 },
    { parseTimeLimitMs: Infinity },
    { recycleMemoryBytes: NaN },
  ])
    assert.throws(() => new SyntaxResourcePolicy(options), RangeError);
});
