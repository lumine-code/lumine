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
      lineNumberGutterVisible: false,
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
    expandHost();

    expect(component.hasInitialMeasurements).toBe(true);
    expect(editor.getElement().offsetHeight).toBeGreaterThan(component.getLineHeight());
    expectFullContentHeight();
    await conditionPromise(() => !component.visible);
    expect(setVisible.calls.allArgs().some(([visible]) => visible)).toBe(false);
    const height = host.scrollHeight;
    host.scrollTop = 1000;
    await conditionPromise(() => component.visible);
    expect(host.scrollHeight).toBe(height);
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
