const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const TextBuffer = require("../src/text-buffer");

describe("Atomic input marker publication", () => {
  let editor, service, buffers;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    service = new Service(lumine.grammars);
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
    buffers = [];
  });

  afterEach(async () => {
    editor.destroy();
    for (const buffer of buffers) buffer.destroy();
    await service.dispose();
  });

  async function start(text) {
    editor.setText(text);
    editor.getBuffer().setLanguageMode(
      new WorkerMode({
        buffer: editor.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName("source.python"),
        service,
      }),
    );
    await editor.whenGrammarSettled();
    editor.getBuffer().clearUndoStack();
  }

  function holdIndentation() {
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const ready = new Promise((resolve) => (entered = resolve));
    const request = service.client.request.bind(service.client);
    spyOn(service.client, "request").and.callFake(async (operation, ...args) => {
      const result = request(operation, ...args);
      if (operation === "prepared-indent") {
        entered();
        await gate;
      }
      return result;
    });
    return { release, ready };
  }

  function diagnostic(layer, row, column = 4) {
    return layer.markBufferRange(
      [
        [row, column],
        [row, column + 5],
      ],
      { invalidate: "never", exclusive: true },
    );
  }

  it("publishes final indentation across delayed frames without copying a 10000-marker layer", async () => {
    const original = "class Record:\n" + "    value = 1\n".repeat(10000);
    await start(original);
    const layer = editor.addMarkerLayer({ maintainHistory: false });
    const markers = Array.from({ length: 10000 }, (_, index) => diagnostic(layer, index + 1));
    const before = markers[4999].getBufferRange();
    const eager = spyOn(layer.bufferMarkerLayer, "createEagerSnapshot").and.callThrough();
    const restore = spyOn(layer.bufferMarkerLayer, "restoreFromSnapshot").and.callThrough();
    editor.setCursorBufferPosition([0, Infinity]);
    const position = editor.getCursorBufferPosition();
    const publications = [];
    editor.getBuffer().onDidApplyChanges(() =>
      publications.push({
        text: editor.getText(),
        marker: markers[4999].getBufferRange(),
      }),
    );
    const gate = holdIndentation();
    const pending = editor.insertNewline();
    try {
      await gate.ready;
      for (let frame = 0; frame < 5; frame++) {
        await new Promise(requestAnimationFrame);
        expect(editor.getText()).toBe(original);
        expect(editor.getCursorBufferPosition()).toEqual(position);
        expect(markers[4999].getBufferRange()).toEqual(before);
        expect(publications.length).toBe(0);
      }
    } finally {
      gate.release();
    }
    await pending;
    expect(editor.lineTextForBufferRow(1)).toBe("    ");
    expect(editor.getCursorBufferPosition()).toEqual([1, 4]);
    expect(publications.length).toBe(1);
    expect(publications[0].text).toBe("class Record:\n    \n" + original.slice(14));
    expect(publications[0].marker).toEqual([
      [5001, 4],
      [5001, 9],
    ]);
    expect(layer.getMarkerCount()).toBe(10000);
    expect(layer.getMarker(markers[4999].id)).toBe(markers[4999]);
    expect(eager).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("retains diagnostic marker and decoration ownership after prepared Enter", async () => {
    await start("class Record:\n    value = 1");
    const layer = editor.addMarkerLayer({ maintainHistory: false });
    const marker = diagnostic(layer, 1);
    const underlying = marker.bufferMarker;
    const decoration = editor.decorateMarker(marker, {
      type: "highlight",
      class: "atomic-input-diagnostic",
    });
    const destroyed = jasmine.createSpy("diagnostic destroyed");
    marker.onDidDestroy(destroyed);
    editor.setCursorBufferPosition([0, Infinity]);
    await editor.insertNewline();
    expect(layer.getMarker(marker.id)).toBe(marker);
    expect(layer.bufferMarkerLayer.getMarker(marker.id)).toBe(underlying);
    expect(marker.getBufferRange()).toEqual([
      [2, 4],
      [2, 9],
    ]);
    expect(editor.getDecorations()).toContain(decoration);
    expect(editor.decorationsStateForScreenRowRange(0, 3)[decoration.id]).toBeDefined();
    marker.destroy();
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(marker.isDestroyed()).toBe(true);
    expect(decoration.isDestroyed()).toBe(true);
    expect(layer.getMarkerCount()).toBe(0);
    expect(editor.getDecorations()).not.toContain(decoration);
    expect(editor.decorationsStateForScreenRowRange(0, 3)[decoration.id]).toBeUndefined();
  });

  for (const clear of ["destroy", "clear"])
    it(`does not resurrect diagnostics after ${clear}, undo and redo`, async () => {
      const original = "class Record:\n    value = 1";
      await start(original);
      const layer = editor.addMarkerLayer({ maintainHistory: false });
      const marker = diagnostic(layer, 1);
      const decoration = editor.decorateMarker(marker, {
        type: "highlight",
        class: "atomic-input-cleared-diagnostic",
      });
      const layerDecoration = editor.decorateMarkerLayer(layer, {
        type: "highlight",
        class: "atomic-input-diagnostic-layer",
      });
      const layerDecorationKey = `${layerDecoration.id}-${marker.id}`;
      const destroyed = jasmine.createSpy("diagnostic destroyed");
      marker.onDidDestroy(destroyed);
      const eager = spyOn(layer.bufferMarkerLayer, "createEagerSnapshot").and.callThrough();
      const restore = spyOn(layer.bufferMarkerLayer, "restoreFromSnapshot").and.callThrough();
      editor.setCursorBufferPosition([0, Infinity]);
      await editor.insertNewline();
      const inserted = editor.getText();
      expect(editor.decorationsStateForScreenRowRange(0, 3)[layerDecorationKey]).toBeDefined();
      if (clear === "destroy") marker.destroy();
      else layer.clear();
      for (let cycle = 0; cycle < 2; cycle++) {
        editor.undo();
        expect(editor.getText()).toBe(original);
        expect(layer.getMarkerCount()).toBe(0);
        expect(marker.isDestroyed()).toBe(true);
        editor.redo();
        expect(editor.getText()).toBe(inserted);
        expect(layer.getMarkerCount()).toBe(0);
        expect(layer.bufferMarkerLayer.getMarker(marker.id)).toBeUndefined();
        expect(marker.isDestroyed()).toBe(true);
        expect(editor.getDecorations()).not.toContain(decoration);
        expect(editor.decorationsStateForScreenRowRange(0, 3)[decoration.id]).toBeUndefined();
        expect(editor.decorationsStateForScreenRowRange(0, 3)[layerDecorationKey]).toBeUndefined();
      }
      expect(destroyed).toHaveBeenCalledTimes(1);
      expect(eager).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    });

  it("honors diagnostic replacement while indentation is waiting for the parser", async () => {
    await start("class Record:\n    value = 1");
    const layer = editor.addMarkerLayer({ maintainHistory: false });
    const old = diagnostic(layer, 1);
    editor.setCursorBufferPosition([0, Infinity]);
    const gate = holdIndentation();
    const pending = editor.insertNewline();
    let replacement;
    try {
      await gate.ready;
      old.destroy();
      replacement = diagnostic(layer, 1, 10);
      await new Promise(requestAnimationFrame);
      expect(old.isDestroyed()).toBe(true);
      expect(layer.getMarkerCount()).toBe(1);
      expect(editor.getCursorBufferPosition()).toEqual([0, 13]);
    } finally {
      gate.release();
    }
    await pending;
    expect(editor.getCursorBufferPosition()).toEqual([1, 4]);
    expect(old.isDestroyed()).toBe(true);
    expect(layer.getMarkerCount()).toBe(1);
    expect(layer.getMarker(replacement.id)).toBe(replacement);
    expect(replacement.getBufferRange()).toEqual([
      [2, 10],
      [2, 13],
    ]);
  });

  it("tracks the actual applied edit sequence and shifted coordinates with multiple cursors", async () => {
    const original = "class First:\n    first = 1\n\nclass Second:\n    second = 2";
    await start(original);
    const calls = [];
    const track = (records, change, log) => {
      log.push({
        ranges: records.map(({ range }) => range),
        oldRange: change.oldRange,
        newRange: change.newRange,
        newText: change.newText,
      });
      return records.map(({ id, range }) => ({
        id,
        range: [
          range.start,
          [
            range.end.row + change.newRange.end.row - change.oldRange.end.row,
            range.end.row === change.oldRange.end.row
              ? change.newRange.end.column + range.end.column - change.oldRange.end.column
              : range.end.column,
          ],
        ],
      }));
    };
    const layer = editor.getBuffer().addMarkerLayer({
      maintainHistory: false,
      trackRanges: (records, change) => track(records, change, calls),
    });
    const marker = layer.markRange(editor.getBuffer().getRange(), { invalidate: "never" });
    editor.setSelectedBufferRanges([
      [
        [0, Infinity],
        [0, Infinity],
      ],
      [
        [3, Infinity],
        [3, Infinity],
      ],
    ]);
    const batches = [];
    editor.getBuffer().onDidApplyChanges(({ changes }) => batches.push(changes));
    await editor.insertNewline();
    expect(editor.getCursorBufferPositions()).toEqual([
      [1, 4],
      [5, 4],
    ]);
    expect(batches.length).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
    const replay = new TextBuffer(original);
    buffers.push(replay);
    const referenceCalls = [];
    const referenceLayer = replay.addMarkerLayer({
      maintainHistory: false,
      trackRanges: (records, change) => track(records, change, referenceCalls),
    });
    const referenceMarker = referenceLayer.markRange(replay.getRange(), { invalidate: "never" });
    for (const change of batches[0]) {
      expect(replay.getTextInRange(change.oldRange)).toBe(change.oldText);
      replay.setTextInRange(change.oldRange, change.newText, { normalizeLineEndings: false });
    }
    expect(replay.getText()).toBe(editor.getText());
    expect(calls).toEqual(referenceCalls);
    expect(marker.getRange()).toEqual(referenceMarker.getRange());
    expect(marker.getRange()).toEqual(editor.getBuffer().getRange());
    expect(layer.getMarker(marker.id)).toBe(marker);
    expect(marker.isValid()).toBe(true);
  });

  it("destroys custom-tracked diagnostics once and keeps them absent through undo and redo", async () => {
    const original = "class Record:\n    value = 1";
    await start(original);
    const tracker = jasmine.createSpy("diagnostic range tracker").and.returnValue([]);
    const layer = editor.addMarkerLayer({
      maintainHistory: false,
      destroyInvalidatedMarkers: true,
      trackRanges: tracker,
    });
    const marker = layer.markBufferRange(editor.getBuffer().getRange(), { invalidate: "never" });
    const destroyed = jasmine.createSpy("diagnostic destroyed");
    marker.onDidDestroy(destroyed);
    editor.setCursorBufferPosition([0, Infinity]);
    await editor.insertNewline();
    const inserted = editor.getText();
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(marker.isDestroyed()).toBe(true);
    expect(layer.getMarkerCount()).toBe(0);
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(marker.isDestroyed()).toBe(true);
    expect(layer.getMarkerCount()).toBe(0);
    editor.redo();
    expect(editor.getText()).toBe(inserted);
    expect(marker.isDestroyed()).toBe(true);
    expect(layer.getMarkerCount()).toBe(0);
    expect(layer.getRangeTracker()).toBe(tracker);
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  for (const target of ["buffer", "display"])
    for (const notification of ["change", "destroy"])
      it(`finishes prepared input and history when a deferred ${target} ${notification} observer throws`, async () => {
        const original = "class Record:\n    value = 1";
        const inserted = "class Record:\n    \n    value = 1";
        await start(original);
        const layer = editor.addMarkerLayer({
          maintainHistory: false,
          destroyInvalidatedMarkers: notification === "destroy",
        });
        const markers = Array.from({ length: 2 }, () =>
          layer.markBufferRange(editor.getBuffer().getRange(), {
            invalidate: notification === "destroy" ? "touch" : "never",
          }),
        );
        const observed = [];
        const failure = new Error("diagnostic observer failed");
        let throwOnce = true;
        markers.forEach((marker, index) => {
          const subscribe = notification === "destroy" ? "onDidDestroy" : "onDidChange";
          const observedMarker = target === "buffer" ? marker.bufferMarker : marker;
          observedMarker[subscribe](() => {
            observed.push({
              marker: index,
              text: editor.getText(),
              cursor: editor.getCursorBufferPosition(),
            });
            if (index === 0 && throwOnce) {
              throwOnce = false;
              throw failure;
            }
          });
        });
        editor.setCursorBufferPosition([0, Infinity]);
        let rejected;
        try {
          await editor.insertNewline();
        } catch (error) {
          rejected = error;
        }
        expect(rejected?.code).toBe("ERR_EDIT_OBSERVER_FAILED");
        expect(rejected?.committed).toBe(true);
        expect(editor.getText()).toBe(inserted);
        expect(editor.getCursorBufferPosition()).toEqual([1, 4]);
        expect(observed.map(({ marker }) => marker).sort()).toEqual([0, 1]);
        for (const observation of observed) {
          expect(observation.text).toBe(inserted);
          expect(observation.cursor).toEqual([1, 4]);
        }
        expect(layer.getMarkerCount()).toBe(notification === "destroy" ? 0 : 2);
        expect(editor.getBuffer().atomicEditContext).toBe(null);

        await editor.insertText("field", { autoIndent: false });
        expect(editor.getText()).toBe("class Record:\n    field\n    value = 1");
        editor.undo();
        expect(editor.getText()).toBe(inserted);
        editor.undo();
        expect(editor.getText()).toBe(original);
        expect(editor.getCursorBufferPosition()).toEqual([0, 13]);
        editor.redo();
        expect(editor.getText()).toBe(inserted);
        expect(editor.getCursorBufferPosition()).toEqual([1, 4]);
        if (notification === "destroy") {
          expect(layer.getMarkerCount()).toBe(0);
          expect(markers.every((marker) => marker.isDestroyed())).toBe(true);
        } else {
          expect(markers.every((marker) => layer.getMarker(marker.id) === marker)).toBe(true);
          expect(markers.map((marker) => marker.getBufferRange())).toEqual([
            editor.getBuffer().getRange(),
            editor.getBuffer().getRange(),
          ]);
        }
      });
});
