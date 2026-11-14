const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Host = require("../../src/syntax-worker-host");
const Parser = require("../../src/tree-sitter-parser");
const TextBuffer = require("../../src/text-buffer");
const SyntaxSnapshot = require("../../src/tree-sitter-syntax-snapshot");
const captureQuery = require("../../src/tree-sitter-query-cache");
const { configuration } = require("../../src/syntax-worker-environment");
const {
  createInputSnapshot,
  isWhitespaceInsertion,
} = require("../../src/tree-sitter-input-snapshot");

async function setup(t, text, files = ["language-python/grammars/python.json"]) {
  const host = new Host();
  t.after(() => host.close());
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const grammars = files.map((name) => {
    const file = require.resolve(name);
    return { file, definition: require("@lumine-code/season").readFileSync(file) };
  });
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars,
    modules: [],
    specMode: true,
  });
  const data = {
    session: 1,
    revision: 0,
    scopeName: grammars[0].definition.scopeName,
    path: "example",
  };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  const mode = host.sessions.get(1).mode;
  // These tests isolate projection/routing from grammar-owned ownership
  // policies, which have their own contract and conservative fallback tests.
  for (const { definition } of grammars)
    host.grammars.grammarForScopeName(definition.scopeName).inputEditPolicy = path.resolve(
      __dirname,
      "../fixtures/input-edit-policy.js",
    );
  mode.queryBudget = { now: () => 0 };
  return { host, mode };
}

function draft(t, text, offsets, newline = "\n") {
  const buffer = new TextBuffer({ text });
  const changes = [];
  t.after(() => buffer.destroy());
  for (const startIndex of offsets.toSorted((a, b) => b - a)) {
    const point = buffer.positionForCharacterIndex(startIndex);
    buffer.setTextInRange([point, point], newline, { normalizeLineEndings: false });
    changes.push({ startIndex, oldEndIndex: startIndex, text: newline });
  }
  return { buffer, changes };
}

async function levels(projection, rows, options = {}) {
  const rowOptions = new Map(
    rows.map((row) => [row, { preserveLeadingWhitespace: true, skipBlankLines: false }]),
  );
  const result = [];
  for await (const batch of projection.scanSuggestedIndentation(
    rows.map((row) => [row, row]),
    4,
    { isPastedText: false, rowOptions, ...options },
  ))
    result.push(...batch);
  return result;
}

function noParsing(t) {
  for (const method of ["parse", "parseSync", "tryParseSync"])
    t.mock.method(Parser.prototype, method, () => {
      throw new Error("A projected input snapshot must not parse");
    });
}

test("one projected forest plans all Python suite splits without parsing or changing its source", async (t) => {
  const text = "if ready: value = 1\nelif other: value = 2\nelse: value = 3";
  const { mode } = await setup(t, text);
  const sourceTree = mode.rootLanguageLayer.tree;
  const syntax = sourceTree.rootNode.toString();
  const offsets = [text.indexOf(":"), text.indexOf(":", 10), text.lastIndexOf(":")].map(
    (index) => index + 1,
  );
  const { buffer, changes } = draft(t, text, offsets);
  noParsing(t);
  const copies = t.mock.method(Parser, "prepareTree", Parser.prepareTree);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  assert.ok(projection);
  assert.deepEqual(await levels(projection, [1, 3, 5]), [
    [1, 1],
    [3, 1],
    [5, 1],
  ]);
  assert.equal(copies.mock.callCount(), 0);
  assert.equal(projection.rootLanguageLayer.tree.rootNode.toString(), syntax);
  assert.equal(sourceTree.rootNode.toString(), syntax);
  assert.equal(sourceTree.rootNode.endPosition.row, 2);
  assert.equal(mode.buffer.getText(), text);
  assert.equal(
    buffer.getText(),
    "if ready:\n value = 1\nelif other:\n value = 2\nelse:\n value = 3",
  );
});

test("Enter after a complete Python one-line suite keeps its outer margin", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [text.length]);
  noParsing(t);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  assert.deepEqual(await levels(projection, [1]), [[1, 0]]);
});

