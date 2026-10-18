describe("Tree-sitter update budgets", () => {
  let editor;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
  });
  afterEach(() => editor?.destroy());
  async function start(text) {
    editor.setText(text);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python");
    await editor.whenGrammarSettled();
    return editor.getBuffer().getLanguageMode();
  }
  const screen = () =>
    editor.displayLayer.getScreenLines(0, Math.min(10, editor.getScreenLineCount()));

  it("retains painted scopes until a budgeted update can publish current syntax", async () => {
    const mode = await start('def work():\n    return "value"\n');
    const painted = screen();
    expect(painted[1].tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
    mode.syncTimeoutMicros = 0;
    editor.selectAll();
    editor.toggleLineCommentsInSelection();
    expect(mode.publicationPending).toBe(true);
    expect(mode.tree).toBeNull();
    expect(screen()[1].tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
    await editor.whenGrammarSettled();
    expect(mode.publicationPending).toBe(false);
    expect(
      editor
        .scopeDescriptorForBufferPosition([1, 2])
        .getScopesArray()
        .some((scope) => scope.startsWith("comment.")),
    ).toBe(true);
    editor.undo();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe('def work():\n    return "value"\n');
  });

  it("publishes only the newest revision when another edit supersedes queued work", async () => {
    const mode = await start("value = 1\n".repeat(1000));
    mode.syncTimeoutMicros = 0;
    const published = [];
    mode.onDidChangeHighlighting(() => {
      if (mode.tree) published.push(mode.tree.revision);
    });
    editor.getBuffer().append("first = 2\n");
    editor.getBuffer().append("second = 3\n");
    const revision = editor.getBuffer().getTextRevision();
    await editor.whenGrammarSettled();
    expect(mode.tree.revision).toBe(revision);
    expect(mode.tree.input).toBe(editor.getText());
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((value) => value === revision)).toBe(true);
  });

  it("plans multicursor newline indentation without parsing once per cursor", async () => {
    const source = Array.from(
      { length: 100 },
      (_, i) => `def work_${i}():\n    return ${i}\n`,
    ).join("");
    const mode = await start(source);
    mode.useAsyncParsing = false;
    const parse = spyOn(mode, "parse").and.callThrough();
    editor.setSelectedBufferRanges(
      Array.from({ length: 8 }, (_, i) => {
        const row = i * 20,
          column = editor.lineTextForBufferRow(row).length;
        return [
          [row, column],
          [row, column],
        ];
      }),
    );
    editor.insertNewline();
    expect(parse.calls.count()).toBeLessThanOrEqual(2);
    for (const cursor of editor.getCursors())
      expect(editor.lineTextForBufferRow(cursor.getBufferRow())).toBe("    ");
    editor.undo();
    expect(editor.getText()).toBe(source);
  });

  it("reuses raw highlight captures while still reevaluating scope predicates", async () => {
    const mode = await start("value = 1\n");
    const layer = mode.rootLanguageLayer;
    const query = layer.queries.highlightsQuery;
    const capture = spyOn(query, "captures").and.callThrough();
    layer.getSyntaxBoundaries({ row: 0, column: 1 }, { row: 0, column: 8 });
    const calls = capture.calls.count();
    layer.getSyntaxBoundaries({ row: 0, column: 1 }, { row: 0, column: 8 });
    expect(capture.calls.count()).toBe(calls);
    expect(calls).toBe(1);
  });

  it("discards an asynchronous indentation hint after another text revision", async () => {
    await start("value = 1\nnext = 2\n");
    let resolve;
    spyOn(editor, "suggestedIndentForBufferRow").and.returnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = editor.autoIndentBufferRow(1);
    editor.getBuffer().append("later = 3\n");
    resolve(4);
    await pending;
    await editor.whenGrammarSettled();
    expect(editor.lineTextForBufferRow(1)).toBe("next = 2");
    editor.undo();
    expect(editor.getText()).toBe("value = 1\nnext = 2\n");
  });
});
