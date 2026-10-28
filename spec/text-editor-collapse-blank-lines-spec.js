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

  for (const ending of ["\n", "\r\n"]) {
    it(`collapses a visible large document with ${JSON.stringify(ending)} endings and preserves its markers, viewport and undo`, async () => {
      const lines = Array.from({ length: 2400 }, (_, row) => `line-${row}`);
      const text = lines.map((line) => line + ending.repeat(4)).join("");
      build(text);
      const buffer = editor.getBuffer();
      const marker = buffer.markPosition([1, 0], { invalidate: "touch" });
      editor.setSelectedBufferRange(
        [
          [8000, 1],
          [8000, 4],
        ],
        { reversed: true, autoscroll: false },
      );
      component.updateSync();
      const lineHeight = component.getLineHeight();
      component.setScrollTop(component.pixelPositionAfterBlocksForRow(8000) + 0.25 * lineHeight);
      component.updateSync();
      const offset = component.pixelPositionAfterBlocksForRow(8000) - component.getScrollTop();
      const markers = editor.getMarkerCount();
      const selection = editor.getSelectedBufferRange();
      buffer.onDidChangeText(() => component.getScrollTop());
      buffer.clearUndoStack();

      await editor.collapseBlankLines();
      component.updateSync();

      expect(buffer.getText()).toBe(lines.map((line) => line + ending.repeat(2)).join(""));
      expect(marker.isValid()).toBe(true);
      expect(marker.getStartPosition()).toEqual([1, 0]);
      expect(editor.getMarkerCount()).toBe(markers);
      expect(editor.getSelectedBufferRange()).toEqual([
        [4000, 1],
        [4000, 4],
      ]);
      expect(editor.getLastSelection().isReversed()).toBe(true);
      expect(editor.lineTextForBufferRow(component.getFirstVisibleRow())).toBe("line-2000");
      expect(component.pixelPositionAfterBlocksForRow(4000) - component.getScrollTop()).toBeCloseTo(
        offset,
        5,
      );
      editor.undo();
      expect(buffer.getText()).toBe(text);
      expect(editor.getSelectedBufferRange()).toEqual(selection);
      editor.redo();
      expect(editor.getSelectedBufferRange()).toEqual([
        [4000, 1],
        [4000, 4],
      ]);
    });
  }

  it("releases the viewport marker after a large collapse makes no changes or is cancelled", async () => {
    const text = "line\r\n\r\n".repeat(2400);
    build(text);
    const buffer = editor.getBuffer();
    const markers = editor.getMarkerCount();
    buffer.clearUndoStack();

    await editor.collapseBlankLines();

    expect(buffer.getText()).toBe(text);
    expect(editor.getMarkerCount()).toBe(markers);
    expect(buffer.undo()).toBe(false);

    editor.setText("line\r\n\r\n\r\n".repeat(2400));
    const original = buffer.getText();
    buffer.clearUndoStack();
    const pending = editor.collapseBlankLines();
    editor.setCursorBufferPosition([3, 0]);
    await expectAsync(pending).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_STALE_EDIT" }),
    );
    expect(buffer.getText()).toBe(original);
    expect(editor.getMarkerCount()).toBe(markers);
    expect(buffer.undo()).toBe(false);
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
