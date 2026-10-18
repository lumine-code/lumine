const CSON = require("@lumine-code/season");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

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

  it("does not parse a transaction again from the post-edit microtask", async () => {
    const mode = await start("value = 1\n".repeat(1000));
    mode.syncTimeoutMicros = 0;
    const parse = spyOn(mode, "parseAsync").and.callThrough();
    editor.getBuffer().insert([0, 0], "# ");
    await editor.whenGrammarSettled();
    expect(parse.calls.count()).toBe(1);
  });

  it("cancels an already started parse when a newer revision supersedes it", async () => {
    const mode = await start("value = 1\n".repeat(1000));
    mode.syncTimeoutMicros = 0;
    let started, firstSignal;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const parse = mode.parseAsync.bind(mode);
    spyOn(mode, "parseAsync").and.callFake((language, previous, ranges, options) =>
      parse(language, previous, ranges, {
        ...options,
        onStart() {
          if (!firstSignal) {
            firstSignal = options.signal;
            started();
          }
          options.onStart?.();
        },
      }),
    );
    editor.getBuffer().append("first = 2\n");
    await entered;
    expect(firstSignal.aborted).toBe(false);
    editor.getBuffer().append("second = 3\n");
    expect(firstSignal.aborted).toBe(true);
    await mode.atGrammarSettlement();
    expect(mode.tree.input).toBe(editor.getText());
    expect(mode.parseAsync.calls.count()).toBe(2);
  });

  it("renders prepared scopes without querying and schedules newly visible fragments", async () => {
    const mode = await start('value = "text"\n'.repeat(1000));
    const layer = mode.rootLanguageLayer;
    const boundaries = spyOn(layer, "getSyntaxBoundaries").and.callThrough();
    screen();
    expect(boundaries).not.toHaveBeenCalled();
    editor.displayLayer.getScreenLines(800, 820);
    expect(boundaries).not.toHaveBeenCalled();
    await editor.whenGrammarSettled();
    expect(boundaries.calls.count()).toBeGreaterThan(0);
    boundaries.calls.reset();
    const lines = editor.displayLayer.getScreenLines(800, 820);
    expect(boundaries).not.toHaveBeenCalled();
    expect(lines[0].tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
    expect(
      mode.highlightCache.snapshots.every(
        (snapshot) => snapshot.stamp.revision === mode.tree.revision,
      ),
    ).toBe(true);
  });

  it("prepares both visible sides of a large fold without querying its hidden middle", async () => {
    const mode = await start('value = "text"\n'.repeat(3000));
    editor.displayLayer.foldBufferRange([
      [2, 0],
      [2990, 0],
    ]);
    const boundaries = spyOn(mode.rootLanguageLayer, "getSyntaxBoundaries").and.callThrough();
    const read = () => editor.displayLayer.getScreenLines(0, 10);
    read();
    expect(boundaries).not.toHaveBeenCalled();
    await mode.atGrammarSettlement();
    expect(boundaries.calls.count()).toBeGreaterThan(0);
    expect(boundaries.calls.allArgs().every(([start]) => start.row < 64 || start.row >= 2944)).toBe(
      true,
    );
    boundaries.calls.reset();
    const lines = read();
    expect(boundaries).not.toHaveBeenCalled();
    expect(lines[0].tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
    expect(lines.at(-1).tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
  });

  it("rejects staged scopes when an edit supersedes presentation preparation", async () => {
    const mode = await start('value = "text"\n'.repeat(1000));
    mode.syncTimeoutMicros = 0;
    mode.presentation.request(500, 600, false);
    const pending = mode.presentation.flush();
    editor.getBuffer().insert([500, 0], "# ");
    await pending;
    await editor.whenGrammarSettled();
    const matching = mode.highlightCache.snapshots.filter(
      (snapshot) => snapshot.start.row <= 500 && snapshot.end.row > 500,
    );
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.at(-1).stamp.revision).toBe(mode.tree.revision);
    expect(
      editor
        .scopeDescriptorForBufferPosition([500, 3])
        .getScopesArray()
        .some((scope) => scope.startsWith("comment.")),
    ).toBe(true);
  });

  it("does not recompute distant prepared fragments for a local equal-height edit", async () => {
    const mode = await start("value = 1\n".repeat(1000));
    const secondView = {};
    mode.presentation.requestRanges(editor.displayLayer, [[0, 63]], false);
    mode.presentation.requestRanges(secondView, [[500, 600]], false);
    await mode.atGrammarSettlement();
    mode.useAsyncParsing = false;
    const boundaries = spyOn(mode.rootLanguageLayer, "getSyntaxBoundaries").and.callThrough();
    editor.setTextInBufferRange(
      [
        [0, 8],
        [0, 9],
      ],
      "2",
    );
    await mode.atGrammarSettlement();
    expect(boundaries.calls.count()).toBeGreaterThan(0);
    expect(boundaries.calls.allArgs().every(([start]) => start.row < 128)).toBe(true);
    expect(mode.presentation.requestsByOwner.has(secondView)).toBe(true);
  });

  it("waits for current syntax before folding and cancels an obsolete fold command", async () => {
    const mode = await start("def work():\n    first = 1\n    return first\n");
    mode.ensureQueriesForLayersSync("foldsQuery");
    mode.syncTimeoutMicros = 0;
    editor.getBuffer().insert([1, 0], "    # comment\n");
    expect(mode.getFoldableRanges()).toEqual([]);
    expect(mode.getFoldableRangeContainingPoint([2, 0])).toBeNull();
    const pending = editor.foldBufferRow(2);
    expect(pending?.then).toBeDefined();
    await pending;
    const folds = editor.unfoldAll();
    expect(folds.length).toBe(1);
    expect(folds[0].end.row).toBe(3);
    editor.getBuffer().insert([1, 0], "    # next\n");
    const obsolete = editor.foldBufferRow(2);
    editor.unfoldAll();
    await obsolete;
    expect(editor.isFoldedAtBufferRow(0)).toBe(false);
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

  it("preserves multicursor indentation when the grammar has no indentation query", async () => {
    const source = "    first\n    second\n";
    editor.setText(source);
    const file = require.resolve("language-python/grammars/python.json");
    const config = CSON.readFileSync(file);
    const treeSitter = { ...config.treeSitter };
    delete treeSitter.indentsQuery;
    const grammar = new TreeSitterGrammar(lumine.grammars, file, {
      ...config,
      scopeName: "source.indentless-test",
      treeSitter,
    });
    const mode = new TreeSitterLanguageMode({
      buffer: editor.getBuffer(),
      grammar,
      grammars: lumine.grammars,
    });
    editor.getBuffer().setLanguageMode(mode);
    try {
      await editor.whenGrammarSettled();
      mode.useAsyncParsing = false;
      editor.setSelectedBufferRanges([
        [
          [0, 9],
          [0, 9],
        ],
        [
          [1, 10],
          [1, 10],
        ],
      ]);
      editor.insertNewline();
      expect(editor.lineTextForBufferRow(1)).toBe("    ");
      expect(editor.lineTextForBufferRow(3)).toBe("    ");
      editor.undo();
      expect(editor.getText()).toBe(source);
    } finally {
      editor.getBuffer().setLanguageMode(null);
      grammar.deactivate();
    }
  });
});
