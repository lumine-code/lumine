const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Parser, Language, Query } = require("web-tree-sitter");
const SourceParser = require("../../src/tree-sitter-parser");
const createQuery = require("../../src/tree-sitter-query");
const { runQuery } = require("../../src/tree-sitter-query-budget");
let language;
before(async () => {
  await Parser.init();
  language = await Language.load(
    path.resolve(__dirname, "../../node_modules/language-json/grammars/json.wasm"),
  );
});
const normalize = (values) =>
  values.map((v) =>
    v.captures
      ? { pattern: v.patternIndex, captures: normalize(v.captures) }
      : {
          name: v.name,
          start: v.node.startIndex,
          end: v.node.endIndex,
          set: v.setProperties,
          asserted: v.assertedProperties,
          refuted: v.refutedProperties,
        },
  );
test("bounded match predicates preserve native captures, quantifiers, negation and predicate order", () => {
  const parser = new SourceParser(language),
    tree = parser.parseSync('["alpha","beta","alpha","🦉","#match?",""]');
  try {
    for (const operator of ["match?", "not-match?", "any-match?", "any-not-match?"])
      for (const pattern of [
        '^"a',
        'a"$',
        '^"alpha"$',
        "[ab]+",
        "^(alpha|beta)",
        "\\btext\\b",
        '^"[a-z]{0,5}"$',
        "",
      ]) {
        const choices = ["alpha", "beta", "🦉", "#match?", ""];
        const operands = choices.map((value) => JSON.stringify(JSON.stringify(value))).join(" ");
        const source = `; Unicode 🦉 and (#match? @ignored "fake")\n((array (string)+ @s) (#not-eq? @s "impossible") (#${operator} @s ${JSON.stringify(pattern)}) (#any-of? @s ${operands}) (#set! kind "value"))`;
        const raw = new Query(language, source),
          bounded = createQuery(language, source);
        try {
          for (const method of ["captures", "matches"])
            assert.deepEqual(
              normalize(bounded[method](tree.rootNode)),
              normalize(raw[method](tree.rootNode)),
              `${operator} ${pattern} ${method}`,
            );
          assert.deepEqual(bounded.predicatesForPattern(0), raw.predicatesForPattern(0));
        } finally {
          raw.delete();
          bounded.delete();
        }
      }
  } finally {
    parser.close();
  }
});
test("anchored predicates inspect a bounded edge of a huge node while unknown negatives remain limited", () => {
  const parser = new SourceParser(language),
    tree = parser.parseSync('"' + "x".repeat(300000) + 'tail"');
  try {
    for (const [pattern, expected] of [
      ['^"x', true],
      ['tail"$', true],
      ['^"missing', false],
      ['^"x"$', false],
    ]) {
      const query = createQuery(language, `((string) @s (#match? @s ${JSON.stringify(pattern)}))`);
      try {
        const result = runQuery(
          query,
          tree.rootNode,
          {},
          { now: () => 0, maxPredicateTextLength: 64 },
        );
        assert.equal(result.complete, true, pattern);
        assert.equal(result.results.length > 0, expected, pattern);
      } finally {
        query.delete();
      }
    }
    const query = createQuery(language, '((string) @s (#match? @s "missing"))');
    try {
      const result = runQuery(
        query,
        tree.rootNode,
        {},
        { now: () => 0, maxPredicateTextLength: 65536 },
      );
      assert.equal(result.complete, false);
      assert.equal(result.reason, "predicate-text-limit");
    } finally {
      query.delete();
    }
  } finally {
    parser.close();
  }
});
test("custom directives and invalid predicates keep the native validation contract", () => {
  for (const source of [
    '((string) @s (#MATCH? @s "x"))',
    '((string) @s (#custom? @s "(#match? @s nope)"))',
  ]) {
    const raw = new Query(language, source),
      bounded = createQuery(language, source);
    try {
      assert.deepEqual(bounded.predicatesForPattern(0), raw.predicatesForPattern(0));
    } finally {
      raw.delete();
      bounded.delete();
    }
  }
  for (const source of [
    '((string) @s (#match? "x" "x"))',
    "((string) @s (#match? @s))",
    '((string) @s (#match? @s "["))',
  ]) {
    assert.throws(() => new Query(language, source));
    assert.throws(() => createQuery(language, source));
  }
});

test("a fatal native metadata failure is propagated without retrying or deleting poisoned state", () => {
  const originalCount = Query.prototype.patternCount,
    originalDelete = Query.prototype.delete;
  const trap = new WebAssembly.RuntimeError("query metadata trap");
  let calls = 0,
    deletes = 0;
  Query.prototype.patternCount = () => {
    calls++;
    throw trap;
  };
  Query.prototype.delete = () => {
    deletes++;
  };
  try {
    assert.throws(
      () => createQuery(language, '((string) @s (#match? @s "^x"))'),
      (error) => error === trap,
    );
    assert.equal(calls, 1);
    assert.equal(deletes, 0);
  } finally {
    Query.prototype.patternCount = originalCount;
    Query.prototype.delete = originalDelete;
  }
});
