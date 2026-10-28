const assert = require("node:assert/strict");
const { test } = require("node:test");
const FoldResolver = require("../../src/tree-sitter-fold-resolver");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");

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
