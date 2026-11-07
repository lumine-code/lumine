const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { getEventListeners } = require("node:events");
const path = require("node:path");
const { Parser, Language, Query } = require("web-tree-sitter");
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
      clipPosition: (point) => new Point(0, Math.max(0, Math.min(length, point.column))),
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

test("splits timed-out windows before resolving captures and preserves the exact stream", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const f = fixture(16);
  const enclosing = f.capture("definition.class", 0, 16);
  const boundary = f.capture("name", 2, 3);
  const last = f.capture("name", 14, 15);
  const expected = [enclosing, boundary, boundary, last];
  const layer = f.layer(expected);
  const query = layer.queries.tagsQuery;
  const captures = query.captures;
  const attempts = [];
  let yields = 0;
  f.mode._yieldForQueryCaptureScan = async () => yields++;
  query.captures = (node, options) => {
    const width = options.endPosition.column - options.startPosition.column;
    attempts.push(width);
    if (width > 2) {
      clock += 26;
      assert.equal(options.progressCallback(), true);
      return [f.capture("must.not.escape", 0, 1)];
    }
    return captures(node, options);
  };
  const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery", { batchSize: 2 }));
  assert.deepEqual(
    batches.flatMap(({ captures }) => captures),
    expected,
  );
  assert.deepEqual(attempts.slice(0, 3), [8, 4, 2]);
  assert.ok(attempts.slice(2).every((width) => width <= 2));
  assert.ok(yields >= 2);
  assert.equal(batches.at(-1).last, true);
});

test("revalidates the snapshot after yielding to split a timed-out window", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const f = fixture();
  const query = f.layer().queries.tagsQuery;
  let attempts = 0;
  query.captures = (_node, options) => {
    attempts++;
    clock += 26;
    assert.equal(options.progressCallback(), true);
    return [];
  };
  f.mode._yieldForQueryCaptureScan = async () => f.edit();
  await assert.rejects(collect(scanQueryCaptures(f.mode, "tagsQuery")), { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("an indivisible window still fails its time budget without an endless retry", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const f = fixture(2);
  const query = f.layer().queries.tagsQuery;
  const widths = [];
  query.captures = (_node, options) => {
    widths.push(options.endPosition.column - options.startPosition.column);
    clock += 26;
    assert.equal(options.progressCallback(), true);
    return [];
  };
  await assert.rejects(collect(scanQueryCaptures(f.mode, "tagsQuery")), {
    name: "QueryBudgetExceeded",
    reason: "timeout",
  });
  assert.deepEqual(widths, [2, 1]);
});

test("does not split an indivisible CRLF or surrogate pair to bypass its budget", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  for (const source of ["\r\n", "💡"]) {
    const f = fixture(source.length);
    f.mode.buffer.getTextSnapshot = () => source;
    const query = f.layer().queries.tagsQuery;
    let attempts = 0;
    query.captures = (_node, options) => {
      attempts++;
      clock += 26;
      assert.equal(options.progressCallback(), true);
      return [];
    };
    await assert.rejects(collect(scanQueryCaptures(f.mode, "tagsQuery")), {
      name: "QueryBudgetExceeded",
      reason: "timeout",
    });
    assert.equal(attempts, 1);
  }
});

test("a learned one-unit window still consumes later CRLF and surrogate pairs whole", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const source = "a\r\n💡b";
  const f = fixture(source.length);
  f.mode.buffer.getTextSnapshot = () => source;
  const expected = [
    f.capture("name", 0, 1),
    f.capture("name", 1, 3),
    f.capture("name", 3, 5),
    f.capture("name", 5, 6),
  ];
  const query = f.layer(expected).queries.tagsQuery;
  const captures = query.captures;
  query.captures = (node, options) => {
    const start = options.startPosition.column;
    const end = options.endPosition.column;
    const text = source.slice(start, end);
    if (end - start > 1 && text !== "\r\n" && text !== "💡") {
      clock += 26;
      assert.equal(options.progressCallback(), true);
      return [];
    }
    return captures(node, options);
  };
  const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery"));
  assert.deepEqual(
    batches.flatMap(({ captures }) => captures),
    expected,
  );
  assert.deepEqual(
    f.calls.map(({ startPosition, endPosition }) => [startPosition.column, endPosition.column]),
    [
      [0, 1],
      [1, 3],
      [3, 5],
      [5, 6],
    ],
  );
});

