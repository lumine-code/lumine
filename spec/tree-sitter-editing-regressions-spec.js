describe("Tree-sitter editing and history", () => {
  let editor;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-ipython");
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, undoGroupingInterval: 10000 });
  });
  afterEach(() => editor?.destroy());

  async function settle() {
    await editor.whenGrammarSettled();
    await editor.autoIndentAtTransactionEndPromise;
    await editor.whenGrammarSettled();
  }
  async function start(text) {
    editor.setText(text);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    await settle();
    editor.getBuffer().historyProvider.clearUndoStack();
  }
  const screen = () =>
    editor.displayLayer
      .getScreenLines(0, editor.getScreenLineCount())
      .map((line) => ({ text: line.lineText, tags: [...line.tags] }));

  it("keeps repeated spaces grouped across asynchronous indentation checks", async () => {
    const original = "value = 1\n";
    await start(original);
    editor.setCursorBufferPosition([0, 9]);
    for (let i = 0; i < 4; i++) {
      editor.insertText(" ", { groupUndo: true });
      await settle();
    }
    expect(editor.getText()).toBe("value = 1    \n");
    editor.undo();
    await settle();
    expect(editor.getText()).toBe(original);
  });

  it("groups repeated newline commands including asynchronous indentation", async () => {
    const original = "def work():\n    value = 1\n";
    await start(original);
    editor.setCursorBufferPosition([1, 13]);
    for (let i = 0; i < 4; i++) {
      lumine.commands.dispatch(editor.getElement(), "editor:newline");
      await settle();
    }
    expect(editor.getLineCount()).toBe(7);
    editor.undo();
    await settle();
    expect(editor.getText()).toBe(original);
  });

  it("restores rendered highlights after multicursor newlines and undo", async () => {
    const original =
      "# %% First\r\nvalue = 1\r\nprint(r'''hello\r\nworld''')\r\n# %% Next\r\nother = 2\r\nprint('done')\r\n";
    await start(original);
    const before = screen();
    editor.setSelectedBufferRanges([
      [
        [1, 0],
        [1, 0],
      ],
      [
        [5, 0],
        [5, 0],
      ],
      [
        [6, 0],
        [6, 0],
      ],
    ]);
    editor.insertNewline();
    screen();
    await settle();
    editor.undo();
    screen();
    await settle();
    expect(editor.getText()).toBe(original);
    const mode = editor.getBuffer().getLanguageMode();
    expect(mode.tree).toBeTruthy();
    for (const layer of mode.getAllLanguageLayers()) expect(layer.tree).toBeTruthy();
    expect(screen()).toEqual(before);
  });

  it("restores highlights when a burst is undone before parsing completes", async () => {
    const original = "# %% First\r\nvalue = 1\r\n# %% Next\r\nother = 2\r\n";
    await start(original);
    const before = screen();
    editor.setSelectedBufferRanges([
      [
        [1, 0],
        [1, 0],
      ],
      [
        [3, 0],
        [3, 0],
      ],
    ]);
    for (let i = 0; i < 20; i++) {
      editor.insertText(" ", { groupUndo: true });
      screen();
    }
    editor.undo();
    screen();
    await settle();
    expect(editor.getText()).toBe(original);
    expect(screen()).toEqual(before);
  });

  it("does not apply delayed indentation after a newline burst has been undone", async () => {
    const original = "def work():\r\n    value = 1\r\n    return value\r\n";
    await start(original);
    const before = screen();
    editor.setCursorBufferPosition([1, 13]);
    for (let i = 0; i < 12; i++) {
      lumine.commands.dispatch(editor.getElement(), "editor:newline");
      screen();
    }
    editor.undo();
    screen();
    await settle();
    expect(editor.getText()).toBe(original);
    expect(screen()).toEqual(before);
  });

  it("reuses fold query windows when commenting and uncommenting a whole document", async () => {
    const original = "# %% Code\n" + "value = max(1, 2)\n".repeat(1800);
    await start(original);
    const mode = editor.getBuffer().getLanguageMode();
    mode.ensureQueriesForLayersSync("foldsQuery");
    const layer = mode
      .getAllInjectionLayers()
      .find((item) => item.grammar.scopeName === "source.python");
    const query = layer.queries.foldsQuery;
    spyOn(query, "captures").and.callThrough();
    for (let i = 0; i < 2; i++) {
      query.captures.calls.reset();
      editor.selectAll();
      editor.toggleLineCommentsInSelection();
      await settle();
      // Off-screen fold warming is optional under the shared budget. Ask for
      // the viewport's folds before checking reuse of their query windows.
      for (let row = 0; row < 80; row++) mode.isFoldableAtRowForRendering(row);
      expect(query.captures.calls.count()).toBeGreaterThan(0);
      expect(query.captures.calls.count()).toBeLessThan(20);
    }
    expect(editor.getText()).toBe(original);
  });

  it("publishes commented Python scopes before the editing command returns", async () => {
    const original = [
      "@cdb.limit",
      "def get(ls):",
      "    item = sof.limit(ls).find(",
      "        name = 'nodes_dissup',",
      "        idcs = [11975],",
      "        comp = lambda b, i: b.d_z < i.d_z,",
      "        grps = [21, 22, 23, 24],",
      "    )",
      "    v_max = ls.meta['val']/3.6 if ls.meta['val']>2 else dyn.parsed['t',1,1].v_max",
      "    return dict(d_z_Ed=item.d_z, v_max=v_max)",
      "",
    ].join("\r\n");
    await start(original);
    screen();
    const mode = editor.getBuffer().getLanguageMode();
    mode.syncTimeoutMicros = 1000000;
    await new Promise((resolve) => setImmediate(resolve));
    spyOn(mode, "parseAsync").and.callThrough();
    editor.selectAll();
    editor.toggleLineCommentsInSelection();
    expect(mode.parseAsync).not.toHaveBeenCalled();
    expect(mode.publicationPending).toBe(false);
    const painted = screen().filter((line) => line.text.trim());
    expect(painted.length).toBe(10);
    for (const line of painted)
      expect(line.tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
    for (let row = 0; row < 10; row++) {
      const column = editor.lineTextForBufferRow(row).indexOf("#");
      const scopes = editor.scopeDescriptorForBufferPosition([row, column]).getScopesArray();
      expect(scopes.some((scope) => scope.startsWith("comment."))).toBe(true);
    }
  });
});
