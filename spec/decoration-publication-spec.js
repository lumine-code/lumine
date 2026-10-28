describe("Decoration publication batches", () => {
  let editor, layer, decoration;
  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor();
    editor.setText("text\n".repeat(100));
    layer = editor.addMarkerLayer({ maintainHistory: false });
    decoration = editor.decorateMarkerLayer(layer, { type: "text", class: "base" });
  });
  afterEach(() => editor.destroy());

  it("publishes final marker and decoration state once without editing text or history", () => {
    const update = jasmine.createSpy("decorations"),
      markers = jasmine.createSpy("markers");
    editor.onDidUpdateDecorations(update);
    layer.onDidUpdate(markers);
    const schedule = spyOn(editor, "scheduleComponentUpdate");
    const buffer = editor.getBuffer(),
      revision = buffer.getTextRevision();
    const checkpoint = spyOn(buffer, "createCheckpoint").and.callThrough();
    const result = editor.batchDecorations(() => {
      for (let row = 0; row < 100; row++) {
        const marker = layer.markBufferRange([
          [row, 0],
          [row, 2],
        ]);
        decoration.setPropertiesForMarker(marker, { type: "text", class: "token" });
      }
      expect(update).not.toHaveBeenCalled();
      expect(markers).not.toHaveBeenCalled();
      return 42;
    });
    expect(result).toBe(42);
    expect(update).toHaveBeenCalledTimes(1);
    expect(markers).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(layer.getMarkerCount()).toBe(100);
    expect(buffer.getTextRevision()).toBe(revision);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("coalesces nested batches, ignores empty batches and flushes applied work on failure", () => {
    const update = jasmine.createSpy("decorations");
    editor.onDidUpdateDecorations(update);
    editor.batchDecorations(() => editor.batchDecorations(() => {}));
    expect(update).not.toHaveBeenCalled();
    expect(() =>
      editor.batchDecorations(() => {
        editor.batchDecorations(() =>
          layer.markBufferRange([
            [0, 0],
            [0, 2],
          ]),
        );
        throw new Error("after marker creation");
      }),
    ).toThrowError("after marker creation");
    expect(update).toHaveBeenCalledTimes(1);
    editor.batchDecorations(() => layer.clear());
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("does not publish a disposed editor after teardown inside a batch", () => {
    const update = jasmine.createSpy("decorations");
    editor.onDidUpdateDecorations(update);
    expect(() =>
      editor.batchDecorations(() => {
        layer.markBufferRange([
          [0, 0],
          [0, 2],
        ]);
        editor.destroy();
      }),
    ).not.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
