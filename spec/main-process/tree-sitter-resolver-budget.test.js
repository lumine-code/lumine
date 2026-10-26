const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Parser, Language, Query } = require("web-tree-sitter");
require("../../src/tree-sitter-node-text");
const TextBuffer = require("../../src/text-buffer");
const Point = require("../../src/point");
const FoldResolver = require("../../src/tree-sitter-fold-resolver");
const IndentResolver = require("../../src/tree-sitter-indent-resolver");
const captureQuery = require("../../src/tree-sitter-query-cache");

let language;
before(async () => {
  await Parser.init();
  language = await Language.load(
    path.resolve(__dirname, "../../node_modules/language-json/grammars/json.wasm"),
  );
});

function fixture(text, querySource, budget = {}) {
  const buffer = new TextBuffer({ text });
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  const query = new Query(language, querySource);
  let calls = 0;
  const captures = query.captures;
  query.captures = function (...args) {
    calls++;
    return captures.apply(this, args);
  };
  const layer = {
    tree,
    queries: { foldsQuery: query },
    getOrParseTree() {
      return this.tree;
    },
    getExtent: () => buffer.getRange(),
    foldNodesToInvalidateOnChange: new Set(),
    scopeResolver: { reset() {}, store: () => true, shouldInvalidateFoldOnChange: () => true },
    languageMode: { queryBudget: { now: () => 0, ...budget } },
  };
  return {
    buffer,
    query,
    tree,
    layer,
    get calls() {
      return calls;
    },
    close() {
      query.delete();
      tree.delete();
      parser.delete();
      buffer.destroy();
    },
  };
}

test("ordinary synchronous fold queries reuse only complete boundaries", () => {
  const f = fixture("[\n 1,\n 2\n]\n", "(array) @fold");
  try {
    const resolver = new FoldResolver(f.buffer, f.layer);
    const range = resolver.getFoldRangeForRow(0);
    assert.equal(range.start.row, 0);
    assert.equal(range.end.row, 3);
    assert.equal(resolver.getFoldRangeForRow(1), null);
    assert.equal(f.calls, 1);
    assert.equal(resolver.boundariesTree, f.tree);
  } finally {
    f.close();
  }
});

test("an empty EOF fold request cannot cache unqueried neighboring rows as empty", () => {
  const f = fixture("[\n 1,\n 2\n]\n", "(array) @fold");
  try {
    const resolver = new FoldResolver(f.buffer, f.layer);
    assert.equal(resolver.getFoldRangeForRow(f.buffer.getLastRow()), null);
    assert.equal(f.calls, 0);
    assert.equal(resolver.getFoldRangeForRow(0).end.row, 3);
    assert.equal(f.calls, 1);
  } finally {
    f.close();
  }
});

test("limited fold warmups are suppressed for the same tree/window but exact requests may retry", () => {
  const f = fixture("[1,2,3]\n", "(number) @fold", { maxResults: 1 });
  try {
    const resolver = new FoldResolver(f.buffer, f.layer);
    const range = f.buffer.getRange();
    resolver.prefillFoldCache(range);
    resolver.prefillFoldCache(range);
    assert.equal(f.calls, 1);
    assert.equal(resolver.boundaries, null);
    assert.throws(() => resolver.getFoldRangeForRow(0), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "result-limit",
    });
    assert.equal(f.calls, 2);
    resolver.reset();
    resolver.prefillFoldCache(range);
    assert.equal(f.calls, 3);
  } finally {
    f.close();
  }
});

test("custom fold predicates cannot materialize huge capture text or publish partial caches", () => {
  const f = fixture(`["${"a".repeat(131072)}"]`, "(array) @fold");
  try {
    let resets = 0,
      reads = 0;
    f.tree.textCallback = () => {
      reads++;
      throw new Error("must not materialize");
    };
    f.layer.scopeResolver.reset = () => resets++;
    f.layer.scopeResolver.store = (capture) => capture.node.text.length > 0;
    const resolver = new FoldResolver(f.buffer, f.layer);
    assert.throws(() => resolver.getAllFoldRanges(), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "predicate-text-limit",
    });
    assert.equal(reads, 0);
    assert.equal(resolver.boundaries, null);
    assert.equal(f.layer.foldNodesToInvalidateOnChange.size, 0);
    assert.ok(resets >= 2);
  } finally {
    f.close();
  }
});

