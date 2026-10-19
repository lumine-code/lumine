const MarkerLayer = require("../src/marker-layer");

describe("Multicursor history batching", () => {
  const editors = [];
  afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
  });
  async function build() {
    const editor = await lumine.workspace.open();
    editors.push(editor);
    editor.setText("abc def\nghi jkl\nretained\n".repeat(80));
    editor.setSelectedBufferRanges(
      Array.from({ length: 80 }, (_, i) => [
        [i * 3, 1],
        [i * 3, 3],
      ]),
    );
    const layer = editor.getBuffer().addMarkerLayer({ maintainHistory: true });
    for (let row = 0; row < 240; row++)
      layer.markRange(
        [
          [row, 4],
          [row, 6],
        ],
        { invalidate: "never" },
      );
    editor.getBuffer().clearUndoStack();
    return { editor, layer };
  }
  const state = ({ editor, layer }) => ({
    text: editor.getText(),
    selections: editor.getSelectedBufferRanges().map((range) => range.serialize()),
    markers: layer.getMarkers().map((marker) => marker.getRange().serialize()),
  });
  it("preserves intermediate callbacks, snapshots, selections and undo for multiline insertion", async () => {
    const actual = await build(),
      reference = await build();
    spyOn(reference.editor.getBuffer(), "batchMarkerHistory").and.callFake((fn) => fn());
    const traces = [],
      retained = [];
    for (const context of [actual, reference]) {
      const events = [];
      traces.push(events);
      context.editor.onDidInsertText(({ range }) => {
        events.push([range.serialize(), context.editor.getText()]);
        if (events.length % 20 === 0) {
          const snapshot = context.layer.createSnapshot();
          const materialized = MarkerLayer.materializeSnapshot(snapshot);
          const eager = context.layer.createEagerSnapshot();
          for (const id of Object.keys(eager))
            expect(materialized[id].range).toEqual(eager[id].range);
          retained.push([snapshot, materialized]);
        }
      });
    }
    const original = state(actual);
    for (const { editor } of [actual, reference])
      editor.insertText("new\n😀line", {
        autoIndent: false,
        autoIndentNewline: false,
        autoDecreaseIndent: false,
      });
    expect(state(actual)).toEqual(state(reference));
    expect(traces[0]).toEqual(traces[1]);
    const changed = state(actual);
    actual.editor.undo();
    expect(state(actual)).toEqual(original);
    actual.editor.redo();
    expect(state(actual)).toEqual(changed);
    for (const [snapshot, expected] of retained)
      expect(MarkerLayer.materializeSnapshot(snapshot)).toEqual(expected);
  });
  it("restores deferred history and batch depths when a selection callback throws", async () => {
    const context = await build(),
      before = state(context);
    expect(() =>
      context.editor.mutateSelectedText((selection, i) => {
        selection.insertText("X\nY", { autoIndent: false, autoIndentNewline: false });
        if (i === 30) throw new Error("stop batch");
      }),
    ).toThrowError("stop batch");
    expect(state(context)).toEqual(before);
    for (const layer of Object.values(context.editor.getBuffer().markerLayers)) {
      expect(layer.historyBatchDepth).toBe(0);
      expect(layer.historyColumnBatchDepth).toBe(0);
    }
    context.editor.insertText("ok", { autoIndent: false });
    context.editor.undo();
    expect(state(context)).toEqual(before);
  });
  it("keeps row-local history updates for batches that do not change line count", async () => {
    const { editor, layer } = await build();
    const dump = spyOn(layer.index, "dump").and.callThrough();
    editor.insertText("x", { autoIndent: false });
    // The optional verification mode deliberately dumps at snapshot boundaries.
    if (!process.env.LUMINE_VERIFY_MARKER_SNAPSHOTS) expect(dump).not.toHaveBeenCalled();
    expect(layer.historyShadowDirty).toBe(false);
  });
});
