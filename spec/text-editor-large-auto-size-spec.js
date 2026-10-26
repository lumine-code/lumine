const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");

describe("Bounded large automatic editor sizing", () => {
  let editor;
  afterEach(() => editor?.destroy());
  function giantLine() {
    let source = TextBuffer.createTextSnapshot("x".repeat(32768));
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
    return source;
  }
  it("switches a mini editor before a giant source edit reaches wrapped layout", () => {
    editor = new TextEditor({ mini: true, autoHeight: true, softWrapped: true });
    const source = giantLine();
    editor.getBuffer().setTextInRange(editor.getBuffer().getRange(), source);
    expect(editor.getBuffer().getLength()).toBe(source.length);
    expect(editor.getSoftWrapColumn()).toBe(Infinity);
    expect(editor.displayLayer.softWrapColumn).toBe(Infinity);
    expect(editor.getScreenLineCount()).toBe(1);
    expect(editor.isSoftWrapped()).toBe(false);
  });
  it("forces a safe projection for an unrepresentable line even after an explicit wrap request", () => {
    editor = new TextEditor({
      autoHeight: false,
      editorWidthInChars: 80,
      softWrapped: true,
      largeFileOptimizations: false,
    });
    editor.setSoftWrapped(true);
    const source = giantLine();
    editor.getBuffer().setTextInRange(editor.getBuffer().getRange(), source);
    expect(editor.getScreenLineCount()).toBe(1);
    expect(editor.isSoftWrapped()).toBe(false);
    editor.setSoftWrapped(true);
    expect(editor.getSoftWrapColumn()).toBe(Infinity);
    editor.setText("small");
    expect(editor.isSoftWrapped()).toBe(true);
  });
  it("limits mounted rows in auto-sized views and restores ordinary sizing after shrinking", () => {
    jasmine.useRealClock();
    const source = TextBuffer.createTextSnapshot("x\n".repeat(400000));
    editor = new TextEditor({
      buffer: new TextBuffer({ text: source }),
      autoHeight: true,
      autoWidth: true,
      softWrapped: true,
    });
    const element = editor.getElement();
    jasmine.attachToDOM(element);
    const component = element.getComponent();
    component.updateSync();
    expect(component.getScrollContainerClientHeight()).toBeGreaterThan(0);
    expect(component.getScrollContainerClientHeight()).toBeLessThanOrEqual(400);
    expect(element.querySelectorAll(".line:not(.dummy)").length).toBeLessThan(150);
    expect(component.canScrollVertically()).toBe(true);
    component.setScrollTop(component.getMaxScrollTop());
    component.updateSync();
    expect(component.getLastVisibleRow()).toBeGreaterThan(399900);
    editor.setText("small");
    component.updateSync();
    expect(editor.usesBoundedAutoSize()).toBe(false);
    expect(component.canScrollVertically()).toBe(false);
    expect(component.getScrollContainerClientHeight()).toBeCloseTo(component.getLineHeight(), 0);
  });
});
