const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Large-buffer syntax update policy", () => {
  it("does not postpone queued root work on retries and bypasses it in synchronous mode", () => {
    const mode = Object.create(TreeSitterLanguageMode.prototype);
    Object.assign(mode, {
      useAsyncParsing: true,
      deferLargeBufferUpdates: true,
      coalesceLargeBufferEdits: true,
      lastLargeBufferEditAt: performance.now(),
      buffer: { getLength: () => 600000 },
    });
    try {
      const pending = mode.waitForRootUpdate();
      const timer = mode.pendingRootUpdateTimer;
      expect(timer).not.toBeNull();
      expect(mode.waitForRootUpdate()).toBe(pending);
      expect(mode.pendingRootUpdateTimer).toBe(timer);
      mode.useAsyncParsing = false;
      expect(mode.waitForRootUpdate()).toBeNull();
    } finally {
      mode.cancelPendingRootUpdate();
    }
  });

  it("cancels queued root work when the editor closes", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const editor = await lumine.workspace.open();
    editor.setText("const value = 1;\n".repeat(34000));
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
    await editor.whenGrammarSettled();
    const mode = editor.getBuffer().getLanguageMode();
    mode.recordSynchronousUpdate(30);
    mode.lastLargeBufferEditAt = performance.now();
    editor.insertText(" ");
    expect(mode.pendingRootUpdateTimer).not.toBeNull();
    const parse = spyOn(mode, "parseAsync").and.callThrough();
    const settled = editor.whenGrammarSettled();
    editor.destroy();
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(mode.pendingRootUpdateTimer).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  }, 30000);

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

  it("budgets large buffers immediately and leaves small buffers synchronous", () => {
    let length = 600000;
    const mode = Object.create(TreeSitterLanguageMode.prototype);
    Object.assign(mode, {
      useAsyncParsing: true,
      synchronousUpdates: true,
      buffer: { getLength: () => length },
    });
    expect(mode.shouldBudgetSynchronousParse()).toBe(true);
    expect(mode.shouldParseSynchronously()).toBe(true);
    mode.recordSynchronousUpdate(50);
    expect(mode.shouldParseSynchronously()).toBe(false);
    length = 100;
    expect(mode.shouldBudgetSynchronousParse()).toBe(false);
    expect(mode.shouldParseSynchronously()).toBe(true);
    length = 600000;
    mode.useAsyncParsing = false;
    expect(mode.shouldBudgetSynchronousParse()).toBe(false);
    expect(mode.shouldParseSynchronously()).toBe(true);
  });

  it("defers repeated moderate syntax costs while preserving cheap synchronous updates", () => {
    let length = 600000;
    const mode = Object.create(TreeSitterLanguageMode.prototype);
    Object.assign(mode, {
      useAsyncParsing: true,
      synchronousUpdates: true,
      buffer: { getLength: () => length },
    });
    mode.recordSynchronousUpdate(1);
    expect(mode.shouldParseSynchronously()).toBeTrue();
    mode.recordSynchronousUpdate(6);
    expect(mode.shouldParseSynchronously()).toBeFalse();
    length = 100;
    expect(mode.shouldParseSynchronously()).toBeTrue();
    length = 600000;
    mode.useAsyncParsing = false;
    expect(mode.shouldParseSynchronously()).toBeTrue();
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
    const parse = spyOn(mode, "parseAsync").and.callThrough();
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
    // One initial job can already have been submitted by the transaction
    // boundary. Subsequent edits must share its wait instead of resubmitting.
    expect(parse.calls.count()).toBeLessThanOrEqual(1);
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

  it("keeps block indentation when text follows a deferred newline immediately", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    const editor = await lumine.workspace.open();
    const original = "value = 1\n".repeat(60000) + "def work():\n    if value:\n";
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
      mode.recordSynchronousUpdate(6);
      editor.getBuffer().clearUndoStack();
      editor.setCursorBufferPosition([60001, 13]);
      editor.insertNewline({ groupUndo: true });
      editor.insertText("return value", { groupUndo: true });
      await settle();
      expect(editor.lineTextForBufferRow(60002)).toBe("        return value");
      expect(mode.tree.input).toBe(editor.getText());
      editor.undo();
      await settle();
      expect(editor.getText()).toBe(original);
    } finally {
      editor.destroy();
    }
  }, 30000);
});

