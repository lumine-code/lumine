const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const { Point, Range } = require("../src/text-buffer");

describe("Prepared scroll presentation", () => {
  it("keeps text and scopes together while newer native thumb destinations arrive", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor({ autoHeight: false });
    editor.setText("const value = 1;\n".repeat(300));
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      service,
      grammar: lumine.grammars.grammarForScopeName("source.js"),
    });
    editor.getBuffer().setLanguageMode(mode);
    const element = editor.getElement();
    element.style.cssText = "height:200px;width:800px";
    try {
      await mode.ready;
      const owner = {};
      mode.requestHighlighting(owner, [[0, 299]], false, { priority: 0, prefetch: false });
      await mode.refresh();
      mode.requestHighlighting(owner, [], false);
      const copy = (first, last) =>
        mode.cache.captureRange(new Point(first, 0), new Point(last, 0), new Point(first, 0), []);
      const initial = copy(0, 30),
        first = copy(90, 130),
        last = copy(190, 230);
      const stamp = {
        revision: editor.getBuffer().getTextRevision(),
        generation: mode.session.generation,
        presentation: mode.presentationVersion,
      };
      spyOn(mode, "schedule");
      clearTimeout(mode.timer);
      mode.timer = null;
      mode.cache.clear();
      mode.cache.replace(initial, stamp);
      jasmine.attachToDOM(element);
      element.setUpdatedSynchronously(true);
      const c = element.component,
        height = c.getLineHeight();
      c.updateSync();
      c.didScrollDummyScrollbar({ orientation: "vertical", position: 100 * height });
      c.didScrollDummyScrollbar({ orientation: "vertical", position: 200 * height });
      expect(c.getScrollTop()).toBe(0);
      expect(c.getRequestedScrollTop()).toBe(200 * height);
      let settled = false;
      const completion = c.getNextUpdatePromise().then(() => (settled = true));
      mode.cache.replace(first, stamp);
      mode.emitter.emit("did-change-highlighting", new Range([90, 0], [129, Infinity]));
      c.scrollPresentation.flush();
      expect(c.getScrollTop()).toBe(100 * height);
      expect(element.querySelectorAll(".syntax--constant").length).toBeGreaterThan(0);
      await Promise.resolve();
      expect(settled).toBeFalse();
      mode.cache.replace(last, stamp);
      mode.emitter.emit("did-change-highlighting", new Range([190, 0], [229, Infinity]));
      c.scrollPresentation.flush();
      await completion;
      expect(c.getScrollTop()).toBe(200 * height);
      expect(element.querySelectorAll(".syntax--constant").length).toBeGreaterThan(0);
      expect(mode.requestsByOwner.get(c.scrollPresentation.readyOwner).ranges).toEqual([]);
    } finally {
      editor.destroy();
      element.remove();
      service.dispose();
    }
  });
});
