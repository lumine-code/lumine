const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Parser, Language, Query } = require("web-tree-sitter");
require("../../src/tree-sitter-node-text");
const {
  runQuery,
  boundedQueryRange,
  withPredicateTextBudget,
  checkPredicateTextLength,
} = require("../../src/tree-sitter-query-budget");

let language;
before(async () => {
  await Parser.init();
  language = await Language.load(
    path.resolve(__dirname, "../../node_modules/language-json/grammars/json.wasm"),
  );
});

function withQuery(text, source, callback) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  const query = new Query(language, source);
  try {
    return callback(query, tree);
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }
}

for (const method of ["captures", "matches"]) {
  test(`${method} preserves complete real queries and predicate semantics`, () => {
    withQuery(
      '["first", "second", "😀"]',
      `((string) @s (#not-eq? @s ${JSON.stringify('"first"')}))`,
      (query, tree) => {
        const expected = query[method](tree.rootNode);
        const predicates = query.textPredicates;
        const actual = runQuery(query, tree.rootNode, {}, { method, timeoutMs: 1000 });
        assert.equal(actual.complete, true);
        assert.deepEqual(actual.results, expected);
        assert.equal(query.textPredicates, predicates);
        assert.equal(actual.resultCount, 2);
      },
    );
  });

  test(`${method} rejects oversized predicate text before any materialization`, () => {
    withQuery(`"${"a".repeat(131072)}"`, '((string) @s (#not-match? @s "z"))', (query, tree) => {
      let reads = 0;
      tree.textCallback = () => {
        reads++;
        throw new Error("oversized predicate must not read text");
      };
      const predicates = query.textPredicates;
      const actual = runQuery(query, tree.rootNode, {}, { method, timeoutMs: 1000 });
      assert.equal(actual.complete, false);
      assert.equal(actual.reason, "predicate-text-limit");
      assert.equal(actual.results, null);
      assert.equal(reads, 0);
      assert.equal(query.textPredicates, predicates);
    });
  });

  test(`${method} does not reject a large capture whose text is never tested`, () => {
    withQuery(
      `{"key":"${"a".repeat(131072)}"}`,
      `((pair key: (string) @key value: (string) @value) @pair (#eq? @key ${JSON.stringify('"key"')}))`,
      (query, tree) => {
        const originalRead = tree.textCallback;
        let reads = 0;
        tree.textCallback = (index, ...args) => {
          reads++;
          assert.ok(index <= 5, "only the small key is read");
          return originalRead(index, ...args);
        };
        const result = runQuery(query, tree.rootNode, {}, { method, timeoutMs: 1000 });
        assert.equal(result.complete, true);
        assert.ok(reads > 0);
        assert.equal(result.captureCount, 3);
      },
    );
  });

  test(`${method} defers predicate exceptions until the binding releases its result`, () => {
    withQuery('["first"]', '((string) @s (#match? @s "first"))', (query, tree) => {
      const originalRead = tree.textCallback;
      const predicates = query.textPredicates;
      const failure = new Error("predicate failure");
      let predicateReturned = false;
      const originalQuery = query[method];
      query[method] = function (...args) {
        const result = originalQuery.apply(this, args);
        predicateReturned = true;
        return result;
      };
      tree.textCallback = () => {
        throw failure;
      };
      assert.throws(
        () => runQuery(query, tree.rootNode, {}, { method, timeoutMs: 1000 }),
        (error) => error === failure,
      );
      assert.equal(predicateReturned, true);
      assert.equal(query.textPredicates, predicates);
      tree.textCallback = originalRead;
      assert.equal(
        runQuery(query, tree.rootNode, {}, { method, timeoutMs: 1000 }).results.length,
        1,
      );
    });
  });
}

test("in-progress match limits do not cap returned captures", () => {
  withQuery(
    `[${Array.from({ length: 100 }, (_, index) => index).join(",")}]`,
    "(number) @n",
    (query, tree) => {
      const result = runQuery(query, tree.rootNode, { matchLimit: 1 }, { timeoutMs: 1000 });
      assert.equal(result.complete, true);
      assert.equal(result.captureCount, 100);
      assert.equal(query.didExceedMatchLimit(), false);
    },
  );
});

test("a real match-limit overflow cannot masquerade as a complete query", () => {
  withQuery(
    `[${Array.from({ length: 30 }, (_, index) => index).join(",")}]`,
    "(array (number) @a (number) @b)",
    (query, tree) => {
      const result = runQuery(query, tree.rootNode, { matchLimit: 1 }, { timeoutMs: 1000 });
      assert.equal(query.didExceedMatchLimit(), true);
      assert.equal(result.complete, false);
      assert.equal(result.reason, "match-limit");
      assert.equal(result.results, null);
    },
  );
});

test("capture limits distinguish incomplete exact answers from explicitly partial painting", () => {
  withQuery(
    `[${Array.from({ length: 1000 }, (_, index) => index).join(",")}]`,
    "(number) @n",
    (query, tree) => {
      const exact = runQuery(query, tree.rootNode, {}, { maxCaptures: 20, timeoutMs: 1000 });
      assert.equal(exact.results, null);
      assert.equal(exact.reason, "capture-limit");
      const painting = runQuery(
        query,
        tree.rootNode,
        {},
        { maxCaptures: 20, timeoutMs: 1000, allowPartial: true },
      );
      assert.equal(painting.complete, false);
      assert.equal(painting.results.length, 20);
      assert.equal(painting.captureCount, 20);
    },
  );
});

