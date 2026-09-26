const Random = require("random-seed");
const TextBuffer = require("../src/text-buffer");
const { isWrapBoundary } = require("../src/text-utils");

const CASE_COUNT = 500;
const EDIT_COUNT = 2;
const INITIAL_WHITESPACE_CHARACTERS = "abcdefghijklmnop";
const INITIAL_STANDARD_CHARACTERS = INITIAL_WHITESPACE_CHARACTERS + "-/";
const WHITESPACE_CHARACTERS = "abcdefghijklmnop      ";
const STANDARD_CHARACTERS = WHITESPACE_CHARACTERS + "---///";

describe("DisplayLayer ASCII boundary fast path", () => {
  it("matches the general path across randomized word boundaries and edits", () => {
    const random = new Random(0x5eedba11);

    for (let caseIndex = 0; caseIndex < CASE_COUNT; caseIndex++) {
      const boundaryMode = caseIndex % 2 === 0 ? "whitespace" : "standard";
      const characters =
        boundaryMode === "whitespace" ? WHITESPACE_CHARACTERS : STANDARD_CHARACTERS;
      const initialCharacters =
        boundaryMode === "whitespace" ? INITIAL_WHITESPACE_CHARACTERS : INITIAL_STANDARD_CHARACTERS;
      const text = randomLine(random, random.intBetween(4300, 6200), characters, initialCharacters);
      const softWrapColumn = random.intBetween(8, 200);
      const actualBuffer = new TextBuffer({ text });
      const expectedBuffer = new TextBuffer({ text });
      const actual = actualBuffer.addDisplayLayer({
        softWrapColumn,
        softWrapHangingIndent: 0,
        isWrapBoundary: boundaryMode === "standard" ? isWrapBoundary : undefined,
      });
      const expected = expectedBuffer.addDisplayLayer({
        softWrapColumn,
        softWrapHangingIndent: 0,
        // A behaviorally-equivalent callback with a different identity keeps
        // the reference layer on the fully-general character loop.
        isWrapBoundary:
          boundaryMode === "standard" ? delegatedStandardBoundary : delegatedWhitespaceBoundary,
      });

      try {
        expectLayoutToMatch(actual, expected, `case ${caseIndex}, initial`);

        for (let editIndex = 0; editIndex < EDIT_COUNT; editIndex++) {
          const lineLength = actualBuffer.lineLengthForRow(0);
          const startColumn = random.intBetween(1, lineLength - 1);
          const endColumn = Math.min(
            lineLength,
            startColumn + random.intBetween(0, Math.min(8, lineLength - startColumn)),
          );
          const insertedText = randomFragment(random, random.intBetween(0, 8), characters);
          const range = [
            [0, startColumn],
            [0, endColumn],
          ];

          actualBuffer.setTextInRange(range, insertedText);
          expectedBuffer.setTextInRange(range, insertedText);
          expectLayoutToMatch(actual, expected, `case ${caseIndex}, edit ${editIndex}`);
        }
      } finally {
        actualBuffer.destroy();
        expectedBuffer.destroy();
      }
    }
  }, 30000);
});

function delegatedWhitespaceBoundary(previousCharacter, character) {
  return (
    (previousCharacter === " " || previousCharacter === "\t") &&
    character !== " " &&
    character !== "\t"
  );
}

function delegatedStandardBoundary(previousCharacter, character) {
  return isWrapBoundary(previousCharacter, character);
}

function randomLine(random, length, characters, initialCharacters) {
  const result = new Array(length);
  // The fast path deliberately excludes leading whitespace. Keep the first
  // code unit ordinary while allowing every boundary shape thereafter.
  result[0] = initialCharacters[random(initialCharacters.length)];
  for (let i = 1; i < length; i++) result[i] = characters[random(characters.length)];
  return result.join("");
}

function randomFragment(random, length, characters) {
  const result = new Array(length);
  for (let i = 0; i < length; i++) result[i] = characters[random(characters.length)];
  return result.join("");
}

function expectLayoutToMatch(actual, expected, context) {
  const lineLength = actual.buffer.lineLengthForRow(0);
  const bufferColumns = [
    0,
    1,
    Math.floor(lineLength / 4),
    Math.floor(lineLength / 2),
    Math.floor((lineLength * 3) / 4),
    lineLength,
  ];

  expect(layoutSnapshot(actual, bufferColumns))
    .withContext(context)
    .toEqual(layoutSnapshot(expected, bufferColumns));
}

function layoutSnapshot(displayLayer, bufferColumns) {
  displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
  const screenLineCount = displayLayer.screenLineLengths.length;
  const sampledScreenRows = Array.from(
    new Set([0, Math.floor(screenLineCount / 2), screenLineCount - 1]),
  );

  return {
    screenLineLengths: displayLayer.screenLineLengths.slice(),
    tabCounts: displayLayer.tabCounts.slice(),
    rightmostScreenPosition: pointArray(displayLayer.rightmostScreenPosition),
    spatialChanges: displayLayer.spatialIndex
      .getChanges()
      .map((change) => [
        ...pointArray(change.oldStart),
        ...pointArray(change.oldEnd),
        ...pointArray(change.newStart),
        ...pointArray(change.newEnd),
      ]),
    translatedPositions: bufferColumns.map((column) => {
      const screenPosition = displayLayer.translateBufferPosition([0, column]);
      return [
        ...pointArray(screenPosition),
        ...pointArray(displayLayer.translateScreenPosition(screenPosition)),
      ];
    }),
    sampledScreenLines: sampledScreenRows.map((row) => {
      const { lineText, tags, softWrapIndent } = displayLayer.getScreenLine(row);
      return { lineText, tags, softWrapIndent };
    }),
  };
}

function pointArray(point) {
  return [point.row, point.column];
}
