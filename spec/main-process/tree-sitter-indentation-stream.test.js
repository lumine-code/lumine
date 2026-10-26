const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const IndentResolver = require("../../src/tree-sitter-indent-resolver");
const { IndentationLevels } = require("../../src/tree-sitter-indentation-stream");

function fixture(count = 5000) {
  const buffer = new TextBuffer({
    text: Array.from({ length: count }, (_, row) => (row % 17 === 0 ? "" : "  value")).join("\n"),
  });
  const layer = {
    tree: {},
    ready: true,
    grammar: { queryLoadGeneration: 0 },
    queries: { indentsQuery: {} },
    getOrParseTree() {
      return this.tree;
    },
  };
  const mode = {
    rootLanguageLayer: layer,
    epoch: 0,
    generation: 0,
    getSyntaxRequestEpoch() {
      return this.epoch;
    },
    getSyntaxGeneration() {
      return this.generation;
    },
    controllingLayerAtPoint: () => layer,
  };
  const resolver = new IndentResolver(buffer, mode);
  let calls = 0;
  resolver.suggestedIndentForBufferRow = (row, tabLength, options) => {
    calls++;
    if (row === 0) return 0;
    if (row === 2) return 7;
    // Model a real @match reference to a previously changed distant parent.
    if (row === 4100)
      return (
        (options.indentationLevels.get(2) ?? resolver.indentLevelForBufferRow(2, tabLength)) + 3
      );
    if (row % 31 === 0) {
      options.preservedRows.add(row);
      return null;
    }
    const previous =
      options.comparisonRowIndent ??
      resolver.indentLevelForBufferRow(options.comparisonRow, tabLength);
    return Math.max(0, previous + (row % 5 === 0 ? 1 : 0));
  };
  return {
    buffer,
    mode,
    resolver,
    get calls() {
      return calls;
    },
    close: () => buffer.destroy(),
  };
}

async function collect(resolver, ranges, batchSize, options = {}) {
  const result = [];
  for await (const batch of resolver.scanSuggestedIndentation(ranges, 2, {
    batchSize,
    ...options,
  })) {
    assert.ok(batch.length > 0 && batch.length <= batchSize);
    result.push(...batch);
  }
  return result;
}

test("numeric history preserves sparse and fragmented prior rows across page boundaries", () => {
  const history = new IndentationLevels();
  for (let row = 0; row < 4096; row++) history.set(row, row / 3);
  history.set(8193, 12);
  for (const row of [0, 1, 2047, 2048, 4095]) assert.equal(history.get(row), row / 3);
  assert.equal(history.get(4096), undefined);
  assert.equal(history.get(8192), undefined);
  assert.equal(history.get(8193), 12);
  assert.equal(history.getStats().densePages, 1);
  assert.ok(history.getStats().allocatedBytes <= 2 * 32768);
});

test("twelve million uniform planned rows use compact pages instead of per-row Map entries", () => {
  const history = new IndentationLevels();
  for (let row = 0; row < 12000000; row++) history.set(row, 3);
  assert.equal(history.get(0), 3);
  assert.equal(history.get(11999999), 3);
  const stats = history.getStats();
  assert.equal(stats.storedRows, 12000000);
  assert.equal(stats.densePages, 0);
  assert.ok(stats.pages < 3000);
  assert.equal(stats.runs, stats.pages);
  assert.ok(stats.allocatedBytes < 300000);
});

for (const batchSize of [1, 7, 256]) {
  test(`streamed indentation matches the synchronous plan across batch size ${batchSize}`, async () => {
    const f = fixture();
    try {
      const expected = [...f.resolver.suggestedIndentForBufferRows(0, 4999, 2)];
      assert.deepEqual(await collect(f.resolver, [[0, 4999]], batchSize), expected);
      assert.equal(new Map(expected).get(4100), 10);
      assert.ok(expected.some(([, level]) => level === null));
      assert.ok(f.resolver.lastIndentationScanStats.storedRows < 5000);
    } finally {
      f.close();
    }
  });
  test(`disjoint ranges preserve shared indentation context with batch size ${batchSize}`, async () => {
    const f = fixture();
    try {
      const rows = [
        ...Array.from({ length: 80 }, (_, i) => i),
        ...Array.from({ length: 60 }, (_, i) => 4080 + i),
      ];
      const expected = [
        ...f.resolver.suggestedIndentForBufferRows(0, 4139, 2, {
          rows,
          preserveLeadingWhitespace: true,
        }),
      ];
      assert.deepEqual(
        await collect(
          f.resolver,
          [
            [0, 79],
            [4080, 4139],
          ],
          batchSize,
          { preserveLeadingWhitespace: true },
        ),
        expected,
      );
    } finally {
      f.close();
    }
  });
}

test("cancellation after a batch stops before resolving another row", async () => {
  const f = fixture(20),
    controller = new AbortController();
  try {
    const stream = f.resolver.scanSuggestedIndentation([[0, 19]], 2, {
      batchSize: 1,
      signal: controller.signal,
    });
    assert.deepEqual((await stream.next()).value, [[0, 0]]);
    controller.abort();
    await assert.rejects(stream.next(), { name: "AbortError" });
    assert.equal(f.calls, 1);
    assert.equal(f.resolver.lastIndentationScanStats.processedRows, 1);
  } finally {
    f.close();
  }
});

