const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");

describe("Worker comment typing presentation", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["language-python", "language-ipython", "language-javascript"])
      await lumine.packages.activatePackage(name);
  });

  for (const [scope, text] of [
    ["source.python", "# kombinacje efektów oddziaływań"],
    ["source.python.ipy", "# kombinacje efektów oddziaływań"],
    ["source.js", "// a comment"],
  ]) {
    it(`colors appended characters before any worker repaint in ${scope}`, async () => {
      const service = new Service(lumine.grammars);
      const editor = lumine.workspace.buildTextEditor();
      const grammar = lumine.grammars.grammarForScopeName(scope);
      editor.setText(text);
      const mode = new WorkerMode({ buffer: editor.getBuffer(), grammar, service });
      editor.getBuffer().setLanguageMode(mode);
      const paint = (row = 0) => editor.tokensForScreenRow(row, { highlightingOwner: editor });
      try {
        await editor.whenGrammarSettled();
        mode.requestHighlighting(editor, [[0, 1]]);
        await mode.refresh();
        expect(
          paint()
            .at(-1)
            .scopes.some((scope) => scope.includes("syntax--comment")),
        ).toBe(true);
        editor.setCursorBufferPosition([0, Infinity]);
        editor.getBuffer().clearUndoStack();
        // Hold only worker paint: no fast reply can hide an uncolored frame.
        const refresh = spyOn(mode, "refresh").and.callFake(async () => {});
        for (const letter of ["x", "ą", " ", "z"]) {
          editor.insertText(letter);
          expect(
            paint()
              .at(-1)
              .scopes.some((scope) => scope.includes("syntax--comment")),
          ).toBe(true);
          await new Promise(requestAnimationFrame);
          expect(
            paint()
              .at(-1)
              .scopes.some((scope) => scope.includes("syntax--comment")),
          ).toBe(true);
        }
        editor.undo();
        expect(
          paint()
            .at(-1)
            .scopes.some((scope) => scope.includes("syntax--comment")),
        ).toBe(true);
        editor.insertText("\n");
        editor.insertText("next");
        expect(
          paint(1)
            .at(-1)
            .scopes.some((scope) => scope.includes("syntax--comment")),
        ).toBe(false);
        refresh.and.callThrough();
        await editor.whenGrammarSettled();
        await mode.refresh();
        const fresh = lumine.workspace.buildTextEditor();
        try {
          fresh.setText(editor.getText());
          fresh.getBuffer().setLanguageMode(
            new InlineMode({
              buffer: fresh.getBuffer(),
              grammar,
              grammars: lumine.grammars,
              config: lumine.config,
            }),
          );
          await fresh.whenGrammarSettled();
          for (let row = 0; row < editor.getLineCount(); row++)
            expect(paint(row)).toEqual(fresh.tokensForScreenRow(row));
        } finally {
          fresh.destroy();
        }
      } finally {
        editor.destroy();
        await service.dispose();
      }
    });
  }
});
