const path = require("node:path");
const Point = require("../src/point");

describe("Package syntax analyses with a worker owner", () => {
  const editors = [];
  const registrations = [];
  let execution;
  beforeEach(async () => {
    jasmine.useRealClock();
    execution = lumine.grammars.syntaxExecution;
    lumine.grammars.syntaxExecution = "worker";
    for (const name of [
      "language-javascript",
      "language-html",
      "language-gfm",
      "language-hyperlink",
      "language-python",
    ])
      await lumine.packages.activatePackage(name);
  });
  afterEach(async () => {
    for (const registration of registrations.splice(0)) registration.dispose();
    for (const editor of editors.splice(0)) {
      const mode = editor.getBuffer().getLanguageMode();
      if (!editor.isDestroyed() && mode.asynchronousSyntax) await mode.refresh();
      expect(mode.error).toBeFalsy();
      editor.destroy();
    }
    lumine.grammars.syntaxWorkerService?.dispose();
    lumine.grammars.syntaxWorkerService = null;
    lumine.grammars.syntaxExecution = execution;
  });
  async function build(text, scope) {
    const editor = lumine.workspace.buildTextEditor();
    editors.push(editor);
    editor.setText(text);
    expect(lumine.grammars.assignLanguageMode(editor.getBuffer(), scope)).toBeTrue();
    await editor.whenGrammarSettled();
    expect(editor.getBuffer().getLanguageMode().asynchronousSyntax).toBeTrue();
    expect(editor.getBuffer().getLanguageMode().rootLanguageLayer).toBeUndefined();
    return editor;
  }

  it("awaits syntax commands before displaying their result or scrolling folded content", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const editor = await build("function example() {\n  return 1;\n}\n", "source.js");
    await lumine.workspace.open(editor);
    editor.setCursorBufferPosition([1, 9]);
    const info = spyOn(lumine.notifications, "addInfo").and.callThrough();
    lumine.commands.dispatch(editor.getElement(), "editor:log-cursor-syntax-tree-scope");
    await conditionPromise(() => info.calls.count() > 0);
    expect(info.calls.mostRecent().args[0]).toContain("number");
    editor.setCursorBufferPosition([0, 5]);
    const scrollStates = [];
    spyOn(editor, "scrollToCursorPosition").and.callFake(() =>
      scrollStates.push(editor.isFoldedAtBufferRow(0)),
    );
    lumine.commands.dispatch(editor.getElement(), "editor:fold-current-row");
    await conditionPromise(() => editor.isFoldedAtBufferRow(0));
    expect(scrollStates).toContain(true);
    expect(() => editor.getSyntaxNodeAtBufferPosition([0, 0])).toThrowError(/analyzeSyntax/);
    await expectAsync(editor.getGrammarQueryCaptureGroups("tagsQuery")).toBeRejectedWithError(
      /analyzeSyntax/,
    );
  });

  it("streams package symbols from root and injected languages through the public API", async () => {
    const pack = await lumine.packages.activatePackage("symbol-tree-sitter");
    const Provider = require(path.join(pack.path, "lib/tree-sitter-provider"));
    const provider = new Provider();
    try {
      const editor = await build("<script>\nfunction inside() {}\n</script>\n", "text.html.basic");
      const symbols = await provider.getDocumentSymbols(editor, { sourceId: "symbol-tree-sitter" });
      expect(
        symbols.some((symbol) => symbol.name === "inside" && symbol.position.row === 1),
      ).toBeTrue();
      editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
      editor.setText(Array.from({ length: 600 }, (_, i) => `function item${i}() {}`).join("\n"));
      const many = await provider.getDocumentSymbols(editor, { sourceId: "symbol-tree-sitter" });
      expect(many.length).toBe(600);
      expect(many[599].name).toBe("item599");
      expect(many[599].position.serialize()).toEqual([599, 0]);
    } finally {
      provider.destroy();
    }
  });

  it("resolves Markdown references without exposing a syntax node to the link provider", async () => {
    const pack = await lumine.packages.activatePackage("link");
    const editor = await build(
      '[label][ref]\n\n[ref]: https://example.com/a\\(b\\) "Title"\n',
      "source.gfm",
    );
    const target = await pack.mainModule.targetAtPosition(editor, [0, 9]);
    expect(target.url).toBe("https://example.com/a(b)");
    expect(target.range.start.row).toBe(0);
  });

  it("closes a typed HTML tag and preserves its single undo transaction", async () => {
    const pack = await lumine.packages.activatePackage("autoclose-html");
    const editor = await build("<span", "text.html.basic");
    pack.mainModule.watchEditor(editor);
    let pending;
    const flush = pack.mainModule.flush.bind(pack.mainModule);
    spyOn(pack.mainModule, "flush").and.callFake((...args) => (pending = flush(...args)));
    editor.setCursorBufferPosition([0, 5]);
    editor.getBuffer().clearUndoStack();
    editor.insertText(">");
    await Promise.resolve();
    await pending;
    expect(editor.getText()).toBe("<span></span>");
    expect(editor.getCursorBufferPosition().serialize()).toEqual([0, 6]);
    editor.undo();
    expect(editor.getText()).toBe("<span");
  });

  it("keeps Python lexical scope checks beside the parser for runtime navigation", async () => {
    const pack = await lumine.packages.loadPackage("jupyter-repl");
    const module = path.join(pack.path, "lib/source-analysis/hyperclick.js");
    const editor = await build("obj.member\ndef outer():\n    local.member\n", "source.python");
    const expression = (range) => editor.analyzeSyntax(module, "expression", { range });
    expect(
      await expression([
        [0, 4],
        [0, 10],
      ]),
    ).toBe("obj.member");
    expect(
      await expression([
        [2, 10],
        [2, 16],
      ]),
    ).toBeNull();
  });

  it("runs bracket navigation, selection and deletion commands against the worker tree", async () => {
    await lumine.packages.activatePackage("bracket-matcher");
    const editor = await build("fn(a)", "source.js");
    registrations.push(lumine.textEditors.add(editor, { role: "fragment" }));
    const run = (command) =>
      lumine.commands.dispatch(editor.getElement(), `bracket-matcher:${command}`);
    editor.setCursorBufferPosition([0, 2]);
    await run("go-to-matching-bracket");
    expect(editor.getCursorBufferPosition().serialize()).toEqual([0, 5]);
    await run("select-inside-brackets");
    expect(editor.getSelectedText()).toBe("a");
    editor.setCursorBufferPosition([0, 3]);
    await run("remove-matching-brackets");
    expect(editor.getText()).toBe("fna");
    editor.undo();
    expect(editor.getText()).toBe("fn(a)");
    editor.setCursorBufferPosition([0, 2]);
    const pending = run("select-inside-brackets");
    editor.setText("replacement");
    await pending;
    expect(editor.getText()).toBe("replacement");
    expect(editor.getSelectedText()).toBe("");
  });

  it("finishes a bracket command while its presentation match is superseded", async () => {
    const pack = await lumine.packages.activatePackage("bracket-matcher");
    const editor = await build("fn(a)", "source.js");
    registrations.push(lumine.textEditors.add(editor, { role: "fragment" }));
    editor.setCursorBufferPosition([0, 2]);
    const mode = editor.getBuffer().getLanguageMode();
    await mode.refresh();
    await conditionPromise(() => pack.mainModule.provideBracketMatcher().getMatchRanges(editor));
    let begin, releaseCommand, releasePaint;
    const started = new Promise((resolve) => {
      begin = resolve;
    });
    const commandGate = new Promise((resolve) => {
      releaseCommand = resolve;
    });
    const paintGate = new Promise((resolve) => {
      releasePaint = resolve;
    });
    const analyze = editor.analyzeSyntax.bind(editor);
    let first = true;
    spyOn(editor, "analyzeSyntax").and.callFake((module, method, params, options) => {
      const result = analyze(module, method, params, options);
      if (method !== "query" || params.method !== "state") return result;
      const gate = first ? commandGate : paintGate;
      if (first) {
        first = false;
        begin();
      }
      return result.then(async (value) => {
        await gate;
        return value;
      });
    });
    try {
      const command = lumine.commands.dispatch(
        editor.getElement(),
        "bracket-matcher:go-to-matching-bracket",
      );
      await started;
      mode.emitter.emit("did-change-highlighting", editor.getBuffer().getRange());
      releaseCommand();
      await command;
      expect(editor.getCursorBufferPosition().serialize()).toEqual([0, 5]);
    } finally {
      releaseCommand();
      releasePaint();
    }
  });

  it("completes Ruby interpolation after the key appears and keeps undo and selection", async () => {
    await lumine.packages.activatePackage("language-ruby");
    const pack = await lumine.packages.activatePackage("bracket-matcher");
    const Matcher = require(path.join(pack.path, "lib/bracket-matcher"));
    const interpolate = Matcher.prototype.insertInterpolation;
    let pending;
    spyOn(Matcher.prototype, "insertInterpolation").and.callFake(function (...args) {
      const result = interpolate.apply(this, args);
      pending = this.pendingInterpolation;
      return result;
    });
    const editor = await build('foo = ""', "source.ruby");
    registrations.push(lumine.textEditors.add(editor, { role: "fragment" }));
    expect(editor.getBuffer().getLanguageMode().asynchronousSyntax).toBeTrue();
    expect(editor.getGrammar().scopeName).toBe("source.ruby");
    editor.setCursorBufferPosition([0, 7]);
    editor.getBuffer().clearUndoStack();
    editor.insertText("#");
    expect(editor.getText()).toBe('foo = "#"');
    await pending;
    expect(editor.getText()).toBe('foo = "#{}"');
    expect(editor.getCursorBufferPosition().serialize()).toEqual([0, 9]);
    editor.undo();
    expect(editor.getText()).toBe('foo = ""');
    editor.setText('foo = "bar"');
    editor.setSelectedBufferRange([
      [0, 7],
      [0, 10],
    ]);
    editor.insertText("#");
    await pending;
    expect(editor.getText()).toBe('foo = "#{bar}"');
    expect(editor.getSelectedText()).toBe("bar");
    editor.undo();
    expect(editor.getText()).toBe('foo = "bar"');
    expect(editor.getSelectedText()).toBe("bar");
    editor.setCursorBufferPosition([0, 7]);
    editor.insertText("#");
    editor.insertText("x");
    await pending;
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe('foo = "#xbar"');
  });

  it("renders LSP display signatures with worker-owned validation and colors", async () => {
    const pack = lumine.packages.loadPackage("ide");
    const { renderDocumentationCodeBlock } = require(
      path.join(pack.path, "lib/documentation-code-block"),
    );
    const source = "class Example(value: str)";
    const pre = await renderDocumentationCodeBlock({ text: source, scopeName: "source.python" });
    expect(pre).not.toBeNull();
    expect(pre.textContent).toBe(source);
    expect(
      pre.querySelector(".syntax--entity.syntax--name.syntax--type.syntax--class").textContent,
    ).toBe("Example");
  });

  it("queries scopes and delimiters outside presentation coverage in bounded batches", async () => {
    const editor = await build("// comment\nconst value = 1;\n".repeat(400), "source.js");
    const positions = Array.from({ length: 800 }, (_, row) => [row, 3]);
    const scopes = await editor.getScopeDescriptorsForBufferPositions(positions);
    expect(scopes.length).toBe(800);
    expect(scopes[798].getScopesArray().some((scope) => scope.startsWith("comment"))).toBeTrue();
    expect(scopes[799].getScopesArray().some((scope) => scope.startsWith("comment"))).toBeFalse();
    expect(scopes[798]).toBe(scopes[0]);
    expect(Object.isFrozen(scopes[0].getScopesArray())).toBeTrue();
    const comments = await editor.getCommentDelimitersForBufferPositions([[799, 3]]);
    expect(comments[0].line.trim()).toBe("//");
    const pending = editor.getScopeDescriptorsForBufferPositions(
      Array.from({ length: 4097 }, () => [0, 3]),
    );
    editor.getBuffer().append("// changed\n");
    expect(await pending).toBeNull();
  });

  it("shares IPython projection across splits and obtains cell structure from its root tree", async () => {
    const language = await lumine.packages.activatePackage("language-ipython");
    const packageWithCells = await lumine.packages.activatePackage("jupyter-cells");
    const service = language.mainModule.provideIPythonSource();
    const cells = packageWithCells.mainModule.provideJupyterCells();
    const source = "# %%\nvalue = !echo hi\n# %% [raw]\nraw bytes\n# %%\nafter = 2\n";
    const editor = await build(source, "source.python.ipy");
    const projected = await service.project(editor);
    expect(projected.source).toBe(source);
    expect(projected.text).toContain("value = eval('')");
    expect(projected.text).not.toContain("raw bytes");
    const split = editor.copy();
    editors.push(split);
    editor.destroy();
    expect(projected.isCurrent()).toBeTrue();
    expect(await service.project(split)).toBe(projected);
    const descriptors = await cells.getCellDescriptors(split);
    expect(descriptors.map(({ cellType }) => cellType)).toEqual(["code", "raw", "code"]);
    expect(descriptors[1].source).toBe("raw bytes");
    const python = await build(
      '# %% first\nvalue = 1\ntext = """\n# %% inside string\n"""\n# %% second\nvalue = 2\n',
      "source.python",
    );
    expect((await cells.getCellDescriptors(python)).length).toBe(2);
  });

  it("plans Python execution blocks in one worker analysis and rejects changed source", async () => {
    const pack = lumine.packages.loadPackage("jupyter-repl");
    const manager = require(path.join(pack.path, "lib/code-manager"));
    const editor = await build(
      "@decorator\ndef work():\n    value = 1\n    return value\n\nwork()\n",
      "source.python",
    );
    const context = { kernel: { language: "python" }, cellsService: null };
    const block = await manager.findCodeBlockAtRow(editor, 0, context);
    expect(block.code).toContain("return value");
    expect(block.range.start.row).toBe(0);
    expect(block.row).toBe(3);
    const blocks = await manager.findCodeBlocksInRange(
      editor,
      0,
      editor.getLastBufferRow(),
      context,
    );
    expect(blocks.length).toBe(2);
    expect(blocks[1].code).toBe("work()");
    const pending = manager.findCodeBlockAtRow(editor, 0, context);
    editor.setText("changed = 1");
    expect(await pending).toBeNull();
  });

  it("prepares the minimap's full coverage independently of the editor viewport", async () => {
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "900px";
    workspace.style.height = "450px";
    jasmine.attachToDOM(workspace);
    lumine.config.set("minimap.autoToggle", true);
    lumine.config.set("minimap.redrawDelay", 0);
    await lumine.packages.activatePackage("marker");
    await lumine.packages.activatePackage("minimap");
    const editor = await build("const value = 1; // comment\n".repeat(600), "source.js");
    await lumine.workspace.open(editor);
    const element = editor.getElement();
    await conditionPromise(() => element.querySelector("lumine-text-editor-minimap"));
    const view = element.querySelector("lumine-text-editor-minimap");
    const mode = editor.getBuffer().getLanguageMode();
    spyOn(view.minimap, "getFirstVisibleScreenRow").and.returnValue(0);
    spyOn(view.minimap, "getLastVisibleScreenRow").and.returnValue(250);
    view.displayCodeHighlights = true;
    view.offscreenFirstRow = null;
    view.updateCanvas();
    await mode.refresh();
    const paintContext = JSON.stringify({
      warmupPaused: mode.warmupPaused,
      cache: mode.cache.getStats(),
      requested: mode.requestsByOwner.get(view)?.ranges,
      row200: mode.cache.snapshots
        .filter((snapshot) => snapshot.start.row <= 200 && snapshot.end.row >= 200)
        .map(({ start, end, quality, reason }) => ({ start, end, quality, reason })),
    });
    expect(mode.cache.covers(new Point(0, 0), new Point(250, 0)))
      .withContext(paintContext)
      .toBeTrue();
    const tokens = editor.tokensForScreenRow(200, { highlightingOwner: view });
    expect(tokens.some((token) => token.scopes.some((scope) => scope.includes("syntax--comment"))))
      .withContext(paintContext)
      .toBeTrue();
    expect(editor.tokensForScreenRow(200, { highlightingOwner: view, maxTokens: 2 }).length)
      .withContext(paintContext)
      .toBe(2);
    view.destroy();
    expect(mode.requestsByOwner.get(view)?.ranges ?? []).toEqual([]);
  });

  it("scans colors outside the renderer while keeping contributed handler closures and exact offsets", async () => {
    const pack = lumine.packages.loadPackage("color-inline");
    const Registry = require(path.join(pack.path, "lib/expressions-registry"));
    const Expression = require(path.join(pack.path, "lib/color-expression"));
    const { scanBufferForColorsAsync, scanTextForColors } = require(
      path.join(pack.path, "lib/buffer-scanner"),
    );
    const registry = new Registry(Expression);
    const red = 0.75;
    registry.createExpression("test:trimmed", "prefix:a a", 10, ["*"], function () {
      this.rgba = [red, 0, 0, 1];
      this.colorExpression = "a";
    });
    registry.createExpression("test:letter", "a", 0, ["*"], function () {
      this.rgba = [0, red, 0, 1];
    });
    registry.createExpression("test:large", "blob\\(x{70000}\\)", 20, ["*"], function () {
      this.rgba = [0, 0, red, 1];
    });
    const text =
      "// \ud83d\ude00\r\n" + "prefix:a a\r\n".repeat(150) + "blob(" + "x".repeat(70000) + ")";
    const editor = await build(text, "source.js");
    const options = { registry, scope: "css", bufferPath: "colors.css" };
    const normalize = (results) =>
      results.map(({ range, line, match, color }) => ({ range, line, match, rgba: color.rgba }));
    try {
      const expected = scanTextForColors(text, options);
      const actual = await scanBufferForColorsAsync(editor, options);
      expect(actual.length).toBe(301);
      expect(normalize(actual)).toEqual(normalize(expected));
      const pending = scanBufferForColorsAsync(editor, options);
      editor.getBuffer().append("changed");
      expect(await pending).toBeNull();
    } finally {
      registry.dispose();
    }
  });

  it("classifies color markers in one batch and scans log scopes by ranges", async () => {
    const pack = lumine.packages.loadPackage("color-inline");
    const ColorBuffer = require(path.join(pack.path, "lib/color-buffer"));
    const ColorMarker = require(path.join(pack.path, "lib/color-marker"));
    const editor = await build("const a = '#fff';\n// #fff\n", "source.js");
    const buffer = Object.assign(Object.create(ColorBuffer.prototype), {
      editor,
      initialized: true,
      ignoredScopes: [/comment/],
      emitter: { emit: jasmine.createSpy("color update") },
    });
    const query = spyOn(editor, "getScopeDescriptorsForBufferPositions").and.callThrough();
    const markers = [
      new ColorMarker({
        marker: editor.markBufferRange([
          [0, 11],
          [0, 15],
        ]),
        color: {},
        text: "#fff",
        colorBuffer: buffer,
      }),
      new ColorMarker({
        marker: editor.markBufferRange([
          [1, 3],
          [1, 7],
        ]),
        color: {},
        text: "#fff",
        colorBuffer: buffer,
      }),
    ];
    try {
      await buffer.scopeCheckPromise;
      expect(query.calls.count()).toBe(1);
      expect(markers.map((marker) => marker.isIgnored())).toEqual([false, true]);
      expect(buffer.emitter.emit).toHaveBeenCalledTimes(1);
      const log = lumine.packages.loadPackage("log-filter");
      const Filter = require(path.join(log.path, "lib/filter"));
      const filter = new Filter(editor);
      try {
        const scopes = await editor.getScopeDescriptorsForBufferPositions([[1, 3]]);
        await filter.filterLevels(
          scopes[0].getScopesArray().filter((scope) => scope.startsWith("comment")),
        );
        expect(filter.hiddenRows.levels.toArray(1)).toEqual([1]);
      } finally {
        filter.destroy();
      }
    } finally {
      buffer.destroyed = true;
      buffer.scopeCheckController?.abort();
      for (const marker of markers) marker.destroy();
    }
  });

  it("triggers completion in an injection and prepares snippet comments before accepting a commit character", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.autoActivationDelay", 0);
    lumine.config.set("autocomplete.commitCharacters", true);
    await lumine.packages.activatePackage("snippets");
    const pack = await lumine.packages.activatePackage("autocomplete");
    await pack.mainModule.autocompleteManager.prepareCompletion();
    const calls = [];
    registrations.push(
      pack.mainModule.consumeAutocomplete({
        scopeSelector: ".source.js",
        inclusionPriority: 100,
        excludeLowerPriority: true,
        triggerCharacters: new Set(["."]),
        getSuggestions(options) {
          calls.push(options);
          return [
            {
              snippet: "${LINE_COMMENT} result",
              displayText: "result",
              replacementPrefix: "",
              commitCharacters: ["("],
            },
            { text: "other", replacementPrefix: "" },
          ];
        },
      }),
    );
    const editor = await build(
      "<!-- heading -->\n".repeat(150) + "<script>\nconsole\n</script>",
      "text.html.basic",
    );
    await lumine.workspace.open(editor);
    editor.setCursorBufferPosition([151, 7]);
    editor.getElement().focus();
    editor.insertText(".");
    await conditionPromise(
      () => editor.getElement().querySelectorAll(".autocomplete li").length === 2,
    );
    expect(calls[0].triggerCharacter).toBe(".");
    expect(calls[0].scopeDescriptor.getScopesArray()).toContain("source.js");
    const query = spyOn(editor, "getCommentDelimitersForBufferPositions").and.callThrough();
    editor.insertText("(");
    await conditionPromise(() => editor.lineTextForBufferRow(151) === "console.// result(");
    expect(query).toHaveBeenCalledTimes(1);
    editor.undo();
    expect(editor.lineTextForBufferRow(151)).toBe("console.(");
  });

  it("indents multiline completions after additional edits and keeps one undo step", async () => {
    const autocomplete = (await lumine.packages.activatePackage("autocomplete")).mainModule
      .autocompleteManager;
    await autocomplete.prepareCompletion();
    const source = "// header\nfunction first() {\n  ab\n}\nfunction second() {\n  ab\n}\n";
    const editor = await build(source, "source.js");
    editor.update({ tabLength: 2, softTabs: true });
    editor.setCursorBufferPosition([2, 4]);
    editor.addCursorAtBufferPosition([5, 4]);
    editor.getBuffer().clearUndoStack();
    autocomplete.updateCurrentEditor(editor);
    const plan = spyOn(editor, "autoIndentBufferRowsAtRows").and.callThrough();
    await autocomplete.insertSuggestion(
      {
        text: "block",
        insertTextMode: 2,
        textEdit: {
          range: [
            [5, 2],
            [5, 4],
          ],
          newText: "if (ready) {\nwork();\n}",
        },
        additionalTextEdits: [
          {
            range: [
              [0, 0],
              [0, 0],
            ],
            newText: "import 'ready';\n",
          },
        ],
      },
      editor.getCursorBufferPosition(),
    );
    expect(plan).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe(
      "import 'ready';\n// header\nfunction first() {\n  if (ready) {\n    work();\n  }\n}\nfunction second() {\n  if (ready) {\n    work();\n  }\n}\n",
    );
    editor.undo();
    expect(editor.getText()).toBe(source);

    const pending = autocomplete.insertSuggestion(
      {
        text: "block",
        insertTextMode: 2,
        textEdit: {
          range: [
            [5, 2],
            [5, 4],
          ],
          newText: "if (ready) {\nwork();\n}",
        },
      },
      editor.getCursorBufferPosition(),
    );
    editor.getBuffer().append("// independent edit\n");
    const manuallyEdited = editor.getText();
    await pending;
    expect(editor.getText()).toBe(manuallyEdited);
    editor.undo();
    expect(editor.getText()).not.toContain("independent edit");
    expect(editor.getText()).toContain("work();");
  });

  for (const cold of [false, true])
    it(`keeps ${cold ? "cold" : "prepared"} completion input through automatic newline indentation`, async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      lumine.config.set("autocomplete.enableAutoActivation", cold);
      lumine.config.set("autocomplete.autoActivationDelay", 0);
      lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
      const editor = await build("if (ok) {\n}", "source.js");
      await lumine.workspace.open(editor);
      let release, prepare;
      if (cold) {
        const pack = lumine.packages.loadPackage("autocomplete");
        const Manager = require(path.join(pack.path, "lib/autocomplete-manager"));
        prepare = Manager.prototype.prepareCompletion;
        const waiting = new Promise((resolve) => (release = resolve));
        spyOn(Manager.prototype, "prepareCompletion").and.returnValue(waiting);
      }
      const pack = await lumine.packages.activatePackage("autocomplete");
      const manager = pack.mainModule.autocompleteManager;
      if (!cold) await manager.prepareCompletion();
      const requests = [];
      registrations.push(
        pack.mainModule.consumeAutocomplete({
          scopeSelector: "*",
          inclusionPriority: 100,
          excludeLowerPriority: true,
          getSuggestions(options) {
            requests.push(options);
            return [{ text: "work" }, { text: "word" }];
          },
        }),
      );
      manager.updateCurrentEditor(editor);
      editor.update({ autoIndent: true, tabLength: 2, softTabs: true });
      editor.setCursorBufferPosition([0, 9]);
      editor.getElement().focus();
      editor.insertNewline();
      editor.insertText("w");
      const original = cold
        ? null
        : lumine.commands.dispatch(editor.getElement(), "autocomplete:activate");
      await editor.whenGrammarSettled();
      if (cold) release(await prepare.call(manager, true));
      await original;
      await conditionPromise(() => requests.length > 0);
      expect(editor.lineTextForBufferRow(1)).toBe("  w");
      expect(requests.at(-1).bufferPosition.serialize()).toEqual([1, 3]);
      expect(requests.at(-1).prefix).toBe("w");
      expect(Boolean(requests.at(-1).activatedManually)).toBe(!cold);
    });

  it("expands a snippet immediately after Enter without losing the pending indentation", async () => {
    const snippets = (await lumine.packages.activatePackage("snippets")).mainModule;
    const editor = await build("if (ok) {\n}", "source.js");
    editor.update({ autoIndent: true, tabLength: 2, softTabs: true });
    editor.setCursorBufferPosition([0, 9]);
    editor.getBuffer().clearUndoStack();
    editor.insertNewline();
    await snippets.expandSnippet(editor, "work(${1:value});");
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe("if (ok) {\n  work(value);\n}");
    editor.undo();
    expect(editor.getText()).toBe("if (ok) {\n  \n}");
    editor.undo();
    expect(editor.getText()).toBe("if (ok) {\n}");
    editor.setCursorBufferPosition([0, 9]);
    editor.insertNewline();
    const pending = snippets.expandSnippet(editor, "shouldNotAppear();");
    editor.insertText("typed");
    expect(await pending).toBeFalse();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe("if (ok) {\n  typed\n}");
  });

  it("prepares syntax-dependent snippet variables before editing every cursor", async () => {
    const pack = await lumine.packages.activatePackage("snippets");
    const snippets = pack.mainModule;
    const source = "<div>html</div>\n<script>\nvalue\n</script>";
    const editor = await build(source, "text.html.basic");
    editor.setSelectedBufferRanges([
      [
        [0, 5],
        [0, 5],
      ],
      [
        [2, 5],
        [2, 5],
      ],
    ]);
    const query = spyOn(editor, "getCommentDelimitersForBufferPositions").and.callThrough();
    await snippets.expandSnippet(editor, "${BLOCK_COMMENT_START}x${BLOCK_COMMENT_END}");
    expect(editor.lineTextForBufferRow(0)).toBe("<div><!--x-->html</div>");
    expect(editor.lineTextForBufferRow(2)).toBe("value/*x*/");
    expect(query.calls.count()).toBe(1);
    editor.undo();
    expect(editor.getText()).toBe(source);
    const autocomplete = (await lumine.packages.activatePackage("autocomplete")).mainModule
      .autocompleteManager;
    await autocomplete.prepareCompletion();
    const js = await build("ab\nab", "source.js");
    js.setSelectedBufferRanges([
      [
        [0, 2],
        [0, 2],
      ],
      [
        [1, 2],
        [1, 2],
      ],
    ]);
    autocomplete.updateCurrentEditor(js);
    autocomplete.setSnippetsManager(snippets.provideSnippets());
    await autocomplete.insertSuggestion(
      { snippet: "${LINE_COMMENT} result", replacementPrefix: "ab" },
      js.getCursorBufferPosition(),
    );
    expect(js.getText()).toBe("// result\n// result");
    js.undo();
    expect(js.getText()).toBe("ab\nab");
  });
});