test("a match remains atomic when it contains too many captures", () => {
  withQuery("[1,2,3,4]", "(array (number) @n (number) @m)", (query, tree) => {
    const result = runQuery(
      query,
      tree.rootNode,
      {},
      { method: "matches", maxCaptures: 1, timeoutMs: 1000, allowPartial: true },
    );
    assert.equal(result.complete, false);
    assert.equal(result.reason, "capture-limit");
    assert.deepEqual(result.results, []);
  });
});

test("result limits are independent of capture limits", () => {
  withQuery("[1,2,3,4]", "(number) @n", (query, tree) => {
    const result = runQuery(
      query,
      tree.rootNode,
      {},
      { maxResults: 2, maxCaptures: 10, timeoutMs: 1000, allowPartial: true },
    );
    assert.equal(result.reason, "result-limit");
    assert.equal(result.results.length, 2);
  });
});

test("filtered candidates after an exact result limit do not falsely mark completion partial", () => {
  withQuery("[1,2,3,4]", '((number) @n (#eq? @n "1"))', (query, tree) => {
    const result = runQuery(
      query,
      tree.rootNode,
      {},
      { maxResults: 1, maxCaptures: 1, timeoutMs: 1000 },
    );
    assert.equal(result.complete, true);
    assert.equal(result.results.length, 1);
  });
});

test("cancelled requests never execute the query", () => {
  const query = {
    captures() {
      throw new Error("must not execute");
    },
  };
  const result = runQuery(query, {}, {}, { isCancelled: () => true });
  assert.equal(result.reason, "cancelled");
  assert.equal(result.results, null);
});

test("native query progress stops on cancellation and defers callback failures", () => {
  withQuery(
    `[${Array.from({ length: 10000 }, (_, index) => index).join(",")}]`,
    "(number) @n",
    (query, tree) => {
      let progress = 0;
      const cancelled = runQuery(
        query,
        tree.rootNode,
        {
          progressCallback: () => {
            progress++;
            return true;
          },
        },
        { timeoutMs: 1000 },
      );
      assert.ok(progress > 0);
      assert.equal(cancelled.reason, "cancelled");
      assert.equal(cancelled.results, null);
      const error = new Error("progress failed");
      let returned = false;
      const original = query.captures;
      query.captures = function (...args) {
        const results = original.apply(this, args);
        returned = true;
        return results;
      };
      assert.throws(
        () =>
          runQuery(
            query,
            tree.rootNode,
            {
              progressCallback: () => {
                throw error;
              },
            },
            { timeoutMs: 1000 },
          ),
        (value) => value === error,
      );
      assert.equal(returned, true);
    },
  );
});

test("elapsed budget interrupts real WASM traversal", () => {
  withQuery(
    `[${Array.from({ length: 10000 }, (_, index) => index).join(",")}]`,
    "(number) @n",
    (query, tree) => {
      let ticks = 0;
      const result = runQuery(query, tree.rootNode, {}, { now: () => ticks++, timeoutMs: 3 });
      assert.equal(result.complete, false);
      assert.equal(result.reason, "timeout");
      assert.equal(result.results, null);
    },
  );
});

test("bounded ranges read only boundaries and preserve UTF-16 and CRLF pairs", () => {
  const text = "ab😀cd\r\nef";
  const source = {
    length: text.length,
    slice(start, end) {
      assert.ok(end - start <= 2);
      return text.slice(start, end);
    },
  };
  assert.deepEqual(boundedQueryRange(source, 0, text.length, 3), {
    startIndex: 0,
    endIndex: 2,
    complete: false,
    clipped: true,
    adjusted: true,
    empty: false,
  });
  assert.deepEqual(boundedQueryRange(source, 3, 5, 4), {
    startIndex: 2,
    endIndex: 5,
    complete: true,
    clipped: false,
    adjusted: true,
    empty: false,
  });
  assert.equal(boundedQueryRange(source, 4, text.length, 3).endIndex, 6);
  assert.equal(boundedQueryRange(source, 7, 9, 4).startIndex, 6);
  assert.equal(boundedQueryRange(source, 0, 0).empty, true);
  assert.equal(boundedQueryRange(source, 3, 3).empty, true);
});

test("a huge single row cannot bypass code-unit window limits", () => {
  const source = { length: 2 ** 30, slice: () => "aa" };
  const range = boundedQueryRange(source, 500000000, source.length);
  assert.equal(range.endIndex - range.startIndex, 16384);
  assert.equal(range.complete, false);
});

test("custom predicate budgets preserve exact semantics and restore nested contexts", () => {
  const outer = withPredicateTextBudget(
    () => {
      checkPredicateTextLength(20);
      const inner = withPredicateTextBudget(() => checkPredicateTextLength(20), {
        maxPredicateTextLength: 10,
      });
      assert.equal(inner.complete, false);
      assert.equal(inner.reason, "predicate-text-limit");
      checkPredicateTextLength(20);
      return false;
    },
    { maxPredicateTextLength: 30 },
  );
  assert.deepEqual(outer, { value: false, complete: true, reason: null });
  checkPredicateTextLength(Number.MAX_SAFE_INTEGER);
  const error = new Error("broken custom predicate");
  assert.throws(
    () =>
      withPredicateTextBudget(() => {
        throw error;
      }),
    (value) => value === error,
  );
  assert.throws(() => withPredicateTextBudget(() => Promise.resolve()), /synchronous/);
});

test("budget validation rejects accidental unbounded execution", () => {
  for (const budget of [
    { timeoutMs: Infinity },
    { maxCaptures: 0 },
    { matchLimit: 65537 },
    { maxResults: 1.5 },
  ])
    assert.throws(() => runQuery({}, {}, {}, budget), RangeError);
  assert.throws(() => boundedQueryRange("abc", NaN, 2), RangeError);
  assert.throws(() => boundedQueryRange("abc", 0, 3, 1), RangeError);
});
