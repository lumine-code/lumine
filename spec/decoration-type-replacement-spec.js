describe("decoration type replacement", () => {
  let editor;

  afterEach(() => editor?.destroy());

  it("removes an overlay from the registry when replacement properties omit its type", () => {
    editor = lumine.workspace.buildTextEditor();
    const item = document.createElement("div");
    const marker = editor.markBufferPosition([0, 0]);
    const decoration = editor.decorateMarker(marker, { type: ["overlay", "line"], item });
    expect(editor.getOverlayDecorations()).toContain(decoration);

    decoration.setProperties({ class: "no-decoration-type" });
    expect(decoration.isType("overlay")).toBe(false);
    expect(editor.getOverlayDecorations()).not.toContain(decoration);

    decoration.setProperties({ type: "overlay", item });
    expect(editor.getOverlayDecorations()).toContain(decoration);
    decoration.setProperties({ type: "line", class: "ordinary-line" });
    expect(editor.getOverlayDecorations()).not.toContain(decoration);
  });
});
