const TextBuffer = require("../src/text-buffer");
const HighlightCache = require("../src/tree-sitter-highlight-cache");
const NullLanguageMode = require("../src/null-language-mode");
const Point = require("../src/point");
const TreeSitterWorkerLanguageMode = require("../src/tree-sitter-worker-language-mode");
const TestLanguageMode = require("./text-buffer-helpers/test-language-mode");

describe("ScreenLineBuilder", () => {
  const buffers = [];

  afterEach(() => {
    for (const buffer of buffers) buffer.destroy();
    buffers.length = 0;
  });

  function buildBuffer(text) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return buffer;
  }

  function installWorkerPaint(buffer, end, events) {
    const mode = new NullLanguageMode({ buffer });
    mode.grammar = { scopeName: "source.test", idForScope: () => 301 };
    mode.cache = new HighlightCache();
    mode.cache.replace([{ start: Point.ZERO, end, scopes: [301, 303], events }], {
      revision: 0,
      generation: 1,
    });
    mode.exactScreenEnds = true;
    mode.buildPresentationHighlightIterator = function () {
      const iterator =
        TreeSitterWorkerLanguageMode.prototype.buildPresentationHighlightIterator.call(this);
      if (!this.exactScreenEnds) delete iterator.seekToPosition;
      return iterator;
    };
    buffer.setLanguageMode(mode);
    return mode;
  }

  it("reads cached worker scopes only through the requested wrap and keeps boundary colors", () => {
    const buffer = buildBuffer("x".repeat(20000));
    const layer = buffer.addDisplayLayer({ softWrapColumn: 80 });
    const events = Array.from({ length: 1999 }, (_, index) => {
      const opening = index % 2 === 0 ? 305 : 303;
      const closing = index % 2 === 0 ? 303 : 305;
      return { position: Point(0, (index + 1) * 10), open: [opening], close: [closing] };
    });
    const mode = installWorkerPaint(buffer, Point(0, 20000), events);
    const read = spyOn(mode.cache, "read").and.callThrough();
    const rows = Array.from({ length: 48 }, (_, index) => index + 2);
    const build = () =>
      rows.map((row) => {
        const { lineText, tags, softWrapIndent } = layer.getScreenLine(row, {});
        return { lineText, tags, softWrapIndent };
      });
    const exact = build();

    expect(read.calls.allArgs().map(([start, end]) => [start.toArray(), end.toArray()])).toEqual(
      rows.map((row) => [
        [0, row * 80],
        [0, (row + 1) * 80],
      ]),
    );
    expect(
      read.calls
        .all()
        .every(({ returnValue }) => returnValue.iterator.snapshot.events.length <= 10),
    ).toBe(true);
    layer.cachedScreenLines.length = 0;
    mode.exactScreenEnds = false;
    expect(build()).toEqual(exact);
  });

  it("keeps exact worker bounds through folds, tabs, EOL invisibles, and Unicode windows", () => {
    const buffer = buildBuffer("ab\tcd   \r\ninside fold\r\n  🐲z\t \nlast");
    const layers = [6, Infinity].map((softWrapColumn) => {
      const layer = buffer.addDisplayLayer({
        softWrapColumn,
        softWrapHangingIndent: 1,
        invisibles: { tab: "→", space: "·", cr: "¤", eol: "¬" },
      });
      layer.foldBufferRange([
        [0, 4],
        [2, 2],
      ]);
      return layer;
    });
    const events = [
      { position: Point(0, 3), open: [305], close: [303] },
      { position: Point(1, 8), open: [307], close: [] },
      { position: Point(2, 2), open: [309], close: [307] },
      { position: Point(2, 5), open: [], close: [309, 305] },
      { position: Point(2, 7), open: [303], close: [] },
      { position: Point(3, 2), open: [], close: [303] },
    ];
    const mode = installWorkerPaint(buffer, Point(3, 4), events);
    const content = ({ lineText, tags, softWrapIndent }) => ({ lineText, tags, softWrapIndent });
    const draw = () => [
      layers[0].getScreenLines().map(content),
      ...[
        [0, 5],
        [2, 9],
        [4, 20],
      ].map(([start, end]) => content(layers[1].getScreenLineWindow(0, start, end, {}))),
    ];
    const exact = draw();
    for (const layer of layers) layer.cachedScreenLines.length = 0;
    mode.exactScreenEnds = false;
    expect(draw()).toEqual(exact);
  });

  it("reads once from a wrap checkpoint and emits ordinary text in runs", () => {
    const buffer = buildBuffer("x".repeat(4000));
    const displayLayer = buffer.addDisplayLayer({ softWrapColumn: 20 });

    // Keep spatial-index work out of these spies. This test is specifically
    // about constructing screen lines after their wrap boundaries are known.
    displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const lineReads = spyOn(buffer, "lineForRow").and.callThrough();
    const sourceReads = spyOn(
      Object.getPrototypeOf(buffer.getTextSnapshot()),
      "slice",
    ).and.callThrough();
    const characterReads = spyOn(buffer, "getCharacterAtPosition").and.callThrough();
    const textAppends = spyOn(displayLayer.screenLineBuilder, "emitText").and.callThrough();

    const screenLines = displayLayer.getScreenLines(150, 160);

    expect(screenLines.map(({ lineText }) => lineText)).toEqual(new Array(10).fill("x".repeat(20)));
    expect(sourceReads).toHaveBeenCalledOnceWith(3000, 4000);
    expect(lineReads).not.toHaveBeenCalled();
    expect(characterReads).not.toHaveBeenCalled();
    // The builder starts at row 150's spatial-index checkpoint. Ordinary text
    // takes one append per requested row, plus an empty-indent append at each
    // wrap, instead of replaying the preceding 3,000 characters.
    expect(textAppends.calls.count()).toBeLessThan(30);
  });

  it("preserves tabs, invisibles, line endings, paired characters, and soft wraps", () => {
    const buffer = buildBuffer("ab\tcd  \r\n  🐲z\t \nlast");
    const displayLayer = buffer.addDisplayLayer({
      tabLength: 4,
      softWrapColumn: 6,
      softWrapHangingIndent: 1,
      invisibles: { tab: "→", space: "·", cr: "¤", eol: "¬" },
    });

    displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const lineReads = spyOn(buffer, "lineForRow").and.callThrough();
    const sourceReads = spyOn(
      Object.getPrototypeOf(buffer.getTextSnapshot()),
      "slice",
    ).and.callThrough();
    const characterReads = spyOn(buffer, "getCharacterAtPosition").and.callThrough();

    expect(
      displayLayer
        .getScreenLines()
        .map(({ lineText, softWrapIndent }) => ({ lineText, softWrapIndent })),
    ).toEqual([
      { lineText: "ab→ ", softWrapIndent: 1 },
      { lineText: " cd··¤¬", softWrapIndent: -1 },
      { lineText: "··🐲z", softWrapIndent: 3 },
      { lineText: "   →·¬", softWrapIndent: -1 },
      { lineText: "last", softWrapIndent: -1 },
    ]);
    expect(sourceReads.calls.allArgs()).toEqual([
      [0, 7],
      [9, 16],
      [17, 21],
    ]);
    expect(lineReads).not.toHaveBeenCalled();
    expect(characterReads).not.toHaveBeenCalled();
  });

  it("stops bulk text runs at highlighting boundaries", () => {
    const buffer = buildBuffer("abcdefghij");
    buffer.setLanguageMode(
      new TestLanguageMode([
        [
          "outer",
          [
            [0, 2],
            [0, 9],
          ],
        ],
        [
          "inner",
          [
            [0, 4],
            [0, 7],
          ],
        ],
      ]),
    );
    const displayLayer = buffer.addDisplayLayer({ softWrapColumn: 100 });

    expect(tokensForScreenLine(displayLayer, displayLayer.getScreenLine(0))).toEqual([
      { text: "ab", scopes: [] },
      { text: "cd", scopes: ["outer"] },
      { text: "efg", scopes: ["outer", "inner"] },
      { text: "hi", scopes: ["outer"] },
      { text: "j", scopes: [] },
    ]);
  });

  it("reloads a line after edits and when a fold jumps between buffer rows", () => {
    const editedBuffer = buildBuffer("abcdefghij");
    const editedDisplayLayer = editedBuffer.addDisplayLayer({ softWrapColumn: 4 });
    expect(editedDisplayLayer.getScreenLines().map(({ lineText }) => lineText)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);

    editedBuffer.setTextInRange(
      [
        [0, 2],
        [0, 8],
      ],
      "XYZ",
    );
    expect(editedDisplayLayer.getScreenLines().map(({ lineText }) => lineText)).toEqual([
      "abXY",
      "Zij",
    ]);

    const foldedBuffer = buildBuffer("abc\ndef\nghi");
    const foldedDisplayLayer = foldedBuffer.addDisplayLayer({ softWrapColumn: 100 });
    foldedDisplayLayer.foldBufferRange([
      [0, 2],
      [2, 2],
    ]);
    const lineReads = spyOn(foldedBuffer, "lineForRow").and.callThrough();
    const sourceReads = spyOn(
      Object.getPrototypeOf(foldedBuffer.getTextSnapshot()),
      "slice",
    ).and.callThrough();

    expect(foldedDisplayLayer.getScreenLine(0).lineText).toBe("ab⋯i");
    expect(sourceReads.calls.allArgs()).toEqual([
      [0, 3],
      [10, 11],
    ]);
    expect(lineReads).not.toHaveBeenCalled();
  });

  it("starts at an indented soft-wrap checkpoint with the correct open scopes", () => {
    const text = "    alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
    const buffer = buildBuffer(text);
    buffer.setLanguageMode(
      new TestLanguageMode([
        [
          "outer",
          [
            [0, 2],
            [0, text.length - 2],
          ],
        ],
        [
          "inner",
          [
            [0, 24],
            [0, 54],
          ],
        ],
      ]),
    );
    const displayLayer = buffer.addDisplayLayer({
      softWrapColumn: 16,
      softWrapHangingIndent: 3,
    });
    const lineCount = displayLayer.getScreenLineCount();

    expectDirectRangeMatchesFull(displayLayer, lineCount - 3, lineCount);
  });

  it("falls back safely when a cross-row fold precedes the requested checkpoint", () => {
    const buffer = buildBuffer(
      ["PREFIX before folded text", "hidden middle", `${" ".repeat(36)}tail words after fold`].join(
        "\n",
      ),
    );
    const displayLayer = buffer.addDisplayLayer({
      softWrapColumn: 10,
      foldCharacter: "…",
    });
    displayLayer.foldBufferRange([
      [0, 7],
      [2, 0],
    ]);
    const lineCount = displayLayer.getScreenLineCount();

    expectDirectRangeMatchesFull(displayLayer, 2, lineCount);
  });

  it("starts exactly across hard tabs, paired characters, and visible line endings", () => {
    const buffer = buildBuffer(`\talpha\tbeta e\u0301 gamma 🐲 delta epsilon\r\nnext row`);
    const displayLayer = buffer.addDisplayLayer({
      softWrapColumn: 9,
      tabLength: 4,
      invisibles: { tab: "→", cr: "¤", eol: "¬" },
    });
    const lineCount = displayLayer.getScreenLineCount();

    expectDirectRangeMatchesFull(displayLayer, 2, lineCount);
  });

  it("reads only a bounded suffix to render a cold viewport in a long wrapped row", () => {
    const prefixLength = 640_000;
    const buffer = buildBuffer(`${"q".repeat(prefixLength)}xy😀\t  \r\nrest`);
    const layer = buffer.addDisplayLayer({
      softWrapColumn: 64,
      softWrapHangingIndent: 0,
      tabLength: 4,
      invisibles: { tab: "→", space: "·", cr: "¤", eol: "¬" },
    });
    // Populate geometry before measuring the independent presentation read.
    expect(layer.getScreenLineCount()).toBe(10_002);
    spyOn(buffer, "lineForRow").and.throwError("Whole buffer row read");
    const source = buffer.getTextSnapshot();
    const reads = spyOn(Object.getPrototypeOf(source), "slice").and.callThrough();

    const [middleLine] = layer.getScreenLines(5_000, 5_001);
    expect(middleLine.lineText).toBe("q".repeat(64));
    expect(reads).toHaveBeenCalledOnceWith(320_000, 324_096);
    reads.calls.reset();

    const lines = layer.getScreenLines(9_999, 10_001);

    expect(lines.map((line) => line.lineText)).toEqual(["q".repeat(64), "xy😀→   ··¤¬"]);
    expect(reads).toHaveBeenCalledOnceWith(prefixLength - 64, prefixLength + 7);
  });

  it("keeps astral text and tab tokens intact across bounded reads", () => {
    const prefix = "a".repeat(4095);
    const buffer = buildBuffer(`${prefix}😀\tx`);
    const layer = buffer.addDisplayLayer({
      softWrapColumn: 8000,
      tabLength: 4,
      invisibles: { tab: "→" },
    });
    const [line] = layer.getScreenLines(0, 1);
    expect(line.lineText).toBe(`${prefix}😀→  x`);
  });

  it("uses current trailing whitespace across shared source pieces after an edit and undo", () => {
    const length = 200_000;
    const buffer = buildBuffer(`prefix${" ".repeat(length)}\t\r\nlast`);
    const layer = buffer.addDisplayLayer({ softWrapColumn: 64 });
    expect(layer.findTrailingWhitespaceStartColumn(0)).toBe(6);
    buffer.insert([0, length - 50_000], "x");
    expect(layer.findTrailingWhitespaceStartColumn(0)).toBe(length - 49_999);
    buffer.undo();
    expect(layer.findTrailingWhitespaceStartColumn(0)).toBe(6);
  });

  it("ends trailing whitespace styling when a fold moves into the next buffer row", () => {
    const buffer = buildBuffer("a  \n  b");
    const layer = buffer.addDisplayLayer({
      softWrapColumn: 80,
      foldCharacter: "…",
      invisibles: { space: "·" },
    });
    layer.foldBufferRange([
      [0, 2],
      [1, 0],
    ]);
    expect(layer.getScreenLines(0, 1)[0].lineText).toBe("a·…  b");
  });
});

function expectDirectRangeMatchesFull(displayLayer, startRow, endRow) {
  const expected = displayLayer
    .getScreenLines(0, endRow)
    .slice(startRow, endRow)
    .map(normalizeScreenLine);

  displayLayer.cachedScreenLines.length = 0;
  const actual = displayLayer.getScreenLines(startRow, endRow).map(normalizeScreenLine);
  expect(actual).toEqual(expected);
}

function normalizeScreenLine({ lineText, tags, softWrapIndent }) {
  return { lineText, tags: Array.from(tags), softWrapIndent };
}

function tokensForScreenLine(displayLayer, screenLine) {
  const tokens = [];
  const scopes = [];
  let startIndex = 0;

  for (const tag of screenLine.tags) {
    if (displayLayer.isOpenTag(tag)) {
      scopes.push(displayLayer.classNameForTag(tag));
    } else if (displayLayer.isCloseTag(tag)) {
      scopes.pop();
    } else if (tag > 0) {
      const endIndex = startIndex + tag;
      tokens.push({
        text: screenLine.lineText.slice(startIndex, endIndex),
        scopes: scopes.slice(),
      });
      startIndex = endIndex;
    }
  }

  return tokens;
}
