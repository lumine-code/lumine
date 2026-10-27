const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

describe("Worker presentation during atomic source edits", () => {
  beforeEach(() => jasmine.useRealClock());

  for (const scope of ["source.python", "source.python.ipy"])
    for (const operation of [
      "stream",
      "replace-all",
      "independent-127",
      "independent-128",
      "independent-256",
    ])
      it(`retains unchanged token roles before publication, undo and redo: ${scope} ${operation}`, async () => {
        await lumine.packages.activatePackage("language-python");
        if (scope.endsWith("ipy")) await lumine.packages.activatePackage("language-ipython");
        const service = new Service(lumine.grammars);
        const editor = lumine.workspace.buildTextEditor();
        const buffer = editor.getBuffer();
        const source = 'value = "old"; untouched = 42\n'.repeat(300);
        editor.setText(source);
        const mode = new WorkerMode({
          buffer,
          grammar: lumine.grammars.grammarForScopeName(scope),
          service,
        });
        buffer.setLanguageMode(mode);
        const tokens = () => editor.tokensForScreenRow(64, { highlightingOwner: editor });
        try {
          await editor.whenGrammarSettled();
          mode.requestHighlighting(editor, [[60, 70]]);
          await mode.refresh();
          const before = tokens();
          expect(before.length).toBeGreaterThan(5);
          const refresh = spyOn(mode, "refresh").and.callFake(async () => {});
          buffer.clearUndoStack();
          const count = operation === "stream" ? 256 : Number(operation.split("-")[1]);
          const edits = Array.from({ length: count }, (_, row) => ({
            range: [
              [row, 9],
              [row, 12],
            ],
            text: "new",
          }));
          if (operation === "stream") await buffer.applyTextEdits(edits);
          else if (operation === "replace-all") await buffer.replaceAllMatches(/old/g, "new");
          else buffer.setTextInIndependentRanges(edits);
          const expected = before.map((token) => ({
            ...token,
            text: token.text === "old" ? "new" : token.text,
          }));
          expect(tokens()).toEqual(expected);
          await new Promise(requestAnimationFrame);
          expect(tokens()).toEqual(expected);
          editor.undo();
          expect(editor.getText()).toBe(source);
          expect(tokens()).toEqual(before);
          await new Promise(requestAnimationFrame);
          expect(tokens()).toEqual(before);
          editor.redo();
          expect(tokens()).toEqual(expected);
          refresh.and.callThrough();
          await editor.whenGrammarSettled();
          await mode.refresh();
          expect(tokens()).toEqual(expected);
        } finally {
          editor.destroy();
          await service.dispose();
        }
      });

  it("translates retained rows across multiline source edits and grouped history", async () => {
    await lumine.packages.activatePackage("language-python");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor(),
      buffer = editor.getBuffer();
    editor.setText('head = 1\nkeep = "colored"\ntail = 3\n');
    const mode = new WorkerMode({
      buffer,
      grammar: lumine.grammars.grammarForScopeName("source.python"),
      service,
    });
    buffer.setLanguageMode(mode);
    const tokens = (row) => editor.tokensForScreenRow(row, { highlightingOwner: editor });
    try {
      await editor.whenGrammarSettled();
      mode.requestHighlighting(editor, [[0, 3]]);
      await mode.refresh();
      const before = tokens(1);
      spyOn(mode, "refresh").and.callFake(async () => {});
      buffer.clearUndoStack();
      await buffer.applyTextEdits([
        {
          range: [
            [0, 7],
            [0, 8],
          ],
          text: "2\nextra = 4",
        },
      ]);
      expect(tokens(2)).toEqual(before);
      buffer.append("# more\n");
      buffer.groupLastChanges();
      editor.undo();
      expect(tokens(1)).toEqual(before);
      editor.redo();
      expect(tokens(2)).toEqual(before);
    } finally {
      editor.destroy();
      await service.dispose();
    }
  });
});
