const { Range } = require("../src/text-buffer");
const TreeSitterRangeList = require("../src/tree-sitter-range-list");

describe("TreeSitterRangeList", () => {
  it("keeps disjoint ranges in document order regardless of insertion order", () => {
    const list = new TreeSitterRangeList();

    list.add(new Range([4, 0], [5, 0]));
    list.add(new Range([0, 0], [1, 0]));
    list.add(new Range([2, 0], [3, 0]));

    expect([...list]).toEqual([
      new Range([0, 0], [1, 0]),
      new Range([2, 0], [3, 0]),
      new Range([4, 0], [5, 0]),
    ]);
  });

  it("coalesces intersecting and adjacent ranges in one batch", () => {
    const list = new TreeSitterRangeList();
    list.add(new Range([1, 0], [2, 0]));

    list.addAll([
      new Range([4, 0], [5, 0]),
      new Range([0, 0], [1, 0]),
      new Range([3, 0], [4, 0]),
      new Range([1, 5], [3, 5]),
    ]);

    expect([...list]).toEqual([new Range([0, 0], [5, 0])]);
  });

  it("clears without replacing the backing collection", () => {
    const list = new TreeSitterRangeList();
    const ranges = list.ranges;
    list.add(new Range([0, 0], [1, 0]));

    list.clear();

    expect(list.ranges).toBe(ranges);
    expect([...list]).toEqual([]);
  });
});
