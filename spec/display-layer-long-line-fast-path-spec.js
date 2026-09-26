const TextBuffer = require("../src/text-buffer");
const Point = require("../src/point");
const { isWrapBoundary } = require("../src/text-utils");

describe("DisplayLayer long-line fast paths", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length > 0) buffers.pop().destroy();
  });

  function buildDisplayLayer(text, params) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return { buffer, displayLayer: buffer.addDisplayLayer(params) };
  }

  it("matches the general path for unwrapped lines containing hard tabs", () => {
    const text = `${"a".repeat(5003)}\tb\nshort\tline`;
    const fast = buildDisplayLayer(text, {
      softWrapColumn: Infinity,
      tabLength: 4,
    });
    const reference = buildDisplayLayer(text, {
      softWrapColumn: Number.MAX_SAFE_INTEGER,
      tabLength: 4,
      ratioForCharacter: () => 1,
      isWrapBoundary: () => false,
    });

    expectEquivalentLayouts(fast.displayLayer, reference.displayLayer, [
      Point(0, 0),
      Point(0, 5003),
      Point(0, 5004),
      Point(0, 5005),
      Point(1, 5),
    ]);

    fast.buffer.insert(Point(0, 2500), "z");
    reference.buffer.insert(Point(0, 2500), "z");
    expectEquivalentLayouts(fast.displayLayer, reference.displayLayer, [
      Point(0, 2499),
      Point(0, 2500),
      Point(0, 5004),
      Point(1, 5),
    ]);
  });

  it("retains the general path for Unicode text with custom character widths", () => {
    const line = `${"我".repeat(4096)}🐲\tb`;
    let ratioCallCount = 0;
    const { displayLayer } = buildDisplayLayer(line, {
      softWrapColumn: Infinity,
      tabLength: 4,
      ratioForCharacter(character) {
        ratioCallCount++;
        return character === "我" ? 2 : 1;
      },
    });

    expect(displayLayer.getScreenLineCount()).toBe(1);
    expect(displayLayer.lineLengthForScreenRow(0)).toBe(4101);
    expect(toArray(displayLayer.getRightmostScreenPosition())).toEqual([0, 4101]);
    expect(toArray(displayLayer.translateBufferPosition(Point(0, 4098)))).toEqual([0, 4098]);
    expect(toArray(displayLayer.translateBufferPosition(Point(0, 4099)))).toEqual([0, 4100]);
    expect(ratioCallCount).toBeGreaterThan(4096);
  });

  it("emits regular hard-wrap hunks without visiting every character", () => {
    const line = "x".repeat(1_000_003);
    let ratioCallCount = 0;
    const { buffer, displayLayer } = buildDisplayLayer(line, {
      softWrapColumn: 500,
    });
    displayLayer.ratioForCharacter = () => {
      ratioCallCount++;
      return 1;
    };

    expect(displayLayer.getScreenLineCount()).toBe(2001);
    expect(displayLayer.screenLineLengths.slice(0, 3)).toEqual([500, 500, 500]);
    expect(displayLayer.screenLineLengths.at(-1)).toBe(3);
    expect(ratioCallCount).toBe(128);

    ratioCallCount = 0;
    buffer.insert(Point(0, 500_000), "x");
    expect(displayLayer.getScreenLineCount()).toBe(2001);
    expect(displayLayer.screenLineLengths.at(-1)).toBe(4);
    expect(ratioCallCount).toBe(128);
  });

  it("matches the general wrapping algorithm before and after edits", () => {
    const text = "x".repeat(20_003);
    const fast = buildDisplayLayer(text, { softWrapColumn: 500 });
    const reference = buildDisplayLayer(text, {
      softWrapColumn: 500,
      ratioForCharacter: () => 1,
      isWrapBoundary(previousCharacter, character) {
        return (
          (previousCharacter === " " || previousCharacter === "\t") &&
          character !== " " &&
          character !== "\t"
        );
      },
    });

    const positions = [
      Point(0, 0),
      Point(0, 499),
      Point(0, 500),
      Point(0, 501),
      Point(0, 10_000),
      Point(0, 20_003),
    ];
    expectEquivalentLayouts(fast.displayLayer, reference.displayLayer, positions);

    fast.buffer.insert(Point(0, 7777), "xxx");
    reference.buffer.insert(Point(0, 7777), "xxx");
    expectEquivalentLayouts(fast.displayLayer, reference.displayLayer, positions);

    fast.buffer.delete([
      [0, 100],
      [0, 2300],
    ]);
    reference.buffer.delete([
      [0, 100],
      [0, 2300],
    ]);
    expectEquivalentLayouts(fast.displayLayer, reference.displayLayer, [
      Point(0, 0),
      Point(0, 499),
      Point(0, 500),
      Point(0, 17_806),
    ]);
  });

  it("inlines standard ASCII widths and wrap boundaries on long prose-like rows", () => {
    const text = "alpha beta-gamma/delta ".repeat(1000);
    let ratioCallCount = 0;
    const fast = buildDisplayLayer(text, {
      softWrapColumn: 73,
      softWrapHangingIndent: 2,
      ratioForCharacter() {
        ratioCallCount++;
        return 1;
      },
      isWrapBoundary,
    });
    const reference = buildDisplayLayer(text, {
      softWrapColumn: 73,
      softWrapHangingIndent: 2,
      ratioForCharacter: () => 1,
      isWrapBoundary(previousCharacter, character) {
        return (
          (previousCharacter === " " ||
            previousCharacter === "\t" ||
            previousCharacter === "-" ||
            previousCharacter === "/") &&
          character !== " " &&
          character !== "\t"
        );
      },
    });

    expectEquivalentLayouts(fast.displayLayer, reference.displayLayer, [
      Point(0, 0),
      Point(0, 72),
      Point(0, 10_000),
      Point(0, text.length),
    ]);
    expect(ratioCallCount).toBeLessThan(200);

    ratioCallCount = 0;
    fast.buffer.insert(Point(0, 12_345), "z");
    reference.buffer.insert(Point(0, 12_345), "z");
    expectEquivalentLayouts(fast.displayLayer, reference.displayLayer, [
      Point(0, 12_344),
      Point(0, 12_345),
      Point(0, text.length + 1),
    ]);
    expect(ratioCallCount).toBeLessThan(200);
  });

  it("finds trailing whitespace after one bulk buffer read", () => {
    const { buffer, displayLayer } = buildDisplayLayer(
      `prefix${" ".repeat(100_000)}\n\t \t\nplain`,
      {},
    );
    const characterReads = spyOn(buffer, "getCharacterAtPosition").and.callThrough();

    expect(displayLayer.findTrailingWhitespaceStartColumn(0)).toBe(6);
    expect(displayLayer.findTrailingWhitespaceStartColumn(1)).toBe(0);
    expect(displayLayer.findTrailingWhitespaceStartColumn(2)).toBe(5);
    expect(characterReads).not.toHaveBeenCalled();
  });
});

