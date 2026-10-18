const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Parser, Language, Query, TreeCursor } = require("web-tree-sitter");
require("../../src/tree-sitter-cursor");

async function main() {
  await Parser.init();
  const file = require.resolve("language-javascript/grammars/javascript.json");
  const config = require("@lumine-code/season").readFileSync(file);
  const language = await Language.load(fs.readFileSync(path.join(path.dirname(file), config.treeSitter.grammar)));
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, "(identifier) @name");
  const retained = [];
  for (let run = 0; run < 300; run++) {
    let tree = parser.parse("function first(a) { return a; }\nfunction second(b) { return b; }");
    let cursor = tree.walk();
    assert.ok(cursor instanceof TreeCursor);
    cursor.gotoFirstChild();
    const text = cursor.nodeText;
    let other = tree.walk();
    other.gotoLastChild();
    if (run % 3 === 0) {
      Object.defineProperty(other, "delete", { value: undefined });
      assert.equal(other.delete, undefined);
    }
    // Another cursor and a query overwrite the shared transfer buffer.
    query.captures(tree.rootNode);
    let copy = cursor.copy();
    assert.equal(copy.nodeText, text);
    copy.gotoFirstChild();
    assert.equal(cursor.nodeText, text);
    if (run % 2) { copy.delete(); copy.delete(); }
    if (run % 10 === 0) retained.push(cursor);
    if (retained.length > 3) retained.shift();
    cursor = other = copy = tree = null;
    if (run % 5 === 0) {
      global.gc();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  for (const cursor of retained) cursor.delete();
  retained.length = 0;
  global.gc();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parser.parse("const healthy = 1;").rootNode.hasError, false);
  query.delete();
  parser.delete();
  console.log("Cursor collection and copy passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
