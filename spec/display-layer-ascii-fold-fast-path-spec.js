const Random = require("random-seed");
const TextBuffer = require("../src/text-buffer");
const Point = require("../src/point");
const { isWrapBoundary: standardWrapBoundary } = require("../src/text-utils");

const RANDOM_CASE_COUNT = 80;
const ASCII_CHARACTERS = ["a", "b", "c", "d", " ", " ", "\t", "-", "/"];
const FOLD_CHARACTERS = ["⋯", "漢", "\u0301"];

describe("DisplayLayer ASCII boundary mode across folds", () => {
  it("matches the general path for focused same-row and cross-row folds", () => {
    const cases = [
      {
        name: "same-row fold between long ASCII spans",
        lines: [longAsciiLine(6000)],
        folds: [
          [
            [0, 1900],
            [0, 3100],
          ],
        ],
        softWrapColumn: 73,
        mode: "standard",
        foldCharacter: "⋯",
        foldWidth: 1,
      },
      {
        name: "multiple same-row folds with tabs and hanging indent",
        lines: [`prefix ${longAsciiLine(7000)}\ttrailer`],
        folds: [
          [
            [0, 1000],
            [0, 1800],
          ],
          [
            [0, 3000],
            [0, 4200],
          ],
        ],
        softWrapColumn: 61,
        softWrapHangingIndent: 3,
        mode: "whitespace",
        foldCharacter: "漢",
        foldWidth: 2,
      },
      {
        name: "cross-row fold into another long ASCII row",
        lines: [longAsciiLine(5000), "hidden", longAsciiLine(6000)],
        folds: [
          [
            [0, 2000],
            [2, 1500],
          ],
        ],
        softWrapColumn: 67,
        mode: "standard",
        foldCharacter: "漢",
        foldWidth: 2,
      },
      {
        name: "cross-row fold into a non-ASCII suffix",
        lines: [longAsciiLine(5000), "hidden", `${longAsciiLine(2000)}漢${longAsciiLine(3000)}`],
        folds: [
          [
            [0, 1500],
            [2, 1000],
          ],
        ],
        softWrapColumn: 79,
        mode: "standard",
        foldCharacter: "⋯",
        foldWidth: 1,
      },
      {
        name: "CJK fold marker at a non-boundary character",
        lines: ["a".repeat(5000)],
        folds: [
          [
            [0, 2000],
            [0, 2400],
          ],
        ],
        softWrapColumn: 43,
        mode: "standard",
        foldCharacter: "漢",
        foldWidth: 2,
      },
      {
        name: "combining fold marker retains pair protection",
        lines: ["a".repeat(5000)],
        folds: [
          [
            [0, 2000],
            [0, 2400],
          ],
        ],
        softWrapColumn: 43,
        mode: "standard",
        foldCharacter: "\u0301",
        foldWidth: 1,
      },
    ];

    for (const testCase of cases) expectCaseToMatchGeneralPath(testCase);
  });

  it("matches the general path across randomized ASCII lines and folds", () => {
    const random = new Random(0xa5c11f0d);

    for (let caseIndex = 0; caseIndex < RANDOM_CASE_COUNT; caseIndex++) {
      const rowCount = random.intBetween(1, 4);
      const lines = new Array(rowCount);
      for (let row = 0; row < rowCount; row++) {
        const length = random.intBetween(4100, 7000);
        const characters = new Array(length);
        for (let column = 0; column < length; column++) {
          characters[column] = ASCII_CHARACTERS[random(ASCII_CHARACTERS.length)];
        }
        if (caseIndex % 7 === 0 && row === rowCount - 1) {
          characters[random.intBetween(1, characters.length - 2)] = "漢";
        }
        lines[row] = characters.join("");
      }

      const folds = [];
      const foldCount = random.intBetween(1, 4);
      for (let i = 0; i < foldCount; i++) {
        const startRow = random.intBetween(0, rowCount - 1);
        const endRow = random.intBetween(startRow, rowCount - 1);
        const startColumn = random.intBetween(0, lines[startRow].length - 1);
        const endColumn =
          endRow === startRow
            ? random.intBetween(startColumn + 1, lines[endRow].length)
            : random.intBetween(0, lines[endRow].length);
        folds.push([
          [startRow, startColumn],
          [endRow, endColumn],
        ]);
      }

      expectCaseToMatchGeneralPath({
        name: `random case ${caseIndex}`,
        lines,
        folds,
        softWrapColumn: random.intBetween(20, 100),
        softWrapHangingIndent: random.intBetween(0, 5),
        tabLength: random.intBetween(2, 8),
        mode: caseIndex % 2 === 0 ? "standard" : "whitespace",
        foldCharacter: FOLD_CHARACTERS[caseIndex % FOLD_CHARACTERS.length],
        foldWidth: caseIndex % FOLD_CHARACTERS.length === 1 ? 2 : 1,
      });
    }
  }, 30000);
});

