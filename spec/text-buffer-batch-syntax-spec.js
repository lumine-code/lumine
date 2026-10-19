describe("Independent edit batches with syntax layers", () => {
  const editors = [];
  afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
  });

  function tree(node) {
    return [
      node.type,
      node.startIndex,
      node.endIndex,
      [node.startPosition.row, node.startPosition.column],
      [node.endPosition.row, node.endPosition.column],
      node.children.map(tree),
    ];
  }
  function forest(editor) {
    return editor
      .getBuffer()
      .getLanguageMode()
      .getAllLanguageLayers()
      .map((layer) => [layer.grammar.scopeName, tree(layer.tree.rootNode)]);
  }

  for (const replacement of ["longer", "longer\r\n"])
    for (const fixture of [
      { package: "language-javascript", scope: "source.js", line: 'const foo = "😀終"; foo;\r\n' },
      {
        package: "language-python",
        scope: "source.python",
        line: 'foo = "😀終"\r\nprint(foo)\r\n',
      },
      {
        package: "language-html",
        scope: "text.html.basic",
        line: '<script>const foo = "😀終"; foo;</script><p>foo</p>\r\n',
      },
    ]) {
      it(`matches a fresh parse, including all node coordinates, for ${fixture.scope} replacing with ${JSON.stringify(replacement)}`, async () => {
        await lumine.packages.activatePackage(fixture.package);
        if (fixture.package === "language-html")
          await lumine.packages.activatePackage("language-javascript");
        const source = fixture.line.repeat(80);
        const actual = await lumine.workspace.open();
        editors.push(actual);
        const expected = await lumine.workspace.open();
        editors.push(expected);
        for (const editor of [actual, expected]) {
          editor.setText(source);
          expect(lumine.grammars.assignLanguageMode(editor.getBuffer(), fixture.scope)).toBe(true);
          await editor.whenGrammarSettled();
        }
        const originalForest = forest(expected);
        if (fixture.package === "language-html") expect(originalForest.length).toBeGreaterThan(1);
        const buffer = actual.getBuffer();
        buffer.clearUndoStack();
        const changes = [...source.matchAll(/foo/g)].map((match) => ({
          range: [
            buffer.positionForCharacterIndex(match.index),
            buffer.positionForCharacterIndex(match.index + 3),
          ],
          text: replacement,
        }));
        const mode = buffer.getLanguageMode();
        const notify = mode.bufferDidChangeBatch.bind(mode);
        const batches = spyOn(mode, "bufferDidChangeBatch").and.callFake((change, count) => {
          const guarded = Object.create(change);
          for (const name of ["oldText", "newText"])
            Object.defineProperty(guarded, name, {
              get() {
                throw new Error("Parser invalidation must use explicit coordinates");
              },
            });
          return notify(guarded, count);
        });
        const applied = [];
        const subscription = buffer.onDidApplyChanges((batch) => applied.push(batch));
        buffer.setTextInIndependentRanges(changes);
        expect(batches.calls.count()).toBe(1);
        expect(applied[0].changes.length).toBe(changes.length);
        expected.setText(source.replace(/foo/g, replacement));
        expected.getBuffer().setLanguageMode(null);
        expect(lumine.grammars.assignLanguageMode(expected.getBuffer(), fixture.scope)).toBe(true);
        await actual.whenGrammarSettled();
        await expected.whenGrammarSettled();
        const changedForest = forest(expected);
        expect(forest(actual)).toEqual(changedForest);
        actual.undo();
        await actual.whenGrammarSettled();
        expect(actual.getText()).toBe(source);
        expect(forest(actual)).toEqual(originalForest);
        actual.redo();
        await actual.whenGrammarSettled();
        expect(forest(actual)).toEqual(changedForest);
        subscription.dispose();
      });
    }
});
