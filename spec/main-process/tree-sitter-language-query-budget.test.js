const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Query } = require("web-tree-sitter");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const { compileInjectionQuery } = require("../../src/tree-sitter-injections");
const Point = require("../../src/point");
const scopeRanges = require("../../src/syntax-scope-ranges");

async function fixture(text = "[1,2,3]", language = "json") {
  const host = new Host();
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const file = require.resolve(`language-${language}/grammars/${language}.json`);
  const definition = require("@lumine-code/season").readFileSync(file);
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars: [{ file, definition }],
    modules: [],
    specMode: true,
  });
  const data = { session: 1, revision: 0, scopeName: definition.scopeName, path: "example.json" };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  const { buffer, mode } = host.sessions.get(1);
  mode.queryBudget = { timeoutMs: 1000 };
  const layer = mode.rootLanguageLayer;
  const queries = [];
  return {
    host,
    data,
    mode,
    layer,
    buffer,
    query(type, source) {
      const query = new Query(layer.language, source);
      if (type === "injectionsQuery")
        query.injectionDescriptors = compileInjectionQuery(query, source);
      queries.push(query);
      layer.queries[type] = query;
      return query;
    },
    close() {
      host.close();
      for (const query of queries) query.delete();
    },
  };
}

test("point scope queries guard native predicates and resolver text without clearing paint state", async () => {
  for (const query of [
    '((string) @string (#match? @string "a"))',
    '((string) @string (#set! adjust.startAfterFirstMatchOf "a"))',
  ]) {
    const f = await fixture(`["${"a".repeat(65537)}"]`);
    try {
      f.query("highlightsQuery", query);
      const boundaries = [...f.layer.scopeResolver.boundaries];
      let reads = 0;
      f.layer.tree.textCallback = () => {
        reads++;
        throw new Error("must not materialize");
      };
      assert.throws(() => f.layer.scopeMapAtPosition(new Point(0, 2)), {
        code: "ERR_SYNTAX_QUERY_BUDGET",
        reason: "predicate-text-limit",
      });
      assert.equal(reads, 0);
      assert.deepEqual([...f.layer.scopeResolver.boundaries], boundaries);
      assert.equal(f.host.sessions.has(1), true);
    } finally {
      f.close();
    }
  }
});

test("semantic query exhaustion crosses the worker boundary without failing its session", async () => {
  const f = await fixture();
  try {
    f.query("highlightsQuery", "(number) @number @number @number");
    f.mode.queryBudget.maxResults = 1;
    await assert.rejects(
      f.host.dispatch("builtin", {
        ...f.data,
        method: "bufferRangeForScopeAtPosition",
        args: ["number", [0, 1]],
      }),
      {
        name: "AbortError",
        code: "ERR_SYNTAX_QUERY_BUDGET",
      },
    );
    assert.equal(f.host.sessions.has(1), true);
    assert.equal(f.host.sessions.get(1).failure, undefined);
  } finally {
    f.close();
  }
});

test("parse-boundary captures use bounded source windows and reject incomplete results", async () => {
  const f = await fixture(`[${"1,".repeat(6000)}2]`);
  try {
    const query = f.query("parseBoundariesQuery", "(number) @parse.boundary");
    const calls = [];
    const captures = query.captures;
    query.captures = function (node, options) {
      calls.push(options);
      return captures.call(this, node, options);
    };
    const result = f.layer.getParseBoundaryCaptures();
    assert.equal(result.length, 6001);
    assert.ok(calls.length > 1);
    assert.ok(
      calls.every(
        (options) =>
          f.buffer.characterIndexForPosition(options.endPosition) -
            f.buffer.characterIndexForPosition(options.startPosition) <=
            8192 && typeof options.progressCallback === "function",
      ),
    );
    f.mode.queryBudget.maxResults = 1;
    assert.throws(() => f.layer.getParseBoundaryCaptures(), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "result-limit",
    });
  } finally {
    f.close();
  }
});

test("large static and dynamic injection scans yield even when synchronous parsing is enabled", async () => {
  const f = await fixture(`[${" ".repeat(70000)}1,2,3]`);
  try {
    f.mode.shouldParseSynchronously = () => true;
    const expected = f.layer.tree.rootNode.descendantsOfType("number").map((node) => node.id);
    const pending = f.layer._collectInjectionCandidateNodes(
      f.layer.tree,
      ["number"],
      f.buffer.getRange(),
      f.layer.injectionPointVersion,
    );
    assert.ok(pending instanceof Promise);
    assert.deepEqual(
      (await pending).map((node) => node.id),
      expected,
    );
    f.query(
      "injectionsQuery",
      '((number) @injection.owner @injection.content (#set! injection.language "numbers"))',
    );
    const statics = f.layer._collectStaticInjectionCandidates(
      f.layer.tree,
      f.buffer.getRange(),
      f.layer.injectionPointVersion,
    );
    assert.ok(statics instanceof Promise);
    assert.deepEqual(
      (await statics).map((record) => record.node.id),
      expected,
    );
  } finally {
    f.close();
  }
});