function expectCaseToMatchGeneralPath(options) {
  const general = createFixture(options, false);
  const optimized = createFixture(options, true);

  try {
    expect(layoutSnapshot(optimized.displayLayer))
      .withContext(options.name)
      .toEqual(layoutSnapshot(general.displayLayer));
  } finally {
    optimized.buffer.destroy();
    general.buffer.destroy();
  }
}

function createFixture(options, useRecognizedBoundary) {
  const buffer = new TextBuffer({ text: options.lines.join("\n") });
  const foldsMarkerLayer = buffer.addMarkerLayer({
    maintainHistory: true,
    persistent: true,
    destroyInvalidatedMarkers: true,
  });
  for (const fold of options.folds) {
    foldsMarkerLayer.markRange(fold, { invalidate: "overlap", exclusive: true });
  }

  const foldCharacter = options.foldCharacter;
  const ratioForCharacter = (character) => (character === foldCharacter ? options.foldWidth : 1);
  const isWrapBoundary = wrapBoundaryForMode(options.mode, useRecognizedBoundary);
  const displayLayer = buffer.addDisplayLayer({
    foldsMarkerLayer,
    softWrapColumn: options.softWrapColumn,
    softWrapHangingIndent: options.softWrapHangingIndent ?? 0,
    tabLength: options.tabLength ?? 4,
    foldCharacter,
    ratioForCharacter,
    isWrapBoundary,
  });

  return { buffer, displayLayer };
}

function wrapBoundaryForMode(mode, useRecognizedBoundary) {
  if (mode === "standard") {
    return useRecognizedBoundary
      ? standardWrapBoundary
      : (previousCharacter, character) => standardWrapBoundary(previousCharacter, character);
  }

  if (useRecognizedBoundary) return undefined;
  return (previousCharacter, character) =>
    (previousCharacter === " " || previousCharacter === "\t") &&
    character !== " " &&
    character !== "\t";
}

function layoutSnapshot(displayLayer) {
  const screenLineCount = displayLayer.getScreenLineCount();
  const screenLines = displayLayer
    .getScreenLines(0, screenLineCount)
    .map(({ lineText, tags, softWrapIndent }) => ({
      lineText,
      tags: Array.from(tags),
      softWrapIndent,
    }));
  const changes = displayLayer.spatialIndex.getChanges().map((change) => ({
    oldStart: plainPoint(change.oldStart),
    oldEnd: plainPoint(change.oldEnd),
    newStart: plainPoint(change.newStart),
    newEnd: plainPoint(change.newEnd),
  }));
  const translations = [];
  const rowStep = Math.max(1, Math.floor(screenLineCount / 17));
  for (let row = 0; row < screenLineCount; row += rowStep) {
    const lineLength = displayLayer.screenLineLengths[row];
    for (const column of [0, Math.floor(lineLength / 2), lineLength]) {
      const screenPosition = Point(row, column);
      const bufferPosition = displayLayer.translateScreenPosition(screenPosition);
      translations.push({
        screenPosition: plainPoint(screenPosition),
        bufferPosition: plainPoint(bufferPosition),
        roundTrip: plainPoint(displayLayer.translateBufferPosition(bufferPosition)),
      });
    }
  }

  return {
    screenLineLengths: displayLayer.screenLineLengths.slice(),
    tabCounts: displayLayer.tabCounts.slice(),
    rightmostScreenPosition: plainPoint(displayLayer.getRightmostScreenPosition()),
    screenLines,
    changes,
    translations,
  };
}

function plainPoint(point) {
  return { row: point.row, column: point.column };
}

function longAsciiLine(length) {
  return "alpha beta-gamma/delta ".repeat(Math.ceil(length / 23)).slice(0, length);
}
