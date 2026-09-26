const Random = require("random-seed");
const TextBuffer = require("../src/text-buffer");
const { isWrapBoundary } = require("../src/text-utils");
const TestLanguageMode = require("./text-buffer-helpers/test-language-mode");

const CASE_COUNT = 500;
const SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE = 1 << 0;
const CHARACTERS = "abcdefghijklmnop        \t";

describe("DisplayLayer screen-line start flags", () => {
  it("populates flags on unwrapped, simple ASCII, boundary-event, and general paths", () => {
    expect(flagsFor("x".repeat(5000), { softWrapColumn: Infinity })).toEqual([
      SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE,
    ]);
    expect(flagsFor("x".repeat(5000), { softWrapColumn: 1000 })).toEqual([
      SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE,
      0,
      0,
      0,
      0,
    ]);

    const boundaryFlags = flagsFor("alpha beta gamma delta ".repeat(240), {
      softWrapColumn: 100,
      isWrapBoundary,
    });
    expect(boundaryFlags[0]).toBe(SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE);
    expect(boundaryFlags.slice(1).every((flags) => flags === 0)).toBe(true);

    const whitespaceFlags = flagsFor(" ".repeat(120), { softWrapColumn: 10 });
    expect(
      whitespaceFlags.every((flags) => flags === SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE),
    ).toBe(true);

    const transitioningFlags = flagsFor(`${" ".repeat(30)}${"x".repeat(90)}`, {
      softWrapColumn: 10,
    });
    const firstNonLeadingRow = transitioningFlags.indexOf(0);
    expect(firstNonLeadingRow).toBeGreaterThan(0);
    expect(
      transitioningFlags
        .slice(0, firstNonLeadingRow)
        .every((flags) => flags === SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE),
    ).toBe(true);
    expect(transitioningFlags.slice(firstNonLeadingRow).every((flags) => flags === 0)).toBe(true);
  });

  it("starts exactly after a fold without losing leading-whitespace or open-scope state", () => {
    const text = [
      "PREFIX before folded text",
      "hidden middle",
      `${" ".repeat(36)}tail words after fold`,
    ].join("\n");
    const buffer = new TextBuffer({ text });
    buffer.setLanguageMode(
      new TestLanguageMode([
        [
          "outer",
          [
            [0, 2],
            [2, 58],
          ],
        ],
        [
          "destination",
          [
            [2, 8],
            [2, 48],
          ],
        ],
      ]),
    );
    const displayLayer = buffer.addDisplayLayer({
      softWrapColumn: 10,
      foldCharacter: "…",
      invisibles: { space: "·" },
    });

    try {
      displayLayer.foldBufferRange([
        [0, 7],
        [2, 0],
      ]);
      const lineCount = displayLayer.getScreenLineCount();
      expect(displayLayer.screenLineStartFlags.length).toBe(lineCount);
      expectDirectRangeMatchesFull(displayLayer, 2, lineCount, "cross-row fold");
    } finally {
      buffer.destroy();
    }
  });

  it("shares, copies, clears, and splices flags with the rest of layout state", () => {
    const buffer = new TextBuffer({ text: `${" ".repeat(40)}alpha beta gamma delta` });
    const displayLayer = buffer.addDisplayLayer({ softWrapColumn: 8 });

    try {
      displayLayer.getScreenLineCount();
      const copy = displayLayer.copy();
      expect(copy.screenLineStartFlags).toBe(displayLayer.screenLineStartFlags);

      copy.foldBufferRange([
        [0, 2],
        [0, 12],
      ]);
      expect(copy.screenLineStartFlags).not.toBe(displayLayer.screenLineStartFlags);
      expect(copy.screenLineStartFlags.length).toBe(copy.screenLineLengths.length);

      copy.reset({ softWrapColumn: 6 });
      expect(copy.screenLineStartFlags).toEqual([]);
      copy.getScreenLineCount();
      expect(copy.screenLineStartFlags.length).toBe(copy.screenLineLengths.length);

      buffer.insert([0, 20], " text");
      expect(displayLayer.screenLineStartFlags.length).toBe(displayLayer.screenLineLengths.length);
      expect(copy.screenLineStartFlags.length).toBe(copy.screenLineLengths.length);
    } finally {
      buffer.destroy();
    }
  });

  it("matches full replay across randomized folds, scopes, tabs, invisibles, and edits", () => {
    const random = new Random(0x51a7f1a6);

    for (let caseIndex = 0; caseIndex < CASE_COUNT; caseIndex++) {
      const rows = randomRows(random);
      const text = rows.join("\n");
      const buffer = new TextBuffer({ text });
      const firstFoldStartColumn = random.intBetween(1, rows[0].length - 1);
      const firstFoldEndColumn = random.intBetween(0, Math.min(20, rows[2].length - 1));
      const decorations = [
        [
          "outer",
          [
            [0, 0],
            [3, rows[3].length],
          ],
        ],
        [
          "hidden",
          [
            [1, 0],
            [1, rows[1].length],
          ],
        ],
        [
          "destination",
          [
            [2, firstFoldEndColumn],
            [2, Math.min(rows[2].length, firstFoldEndColumn + 160)],
          ],
        ],
      ];
      buffer.setLanguageMode(new TestLanguageMode(decorations, buffer, random));
      const displayLayer = buffer.addDisplayLayer({
        softWrapColumn: random.intBetween(6, 40),
        softWrapHangingIndent: random.intBetween(0, 4),
        tabLength: random.intBetween(2, 8),
        foldCharacter: "…",
        invisibles: {
          space: random(2) ? "·" : null,
          tab: random(2) ? "→" : null,
          eol: random(2) ? "¬" : null,
        },
      });

      try {
        displayLayer.foldBufferRange([
          [0, firstFoldStartColumn],
          [2, firstFoldEndColumn],
        ]);
        if (rows[2].length - firstFoldEndColumn > 40) {
          displayLayer.foldBufferRange([
            [2, firstFoldEndColumn + 20],
            [3, Math.min(20, rows[3].length)],
          ]);
        }

        expectRandomDirectRangeToMatch(displayLayer, random, `case ${caseIndex}, initial`);

        const lineLength = buffer.lineLengthForRow(2);
        const editStart = random.intBetween(
          Math.min(lineLength, firstFoldEndColumn + 1),
          lineLength,
        );
        const editEnd = Math.min(lineLength, editStart + random.intBetween(0, 12));
        buffer.setTextInRange(
          [
            [2, editStart],
            [2, editEnd],
          ],
          randomFragment(random),
        );
        expectRandomDirectRangeToMatch(displayLayer, random, `case ${caseIndex}, edit`);
      } finally {
        buffer.destroy();
      }
    }
  }, 30000);
});