test("adaptive windows preserve real WASM captures and genuine repeated patterns", async (t) => {
  await Parser.init();
  const language = await Language.load(
    path.resolve(__dirname, "../../node_modules/language-json/grammars/json.wasm"),
  );
  const parser = new Parser();
  parser.setLanguage(language);
  const source = `[${Array.from({ length: 100 }, (_, index) => index).join(",")}]`;
  const tree = parser.parse(source);
  const query = new Query(
    language,
    "(array) @meta.array\n(number) @constant.numeric\n(number) @constant.numeric",
  );
  const captures = query.captures.bind(query);
  const identity = (values) =>
    values.map(({ name, node }) => [name, node.startIndex, node.endIndex]);
  const expected = identity(captures(tree.rootNode));
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const attempts = [];
  query.captures = (node, options) => {
    const width = options.endPosition.column - options.startPosition.column;
    attempts.push(width);
    if (width > 16) {
      clock += 26;
      assert.equal(options.progressCallback(), true);
      return [];
    }
    return captures(node, options);
  };
  const f = fixture(source.length);
  f.mode.buffer.getTextSnapshot = () => source;
  f.mode.queryCaptureChunkCodeUnits = 128;
  const layer = f.layer();
  layer.tree.rootNode = tree.rootNode;
  layer.queries.tagsQuery = query;
  try {
    const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery", { batchSize: 7 }));
    assert.deepEqual(identity(batches.flatMap(({ captures }) => captures)), expected);
    assert.equal(expected.length, 201);
    assert.deepEqual(attempts.slice(0, 4), [128, 64, 32, 16]);
    assert.ok(attempts.slice(3).every((width) => width <= 16));
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }
});

test("does not replay a timeout after the scope resolver has consumed captures", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const f = fixture();
  const capture = f.capture("name", 0, 40, { "adjust.startAfterFirstMatchOf": ".+" });
  Object.defineProperty(capture.node, "text", {
    get() {
      clock += 26;
      checkPredicateTextLength(40);
      return "x".repeat(40);
    },
  });
  f.layer([capture]);
  await assert.rejects(collect(scanQueryCaptures(f.mode, "tagsQuery")), {
    name: "QueryBudgetExceeded",
    reason: "timeout",
  });
  assert.equal(f.calls.length, 1);
});

test("unbounded scope adjustments reject oversized predicate text instead of omitting a capture", async () => {
  const f = fixture(65537);
  const capture = f.capture("name", 0, 65537, { "adjust.startAfterFirstMatchOf": ".+" });
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

test("finite scope adjustments stream huge captures using bounded source reads", async () => {
  const f = fixture(65537);
  f.mode.queryCaptureChunkCodeUnits = 8192;
  const reads = [];
  f.mode.buffer.getTextSnapshot = () => ({
    length: 65537,
    slice(start, end) {
      reads.push(end - start);
      return "x".repeat(end - start);
    },
  });
  const capture = f.capture("name", 0, 65537, { "adjust.startAfterFirstMatchOf": "." });
  Object.defineProperty(capture.node, "text", {
    get() {
      return assert.fail("A finite first match must not materialize the whole node");
    },
  });
  f.layer([capture]);
  const batches = await collect(scanQueryCaptures(f.mode, "tagsQuery"));
  assert.deepEqual(
    batches.flatMap(({ captures }) => captures),
    [capture],
  );
  assert.equal(batches.at(-1).last, true);
  assert.ok(reads.includes(4096));
  assert.ok(reads.every((length) => length <= 4096));
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