test("Unicode source positions and CRLF insertions share the exact batch mapping", async (t) => {
  const text = "if s.l<=50e-3: s.Δσ_C = 80e6\r\nelif s.l<=80e-3: s.Δσ_C = 71e6";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(
    t,
    text,
    [text.indexOf(":") + 1, text.lastIndexOf(":") + 1],
    "\r\n",
  );
  noParsing(t);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  assert.deepEqual(await levels(projection, [1, 3]), [
    [1, 1],
    [3, 1],
  ]);
  assert.equal(
    buffer.getText(),
    "if s.l<=50e-3:\r\n s.Δσ_C = 80e6\r\nelif s.l<=80e-3:\r\n s.Δσ_C = 71e6",
  );
});

test("split JavaScript operators keep token ends before the inserted newline", async (t) => {
  for (const [text, token, setting] of [
    ["const value = ready && other;", "&&", "addHangingIndentAfterLogicalOperators"],
    ["const value = ready ? yes : no;", "?", "addHangingIndentAfterTernaryOperators"],
  ]) {
    const { host, mode } = await setup(t, text, ["language-javascript/grammars/javascript.json"]);
    host.config.set(`language-javascript.indentation.${setting}`, true);
    const { buffer, changes } = draft(t, text, [text.indexOf(token) + token.length]);
    const projection = createInputSnapshot(mode, buffer, changes);
    t.after(() => projection.close());
    assert.deepEqual(await levels(projection, [1]), [[1, 1]], text);
  }
});

test("native text predicates see original tokens while captured nodes expose projected geometry", async (t) => {
  const text = "value = word";
  const { mode } = await setup(t, text);
  await mode.grammar.setQueryForTest(
    "indentsQuery",
    '((identifier) @indent (#eq? @indent "word"))',
  );
  await mode.atGrammarSettlement();
  const { buffer, changes } = draft(t, text, [text.length]);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  assert.deepEqual(await levels(projection, [1]), [[1, 1]]);
  const node = projection.rootLanguageLayer.tree.rootNode.lastNamedChild.lastNamedChild;
  assert.equal(node.text, "word");
  assert.deepEqual(node.endPosition, { row: 0, column: text.length });
});

test("projected native predicates preserve text budgets and restore the shared query", async (t) => {
  const text = "value = word";
  const { mode } = await setup(t, text);
  await mode.grammar.setQueryForTest(
    "indentsQuery",
    '((identifier) @indent (#eq? @indent "word"))',
  );
  await mode.atGrammarSettlement();
  mode.queryBudget = { now: () => 0, maxPredicateTextLength: 3 };
  const query = mode.grammar.getQuerySync("indentsQuery");
  const predicates = query.textPredicates;
  const { buffer, changes } = draft(t, text, [text.length]);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  await assert.rejects(levels(projection, [1]), {
    name: "QueryBudgetExceeded",
    reason: "predicate-text-limit",
  });
  assert.equal(query.textPredicates, predicates);
});

test("same-line splits propagate the planned blank margin including retained whitespace", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [9, 10]);
  noParsing(t);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  assert.deepEqual(
    await levels(projection, [1, 2], {
      rowOptions: new Map([
        [1, { preserveLeadingWhitespace: true, skipBlankLines: false }],
        [
          2,
          {
            preserveLeadingWhitespace: true,
            skipBlankLines: false,
            comparisonRowIndent: 0.25,
            comparisonRowIndentCaptured: true,
          },
        ],
      ]),
    }),
    [
      [1, 1],
      [2, 1.25],
    ],
  );
  assert.equal(buffer.getText(), "if ready:\n \nvalue = 1");
});

test("IPython projects combined Python members while keeping their intervening holes", async (t) => {
  const text = "# %%\nif ready: value = 1\n# %% [markdown]\nhello\n# %%\nif other: value = 2";
  const { mode } = await setup(t, text, [
    "language-ipython/grammars/ipython.json",
    "language-python/grammars/python.json",
    "language-gfm/grammars/gfm.json",
  ]);
  const { buffer, changes } = draft(t, text, [text.indexOf(":") + 1, text.lastIndexOf(":") + 1]);
  noParsing(t);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  assert.ok(projection);
  const python = projection
    .getAllLanguageLayers()
    .find((layer) => layer.grammar.scopeName === "source.python");
  assert.ok(python);
  assert.ok(python.getCurrentRanges().length > 1);
  const hello = buffer.positionForCharacterIndex(buffer.getText().indexOf("hello"));
  assert.equal(python.containsPoint(hello), false);
  assert.notEqual(projection.controllingLayerAtPoint(hello), python);
  assert.deepEqual(await levels(projection, [2, 7]), [
    [2, 1],
    [7, 1],
  ]);
});

