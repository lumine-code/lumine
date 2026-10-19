const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");

describe("Collapsing blank lines preserves the reading position", () => {
  let editor, component;
  afterEach(() => {
    editor?.destroy();
    component?.element.remove();
  });

  function build(text) {
    editor = new TextEditor({ softWrapped: false, autoHeight: false });
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
