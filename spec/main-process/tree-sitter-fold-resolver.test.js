const assert = require("node:assert/strict");
const { test } = require("node:test");
const FoldResolver = require("../../src/tree-sitter-fold-resolver");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");

async function openJson(t, text, notify) {
  const host = new Host({ notify });
  t.after(() => host.close());
  for (const [key, schema] of Object.entries(require("../../src/config-schema"))) {
    host.config.setSchema(key, schema);
  }
  const file = require.resolve("language-json/grammars/json.json");
  const definition = require("@lumine-code/season").readFileSync(file);
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars: [{ file, definition }],
    modules: [],
    specMode: true,
  });
  const data = { session: 1, revision: 0, scopeName: definition.scopeName };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  const mode = host.sessions.get(1).mode;
  const builtin = async (method, args, options) =>
    (await host.dispatch("builtin", { ...data, method, args }, options)).value;
  return { host, data, mode, builtin };
}

function foldRows(ranges) {
  return ranges.map(({ start, end }) => [start.row, end.row]);
}

test("fold rendering waits for a current tree without forcing a synchronous parse", () => {
  const layer = {
    tree: { rootNode: {} },
    queries: { foldsQuery: {} },
    getOrParseTree(options) {
      assert.deepEqual(options, { force: false });
      return null;
    },
  };
  const resolver = new FoldResolver(null, layer);
  resolver.getOrCreateBoundariesIterator = () => {
    assert.fail("must not query the retained stale tree");
  };
  assert.equal(resolver.getFoldRangeForRow(0), null);
  assert.deepEqual(resolver.getAllFoldRanges(), []);
  resolver.prefillFoldCache({ start: { row: 0, column: 0 }, end: { row: 10, column: 0 } });

  const currentTree = { rootNode: {} };
  layer.tree = currentTree;
  layer.getOrParseTree = () => currentTree;
  let queried = false;
  resolver.getOrCreateBoundariesIterator = (rootNode) => {
    assert.equal(rootNode, currentTree.rootNode);
    queried = true;
    return { key: null };
  };
  assert.equal(resolver.getFoldRangeForRow(0), null);
  assert.equal(queried, true);
});

test("nested divided folds reuse exact local pairs and still search for distant ends", async (t) => {
  const host = new Host();
  try {
    for (const [key, schema] of Object.entries(require("../../src/config-schema")))
      host.config.setSchema(key, schema);
    const file = require.resolve("language-python/grammars/python.json");
    const definition = require("@lumine-code/season").readFileSync(file);
    await host.dispatch("environment", {
      version: 1,
      configuration: configuration(host.config),
      grammars: [{ file, definition }],
      modules: [],
      specMode: true,
    });
    const data = { session: 1, revision: 0, scopeName: "source.python" };
    await host.dispatch("open", data);
    const text = "if outer:\n    if inner:\n        action()\n    done()\n".repeat(500);
    await host.dispatch("append", { session: 1, text });
    await host.dispatch("initialize", data);
    await host.dispatch("settle", data);
    const mode = host.sessions.get(1).mode;
    mode.queryBudget = { now: () => 0 };
    mode.ensureQueriesForLayersSync("foldsQuery");
    const layer = mode.rootLanguageLayer;
    const resolver = layer.foldResolver;
    resolver.reset();
    const query = layer.queries.foldsQuery,
      captures = query.captures;
    const windows = [];
    t.mock.method(query, "captures", function (node, options) {
      windows.push(options);
      return captures.call(this, node, options);
    });
    const outer = resolver.getFoldRangeForRow(0),
      inner = resolver.getFoldRangeForRow(1);
    assert.equal(outer.end.row, 3);
    assert.equal(inner.end.row, 2);
    assert.equal(windows.length, 1);
    assert.ok(windows[0].endPosition.row <= 301);

    await layer.grammar.setQueryForTest(
      "foldsQuery",
      `
      ((identifier) @fold.start (#eq? @fold.start "outer"))
      ((identifier) @fold.end (#eq? @fold.end "done"))
    `,
    );
    const distant = "outer\n" + "value = 1\n".repeat(600) + "done\n";
    await host.dispatch("edit", {
      session: 1,
      beforeRevision: 0,
      revision: 1,
      changes: [{ startIndex: 0, oldEndIndex: text.length, text: distant }],
    });
    await host.dispatch("settle", { ...data, revision: 1 });
    resolver.reset();
    const distantQuery = layer.queries.foldsQuery,
      distantCaptures = distantQuery.captures;
    const ends = [];
    t.mock.method(distantQuery, "captures", function (node, options) {
      ends.push(options.endPosition.row);
      return distantCaptures.call(this, node, options);
    });
    assert.ok(resolver.getFoldRangeForRow(0).end.row >= 600);
    assert.equal(ends[0], 301);
    assert.ok(ends.at(-1) >= 601);
  } finally {
    host.close();
  }
});

