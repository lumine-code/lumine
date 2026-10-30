const TextEditor = require("../src/text-editor");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const Tooltip = require("../src/tooltip");

describe("shared background work across presentation windows", () => {
  beforeEach(() => jasmine.useRealClock());

  it("does not park model layout on the main window's idle queue", () => {
    const idle = spyOn(window, "requestIdleCallback").and.returnValue(999);
    const editor = new TextEditor();
    try {
      expect(idle).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });

  it("uses a visible auxiliary frame and idle queue for deferred query work", () => {
    let frame, idle;
    const auxiliary = {
      closed: false,
      document: { visibilityState: "visible" },
      requestAnimationFrame: jasmine.createSpy("aux frame").and.callFake((callback) => {
        frame = callback;
        return 31;
      }),
      cancelAnimationFrame: jasmine.createSpy("aux cancel frame"),
      requestIdleCallback: jasmine.createSpy("aux idle").and.callFake((callback) => {
        idle = callback;
        return 32;
      }),
      cancelIdleCallback: jasmine.createSpy("aux cancel idle"),
    };
    const focused = spyOn(lumine.workspace, "getFocusedWindow").and.returnValue({
      getDOMWindow: () => auxiliary,
    });
    const mainFrame = spyOn(window, "requestAnimationFrame").and.returnValue(99);
    const callback = jasmine.createSpy("query compilation");
    const cancel = TreeSitterLanguageMode.prototype.scheduleAfterHighlightPaint.call(
      { destroyed: false },
      callback,
    );
    expect(mainFrame).not.toHaveBeenCalled();
    expect(auxiliary.requestAnimationFrame).toHaveBeenCalled();
    if (frame) {
      frame();
      idle();
    }
    cancel();
    expect(callback).toHaveBeenCalledTimes(1);
    // Shared DOM observers may also queue work while this test substitutes
    // presentation clocks. Retire those clocks before the environment resets.
    focused.and.callThrough();
    mainFrame.and.callThrough();
    lumine.views.setAnimationFrameWindow(null);
  });

  it("retires a queued tooltip layout before destroying its observer", async () => {
    const tooltip = new Tooltip(document.createElement("span"), { title: "Clock" }, lumine.views);
    const layout = spyOn(tooltip, "recalculatePosition");
    tooltip.handleMutations();
    tooltip.destroy();
    await lumine.views.getNextUpdatePromise();
    expect(layout).not.toHaveBeenCalled();
  });
});
