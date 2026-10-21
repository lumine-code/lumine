const crypto = require("node:crypto");
exports.summary = (context) => {
  const root = context.getRootSyntaxNode();
  return {
    revision: context.buffer.getTextRevision(),
    endIndex: root.endIndex,
    hasError: root.hasError,
    inputHash: crypto.createHash("sha256").update(context.getText()).digest("hex"),
  };
};