test("unknown dynamic types retain matching nodes through a bounded cursor fallback", async () => {
  const f = await fixture();
  try {
    const types = ["number", "not_an_existing_type"];
    const expected = f.layer.tree.rootNode.descendantsOfType("number").map((node) => node.id);
    const result = f.layer._collectInjectionCandidateNodes(
      f.layer.tree,
      types,
      f.buffer.getRange(),
      f.layer.injectionPointVersion,
    );
    assert.ok(!(result instanceof Promise));
    assert.deepEqual(
      f.layer._collectInjectionCandidateNodes(
        f.layer.tree,
        ["_"],
        f.buffer.getRange(),
        f.layer.injectionPointVersion,
      ),
      [],
    );
    assert.deepEqual(
      result.map((node) => node.id),
      expected,
    );
    f.mode.queryBudget.maxResults = 1;
    assert.throws(
      () =>
        f.layer._collectInjectionCandidateNodes(
          f.layer.tree,
          types,
          f.buffer.getRange(),
          f.layer.injectionPointVersion,
        ),
      { code: "ERR_SYNTAX_QUERY_BUDGET", reason: "result-limit" },
    );
  } finally {
    f.close();
  }
});

test("static injection language text cannot escape its budget or publish partial topology", async () => {
  const f = await fixture(`["${"a".repeat(65537)}"]`);
  try {
    f.query("injectionsQuery", "(string) @injection.owner @injection.content @injection.language");
    let reads = 0,
      reconciled = 0;
    f.layer.tree.textCallback = () => {
      reads++;
      throw new Error("must not materialize");
    };
    f.layer._reconcileInjections = () => {
      reconciled++;
    };
    await assert.rejects(f.layer._performPopulateInjections(f.buffer.getRange()), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "predicate-text-limit",
    });
    assert.equal(reads, 0);
    assert.equal(reconciled, 0);
    assert.equal(f.layer.childLayerMarkers.size, 0);
  } finally {
    f.close();
  }
});

test("inline long-line presentation retains its limited quality in the highlight cache", async () => {
  const f = await fixture(`[${"1,".repeat(10000)}2]`);
  try {
    const query = f.layer.queries.highlightsQuery;
    const captures = query.captures;
    const queriedLengths = [];
    query.captures = function (node, options) {
      queriedLengths.push(
        f.buffer.characterIndexForPosition(options.endPosition) -
          f.buffer.characterIndexForPosition(options.startPosition),
      );
      return captures.call(this, node, options);
    };
    f.mode.highlightCache.clear();
    f.mode.presentation.requestRanges(f, [[0, 0]], false);
    f.mode.presentation.invalidate();
    await f.mode.presentation.flush();
    assert.ok(f.mode.highlightCache.snapshots.length > 0);
    assert.ok(
      f.mode.highlightCache.snapshots.some(
        (snapshot) => snapshot.quality === "limited" && snapshot.reason === "source-window",
      ),
    );
    assert.ok(queriedLengths.length > 0);
    assert.ok(queriedLengths.every((length) => length <= 2048));
  } finally {
    f.close();
  }
});

test("ordinary 180 KiB JavaScript comments preserve exact injection routing and healthy syntax", async () => {
  const f = await fixture("const value = 1;\n", "javascript");
  try {
    const before = f.buffer.getLength();
    await f.host.dispatch("edit", {
      ...f.data,
      beforeRevision: 0,
      revision: 1,
      changes: [{ startIndex: before, oldEndIndex: before, text: `/*${"x".repeat(180000)}*/\n` }],
    });
    await f.host.dispatch("settle", { ...f.data, revision: 1 });
    assert.equal(f.host.sessions.has(1), true);
    assert.equal(f.host.sessions.get(1).failure, undefined);
    assert.equal(f.mode.tree.rootNode.hasError, false);
    assert.equal(f.mode.tree.rootNode.endIndex, f.buffer.getLength());
  } finally {
    f.close();
  }
});

test("native injection text predicates retain a hard cap above ordinary comments", async () => {
  const f = await fixture(`"${"a".repeat(1024 * 1024 + 1)}"`);
  try {
    f.query(
      "injectionsQuery",
      '((string) @injection.owner @injection.content (#match? @injection.content "^a") (#set! injection.language "test"))',
    );
    let reads = 0;
    f.layer.tree.textCallback = () => {
      reads++;
      throw new Error("must not materialize");
    };
    await assert.rejects(f.layer._performPopulateInjections(f.buffer.getRange()), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "predicate-text-limit",
    });
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});

