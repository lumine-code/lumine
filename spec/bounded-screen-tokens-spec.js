describe("Bounded tokens for auxiliary renderers", () => {
  let editor;
  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor();
  });
  afterEach(() => editor.destroy());

  it("exposes bounded rendered source ranges without creating a view for a background editor", () => {
    expect(editor.component).toBeUndefined();
    expect(editor.getRenderedBufferRanges()).toEqual([]);
    expect(editor.component).toBeUndefined();
    editor.setText("x".repeat(1000000));
    editor.update({ autoHeight: false, softWrapped: false, maxScreenLineLength: Infinity });
    const element = editor.element;
    element.style.cssText = "width:800px;height:200px";
    jasmine.attachToDOM(element);
    element.setUpdatedSynchronously(true);
    const component = element.component;
    component.updateSync();
    let ranges = editor.getRenderedBufferRanges();
    expect(ranges.length).toBe(1);
    expect(ranges[0].end.column - ranges[0].start.column).toBeLessThan(8192);
    component.setScrollLeft(400000 * component.getBaseCharacterWidth());
    component.updateSync();
    ranges = editor.getRenderedBufferRanges();
    expect(ranges[0].start.column).toBeGreaterThan(390000);
    expect(ranges[0].end.column - ranges[0].start.column).toBeLessThan(8192);
    element.remove();
    expect(editor.getRenderedBufferRanges()).toEqual([]);
  });

  it("does not materialize a very long row to draw its small visible prefix", () => {
    editor.setText("x".repeat(1000000));
    editor.update({ softWrapped: false, maxScreenLineLength: Infinity });
    const full = spyOn(editor.displayLayer, "getScreenLine").and.callThrough();
    const window = spyOn(editor.displayLayer, "getScreenLineWindow").and.callThrough();
    const tokens = editor.tokensForScreenRow(0, { maxTokens: 10, maxColumns: 120 });
    expect(full).not.toHaveBeenCalled();
    expect(window).toHaveBeenCalled();
    expect(tokens.map((token) => token.text).join("")).toBe("x".repeat(120));
  });

  it("clips token prefixes without splitting a surrogate pair or borrowing another row", () => {
    editor.setText("a🦉b\nnext");
    expect(
      editor
        .tokensForScreenRow(0, { maxColumns: 2 })
        .map((t) => t.text)
        .join(""),
    ).toBe("a");
    expect(
      editor
        .tokensForScreenRow(0, { maxColumns: 3 })
        .map((t) => t.text)
        .join(""),
    ).toBe("a🦉");
    expect(editor.tokensForScreenRow(0, { maxColumns: 0 })).toEqual([]);
    expect(() => editor.tokensForScreenRow(0, { maxColumns: NaN })).toThrowError(RangeError);
  });

  it("a pre-requested column read cannot replace its owner's larger viewport", () => {
    editor.setText("x".repeat(20000));
    editor.update({ softWrapped: false, maxScreenLineLength: Infinity });
    const prepare = spyOn(
      editor.displayLayer,
      "prepareHighlightingForScreenRows",
    ).and.callThrough();
    editor.tokensForScreenRow(0, { highlightingOwner: {}, maxColumns: 80 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("column preparation does not query a folded interior between two long visible fragments", () => {
    editor.setText("x".repeat(20000) + "\n" + "hidden\n".repeat(1000) + "y".repeat(20000));
    editor.update({ softWrapped: false, maxScreenLineLength: Infinity });
    editor.foldBufferRange([
      [0, 100],
      [1001, 100],
    ]);
    const mode = editor.getBuffer().getLanguageMode();
    mode.asynchronousSyntax = true;
    mode.requestHighlighting = jasmine.createSpy("prepare").and.returnValue(false);
    editor.displayLayer.prepareHighlightingForScreenRows(
      0,
      1,
      {},
      {
        columnsForRow: () => ({ start: 0, end: 1000 }),
      },
    );
    const windows = mode.requestHighlighting.calls.mostRecent().args[3].windows;
    expect(windows.length).toBe(2);
    expect(windows[0].start.serialize()).toEqual([0, 0]);
    expect(windows[0].end.serialize()).toEqual([0, 100]);
    expect(windows[1].start.serialize()).toEqual([1001, 100]);
    expect(windows[1].end.row).toBe(1001);
  });
});