test("worker fold commands enumerate and locate nested folds beyond the range limit", async (t) => {
  const entries = "  [\n    1\n  ],\n".repeat(260);
  const long = "x".repeat(600000);
  const text = `[\n${entries}  [\n    "${long}",\n    "${long}"\n  ]\n]\n`;
  const { builtin } = await openJson(t, text);
  const innerStart = 781;
  const outerEnd = 785;

  const all = foldRows(await builtin("getFoldableRanges", [4]));
  assert.equal(all.length, 262);
  assert.deepEqual(all[0], [0, outerEnd]);
  assert.deepEqual(all.at(-1), [innerStart, outerEnd - 1]);
  assert.deepEqual(foldRows(await builtin("getFoldableRangesAtIndentLevel", [0, 4])), [all[0]]);
  assert.deepEqual(foldRows(await builtin("getFoldableRangesAtIndentLevel", [1, 4])), all.slice(1));

  const inner = await builtin("getFoldableRangeContainingPoint", [[innerStart + 1, 6], 4]);
  assert.deepEqual(foldRows([inner]), [all.at(-1)]);
  const outer = await builtin("getFoldableRangeContainingPoint", [[innerStart, 0], 4]);
  assert.deepEqual(foldRows([outer]), [all[0]]);
});

test(
  "a distant divided fold is paired across capture windows after color and local markers",
  { timeout: 3000 },
  async (t) => {
    const long = "x".repeat(600000);
    const text = `[\n  true,\n  [\n    1\n  ],\n${"\n".repeat(350)}  "${long}",\n  "${long}",\n  false\n]\n`;
    const observed = [];
    const deferred = Promise.withResolvers();
    const { host, data, mode, builtin } = await openJson(t, text, (event) => {
      if (event.event === "paint-folds") observed.push(event);
      if (event.deferred) deferred.resolve(event);
    });
    await mode.rootLanguageLayer.grammar.setQueryForTest(
      "foldsQuery",
      "(true) @fold.start\n(false) @fold.end\n(array) @fold",
    );
    await host.dispatch(
      "view",
      { ...data, ranges: [[0, 4]], stream: true },
      {
        emit(packet) {
          if (packet.kind === "end") observed.push("color");
        },
      },
    );
    assert.equal(observed[0], "color");
    const local = observed.find((event) => event.event === "paint-folds" && !event.deferred);
    assert.ok(local.folds.some(([row, fold]) => row === 2 && fold));
    assert.ok(!observed.some((event) => event.deferred));
    const distant = await deferred.promise;
    assert.deepEqual(foldRows([distant.folds.find(([row]) => row === 1)[1]]), [[1, 356]]);
    assert.deepEqual(foldRows([await builtin("getFoldRangeForRow", [1, 4])]), [[1, 356]]);
  },
);

test("fold scans discard cancelled work and distinguish an exhausted budget", async (t) => {
  const { host, mode, builtin } = await openJson(t, `[\n${"  [1],\n".repeat(400)}  [2]\n]\n`);
  mode.queryCaptureChunkRows = 1;
  const controller = new AbortController();
  const originalYield = host.yieldForInput;
  const mock = t.mock.method(host, "yieldForInput", (...args) => {
    controller.abort();
    return originalYield.apply(host, args);
  });
  await assert.rejects(builtin("getFoldableRanges", [4], { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(mode.rootLanguageLayer.foldResolver.currentPreparedRanges(), null);
  mock.mock.restore();

  mode.queryBudget = { timeoutMs: 0 };
  await assert.rejects(builtin("getFoldableRanges", [4]), {
    name: "QueryBudgetExceeded",
    code: "ERR_SYNTAX_QUERY_BUDGET",
    reason: "timeout",
  });
  mode.queryBudget = undefined;
  assert.deepEqual(foldRows(await builtin("getFoldableRanges", [4])), [[0, 402]]);
  mode.invalidateSyntaxRequestEpoch();
  assert.equal(mode.rootLanguageLayer.foldResolver.currentPreparedRanges(), null);
});