it("replays from one error-free root checkpoint and releases it when history is unavailable", async () => {
  jasmine.useRealClock();
  await lumine.packages.activatePackage("language-javascript");
  const editor = await lumine.workspace.open();
  const original = "export function value() { return 1; }\n".repeat(18000);
  editor.setText(original);
  editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
  editor.update({ autoIndent: false, undoGroupingInterval: 0 });
  await editor.whenGrammarSettled();
  const mode = editor.getBuffer().getLanguageMode(),
    layer = mode.rootLanguageLayer;
  const first = layer.errorFreeTree;
  try {
    expect(first).toBe(mode.tree);
    expect(first.rootNode.hasError).toBe(false);
    mode.recordSynchronousUpdate(30);
    mode.recordSynchronousUpdate(30);
    editor.setCursorBufferPosition([17000, 0]);
    editor.insertText("a");
    await editor.whenGrammarSettled();
    expect(layer.backgroundHasErrors).toBe(true);
    expect(layer.errorFreeTree).toBe(first);
    const displayedRevision = mode.tree.revision;
    const { Tree } = require("web-tree-sitter");
    const comparisons = spyOn(Tree.prototype, "getChangedRanges").and.callThrough();
    const capture = spyOn(mode.document, "capture").and.callThrough();
    for (let i = 0; i < 200; i++) editor.insertText(i % 12 === 11 ? " " : "a");
    await editor.whenGrammarSettled();
    expect(capture.calls.allArgs().some((args) => args[0] === first)).toBe(true);
    expect(mode.tree.incremental).toBe(true);
    expect(mode.parseDetails.get(mode.tree).incremental).toBe(true);
    expect(mode.parseDetails.get(mode.tree).changedRanges).toBeDefined();
    expect(mode.tree.changedRangesBaseRevision).toBe(displayedRevision);
    expect(comparisons.calls.count()).toBe(1);
    const Parser = require("../src/tree-sitter-parser");
    const reference = new Parser(mode.tree.language);
    try {
      expect(mode.tree.rootNode.toString()).toBe(
        reference.parseSync(editor.getBuffer().getTextSnapshot()).rootNode.toString(),
      );
    } finally {
      reference.close();
    }
    editor.getBuffer().delete([
      [17000, 0],
      [17000, 201],
    ]);
    await editor.whenGrammarSettled();
    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(
      mode.parseDetails
        .get(mode.tree)
        .changedRanges.some(
          (range) => range.startPosition.row <= 17000 && range.endPosition.row >= 17000,
        ),
    ).toBe(true);
    expect(layer.errorFreeTree).toBe(mode.tree);
    expect(first.input).toBe(original);
    editor.setCursorBufferPosition([17000, 0]);
    editor.insertText("a");
    await editor.whenGrammarSettled();
    mode.document.clearHistory();
    editor.insertText("a");
    await editor.whenGrammarSettled();
    expect(layer.errorFreeTree).toBe(null);
    expect(mode.tree.input).toBe(editor.getText());
  } finally {
    editor.destroy();
  }
  expect(layer.errorFreeTree).toBe(null);
}, 30000);

