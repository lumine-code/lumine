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
