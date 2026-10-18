const assert = require("node:assert/strict");
const { test } = require("node:test");
const FoldResolver = require("../../src/tree-sitter-fold-resolver");

test("fold rendering waits for a current tree without forcing a synchronous parse", () => {
  const layer = {
    tree: { rootNode: {} },
    queries: { foldsQuery: {} },
    getOrParseTree(options) {
      assert.deepEqual(options, { force: false });
      return null;
    },
  };
  const resolver = new FoldResolver(null, layer);
  resolver.getOrCreateBoundariesIterator = () => {
    assert.fail("must not query the retained stale tree");
  };
  assert.equal(resolver.getFoldRangeForRow(0), null);

  const currentTree = { rootNode: {} };
  layer.tree = currentTree;
  layer.getOrParseTree = () => currentTree;
  let queried = false;
  resolver.getOrCreateBoundariesIterator = (rootNode) => {
    assert.equal(rootNode, currentTree.rootNode);
    queried = true;
    return { key: null };
  };
  assert.equal(resolver.getFoldRangeForRow(0), null);
  assert.equal(queried, true);
});
