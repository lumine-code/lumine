const TextBuffer = require("../src/text-buffer");
const { isWrapBoundary } = require("../src/text-utils");

const MIN_FAST_PATH_LENGTH = 4096;
const SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE = 1 << 0;

describe("DisplayLayer ASCII event scanner", () => {
  it("matches the general loop when tabs cross wrap boundaries and are re-expanded", () => {
    const text = longLineFromRuns(0x7ab5, 12_000, 35, true);
    const params = {
      softWrapColumn: 37,
      softWrapHangingIndent: 5,
      tabLength: 8,
    };

    expectFastPathToMatchGeneral(text, params, "standard", "tab re-expansion");
  });

  it("checkpoints leading-whitespace state across wraps with hanging indentation", () => {
    const text = `${" \t".repeat(7)}${longLineFromRuns(0x1ead, 9000, 80, false)}`;
    const params = {
      softWrapColumn: 13,
      softWrapHangingIndent: 6,
      tabLength: 4,
    };

    const snapshot = expectFastPathToMatchGeneral(text, params, "whitespace", "leading whitespace");
    expect(snapshot.screenLineStartFlags).toContain(SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE);
    expect(snapshot.screenLineStartFlags).toContain(0);
  });

  it("matches the general loop for dense input that falls back after the event probe", () => {
    const text = "a \t-b/c ".repeat(700);
    expectFastPathToMatchGeneral(
      text,
      {
        softWrapColumn: 17,
        softWrapHangingIndent: 3,
        tabLength: 4,
      },
      "standard",
      "dense fallback",
    );
  });

  it("matches systematically for every soft-wrap column in both boundary modes", () => {
    for (let softWrapColumn = 5; softWrapColumn <= 200; softWrapColumn++) {
      for (const mode of ["whitespace", "standard"]) {
        for (let variant = 0; variant < 2; variant++) {
          const seed = softWrapColumn * 1009 + variant * 97 + (mode === "standard" ? 17 : 0);
          const random = randomGenerator(seed);
          const text = longLineFromRuns(
            seed,
            MIN_FAST_PATH_LENGTH + randomInt(random, 0, 1200),
            randomInt(random, 70, 180),
            true,
          );
          const params = {
            softWrapColumn,
            softWrapHangingIndent: randomInt(random, 0, softWrapColumn + 5),
            tabLength: randomInt(random, 1, 8),
          };
          expectFastPathToMatchGeneral(
            text,
            params,
            mode,
            `column ${softWrapColumn}, ${mode}, variant ${variant}`,
          );
        }
      }
    }
  }, 30000);

  it("matches across randomized sparse and dense event distributions", () => {
    const random = randomGenerator(0xe7e175ca);
    for (let caseIndex = 0; caseIndex < 300; caseIndex++) {
      const mode = random() < 0.5 ? "whitespace" : "standard";
      const eventSpacing = random() < 0.25 ? randomInt(random, 3, 12) : randomInt(random, 40, 300);
      const text = longLineFromRuns(
        randomInt(random, 1, 0x7fffffff),
        randomInt(random, MIN_FAST_PATH_LENGTH, 15_000),
        eventSpacing,
        true,
      );
      const softWrapColumn = randomInt(random, 5, 200);
      expectFastPathToMatchGeneral(
        text,
        {
          softWrapColumn,
          softWrapHangingIndent: randomInt(random, 0, softWrapColumn + 5),
          tabLength: randomInt(random, 1, 8),
        },
        mode,
        `random case ${caseIndex}`,
      );
    }
  }, 30000);
});

function expectFastPathToMatchGeneral(text, params, mode, context) {
  const fastSnapshot = layoutSnapshot(text, {
    ...params,
    ...(mode === "standard" ? { isWrapBoundary } : {}),
  });
  const generalSnapshot = layoutSnapshot(text, {
    ...params,
    ratioForCharacter: () => 1,
    isWrapBoundary:
      mode === "standard"
        ? (previousCharacter, character) =>
            (previousCharacter === " " ||
              previousCharacter === "\t" ||
              previousCharacter === "-" ||
              previousCharacter === "/") &&
            character !== " " &&
            character !== "\t"
        : (previousCharacter, character) =>
            (previousCharacter === " " || previousCharacter === "\t") &&
            character !== " " &&
            character !== "\t",
  });

  expect(fastSnapshot).withContext(context).toEqual(generalSnapshot);
  return fastSnapshot;
}

function layoutSnapshot(text, params) {
  const buffer = new TextBuffer({ text });
  try {
    const displayLayer = buffer.addDisplayLayer(params);
    displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const bufferColumns = [
      0,
      1,
      Math.floor(text.length / 4),
      Math.floor(text.length / 2),
      Math.max(0, text.length - 1),
      text.length,
    ];
    return {
      screenLineLengths: displayLayer.screenLineLengths.slice(),
      tabCounts: displayLayer.tabCounts.slice(),
      screenLineStartFlags: displayLayer.screenLineStartFlags.slice(),
      rightmostScreenPosition: pointArray(displayLayer.getRightmostScreenPosition()),
      changes: displayLayer.spatialIndex.getChanges().map(serializeChange),
      translations: bufferColumns.map((column) => {
        const screenPosition = displayLayer.translateBufferPosition([0, column]);
        return {
          bufferColumn: column,
          screenPosition: pointArray(screenPosition),
          roundTrip: pointArray(displayLayer.translateScreenPosition(screenPosition)),
        };
      }),
    };
  } finally {
    buffer.destroy();
  }
}

function serializeChange({ oldStart, oldEnd, newStart, newEnd }) {
  return {
    oldStart: pointArray(oldStart),
    oldEnd: pointArray(oldEnd),
    newStart: pointArray(newStart),
    newEnd: pointArray(newEnd),
  };
}

function pointArray(point) {
  return [point.row, point.column];
}

function longLineFromRuns(seed, targetLength, eventSpacing, includeLeadingWhitespace) {
  const random = randomGenerator(seed);
  let result = includeLeadingWhitespace ? " \t".repeat(randomInt(random, 0, 6)) : "";
  const delimiters = [" ", "\t", "-", "/", " \t", "\t ", "-\t", "\t/", "/word"];
  while (result.length < targetLength) {
    const runLength = Math.min(
      targetLength - result.length,
      Math.max(1, eventSpacing + randomInt(random, -Math.floor(eventSpacing / 3), eventSpacing)),
    );
    const character = String.fromCharCode(97 + randomInt(random, 0, 5));
    result += character.repeat(runLength);
    if (result.length < targetLength) {
      result += delimiters[randomInt(random, 0, delimiters.length - 1)];
    }
  }
  return result.slice(0, targetLength);
}

function randomGenerator(seed) {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function randomInt(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}
