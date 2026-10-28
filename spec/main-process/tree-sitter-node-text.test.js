const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Node, TreeCursor } = require("web-tree-sitter");
const { textRangeReader } = require("../../src/tree-sitter-node-text");
const { withPredicateTextBudget } = require("../../src/tree-sitter-query-budget");
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

  test(`${name} uses precise snapshot reads without bypassing predicate budgets`, () => {
    const getter = Object.getOwnPropertyDescriptor(prototype, name).get;
    const text = "xx😀\r\nendZZ",
      reads = [];
    const tree = { textCallback: () => assert.fail("parser-sized chunk was read") };
    tree.textCallback[textRangeReader] = (start, end) => {
      reads.push([start, end]);
      return text.slice(start, end);
    };
    const node = { tree, startIndex: 2, endIndex: 9, startPosition: { row: 0, column: 2 } };
    assert.equal(getter.call(node), "😀\r\nend");
    assert.deepEqual(reads, [[2, 9]]);
    const limited = withPredicateTextBudget(() => getter.call(node), {
      maxPredicateTextLength: 3,
      now: () => 0,
    });
    assert.equal(limited.complete, false);
    assert.equal(limited.reason, "predicate-text-limit");
    assert.deepEqual(reads, [[2, 9]]);
  });
}
