const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const PieceTree = require("../../src/piece-tree");
const {
  allowsInputProjection,
  normalizeInputEditPolicy,
} = require("../../src/tree-sitter-input-policy");

const policyPath = path.resolve(__dirname, "../fixtures/input-edit-policy.js");
const grammar = (options = {}) => ({
  queryPaths: {},
  queryCache: new Map(),
  injectionPointsByType: {},
  ...options,
});
const injecting = (languageName, options = {}) =>
  grammar({
    queryPaths: { injectionsQuery: "injections.scm" },
    queryCache: new Map([
      ["injectionsQuery", { injectionDescriptors: new Map([[0, { languageName }]]) }],
    ]),
    ...options,
  });
const indented = () => grammar({ queryPaths: { indentsQuery: "indents.scm" } });
function fixture(rootGrammar = grammar(), text = "first(value)\nsecond(value)\n") {
  const root = { grammar: rootGrammar, parent: null, ranges: null };
  const snapshot = { source: new PieceTree(text), policy: null, layers: [root] };
  const languages = new Map();
  return {
    root,
    snapshot,
    languages,
    mode: { grammarForLanguageString: (language) => languages.get(language) },
  };
}
const insertion = (startIndex, newText = "\n") => ({
  startIndex,
  oldEndIndex: startIndex,
  newText,
});
const allows = ({ mode, snapshot }, changes) => allowsInputProjection(mode, snapshot, changes);

test("input ownership policy paths normalize relative to the grammar definition", () => {
  const file = path.resolve("grammars/language.json");
  assert.equal(normalizeInputEditPolicy(file, "../lib/policy.js"), path.resolve("lib/policy.js"));
  assert.equal(normalizeInputEditPolicy(file, undefined), null);
  for (const invalid of [true, {}, "", "   "])
    assert.throws(() => normalizeInputEditPolicy(file, invalid), TypeError);
});

test("own indentation and fixed nonindenting or unavailable injections need no policy", () => {
  assert.equal(allows(fixture(indented()), [insertion(5)]), true);
  const f = fixture(injecting("todo"));
  assert.equal(allows(f, [insertion(5)]), true);
  f.languages.set("todo", grammar());
  assert.equal(allows(f, [insertion(5)]), true);
});

test("possible indentation requires proof even when the old forest has no child", () => {
  const f = fixture(injecting("python"));
  f.languages.set("python", indented());
  assert.equal(allows(f, [insertion(5)]), false);
  f.root.grammar.inputEditPolicy = policyPath;
  assert.equal(allows(f, [insertion(5)]), true);
});

test("dynamic and unloaded injection descriptors require an explicit policy", () => {
  for (const root of [
    injecting(undefined),
    grammar({ queryPaths: { injectionsQuery: "unloaded.scm" } }),
    grammar({ injectionPointsByType: { body: [{ language: () => "python" }] } }),
  ]) {
    const f = fixture(root);
    assert.equal(allows(f, [insertion(5)]), false);
    root.inputEditPolicy = policyPath;
    assert.equal(allows(f, [insertion(5)]), true);
  }
});

test("proof follows possible descendants of fixed injected grammars", () => {
  const f = fixture(injecting("child"));
  f.languages.set("child", injecting(undefined));
  assert.equal(allows(f, [insertion(5)]), false);
});

test("only containing saved children participate; included range holes do not", () => {
  const f = fixture(grammar(), "abcdefghijklmnopqrstuvwx");
  const child = {
    parent: f.root,
    grammar: injecting(undefined),
    ranges: [
      { startIndex: 2, endIndex: 7 },
      { startIndex: 12, endIndex: 17 },
    ],
  };
  f.snapshot.layers.push(child);
  assert.equal(allows(f, [insertion(4)]), false);
  assert.equal(allows(f, [insertion(9)]), true);
  child.grammar.inputEditPolicy = policyPath;
  assert.equal(allows(f, [insertion(4)]), true);
  for (const boundary of [2, 7, 12, 17]) assert.equal(allows(f, [insertion(boundary)]), false);
});

