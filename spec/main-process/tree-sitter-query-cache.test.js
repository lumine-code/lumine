const { test } = require("node:test");
const assert = require("node:assert/strict");
const captureQuery = require("../../src/tree-sitter-query-cache");

test("raw capture caching keeps range, query and tree identity separate", () => {
  let calls = 0;
  const query = { captures: () => [{ name: String(++calls) }] };
  const layer = {},
    tree = { rootNode: {} };
  const options = { startPosition: { row: 4, column: 0 }, endPosition: { row: 8, column: 0 } };
  const first = captureQuery(layer, query, tree, options);
  assert.equal(captureQuery(layer, query, tree, { ...options }), first);
  assert.equal(calls, 1);
  captureQuery(layer, query, tree, { ...options, endPosition: { row: 9, column: 0 } });
  assert.equal(calls, 2);
  captureQuery(layer, { captures: query.captures }, tree, options);
  assert.equal(calls, 3);
  captureQuery(layer, query, { rootNode: {} }, options);
  assert.equal(calls, 4);
});

test("capture windows are bounded and oversized or partial results are not retained", () => {
  let calls = 0,
    size = 1,
    partial = false;
  const query = {
    captures: () => {
      calls++;
      return Array.from({ length: size }, () => ({}));
    },
    didExceedMatchLimit: () => partial,
  };
  const layer = {},
    tree = { rootNode: {} };
  for (let row = 0; row < 17; row++)
    captureQuery(layer, query, tree, { startPosition: { row, column: 0 } });
  captureQuery(layer, query, tree, { startPosition: { row: 0, column: 0 } });
  assert.equal(calls, 18);
  size = 16001;
  captureQuery(layer, query, tree, {});
  captureQuery(layer, query, tree, {});
  assert.equal(calls, 20);
  size = 1;
  partial = true;
  captureQuery(layer, query, tree, {});
  captureQuery(layer, query, tree, {});
  assert.equal(calls, 22);
});

test("deadline and cancellation callbacks are never bypassed by a cache hit", () => {
  let calls = 0;
  const query = {
    captures: (_node, options) => {
      calls++;
      options.progressCallback?.();
      return [];
    },
  };
  const layer = {},
    tree = { rootNode: {} };
  captureQuery(layer, query, tree);
  let progress = 0;
  captureQuery(layer, query, tree, { progressCallback: () => progress++ });
  captureQuery(layer, query, tree, { timeoutMicros: 1 });
  assert.equal(calls, 3);
  assert.equal(progress, 1);
});

test("large names and shared predicate metadata count toward byte retention without reading text", () => {
  const layer = {},
    tree = { rootNode: {} };
  let calls = 0;
  const metadata = { description: "x".repeat(350000) };
  const node = {
    get text() {
      throw new Error("cache estimates must not materialize text");
    },
  };
  const query = {
    captures: () => {
      calls++;
      return [{ name: "scope", node, setProperties: metadata }];
    },
  };
  for (let row = 0; row < 5; row++) captureQuery(layer, query, tree, { startIndex: row });
  const stats = captureQuery.getStats(layer);
  assert.ok(stats.entries < 5);
  assert.ok(stats.captures < 5);
  assert.ok(stats.estimatedBytes <= stats.maxBytes);
  captureQuery(layer, query, tree, { startIndex: 0 });
  assert.equal(calls, 6);
  captureQuery.clear(layer);
  assert.equal(captureQuery.getStats(layer).estimatedBytes, 0);
});

test("oversized capture entries are returned without evicting useful cached data", () => {
  const layer = {},
    tree = { rootNode: {} };
  let name = "small",
    calls = 0;
  const query = {
    captures: () => {
      calls++;
      return [{ name }];
    },
  };
  const small = captureQuery(layer, query, tree);
  const before = captureQuery.getStats(layer);
  name = "x".repeat(before.maxBytes);
  captureQuery(layer, query, tree, { startIndex: 1 });
  captureQuery(layer, query, tree, { startIndex: 1 });
  assert.equal(calls, 3);
  assert.equal(captureQuery.getStats(layer).estimatedBytes, before.estimatedBytes);
  assert.equal(captureQuery(layer, query, tree), small);
});

test("bounded execution seam caches only complete arrays and also handles uncached options", () => {
  const layer = {},
    tree = { rootNode: {} };
  const query = {
    captures: () => {
      throw new Error("executor must own query execution");
    },
  };
  let calls = 0,
    limited = true;
  const execute = (actualQuery, node, options) => {
    assert.equal(actualQuery, query);
    assert.equal(node, tree.rootNode);
    assert.ok(options);
    calls++;
    return limited ? null : [{ name: "complete" }];
  };
  assert.equal(captureQuery(layer, query, tree, {}, execute), null);
  assert.equal(captureQuery(layer, query, tree, {}, execute), null);
  assert.equal(captureQuery.getStats(layer).estimatedBytes, 0);
  limited = false;
  const complete = captureQuery(layer, query, tree, {}, execute);
  assert.equal(captureQuery(layer, query, tree, {}, execute), complete);
  assert.equal(calls, 3);
  captureQuery(layer, query, tree, { progressCallback: () => false }, execute);
  assert.equal(calls, 4);
  captureQuery(layer, query, { rootNode: tree.rootNode }, {}, execute);
  assert.equal(captureQuery.getStats(layer).entries, 1);
  assert.equal(captureQuery.getStats(layer).misses, 1);
});
