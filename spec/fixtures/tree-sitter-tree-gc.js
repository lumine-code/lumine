const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Parser, Language, Tree, Query } = require("web-tree-sitter");
const DocumentParser = require("../../src/tree-sitter-parser");

async function main() {
  await Parser.init();
  const configFile = require.resolve("language-javascript/grammars/javascript.json");
  const config = require("@lumine-code/season").readFileSync(configFile);
  const language = await Language.load(fs.readFileSync(path.join(path.dirname(configFile), config.treeSitter.grammar)));
  const parser = new DocumentParser(language);
  const query = new Query(language, "(identifier) @name");
  let deleted = 0;
  const dispose = Tree.prototype.delete;
  Tree.prototype.delete = function () {
    deleted++;
    return dispose.call(this);
  };
  let nodes = [], cursors = [], owners = [];
  function createTrees() {
    for (let i = 0; i < 40; i++) {
      const tree = parser.parseSync(`const value${i} = ${i};`);
      assert.ok(tree instanceof Tree);
      assert.equal(tree.rootNode.tree, tree);
      owners.push(new WeakRef(tree));
      if (i % 4 === 0) nodes.push(tree.rootNode.namedChild(0));
      else if (i % 4 === 1) cursors.push(tree.walk());
      else if (i % 4 === 2) nodes.push(tree.rootNodeWithOffset(0, { row: 0, column: 0 }));
    }
  }
  const collect = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      global.gc();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  createTrees();
  parser.close();
  await collect();
  assert.equal(deleted, 10);
  function useRetained() {
    for (const node of nodes) {
      assert.match(node.text, /^const value\d+ = \d+;/);
      assert.equal(query.captures(node).length, 1);
    }
    for (const cursor of cursors) {
      assert.ok(cursor.gotoFirstChild());
      assert.match(cursor.nodeText, /^const value\d+ = \d+;/);
      cursor.delete();
    }
  }
  useRetained();
  nodes = cursors = null;
  await collect();
  assert.equal(owners.filter((owner) => owner.deref()).length, 0);
  assert.equal(deleted, 40);
  owners = null;
  query.delete();
  Tree.prototype.delete = dispose;
  console.log("Managed trees preserve retained nodes and release collected owners");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