it("budgets the first large edit and resumes the same native job and parser lease", async () => {
  jasmine.useRealClock();
  await lumine.packages.activatePackage("language-javascript");
  const editor = await lumine.workspace.open();
  editor.setText("export function value() { return 1; }\n".repeat(18000));
  editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
  editor.update({ autoIndent: false });
  await editor.whenGrammarSettled();
  await new Promise(setImmediate);
  const mode = editor.getBuffer().getLanguageMode();
  const parser = mode.getOrCreateParserForLanguage(mode.rootLanguage);
  const nativeParse = parser.parser.parse.bind(parser.parser),
    inputs = [];
  let interrupted = false;
  spyOn(parser.parser, "parse").and.callFake((input, old, options) => {
    inputs.push(input);
    return nativeParse(input, old, {
      ...options,
      progressCallback: (state) => {
        if (!interrupted) {
          interrupted = true;
          return true;
        }
        return options.progressCallback(state);
      },
    });
  });
  const acquire = spyOn(mode, "acquireParserForLanguage").and.callThrough();
  const release = spyOn(mode, "releaseParserForLanguage").and.callThrough();
  const capture = spyOn(mode.document, "capture").and.callThrough();
  try {
    expect(mode.deferLargeBufferUpdates).not.toBe(true);
    editor.setCursorBufferPosition([17000, 0]);
    editor.insertText("a", { autoIndent: false });
    expect(mode.shouldParseSynchronously()).toBe(false);
    expect(mode.publicationPending).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await editor.whenGrammarSettled();
    expect(interrupted).toBe(true);
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every((input) => input === inputs[0])).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mode.tree.input).toBe(editor.getText());
    expect(mode.tree.revision).toBe(editor.getBuffer().getTextRevision());
  } finally {
    editor.destroy();
  }
}, 30000);

it("returns a queued first-edit lease after cancellation without starting another parse", async () => {
  jasmine.useRealClock();
  const scheduler = require("../src/tree-sitter-scheduler"),
    releases = [];
  const blockers = Array.from({ length: scheduler.concurrency }, () =>
    scheduler.run(() => new Promise((resolve) => releases.push(resolve))),
  );
  await new Promise(setImmediate);
  const parser = {
    pending: {},
    tryParseSync: jasmine.createSpy("try").and.returnValue(null),
    parse: jasmine.createSpy("parse"),
    reset() {
      this.pending = null;
    },
  };
  const mode = Object.assign(Object.create(TreeSitterLanguageMode.prototype), {
    useAsyncParsing: true,
    syncTimeoutMicros: 5000,
    buffer: { getLength: () => 600000 },
    document: { capture: () => ({ text: "text", revision: 1, previous: null, edits: [] }) },
    backgroundSnapshots: new WeakSet(),
    parseDetails: new WeakMap(),
    acquireParserForLanguage: () => parser,
    releaseParserForLanguage: jasmine.createSpy("release"),
  });
  try {
    const controller = new AbortController();
    const pending = mode.parse({}, null, null, { resumable: true, signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(null);
    expect(parser.parse).not.toHaveBeenCalled();
    expect(parser.pending).toBe(null);
    expect(mode.releaseParserForLanguage).toHaveBeenCalledTimes(1);
  } finally {
    releases.forEach((resolve) => resolve());
    await Promise.all(blockers);
  }
});

it("budgets the first newline and preserves deferred indentation and undo", async () => {
  jasmine.useRealClock();
  await lumine.packages.activatePackage("language-python");
  const editor = await lumine.workspace.open();
  const original = "value = 1\n".repeat(60000) + "def work():\n    return 1\n";
  editor.setText(original);
  editor.setGrammar(lumine.grammars.grammarForScopeName("source.python"));
  editor.update({ autoIndent: true, undoGroupingInterval: 10000 });
  await editor.whenGrammarSettled();
  const mode = editor.getBuffer().getLanguageMode();
  try {
    expect(mode.deferLargeBufferUpdates).not.toBe(true);
    mode.syncTimeoutMicros = 0;
    mode.editTimeoutMicros = 0;
    editor.getBuffer().clearUndoStack();
    editor.setCursorBufferPosition([60000, 11]);
    editor.insertNewline({ groupUndo: true });
    expect(mode.shouldParseSynchronously()).toBe(false);
    await editor.whenGrammarSettled();
    await editor.autoIndentAtTransactionEndPromise;
    await editor.whenGrammarSettled();
    expect(editor.getCursorBufferPosition().column).toBe(4);
    expect(mode.tree.input).toBe(editor.getText());
    editor.undo();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe(original);
  } finally {
    editor.destroy();
  }
}, 30000);
