describe("Auto-indent plans", () => {
  const editors = [];
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    await lumine.packages.activatePackage("language-python");
  });
  afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
  });
  async function build(text, scope = "source.js") {
    const editor = await lumine.workspace.open();
    editors.push(editor);
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
    editor.setText(text);
    expect(lumine.grammars.assignLanguageMode(editor.getBuffer(), scope)).toBe(true);
    await editor.whenGrammarSettled();
    editor.getBuffer().clearUndoStack();
    return editor;
  }

  it("carries preceding indentation through a sparse plain-text plan", async () => {
    const editor = lumine.workspace.buildTextEditor();
    editors.push(editor);
    editor.update({ tabLength: 2, softTabs: true });
    editor.setText("  first\nsecond\nthird\nuntouched");
    const before = editor.getText();
    await editor.autoIndentBufferRowsAtRows([2, 1, 2]);
    expect(editor.getText()).toBe("  first\n  second\n  third\nuntouched");
    editor.undo();
    expect(editor.getText()).toBe(before);
  });

  it("carries absolute indentation between rows while returning additive hints", async () => {
    const editor = await build("if (ok) {\n    foo();\nbar();\n}");
    const mode = editor.getBuffer().getLanguageMode();
    const levels = mode.suggestedIndentForBufferRows(1, 2, 4, { preserveLeadingWhitespace: true });
    expect([...levels]).toEqual([
      [1, 0],
      [2, 1],
    ]);
    editor.autoIndentBufferRows(1, 2, { preserveLeadingWhitespace: true });
    expect(editor.getText()).toBe("if (ok) {\n    foo();\n    bar();\n}");
    editor.undo();
    expect(editor.getText()).toBe("if (ok) {\n    foo();\nbar();\n}");
  });

  it("indents adjacent new rows consistently when multiple cursors split one line", async () => {
    const source = "if (ok) {    foo();bar();}";
    const editor = await build(source);
    editor.setSelectedBufferRanges(
      [9, source.indexOf("bar")].map((column) => [
        [0, column],
        [0, column],
      ]),
    );
    editor.insertNewline();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe("if (ok) {\n    foo();\n    bar();}");
    editor.undo();
    expect(editor.getText()).toBe(source);
  });

  it("does not interpret a missing batch hint as zero indentation", async () => {
    const editor = await build("    first\n        second", "source.python");
    const mode = editor.getBuffer().getLanguageMode();
    spyOn(mode, "suggestedIndentForBufferRows").and.returnValue(
      new Map([
        [0, null],
        [1, undefined],
      ]),
    );
    spyOn(editor, "suggestedIndentForBufferRow").and.returnValue(null);
    editor.autoIndentBufferRows(0, 1);
    expect(editor.getText()).toBe("    first\n        second");
  });

  it("ignores invalid scalar hints instead of erasing indentation", async () => {
    const editor = await build("    value();");
    const suggest = spyOn(editor, "suggestedIndentForBufferRow");
    const dedent = spyOn(editor.getBuffer().getLanguageMode(), "suggestedIndentForEditedBufferRow");
    for (const hint of [null, undefined, NaN, Infinity, -1, "2"]) {
      suggest.and.returnValue(hint);
      dedent.and.returnValue(hint);
      editor.autoIndentBufferRow(0);
      editor.autoDecreaseIndentForBufferRow(0);
      expect(editor.getText()).toBe("    value();");
    }
  });

  it("continues to typing dedent rules when a reindent-only capture does not apply", async () => {
    const editor = await build("if (ok) {\n    }");
    const mode = editor.getBuffer().getLanguageMode();
    mode.ensureQueriesForLayersSync("indentsQuery");
    const query = mode.rootLanguageLayer.queries.indentsQuery;
    const captures = query.captures.bind(query);
    spyOn(query, "captures").and.callFake((...args) => {
      const result = captures(...args);
      const closing = result.find((c) => c.node.startPosition.row === 1);
      return closing
        ? [
            {
              ...closing,
              assertedProperties: { ...closing.assertedProperties, "indent.reindent": "true" },
            },
            ...result,
          ]
        : result;
    });
    expect(mode.suggestedIndentForEditedBufferRow(1, 4)).toBe(0);
  });

  it("uses resulting tab-stop columns rather than adding indentation levels arithmetically", async () => {
    const source = "      if (ok) {\n\tfoo();\nbar();\n}";
    const editor = await build(source);
    editor.autoIndentBufferRows(1, 2, { preserveLeadingWhitespace: true });
    expect(editor.indentationForBufferRow(1)).toBe(2);
    expect(editor.indentationForBufferRow(2)).toBe(2);
  });

  it("treats CRLF insertion like Enter for single and multiple cursors", async () => {
    for (const count of [1, 3]) {
      const editor = await build("if (ok) {x();}\r\n".repeat(count));
      editor.setSelectedBufferRanges(
        Array.from({ length: count }, (_, row) => [
          [row, 9],
          [row, 9],
        ]),
      );
      editor.insertText("\r\n");
      await editor.whenGrammarSettled();
      expect(editor.getText()).toBe("if (ok) {\r\n    x();}\r\n".repeat(count));
    }
  });

  it("applies a large indentation plan as one display update and one undo step", async () => {
    const editor = await build("if (ok) {\nfoo();\n}\n".repeat(100));
    const original = editor.getText();
    const layout = spyOn(editor.getBuffer(), "updateDisplayLayersForChange").and.callThrough();
    editor.autoIndentBufferRows(0, editor.getLastBufferRow());
    expect(editor.getText()).toBe("if (ok) {\n    foo();\n}\n".repeat(100));
    expect(layout.calls.count()).toBe(1);
    editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("leaves a cursor inside already-correct indentation in place", async () => {
    const editor = await build("if (ok) {\n    foo();\n}");
    editor.setCursorBufferPosition([1, 2]);
    const revision = editor.getBuffer().getTextRevision();
    editor.autoIndentBufferRows(1, 1);
    expect(editor.getCursorBufferPosition().serialize()).toEqual([1, 2]);
    expect(editor.getBuffer().getTextRevision()).toBe(revision);
  });

  it("discards a plan when an indent observer changes the buffer during planning", async () => {
    const editor = await build("if (ok) {\nfoo();\n}");
    const resolver = editor.getBuffer().getLanguageMode().indentResolver;
    const subscription = resolver.onDidSuggestIndent(() => {
      subscription.dispose();
      editor.getBuffer().append("\n// later");
    });
    editor.autoIndentBufferRows(0, 2);
    expect(editor.getText()).toBe("if (ok) {\nfoo();\n}\n// later");
  });

  it("waits for asynchronous syntax before planning and discards stale requests", async () => {
    for (const stale of [false, true]) {
      const editor = await build("if (ok) {\nfoo();\n}");
      const mode = editor.getBuffer().getLanguageMode();
      let resolve;
      mode.publicationPending = true;
      spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
      spyOn(mode, "atGrammarSettlement").and.returnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const suggest = spyOn(mode, "suggestedIndentForBufferRows").and.callThrough();
      const pending = editor.autoIndentBufferRows(0, 2);
      expect(suggest).not.toHaveBeenCalled();
      if (stale) editor.getBuffer().append("\n// later");
      mode.publicationPending = false;
      resolve();
      await pending;
      expect(editor.getText()).toBe(
        stale ? "if (ok) {\nfoo();\n}\n// later" : "if (ok) {\n    foo();\n}",
      );
    }
  });

  it("keeps automatic transaction repair in typing mode rather than structural reindent", async () => {
    const editor = await build("if True:\nvalue = 1", "source.python");
    const mode = editor.getBuffer().getLanguageMode();
    mode.useAsyncParsing = mode.useAsyncIndent = true;
    spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
    spyOn(mode, "atTransactionEnd").and.resolveTo({
      range: editor.getBuffer().getRange(),
      autoIndentRequests: 1,
    });
    await editor.scheduleIndentAdjustment(true);
    expect(editor.getText()).toBe("if True:\n    value = 1");
  });

  it("owns each deferred paste range and releases markers on completion or cancellation", async () => {
    for (const stale of [false, true]) {
      const original = "if (one) {\n\n}\nif (two) {\n\n}\n";
      const editor = await build(original);
      const mode = editor.getBuffer().getLanguageMode();
      spyOn(mode, "shouldParseSynchronously").and.returnValue(false);
      editor.setSelectedBufferRanges([
        [
          [1, 0],
          [1, 0],
        ],
        [
          [4, 0],
          [4, 0],
        ],
      ]);
      const markers = [];
      const mark = editor.markBufferRange.bind(editor);
      spyOn(editor, "markBufferRange").and.callFake((...args) => {
        const marker = mark(...args);
        markers.push(marker);
        return marker;
      });
      const events = [];
      editor.onDidInsertText((event) => events.push(event.text));
      const pending = editor.pasteText({
        clipboard: { readWithMetadata: () => ({ text: "foo();\nbar();", metadata: {} }) },
        autoIndent: true,
      });
      if (stale) editor.getBuffer().append("// newer");
      await pending;
      await editor.whenGrammarSettled();
      expect(markers.length).toBe(2);
      expect(markers.every((marker) => marker.isDestroyed())).toBe(true);
      if (stale) expect(editor.getText().endsWith("// newer")).toBe(true);
      else {
        expect(editor.getText()).toBe(
          "if (one) {\n    foo();\n    bar();\n}\nif (two) {\n    foo();\n    bar();\n}\n",
        );
        expect(events).toEqual(["    foo();\n    bar();", "    foo();\n    bar();"]);
        editor.undo();
        expect(editor.getText()).toBe(original);
      }
    }
  });

  it("keeps blank-line indentation with multiple cursors when whitespace cleans the old rows", async () => {
    await lumine.packages.activatePackage("whitespace");
    lumine.config.set("whitespace.removeTrailingWhitespace", true);
    lumine.config.set("whitespace.ignoreWhitespaceOnlyLines", false);
    try {
      const editor = await build("    \n    ");
      editor.setSelectedBufferRanges([
        [
          [0, 4],
          [0, 4],
        ],
        [
          [1, 4],
          [1, 4],
        ],
      ]);
      editor.insertNewline();
      await editor.whenGrammarSettled();
      expect(editor.getText()).toBe("\n    \n\n    ");
      editor.undo();
      expect(editor.getText()).toBe("    \n    ");
    } finally {
      await lumine.packages.deactivatePackage("whitespace");
    }
  });

  for (const [scope, text] of [
    ["source.js", "if (ok) {\n\nfoo();\nif (other) {\nbar();\n}\n}"],
    ["source.python", "if ok:\n\n    value = [\n1,\n2\n]\n"],
  ]) {
    it(`matches sequential indentation across blank lines in ${scope}`, async () => {
      const batch = await build(text, scope),
        scalar = await build(text, scope);
      scalar.transact(() => {
        for (let row = 0; row <= scalar.getLastBufferRow(); row++) scalar.autoIndentBufferRow(row);
      });
      batch.autoIndentBufferRows(0, batch.getLastBufferRow());
      expect(batch.getText()).toBe(scalar.getText());
      const once = batch.getText();
      batch.autoIndentBufferRows(0, batch.getLastBufferRow());
      expect(batch.getText()).toBe(once);
    });
  }
});
