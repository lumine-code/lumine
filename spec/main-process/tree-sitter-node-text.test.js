const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Node, TreeCursor } = require("web-tree-sitter");
require("../../src/tree-sitter-node-text");
const { constants } = require("node:buffer");

for (const [prototype, name] of [
  [Node.prototype, "text"],
  [TreeCursor.prototype, "nodeText"],
]) {
  test(`${name} rejects oversized UTF-16 ranges before invoking the text callback`, () => {
    const getter = Object.getOwnPropertyDescriptor(prototype, name).get;
    let reads = 0;
    const tree = {
      textCallback() {
        reads++;
        throw new Error("must not read");
      },
    };
    assert.throws(
      () =>
        getter.call({
          tree,
          startIndex: 3,
          endIndex: constants.MAX_STRING_LENGTH + 4,
          startPosition: { row: 0, column: 3 },
        }),
      {
        code: "ERR_TEXT_MATERIALIZATION_LIMIT",
      },
    );
    assert.equal(reads, 0);
  });
  test(`${name} preserves bounded Unicode text and clamps callback overshoot`, () => {
    const getter = Object.getOwnPropertyDescriptor(prototype, name).get;
    const text = "xx😀\r\nendZZ";
    const tree = { textCallback: (offset) => text.slice(offset, offset + 3) };
    assert.equal(
      getter.call({ tree, startIndex: 2, endIndex: 9, startPosition: { row: 0, column: 2 } }),
      "😀\r\nend",
    );
  });
}
