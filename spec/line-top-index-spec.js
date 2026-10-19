const LineTopIndex = require("../src/line-top-index");

describe("LineTopIndex row geometry version", () => {
  let index;

  beforeEach(() => {
    index = new LineTopIndex({ defaultLineHeight: 10, seed: 1 });
  });

  function expectGeometryChange(operation) {
    const before = index.geometryVersion;
    operation();
    expect(index.geometryVersion).not.toBe(before);
  }

  it("invalidates nonzero blocks before and after a row", () => {
    expectGeometryChange(() => index.insertBlock("before", 2, 20));
    expect(index.pixelPositionBeforeBlocksForRow(2)).toBe(20);
    expect(index.pixelPositionAfterBlocksForRow(2)).toBe(40);

    expectGeometryChange(() => index.insertBlock("after", 2, 15, true));
    expect(index.pixelPositionAfterBlocksForRow(2)).toBe(40);
    expect(index.pixelPositionBeforeBlocksForRow(3)).toBe(65);

    expectGeometryChange(() => index.resizeBlock("after", 25));
    expect(index.pixelPositionBeforeBlocksForRow(3)).toBe(75);
    expectGeometryChange(() => index.removeBlock("before"));
    expect(index.pixelPositionAfterBlocksForRow(2)).toBe(20);
    expectGeometryChange(() => index.removeBlock("after"));
    expect(index.pixelPositionBeforeBlocksForRow(3)).toBe(30);
  });

  it("invalidates a moved block even when total document height is unchanged", () => {
    index.insertBlock("block", 2, 20);
    const totalHeight = index.pixelPositionAfterBlocksForRow(10);
    expect(index.pixelPositionAfterBlocksForRow(4)).toBe(60);

    expectGeometryChange(() => index.moveBlock("block", 6));

    expect(index.pixelPositionAfterBlocksForRow(4)).toBe(40);
    expect(index.pixelPositionAfterBlocksForRow(10)).toBe(totalHeight);
  });

  it("invalidates compensating block resizes with unchanged total height", () => {
    index.insertBlock("early", 2, 20);
    index.insertBlock("late", 8, 30);
    const totalHeight = index.pixelPositionAfterBlocksForRow(12);

    expectGeometryChange(() => {
      index.resizeBlock("early", 30);
      index.resizeBlock("late", 20);
    });

    expect(index.pixelPositionAfterBlocksForRow(5)).toBe(80);
    expect(index.pixelPositionAfterBlocksForRow(12)).toBe(totalHeight);
  });

  it("invalidates replacement blocks at another row with unchanged total height", () => {
    index.insertBlock("early", 2, 20);
    const totalHeight = index.pixelPositionAfterBlocksForRow(12);

    expectGeometryChange(() => {
      index.removeBlock("early");
      index.insertBlock("late", 8, 20);
    });

    expect(index.pixelPositionAfterBlocksForRow(5)).toBe(50);
    expect(index.pixelPositionAfterBlocksForRow(12)).toBe(totalHeight);
  });

  it("invalidates suffix-only splices and equal-extent replacements", () => {
    index.insertBlock("block", 4, 20);
    expectGeometryChange(() => index.splice(0, 0, 2));
    expect(index.pixelPositionAfterBlocksForRow(5)).toBe(50);
    expect(index.pixelPositionAfterBlocksForRow(6)).toBe(80);

    expectGeometryChange(() => index.splice(4, 3, 3));
    expect(index.pixelPositionAfterBlocksForRow(6)).toBe(60);
    expect(index.pixelPositionAfterBlocksForRow(7)).toBe(90);
  });

  it("invalidates changed line heights", () => {
    index.insertBlock("block", 2, 20);
    expectGeometryChange(() => index.setDefaultLineHeight(12));
    expect(index.pixelPositionAfterBlocksForRow(2)).toBe(44);
  });

  it("keeps geometry versions stable for reads and no-op mutations", () => {
    const empty = index.geometryVersion;
    index.splice(0, 0, 2);
    expect(index.geometryVersion).toBe(empty);

    index.insertBlock("block", 2, 20);
    const before = index.geometryVersion;
    index.pixelPositionBeforeBlocksForRow(2);
    index.pixelPositionAfterBlocksForRow(2);
    index.rowForPixelPosition(50);
    index.isEmpty();
    index.splice(0, 0, 0);
    index.setDefaultLineHeight(10);
    index.resizeBlock("block", 20);
    index.insertBlock("zero", 4, 0);
    index.resizeBlock("zero", 0);
    index.removeBlock("zero");

    expect(index.geometryVersion).toBe(before);
  });
});
