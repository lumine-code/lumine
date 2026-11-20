const Range = require("../src/range");
const TextEditor = require("../src/text-editor");

describe("Fold range replacement", () => {
  let editor, copy, buffer, mode;

  function foldAt(block) {
    return new Range([block * 3, 7], [block * 3 + 2, 0]);
  }

  beforeEach(() => {
    editor = new TextEditor();
    editor.setText("block {\n  value;\n}\n".repeat(42));
    buffer = editor.getBuffer();
    mode = buffer.getLanguageMode();
  });

  afterEach(() => {
    copy?.destroy();
    copy = null;
    editor.destroy();
  });

  for (const command of ["foldAll", "foldAllAtIndentLevel"]) {
    it(`publishes ${command} once, retaining matching markers and independent split folds`, async () => {
      editor.displayLayer.reset({ softWrapColumn: command === "foldAll" ? Infinity : 80 });
      const first = foldAt(0);
      const keptId = editor.foldBufferRange(first);
      const obsolete = foldAt(41);
      editor.foldBufferRange(obsolete);
      copy = editor.copy();
      const oldCount = editor.getScreenLineCount();
      const ranges = Array.from({ length: 40 }, (_, index) => foldAt(index));
      ranges.push(first);
      mode.getFoldableRanges = mode.getFoldableRangesAtIndentLevel = () => Promise.resolve(ranges);
      const geometry = spyOn(editor.displayLayer, "updateSpatialIndex").and.callThrough();
      const layerUpdates = jasmine.createSpy("marker layer update");
      editor.displayLayer.foldsMarkerLayer.onDidUpdate(layerUpdates);
      const observed = [];
      editor.onDidChange(() => {
        observed.push({
          count: editor.getScreenLineCount(),
          folds: editor.displayLayer.foldRangesSnapshot().length,
        });
      });

      await editor[command](1);

      expect(geometry).toHaveBeenCalledTimes(1);
      expect(layerUpdates).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([{ count: buffer.getLineCount() - 80, folds: ranges.length }]);
      expect(editor.displayLayer.bufferRangeForFold(keptId)).toEqual(first);
      expect(editor.isFoldedAtBufferRow(obsolete.start.row)).toBe(false);
      expect(copy.isFoldedAtBufferRow(obsolete.start.row)).toBe(true);
      expect(copy.getScreenLineCount()).toBe(oldCount);

      await editor[command](1);
      expect(geometry).toHaveBeenCalledTimes(1);
      expect(layerUpdates).toHaveBeenCalledTimes(1);
      expect(observed.length).toBe(1);
    });
  }

  it("retains fold snapshots for text undo without adding a fold-only history entry", async () => {
    const range = foldAt(0);
    buffer.clearUndoStack();
    mode.getFoldableRanges = () => Promise.resolve([range]);
    await editor.foldAll();

    expect(buffer.undo()).toBe(false);
    expect(editor.displayLayer.foldRangesSnapshot()).toEqual([range]);
    buffer.delete(range);
    expect(editor.displayLayer.foldRangesSnapshot()).toEqual([]);
    buffer.undo();
    expect(editor.displayLayer.foldRangesSnapshot()).toEqual([range]);
  });

  it("reconciles committed folds before propagating a failing marker callback", async () => {
    const range = foldAt(0);
    const id = editor.foldBufferRange(range);
    const failure = new Error("fold observer failed");
    editor.displayLayer.foldsMarkerLayer.getMarker(id).onDidDestroy(() => {
      throw failure;
    });
    mode.getFoldableRanges = () => Promise.resolve([foldAt(2)]);

    await expectAsync(editor.foldAll()).toBeRejectedWith(failure);
    expect(editor.displayLayer.foldRangesSnapshot()).toEqual([]);
    expect(editor.getScreenLineCount()).toBe(buffer.getLineCount());
  });
});