function randomRows(random) {
  return [
    randomLine(random, random.intBetween(80, 240), random.intBetween(0, 30)),
    randomLine(random, random.intBetween(40, 160), random.intBetween(0, 20)),
    randomLine(random, random.intBetween(320, 900), random.intBetween(0, 100)),
    randomLine(random, random.intBetween(80, 300), random.intBetween(0, 40)),
  ];
}

function flagsFor(text, params) {
  const buffer = new TextBuffer({ text });
  try {
    const displayLayer = buffer.addDisplayLayer(params);
    displayLayer.getScreenLineCount();
    expect(displayLayer.screenLineStartFlags.length).toBe(displayLayer.screenLineLengths.length);
    return displayLayer.screenLineStartFlags.slice();
  } finally {
    buffer.destroy();
  }
}

function randomLine(random, length, leadingWhitespaceLength) {
  const result = new Array(length);
  for (let i = 0; i < length; i++) {
    result[i] =
      i < leadingWhitespaceLength
        ? random(3) === 0
          ? "\t"
          : " "
        : CHARACTERS[random(CHARACTERS.length)];
  }
  return result.join("");
}

function randomFragment(random) {
  const result = new Array(random.intBetween(0, 16));
  for (let i = 0; i < result.length; i++) result[i] = CHARACTERS[random(CHARACTERS.length)];
  return result.join("");
}

function expectRandomDirectRangeToMatch(displayLayer, random, context) {
  const lineCount = displayLayer.getScreenLineCount();
  expect(displayLayer.screenLineStartFlags.length).withContext(context).toBe(lineCount);
  expect(
    displayLayer.screenLineStartFlags.every(
      (flags) => flags === 0 || flags === SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE,
    ),
  )
    .withContext(context)
    .toBe(true);

  if (lineCount < 2) return;
  const startRow = random.intBetween(1, lineCount - 1);
  const endRow = Math.min(lineCount, startRow + random.intBetween(1, 30));
  expectDirectRangeMatchesFull(displayLayer, startRow, endRow, context);
}

function expectDirectRangeMatchesFull(displayLayer, startRow, endRow, context) {
  const expected = displayLayer
    .getScreenLines(0, endRow)
    .slice(startRow, endRow)
    .map(normalizeScreenLine);

  displayLayer.cachedScreenLines.length = 0;
  const actual = displayLayer.getScreenLines(startRow, endRow).map(normalizeScreenLine);
  expect(actual).withContext(context).toEqual(expected);
}

function normalizeScreenLine({ lineText, tags, softWrapIndent }) {
  return { lineText, tags: Array.from(tags), softWrapIndent };
}
