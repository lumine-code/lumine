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
    const prepare = spyOn(actual.buffer.buffer, "prepareEdit").and.callThrough();
    const layout = spyOn(actual.buffer, "updateDisplayLayersForChange").and.callThrough();
    const history = spyOn(actual.buffer.historyProvider, "pushPatch").and.callThrough();
    const applied = [];
    const originalRange = actual.buffer.getRange();
    actual.buffer.onDidApplyChanges((batch) => applied.push(batch));
    actual.buffer.setTextInIndependentRanges(edits);
    scalar(expected.buffer, edits);
    expect(prepare.calls.count()).toBe(1);
    expect(prepare.calls.first().args[0]).toEqual(originalRange);
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

  it("keeps the scalar path for overlapping edits and newly inserted lines", () => {
    for (const first of [
      {
        range: [
          [1, 0],
          [1, 0],
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
      actual.buffer.setTextInIndependentRanges(changes);
      scalar(expected.buffer, changes);
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
    const prepare = spyOn(buffer.buffer, "prepareEdit").and.callThrough();
    buffer.setTextInIndependentRanges(
      Array.from({ length: 64 }, (_, row) => ({
        range: [
          [row, 0],
          [row, 0],
        ],
        text: "# ",
      })),
    );
    expect(prepare.calls.count()).toBe(64);
    expect(buffer.lineForRow(63)).toBe("# row");
    expect(buffer.lineForRow(64)).toBe("row");
  });
});