test("exact scope scans bound huge rows and preserve Unicode, CRLF and enclosing scopes", async () => {
  const first = `"${"x".repeat(8189)}😀"`;
  const second = `"${"y".repeat(10000)}"`;
  const text = `[${first},\r\n${second}]`;
  const f = await fixture(text);
  try {
    const query = f.query("highlightsQuery", "(array) @array (string) @string");
    const calls = [];
    const captures = query.captures;
    query.captures = function (node, options) {
      const start = f.buffer.characterIndexForPosition(options.startPosition);
      const end = f.buffer.characterIndexForPosition(options.endPosition);
      calls.push([start, end]);
      return captures.call(this, node, options);
    };
    const merged = [];
    for (const { range, scopes } of scopeRanges(f.mode, f.buffer.getRange())) {
      const previous = merged.at(-1);
      if (previous && previous.scopes.join("\0") === scopes.join("\0")) previous.end = range.end;
      else merged.push({ start: range.start, end: range.end, scopes });
    }
    const base = [f.mode.grammar.scopeName, "array"];
    const firstEnd = 1 + first.length;
    const secondStart = firstEnd + 3;
    const expected = [
      [0, 1, base],
      [1, firstEnd, [...base, "string"]],
      [firstEnd, secondStart, base],
      [secondStart, secondStart + second.length, [...base, "string"]],
      [secondStart + second.length, text.length, base],
    ].map(([start, end, scopes]) => ({
      start: f.buffer.positionForCharacterIndex(start),
      end: f.buffer.positionForCharacterIndex(end),
      scopes,
    }));
    assert.deepEqual(merged, expected);
    assert.ok(calls.length > 2);
    for (const [start, end] of calls) {
      assert.ok(end - start <= 8192);
      for (const boundary of [start, end]) {
        const before = text.charCodeAt(boundary - 1),
          after = text.charCodeAt(boundary);
        assert.ok(!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff));
        assert.notEqual(text.slice(boundary - 1, boundary + 1), "\r\n");
      }
    }
  } finally {
    f.close();
  }
});

test("exact scope scans reject stale and inexact results instead of completing a partial scan", async () => {
  const f = await fixture("[1,2,3]");
  try {
    const iterator = scopeRanges(f.mode, f.buffer.getRange());
    assert.equal(iterator.next().done, false);
    f.mode.invalidateSyntaxConfiguration();
    assert.throws(() => iterator.next(), { name: "AbortError" });
    f.mode.buildHighlightIterator = () => ({ seek: () => [], limitedReason: "source-window" });
    assert.throws(() => [...scopeRanges(f.mode, f.buffer.getRange())], {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "source-window",
    });
  } finally {
    f.close();
  }
});

test("a later scope window exhausting its query budget fails the entire exact scan", async () => {
  const f = await fixture(`["${"x".repeat(18000)}"]`);
  try {
    const query = f.query("highlightsQuery", "(array) @array (string) @string");
    const captures = query.captures;
    let calls = 0,
      ranges = 0;
    query.captures = function (...args) {
      calls++;
      return captures.apply(this, args);
    };
    query.didExceedMatchLimit = () => calls >= 2;
    assert.throws(
      () => {
        for (const _range of scopeRanges(f.mode, f.buffer.getRange())) ranges++;
      },
      { code: "ERR_SYNTAX_QUERY_BUDGET", reason: "match-limit" },
    );
    assert.ok(ranges > 0);
    assert.equal(calls, 2);
  } finally {
    f.close();
  }
});

test("optional boundary limits preserve original included ranges and healthy syntax", async () => {
  const f = await fixture();
  try {
    f.query("parseBoundariesQuery", "(number) @parse.boundary");
    f.mode.queryBudget.maxResults = 1;
    const included = [
      {
        startIndex: 0,
        endIndex: f.buffer.getLength(),
        startPosition: new Point(0, 0),
        endPosition: f.buffer.getEndPosition(),
      },
    ];
    assert.equal(f.layer.getParseRanges(included), included);
    assert.equal(f.layer.parseBoundaryLimitedReason, "result-limit");
    assert.deepEqual(f.layer.parseCompactionEdits, []);
    assert.equal(f.layer.getParseRanges(null), null);
    assert.equal(f.layer.tree.rootNode.hasError, false);
    assert.equal(f.host.sessions.has(1), true);
  } finally {
    f.close();
  }
});

test("boundary fallback discards tentative fragment compaction after a later budget failure", async () => {
  const f = await fixture(`[${"1,".repeat(100)}2]`);
  try {
    f.query("parseBoundariesQuery", '[(number) "," "[" "]"] @parse.boundary');
    const capture = f.layer.getParseBoundaryCaptures.bind(f.layer);
    const dirty = f.layer.treeIsDirty;
    let passes = 0;
    f.layer.getParseBoundaryCaptures = (tree) => {
      if (++passes === 2) f.mode.queryBudget.maxResults = 1;
      return capture(tree);
    };
    assert.equal(f.layer.getParseRanges(null), null);
    assert.equal(passes, 2);
    assert.equal(f.layer.parseBoundaryLimitedReason, "result-limit");
    assert.deepEqual(f.layer.parseCompactionEdits, []);
    assert.equal(f.layer.treeIsDirty, dirty);
    assert.equal(f.layer.tree.rootNode.hasChanges, false);
  } finally {
    f.close();
  }
});
