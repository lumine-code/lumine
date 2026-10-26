const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { MAX_DOM_EXTENT, MAX_SCROLLBAR_EXTENT } = require("../src/scroll-coordinate-space");

describe("Large document viewport", () => {
  let editor;
  afterEach(() => editor?.destroy());

  it("renders the final rows, gutter, selection and input beyond Chromium's CSS extent", () => {
    jasmine.useRealClock();
    const rows = 2000000;
    editor = new TextEditor({
      buffer: new TextBuffer("x\n".repeat(rows)),
      softWrapped: true,
      autoHeight: false,
    });
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.getSoftWrapColumn()).toBe(Infinity);
    const element = editor.getElement();
    element.style.width = "700px";
    element.style.height = "500px";
    jasmine.attachToDOM(element);
    const component = element.getComponent();
    component.updateSync();
    editor.setSelectedBufferRange([
      [rows - 2, 0],
      [rows, 0],
    ]);
    component.setScrollTop(component.getMaxScrollTop());
    component.updateSync();

    const viewport = component.refs.scrollContainer.getBoundingClientRect();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    };
    expect(component.getScrollHeight()).toBeGreaterThan(33554432);
    expect(component.refs.content.getBoundingClientRect().height).toBeLessThanOrEqual(
      MAX_DOM_EXTENT,
    );
    expect([...element.querySelectorAll(".line")].some(visible)).toBe(true);
    expect(
      [...element.querySelectorAll(".line-number")].some(
        (node) => visible(node) && node.dataset.bufferRow === String(rows),
      ),
    ).toBe(true);
    expect([...element.querySelectorAll(".highlight .region")].some(visible)).toBe(true);
    expect(visible(component.refs.cursorsAndInput.refs.hiddenInput)).toBe(true);
    const scrollbar = component.refs.verticalScrollbar;
    scrollbar.flushScrollPosition();
    expect(scrollbar.element.scrollHeight).toBeLessThanOrEqual(MAX_SCROLLBAR_EXTENT);
    expect(scrollbar.element.scrollTop).toBeCloseTo(
      scrollbar.element.scrollHeight - scrollbar.element.clientHeight,
      0,
    );

    const line = element.querySelector(`.line[data-screen-row="${rows - 1}"]`);
    const rect = line.getBoundingClientRect();
    const logical = component.pixelPositionForMouseEvent({
      clientX: rect.left + 2,
      clientY: rect.top + rect.height / 2,
    });
    expect(component.screenPositionForPixelPosition(logical).row).toBe(rows - 1);
  }, 60000);

  it("allows an explicit wrapping choice and preserves it in serialized editor state", () => {
    editor = new TextEditor({
      buffer: new TextBuffer("x\n".repeat(300000)),
      softWrapped: true,
      autoHeight: false,
    });
    expect(editor.isSoftWrapped()).toBe(false);
    editor.setSoftWrapped(true);
    expect(editor.isSoftWrapped()).toBe(true);
    expect(editor.serialize().largeDocumentWrapEnabled).toBe(true);
    editor.setSoftWrapped(false);
    expect(editor.getSoftWrapColumn()).toBe(Infinity);
  });
});
