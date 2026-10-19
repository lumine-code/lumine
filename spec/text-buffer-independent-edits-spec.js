const TextBuffer = require("../src/text-buffer");

describe("Independent line edit batches", () => {
  const buffers = [];
  afterEach(() => {
    for (const buffer of buffers.splice(0)) buffer.destroy();
  });
  const source = Array.from({ length: 128 }, (_, row) => `  row_${row}\t😀ą\r\n`).join("");
  const edits = Array.from({ length: 128 }, (_, row) => ({
    range: [
      [row, row % 3],
      [row, (row % 3) + (row % 2)],
    ],
    text: row % 2 ? "" : "# 😀 ",
  }));
  function build() {
    const buffer = new TextBuffer(source);
    buffers.push(buffer);
    const display = buffer.addDisplayLayer({ softWrapColumn: 12, tabLength: 4 });
    display.getScreenLines();
    const layer = buffer.addMarkerLayer({ maintainHistory: true });
    const markers = [];
    for (const invalidate of ["never", "surround", "overlap", "inside", "touch"]) {
      for (const exclusive of [true, false]) {
        markers.push(
          layer.markRange(
            [
              [0, 0],
              [127, 7],
            ],
            { invalidate, exclusive },
          ),
        );
        markers.push(
          layer.markRange(
            [
              [64, 1],
              [64, 6],
            ],
            { invalidate, exclusive },
          ),
        );
      }
    }
    return { buffer, display, markers };
  }
  function state({ buffer, display, markers }) {
    return {
      text: buffer.getText(),
      modified: buffer.buffer.isModified(),
      markers: markers.map((marker) => [marker.getRange().serialize(), marker.isValid()]),
      lines: display.getScreenLines().map((line) => [line.lineText, line.tags]),
      longest: display.getApproximateRightmostScreenPosition(),
    };
  }
  function scalar(buffer, changes) {
    buffer.transact(() => {
      for (const { range, text } of changes) buffer.setTextInRange(range, text);
    });
  }

  it("commits text and display once while preserving granular events, marker states and undo/redo", () => {
    const actual = build(),
      expected = build();
    const prepare = spyOn(actual.buffer.buffer, "prepareEdits").and.callThrough();
    const layout = spyOn(actual.buffer, "updateDisplayLayersForChange").and.callThrough();
    const history = spyOn(actual.buffer.historyProvider, "pushPatch").and.callThrough();
    const applied = [];
    actual.buffer.onDidApplyChanges((batch) => applied.push(batch));
    actual.buffer.setTextInIndependentRanges(edits);
    scalar(expected.buffer, edits);
    expect(prepare.calls.count()).toBe(1);
    expect(prepare.calls.first().args[0].length).toBe(edits.length);
    expect(layout.calls.count()).toBe(1);
    expect(history.calls.count()).toBe(1);
    expect(state(actual)).toEqual(state(expected));
    expect(applied.length).toBe(1);
    expect(applied[0].changes.length).toBe(edits.length);
    let replay = source;
    for (const change of applied[0].changes) {
      expect(replay.slice(change.startIndex, change.oldEndIndex)).toBe(change.oldText);
      replay =
        replay.slice(0, change.startIndex) + change.newText + replay.slice(change.oldEndIndex);
    }
    expect(replay).toBe(actual.buffer.getText());
    prepare.calls.reset();
    layout.calls.reset();
    history.calls.reset();
    actual.buffer.undo();
    expected.buffer.undo();
    expect(state(actual)).toEqual(state(expected));
    expect(actual.buffer.getText()).toBe(source);
    expect(prepare.calls.count()).toBe(1);
    expect(layout.calls.count()).toBe(1);
    expect(history).not.toHaveBeenCalled();
    prepare.calls.reset();
    layout.calls.reset();
    actual.buffer.redo();
    expected.buffer.redo();
    expect(state(actual)).toEqual(state(expected));
    expect(prepare.calls.count()).toBe(1);
    expect(layout.calls.count()).toBe(1);
    expect(history).not.toHaveBeenCalled();
  });

  it("keeps intermediate text visible to range-tracking callbacks", () => {
    const { buffer } = build();
    const seen = [];
    const tracked = buffer.addMarkerLayer({
      trackRanges(ranges) {
        seen.push(buffer.lineForRow(127));
        return ranges;
      },
    });
    tracked.markRange([
      [0, 0],
      [127, 8],
    ]);
    const prepare = spyOn(buffer.buffer, "prepareEdit").and.callThrough();
    buffer.setTextInIndependentRanges(edits);
    expect(prepare.calls.count()).toBe(edits.length);
    expect(seen[0]).toBe("  row_127\t😀ą");
    expect(seen.at(-1)).toBe(buffer.lineForRow(127));
  });

  it("rejects overlapping rows, fractional columns and inserted line endings before changing text", () => {
    for (const first of [
      {
        range: [
          [0, 0.5],
          [0, 1.5],
        ],
        text: "X",
      },
      {
        range: [
          [1, 1],
          [1, 1],
        ],
        text: "prefix",
      },
      {
        range: [
          [0, 0],
          [0, 0],
        ],
        text: "new\nline\r\n",
      },
    ]) {
      const actual = build(),
        expected = build();
      const changes = [first, ...edits.slice(1)];
      expect(() => actual.buffer.setTextInIndependentRanges(changes)).toThrowError(RangeError);
      expect(state(actual)).toEqual(state(expected));
    }
  });

  it("rolls back the complete batch when a syntax observer throws", () => {
    const actual = build();
    const original = state(actual);
    const failure = new Error("syntax observer failed");
    let calls = 0;
    spyOn(actual.buffer.languageMode, "bufferDidChange").and.callFake(() => {
      if (++calls === 1) throw failure;
    });
    const applied = [];
    actual.buffer.onDidApplyChanges((batch) => applied.push(...batch.changes));
    expect(() => actual.buffer.setTextInIndependentRanges(edits)).toThrow(failure);
    expect(state(actual)).toEqual(original);
    let replay = source;
    for (const change of applied) {
      expect(replay.slice(change.startIndex, change.oldEndIndex)).toBe(change.oldText);
      replay =
        replay.slice(0, change.startIndex) + change.newText + replay.slice(change.oldEndIndex);
    }
    expect(replay).toBe(source);
  });

  it("rechecks marker observers installed by will-change before committing", () => {
    const { buffer } = build();
    const seen = [];
    buffer.onWillChange(() => {
      const layer = buffer.addMarkerLayer({ destroyInvalidatedMarkers: true });
      const marker = layer.markRange(
        [
          [0, 0],
          [0, 4],
        ],
        { invalidate: "touch" },
      );
      marker.onDidDestroy(() => seen.push(buffer.lineForRow(127)));
    });
    const prepare = spyOn(buffer.buffer, "prepareEdit").and.callThrough();
    buffer.setTextInIndependentRanges(edits);
    expect(prepare.calls.count()).toBe(edits.length);
    expect(seen).toEqual(["  row_127\t😀ą"]);
  });

  it("does not rewrite a large document for a small edited region", () => {
    const buffer = new TextBuffer("row\n".repeat(10000));
    buffers.push(buffer);
    const prepare = spyOn(buffer.buffer, "prepareEdits").and.callThrough();
    buffer.setTextInIndependentRanges(
      Array.from({ length: 64 }, (_, row) => ({
        range: [
          [row, 0],
          [row, 0],
        ],
        text: "# ",
      })),
    );
    expect(prepare.calls.count()).toBe(1);
    expect(buffer.lineForRow(63)).toBe("# row");
    expect(buffer.lineForRow(64)).toBe("row");
  });

  it("validates the complete plan and expected revision before any mutation", () => {
    const buffer = new TextBuffer("first\nsecond\nthird");
    buffers.push(buffer);
    const revision = buffer.getTextRevision();
    expect(() =>
      buffer.setTextInIndependentRanges([
        {
          range: [
            [0, 0],
            [0, 1],
          ],
          text: "X",
        },
        {
          range: [
            [1, 0],
            [2, 0],
          ],
          text: "Y",
        },
      ]),
    ).toThrowError(RangeError);
    expect(buffer.getText()).toBe("first\nsecond\nthird");
    buffer.insert([0, 0], "prefix");
    expect(() =>
      buffer.setTextInIndependentRanges(
        [
          {
            range: [
              [0, 0],
              [0, 1],
            ],
            text: "X",
          },
        ],
        { expectedRevision: revision },
      ),
    ).toThrowError(/revision/);
    expect(buffer.getText()).toBe("prefixfirst\nsecond\nthird");
  });

  it("accepts unsorted rows, skips identities and avoids reading the full document", () => {
    const buffer = new TextBuffer("row\n".repeat(1000));
    buffers.push(buffer);
    const read = spyOn(buffer, "getText").and.callThrough();
    const edits = Array.from({ length: 100 }, (_, row) => ({
      range: [
        [row, 0],
        [row, 3],
      ],
      text: `line_${row}`,
    })).reverse();
    expect(buffer.setTextInIndependentRanges(edits)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(buffer.lineForRow(0)).toBe("line_0");
    expect(buffer.lineForRow(99)).toBe("line_99");
    const revision = buffer.getTextRevision();
    expect(
      buffer.setTextInIndependentRanges([
        {
          range: [
            [0, 0],
            [0, 6],
          ],
          text: "line_0",
        },
      ]),
    ).toBe(false);
    expect(buffer.getTextRevision()).toBe(revision);
    buffer.undo();
    expect(buffer.buffer.isModified()).toBe(false);
    expect(buffer.getText()).toBe("row\n".repeat(1000));
  });

  it("batches multiple disjoint changes per row without moving markers in untouched gaps", () => {
    const actual = build(),
      expected = build();
    const planned = Array.from({ length: 128 }, (_, row) => [
      {
        range: [
          [row, 0],
          [row, 0],
        ],
        text: "#",
      },
      {
        range: [
          [row, 2],
          [row, 3],
        ],
        text: "",
      },
      {
        range: [
          [row, 6],
          [row, 7],
        ],
        text: "WORD",
      },
    ]).flat();
    const batches = [];
    actual.buffer.onDidApplyChanges((batch) => batches.push(batch));
    const layout = spyOn(actual.buffer, "updateDisplayLayersForChange").and.callThrough();
    actual.buffer.setTextInIndependentRanges(planned.slice().reverse());
    scalar(expected.buffer, planned.slice().reverse());
    expect(layout.calls.count()).toBe(1);
    expect(state(actual)).toEqual(state(expected));
    let replay = source;
    for (const change of batches[0].changes) {
      expect(replay.slice(change.startIndex, change.oldEndIndex)).toBe(change.oldText);
      replay =
        replay.slice(0, change.startIndex) + change.newText + replay.slice(change.oldEndIndex);
    }
    expect(replay).toBe(actual.buffer.getText());
    for (const operation of ["undo", "redo"]) {
      layout.calls.reset();
      actual.buffer[operation]();
      expected.buffer[operation]();
      expect(state(actual)).toEqual(state(expected));
      expect(layout.calls.count()).toBe(1);
    }
  });

  it("replace-all batches adjacent matches and retains regex substitution semantics", () => {
    for (const replacement of ["$1$1", "", "$&!", "$$", "$`", "$'"]) {
      const text = "abc abc\r\n".repeat(70);
      const buffer = new TextBuffer(text);
      buffers.push(buffer);
      const layout = spyOn(buffer, "updateDisplayLayersForChange").and.callThrough();
      expect(buffer.replace(/(a|b|c)/g, replacement)).toBe(420);
      expect(buffer.getText()).toBe(text.replace(/(a|b|c)/g, replacement));
      if (!replacement.includes("`") && !replacement.includes("'"))
        expect(layout.calls.count()).toBe(1);
      buffer.undo();
      expect(buffer.getText()).toBe(text);
      buffer.redo();
      expect(buffer.getText()).toBe(text.replace(/(a|b|c)/g, replacement));
    }
  });

  it("keeps regex offsets exact inside CRLF, including zero-width matches", () => {
    for (const regex of [/\r/g, /\n/g, /(?<=\r)(?=\n)/g, /(?:)/gu]) {
      for (const replacement of ["", "X", "\n"]) {
        const source = "a😀\r\n\r\nb\r\n".repeat(70);
        const buffer = new TextBuffer(source);
        buffers.push(buffer);
        buffer.replace(regex, replacement);
        expect(buffer.getText())
          .withContext(`${regex} ${JSON.stringify(replacement)}`)
          .toBe(source.replace(regex, replacement));
        buffer.undo();
        expect(buffer.getText()).toBe(source);
        buffer.redo();
        expect(buffer.getText()).toBe(source.replace(regex, replacement));
      }
    }
  });

  it("rejects replace-all called from a will-change observer before preparing a batch", () => {
    const { buffer } = build();
    buffer.onWillChange(() => {
      expect(() => buffer.replace(/row/g, "ROW")).toThrowError(/onWillChange/);
    });
    buffer.setTextInIndependentRanges(edits);
    expect(buffer.getText()).not.toContain("ROW");
  });

  it("synchronizes marker history snapshots requested in the middle of a batch", () => {
    const { buffer, markers } = build();
    const layer = markers[0].layer;
    const snapshots = [];
    let calls = 0;
    spyOn(buffer.languageMode, "bufferDidChange").and.callFake(() => {
      if (++calls % 31 !== 0) return;
      const snapshot = layer.createSnapshot();
      layer.verifyHistorySnapshot(snapshot);
      snapshots.push({
        snapshot,
        ranges: [...snapshot.ranges].map(([id, range]) => [id, { ...range }]),
      });
    });
    buffer.setTextInIndependentRanges(edits);
    for (const { snapshot, ranges } of snapshots) expect([...snapshot.ranges]).toEqual(ranges);
    layer.verifyHistorySnapshot(layer.createSnapshot());
    buffer.undo();
    expect(buffer.getText()).toBe(source);
  });

  it("matches scalar marker affinities for randomized touching edits on one row", () => {
    let seed = 771;
    const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
    for (let trial = 0; trial < 25; trial++) {
      const text = "abcdef ".repeat(110);
      const actual = new TextBuffer(text),
        expected = new TextBuffer(text);
      buffers.push(actual, expected);
      const layers = [actual, expected].map((buffer) =>
        buffer.addMarkerLayer({ maintainHistory: true }),
      );
      for (let i = 0; i < 100; i++) {
        const start = random(700),
          end = start + random(701 - start);
        const options = {
          invalidate: ["never", "touch", "inside", "overlap", "surround"][random(5)],
          exclusive: random(2) === 0,
        };
        for (const layer of layers)
          layer.markRange(
            [
              [0, start],
              [0, end],
            ],
            options,
          );
      }
      const planned = Array.from({ length: 100 }, (_, i) => ({
        range: [
          [0, i * 7],
          [0, i * 7 + random(8)],
        ],
        text: ["", "X", "YYY"][random(3)],
      }));
      actual.setTextInIndependentRanges(planned);
      scalar(expected, planned.slice().reverse());
      const markerState = (layer) =>
        layer.getMarkers().map((marker) => [marker.getRange().serialize(), marker.isValid()]);
      expect(actual.getText()).withContext(`trial ${trial}`).toBe(expected.getText());
      expect(markerState(layers[0])).withContext(`trial ${trial}`).toEqual(markerState(layers[1]));
      actual.undo();
      expected.undo();
      expect(markerState(layers[0])).toEqual(markerState(layers[1]));
      actual.redo();
      expected.redo();
      expect(markerState(layers[0])).toEqual(markerState(layers[1]));
    }
  });

  it("same-row scalar fallback rebases ranges when callbacks need intermediate text", () => {
    const text = "abc def ghi";
    const buffer = new TextBuffer(text);
    buffers.push(buffer);
    buffer.setTextInIndependentRanges([
      {
        range: [
          [0, 8],
          [0, 11],
        ],
        text: "Z",
      },
      {
        range: [
          [0, 0],
          [0, 3],
        ],
        text: "LONGER",
      },
    ]);
    expect(buffer.getText()).toBe("LONGER def Z");
    buffer.undo();
    expect(buffer.getText()).toBe(text);
  });
});
