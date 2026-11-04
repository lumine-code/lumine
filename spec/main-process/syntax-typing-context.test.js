const { test } = require("node:test");
const assert = require("node:assert/strict");
const { permits, advance, capture } = require("../../src/syntax-typing-context");
const Range = require("../../src/range");
const policyFile = require.resolve("../fixtures/syntax-content-edit-policy");
const grammar = { contentEditPolicies: new Map([["words", policyFile]]) };
const registry = { grammarForScopeName: () => grammar };
const snapshot = () => ({
  rootRules: [],
  contexts: [
    {
      owner: "source.host",
      policy: "words",
      rules: [{ value: "else", start: true, end: true }],
      ranges: [{ start: { row: 1, column: 0 }, end: { row: 4, column: 0 } }],
    },
  ],
});

test("stable content uses child indentation rules and fails closed without a policy", () => {
  const context = snapshot();
  assert.equal(permits(context, registry, new Range([2, 10], [2, 10]), "a", "    value="), true);
  assert.equal(permits(context, registry, new Range([2, 7], [2, 7]), "e", "    els"), false);
  assert.equal(permits(context, registry, new Range([2, 10], [2, 10]), "'", "    value="), false);
  assert.equal(permits(context, registry, new Range([2, 10], [2, 10]), "\n", "    value="), false);
  assert.equal(
    permits(
      context,
      { grammarForScopeName: () => null },
      new Range([2, 10], [2, 10]),
      "a",
      "    value=",
    ),
    false,
  );
  context.contexts[0].rules = null;
  assert.equal(permits(context, registry, new Range([2, 10], [2, 10]), "a", "    value="), false);
});

test("range boundaries, excluded holes, overlapping unknown languages and long rows retain preparation", () => {
  const context = snapshot();
  context.contexts[0].ranges = [
    { start: { row: 2, column: 0 }, end: { row: 2, column: 12 } },
    { start: { row: 2, column: 15 }, end: { row: 3, column: 0 } },
  ];
  for (const [start, end] of [
    [0, 0],
    [12, 12],
    [10, 16],
    [15, 16],
  ])
    assert.equal(
      permits(context, registry, new Range([2, start], [2, end]), "a", "    value = one other"),
      false,
    );
  context.contexts.push({ ...context.contexts[0], policy: null });
  assert.equal(
    permits(context, registry, new Range([2, 10], [2, 10]), "a", "    value = one other"),
    false,
  );
  assert.equal(
    permits(snapshot(), registry, new Range([2, 10], [2, 10]), "a", " ".repeat(5000)),
    false,
  );
});

test("safe edits rebase same-row content boundaries and unsafe edits discard ownership", () => {
  const context = snapshot();
  context.contexts[0].ranges[0].end = { row: 2, column: 20 };
  const change = {
    oldRange: new Range([2, 10], [2, 10]),
    newRange: new Range([2, 10], [2, 11]),
    oldText: "",
  };
  const buffer = { lineLengthForRow: () => 21, lineForRow: () => "    value=aaa trailing" };
  assert.equal(advance(context, registry, change, buffer), context);
  assert.deepEqual(context.contexts[0].ranges[0].end, { row: 2, column: 21 });
  const unsafe = { ...change, newRange: new Range([2, 10], [3, 0]) };
  assert.equal(advance(context, registry, unsafe, buffer), null);
});

test("roots without policies do not enumerate injection ranges", () => {
  assert.equal(capture({ publicationPending: true }), null);
  assert.equal(
    capture({ rootLanguageLayer: { grammar: { contentEditPolicies: new Map() } } }),
    null,
  );
});

test("policy exceptions and asynchronous results cannot opt an edit into the fast path", (t) => {
  require(policyFile);
  const edit = () => permits(snapshot(), registry, new Range([2, 10], [2, 10]), "a", "    value=");
  const policy = t.mock.method(require.cache[policyFile], "exports", () => {
    throw new Error("Policy failed");
  });
  assert.equal(edit(), false);
  policy.mock.mockImplementation(() => Promise.reject(new Error("Policies must be synchronous")));
  assert.equal(edit(), false);
  policy.mock.mockImplementation(() => "true");
  assert.equal(edit(), false);
});

test("provisional metadata retains only same-revision ownership and exact metadata replaces it", () => {
  const Mode = require("../../src/tree-sitter-worker-language-mode");
  const context = snapshot();
  const mode = {
    typingContext: context,
    typingContextRevision: 8,
    typingIndentationEpoch: "current",
    getSyntaxRequestEpoch: () => "current",
  };
  const result = {
    queries: [],
    grammars: [],
    typingContext: null,
    typingContextRevision: 8,
    syntaxReady: false,
  };
  Mode.prototype.receiveMetadata.call(mode, result);
  assert.equal(mode.typingContext, context);
  Mode.prototype.receiveMetadata.call(mode, { ...result, typingContextRevision: 9 });
  assert.equal(mode.typingContext, null);
  mode.typingContext = context;
  Mode.prototype.receiveMetadata.call(mode, {
    ...result,
    typingContextRevision: 9,
    syntaxReady: true,
  });
  assert.equal(mode.typingContext, null);
});

test("capture bounds ownership and refuses a target-owned content filter", () => {
  const child = {
    grammar: { queryPaths: {}, injectionPointsByType: {} },
    injectionPoint: { contentEditPolicy: "words" },
    currentRangesLayer: { getMarkerCount: () => 1 },
    getCurrentRanges: () => [new Range([1, 0], [4, 0])],
  };
  const mode = {
    rootLanguageLayer: {
      grammar: { ...grammar, scopeName: "source.host", queryPaths: {}, injectionPointsByType: {} },
      childLayerMarkers: new Set([{ languageLayer: child }]),
    },
  };
  assert.equal(capture(mode).contexts[0].policy, "words");
  child.grammar.injectionContentRegex = /allowed/;
  assert.equal(capture(mode).contexts[0].policy, null);
  child.currentRangesLayer.getMarkerCount = () => 129;
  assert.equal(capture(mode), null);
});

test("static queries validate policy identifiers without treating them as executable paths", () => {
  const { compileInjectionQuery } = require("../../src/tree-sitter-injections");
  const properties = { "injection.language": "python", "injection.content-edit-policy": "words" };
  const query = {
    patternCount: () => 1,
    startIndexForPattern: () => 0,
    captureNames: ["injection.owner", "injection.content"],
    captureQuantifiers: [[3, 3]],
    predicatesForPattern: () => [],
    assertedProperties: [{}],
    refutedProperties: [{}],
    setProperties: [properties],
  };
  assert.equal(compileInjectionQuery(query).get(0).contentEditPolicy, "words");
  for (const invalid of ["", "../policy.js", "Words", "two words", null]) {
    properties["injection.content-edit-policy"] = invalid;
    assert.throws(() => compileInjectionQuery(query), /must name a content edit policy/);
  }
});
