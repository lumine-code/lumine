const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const Range = require("../src/range");
const { isWrapBoundary } = require("../src/text-utils");

describe("DisplayLayer geometry-preserving replacements", () => {
  const buffers = [];
  const editors = [];

  afterEach(() => {
    while (editors.length > 0) editors.pop().destroy();
    while (buffers.length > 0) buffers.pop().destroy();
  });

  function buildBuffer(text) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return buffer;
  }

  function buildPair(text, params = {}) {
    const buffer = buildBuffer(text);
    const expectedBuffer = buildBuffer(text);
    const actual = buffer.addDisplayLayer(params);
    const boundary = actual.isWrapBoundary;
    // A separate buffer with a delegated predicate always takes the rebuild
    // path, so sharing a layout cannot conceal an incorrect fast-path result.
    const expected = expectedBuffer.addDisplayLayer({
      ...params,
      isWrapBoundary: (previous, character) => boundary(previous, character),
    });
    actual.getScreenLines();
    expected.getScreenLines();
    return { buffer, expectedBuffer, actual, expected };
  }

  const stableCases = [
    { name: "inside a wrap", start: 2, end: 4 },
    { name: "at the beginning of a row", start: 0, end: 2 },
    { name: "ending at an exclusive wrap boundary", start: 2, end: 5 },
    { name: "starting at a wrap boundary", start: 5, end: 7 },
    { name: "crossing several wraps", start: 4, end: 17 },
    { name: "at the final character", start: 24, end: 25 },
  ];

  for (const { name, start, end } of stableCases) {
    it(`preserves geometry and unaffected cached lines ${name}`, () => {
      const pair = buildPair("abcdefghijklmnopqrstuvwxy\ntail", { softWrapColumn: 5 });
      const { actual, buffer, expectedBuffer } = pair;
      const cachedLines = actual.cachedScreenLines.slice();
      const geometry = captureGeometry(actual);
      const firstRow = actual.translateBufferPosition([0, start], { clipDirection: "forward" }).row;
      const lastRow = actual.translateBufferPosition([0, end - 1], {
        clipDirection: "forward",
      }).row;
      const update = spyOn(actual, "updateSpatialIndex").and.callThrough();
      const events = jasmine.createSpy("events");
      actual.onDidChange(events);
      const range = [
        [0, start],
        [0, end],
      ];
      const text = "Z".repeat(end - start);

      buffer.setTextInRange(range, text);
      expectedBuffer.setTextInRange(range, text);

      expect(update).not.toHaveBeenCalled();
      expectGeometryRetained(actual, geometry);
      expect(events).toHaveBeenCalledTimes(1);
      expect(normalizeEvents(events.calls.mostRecent().args[0])).toEqual([
        {
          oldRange: [
            [firstRow, 0],
            [lastRow + 1, 0],
          ],
          newRange: [
            [firstRow, 0],
            [lastRow + 1, 0],
          ],
        },
      ]);
      expectCachedRowsInvalidated(actual, cachedLines, firstRow, lastRow);
      expectEquivalentLayouts(pair.actual, pair.expected);
    });
  }

  it("retains tabs, Unicode neighbors and hanging-indent summaries", () => {
    for (const params of [
      { softWrapColumn: 7, tabLength: 4 },
      { softWrapColumn: 8, softWrapHangingIndent: 2, isWrapBoundary },
      { softWrapColumn: Infinity },
    ]) {
      const pair = buildPair("\tabcdefghijklmnop😀z\tlast\ntail", params);
      const geometry = captureGeometry(pair.actual);
      const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
      pair.buffer.setTextInRange(
        [
          [0, 3],
          [0, 13],
        ],
        "A9_zA9_zA9",
      );
      pair.expectedBuffer.setTextInRange(
        [
          [0, 3],
          [0, 13],
        ],
        "A9_zA9_zA9",
      );
      expect(update).not.toHaveBeenCalled();
      expectGeometryRetained(pair.actual, geometry);
      expectEquivalentLayouts(pair.actual, pair.expected);
    }
  });

  it("lets copies invalidate their own caches while sharing the geometry", () => {
    const pair = buildPair("abcdefghijklmnopqrstuvwxyz\ntail", { softWrapColumn: 5 });
    const copy = pair.actual.copy();
    copy.getScreenLines();
    const cached = [pair.actual.cachedScreenLines.slice(), copy.cachedScreenLines.slice()];
    const updates = [
      spyOn(pair.actual, "updateSpatialIndex").and.callThrough(),
      spyOn(copy, "updateSpatialIndex").and.callThrough(),
    ];
    const events = [jasmine.createSpy("sourceEvents"), jasmine.createSpy("copyEvents")];
    pair.actual.onDidChange(events[0]);
    copy.onDidChange(events[1]);

    pair.buffer.setTextInRange(
      [
        [0, 4],
        [0, 11],
      ],
      "ABC_123",
    );
    pair.expectedBuffer.setTextInRange(
      [
        [0, 4],
        [0, 11],
      ],
      "ABC_123",
    );

    for (const update of updates) expect(update).not.toHaveBeenCalled();
    expect(copy.layoutState).toBe(pair.actual.layoutState);
    expect(copy.cachedScreenLines).not.toBe(pair.actual.cachedScreenLines);
    for (const event of events) expect(event).toHaveBeenCalledTimes(1);
    expect(normalizeEvents(events[0].calls.mostRecent().args[0])).toEqual(
      normalizeEvents(events[1].calls.mostRecent().args[0]),
    );
    expectCachedRowsInvalidated(pair.actual, cached[0], 0, 2);
    expectCachedRowsInvalidated(copy, cached[1], 0, 2);
    expectEquivalentLayouts(pair.actual, pair.expected);
    expectEquivalentLayouts(copy, pair.expected);
  });

  it("preserves transaction aggregation, undo and redo", () => {
    const pair = buildPair("abcdefghijklmnopqrstuvwxyz\ntail", { softWrapColumn: 5 });
    const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
    const events = jasmine.createSpy("events");
    pair.actual.onDidChange(events);
    for (const buffer of [pair.buffer, pair.expectedBuffer]) {
      buffer.transact(() => {
        buffer.setTextInRange(
          [
            [0, 1],
            [0, 3],
          ],
          "AZ",
        );
        buffer.setTextInRange(
          [
            [0, 9],
            [0, 12],
          ],
          "0_9",
        );
      });
    }
    expect(events).toHaveBeenCalledTimes(1);
    expectEquivalentLayouts(pair.actual, pair.expected);
    for (const operation of ["undo", "redo"]) {
      pair.buffer[operation]();
      pair.expectedBuffer[operation]();
      expectEquivalentLayouts(pair.actual, pair.expected);
    }
    expect(update).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledTimes(3);
  });

  const unsafeCases = [
    {
      name: "insertion",
      range: [
        [0, 2],
        [0, 2],
      ],
      text: "z",
    },
    {
      name: "deletion",
      range: [
        [0, 2],
        [0, 3],
      ],
      text: "",
    },
    {
      name: "changed length",
      range: [
        [0, 2],
        [0, 3],
      ],
      text: "zz",
    },
    {
      name: "space",
      range: [
        [0, 2],
        [0, 3],
      ],
      text: " ",
    },
    {
      name: "tab",
      range: [
        [0, 2],
        [0, 3],
      ],
      text: "\t",
    },
    {
      name: "hyphen",
      range: [
        [0, 2],
        [0, 3],
      ],
      text: "-",
    },
    {
      name: "slash",
      range: [
        [0, 2],
        [0, 3],
      ],
      text: "/",
    },
    {
      name: "Unicode",
      range: [
        [0, 2],
        [0, 3],
      ],
      text: "我",
    },
    {
      name: "multiline replacement",
      range: [
        [0, 2],
        [1, 2],
      ],
      text: "ab\ncdefghijklmnopqrstuvwx",
    },
    {
      name: "long replacement",
      range: [
        [0, 0],
        [0, 65],
      ],
      text: "Z".repeat(65),
    },
  ];

  for (const { name, range, text } of unsafeCases) {
    it(`rebuilds for ${name}`, () => {
      const pair = buildPair(`${"a".repeat(70)}\nsecond`, { softWrapColumn: 5 });
      const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
      pair.buffer.setTextInRange(range, text);
      pair.expectedBuffer.setTextInRange(range, text);
      expect(update).toHaveBeenCalled();
      expectEquivalentLayouts(pair.actual, pair.expected);
    });
  }

  it("rebuilds when an edit destroys a fold intersecting the edited row", () => {
    const pair = buildPair("abcdefghijklmnopqrstuvwxyz\ntail", { softWrapColumn: 5 });
    for (const layer of [pair.actual, pair.expected]) {
      layer.foldBufferRange([
        [0, 2],
        [0, 9],
      ]);
      layer.getScreenLines();
    }
    const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
    pair.buffer.setTextInRange(
      [
        [0, 1],
        [0, 10],
      ],
      "Z".repeat(9),
    );
    pair.expectedBuffer.setTextInRange(
      [
        [0, 1],
        [0, 10],
      ],
      "Z".repeat(9),
    );
    expect(pair.actual.foldsMarkerLayer.getMarkers().length).toBe(0);
    expect(update).toHaveBeenCalled();
    expectEquivalentLayouts(pair.actual, pair.expected);
  });

  it("rebuilds for custom character widths or wrap predicates", () => {
    for (const params of [
      { ratioForCharacter: () => 1 },
      { ratioForCharacter: (character) => (character === "Z" ? 2 : 1) },
      { isWrapBoundary: () => false },
    ]) {
      const pair = buildPair("abcdefghijklmnopqrstuvwxyz\ntail", { softWrapColumn: 5, ...params });
      const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
      pair.buffer.setTextInRange(
        [
          [0, 2],
          [0, 4],
        ],
        "ZZ",
      );
      pair.expectedBuffer.setTextInRange(
        [
          [0, 2],
          [0, 4],
        ],
        "ZZ",
      );
      expect(update).toHaveBeenCalled();
      expectEquivalentLayouts(pair.actual, pair.expected);
    }
  });

  it("recognizes only the original bound TextEditor width implementation", () => {
    class CustomWidthEditor extends TextEditor {
      ratioForCharacter() {
        return 2;
      }
    }
    const regular = new TextEditor({ buffer: buildBuffer("abcdefghijklmnop") });
    const custom = new CustomWidthEditor({ buffer: buildBuffer("abcdefghijklmnop") });
    editors.push(regular, custom);
    expect(regular.displayLayer.hasStandardCharacterWidth()).toBe(true);
    expect(regular.displayLayer.copy().hasStandardCharacterWidth()).toBe(true);
    expect(custom.displayLayer.hasStandardCharacterWidth()).toBe(false);
    regular.displayLayer.reset({ softWrapColumn: 5 });
    regular.displayLayer.getScreenLines();
    const update = spyOn(regular.displayLayer, "updateSpatialIndex").and.callThrough();
    regular.buffer.setTextInRange(
      [
        [0, 2],
        [0, 4],
      ],
      "ZZ",
    );
    expect(update).not.toHaveBeenCalled();
    regular.displayLayer.reset({ ratioForCharacter: () => 1 });
    expect(regular.displayLayer.hasStandardCharacterWidth()).toBe(false);

    spyOn(TextEditor.prototype, "ratioForCharacter").and.callThrough();
    const spied = new TextEditor({ buffer: buildBuffer("abcdefghijklmnop") });
    editors.push(spied);
    expect(spied.displayLayer.hasStandardCharacterWidth()).toBe(false);
  });

  it("discards prepared geometry after a reset", () => {
    const pair = buildPair("abcdefghijklmnopqrstuvwxyz\ntail", { softWrapColumn: 5 });
    pair.buffer.onWillChange(() => pair.actual.reset({ softWrapColumn: 7 }));
    pair.expectedBuffer.onWillChange(() => pair.expected.reset({ softWrapColumn: 7 }));
    const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
    pair.buffer.setTextInRange(
      [
        [0, 2],
        [0, 4],
      ],
      "ZZ",
    );
    pair.expectedBuffer.setTextInRange(
      [
        [0, 2],
        [0, 4],
      ],
      "ZZ",
    );
    expect(update).toHaveBeenCalled();
    expectEquivalentLayouts(pair.actual, pair.expected);
  });

  for (const phase of ["will-change", "language mode"]) {
    it(`discards an outer preparation after a reentrant edit in ${phase}`, () => {
      const pair = buildPair("abcdefghijklmnopqrstuvwxyz\nsecond", { softWrapColumn: 5 });
      for (const buffer of [pair.buffer, pair.expectedBuffer]) {
        let nested = false;
        const edit = () => {
          if (nested) return;
          nested = true;
          buffer.setTextInRange(
            [
              [1, 1],
              [1, 3],
            ],
            "ZZ",
          );
        };
        if (phase === "will-change") {
          buffer.onWillChange(edit);
        } else {
          buffer.languageMode.bufferDidChange = edit;
        }
      }
      const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
      pair.buffer.setTextInRange(
        [
          [0, 2],
          [0, 4],
        ],
        "YY",
      );
      pair.expectedBuffer.setTextInRange(
        [
          [0, 2],
          [0, 4],
        ],
        "YY",
      );
      expect(update).toHaveBeenCalled();
      expectEquivalentLayouts(pair.actual, pair.expected);
    });
  }

  for (const synchronous of [true, false]) {
    it(`respects broader ${synchronous ? "synchronous" : "later"} highlighting invalidation`, () => {
      const pair = buildPair("abcdefghijklmnopqrstuvwxyz\ntail", { softWrapColumn: 5 });
      const previousLines = pair.actual.cachedScreenLines.slice();
      const emitHighlighting = (buffer) => {
        buffer.languageMode.emitter.emit(
          "did-change-highlighting",
          Range.fromObject([
            [0, 0],
            [0, 26],
          ]),
        );
      };
      if (synchronous) {
        for (const buffer of [pair.buffer, pair.expectedBuffer]) {
          buffer.languageMode.bufferDidChange = () => emitHighlighting(buffer);
        }
      }
      const update = spyOn(pair.actual, "updateSpatialIndex").and.callThrough();
      pair.buffer.setTextInRange(
        [
          [0, 2],
          [0, 4],
        ],
        "ZZ",
      );
      pair.expectedBuffer.setTextInRange(
        [
          [0, 2],
          [0, 4],
        ],
        "ZZ",
      );
      if (!synchronous) {
        expectCachedRowsInvalidated(pair.actual, previousLines, 0, 0);
        pair.actual.getScreenLines();
        emitHighlighting(pair.buffer);
        emitHighlighting(pair.expectedBuffer);
      }
      expect(update).not.toHaveBeenCalled();
      for (let row = 0; row < previousLines.length - 1; row++) {
        expect(pair.actual.cachedScreenLines[row]).toBeUndefined();
      }
      expect(pair.actual.cachedScreenLines.at(-1)).toBe(previousLines.at(-1));
      expectEquivalentLayouts(pair.actual, pair.expected);
    });
  }
});

