const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");

describe("Collapsing blank lines preserves the reading position", () => {
  let editor, component;
  afterEach(() => {
    editor?.destroy();
    component?.element.remove();
  });

  function build(text, options = {}) {
    editor = new TextEditor({ softWrapped: false, autoHeight: false, ...options });
    editor.setText(text);
    component = new TextEditorComponent({ model: editor });
    component.element.style.height = "300px";
    component.element.style.width = "600px";
    jasmine.attachToDOM(component.element);
    component.updateSync();
  }

  it("keeps the same content and cursor offset when blank runs change on both sides of the viewport", () => {
    build(Array.from({ length: 150 }, (_, row) => `line-${row}\n\n\n\n`).join(""));
    editor.setCursorBufferPosition([400, 3]);
    component.updateSync();
    const lineHeight = component.getLineHeight();
    component.setScrollTop(component.pixelPositionBeforeBlocksForRow(400) + 0.25 * lineHeight);
    component.updateSync();
    const offset =
      component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
      component.getScrollTop();
    editor.collapseBlankLines();
    component.updateSync();
    expect(editor.lineTextForBufferRow(editor.getCursorBufferPosition().row)).toBe("line-100");
    expect(editor.getCursorBufferPosition().column).toBe(3);
    const after =
      component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
      component.getScrollTop();

    expect(Math.abs(after - offset)).toBeLessThan(1);
  });

  for (const scrollPastEnd of [false, true]) {
    for (const topOffset of [0, 0.25]) {
      it(`keeps the top content near EOF with scrollPastEnd=${scrollPastEnd} and offset=${topOffset}, even when text observers read the viewport`, () => {
        const lines = Array.from({ length: 100 }, (_, row) => `line-${row}`);
        lines.fill("", 10, 17);
        lines.fill("", 85, 97);
        build(lines.join("\n"), { scrollPastEnd });
        const lineHeight = component.getLineHeight();
        component.element.style.height = `${20.5 * lineHeight}px`;
        component.updateSync();
        editor.setCursorBufferPosition([80, 3], { autoscroll: false });
        component.setScrollTop((79 + topOffset) * lineHeight);
        component.updateSync();
        const offset = component.pixelPositionAfterBlocksForRow(79) - component.getScrollTop();
        editor.getBuffer().onDidChangeText(() => component.getScrollTop());

        editor.collapseBlankLines();
        for (let update = 0; update < 3; update++) component.updateSync();

        expect(editor.lineTextForBufferRow(component.getFirstVisibleRow())).toBe("line-79");
        expect(component.pixelPositionAfterBlocksForRow(73) - component.getScrollTop()).toBeCloseTo(
          offset,
          5,
        );
        expect(editor.getScrollPastEnd()).toBe(scrollPastEnd);

        const scrollTop = component.getScrollTop();
        editor.collapseBlankLines();
        component.updateSync();
        expect(component.getScrollTop()).toBeCloseTo(scrollTop, 5);

        if (!scrollPastEnd) {
          const naturalMaximum = Math.round(
            component.getContentHeight() - component.getScrollContainerClientHeight(),
          );
          expect(scrollTop).toBeGreaterThan(naturalMaximum);
          component.setScrollTop(scrollTop - lineHeight);
          component.updateSync();
          expect(component.getMaxScrollTop()).toBeNear(scrollTop - lineHeight);
          component.setScrollTop(0);
          component.updateSync();
          component.setScrollTop(scrollTop);
          expect(component.getScrollTop()).toBe(naturalMaximum);
        }
      });
    }
  }

  it("keeps the top text when a surviving block moves from a deleted blank line to after it", () => {
    const lines = Array.from({ length: 150 }, (_, row) => `line-${row}`);
    lines.fill("", 11, 13);
    build(lines.join("\n"));
    const item = document.createElement("div");
    item.style.height = "80px";
    editor.decorateMarker(editor.markBufferPosition([12, 0], { invalidate: "never" }), {
      type: "block",
      position: "after",
      item,
    });
    component.updateSync();
    const lineHeight = component.getLineHeight();
    component.setScrollTop(component.pixelPositionAfterBlocksForRow(13) + 0.25 * lineHeight);
    component.updateSync();
    const offset = component.pixelPositionAfterBlocksForRow(13) - component.getScrollTop();

    editor.collapseBlankLines();
    component.updateSync();

    expect(editor.lineTextForBufferRow(component.getFirstVisibleRow())).toBe("line-13");
    expect(component.pixelPositionAfterBlocksForRow(12) - component.getScrollTop()).toBeCloseTo(
      offset,
      5,
    );
  });

  it("does not carry the temporary EOF space to a replacement editor", () => {
    const lines = Array.from({ length: 100 }, (_, row) => `line-${row}`);
    lines.fill("", 85, 97);
    build(lines.join("\n"));
    const lineHeight = component.getLineHeight();
    component.element.style.height = `${20.5 * lineHeight}px`;
    component.updateSync();
    component.setScrollTop(79.25 * lineHeight);
    editor.collapseBlankLines();
    component.updateSync();
    expect(component.getScrollTop()).toBeGreaterThan(
      component.getContentHeight() - component.getScrollContainerClientHeight(),
    );

    const previousEditor = editor;
    editor = new TextEditor({ autoHeight: false });
    editor.setText("short document");
    component.update({ ...component.props, model: editor });
    previousEditor.destroy();
    component.updateSync();

    expect(component.getScrollTop()).toBe(0);
    expect(component.getMaxScrollTop()).toBe(0);
  });

  it("keeps a cursor on the first blank line that survives the collapse", () => {
    build("one\n\n\n\ntwo\n");
    editor.setCursorBufferPosition([1, 0]);
    editor.collapseBlankLines();
    expect(editor.getText()).toBe("one\n\ntwo\n");
    expect(editor.getCursorBufferPosition()).toEqual([1, 0]);
  });

  for (const ending of ["\n", "\r\n", "\r"]) {
    it(`preserves ${JSON.stringify(ending)} endings and restores selections on undo`, () => {
      const text = `one${ending.repeat(4)}two${ending}`;
      build(text);
      const buffer = editor.getBuffer();
      const position = buffer.positionForCharacterIndex(3 + ending.length);
      editor.setCursorBufferPosition(position);
      buffer.clearUndoStack();
      editor.collapseBlankLines();
      expect(editor.getText()).toBe(`one${ending.repeat(2)}two${ending}`);
      expect(editor.getCursorBufferPosition()).toEqual(position);
      editor.undo();
      expect(editor.getText()).toBe(text);
      expect(editor.getCursorBufferPosition()).toEqual(position);
      editor.redo();
      expect(editor.getText()).toBe(`one${ending.repeat(2)}two${ending}`);
    });
  }

  it("does not move the viewport for deletions below it or overshoot a deleted top row", () => {
    build(Array.from({ length: 100 }, (_, row) => `line-${row}\n`).join(""));
    const buffer = editor.getBuffer();
    const lineHeight = component.getLineHeight();
    component.setScrollTop(20.25 * lineHeight);
    buffer.delete([
      [40, 0],
      [50, 0],
    ]);
    component.updateSync();
    expect(component.getScrollTop()).toBe(20.25 * lineHeight);
    buffer.delete([
      [10, 0],
      [30, 0],
    ]);
    component.updateSync();
    expect(component.getScrollTop()).toBe(10.25 * lineHeight);
  });
});
