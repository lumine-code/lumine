const Random = require("random-seed");
const TextBuffer = require("../src/text-buffer");
const Range = require("../src/range");

const CASE_COUNT = 500;
const EDIT_COUNT = 2;
const FOLD_CHARACTER = "⋯";
const LINE_CHARACTERS = "abcdefghijklmnop        \t";

describe("DisplayLayer fold cursor", () => {
  it("continues with later folds after a fold jumps to another buffer row", () => {
    const buffer = new TextBuffer({
      text: "zero\talpha beta\none gamma\ntwo\tdelta epsilon\nthree zeta eta\nfour theta",
    });
    const displayLayer = buffer.addDisplayLayer({
      tabLength: 4,
      softWrapColumn: 9,
      softWrapHangingIndent: 2,
      foldCharacter: FOLD_CHARACTER,
      isWrapBoundary: neverWrapBoundary,
    });

    try {
      displayLayer.foldBufferRange([
        [0, 4],
        [2, 3],
      ]);
      displayLayer.foldBufferRange([
        [2, 7],
        [3, 5],
      ]);
      displayLayer.foldBufferRange([
        [3, 8],
        [4, 2],
      ]);

      expectLayoutToMatchFoldedText(displayLayer, "initial");
      buffer.insert([2, 5], "\tX ");
      expectLayoutToMatchFoldedText(displayLayer, "after edit between fold events");
    } finally {
      buffer.destroy();
    }
  });

  it("matches the legacy sparse lookup across randomized wraps, tabs, folds, and edits", () => {
    const random = new Random(0xf01dc0de);

    for (let caseIndex = 0; caseIndex < CASE_COUNT; caseIndex++) {
      const buffer = new TextBuffer({ text: randomBufferText(random) });
      const displayLayer = buffer.addDisplayLayer({
        tabLength: random.intBetween(2, 8),
        softWrapColumn: random.intBetween(5, 40),
        softWrapHangingIndent: 0,
        foldCharacter: FOLD_CHARACTER,
        isWrapBoundary: neverWrapBoundary,
      });

      try {
        addRandomFolds(random, displayLayer);
        expectLayoutToMatchLegacyLookup(displayLayer, `case ${caseIndex}, initial`);

        for (let editIndex = 0; editIndex < EDIT_COUNT; editIndex++) {
          const row = random(buffer.getLineCount());
          const lineLength = buffer.lineLengthForRow(row);
          const startColumn = random.intBetween(1, lineLength);
          const endColumn = Math.min(lineLength, startColumn + random.intBetween(0, 8));
          buffer.setTextInRange(
            [
              [row, startColumn],
              [row, endColumn],
            ],
            randomEditText(random),
          );
          expectLayoutToMatchLegacyLookup(displayLayer, `case ${caseIndex}, edit ${editIndex}`);
        }
      } finally {
        buffer.destroy();
      }
    }
  }, 30000);
});

function neverWrapBoundary() {
  return false;
}

function randomBufferText(random) {
  const rows = new Array(random.intBetween(4, 12));
  for (let row = 0; row < rows.length; row++) {
    const length = random.intBetween(20, 100);
    const characters = new Array(length);
    characters[0] = "a";
    for (let column = 1; column < length; column++) {
      characters[column] = LINE_CHARACTERS[random(LINE_CHARACTERS.length)];
    }
    rows[row] = characters.join("");
  }
  return rows.join("\n");
}

function randomEditText(random) {
  const characters = new Array(random.intBetween(0, 12));
  for (let i = 0; i < characters.length; i++) {
    characters[i] = LINE_CHARACTERS[random(LINE_CHARACTERS.length)];
  }
  return characters.join("");
}

function addRandomFolds(random, displayLayer) {
  const buffer = displayLayer.buffer;
  const bufferLength = buffer.getLength();
  const targetCount = random.intBetween(1, 6);
  let cursor = 0;

  for (let i = 0; i < targetCount && cursor < bufferLength - 1; i++) {
    const startIndex = Math.min(bufferLength - 1, cursor + random.intBetween(0, 12));
    const endIndex = Math.min(
      bufferLength,
      startIndex + random.intBetween(1, Math.min(80, bufferLength - startIndex)),
    );
    displayLayer.foldBufferRange([
      buffer.positionForCharacterIndex(startIndex),
      buffer.positionForCharacterIndex(endIndex),
    ]);
    cursor = endIndex + random.intBetween(0, 12);
  }
}

function expectLayoutToMatchFoldedText(displayLayer, context) {
  const expectedBuffer = new TextBuffer({ text: displayLayer.buffer.getText() });
  const foldedRanges = mergedFoldRanges(displayLayer).reverse();
  for (const range of foldedRanges) expectedBuffer.setTextInRange(range, FOLD_CHARACTER);

  const expected = expectedBuffer.addDisplayLayer({
    tabLength: displayLayer.tabLength,
    softWrapColumn: displayLayer.softWrapColumn,
    softWrapHangingIndent: displayLayer.softWrapHangingIndent,
    foldCharacter: displayLayer.foldCharacter,
    invisibles: displayLayer.invisibles,
    ratioForCharacter: displayLayer.ratioForCharacter,
    isWrapBoundary: displayLayer.isWrapBoundary,
  });

  try {
    expect(layoutSnapshot(displayLayer)).withContext(context).toEqual(layoutSnapshot(expected));
  } finally {
    expectedBuffer.destroy();
  }
}

