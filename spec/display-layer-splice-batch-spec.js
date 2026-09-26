const TextBuffer = require("../src/text-buffer");

describe("DisplayLayer geometry splice batching", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length > 0) buffers.pop().destroy();
  });

  function buildLayer(text) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return {
      buffer,
      layer: buffer.addDisplayLayer({
        softWrapColumn: 18,
        softWrapHangingIndent: 2,
        tabLength: 4,
        foldCharacter: "…",
      }),
    };
  }

  it("matches sequential splices across wraps, tabs, folds, and edits", () => {
    const text = [
      "alpha beta\tgamma delta epsilon zeta eta theta",
      "hidden middle row",
      "fold tail iota kappa lambda mu nu xi omicron",
      "last row with words",
    ].join("\n");
    const batched = buildLayer(text);
    const sequential = buildLayer(text);
    const foldRange = [
      [0, 11],
      [2, 9],
    ];
    batched.layer.foldBufferRange(foldRange);
    sequential.layer.foldBufferRange(foldRange);
    batched.layer.clearSpatialIndex();
    sequential.layer.clearSpatialIndex();

    const nativeSplice = batched.layer.spatialIndex.splice.bind(batched.layer.spatialIndex);
    const spliceMany = jasmine.createSpy("spliceMany").and.callFake((packed) => {
      const start = { row: 0, column: 0 };
      const deletedExtent = { row: 0, column: 0 };
      const insertedExtent = { row: 0, column: 0 };
      for (let i = 0; i < packed.length; i += 6) {
        start.row = packed[i];
        start.column = packed[i + 1];
        deletedExtent.row = packed[i + 2];
        deletedExtent.column = packed[i + 3];
        insertedExtent.row = packed[i + 4];
        insertedExtent.column = packed[i + 5];
        nativeSplice(start, deletedExtent, insertedExtent);
      }
    });
    batched.layer.spatialIndex.spliceMany = spliceMany;

    expectEquivalentLayout(batched.layer, sequential.layer);
    expect(spliceMany).toHaveBeenCalled();
    expect(spliceMany.calls.mostRecent().args[0] instanceof Uint32Array).toBe(true);

    spliceMany.calls.reset();
    batched.buffer.insert([3, 8], " inserted words");
    sequential.buffer.insert([3, 8], " inserted words");
    expectEquivalentLayout(batched.layer, sequential.layer);
    expect(spliceMany).toHaveBeenCalled();
  });
});

function expectEquivalentLayout(actual, expected) {
  actual.populateSpatialIndexIfNeeded(Infinity, Infinity);
  expected.populateSpatialIndexIfNeeded(Infinity, Infinity);
  expect(actual.screenLineLengths).toEqual(expected.screenLineLengths);
  expect(actual.tabCounts).toEqual(expected.tabCounts);
  expect(actual.getText()).toBe(expected.getText());
  expect(serializeChanges(actual.spatialIndex.getChanges())).toEqual(
    serializeChanges(expected.spatialIndex.getChanges()),
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
