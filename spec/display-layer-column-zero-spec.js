const TextBuffer = require("../src/text-buffer");
const Point = require("../src/point");

describe("DisplayLayer clipping at column zero", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length) buffers.pop().destroy();
  });

  function buildLayer(text, options = {}) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return buffer.addDisplayLayer(options);
  }

  it("does not read characters to clip a line start", () => {
    const layer = buildLayer("    indented\n\tindented\n😀 text\n\ude00 text\n");
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const readCharacter = spyOn(layer.buffer, "getCharacterAtPosition").and.callThrough();

    for (const clipDirection of ["backward", "closest", "forward"]) {
      for (let row = 0; row < layer.buffer.getLineCount(); row++) {
        expect(layer.translateBufferPosition([row, 0], { clipDirection })).toEqual(Point(row, 0));
      }
    }

    expect(readCharacter).not.toHaveBeenCalled();
  });

  it("still projects line starts through folds and soft wraps", () => {
    const layer = buildLayer("abcdefgh\naa\nbb\ncc\ntail", { softWrapColumn: 4 });
    layer.foldBufferRange([
      [1, 0],
      [3, 2],
    ]);
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const readCharacter = spyOn(layer.buffer, "getCharacterAtPosition").and.callThrough();

    for (const clipDirection of ["backward", "closest", "forward"]) {
      expect(layer.translateBufferPosition([0, 0], { clipDirection })).toEqual(Point(0, 0));
      expect(layer.translateBufferPosition([1, 0], { clipDirection })).toEqual(Point(2, 0));
      expect(layer.translateBufferPosition([4, 0], { clipDirection })).toEqual(Point(3, 0));
    }

    expect(readCharacter).not.toHaveBeenCalled();
  });

  it("keeps character-pair, soft-tab and hard-tab clipping away from line starts", () => {
    const layer = buildLayer("😀x\n    x\n\tz", { tabLength: 4 });

    for (const clipDirection of ["backward", "closest", "forward"]) {
      const forward = clipDirection === "forward";
      expect(layer.translateBufferPosition([0, 1], { clipDirection })).toEqual(
        Point(0, forward ? 2 : 0),
      );
      expect(layer.translateBufferPosition([1, 1], { clipDirection })).toEqual(
        Point(1, forward ? 4 : 0),
      );
      expect(layer.translateBufferPosition([2, 1], { clipDirection })).toEqual(Point(2, 4));
    }
  });

  it("uses the same line-start result in existing position batches", () => {
    const layer = buildLayer("abcdefgh\naa\nbb\ncc\ntail", { softWrapColumn: 4 });
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const readCharacter = spyOn(layer.buffer, "getCharacterAtPosition").and.callThrough();
    const points = Array.from({ length: 100 }, (_, index) => [index % 5, 0]);
    const expected = [Point(0, 0), Point(2, 0), Point(3, 0), Point(4, 0), Point(5, 0)];

    expect(layer.translateBufferPositions(points)).toEqual(
      points.map((_, index) => expected[index % 5]),
    );
    expect(readCharacter).not.toHaveBeenCalled();
  });
});
