const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { getEventListeners } = require("node:events");
const Point = require("../../src/point");
const ScopeResolver = require("../../src/scope-resolver");
const scanQueryCaptures = require("../../src/tree-sitter-capture-stream");
const { checkPredicateTextLength } = require("../../src/tree-sitter-query-budget");

let originalLumine;
beforeEach(() => {
  originalLumine = global.lumine;
  global.lumine = {
    grammars: {
      onDidAddGrammar: () => ({ dispose() {} }),
      onDidUpdateGrammar: () => ({ dispose() {} }),
    },
    window: { isDevMode: () => false },
  };
});
afterEach(() => {
  ScopeResolver.clearConfigCache();
  global.lumine = originalLumine;
});

function fixture(length = 40) {
  let revision = 1;
  const source = "x".repeat(length);
  const config = { emitter: {}, onDidChangeConfiguration: () => ({ dispose() {} }) };
  const calls = [];
  const mode = {
    buffer: {
      getTextRevision: () => revision,
      getTextSnapshot: () => source,
      positionForCharacterIndex: (index) => new Point(0, index),
      characterIndexForPosition: (point) => point.column,
    },
    config,
    queryCaptureChunkRows: 200,
    queryCaptureChunkCodeUnits: 8,
    layers: [],
    getAllLanguageLayers() {
      return [...this.layers];
    },
    atGrammarSettlement: async () => ({}),
    _yieldForQueryCaptureScan: () => new Promise(setImmediate),
    queryCaptureSnapshotIsCurrent(snapshots, type, signal) {
      return (
        !this.destroyed &&
        !signal?.aborted &&
        !this.resolveNextTransaction &&
        snapshots.length === this.layers.length &&
        snapshots.every(
          (snapshot, index) =>
            snapshot.layer === this.layers[index] &&
            snapshot.tree === snapshot.layer.tree &&
            snapshot.query === snapshot.layer.queries[type] &&
            snapshot.injectionPointVersion === snapshot.layer.injectionPointVersion &&
            snapshot.tree.revision === revision,
        )
      );
    },
  };
  const capture = (name, start, end, properties) => ({
    name,
    node: {
      startIndex: start,
      endIndex: end,
      startPosition: new Point(0, start),
      endPosition: new Point(0, end),
    },
    setProperties: properties,
  });
  const layer = (captures = [], { query = true } = {}) => {
    const value = {
      buffer: mode.buffer,
      languageMode: mode,
      grammar: { scopeName: `source.layer${mode.layers.length}` },
      tree: { revision, rootNode: {} },
      scopeResolver: { idForScope: (name) => name },
      queries: query
        ? {
            tagsQuery: {
              captures(_node, options) {
                calls.push(options);
                return captures.filter(
                  ({ node }) =>
                    node.endIndex >= options.startPosition.column &&
                    node.startIndex <= options.endPosition.column,
                );
              },
            },
          }
        : {},
      getExtent: () => ({ start: new Point(0, 0), end: new Point(0, length) }),
      ensureQuery: async () => {},
    };
    mode.layers.push(value);
    return value;
  };
  return { mode, layer, capture, calls, edit: () => revision++ };
}

async function collect(stream) {
  const result = [];
  for await (const batch of stream) result.push(batch);
  return result;
}

test("streams bounded windows and batches while retaining genuine duplicate captures", async () => {
  const f = fixture();
  const enclosing = f.capture("definition.class", 0, 40);
  const boundary = f.capture("name", 8, 9);
  const last = f.capture("name", 24, 25);
  f.layer([enclosing, boundary, boundary, last]);
  f.layer([]);
  f.layer([], { query: false });
  const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery", { batchSize: 2 }));
  assert.deepEqual(
    batches.flatMap(({ captures }) => captures),
    [enclosing, boundary, boundary, last],
  );
  assert.deepEqual(
    batches.map(({ layerId, last, captures }) => [layerId, last, captures.length]),
    [
      [0, false, 2],
      [0, false, 2],
      [0, true, 0],
      [1, true, 0],
    ],
  );
  assert.ok(
    f.calls.every(
      ({ startPosition, endPosition }) => endPosition.column - startPosition.column <= 8,
    ),
  );
  assert.ok(f.calls.length > 1);
});

