describe("Synchronous warm Tree-sitter updates", () => {
  let editor;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["language-python", "language-ipython", "language-gfm"]) {
      await lumine.packages.activatePackage(name);
    }
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, softTabs: true, tabLength: 4 });
  });
  afterEach(() => editor?.destroy());
  async function start(text) {
    editor.setText(text);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    await editor.whenGrammarSettled();
    const mode = editor.getBuffer().getLanguageMode();
    // An exhausted initial-load budget must not defer warm edits.
    mode.syncTimeoutMicros = 0;
    await new Promise((resolve) => setImmediate(resolve));
    spyOn(mode, "parseAsync").and.callThrough();
    return mode;
  }
  function current(mode) {
    expect(mode.publicationPending).toBe(false);
    expect(mode.tree.revision).toBe(editor.getBuffer().getTextRevision());
    for (const layer of mode.getAllLanguageLayers()) {
      expect(layer.tree.revision).toBe(editor.getBuffer().getTextRevision());
      expect(layer.tree.input).toBe(editor.getText());
    }
    expect(mode.parseAsync).not.toHaveBeenCalled();
  }
  it("publishes edits, undo and redo before their methods return", async () => {
    const mode = await start("value = 1\r\n");
    const previous = mode.tree;
    editor.setCursorBufferPosition([0, 5]);
    editor.insertText("_changed");
    current(mode);
    expect(previous.rootNode.text).toBe("value = 1\r\n");
    editor.undo();
    current(mode);
    expect(editor.getText()).toBe("value = 1\r\n");
    editor.redo();
    current(mode);
    expect(editor.getText()).toBe("value_changed = 1\r\n");
  });
  it("publishes comment and uncomment scopes without a promise or repaint delay", async () => {
    const mode = await start("@cdb.limit\r\ndef get(ls):\r\n    return dict(value=ls.value)\r\n");
    editor.selectAll();
    editor.toggleLineCommentsInSelection();
    current(mode);
    expect(
      editor
        .scopeDescriptorForBufferPosition([1, 2])
        .getScopesArray()
        .some((scope) => scope.startsWith("comment.")),
    ).toBe(true);
    editor.toggleLineCommentsInSelection();
    current(mode);
    expect(
      editor
        .scopeDescriptorForBufferPosition([1, 1])
        .getScopesArray()
        .some((scope) => scope.startsWith("comment.")),
    ).toBe(false);
  });
  it("updates multicursor newlines and indentation synchronously", async () => {
    const mode = await start("def first():\r\n    one = 1\r\ndef second():\r\n    two = 2\r\n");
    editor.setSelectedBufferRanges([
      [
        [1, 11],
        [1, 11],
      ],
      [
        [3, 11],
        [3, 11],
      ],
    ]);
    editor.insertNewline();
    current(mode);
    expect(editor.lineTextForBufferRow(2)).toBe("    ");
    expect(editor.lineTextForBufferRow(5)).toBe("    ");
    editor.undo();
    current(mode);
  });

  it("finishes bulk comment, uncomment and undo with current visible scopes despite a zero load budget", async () => {
    const mode = await start('value = "text"\r\n'.repeat(2000));
    editor.displayLayer.getScreenLines(800, 820);
    await editor.whenGrammarSettled();
    editor.selectAll();
    for (const commented of [true, false]) {
      editor.toggleLineCommentsInSelection();
      current(mode);
      expect(mode.presentation.promise).toBeNull();
      expect(
        editor
          .tokensForScreenRow(800)
          .some((token) => token.scopes.some((scope) => scope.includes("syntax--comment"))),
      ).toBe(commented);
    }
    editor.undo();
    current(mode);
    expect(
      editor
        .tokensForScreenRow(800)
        .some((token) => token.scopes.some((scope) => scope.includes("syntax--comment"))),
    ).toBe(true);
  });
  it("creates newly needed layers synchronously when their grammar is already loaded", async () => {
    const mode = await start(
      "# %% [markdown]\n# Heading\n# %% [raw]\n# Another\n# %%\nvalue = 1\n",
    );
    editor.setTextInBufferRange(
      [
        [2, 6],
        [2, 9],
      ],
      "markdown",
    );
    current(mode);
    expect(editor.scopeDescriptorForBufferPosition([3, 3]).getScopesArray()).toContain(
      "source.gfm",
    );
  });
  it("finishes multiline paste indentation and syntax in the same transaction", async () => {
    const original = "def work():\n    \n";
    const mode = await start(original);
    editor.setCursorBufferPosition([1, 4]);
    editor.pasteText({
      autoIndent: true,
      clipboard: { readWithMetadata: () => ({ text: "value = 1\nprint(value)\n", metadata: {} }) },
    });
    current(mode);
    expect(editor.getText()).toContain("print(value)");
    editor.undo();
    current(mode);
    expect(editor.getText()).toBe(original);
  });

  it("preserves existing indentation when a multiline paste starts after code", async () => {
    const original = "if value:\n        work()\n";
    const mode = await start(original);
    editor.setCursorBufferPosition([1, Infinity]);
    editor.pasteText({
      autoIndent: true,
      clipboard: { readWithMetadata: () => ({ text: "; next()\n other()", metadata: {} }) },
    });
    current(mode);
    expect(editor.lineTextForBufferRow(1)).toBe("        work(); next()");
    expect(editor.lineTextForBufferRow(2)).toBe(" other()");
    editor.undo();
    current(mode);
    expect(editor.getText()).toBe(original);
  });
});