function captureGeometry(layer) {
  return {
    layoutState: layer.layoutState,
    spatialIndex: layer.spatialIndex,
    changes: serializeChanges(layer.spatialIndex.getChanges()),
    screenLineLengths: layer.screenLineLengths,
    tabCounts: layer.tabCounts,
    screenLineStartFlags: layer.screenLineStartFlags,
    screenLineBlocks: layer.screenLineBlocks,
    rightmostScreenPosition: layer.rightmostScreenPosition,
    indexedBufferRowCount: layer.indexedBufferRowCount,
  };
}

function expectGeometryRetained(layer, previous) {
  for (const property of [
    "layoutState",
    "spatialIndex",
    "screenLineLengths",
    "tabCounts",
    "screenLineStartFlags",
    "screenLineBlocks",
    "rightmostScreenPosition",
    "indexedBufferRowCount",
  ]) {
    expect(layer[property]).toBe(previous[property]);
  }
  expect(serializeChanges(layer.spatialIndex.getChanges())).toEqual(previous.changes);
}

function expectCachedRowsInvalidated(layer, previous, firstRow, lastRow) {
  expect(layer.cachedScreenLines.length).toBe(previous.length);
  for (let row = 0; row < previous.length; row++) {
    if (row >= firstRow && row <= lastRow) {
      expect(layer.cachedScreenLines[row]).toBeUndefined();
    } else {
      expect(layer.cachedScreenLines[row]).toBe(previous[row]);
      expect(layer.cachedScreenLines[row].id).toBe(previous[row].id);
    }
  }
}