test("scope resolver state survives batches and windows without touching the layer resolver", async () => {
  const f = fixture();
  const outer = f.capture("definition.class", 0, 40, { outer: true });
  const first = f.capture("name", 1, 2, { "capture.final": true });
  const ignored = f.capture("ignored", 1, 2);
  const child = f.capture("name", 20, 21);
  child.node.parent = outer.node;
  child.assertedProperties = { "test.descendantOfNodeWithData": "outer" };
  const layer = f.layer([outer, first, ignored, child]);
  layer.scopeResolver.reset = () => assert.fail("A scan must own its resolver state");
  const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery", { batchSize: 1 }));
  assert.deepEqual(
    batches.flatMap(({ captures }) => captures),
    [outer, first, child],
  );
});

test("waits for lazy queries and repeats settlement when injection topology changes", async () => {
  const f = fixture();
  const root = f.layer([], { query: false });
  let settlements = 0;
  f.mode.atGrammarSettlement = async () => {
    settlements++;
    return {};
  };
  root.ensureQuery = async () => {
    root.ensureQuery = async () => {};
    f.layer([f.capture("name", 3, 4)]);
  };
  const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery"));
  assert.equal(settlements, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].layerId, 1);
  assert.equal(batches[0].captures[0].name, "name");
});

test("stale revisions and replaced queries reject after a yielded batch", async () => {
  for (const change of [
    (f) => f.edit(),
    (f) => {
      f.mode.layers[0].queries.tagsQuery = {};
    },
  ]) {
    const f = fixture();
    f.layer([f.capture("name", 1, 2), f.capture("name", 9, 10)]);
    const iterator = scanQueryCaptures(f.mode, "tagsQuery", { batchSize: 1 });
    assert.equal((await iterator.next()).value.last, false);
    change(f);
    await assert.rejects(iterator.next(), { name: "AbortError" });
  }
});

test("configuration epochs invalidate an exact stream even without edits or replaced queries", async () => {
  const f = fixture();
  let epoch = 0;
  f.mode.getSyntaxRequestEpoch = () => epoch;
  f.layer([f.capture("name", 1, 2), f.capture("name", 9, 10)]);
  const iterator = scanQueryCaptures(f.mode, "tagsQuery", { batchSize: 1 });
  assert.equal((await iterator.next()).value.last, false);
  epoch++;
  await assert.rejects(iterator.next(), { name: "AbortError" });
});

test("cancellation interrupts grammar settlement and removes its listener", async () => {
  const f = fixture();
  f.mode.atGrammarSettlement = () => new Promise(() => {});
  const controller = new AbortController();
  const next = scanQueryCaptures(f.mode, "tagsQuery", { signal: controller.signal }).next();
  const rejected = assert.rejects(next, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an exhausted query budget never reports a partial exact scan as completed", async () => {
  const f = fixture();
  const layer = f.layer([f.capture("name", 1, 2)]);
  layer.queries.tagsQuery.didExceedMatchLimit = () => true;
  await assert.rejects(collect(scanQueryCaptures(f.mode, "tagsQuery")), {
    name: "QueryBudgetExceeded",
    reason: "match-limit",
  });
});

test("scope adjustments also reject oversized predicate text instead of omitting a capture", async () => {
  const f = fixture(65537);
  const capture = f.capture("name", 0, 65537, { "adjust.startAfterFirstMatchOf": "." });
  Object.defineProperty(capture.node, "text", {
    get() {
      checkPredicateTextLength(65537);
      return assert.fail("Oversized predicate text must be rejected before materialization");
    },
  });
  f.layer([capture]);
  await assert.rejects(collect(scanQueryCaptures(f.mode, "tagsQuery")), {
    name: "QueryBudgetExceeded",
    reason: "predicate-text-limit",
  });
});

test("delivers early batches before scanning later windows and stops when the consumer closes", async () => {
  const f = fixture(10000);
  f.layer([f.capture("name", 1, 2), f.capture("name", 9000, 9001)]);
  const iterator = scanQueryCaptures(f.mode, "tagsQuery", { batchSize: 1 });
  const first = await iterator.next();
  assert.equal(first.value.captures.length, 1);
  assert.equal(first.value.last, false);
  assert.equal(f.calls.length, 1);
  await iterator.return();
  assert.equal(f.calls.length, 1);
});

test("empty layers finish without an unrestricted zero-end query", async () => {
  const f = fixture(0);
  f.layer();
  const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery"));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    batches.map(({ captures, last }) => ({ captures, last })),
    [{ captures: [], last: true }],
  );
});
