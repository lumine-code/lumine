const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Parser, Language, Query } = require("web-tree-sitter");
const { compileInjectionQuery } = require("../../src/tree-sitter-injections");
const indentation = require("../../src/typing-indentation-rules");
const { runQuery } = require("../../src/tree-sitter-query-budget");

let language;
before(async () => {
  await Parser.init();
  language = await Language.load(
    path.resolve(__dirname, "../../node_modules/language-json/grammars/json.wasm"),
  );
});

test("injection errors point to the exact UTF-16 pattern after Unicode comments", () => {
  const comment = "; " + "é🦉".repeat(30) + "\r\n";
  const source =
    comment +
    '((string) @injection.owner @injection.content (#set! injection.language "javascript"))\r\n' +
    comment +
    "(number) @injection.content";
  const query = new Query(language, source);
  try {
    assert.throws(
      () => compileInjectionQuery(query, source),
      (error) => {
        assert.equal(error.name, "QueryError");
        assert.match(error.message, /pattern 2.*exactly one @injection.owner/);
        assert.equal(error.index, source.indexOf("(number)"));
        assert.equal(source.slice(error.index), "(number) @injection.content");
        return true;
      },
    );
  } finally {
    query.delete();
  }
});

test("typing indentation compiles each pattern from UTF-16 source boundaries", () => {
  const comment = "; " + "é🦉".repeat(30) + "\r\n";
  const source = comment + '"}" @dedent\r\n' + comment + '"]" @match';
  const query = new Query(language, source);
  try {
    const rules = indentation.compile(query, source);
    assert.deepEqual(rules, [
      { value: "}", start: true, end: true },
      { value: "]", start: true, end: true },
    ]);
    assert.equal(indentation.mayMatch(rules, " } "), true);
    assert.equal(indentation.mayMatch(rules, "]"), true);
    assert.equal(indentation.mayMatch(rules, "ordinary text"), false);
  } finally {
    query.delete();
  }
});

test("query windows and containing windows pass UTF-16 indices without doubling", () => {
  const source = '["🦉",\r\n"é",\r\n"tail"]';
  const parser = new Parser().setLanguage(language),
    tree = parser.parse(source),
    query = new Query(language, "(string) @s");
  const start = source.indexOf('"é"'),
    end = start + '"é"'.length;
  try {
    for (const method of ["captures", "matches"])
      for (const options of [
        { startIndex: start, endIndex: end },
        { startContainingIndex: start, endContainingIndex: end },
      ]) {
        const result = runQuery(query, tree.rootNode, options, { method, now: () => 0 });
        assert.equal(result.complete, true);
        const captures =
          method === "captures"
            ? result.results
            : result.results.flatMap((match) => match.captures);
        assert.deepEqual(
          captures.map(({ node }) => [node.text, node.startIndex, node.endIndex]),
          [['"é"', start, end]],
        );
      }
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }
});
