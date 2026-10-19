const TextBuffer = require("../src/text-buffer");
const Point = require("../src/point");

describe("TextBuffer line-start clipping", () => {
  let buffer;

  afterEach(() => buffer?.destroy());

  it("clips ordinary line starts without reading line lengths", () => {
    buffer = new TextBuffer({ text: "\ntext\n\tindented\n😀\n" });
    const lengths = spyOn(buffer, "lineLengthForRow").and.callThrough();
    for (const options of [
      undefined,
      {},
      { clipDirection: "backward" },
      { clipDirection: "closest" },
    ]) {
      for (let row = 0; row < buffer.getLineCount(); row++) {
        const position = Point(row, 0);
        expect(buffer.clipPosition(position, options)).toBe(position);
      }
    }
    expect(lengths).not.toHaveBeenCalled();
  });

  it("preserves forward clipping across empty lines and at the end of the buffer", () => {
    buffer = new TextBuffer({ text: "\ntext\n\n" });
    const options = { clipDirection: "forward" };
    expect(buffer.clipPosition([0, 0], options)).toEqual(Point(1, 0));
    expect(buffer.clipPosition([1, 0], options)).toEqual(Point(1, 0));
    expect(buffer.clipPosition([2, 0], options)).toEqual(Point(3, 0));
    expect(buffer.clipPosition([3, 0], options)).toEqual(Point(3, 0));
  });

  it("still clips rows, negative columns and columns beyond the line end", () => {
    buffer = new TextBuffer({ text: "text\ntail" });
    expect(buffer.clipPosition([-1, 0])).toEqual(Point(0, 0));
    expect(buffer.clipPosition([Infinity, 0])).toEqual(Point(1, 4));
    expect(buffer.clipPosition([1, -1])).toEqual(Point(1, 0));
    expect(buffer.clipPosition([1, Infinity])).toEqual(Point(1, 4));
    expect(buffer.clipPosition(Object.freeze([1, 0]))).toEqual(Point(1, 0));
  });
});
