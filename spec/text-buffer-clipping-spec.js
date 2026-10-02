const TextBuffer = require("../src/text-buffer");
const Point = require("../src/point");
const Range = require("../src/range");

describe("TextBuffer range clipping", () => {
  let buffer;

  beforeEach(() => {
    buffer = new TextBuffer("alpha\r\n\ncoffee\n");
  });

  afterEach(() => buffer.destroy());

  it("preserves an in-bounds range and its endpoint identities", () => {
    const range = new Range([0, 1], [0, 4]);
    expect(buffer.clipRange(range)).toBe(range);
    expect(buffer.clipRange(range).start).toBe(range.start);
    expect(buffer.clipRange(range).end).toBe(range.end);
  });

  it("clips both endpoints independently and retains an unchanged endpoint", () => {
    const range = new Range([0, 1], [0, Infinity]);
    const clipped = buffer.clipRange(range);
    expect(clipped.serialize()).toEqual([
      [0, 1],
      [0, 5],
    ]);
    expect(clipped.start).toBe(range.start);
    expect(clipped.end).not.toBe(range.end);

    const empty = buffer.clipRange(new Range([1, 100], [1, 100]));
    expect(empty.serialize()).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(empty.start).not.toBe(empty.end);
  });

  it("agrees with clipping each point across fractional and unbounded coordinates", () => {
    const coordinates = [-Infinity, -1, -0.1, 0, 0.1, 1, 1.9, 2, 3, 4, 5, 6, Infinity];
    for (const row of coordinates) {
      for (const startColumn of coordinates) {
        for (const endColumn of coordinates) {
          const range = new Range(new Point(row, startColumn), new Point(row, endColumn));
          const start = buffer.clipPosition(range.start);
          const end = buffer.clipPosition(range.end);
          const result = buffer.clipRange(range);
          expect(result.start.toArray()).toEqual(start.toArray());
          expect(result.end.toArray()).toEqual(end.toArray());
          expect(result === range).toBe(range.start.isEqual(start) && range.end.isEqual(end));
        }
      }
    }
  });

  it("rejects invalid coordinates with the point clipping error", () => {
    for (const point of [new Point(NaN, 1), new Point(0, NaN), new Point(0, {})]) {
      expect(() => buffer.clipRange(new Range(point, point))).toThrowError(
        TypeError,
        `Invalid Point: ${point}`,
      );
    }
  });

  it("honors an overridden clipPosition method for both endpoints", () => {
    const range = new Range([0, 1], [0, 4]);
    const clipPosition = spyOn(buffer, "clipPosition").and.callFake((point) =>
      point.translate([0, 1]),
    );
    expect(buffer.clipRange(range).serialize()).toEqual([
      [0, 2],
      [0, 5],
    ]);
    expect(clipPosition).toHaveBeenCalledTimes(2);
    expect(clipPosition.calls.argsFor(0)).toEqual([range.start]);
    expect(clipPosition.calls.argsFor(1)).toEqual([range.end]);
  });

  it("honors a replacement on the TextBuffer prototype", () => {
    const clipPosition = spyOn(TextBuffer.prototype, "clipPosition").and.callFake((point) =>
      point.translate([0, 1]),
    );
    expect(buffer.clipRange(new Range([0, 1], [0, 4])).serialize()).toEqual([
      [0, 2],
      [0, 5],
    ]);
    expect(clipPosition).toHaveBeenCalledTimes(2);
  });

  it("reads current bounds after edits, undo, and redo", () => {
    const range = new Range([0, 0], [0, Infinity]);
    expect(buffer.clipRange(range).end.column).toBe(5);
    buffer.setTextInRange(
      [
        [0, 5],
        [0, 5],
      ],
      "longer",
    );
    expect(buffer.clipRange(range).end.column).toBe(11);
    buffer.undo();
    expect(buffer.clipRange(range).end.column).toBe(5);
    buffer.redo();
    expect(buffer.clipRange(range).end.column).toBe(11);
    buffer.setText("x");
    expect(buffer.clipRange(range).end.column).toBe(1);
  });
});
