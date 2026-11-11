const { test } = require("node:test");
const assert = require("node:assert/strict");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const { QueryBudgetExceeded } = require("../../src/tree-sitter-query-budget");

async function setup(t, text = "[\n  1,\n  2\n]\n") {
  const host = new Host();
  t.after(() => host.close());
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const file = require.resolve("language-json/grammars/json.json");
  const definition = require("@lumine-code/season").readFileSync(file);
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars: [{ file, definition }],
    modules: [],
    specMode: true,
  });
  const data = {
    session: 1,
    revision: 0,
    scopeName: definition.scopeName,
    path: "fold-rendering.json",
  };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  const mode = host.sessions.get(1).mode;
  // Deterministic clock, as in the other runtime contract specs. Production
  // query limits are unchanged; failures below use the real typed error.
  mode.queryBudget = { now: () => 0 };
  mode.ensureQueriesForLayersSync("foldsQuery");
  mode.isFoldableCache.clear();
  const scheduled = [];
  t.mock.method(mode, "scheduleAfterHighlightPaint", (callback) => {
    const task = { callback, cancelled: false };
    scheduled.push(task);
    return () => (task.cancelled = true);
  });
  return { mode, scheduled };
}

function throwsExactly(callback, expected) {
  let caught = false;
  try {
    callback();
  } catch (error) {
    caught = true;
    assert.equal(error, expected);
  }
  assert.equal(caught, true);
}

test("a rendering timeout leaves no false cache and recovers the actual fold after paint", async (t) => {
  const { mode, scheduled } = await setup(t);
  const resolver = mode.rootLanguageLayer.foldResolver;
  const get = resolver.getFoldRangeForRow;
  let calls = 0;
  t.mock.method(resolver, "getFoldRangeForRow", function (...args) {
    if (++calls === 1) throw new QueryBudgetExceeded("timeout");
    return get.apply(this, args);
  });
  assert.equal(mode.isFoldableAtRowForRendering(0), false);
  assert.equal(mode.isFoldableCache.has(0), false);
  assert.equal(scheduled.length, 1);
  const changes = [];
  mode.onDidChangeFoldability((rows) => changes.push(rows));
  scheduled[0].callback();
  assert.equal(mode.isFoldableAtRowForRendering(0), true);
  assert.equal(mode.isFoldableCache.get(0), true);
  assert.equal(calls, 2);
  assert.equal(changes.length, 1);
  assert.ok(changes[0].has(0));
  assert.equal(scheduled.length, 1);
});

test("exact fold APIs retain the original typed failure", async (t) => {
  const { mode, scheduled } = await setup(t);
  const error = new QueryBudgetExceeded("timeout");
  t.mock.method(mode.rootLanguageLayer.foldResolver, "getFoldRangeForRow", () => {
    throw error;
  });
  throwsExactly(() => mode.isFoldableAtRow(0), error);
  throwsExactly(() => mode.getFoldRangeForRow(0), error);
  assert.equal(mode.isFoldableCache.has(0), false);
  assert.equal(scheduled.length, 0);
});

test("rendering propagates unrelated thrown values without scheduling recovery", async (t) => {
  const { mode, scheduled } = await setup(t);
  for (const error of [
    new Error("unexpected fold failure"),
    null,
    undefined,
    { code: "ERR_SYNTAX_QUERY_BUDGET" },
  ]) {
    const stub = t.mock.method(mode.rootLanguageLayer.foldResolver, "getFoldRangeForRow", () => {
      throw error;
    });
    throwsExactly(() => mode.isFoldableAtRowForRendering(0), error);
    stub.mock.restore();
  }
  assert.equal(mode.isFoldableCache.has(0), false);
  assert.equal(scheduled.length, 0);
});

test("structural query limits do not schedule a futile idle retry or cache false", async (t) => {
  const { mode, scheduled } = await setup(t);
  const error = new QueryBudgetExceeded("match-limit");
  const get = t.mock.method(mode.rootLanguageLayer.foldResolver, "getFoldRangeForRow", () => {
    throw error;
  });
  assert.equal(mode.isFoldableAtRowForRendering(0), false);
  assert.equal(mode.isFoldableAtRowForRendering(0), false);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(mode.isFoldableCache.has(0), false);
  assert.equal(scheduled.length, 0);
  throwsExactly(() => mode.isFoldableAtRow(0), error);
});

