const TextBuffer = require("../src/text-buffer");
const {
  isWrapBoundary,
  isDoubleWidthCharacter,
  isHalfWidthCharacter,
  isKoreanCharacter,
} = require("../src/text-utils");

describe("DisplayLayer mixed Unicode line fast paths", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length > 0) buffers.pop().destroy();
  });

  function createBuffer(text) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return buffer;
  }

  function buildPair(text, params = {}, { ratio, trustedWidth = true } = {}) {
    const buffer = createBuffer(text);
    const expectedBuffer = createBuffer(text);
    const actual = buffer.addDisplayLayer({
      ...params,
      ...(ratio ? { ratioForCharacter: ratio } : {}),
      ...(ratio && trustedWidth ? { standardRatioForCharacter: ratio } : {}),
    });
    const expected = expectedBuffer.addDisplayLayer({
      ...params,
      ratioForCharacter: (character) => actual.ratioForCharacter(character),
      standardRatioForCharacter: null,
      isWrapBoundary: (previous, character) => actual.isWrapBoundary(previous, character),
    });
    return { buffer, expectedBuffer, actual, expected };
  }

  function expectEquivalentLayouts(pair, context) {
    expect(layoutSnapshot(pair.actual)).withContext(context).toEqual(layoutSnapshot(pair.expected));
  }

  it("preserves paired characters at the ends of long ASCII runs", () => {
    const text =
      `${"a".repeat(79)}e\u0301${"b".repeat(77)}x\ufe0f` +
      `${"c".repeat(77)}\ud83d\udc09${"d".repeat(78)}漢かな한Ａｶ` +
      `${"e".repeat(4300)}\ud800x\udc00tail`;

    for (const softWrapColumn of [1, 13, 80, 500]) {
      for (const boundary of [undefined, isWrapBoundary]) {
        const pair = buildPair(text, { softWrapColumn, isWrapBoundary: boundary });
        expectEquivalentLayouts(pair, `paired characters, column ${softWrapColumn}`);
      }
    }
  });

  it("preserves non-unit and fractional Unicode widths beside ASCII runs", () => {
    const text =
      ` \t${"a".repeat(149)}漢${"b".repeat(151)}ｶ${"c".repeat(147)}한` +
      `${"d".repeat(153)}かなＡ${"e".repeat(177)}\tword-/` +
      `${"f".repeat(149)}e\u0301x\ufe0f\ud83d\udc09`.repeat(24);

    for (const widths of [
      { double: 2, half: 1, korean: 2 },
      { double: 1.75, half: 0.5, korean: 2.25 },
    ]) {
      for (const softWrapColumn of [37, 80, 80.5]) {
        for (const boundary of [undefined, isWrapBoundary]) {
          const pair = buildPair(
            text,
            {
              softWrapColumn,
              softWrapHangingIndent: 3,
              tabLength: 8,
              isWrapBoundary: boundary,
            },
            { ratio: standardWidthProvider(widths) },
          );
          expectEquivalentLayouts(pair, `Unicode widths, column ${softWrapColumn}`);
        }
      }
    }
  });

  it("preserves dense Unicode, tab, and wrap-boundary distributions", () => {
    const text = "a\u0301漢\ud83d\udc09 x\ufe0f/\t한-".repeat(500);
    const pair = buildPair(
      text,
      { softWrapColumn: 17, softWrapHangingIndent: 4, tabLength: 4, isWrapBoundary },
      { ratio: standardWidthProvider({ double: 2, half: 0.5, korean: 1.5 }) },
    );
    expectEquivalentLayouts(pair, "dense events");
  });

  it("rejects dense dash and slash events even with the whitespace-only wrap predicate", () => {
    const text = `漢${"abc-/".repeat(1000)}`;
    let widthCalls = 0;
    const ratio = () => {
      widthCalls++;
      return 1;
    };
    const pair = buildPair(text, { softWrapColumn: 79 }, { ratio });

    pair.actual.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const actualWidthCalls = widthCalls;
    widthCalls = 0;
    pair.expected.populateSpatialIndexIfNeeded(Infinity, Infinity);
    expect(actualWidthCalls).toBeGreaterThanOrEqual(text.length);
    expect(actualWidthCalls).toBe(widthCalls);
    expectEquivalentLayouts(pair, "dense punctuation in whitespace-boundary mode");
  });

  it("stops ASCII runs at folds and reclassifies the visible suffix after cross-row folds", () => {
    for (const foldCharacter of ["漢", "\u0301"]) {
      const text = [
        `${"a".repeat(1300)}漢${"b".repeat(4300)}`,
        "hidden row",
        `${"c".repeat(1200)}e\u0301\t${"d".repeat(4300)}`,
        "hidden row",
        "漢x",
      ].join("\n");
      const pair = buildPair(
        text,
        {
          softWrapColumn: 79,
          softWrapHangingIndent: 2,
          tabLength: 8,
          foldCharacter,
          isWrapBoundary,
        },
        { ratio: standardWidthProvider() },
      );
      const ranges = [
        [
          [0, 700],
          [0, 1000],
        ],
        [
          [0, 2800],
          [2, 700],
        ],
        [
          [2, 3200],
          [4, 1],
        ],
      ];
      for (const range of ranges) {
        pair.actual.foldBufferRange(range);
        pair.expected.foldBufferRange(range);
      }
      expectEquivalentLayouts(pair, `fold marker ${JSON.stringify(foldCharacter)}`);
      pair.actual.destroyAllFolds();
      pair.expected.destroyAllFolds();
      expectEquivalentLayouts(pair, "unfolded");
    }
  });

  it("retains scalar evaluation for custom width and wrap callbacks", () => {
    const text = `漢${"a".repeat(4300)}q${"b".repeat(500)}\u0301tail`;
    let widthCalls = 0;
    let boundaryCalls = 0;
    const ratio = (character) => {
      widthCalls++;
      return character === "a" ? 1.5 : 1;
    };
    const customBoundary = (previous, character) => {
      boundaryCalls++;
      return character === "q" || isWrapBoundary(previous, character);
    };
    const pair = buildPair(
      text,
      { softWrapColumn: 79, isWrapBoundary: customBoundary },
      { ratio, trustedWidth: false },
    );
    pair.actual.populateSpatialIndexIfNeeded(Infinity, Infinity);
    expect(widthCalls).toBeGreaterThanOrEqual(text.length);
    expect(boundaryCalls).toBe(text.length - 1);
    expectEquivalentLayouts(pair, "custom callbacks");
  });

  it("preserves Unicode line metrics with wrapping disabled", () => {
    const text = [
      `漢한ｶ${"a".repeat(4103)}\t\ud83d\udc09e\u0301\tend`,
      "\tＡかなx\ufe0f\t",
      "",
    ].join("\n");
    let widthCalls = 0;
    const width = standardWidthProvider({ double: 1.75, half: 0.5, korean: 2.25 });
    const ratio = (character) => {
      widthCalls++;
      return width(character);
    };
    const pair = buildPair(
      text,
      { softWrapColumn: Infinity, tabLength: 8, isWrapBoundary },
      { ratio },
    );
    pair.actual.populateSpatialIndexIfNeeded(Infinity, Infinity);
    expect(widthCalls).toBe(0);
    expectEquivalentLayouts(pair, "unwrapped Unicode");
  });

  it("keeps independent run scans when a Unicode width callback indexes another layer", () => {
    const nestedBuffer = createBuffer(`漢${"nested-word/".repeat(500)}\ttail`);
    const nested = nestedBuffer.addDisplayLayer({ softWrapColumn: 43, isWrapBoundary });
    const text = `${"a".repeat(1700)}漢${"b".repeat(1700)}\t${"c".repeat(1700)}tail`;
    const width = standardWidthProvider();
    let enteredNestedLayer = false;
    const ratio = (character) => {
      if (character === "漢" && !enteredNestedLayer) {
        enteredNestedLayer = true;
        nested.populateSpatialIndexIfNeeded(Infinity, Infinity);
      }
      return width(character);
    };
    const pair = buildPair(text, { softWrapColumn: 79, isWrapBoundary }, { ratio });
    expectEquivalentLayouts(pair, "reentrant layout");
    expect(enteredNestedLayer).toBe(true);
    expect(nested.getScreenLineCount()).toBeGreaterThan(1);
  });

  it("rebuilds mixed lines correctly after Unicode insertions, removals, undo, and redo", () => {
    const text = `漢${"word-".repeat(1100)}\ttail`;
    const pair = buildPair(
      text,
      { softWrapColumn: 79, softWrapHangingIndent: 3, isWrapBoundary },
      { ratio: standardWidthProvider() },
    );
    expectEquivalentLayouts(pair, "initial layout");
    for (const buffer of [pair.buffer, pair.expectedBuffer]) {
      buffer.insert([0, 1000], "e\u0301漢\ud83d\udc09\t");
    }
    expectEquivalentLayouts(pair, "inserted Unicode");
    for (const buffer of [pair.buffer, pair.expectedBuffer]) {
      buffer.delete([
        [0, 995],
        [0, 1020],
      ]);
    }
    expectEquivalentLayouts(pair, "deleted Unicode");
    for (const buffer of [pair.buffer, pair.expectedBuffer]) buffer.undo();
    expectEquivalentLayouts(pair, "undo");
    for (const buffer of [pair.buffer, pair.expectedBuffer]) buffer.redo();
    expectEquivalentLayouts(pair, "redo");
  });
});

