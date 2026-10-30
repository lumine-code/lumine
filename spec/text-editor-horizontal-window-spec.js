const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { MAX_DOM_EXTENT } = require("../src/scroll-coordinate-space");

describe("TextEditor horizontal windows", () => {
  let editor;
  afterEach(() => editor?.destroy());

  function attach(text) {
    jasmine.useRealClock();
    editor = new TextEditor({
      buffer: new TextBuffer(text),
      softWrapped: false,
      autoHeight: false,
      maxScreenLineLength: Infinity,
    });
    editor.maxScreenLineLength = Infinity;
    editor.displayLayer.reset({ softWrapColumn: Infinity });
    const element = editor.getElement();
    element.style.width = "700px";
    element.style.height = "300px";
    jasmine.attachToDOM(element);
    const component = element.getComponent();
    component.updateSync();
    return { element, component };
  }

  it("renders a bounded window, cursor, selection and IME anchor beyond the CSS width limit", () => {
    const length = 6_000_000;
    const { element, component } = attach("a".repeat(length));
    spyOn(editor.buffer, "lineForRow").and.callFake(() => {
      throw new Error("renderer materialized an entire long line");
    });
    editor.setCursorBufferPosition([0, length]);
    component.updateSync();
    component.updateSync();
    const line = component.renderedScreenLineForRow(0);
    expect(line.startScreenColumn).toBeGreaterThan(length - 10000);
    expect(line.lineText.length).toBeLessThanOrEqual(5000);
    expect(component.getScrollWidth()).toBeGreaterThan(33554432);
    expect(component.refs.content.getBoundingClientRect().width).toBeLessThanOrEqual(
      MAX_DOM_EXTENT,
    );
    const viewport = component.refs.scrollContainer.getBoundingClientRect();
    expect(
      component.refs.horizontalScrollbar.element.getBoundingClientRect().width,
    ).toBeLessThanOrEqual(viewport.width);
    expect(component.refs.horizontalScrollbar.element.scrollLeft).toBe(0);
    const cursor = element.querySelector(".cursor").getBoundingClientRect();
    const input = component.refs.cursorsAndInput.refs.hiddenInput.getBoundingClientRect();
    expect(cursor.left).toBeGreaterThanOrEqual(viewport.left);
    expect(cursor.left).toBeLessThanOrEqual(viewport.right);
    expect(input.left).toBeCloseTo(cursor.left, 0);
    editor.setSelectedBufferRange([
      [0, length - 10],
      [0, length],
    ]);
    component.updateSync();
    expect(
      element.querySelector(".highlight .region").getBoundingClientRect().width,
    ).toBeGreaterThan(0);
    editor.insertText("END");
    component.updateSync();
    expect(component.renderedScreenLineForRow(0).lineText.endsWith("END")).toBe(true);
  }, 60000);

  it("keeps visible CJK, astral, tabs, decorations and hit testing aligned", () => {
    const text = "prefix".repeat(10000) + "\t我😀xyz" + "a".repeat(200);
    const { element, component } = attach(text);
    const column = 60004;
    editor.setCursorBufferPosition([0, column]);
    component.updateSync();
    component.updateSync();
    const screen = editor.screenPositionForBufferPosition([0, column]);
    const pixel = component.pixelPositionForScreenPosition(screen);
    const hit = component.screenPositionForPixelPosition(pixel);
    expect(hit.toArray()).toEqual(screen.toArray());
    const marker = editor.markBufferRange([
      [0, 60001],
      [0, 60007],
    ]);
    editor.decorateMarker(marker, { type: "text", class: "window-text-decoration" });
    component.updateSync();
    expect(element.querySelector(".window-text-decoration").textContent).toContain("我😀");
    const windowLine = component.renderedScreenLineForRow(0);
    expect(/^[\udc00-\udfff]/.test(windowLine.lineText)).toBe(false);
    expect(/[\ud800-\udbff]$/.test(windowLine.lineText)).toBe(false);
    const logical = component.pixelPositionForMouseEvent({
      clientX:
        component.refs.lineTiles.getBoundingClientRect().left +
        pixel.left -
        component.renderOriginLeft,
      clientY:
        component.refs.lineTiles.getBoundingClientRect().top +
        pixel.top +
        component.getLineHeight() / 2,
    });
    expect(component.screenPositionForPixelPosition(logical).toArray()).toEqual(screen.toArray());
  });
});
