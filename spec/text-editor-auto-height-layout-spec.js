const TextEditor = require("../src/text-editor");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("TextEditor auto-height layout outside the viewport", () => {
  let host;
  let editor;
  let component;

  beforeEach(() => {
    jasmine.useRealClock();
    host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:0;top:0;width:420px;height:120px;overflow:auto;display:none;";
    const spacer = document.createElement("div");
    spacer.style.height = "1000px";
    host.appendChild(spacer);
    editor = new TextEditor({
      autoHeight: true,
      autoWidth: false,
      softWrapped: true,
      softWrapAtPreferredLineLength: false,
      showInvisibles: false,
    });
    editor.setText("a long example with enough words to wrap ".repeat(16));
    host.appendChild(editor.getElement());
    jasmine.attachToDOM(host);
    component = editor.getElement().getComponent();
    expect(component.hasInitialMeasurements).toBe(false);
    expect(component.visible).toBe(false);
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  function expandHost() {
    host.style.display = "block";
    // ResizeObserver delivers this same callback after the collapsed parent
    // expands. Invoke it directly to keep the layout assertion deterministic.
    component.didResize();
  }

  function expectFullContentHeight() {
    const lineCount = editor.getApproximateScreenLineCount();
    expect(lineCount).toBe(editor.getScreenLineCount());
    expect(editor.getElement().offsetHeight).toBeCloseTo(lineCount * component.getLineHeight(), 0);
    expect(component.visible).toBe(false);
  }

  it("establishes wrapped height when its collapsed parent expands offscreen", async () => {
    const setVisible = spyOn(editor, "setVisible").and.callThrough();
    const render = spyOn(component, "renderSync").and.callThrough();
    expandHost();

    expect(component.hasInitialMeasurements).toBe(true);
    expect(editor.getElement().offsetHeight).toBeGreaterThan(component.getLineHeight());
    expectFullContentHeight();
    expect(render).not.toHaveBeenCalled();
    expect(editor.getElement().querySelector(".line:not(.dummy)")).toBeNull();
    expect(editor.getElement().querySelector(".line-number:not(.dummy)")).toBeNull();
    await conditionPromise(() => !component.visible);
    expect(setVisible.calls.allArgs().some(([visible]) => visible)).toBe(false);
    const height = host.scrollHeight;
    host.scrollTop = 1000;
    await conditionPromise(() => component.visible);
    expect(host.scrollHeight).toBe(height);
    expect(render).toHaveBeenCalled();
    expect(editor.getElement().querySelector(".line:not(.dummy)")).not.toBeNull();
    expect(editor.getElement().querySelector(".line-number:not(.dummy)")).not.toBeNull();
  });

  it("reflows and updates its content height while outside the viewport", async () => {
    expandHost();
    const wideHeight = editor.getElement().offsetHeight;
    host.style.width = "220px";
    component.didResize();

    expect(editor.getElement().offsetHeight).toBeGreaterThan(wideHeight);
    expectFullContentHeight();
    const wrappedHeight = editor.getElement().offsetHeight;
    editor.setText(`${editor.getText()}\n${editor.getText()}`);
    await conditionPromise(() => editor.getElement().offsetHeight > wrappedHeight);
    expectFullContentHeight();
  });

  it("shrinks previously rendered content without painting it again offscreen", async () => {
    expandHost();
    component.didShow();
    const oldHeight = editor.getElement().offsetHeight;
    expect(editor.getElement().querySelector(".line:not(.dummy)")).not.toBeNull();
    component.didHide();
    const render = spyOn(component, "renderSync").and.callThrough();

    editor.setText("Short example.");
    await conditionPromise(() => editor.getElement().offsetHeight < oldHeight);
    expectFullContentHeight();
    expect(render).not.toHaveBeenCalled();
    const height = host.scrollHeight;
    component.didShow();
    expect(host.scrollHeight).toBe(height);
    expect(editor.getElement().querySelector(".line:not(.dummy)").textContent).toContain(
      "Short example.",
    );
  });

  it("reconciles wider gutter digits before sizing offscreen content", () => {
    expandHost();
    const oldGutterWidth = component.getGutterContainerWidth();
    editor.setText(Array.from({ length: 100 }, () => "long wrapped example ".repeat(8)).join("\n"));
    component.updateSync();

    expect(component.getGutterContainerWidth()).toBeGreaterThan(oldGutterWidth);
    expect(component.lineNumbersToRender.maxDigits).toBe(3);
    expectFullContentHeight();
    const height = host.scrollHeight;
    component.didShow();
    expect(host.scrollHeight).toBe(height);
  });

  it("fully measures custom gutters before sizing offscreen content", () => {
    editor.addGutter({
      name: "custom-numbers",
      type: "line-number",
      labelFn: ({ bufferRow }) => `label ${bufferRow}`,
    });
    const render = spyOn(component, "renderSync").and.callThrough();
    expandHost();

    expect(render).toHaveBeenCalled();
    expectFullContentHeight();
    const height = host.scrollHeight;
    component.didShow();
    expect(host.scrollHeight).toBe(height);
  });

  it("keeps offscreen block growth in the parent's layout", async () => {
    const item = document.createElement("div");
    item.style.height = "20px";
    const decoration = editor.decorateMarker(editor.markBufferPosition([0, 0]), {
      type: "block",
      position: "after",
      item,
    });
    expandHost();
    const oldHeight = editor.getElement().offsetHeight;
    const oldScrollHeight = host.scrollHeight;
    expect(component.heightsByBlockDecoration.get(decoration)).toBe(20);
    expect(component.visible).toBe(false);

    item.style.height = "120px";
    await conditionPromise(
      () => component.heightsByBlockDecoration.get(decoration) === 120,
      "offscreen block resize measurement",
    );
    expect(editor.getElement().offsetHeight).toBe(oldHeight + 100);
    expect(host.scrollHeight).toBe(oldScrollHeight + 100);
    expect(component.visible).toBe(false);
    component.didShow();
    expect(host.scrollHeight).toBe(oldScrollHeight + 100);
  });

  it("ignores block resize callbacks without an eligible offscreen layout", () => {
    const item = document.createElement("div");
    item.style.height = "20px";
    editor.decorateMarker(editor.markBufferPosition([0, 0]), {
      type: "block",
      position: "after",
      item,
    });
    expandHost();
    expect(editor.getElement().contains(item)).toBe(true);
    const invalidate = spyOn(component, "invalidateBlockDecorationDimensions").and.callThrough();
    const entries = [{ target: item, contentRect: { height: 120 } }];
    host.style.display = "none";
    component.didResizeBlockDecorations(entries);
    expect(invalidate).not.toHaveBeenCalled();

    host.style.display = "block";
    editor.update({ autoHeight: false });
    component.didResizeBlockDecorations(entries);
    expect(invalidate).not.toHaveBeenCalled();

    editor.update({ autoHeight: true });
    host.remove();
    component.didResizeBlockDecorations(entries);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps display:none and fixed-height editors suppressed", () => {
    const measure = spyOn(component, "measureDimensions").and.callThrough();
    component.updateSync();
    expect(measure).not.toHaveBeenCalled();
    expect(component.hasInitialMeasurements).toBe(false);

    editor.update({ autoHeight: false });
    host.style.display = "block";
    component.didResize();
    component.updateSync();
    expect(measure).not.toHaveBeenCalled();
    expect(component.hasInitialMeasurements).toBe(false);
    expect(component.visible).toBe(false);
  });
});
