const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Large-buffer syntax update policy", () => {
  it("does not capture text for cancelled or superseded coalesced ranges", async () => {
    jasmine.useRealClock();
    let revision = 1;
    const mode = Object.create(TreeSitterLanguageMode.prototype);
    Object.assign(mode, {
      deferLargeBufferUpdates: true,
      coalesceLargeBufferEdits: true,
      lastLargeBufferEditAt: performance.now(),
      buffer: { getLength: () => 600000, getTextRevision: () => revision },
      document: { capture: jasmine.createSpy("capture") },
    });
    const controller = new AbortController();
    const cancelled = mode.parseAsync({}, {}, [], { signal: controller.signal });
    controller.abort();
    expect(await cancelled).toBe(null);
    mode.lastLargeBufferEditAt = performance.now();
    const superseded = mode.parseAsync({}, {}, []);
    revision++;
    expect(await superseded).toBe(null);
    expect(mode.document.capture).not.toHaveBeenCalled();
  });

  it("requires repeated expensive updates and leaves small buffers synchronous", () => {
    let length = 600000;
    const mode = Object.create(TreeSitterLanguageMode.prototype);
    Object.assign(mode, {
      useAsyncParsing: true,
      synchronousUpdates: true,
      buffer: { getLength: () => length },
    });
    mode.recordSynchronousUpdate(50);
    expect(mode.shouldParseSynchronously()).toBe(true);
    mode.recordSynchronousUpdate(1);
    mode.recordSynchronousUpdate(50);
    expect(mode.shouldParseSynchronously()).toBe(true);
    mode.recordSynchronousUpdate(50);
    expect(mode.shouldParseSynchronously()).toBe(false);
    length = 100;
    expect(mode.shouldParseSynchronously()).toBe(true);
    length = 600000;
    mode.useAsyncParsing = false;
    expect(mode.shouldParseSynchronously()).toBe(true);
  });

  it("publishes the latest edited revision and restores it through undo", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const editor = await lumine.workspace.open();
    const original = "const value = 1;\n".repeat(34000);
    editor.setText(original);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
    editor.update({ undoGroupingInterval: 0, autoIndent: false });
    await editor.whenGrammarSettled();
    const mode = editor.getBuffer().getLanguageMode();
    mode.recordSynchronousUpdate(30);
    mode.recordSynchronousUpdate(30);
    expect(mode.shouldParseSynchronously()).toBe(false);
    editor.setCursorBufferPosition([17000, 0]);
    const capture = spyOn(mode.document, "capture").and.callThrough();
    editor.insertText(" ", { autoIndent: false });
    // The first edit after a pause still starts immediately.
    expect(capture).toHaveBeenCalled();
    await editor.whenGrammarSettled();
    editor.undo();
    await editor.whenGrammarSettled();
    const acquire = spyOn(mode, "acquireParserForLanguage").and.callThrough();
    for (let i = 0; i < 10; i++) {
      editor.insertText(" ", { autoIndent: false });
      // Let cancellation and update continuations run, without waiting for
      // the quiet-period timer. No obsolete native parse should start.
      if (i > 0) {
        await Promise.resolve();
        await Promise.resolve();
      }
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(mode.publicationPending).toBe(true);
    await editor.whenGrammarSettled();
    expect(acquire).toHaveBeenCalled();
    expect(mode.tree.revision).toBe(editor.getBuffer().getTextRevision());
    expect(mode.tree.input).toBe(editor.getText());
    for (let i = 0; i < 10; i++) editor.undo();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe(original);
    expect(mode.tree.input).toBe(original);
    editor.insertText(" ", { autoIndent: false });
    const settled = editor.whenGrammarSettled();
    editor.destroy();
    expect(await settled).toBe(false);
  }, 30000);

  it("keeps grouped Python newline indentation and cancels it after immediate undo", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    const editor = await lumine.workspace.open();
    const original = "value = 1\n".repeat(60000) + "def work():\n    value = 1\n    return value\n";
    editor.setText(original);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.python"));
    editor.update({ undoGroupingInterval: 10000, autoIndent: true });
    const settle = async () => {
      await editor.whenGrammarSettled();
      await editor.autoIndentAtTransactionEndPromise;
      await editor.whenGrammarSettled();
    };
    try {
      await settle();
      const mode = editor.getBuffer().getLanguageMode();
      mode.recordSynchronousUpdate(30);
      mode.recordSynchronousUpdate(30);
      editor.getBuffer().clearUndoStack();
      editor.setCursorBufferPosition([60001, 13]);
      for (let i = 0; i < 12; i++) editor.insertNewline({ groupUndo: true });
      await settle();
      expect(editor.getLineCount()).toBe(original.split("\n").length + 12);
      expect(editor.getCursorBufferPosition().column).toBe(4);
      expect(mode.tree.input).toBe(editor.getText());
      editor.undo();
      await settle();
      expect(editor.getText()).toBe(original);
      for (let i = 0; i < 12; i++) editor.insertNewline({ groupUndo: true });
      editor.undo();
      await settle();
      expect(editor.getText()).toBe(original);
    } finally {
      editor.destroy();
    }
  }, 30000);
});