test("all containing ancestors must approve, but unrelated cells may decline", () => {
  const f = fixture(injecting(undefined), "abcdefghijklmnopqrstuvwxyz");
  f.root.grammar.inputEditPolicy = policyPath;
  const parent = {
    parent: f.root,
    grammar: injecting(undefined),
    ranges: [{ startIndex: 2, endIndex: 20 }],
  };
  const nested = {
    parent,
    grammar: indented(),
    ranges: [{ startIndex: 4, endIndex: 10 }],
  };
  const unrelated = {
    parent: f.root,
    grammar: injecting(undefined),
    ranges: [{ startIndex: 22, endIndex: 25 }],
  };
  f.snapshot.layers.push(parent, nested, unrelated);
  assert.equal(allows(f, [insertion(6)]), false);
  parent.grammar.inputEditPolicy = policyPath;
  assert.equal(allows(f, [insertion(6)]), true);
  assert.equal(allows(f, [insertion(23)]), false);
});

test("sequential insertion coordinates map to the original ownership path", () => {
  const f = fixture(grammar(), "abcdefghijklmnopqrstuvwx");
  f.snapshot.layers.push({
    parent: f.root,
    grammar: injecting(undefined),
    ranges: [{ startIndex: 12, endIndex: 20 }],
  });
  assert.equal(allows(f, [insertion(2, "\n\n"), insertion(16)]), false);
  assert.equal(allows(f, [insertion(2, "\n\n"), insertion(10)]), true);
  assert.equal(allows(f, [insertion(2, "\n\n"), insertion(3)]), false);
});

test("policies receive immutable bounded current-line context for each sequential edit", (t) => {
  const f = fixture(injecting(undefined), "previous\r\nfirst(value)\r\nlast");
  const observed = [];
  const cached = require.cache[policyPath];
  require.cache[policyPath] = {
    exports: (context) => {
      observed.push(context);
      return true;
    },
  };
  t.after(() => {
    if (cached) require.cache[policyPath] = cached;
    else delete require.cache[policyPath];
  });
  f.root.grammar.inputEditPolicy = policyPath;
  assert.equal(allows(f, [insertion(15), insertion(21)]), true);
  assert.deepEqual(observed[0], {
    before: "first",
    oldText: "",
    newText: "\n",
    after: "(value)",
    previousLine: "previous",
    row: 1,
    column: 5,
  });
  assert.equal(Object.isFrozen(observed[0]), true);
  assert.equal(observed[1].previousLine, "first");
  assert.equal(observed[1].before, "(valu");
});

test("missing, throwing, asynchronous and nonliteral policy answers decline", async (t) => {
  const f = fixture(injecting(undefined));
  const cached = require.cache[policyPath];
  t.after(() => {
    if (cached) require.cache[policyPath] = cached;
    else delete require.cache[policyPath];
  });
  f.root.grammar.inputEditPolicy = policyPath;
  for (const policy of [
    null,
    () => 1,
    () => {
      throw new Error("policy");
    },
    () => Promise.reject(new Error("policy")),
  ]) {
    require.cache[policyPath] = { exports: policy };
    assert.equal(allows(f, [insertion(5)]), false);
  }
  await new Promise((resolve) => setImmediate(resolve));
  f.root.grammar.inputEditPolicy = `${policyPath}.absent`;
  assert.equal(allows(f, [insertion(5)]), false);
});

test("oversized context, uncertain CRLF coordinates and root-range policies decline", () => {
  const root = injecting(undefined, { inputEditPolicy: policyPath });
  assert.equal(allows(fixture(root, "x".repeat(4097)), [insertion(5)]), false);
  assert.equal(allows(fixture(root, "x".repeat(4097) + "\nsecond"), [insertion(4100)]), false);
  assert.equal(allows(fixture(root), [insertion(5, " ".repeat(4097))]), false);
  assert.equal(allows(fixture(root, "first\r\nsecond"), [insertion(6)]), false);
  const f = fixture();
  f.snapshot.policy = { ranges: [] };
  assert.equal(allows(f, [insertion(5)]), false);
});

test("invalid journals decline and cancellation checks remain observable", () => {
  const f = fixture();
  for (const changes of [
    [insertion(-1)],
    [insertion(500)],
    [insertion(2, "word")],
    [{ startIndex: 2, oldEndIndex: 3, newText: "\n" }],
  ])
    assert.equal(allows(f, changes), false);
  assert.throws(
    () =>
      allowsInputProjection(f.mode, f.snapshot, [insertion(5)], () => {
        throw new Error("cancelled");
      }),
    /cancelled/,
  );
});
