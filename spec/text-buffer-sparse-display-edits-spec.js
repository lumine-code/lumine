const TextBuffer = require("../src/text-buffer");
const Range = require("../src/range");

describe("Sparse independent edits with display geometry", () => {
  const buffers = [];
  afterEach(() => {
    for (const buffer of buffers.splice(0)) buffer.destroy();
  });

  function build(rows = 33000, withDisplay = true) {
    const buffer = new TextBuffer("a\t😀\r\n".repeat(rows - 1) + "a\t😀");
    buffers.push(buffer);
    const display = withDisplay ? buffer.addDisplayLayer({ tabLength: 4 }) : null;
    const layer = buffer.addMarkerLayer({ maintainHistory: true });
    const markers = [
      layer.markRange(
        [
          [0, 0],
          [rows - 1, 4],
        ],
        { invalidate: "never" },
      ),
      layer.markRange(
        [
          [Math.floor(rows / 2), 1],
          [Math.floor(rows / 2), 4],
        ],
        { exclusive: true },
      ),
    ];
    return { buffer, display, markers };
  }

  function sparseEdits(rows, text = "X\nY") {
    return Array.from({ length: 64 }, (_, index) => {
      const row = Math.floor((index * (rows - 1)) / 63);
      return {
        range: [
          [row, 1],
          [row, 1],
        ],
        text,
      };
    });
  }

  function state({ buffer, display, markers }) {
    const count = display?.getScreenLineCount();
    return {
      text: buffer.getText(),
      markers: markers.map((marker) => [marker.getRange().serialize(), marker.isValid()]),
      screenRows: count,
      sampleLines:
        display &&
        [0, Math.floor(count / 2), count - 1].map((row) => {
          const line = display.getScreenLines(row, row + 1)[0];
          return [line.lineText, line.tags];
        }),
    };
  }

  it("avoids a broad rescan while preserving text, markers, granular events and undo/redo", () => {
    const actual = build(),
      expected = build();
    const original = actual.buffer.getText();
    const edits = sparseEdits(33000);
    actual.display.getScreenLineCount();
    expected.display.getScreenLineCount();
    const storage = spyOn(actual.buffer.buffer, "prepareEdits").and.callThrough();
    const display = spyOn(actual.buffer, "updateDisplayLayersForChange").and.callThrough();
    const applied = [];
    actual.buffer.onDidApplyChanges((batch) => applied.push(batch));

    actual.buffer.setTextInIndependentRanges(edits);
    expected.buffer.transact(() => {
      for (const edit of [...edits].reverse())
        expected.buffer.setTextInRange(edit.range, edit.text, { normalizeLineEndings: false });
    });
    expect(storage).not.toHaveBeenCalled();
    expect(display.calls.count()).toBe(64);
    expect(state(actual)).toEqual(state(expected));
    expect(applied.length).toBe(1);
    expect(applied[0].changes.length).toBe(64);
    let replay = original;
    for (const change of applied[0].changes) {
      expect(replay.slice(change.startIndex, change.oldEndIndex)).toBe(change.oldText);
      replay =
        replay.slice(0, change.startIndex) + change.newText + replay.slice(change.oldEndIndex);
    }
    expect(replay).toBe(actual.buffer.getText());

    for (const operation of ["undo", "redo"]) {
      display.calls.reset();
      actual.buffer[operation]();
      expected.buffer[operation]();
      expect(storage).not.toHaveBeenCalled();
      expect(display.calls.count()).toBe(64);
      expect(state(actual)).toEqual(state(expected));
      if (operation === "undo") expect(actual.buffer.getText()).toBe(original);
    }
  });

  it("declines the sparse optimization before preparing storage or notifying will-change", () => {
    const { buffer } = build();
    const original = buffer.getText(),
      revision = buffer.getTextRevision();
    const notify = spyOn(buffer, "emitWillChangeEvent").and.callThrough();
    const storage = spyOn(buffer.buffer, "prepareEdits").and.callThrough();
    const edits = sparseEdits(33000).map((edit) => ({
      ...edit,
      range: Range.fromObject(edit.range),
    }));
    expect(buffer.tryApplyIndependentEdits(edits, true)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(buffer.getText()).toBe(original);
    expect(buffer.getTextRevision()).toBe(revision);
  });

  for (const rows of [12000, 32767, 32768]) {
    it(`uses local display updates only at the large-span boundary (${rows} rows)`, () => {
      const { buffer } = build(rows);
      const storage = spyOn(buffer.buffer, "prepareEdits").and.callThrough();
      buffer.setTextInIndependentRanges(sparseEdits(rows));
      expect(storage.calls.count()).toBe(rows < 32768 ? 1 : 0);
    });
  }

  it("retains storage batching for a large sparse buffer without a display layer", () => {
    const { buffer } = build(33000, false);
    const storage = spyOn(buffer.buffer, "prepareEdits").and.callThrough();
    buffer.setTextInIndependentRanges(sparseEdits(33000));
    expect(storage.calls.count()).toBe(1);
  });

  it("retains storage batching when old multiline ranges densely cover a large span", () => {
    const { buffer } = build();
    const storage = spyOn(buffer.buffer, "prepareEdits").and.callThrough();
    buffer.setTextInIndependentRanges(
      Array.from({ length: 64 }, (_, index) => ({
        range: [
          [index * 512, 0],
          [(index + 1) * 512, 0],
        ],
        text: "replacement\n",
      })),
    );
    expect(storage.calls.count()).toBe(1);
  });

  it("counts inserted multiline text when deciding whether a large batch is sparse", () => {
    const { buffer } = build();
    const storage = spyOn(buffer.buffer, "prepareEdits").and.callThrough();
    buffer.setTextInIndependentRanges(sparseEdits(33000, "new\n".repeat(600)));
    expect(storage.calls.count()).toBe(1);
  });
});