test("HTML routes split script bodies to the projected JavaScript layer", async (t) => {
  const text = "<script>if (ready) { value(); }</script>\n<p>hello</p>";
  const { host, mode } = await setup(t, text, [
    "language-html/grammars/html.json",
    "language-javascript/grammars/javascript.json",
  ]);
  host.config.set("language-javascript.indentation.indentBraces", true);
  const { buffer, changes } = draft(t, text, [text.indexOf("{") + 1, text.indexOf("}")]);
  noParsing(t);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  const point = buffer.positionForCharacterIndex(buffer.getText().indexOf("value"));
  assert.equal(projection.controllingLayerAtPoint(point).grammar.scopeName, "source.js");
  const tag = buffer.positionForCharacterIndex(buffer.getText().indexOf("<p>"));
  assert.equal(projection.controllingLayerAtPoint(tag).grammar.scopeName, "text.html.basic");
  assert.deepEqual(await levels(projection, [1, 2]), [
    [1, 1],
    [2, 0],
  ]);
});

test("projection releases borrowed node wrappers and capture caches without deleting its source", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [9]);
  const projection = createInputSnapshot(mode, buffer, changes);
  const layer = projection.rootLanguageLayer;
  const tree = layer.tree;
  const node = tree.rootNode;
  await levels(projection, [1]);
  assert.ok(captureQuery.getStats(layer).entries > 0);
  projection.close();
  projection.close();
  assert.equal(node.original, null);
  assert.throws(() => tree.rootNode, { name: "AbortError" });
  assert.equal(captureQuery.getStats(layer).entries, 0);
  assert.equal(layer.tree, null);
  assert.equal(layer.buffer, null);
  assert.equal(layer.languageMode, null);
  assert.equal(layer.scopeResolver.buffer, null);
  assert.equal(projection.buffer, null);
  assert.equal(projection.indentResolver.buffer, null);
  assert.equal(projection.destroyed, true);
  await assert.rejects(levels(projection, [1]), { name: "AbortError" });
  assert.equal(mode.rootLanguageLayer.tree.rootNode.type, "module");
});

test("aborting or superseding a projection stops an in-progress scan", async (t) => {
  const text = "if ready: value = 1\nif other: value = 2";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [9, text.lastIndexOf(":") + 1]);
  const controller = new AbortController();
  const projection = createInputSnapshot(mode, buffer, changes, { signal: controller.signal });
  t.after(() => projection.close());
  const scan = projection.scanSuggestedIndentation(
    [
      [1, 1],
      [3, 3],
    ],
    4,
    { batchSize: 1, signal: controller.signal },
  );
  await scan.next();
  controller.abort();
  await assert.rejects(scan.next(), { name: "AbortError" });
  const second = createInputSnapshot(mode, buffer, changes);
  t.after(() => second.close());
  mode.invalidateSyntaxRequestEpoch();
  await assert.rejects(levels(second, [1, 3]), { name: "AbortError" });
});

test("completing initialization releases its signal while later scans use their own signal", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [9]);
  const initialization = new AbortController();
  const projection = createInputSnapshot(mode, buffer, changes, {
    signal: initialization.signal,
  });
  t.after(() => projection.close());
  initialization.abort();
  assert.deepEqual(await levels(projection, [1]), [[1, 1]]);
  const scan = new AbortController();
  scan.abort();
  await assert.rejects(levels(projection, [1], { signal: scan.signal }), { name: "AbortError" });
});

test("a grammar generation change invalidates the borrowed query contract", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [9]);
  const projection = createInputSnapshot(mode, buffer, changes);
  t.after(() => projection.close());
  const grammar = mode.rootLanguageLayer.grammar;
  const generation = grammar.queryLoadGeneration;
  t.after(() => {
    grammar.queryLoadGeneration = generation;
  });
  grammar.queryLoadGeneration++;
  await assert.rejects(levels(projection, [1]), { name: "AbortError" });
});

