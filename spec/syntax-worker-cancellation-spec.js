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
    spyOn(mode, "scanPreparedIndentation").and.callFake(() =>
      (async function* () {
        attempts++;
        yield await Promise.reject(abort());
      })(),
    );
    const before = editor.getText();
    await editor.insertNewline();
    expect(attempts).toBe(1);
    expect(editor.getText()).toBe(before);
    expect(editor.hasPendingIndentation()).toBe(false);
  });

  it("discards queued edits with their cancelled preparation without retrying stale syntax", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let attempts = 0;
    spyOn(mode, "scanPreparedIndentation").and.callFake(() =>
      (async function* () {
        attempts++;
        await gate;
        yield await Promise.reject(abort());
      })(),
    );
    const before = editor.getText();
    const newline = editor.insertNewline();
    const typing = editor.insertText("next = 2");
    release();
    await Promise.all([newline, typing]);
    expect(attempts).toBe(1);
    expect(editor.getText()).toBe(before);
  });

  for (const action of ["undo", "undo-redo", "grammar", "destroy", "readOnly"]) {
    it(`discards delayed indentation after ${action} and releases its markers`, async () => {
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      spyOn(mode, "scanPreparedIndentation").and.callFake(() =>
        (async function* () {
          await gate;
          yield [[2, 3]];
        })(),
      );
      const pending = editor.insertNewline();
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
      expect(editor.hasPendingIndentation()).toBe(false);
    });
  }

  it("retains an explicit read-only bypass through delayed newline indentation", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    spyOn(mode, "scanPreparedIndentation").and.callFake(() =>
      (async function* () {
        await gate;
        yield [[2, 2]];
      })(),
    );
    editor.setReadOnly(true);
    const pending = editor.insertNewline({ bypassReadOnly: true });
    release(new Map([[2, 2]]));
    await pending;
    expect(editor.lineTextForBufferRow(2)).toBe("        ");
  });
});