function standardWidthProvider({ double = 2, half = 1, korean = 2 } = {}) {
  return (character) => {
    if (isKoreanCharacter(character)) return korean;
    if (isHalfWidthCharacter(character)) return half;
    if (isDoubleWidthCharacter(character)) return double;
    return 1;
  };
}

function layoutSnapshot(displayLayer) {
  displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
  const screenLineCount = displayLayer.getScreenLineCount();
  const buffer = displayLayer.buffer;
  const bufferTranslations = [];
  for (let row = 0; row < buffer.getLineCount(); row++) {
    const line = buffer.lineForRow(row);
    const columns = new Set([0, 1, Math.floor(line.length / 2), line.length]);
    for (let column = 0; column < line.length; column++) {
      if (line.charCodeAt(column) > 127 || line[column] === "\t") {
        for (let offset = -1; offset <= 2; offset++) {
          columns.add(Math.max(0, Math.min(line.length, column + offset)));
        }
      }
    }
    for (const column of columns) {
      for (const clipDirection of ["backward", "forward", "closest"]) {
        const screenPosition = displayLayer.translateBufferPosition([row, column], {
          clipDirection,
        });
        bufferTranslations.push({
          bufferPosition: [row, column],
          clipDirection,
          screenPosition: plainPoint(screenPosition),
          roundTrip: plainPoint(
            displayLayer.translateScreenPosition(screenPosition, { clipDirection }),
          ),
        });
      }
    }
  }
  const screenTranslations = [];
  const rowStep = Math.max(1, Math.floor(screenLineCount / 19));
  for (let row = 0; row < screenLineCount; row += rowStep) {
    const length = displayLayer.screenLineLengths[row];
    for (const column of [0, 1, Math.floor(length / 2), length]) {
      screenTranslations.push({
        screenPosition: [row, column],
        bufferPosition: plainPoint(displayLayer.translateScreenPosition([row, column])),
      });
    }
  }
  return {
    screenLineLengths: displayLayer.screenLineLengths.slice(),
    tabCounts: displayLayer.tabCounts.slice(),
    screenLineStartFlags: displayLayer.screenLineStartFlags.slice(),
    rightmostScreenPosition: plainPoint(displayLayer.getRightmostScreenPosition()),
    screenLines: displayLayer
      .getScreenLines(0, screenLineCount)
      .map(({ lineText, tags, softWrapIndent }) => ({
        lineText,
        tags: Array.from(tags),
        softWrapIndent,
      })),
    changes: displayLayer.spatialIndex
      .getChanges()
      .map(({ oldStart, oldEnd, newStart, newEnd }) => ({
        oldStart: plainPoint(oldStart),
        oldEnd: plainPoint(oldEnd),
        newStart: plainPoint(newStart),
        newEnd: plainPoint(newEnd),
      })),
    bufferTranslations,
    screenTranslations,
  };
}

function plainPoint(point) {
  return [point.row, point.column];
}
