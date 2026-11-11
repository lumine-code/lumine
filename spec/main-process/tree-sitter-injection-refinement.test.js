const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const { Point } = require("../../src/text-buffer");
const { QueryBudgetExceeded } = require("../../src/tree-sitter-query-budget");

let host, layerPrototype;
before(async () => {
  host = new Host();
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
    path: "injections.json",
  };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text: "[]" });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  layerPrototype = Object.getPrototypeOf(host.sessions.get(1).mode.rootLanguageLayer);
});
after(() => host?.close());

const sigil = (rows = 6000, extra = "") =>
  [
    'value = ~s"""',
    ...Array.from({ length: rows }, (_, i) => `line #{value_${i}}${extra}`),
    '"""',
  ].join("\r\n");

// Exercise the actual collectors, retry policy and UTF-16 range limiter.
// Only query outcomes and the cooperative yield are controlled; no time or
// query budget is raised to make these deterministic operation counts pass.
async function collect(kind, text, outcome = () => {}, cancelAfterYield = false) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const position = (index) => {
    let lo = 0,
      hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid;
    }
    return new Point(lo, index - starts[lo]);
  };
  const index = (point) => starts[point.row] + point.column;
  const layer = Object.create(layerPrototype),
    calls = [];
  let current = true,
    yields = 0;
  layer.buffer = { characterIndexForPosition: index, positionForCharacterIndex: position };
  layer.languageMode = {
    document: { capture: () => ({ text }) },
    _yieldForInjectionCandidateScan: async () => {
      yields++;
      if (cancelAfterYield) current = false;
    },
  };
  layer._injectionCandidateScanIsCurrent = () => current;
  const query = (start, end, state) => {
    const call = { start: index(start), end: index(end), success: false };
    calls.push(call);
    outcome(call);
    call.success = true;
    const node = { id: "part-" + call.start, startIndex: call.start, endIndex: call.end };
    if (kind === "dynamic") return [{ id: "shared-owner" }, node];
    state ??= { records: [], patterns: new Map() };
    state.records.push(node);
    return { records: state.records, state };
  };
  layer._queryStaticInjectionCandidates = (tree, queryObject, start, end, version, state) =>
    query(start, end, state);
  layer._queryInjectionCandidateNodes = (tree, types, start, end) => query(start, end);
  const args = [
    {},
    kind === "static" ? {} : ["sigil"],
    position(0),
    position(text.length),
    0,
    text.length,
    1000,
    4096,
    1,
  ];
  const result =
    kind === "static"
      ? await layer._collectStaticInjectionCandidatesInChunks(...args)
      : await layer._collectInjectionCandidateNodesInChunks(...args, {});
  return { result, calls, yields };
}

function exactCoverage(kind, text, observed) {
  const successes = observed.calls.filter((call) => call.success);
  let cursor = 0;
  for (const call of successes) {
    assert.equal(call.start, cursor);
    assert(call.end > call.start);
    assert(!(text[call.end - 1] === "\r" && text[call.end] === "\n"));
    const previous = text.charCodeAt(call.end - 1),
      next = text.charCodeAt(call.end);
    assert(!(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff));
    cursor = call.end;
  }
  assert.equal(cursor, text.length);
  const parts = observed.result.filter((node) => node.id !== "shared-owner");
  assert.deepEqual(
    parts.map((node) => [node.startIndex, node.endIndex]),
    successes.map((call) => [call.start, call.end]),
  );
  if (kind === "dynamic")
    assert.equal(observed.result.filter((node) => node.id === "shared-owner").length, 1);
  return successes;
}

for (const kind of ["static", "dynamic"]) {
  test(`${kind} injection scan keeps ordinary exact windows and results`, async () => {
    const text = sigil(),
      observed = await collect(kind, text);
    exactCoverage(kind, text, observed);
    assert.equal(observed.calls.length, 30);
    assert.equal(observed.calls.filter((call) => !call.success).length, 0);
  });

  for (const limit of [16, 2]) {
    test(`${kind} injection scan confines first-window timeout refinement (${limit} units)`, async () => {
      const text = sigil();
      const observed = await collect(kind, text, (call) => {
        if (call.start === 0 && call.end - call.start > limit)
          throw new QueryBudgetExceeded("timeout");
      });
      const successes = exactCoverage(kind, text, observed);
      assert(observed.calls.some((call) => !call.success));
      assert(
        observed.calls.length < 100,
        `A locally slow prefix must not shrink the healthy suffix: ${observed.calls.length} queries`,
      );
      assert(
        successes
          .filter((call) => call.start >= 4096)
          .every((call) => call.end - call.start >= 4095 || call.end === text.length),
      );
    });
  }

  test(`${kind} injection scan handles adjacent difficult windows without fragmenting the suffix`, async () => {
    const text = sigil(6000, "😀"),
      observed = await collect(kind, text, (call) => {
        if (call.start < 8192 && call.end - call.start > 64)
          throw new QueryBudgetExceeded("timeout");
      });
    const successes = exactCoverage(kind, text, observed);
    assert(observed.calls.length < 700);
    assert(
      successes
        .filter((call) => call.start >= 8192)
        .every((call) => call.end - call.start >= 4094 || call.end === text.length),
    );
  });

  test(`${kind} uniformly difficult injection windows traverse a bounded refinement tree`, async () => {
    const text = sigil(600, "😀"),
      observed = await collect(kind, text, (call) => {
        if (call.end - call.start > 64) throw new QueryBudgetExceeded("timeout");
      });
    const successes = exactCoverage(kind, text, observed);
    assert(
      observed.calls.length <= 4 * successes.length,
      "Do not restart the entire refinement ladder after every successful child",
    );
  });

  test(`${kind} injection refinement discards cancellation before another query`, async () => {
    const observed = await collect(
      kind,
      sigil(),
      () => {
        throw new QueryBudgetExceeded("timeout");
      },
      true,
    );
    assert.equal(observed.result, null);
    assert.equal(observed.calls.length, 1);
    assert.equal(observed.yields, 1);
  });

  for (const error of [new QueryBudgetExceeded("result-limit"), new Error("query failed")]) {
    test(`${kind} injection refinement propagates ${error.name}/${error.reason ?? "unrelated"}`, async () => {
      let calls = 0;
      await assert.rejects(
        collect(kind, sigil(), () => {
          calls++;
          throw error;
        }),
        (actual) => actual === error,
      );
      assert.equal(calls, 1);
    });
  }

  test(`${kind} indivisible injection windows retain the original timeout failure`, async () => {
    const error = new QueryBudgetExceeded("timeout");
    let calls = 0;
    await assert.rejects(
      collect(kind, sigil(), () => {
        calls++;
        throw error;
      }),
      (actual) => actual === error,
    );
    assert(calls < 40);
  });
}
