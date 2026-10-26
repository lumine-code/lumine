const { Node, TreeCursor } = require("web-tree-sitter");
const { constants } = require("node:buffer");
const { checkPredicateTextLength } = require("./tree-sitter-query-budget");

function textForRange(tree, start, end, position) {
  const length = end - start;
  checkPredicateTextLength(length);
  if (length > constants.MAX_STRING_LENGTH)
    throw Object.assign(
      new RangeError(
        "Syntax node text exceeds the runtime string limit; read its source range in chunks.",
      ),
      {
        code: "ERR_TEXT_MATERIALIZATION_LIMIT",
        length,
        limit: constants.MAX_STRING_LENGTH,
      },
    );
  const chunks = [];
  for (let offset = start; offset < end;) {
    const part = tree.textCallback(offset, position);
    if (!part) break;
    // The parser callback can return past this node's end. Clamp before joining
    // so even a representable node near the runtime limit cannot overallocate.
    const chunk = part.slice(0, end - offset);
    chunks.push(chunk);
    offset += chunk.length;
  }
  return chunks.join("");
}

const installed = Symbol.for("lumine.tree-sitter.bounded-node-text");
for (const [prototype, property] of [
  [Node.prototype, "text"],
  [TreeCursor.prototype, "nodeText"],
]) {
  if (prototype[installed]) continue;
  Object.defineProperty(prototype, property, {
    ...Object.getOwnPropertyDescriptor(prototype, property),
    get() {
      return textForRange(this.tree, this.startIndex, this.endIndex, this.startPosition);
    },
  });
  Object.defineProperty(prototype, installed, { value: true });
}

module.exports = { textForRange };