function expectEquivalentLayouts(actual, expected) {
  expect(actual.getScreenLines().map(({ lineText, tags }) => ({ lineText, tags }))).toEqual(
    expected.getScreenLines().map(({ lineText, tags }) => ({ lineText, tags })),
  );
  for (const property of [
    "screenLineLengths",
    "screenLineStartFlags",
    "tabCounts",
    "screenLineBlocks",
  ]) {
    expect(actual[property]).toEqual(expected[property]);
  }
  expect(pointArray(actual.getRightmostScreenPosition())).toEqual(
    pointArray(expected.getRightmostScreenPosition()),
  );
  expect(serializeChanges(actual.spatialIndex.getChanges())).toEqual(
    serializeChanges(expected.spatialIndex.getChanges()),
  );
  for (let row = 0; row < actual.buffer.getLineCount(); row++) {
    for (let column = 0; column <= actual.buffer.lineLengthForRow(row); column++) {
      for (const clipDirection of ["forward", "backward", "closest"]) {
        expect(
          pointArray(actual.translateBufferPosition([row, column], { clipDirection })),
        ).toEqual(pointArray(expected.translateBufferPosition([row, column], { clipDirection })));
      }
    }
  }
  for (let row = 0; row < actual.screenLineLengths.length; row++) {
    for (let column = 0; column <= actual.screenLineLengths[row]; column++) {
      for (const clipDirection of ["forward", "backward", "closest"]) {
        expect(
          pointArray(actual.translateScreenPosition([row, column], { clipDirection })),
        ).toEqual(pointArray(expected.translateScreenPosition([row, column], { clipDirection })));
      }
    }
  }
}

function normalizeEvents(events) {
  return events.map(({ oldRange, newRange }) => ({
    oldRange: [pointArray(oldRange.start), pointArray(oldRange.end)],
    newRange: [pointArray(newRange.start), pointArray(newRange.end)],
  }));
}

function serializeChanges(changes) {
  return changes.map(({ oldStart, oldEnd, newStart, newEnd }) => ({
    oldStart: pointArray(oldStart),
    oldEnd: pointArray(oldEnd),
    newStart: pointArray(newStart),
    newEnd: pointArray(newEnd),
  }));
}

function pointArray({ row, column }) {
  return [row, column];
}