function expectEquivalentLayouts(actual, expected, bufferPositions) {
  actual.populateSpatialIndexIfNeeded(Infinity, Infinity);
  expected.populateSpatialIndexIfNeeded(Infinity, Infinity);

  expect(actual.screenLineLengths).toEqual(expected.screenLineLengths);
  expect(actual.tabCounts).toEqual(expected.tabCounts);
  expect(toArray(actual.getRightmostScreenPosition())).toEqual(
    toArray(expected.getRightmostScreenPosition()),
  );
  expect(serializeChanges(actual.spatialIndex.getChanges())).toEqual(
    serializeChanges(expected.spatialIndex.getChanges()),
  );
  expect(actual.getText()).toBe(expected.getText());

  for (const position of bufferPositions) {
    const actualScreenPosition = actual.translateBufferPosition(position);
    const expectedScreenPosition = expected.translateBufferPosition(position);
    expect(toArray(actualScreenPosition)).toEqual(toArray(expectedScreenPosition));
    expect(toArray(actual.translateScreenPosition(actualScreenPosition))).toEqual(
      toArray(expected.translateScreenPosition(expectedScreenPosition)),
    );
  }
}

function serializeChanges(changes) {
  return changes.map(({ oldStart, oldEnd, newStart, newEnd }) => ({
    oldStart: toArray(oldStart),
    oldEnd: toArray(oldEnd),
    newStart: toArray(newStart),
    newEnd: toArray(newEnd),
  }));
}

function toArray(point) {
  return [point.row, point.column];
}
