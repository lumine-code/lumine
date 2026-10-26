const path = require("node:path");

describe("None grammar syntax analysis boundary", () => {
  const analysis = path.join(__dirname, "fixtures/syntax-worker-analysis.js");
  const absentAnalysis = path.join(__dirname, "fixtures/no-analysis-for-none.js");
  let editor, split, execution;

  beforeEach(async () => {
    jasmine.useRealClock();
    execution = lumine.grammars.syntaxExecution;
    const pkg = await lumine.packages.activatePackage("language-javascript");
    await pkg.resourceLoadPromise;
    editor = lumine.workspace.buildTextEditor();
    editor.setText("const before = 1;\n");
  });

  afterEach(() => {
    split?.destroy();
    split = null;
    editor.destroy();
    lumine.grammars.syntaxExecution = execution;
  });

  for (const backend of ["inline", "worker"]) {
    it(`does not load an analysis module or read None source with the ${backend} backend`, async () => {
      lumine.grammars.syntaxExecution = backend;
      lumine.grammars.assignLanguageMode(editor, lumine.grammars.nullGrammar.scopeName);
      const read = spyOn(editor.getBuffer(), "getText").and.callThrough();
      await expectAsync(editor.analyzeSyntax(absentAnalysis, "scan")).toBeResolvedTo(null);
      await expectAsync(editor.getBuffer().analyzeSyntax(absentAnalysis, "scan")).toBeResolvedTo(
        null,
      );
      expect(read).not.toHaveBeenCalled();
    });

    it(`cancels old analysis and resumes from current source across split views with ${backend}`, async () => {
      lumine.grammars.syntaxExecution = backend;
      lumine.grammars.assignLanguageMode(editor, "source.js");
      split = editor.copy();
      await editor.whenGrammarSettled();
      const previous = editor.getBuffer().getLanguageMode();
      let started;
      const entered = new Promise((resolve) => (started = resolve));
      const pending = editor.analyzeSyntax(analysis, "waitForCancellation", null, {
        onChunk: () => started(),
      });
      await entered;
      lumine.grammars.assignLanguageMode(split, lumine.grammars.nullGrammar.scopeName);
      expect(split.getGrammar()).toBe(lumine.grammars.nullGrammar);
      expect(editor.getGrammar()).toBe(lumine.grammars.nullGrammar);
      await expectAsync(pending).toBeResolvedTo(null);
      if (backend === "worker") {
        expect(previous.session.closed).toBe(true);
        expect(
          [...previous.service.sessions.values()].some(
            (entry) => entry.buffer === editor.getBuffer(),
          ),
        ).toBe(false);
      }
      editor.getBuffer().append("const after = 2;\n");
      await expectAsync(split.analyzeSyntax(absentAnalysis, "scan")).toBeResolvedTo(null);
      lumine.grammars.assignLanguageMode(split, "source.js");
      const result = await editor.analyzeSyntax(analysis, "summary");
      expect(result.text).toBe("const before = 1;\nconst after = 2;\n");
      expect(result.type).toBe("const");
      expect(editor.getBuffer().getLanguageMode()).not.toBe(previous);
      expect(split.getGrammar()).toBe(editor.getGrammar());
      if (backend === "worker") {
        expect(editor.getBuffer().getLanguageMode().session.id).not.toBe(previous.session.id);
      }
    });
  }
});