function expectLayoutToMatchLegacyLookup(displayLayer, context) {
  displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
  expect({
    screenLineLengths: displayLayer.screenLineLengths,
    tabCounts: displayLayer.tabCounts,
    rightmostScreenColumn: displayLayer.rightmostScreenPosition.column,
  })
    .withContext(context)
    .toEqual(legacyLayoutSnapshot(displayLayer));
}

function legacyLayoutSnapshot(displayLayer) {
  // This is the former per-code-unit fold lookup kept as a spec-local oracle.
  // The surrounding layout state machine deliberately follows the production
  // general path so the only independent variable is sparse lookup vs cursor.
  const { buffer } = displayLayer;
  const folds = sparseFoldMap(displayLayer);
  const screenLineLengths = [];
  const tabCounts = [];
  let bufferRow = 0;
  let bufferColumn = 0;
  let unexpandedScreenColumn = 0;
  let expandedScreenColumn = 0;

  while (bufferRow < buffer.getLineCount()) {
    let bufferLine = buffer.lineForRow(bufferRow);
    let bufferLineLength = bufferLine.length;
    let screenLineWidth = 0;
    let firstNonWhitespaceScreenColumn = -1;
    let currentScreenLineTabColumns = [];

    while (bufferColumn <= bufferLineLength) {
      const foldEnd = folds[bufferRow]?.[bufferColumn];
      const previousCharacter = bufferLine[bufferColumn - 1];
      const character = foldEnd ? displayLayer.foldCharacter : bufferLine[bufferColumn];

      if (firstNonWhitespaceScreenColumn < 0 && character !== " " && character !== "\t") {
        firstNonWhitespaceScreenColumn = expandedScreenColumn;
      }

      let characterWidth;
      if (character === "\t") {
        characterWidth = displayLayer.tabLength - (expandedScreenColumn % displayLayer.tabLength);
      } else {
        characterWidth = character ? 1 : 0;
      }

      if (
        screenLineWidth > 0 &&
        characterWidth > 0 &&
        screenLineWidth + characterWidth > displayLayer.softWrapColumn &&
        previousCharacter &&
        character
      ) {
        let indentLength =
          firstNonWhitespaceScreenColumn < displayLayer.softWrapColumn
            ? Math.max(0, firstNonWhitespaceScreenColumn)
            : 0;
        if (indentLength + displayLayer.softWrapHangingIndent < displayLayer.softWrapColumn) {
          indentLength += displayLayer.softWrapHangingIndent;
        }

        screenLineLengths.push(expandedScreenColumn);
        tabCounts.push(currentScreenLineTabColumns.length);
        currentScreenLineTabColumns = [];
        unexpandedScreenColumn = indentLength;
        expandedScreenColumn = indentLength;
        screenLineWidth = indentLength;
      }

      if (foldEnd) {
        unexpandedScreenColumn++;
        expandedScreenColumn++;
        screenLineWidth += characterWidth;
        bufferRow = foldEnd.row;
        bufferColumn = foldEnd.column;
        bufferLine = buffer.lineForRow(bufferRow);
        bufferLineLength = bufferLine.length;
      } else {
        if (character === "\t") {
          currentScreenLineTabColumns.push(unexpandedScreenColumn);
          const distanceToNextTabStop =
            displayLayer.tabLength - (expandedScreenColumn % displayLayer.tabLength);
          expandedScreenColumn += distanceToNextTabStop;
          screenLineWidth += distanceToNextTabStop;
        } else {
          expandedScreenColumn++;
          screenLineWidth += characterWidth;
        }
        unexpandedScreenColumn++;
        bufferColumn++;
      }
    }

    expandedScreenColumn--;
    screenLineLengths.push(expandedScreenColumn);
    tabCounts.push(currentScreenLineTabColumns.length);
    bufferRow++;
    bufferColumn = 0;
    unexpandedScreenColumn = 0;
    expandedScreenColumn = 0;
  }

  return {
    screenLineLengths,
    tabCounts,
    rightmostScreenColumn: Math.max(0, ...screenLineLengths),
  };
}

function sparseFoldMap(displayLayer) {
  const folds = {};
  for (const range of mergedFoldRanges(displayLayer)) {
    if (!folds[range.start.row]) folds[range.start.row] = {};
    folds[range.start.row][range.start.column] = range.end;
  }
  return folds;
}

function mergedFoldRanges(displayLayer) {
  const ranges = displayLayer.foldsMarkerLayer
    .getMarkers()
    .map((marker) => marker.getRange())
    .sort((left, right) => left.start.compare(right.start));
  const result = [];

  for (const range of ranges) {
    const previous = result[result.length - 1];
    if (previous && range.start.compare(previous.end) < 0) {
      result[result.length - 1] = Range(
        previous.start,
        previous.end.compare(range.end) >= 0 ? previous.end : range.end,
      );
    } else {
      result.push(range);
    }
  }

  return result;
}

function layoutSnapshot(displayLayer) {
  displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
  return {
    screenLineLengths: displayLayer.screenLineLengths.slice(),
    tabCounts: displayLayer.tabCounts.slice(),
    rightmostScreenColumn: displayLayer.rightmostScreenPosition.column,
    screenLines: displayLayer
      .getScreenLines()
      .map(({ lineText, softWrapIndent }) => ({ lineText, softWrapIndent })),
  };
}