test("fold speculation is bounded by code units even when nearby lines are huge", () => {
  const f = fixture(`[\n1,\n"${"a".repeat(100000)}"\n]\n`, "(array) @fold");
  try {
    const resolver = new FoldResolver(f.buffer, f.layer);
    resolver.getFoldRangeForRow(0);
    const range = resolver.boundariesRange;
    assert.ok(
      f.buffer.characterIndexForPosition(range.end) -
        f.buffer.characterIndexForPosition(range.start) <=
        16384,
    );
  } finally {
    f.close();
  }
});

test("oversized exact fold ranges report unavailable before invoking the query", () => {
  const f = fixture("[1,2,3]\n", "(array) @fold", { maxRangeLength: 4 });
  try {
    const resolver = new FoldResolver(f.buffer, f.layer);
    assert.throws(() => resolver.getAllFoldRanges(), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "range-limit",
    });
    assert.equal(f.calls, 0);
  } finally {
    f.close();
  }
});

test("indent query cache never retains limited captures and preserves the complete fast path", () => {
  const f = fixture("[1,2,3]\n", "(number) @indent", { maxResults: 1 });
  try {
    const resolver = new IndentResolver(f.buffer, f.layer.languageMode);
    const options = { startPosition: new Point(0, 0), endPosition: new Point(1, 0) };
    for (let i = 0; i < 2; i++)
      assert.throws(() => resolver.captureQuery(f.layer, f.query, f.tree, options), {
        code: "ERR_SYNTAX_QUERY_BUDGET",
        reason: "result-limit",
      });
    assert.equal(captureQuery.getStats(f.layer).estimatedBytes, 0);
    f.layer.languageMode.queryBudget.maxResults = 10;
    const complete = resolver.captureQuery(f.layer, f.query, f.tree, options);
    assert.equal(complete.length, 3);
    assert.equal(resolver.captureQuery(f.layer, f.query, f.tree, options), complete);
    assert.equal(f.calls, 3);
  } finally {
    f.close();
  }
});

test("custom indent predicate failures reset scope state and emit no suggestion", () => {
  const f = fixture(`"${"a".repeat(131072)}"`, "(string) @indent");
  try {
    const resolver = new IndentResolver(f.buffer, f.layer.languageMode);
    let resets = 0,
      suggestions = 0;
    const scopes = { reset: () => resets++, store: (capture) => capture.node.text.length > 0 };
    resolver.emitter.on("did-suggest-indent", () => suggestions++);
    resolver.computeSuggestedIndentForBufferRow = () => {
      resolver.emitIndentSuggestion("did-suggest-indent", { finalIndent: 2 });
      resolver.storeScope(scopes, { node: f.tree.rootNode });
      return 2;
    };
    assert.throws(() => resolver.suggestedIndentForBufferRow(1, 2), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "predicate-text-limit",
    });
    assert.equal(resets, 1);
    assert.equal(suggestions, 0);
  } finally {
    f.close();
  }
});

test("indent budget wrappers preserve synchronous answers and deferred parse promises", async () => {
  const resolver = new IndentResolver({}, { queryBudget: { now: () => 0 } });
  let events = 0;
  resolver.emitter.on("did-suggest-indent", () => events++);
  resolver.computeSuggestedIndentForBufferRow = () => {
    resolver.emitIndentSuggestion("did-suggest-indent", { finalIndent: 3 });
    return 3;
  };
  assert.equal(resolver.suggestedIndentForBufferRow(1, 2), 3);
  assert.equal(events, 1);
  resolver.computeSuggestedIndentForBufferRow = () => Promise.resolve(4);
  const result = resolver.suggestedIndentForBufferRow(1, 2);
  assert.ok(result instanceof Promise);
  assert.equal(await result, 4);
});

test("huge indentation rows fail before scanning or reading their text", () => {
  const resolver = new IndentResolver(
    {
      lineLengthForRow: () => 100000000,
      getTextSnapshot() {
        throw new Error("must not read source");
      },
    },
    {},
  );
  for (const method of ["lineContent", "lineSource", "indentLevelForBufferRow"])
    assert.throws(() => resolver[method](1, 2), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "range-limit",
    });
});