test("persistent timeouts get one deferred attempt per window and presentation version", async (t) => {
  const { mode, scheduled } = await setup(t);
  const get = t.mock.method(mode, "getFoldRangeForRowInternal", () => {
    throw new QueryBudgetExceeded("timeout");
  });
  assert.equal(mode.isFoldableAtRowForRendering(2), false);
  scheduled[0].callback();
  for (let i = 0; i < 10; i++) {
    assert.equal(mode.isFoldableAtRowForRendering(0), false);
    assert.equal(mode.isFoldableAtRowForRendering(2), false);
  }
  assert.equal(get.mock.callCount(), 2);
  assert.equal(scheduled.length, 1);
  assert.equal(mode.isFoldableCache.size, 0);
  mode.presentation.invalidate();
  assert.equal(mode.isFoldableAtRowForRendering(2), false);
  assert.equal(scheduled.length, 2);
});

test("deferred recovery prepares the requested row before any neighboring row", async (t) => {
  const { mode, scheduled } = await setup(t, `[\n${Array(100).fill("  1").join(",\n")}\n]\n`);
  const rows = [];
  t.mock.method(mode, "getFoldRangeForRowInternal", (row) => {
    rows.push(row);
    if (rows.length === 1) throw new QueryBudgetExceeded("timeout");
    return null;
  });
  assert.equal(mode.isFoldableAtRowForRendering(50), false);
  scheduled[0].callback();
  assert.deepEqual(rows, [50, 50]);
  assert.equal(mode.isFoldableCache.get(50), false);
});

for (const invalidation of ["presentation", "destroy"]) {
  test(`a ${invalidation} change discards deferred fold work`, async (t) => {
    const { mode, scheduled } = await setup(t);
    const get = t.mock.method(mode, "getFoldRangeForRowInternal", () => {
      throw new QueryBudgetExceeded("timeout");
    });
    const changes = [];
    mode.onDidChangeFoldability((rows) => changes.push(rows));
    mode.isFoldableAtRowForRendering(0);
    if (invalidation === "destroy") mode.destroy();
    else mode.presentation.invalidate();
    scheduled[0].callback();
    assert.equal(get.mock.callCount(), 1);
    assert.equal(changes.length, 0);
    if (invalidation === "destroy") assert.equal(scheduled[0].cancelled, true);
  });
}

test("the recovery cap preserves successful reads elsewhere and never evicts an attempted window", async (t) => {
  const { mode, scheduled } = await setup(t, `[\n${Array(4200).fill("  1").join(",\n")}\n]\n`);
  let calls = 0;
  let healthy = false;
  t.mock.method(mode, "getFoldRangeForRowInternal", () => {
    calls++;
    if (!healthy) throw new QueryBudgetExceeded("timeout");
    return [
      [0, 0],
      [1, 0],
    ];
  });
  for (let window = 0; window < 64; window++) mode.isFoldableAtRowForRendering(window * 64);
  for (let index = 0; index < scheduled.length; index++) scheduled[index].callback();
  assert.equal(scheduled.length, 64);
  assert.equal(calls, 128);
  assert.equal(mode.isFoldableAtRowForRendering(4096), false);
  assert.equal(scheduled.length, 64);
  healthy = true;
  assert.equal(mode.isFoldableAtRowForRendering(4096), true);
  assert.equal(mode.isFoldableCache.get(4096), true);
  const before = calls;
  assert.equal(mode.isFoldableAtRowForRendering(0), false);
  assert.equal(calls, before);
  assert.equal(scheduled.length, 64);
});

test("a second timeout in a recovered window does not start another idle cycle", async (t) => {
  const { mode, scheduled } = await setup(t);
  let calls = 0;
  t.mock.method(mode, "getFoldRangeForRowInternal", () => {
    if (++calls !== 2) throw new QueryBudgetExceeded("timeout");
    return null;
  });
  mode.isFoldableAtRowForRendering(0);
  scheduled[0].callback();
  assert.equal(mode.isFoldableAtRowForRendering(1), false);
  assert.equal(mode.isFoldableAtRowForRendering(2), false);
  assert.equal(calls, 3);
  assert.equal(scheduled.length, 1);
  assert.equal(mode.isFoldableCache.has(1), false);
});