test("a twelve-million-row request produces its first packet without materializing a row list", async () => {
  const f = fixture(20);
  try {
    f.buffer.getLastRow = () => 11999999;
    const stream = f.resolver.scanSuggestedIndentation([[0, 11999999]], 2, { batchSize: 7 });
    assert.equal((await stream.next()).value.length, 7);
    await stream.return();
    assert.equal(f.calls, 7);
    assert.equal(f.resolver.lastIndentationScanStats.processedRows, 7);
    assert.ok(f.resolver.lastIndentationScanStats.allocatedBytes < 32768);
  } finally {
    f.close();
  }
});

for (const mutate of [
  (f) => f.mode.epoch++,
  (f) => f.mode.generation++,
  (f) => {
    f.mode.rootLanguageLayer = {};
  },
  (f) => {
    f.mode.rootLanguageLayer.grammar = { queryLoadGeneration: 0 };
  },
  (f) => f.buffer.append("changed"),
]) {
  test("revision or language topology changes invalidate a yielded indentation scan", async () => {
    const f = fixture(20);
    try {
      const stream = f.resolver.scanSuggestedIndentation([[0, 19]], 2, { batchSize: 1 });
      await stream.next();
      mutate(f);
      await assert.rejects(stream.next(), { name: "AbortError" });
      assert.equal(f.calls, 1);
    } finally {
      f.close();
    }
  });
}

test("a missing finite answer fails the stream instead of completing a partial plan", async () => {
  const f = fixture(20);
  try {
    f.resolver.suggestedIndentForBufferRow = (row) => (row === 0 ? 0 : undefined);
    const stream = f.resolver.scanSuggestedIndentation([[0, 19]], 2, { batchSize: 1 });
    await stream.next();
    await assert.rejects(stream.next(), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "indentation-unavailable",
    });
  } finally {
    f.close();
  }
});

test("undo after the final packet aborts before a streamed plan reports completion", async () => {
  const f = fixture(20);
  try {
    f.buffer.clearUndoStack();
    f.buffer.transact(() => f.buffer.append("\nnew row"));
    const stream = f.resolver.scanSuggestedIndentation([[20, 20]], 2, { batchSize: 1 });
    assert.equal((await stream.next()).value[0][0], 20);
    f.buffer.undo();
    assert.equal(f.buffer.getLastRow(), 19);
    await assert.rejects(stream.next(), { name: "AbortError" });
    assert.equal(f.calls, 1);
  } finally {
    f.close();
  }
});

test("unchanged plans retain no per-row numeric history", async () => {
  const f = fixture(5000);
  try {
    f.resolver.suggestedIndentForBufferRow = (row, tabLength) =>
      f.resolver.indentLevelForBufferRow(row, tabLength);
    const result = await collect(f.resolver, [[0, 4999]], 256);
    assert.equal(result.length, 5000);
    assert.equal(f.resolver.lastIndentationScanStats.allocatedBytes, 0);
    assert.equal(f.resolver.lastIndentationScanStats.storedRows, 0);
  } finally {
    f.close();
  }
});

test("stream validation rejects unordered, overlapping and out-of-bounds ranges and oversized batches", async () => {
  const f = fixture(20);
  try {
    for (const ranges of [
      [[2, 1]],
      [
        [0, 2],
        [2, 3],
      ],
      [[-1, 2]],
      [[0, 20]],
      [[1.2, 2]],
    ])
      await assert.rejects(f.resolver.scanSuggestedIndentation(ranges, 2).next(), RangeError);
    for (const batchSize of [0, 4097, 1.5])
      await assert.rejects(
        f.resolver.scanSuggestedIndentation([[0, 1]], 2, { batchSize }).next(),
        RangeError,
      );
    assert.equal(f.calls, 0);
  } finally {
    f.close();
  }
});

test("real JavaScript indentation gives the same plan through synchronous and streamed APIs", async () => {
  const Host = require("../../src/syntax-worker-host");
  const { configuration } = require("../../src/syntax-worker-environment");
  const host = new Host();
  try {
    for (const [key, schema] of Object.entries(require("../../src/config-schema")))
      host.config.setSchema(key, schema);
    host.config.set("language-javascript.indentation.indentBraces", true);
    const file = require.resolve("language-javascript/grammars/javascript.json");
    const definition = require("@lumine-code/season").readFileSync(file);
    await host.dispatch("environment", {
      version: 1,
      configuration: configuration(host.config),
      grammars: [{ file, definition }],
      modules: [],
      specMode: true,
    });
    const data = { session: 1, revision: 0, scopeName: definition.scopeName, path: "indent.js" };
    await host.dispatch("open", data);
    await host.dispatch("append", {
      session: 1,
      text: "function outer() {\nfunction inner() {\n" + "work();\n".repeat(40) + "}\n}\n",
    });
    await host.dispatch("initialize", data);
    await host.dispatch("settle", data);
    const { mode, buffer } = host.sessions.get(1);
    mode.ensureQueriesForLayersSync("indentsQuery");
    assert.ok(
      mode.rootLanguageLayer.queries.indentsQuery,
      "JavaScript indentation query is loaded",
    );
    assert.ok(
      mode.rootLanguageLayer.queries.indentsQuery.captures(mode.rootLanguageLayer.tree.rootNode)
        .length > 0,
      "JavaScript indentation captures are available",
    );
    const lastRow = buffer.getLastRow();
    const expected = [...mode.suggestedIndentForBufferRows(0, lastRow, 2)];
    for (const batchSize of [1, 7, 256])
      assert.deepEqual(await collect(mode.indentResolver, [[0, lastRow]], batchSize), expected);
    assert.equal(new Map(expected).get(1), 1, JSON.stringify(expected));
    assert.equal(new Map(expected).get(42), 1);
  } finally {
    host.close();
  }
});
