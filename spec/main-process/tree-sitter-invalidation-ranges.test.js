const { test } = require("node:test");
const assert = require("node:assert/strict");
const Ranges = require("../../src/tree-sitter-invalidation-ranges");
const Range = require("../../src/range");

test("invalidation dependencies follow edits and retain untouched captured regions", () => {
  const ranges = new Ranges();
  ranges.add({ startPosition: { row: 10, column: 2 }, endPosition: { row: 20, column: 5 } });
  ranges.add({ startPosition: { row: 30, column: 0 }, endPosition: { row: 40, column: 0 } });
  ranges.edit({
    startPosition: { row: 0, column: 0 },
    oldEndPosition: { row: 0, column: 0 },
    newEndPosition: { row: 5, column: 0 },
  });
  assert.deepEqual(
    ranges.takeIntersecting(new Range([15, 3], [15, 4])).map((r) => r.serialize()),
    [
      [
        [15, 2],
        [25, 5],
      ],
    ],
  );
  ranges.edit({
    startPosition: { row: 35, column: 0 },
    oldEndPosition: { row: 36, column: 0 },
    newEndPosition: { row: 35, column: 0 },
  });
  assert.deepEqual(
    ranges.takeIntersecting(new Range([35, 0], [35, 1])).map((r) => r.serialize()),
    [
      [
        [35, 0],
        [44, 0],
      ],
    ],
  );
  assert.equal(ranges.ranges.size, 0);
});

test("boundary inserts extend dependency coverage without retaining syntax nodes", () => {
  const ranges = new Ranges();
  const node = { startPosition: { row: 0, column: 2 }, endPosition: { row: 0, column: 5 } };
  ranges.add(node);
  ranges.add({ ...node, id: 999 });
  assert.equal(ranges.ranges.size, 1);
  node.startPosition.column = 100;
  ranges.edit({
    startPosition: { row: 0, column: 2 },
    oldEndPosition: { row: 0, column: 2 },
    newEndPosition: { row: 1, column: 0 },
  });
  ranges.edit({
    startPosition: { row: 1, column: 3 },
    oldEndPosition: { row: 1, column: 3 },
    newEndPosition: { row: 1, column: 4 },
  });
  assert.deepEqual(
    ranges.takeIntersecting(new Range([1, 3], [1, 4])).map((r) => r.serialize()),
    [
      [
        [0, 2],
        [1, 4],
      ],
    ],
  );
});
