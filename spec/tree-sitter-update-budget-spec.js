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

  it("repaints a stationary viewport after bulk comments yield while measuring an offscreen line", async () => {
    const mode = await start('value = "text"\n'.repeat(2000));
    const draw = () => {
      editor.displayLayer.getScreenLines(800, 820);
      const tokens = editor.tokensForScreenRow(800);
      // The component measures its longest line after requesting the view.
      editor.screenLineForScreenRow(0);
      return tokens;
    };
    draw();
    await editor.whenGrammarSettled();
    let painted = draw();
    mode.syncTimeoutMicros = 0;
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
    let paintTask = null;
    const subscription = editor.onDidChange(() => {
      if (paintTask) return;
      paintTask = setImmediate(() => {
        paintTask = null;
        painted = draw();
      });
    });
    try {
      editor.selectAll();
      for (const commented of [true, false]) {
        editor.toggleLineCommentsInSelection();
        // No settlement API or extra screen read: only regular change events
        // can refresh the recorded paint. Bound a scheduling loop on failure.
        for (let i = 0; i < 200; i++) {
          await new Promise((resolve) => setImmediate(resolve));
          if (
            !mode.publicationPending &&
            !mode.presentation.promise &&
            !mode.presentation.timer &&
            !paintTask
          )
            break;
        }
        expect(mode.publicationPending).toBe(false);
        expect(mode.presentation.promise).toBeNull();
        expect(mode.presentation.timer).toBeNull();
        expect([...mode.presentation.tiles.values()].every((tile) => !tile.dirty)).toBe(true);
        expect(
          painted
            .map((token) => token.text)
            .join("")
            .startsWith("#"),
        ).toBe(commented);
        expect(
          painted.some((token) => token.scopes.some((scope) => scope.includes("syntax--comment"))),
        ).toBe(commented);
        expect(
          painted.some((token) => token.scopes.some((scope) => scope.includes("syntax--string"))),
        ).toBe(!commented);
      }
    } finally {
      subscription.dispose();
      clearImmediate(paintTask);
    }
  });

  it("retains painted scopes until a budgeted update can publish current syntax", async () => {
    const mode = await start('def work():\n    return "value"\n');
    const painted = screen();
    expect(painted[1].tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
    mode.syncTimeoutMicros = 0;
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
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
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
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
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
    const parse = spyOn(mode, "parseAsync").and.callThrough();
    editor.getBuffer().insert([0, 0], "# ");
    await editor.whenGrammarSettled();
    expect(parse.calls.count()).toBe(1);
  });

  it("warms fold queries for the current viewport rather than every changed row", async () => {
    const mode = await start("value = 1\n".repeat(2000));
    mode.useAsyncParsing = false;
    editor.displayLayer.getScreenLines(800, 820);
    await editor.whenGrammarSettled();
    mode.ensureQueriesForLayersSync("foldsQuery");
    const captures = spyOn(mode.rootLanguageLayer.queries.foldsQuery, "captures").and.callThrough();
    mode.syncTimeoutMicros = 1000000;
    await new Promise((resolve) => setImmediate(resolve));
    editor.selectAll();
    editor.toggleLineCommentsInSelection();
    await editor.whenGrammarSettled();
    expect(captures.calls.count()).toBeGreaterThan(0);
    expect(captures.calls.count()).toBeLessThan(4);
    for (const [, options] of captures.calls.allArgs()) {
      expect(options.startPosition.row).toBeGreaterThan(700);
      expect(options.endPosition.row).toBeLessThan(900);
    }
  });

  it("settles automatic indentation and its syntax before a subsequent command", async () => {
    const mode = await start("def work():\n    value = 1\n    return value\n");
    mode.syncTimeoutMicros = 0;
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
    editor.setCursorBufferPosition([1, Infinity]);
    editor.insertNewline();
    expect(await editor.whenGrammarSettled()).toBe(true);
    expect(editor.lineTextForBufferRow(2)).toBe("    ");
    expect(editor.getCursorBufferPosition().column).toBe(4);
    expect(mode.tree.input).toBe(editor.getText());
    expect(editor.pendingIndentationPromises?.size ?? 0).toBe(0);
    expect(editor.autoIndentAtTransactionEndPromise).toBeNull();
    editor.undo();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe("def work():\n    value = 1\n    return value\n");
  });

  it("cancels an already started parse when a newer revision supersedes it", async () => {
    const mode = await start("value = 1\n".repeat(1000));
    mode.syncTimeoutMicros = 0;
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
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

  it("prepares newly visible scopes before their first screen lines are built", async () => {
    const mode = await start('value = "text"\n'.repeat(1000));
    const layer = mode.rootLanguageLayer;
    const boundaries = spyOn(layer, "getSyntaxBoundaries").and.callThrough();
    screen();
    expect(boundaries).not.toHaveBeenCalled();
    const build = editor.displayLayer.screenLineBuilder.buildScreenLines.bind(
      editor.displayLayer.screenLineBuilder,
    );
    spyOn(editor.displayLayer.screenLineBuilder, "buildScreenLines").and.callFake((...args) => {
      const before = boundaries.calls.count();
      const lines = build(...args);
      expect(boundaries.calls.count()).toBe(before);
      return lines;
    });
    const first = editor.displayLayer.getScreenLines(800, 820);
    expect(first[0].tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
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
    const first = read();
    expect(first.at(-1).tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
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

  it("paints rapid jumps across uncached fragments immediately with an exhausted load budget", async () => {
    const mode = await start('value = "text"\n'.repeat(4000));
    mode.syncTimeoutMicros = 0;
    for (const row of [800, 1600, 3000, 200, 3900, 1200]) {
      const lines = editor.displayLayer.getScreenLines(row, row + 25);
      expect(lines.length).toBe(25);
      expect(lines.every((line) => line.tags.filter((tag) => tag < 0).length > 2)).toBe(true);
      expect(mode.presentation.promise).toBeNull();
      expect(mode.presentation.timer).toBeNull();
    }
  });

  it("keeps screen-line construction intact when highlight publication triggers another read", async () => {
    await start(Array.from({ length: 2000 }, (_, row) => `value_${row} = "text"\n`).join(""));
    let nested;
    let reading = false;
    const subscription = editor.onDidChange(() => {
      if (reading) return;
      reading = true;
      nested = editor.screenLineForScreenRow(1700);
    });
    try {
      const lines = editor.displayLayer.getScreenLines(800, 820);
      expect(nested.lineText).toBe('value_1700 = "text"');
      expect(lines.length).toBe(20);
      for (let index = 0; index < lines.length; index++) {
        expect(lines[index].lineText).toBe(`value_${800 + index} = "text"`);
        expect(lines[index].tags.filter((tag) => tag < 0).length).toBeGreaterThan(2);
      }
    } finally {
      subscription.dispose();
    }
  });

  it("rejects staged scopes when an edit supersedes presentation preparation", async () => {
    const mode = await start('value = "text"\n'.repeat(1000));
    mode.syncTimeoutMicros = 0;
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
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
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
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
