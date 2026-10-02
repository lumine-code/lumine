const TextBuffer = require("../src/text-buffer");

describe("TextBuffer first-match scans", () => {
  let buffer;

  afterEach(() => buffer?.destroy());

  it("does not collect every match for a forward scan without the global flag", () => {
    buffer = new TextBuffer("alpha beta\nalpha beta\nalpha beta");
    const first = spyOn(buffer, "findInRangeSync").and.callThrough();
    const all = spyOn(buffer, "findAllInRangeSync").and.callThrough();
    const callback = jasmine.createSpy("callback");
    buffer.scan(/beta/, callback);

    expect(first).toHaveBeenCalledTimes(1);
    expect(all).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("returns captures and context for the first match in a clipped range", () => {
    buffer = new TextBuffer("before\nalpha Beta\nalpha beta\nafter");
    const matches = [];
    buffer.scanInRange(
      /(be)(ta)/i,
      [
        [1, 0],
        [Infinity, Infinity],
      ],
      { leadingContextLineCount: 1, trailingContextLineCount: 1 },
      (argument) => matches.push(argument),
    );

    expect(matches.length).toBe(1);
    expect(matches[0].range.start.toArray()).toEqual([1, 6]);
    expect(matches[0].range.end.toArray()).toEqual([1, 10]);
    expect(Array.from(matches[0].match)).toEqual(["Beta", "Be", "ta"]);
    expect(matches[0].leadingContextLines).toEqual(["before"]);
    expect(matches[0].trailingContextLines).toEqual(["alpha beta"]);
  });

  it("keeps zero-width matches at the end of a row-start range", () => {
    buffer = new TextBuffer("first\nsecond");
    const matches = [];
    buffer.scanInRange(
      /^/m,
      [
        [0, 5],
        [1, 0],
      ],
      ({ range }) => matches.push(range.start.toArray()),
    );

    expect(matches).toEqual([[1, 0]]);
  });

  it("excludes a zero-width match at a range ending inside a line", () => {
    buffer = new TextBuffer("first\nsecond");
    const matches = [];
    buffer.scanInRange(
      /(?=ond)/,
      [
        [1, 0],
        [1, 3],
      ],
      ({ range }) => matches.push(range),
    );

    expect(matches).toEqual([]);
  });

  it("replaces only the first forward match and preserves undo", () => {
    buffer = new TextBuffer("alpha beta\nalpha beta");
    buffer.scan(/beta/, ({ replace }) => replace("BETA"));

    expect(buffer.getText()).toBe("alpha BETA\nalpha beta");
    expect(buffer.undo()).toBeTrue();
    expect(buffer.getText()).toBe("alpha beta\nalpha beta");
  });

  it("still visits every global match and the last non-global backwards match", () => {
    buffer = new TextBuffer("alpha beta\nalpha beta\nalpha beta");
    const forwards = [];
    const backwards = [];
    buffer.scan(/beta/g, ({ row }) => forwards.push(row));
    buffer.backwardsScan(/beta/, ({ row }) => backwards.push(row));

    expect(forwards).toEqual([0, 1, 2]);
    expect(backwards).toEqual([2]);
  });

  it("does not invoke the callback if the regex has no match", () => {
    buffer = new TextBuffer("alpha beta\nalpha beta");
    const callback = jasmine.createSpy("callback");
    buffer.scan(/absent/, callback);

    expect(callback).not.toHaveBeenCalled();
  });
});
