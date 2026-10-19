const TextBuffer = require("../src/text-buffer");
const MarkerLayer = require("../src/marker-layer");

describe("Independent multiline edits", () => {
  const buffers = [];
  afterEach(() => {
    for (const buffer of buffers.splice(0)) buffer.destroy();
  });
  function build(text) {
    const buffer = new TextBuffer(text);
    buffers.push(buffer);
    const display = buffer.addDisplayLayer({ softWrapColumn: 14, tabLength: 4 });
    display.getScreenLines();
    const layer = buffer.addMarkerLayer({ maintainHistory: true });
    for (let row = 0; row < buffer.getLastRow() - 2; row += 3)
      for (const invalidate of ["never", "touch", "inside", "overlap", "surround"])
        for (const exclusive of [false, true])
          layer.markRange(
            [
              [row, 2],
              [row + 2, 4],
            ],
            { invalidate, exclusive },
          );
    buffer.clearUndoStack();
    return { buffer, display, layer };
  }
  const state = ({ buffer, display, layer }) => ({
    text: buffer.getText(),
    modified: buffer.buffer.isModified(),
    lines: display.getScreenLines().map((line) => [line.lineText, line.tags]),
    markers: layer.getMarkers().map((marker) => [marker.getRange().serialize(), marker.isValid()]),
  });
  function applyScalar(buffer, edits) {
    const source = buffer.getTextSnapshot();
    const planned = edits.map(({ range, text }) => ({
      start: source.offsetAt({ row: range[0][0], column: range[0][1] }),
      end: source.offsetAt({ row: range[1][0], column: range[1][1] }),
      text,
    }));
    buffer.transact(() => {
      let delta = 0;
      for (const { start, end, text } of planned) {
        const snapshot = buffer.getTextSnapshot();
        buffer.setTextInRange(
          [snapshot.positionAt(start + delta), snapshot.positionAt(end + delta)],
          text,
          { normalizeLineEndings: false },
        );
        delta += text.length - end + start;
      }
    });
  }
  for (const count of [3, 128]) {
    for (const ending of ["\n", "\r\n"]) {
      it(`preserves markers, layout, granular replay and history for ${count} edits with ${JSON.stringify(ending)}`, () => {
        const source = `first 😀${ending}\tsecond${ending}third 終${ending}gap${ending}`.repeat(
          count,
        );
        const edits = Array.from({ length: count }, (_, i) => ({
          range:
            i % 3 === 0
              ? [
                  [i * 4, 1],
                  [i * 4 + 2, 3],
                ]
              : [
                  [i * 4, 1],
                  [i * 4, 3],
                ],
          text:
            i % 3 === 1 ? `new😀${ending}middle${ending}end` : i % 3 === 2 ? "" : `new${ending}end`,
        }));
        const actual = build(source),
          expected = build(source),
          original = state(actual);
        const layout = spyOn(actual.buffer, "updateDisplayLayersForChange").and.callThrough();
        const events = [];
        actual.buffer.onDidApplyChanges((batch) => events.push(...batch.changes));
        actual.buffer.setTextInIndependentRanges(edits.slice().reverse());
        applyScalar(expected.buffer, edits);
        expect(state(actual)).toEqual(state(expected));
        if (count >= 64) expect(layout.calls.count()).toBe(1);
        let replay = source;
        for (const event of events) {
          expect(replay.slice(event.startIndex, event.oldEndIndex)).toBe(event.oldText);
          replay =
            replay.slice(0, event.startIndex) + event.newText + replay.slice(event.oldEndIndex);
        }
        expect(replay).toBe(actual.buffer.getText());
        const changed = state(actual);
        layout.calls.reset();
        actual.buffer.undo();
        expect(state(actual)).toEqual(original);
        if (count >= 64) expect(layout.calls.count()).toBe(1);
        actual.buffer.redo();
        expect(state(actual)).toEqual(changed);
        const shadow = MarkerLayer.materializeSnapshot(actual.layer.createSnapshot());
        const eager = actual.layer.createEagerSnapshot();
        for (const id of Object.keys(eager)) expect(shadow[id].range).toEqual(eager[id].range);
      });
    }
  }

  it("normalizes against original rows only when explicitly requested", () => {
    const literal = new TextBuffer("a\r\nb\nc"),
      normalized = new TextBuffer("a\r\nb\nc");
    buffers.push(literal, normalized);
    const edits = [
      {
        range: [
          [0, 0],
          [0, 1],
        ],
        text: "X\nY",
      },
      {
        range: [
          [1, 0],
          [1, 1],
        ],
        text: "Z\r\nW",
      },
    ];
    literal.setTextInIndependentRanges(edits);
    normalized.setTextInIndependentRanges(edits, { normalizeLineEndings: true });
    expect(literal.getText()).toBe("X\nY\r\nZ\r\nW\nc");
    expect(normalized.getText()).toBe("X\r\nY\r\nZ\nW\nc");
  });

  it("rolls back all multiline changes when syntax notification fails", () => {
    const source = "first\r\nsecond\r\nthird\r\n".repeat(80);
    const actual = build(source),
      before = state(actual);
    let notified = false;
    spyOn(actual.buffer.languageMode, "bufferDidChange").and.callFake(() => {
      if (!notified) {
        notified = true;
        throw new Error("syntax failed");
      }
    });
    const events = [];
    actual.buffer.onDidApplyChanges((batch) => events.push(...batch.changes));
    expect(() =>
      actual.buffer.setTextInIndependentRanges(
        Array.from({ length: 80 }, (_, i) => ({
          range: [
            [i * 3, 1],
            [i * 3 + 1, 2],
          ],
          text: "a\nb\nc",
        })),
      ),
    ).toThrowError("syntax failed");
    expect(state(actual)).toEqual(before);
    let replay = source;
    for (const event of events) {
      expect(replay.slice(event.startIndex, event.oldEndIndex)).toBe(event.oldText);
      replay = replay.slice(0, event.startIndex) + event.newText + replay.slice(event.oldEndIndex);
    }
    expect(replay).toBe(source);
  });

  for (const count of [2, 128]) {
    it(`retains original offsets when ${count} adjacent edits form and split CRLF`, () => {
      const buffer = new TextBuffer("x\ny\n".repeat(count));
      buffers.push(buffer);
      const edits = Array.from({ length: count }, (_, i) => [
        {
          range: [
            [i * 2, 0],
            [i * 2, 1],
          ],
          text: "\r",
        },
        {
          range: [
            [i * 2, 1],
            [i * 2 + 1, 0],
          ],
          text: "\nZ",
        },
      ]).flat();
      buffer.setTextInIndependentRanges(edits);
      expect(buffer.getText()).toBe("\r\nZy\n".repeat(count));
      buffer.undo();
      expect(buffer.getText()).toBe("x\ny\n".repeat(count));
      buffer.redo();
      expect(buffer.getText()).toBe("\r\nZy\n".repeat(count));
    });
  }
});
