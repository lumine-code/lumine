const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const NullMode = require("../src/null-language-mode");

describe("Syntax worker cancellation boundaries", () => {
  let service, editor, mode;
  const abort = () => Object.assign(new Error("Cancelled syntax request"), { name: "AbortError" });
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    service = new Service(lumine.grammars);
    editor = lumine.workspace.buildTextEditor({ autoIndent: true, tabLength: 4, softTabs: true });
    editor.setText("def work():\n    value = 1");
    mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.python"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    await mode.ready;
    await mode.refresh();
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
    editor.setCursorBufferPosition([1, Infinity]);
    editor.getBuffer().clearUndoStack();
  });
  afterEach(() => {
    editor.destroy();
    service.dispose();
  });

  it("does not start presentation requests after the service closes", async () => {
    service.dispose();
    mode.cache.clear();
    const request = service.request.bind(service);
    let attempts = 0;
    const spy = spyOn(service, "request").and.callFake((...args) => {
      // Bound the broken implementation so a regression fails instead of
      // trapping the test window in an infinite microtask retry loop.
      if (++attempts > 3) throw new Error("Presentation retry loop");
      return request(...args);
    });
    await expectAsync(mode.refresh()).toBeResolved();
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops a pending presentation when its session closes", async () => {
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const started = new Promise((resolve) => (entered = resolve));
    const request = service.request.bind(service);
    let attempts = 0;
    spyOn(service, "request").and.callFake(async (...args) => {
      if (++attempts > 3) throw new Error("Presentation retry loop");
      entered();
      await gate;
      return request(...args);
    });
    mode.cache.clear();
    const pending = mode.refresh();
    try {
      await started;
      service.dispose();
    } finally {
      release();
    }
    await expectAsync(pending).toBeResolved();
    expect(attempts).toBe(1);
    expect(mode.refreshPromise).toBeNull();
  });

  it("does not retry a terminal worker error even when it is an AbortError", async () => {
    const failure = abort();
    service.terminalError = failure;
    const request = service.request.bind(service);
    let attempts = 0;
    spyOn(service, "request").and.callFake((...args) => {
      if (++attempts > 3) throw new Error("Terminal retry loop");
      return request(...args);
    });
    await expectAsync(service.settle(mode.session)).toBeRejectedWith(failure);
    mode.cache.clear();
    await expectAsync(mode.refresh()).toBeResolved();
    expect(attempts).toBe(1);
  });

  it("does not retry a cancelled indentation request against unchanged syntax", async () => {
    let attempts = 0;
    spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.callFake(async () => {
      if (++attempts <= 3) throw abort();
      return new Map([[2, 0]]);
    });
    editor.insertNewline();
    const afterEnter = editor.getText();
    const markers = [...editor.pendingNewlineIndentIntent.markers];
    await editor.autoIndentAtTransactionEndPromise;
    expect(attempts).toBe(1);
    expect(editor.getText()).toBe(afterEnter);
    expect(editor.pendingNewlineIndentIntent).toBeNull();
    expect(markers.every((marker) => marker.isDestroyed())).toBe(true);
  });

  it("replans a cancelled indentation request when typing advances its revision", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const suggest = mode.suggestedIndentForBufferRowsAtRows.bind(mode);
    let attempts = 0;
    spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.callFake(async (...args) => {
      if (++attempts === 1) {
        await gate;
        throw abort();
      }
      return suggest(...args);
    });
    editor.insertNewline();
    editor.insertText("next = 2");
    release();
    await editor.whenGrammarSettled();
    expect(attempts).toBe(2);
    expect(editor.getText()).toBe("def work():\n    value = 1\n    next = 2");
  });

  for (const action of ["undo", "undo-redo", "grammar", "destroy", "readOnly"]) {
    it(`discards delayed indentation after ${action} and releases its markers`, async () => {
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.returnValue(gate);
      editor.insertNewline();
      const markers = [...editor.pendingNewlineIndentIntent.markers];
      const pending = editor.autoIndentAtTransactionEndPromise;
      if (action.startsWith("undo")) editor.undo();
      if (action === "undo-redo") editor.redo();
      if (action === "grammar")
        editor.getBuffer().setLanguageMode(new NullMode({ buffer: editor.getBuffer() }));
      if (action === "readOnly") editor.setReadOnly(true);
      const expected = editor.getText();
      if (action === "destroy") editor.destroy();
      release(new Map([[2, 3]]));
      await pending;
      if (action !== "destroy") expect(editor.getText()).toBe(expected);
      expect(editor.pendingNewlineIndentIntent).toBeNull();
      expect(markers.every((marker) => marker.isDestroyed())).toBe(true);
    });
  }

  it("retains an explicit read-only bypass through delayed newline indentation", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.returnValue(gate);
    editor.setReadOnly(true);
    editor.insertNewline({ bypassReadOnly: true });
    const pending = editor.autoIndentAtTransactionEndPromise;
    release(new Map([[2, 2]]));
    await pending;
    expect(editor.lineTextForBufferRow(2)).toBe("        ");
  });
});