test("unsupported mutations and an inconsistent edit journal use the parsed fallback", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [9]);
  assert.equal(isWhitespaceInsertion(changes), true);
  assert.equal(isWhitespaceInsertion([{ startIndex: 9, oldEndIndex: 10, text: "\n" }]), false);
  assert.equal(isWhitespaceInsertion([{ startIndex: 9, oldEndIndex: 9, text: "new_name" }]), false);
  assert.equal(createInputSnapshot(mode, buffer, []), null);
  assert.equal(
    createInputSnapshot(mode, buffer, [{ startIndex: 9, oldEndIndex: 10, text: "\n" }]),
    null,
  );
  assert.equal(
    createInputSnapshot(mode, buffer, [{ startIndex: 9, oldEndIndex: 9, text: ":" }]),
    null,
  );
});

test("an embedding grammar without an ownership proof declines projection", async (t) => {
  const text = "<script>if (ready) { value(); }</script>";
  const { mode } = await setup(t, text, [
    "language-html/grammars/html.json",
    "language-javascript/grammars/javascript.json",
  ]);
  mode.grammar.inputEditPolicy = null;
  const { buffer, changes } = draft(t, text, [text.indexOf("{") + 1]);
  assert.equal(createInputSnapshot(mode, buffer, changes), null);
});

test("a captured snapshot can project after the original buffer receives the raw input", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const snapshot = mode.captureSyntaxSnapshot({ indentationOnly: true });
  const { buffer, changes } = draft(t, text, [9]);
  mode.buffer.setTextInRange(
    [
      [0, 9],
      [0, 9],
    ],
    "\n",
  );
  const projection = createInputSnapshot(mode, buffer, changes, { snapshot });
  t.after(() => projection.close());
  assert.ok(projection);
  assert.deepEqual(await levels(projection, [1]), [[1, 1]]);
});

test("incomplete captured forests are distinguishable from intentionally ignored injections", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const { buffer, changes } = draft(t, text, [9]);
  const root = mode.rootLanguageLayer;
  const child = {
    ...root,
    childLayerMarkers: new Set(),
    lastIncludedRanges: null,
    backgroundTree: { revision: -1 },
  };
  const fake = Object.create(mode);
  fake.rootLanguageLayer = { ...root, childLayerMarkers: new Set([{ languageLayer: child }]) };
  let snapshot = SyntaxSnapshot.capture(fake, { indentationOnly: true });
  assert.equal(snapshot.complete, false);
  assert.equal(createInputSnapshot(mode, buffer, changes, { snapshot }), null);
  child.grammar = { queryLoadGeneration: 0 };
  snapshot = SyntaxSnapshot.capture(fake, { indentationOnly: true });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.layers.length, 1);
});

test("a configuration change between capture and projection declines the previous intent", async (t) => {
  const text = "if ready: value = 1";
  const { mode } = await setup(t, text);
  const snapshot = mode.captureSyntaxSnapshot({ indentationOnly: true });
  const { buffer, changes } = draft(t, text, [9]);
  mode.invalidateSyntaxRequestEpoch();
  assert.equal(createInputSnapshot(mode, buffer, changes, { snapshot }), null);
});

test("capture limits mark truncated forests unavailable to the typing projection", async (t) => {
  const { mode } = await setup(t, "value = 1");
  const root = mode.rootLanguageLayer;
  const fake = Object.create(mode);
  const child = { ...root, childLayerMarkers: new Set(), lastIncludedRanges: null };
  fake.rootLanguageLayer = {
    ...root,
    childLayerMarkers: new Set(Array.from({ length: 4096 }, () => ({ languageLayer: child }))),
  };
  let snapshot = SyntaxSnapshot.capture(fake, { indentationOnly: true });
  assert.equal(snapshot.layers.length, 4096);
  assert.equal(snapshot.complete, false);
  fake.rootLanguageLayer = {
    ...root,
    lastIncludedRanges: Array(16385).fill({ startIndex: 0, endIndex: 1 }),
  };
  assert.equal(SyntaxSnapshot.capture(fake, { indentationOnly: true }), null);
  fake.rootLanguageLayer = {
    ...root,
    childLayerMarkers: new Set([
      {
        languageLayer: {
          ...child,
          lastIncludedRanges: Array(16385).fill({ startIndex: 0, endIndex: 1 }),
        },
      },
    ]),
  };
  snapshot = SyntaxSnapshot.capture(fake, { indentationOnly: true });
  assert.equal(snapshot.complete, false);
});
