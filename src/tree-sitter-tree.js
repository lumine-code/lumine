const { Tree } = require("web-tree-sitter");
const { idleDisposals } = require("./idle-disposal-queue");

// A native finalizer drains every unreachable tree in one renderer task.
// Retain the raw Tree until its public owner (including nodes and cursors)
// is collected, then release trees in small batches through the public API.
const dispose = (tree) => {
  if (!require("./tree-sitter-runtime").failure) Tree.prototype.delete.call(tree);
};
const finalizer = new FinalizationRegistry((tree) => {
  idleDisposals.add(tree, dispose);
});

module.exports = function ownTree(tree) {
  // Keep the receiver as the proxy: rootNode/rootNodeWithOffset construct
  // nodes with `this` as their tree, so any retained node keeps this owner
  // alive. Binding these methods to the raw tree would break that lifetime.
  const owner = new Proxy(tree, {});
  finalizer.register(owner, tree);
  return owner;
};
