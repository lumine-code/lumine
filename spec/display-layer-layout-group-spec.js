const TextBuffer = require("../src/text-buffer");

describe("DisplayLayer layout groups", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length > 0) buffers.pop().destroy();
  });

  function buildBuffer(text) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return buffer;
  }

  it("updates one copied layout and lets its siblings adopt the result", () => {
    const buffer = buildBuffer(`${"x".repeat(100_000)}\ntail`);
    const source = buffer.addDisplayLayer({ softWrapColumn: 500 });
    source.getScreenLines();
    const copy = source.copy();
    expect(copy.layoutState).toBe(source.layoutState);
    copy.getScreenLines();
    const sourceTailId = source.cachedScreenLines.at(-1).id;
    const copyTailId = copy.cachedScreenLines.at(-1).id;
    const sourceUpdates = spyOn(source, "updateSpatialIndex").and.callThrough();
    const copyUpdates = spyOn(copy, "updateSpatialIndex").and.callThrough();
    const sourceEvents = jasmine.createSpy("sourceEvents");
    const copyEvents = jasmine.createSpy("copyEvents");
    source.onDidChange(sourceEvents);
    copy.onDidChange(copyEvents);

    buffer.insert([0, 50_000], "y");

    expect(sourceUpdates.calls.count() + copyUpdates.calls.count()).toBe(1);
    expect(copy.layoutState).toBe(source.layoutState);
    expectEquivalentSpatialState(source, copy);
    expect(sourceEvents).toHaveBeenCalledTimes(1);
    expect(copyEvents).toHaveBeenCalledTimes(1);
    expect(source.cachedScreenLines.at(-1).id).toBe(sourceTailId);
    expect(copy.cachedScreenLines.at(-1).id).toBe(copyTailId);
  });

  it("shares background indexing while keeping each member's screen-line cache local", () => {
    const buffer = buildBuffer(`${"x".repeat(20_000)}\n${"y".repeat(20_000)}`);
    const source = buffer.addDisplayLayer({ softWrapColumn: 500 });
    source.getScreenLines(0, 2);
    const copy = source.copy();
    const sourceProgress = spyOn(source, "updateSpatialIndex").and.callThrough();
    const copyProgress = spyOn(copy, "updateSpatialIndex").and.callThrough();
    copy.populateSpatialIndexIfNeeded(Infinity, Infinity);
    expect(sourceProgress).not.toHaveBeenCalled();
    expect(copyProgress).toHaveBeenCalled();
    expect(copy.indexedBufferRowCount).toBe(source.indexedBufferRowCount);
    expect(copy.cachedScreenLines).not.toBe(source.cachedScreenLines);
    sourceProgress.calls.reset();
    copyProgress.calls.reset();

    buffer.insert([0, 10_000], "z");

    expect(sourceProgress.calls.count() + copyProgress.calls.count()).toBe(1);
    expectEquivalentSpatialState(source, copy);

    buffer.insert([1, 10_000], "q");
    expectEquivalentSpatialState(source, copy);
    const targetScreenRow = source.translateBufferPosition([1, 10_000]).row;
    expect(source.getScreenLines(targetScreenRow, targetScreenRow + 2).map(lineText)).toEqual(
      copy.getScreenLines(targetScreenRow, targetScreenRow + 2).map(lineText),
    );
  });

  it("separates copies when their layout settings or folds diverge", () => {
    const buffer = buildBuffer(`${"x".repeat(10_000)}\nsecond\nthird`);
    const source = buffer.addDisplayLayer({ softWrapColumn: 500 });
    const settingsCopy = source.copy();
    const foldsCopy = source.copy();

    settingsCopy.reset({ softWrapColumn: 250 });
    foldsCopy.foldBufferRange([
      [1, 0],
      [2, 3],
    ]);
    expect(settingsCopy.layoutGroupId).not.toBe(source.layoutGroupId);
    expect(foldsCopy.layoutGroupId).not.toBe(source.layoutGroupId);
    expect(settingsCopy.layoutState).not.toBe(source.layoutState);
    expect(foldsCopy.layoutState).not.toBe(source.layoutState);
    for (const displayLayer of [source, settingsCopy, foldsCopy]) {
      displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    }

    const sourceUpdates = spyOn(source, "updateSpatialIndex").and.callThrough();
    const settingsUpdates = spyOn(settingsCopy, "updateSpatialIndex").and.callThrough();
    const foldsUpdates = spyOn(foldsCopy, "updateSpatialIndex").and.callThrough();
    buffer.insert([0, 5000], "z");

    expect(sourceUpdates).toHaveBeenCalledTimes(1);
    expect(settingsUpdates).toHaveBeenCalledTimes(1);
    expect(foldsUpdates).toHaveBeenCalledTimes(1);
    expect(source.getScreenLineCount()).not.toBe(settingsCopy.getScreenLineCount());
  });
});

function expectEquivalentSpatialState(left, right) {
  expect(right.indexedBufferRowCount).toBe(left.indexedBufferRowCount);
  expect(right.screenLineLengths).toEqual(left.screenLineLengths);
  expect(right.tabCounts).toEqual(left.tabCounts);
  expect(right.screenLineBlocks).toEqual(left.screenLineBlocks);
  expect([right.rightmostScreenPosition.row, right.rightmostScreenPosition.column]).toEqual([
    left.rightmostScreenPosition.row,
    left.rightmostScreenPosition.column,
  ]);
  expect(serializeChanges(right.spatialIndex.getChanges())).toEqual(
    serializeChanges(left.spatialIndex.getChanges()),
  );
}

function serializeChanges(changes) {
  return changes.map(({ oldStart, oldEnd, newStart, newEnd }) => ({
    oldStart: [oldStart.row, oldStart.column],
    oldEnd: [oldEnd.row, oldEnd.column],
    newStart: [newStart.row, newStart.column],
    newEnd: [newEnd.row, newEnd.column],
  }));
}

function lineText(screenLine) {
  return screenLine.lineText;
}
