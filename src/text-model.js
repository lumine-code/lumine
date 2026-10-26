// Internal document data structures without editor, filesystem or parser
// imports. Patch byte serialization retains the host's Buffer API; PieceTree
// reads node:buffer's intrinsic string limit before explicit materialization.
const { DocumentCore, ChangeSet } = require("./document-core");

module.exports = {
  PieceTree: require("./piece-tree"),
  DocumentCore,
  ChangeSet,
  TextPatch: require("./text-patch"),
  MarkerIndex: require("./marker-index"),
};
