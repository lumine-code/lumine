const { Readable } = require("node:stream");
const path = require("node:path");
const { Disposable } = require("@lumine-code/event-kit");
const TextBuffer = require("../src/text-buffer");
const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");

describe("Syntax after external file reloads", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-latex");
  });

  for (const ending of ["\n", "\r\n"]) {
    it(`matches a fresh LaTeX parse and paint after repeated reloads (${JSON.stringify(ending)})`, async () => {
      const document = (version) =>
        [
          "\\documentclass{article}",
          "\\begin{document}",
          ...Array.from({ length: 150 }, (_, index) => [
            `\\section{Wyniki ${index}}`,
            version ? `\\textbf{Wartość ${index + version} 😀} $x^2$` : "% previous result",
            "\\begin{itemize}",
            `\\item ${version ? "Nowy wynik" : "Stary"}`,
            "\\end{itemize}",
            ...(version === 2 && index % 3 === 0 ? ["% additional result", "$x = 42$"] : []),
          ]).flat(),
          "\\end{document}",
          "",
        ].join(ending);
      const source = {
        text: document(0),
        getPath: () => null,
        getEncoding: () => "utf8",
        existsSync: () => true,
        createReadStream() {
          return Readable.from([this.text]);
        },
        onDidChange: () => new Disposable(),
        onDidDelete: () => new Disposable(),
      };
      const buffer = await TextBuffer.load(source);
      const editor = lumine.workspace.buildTextEditor({ buffer });
      const service = new Service(lumine.grammars);
      const grammar = lumine.grammars.grammarForScopeName("text.tex.latex");
      const mode = new WorkerMode({ buffer, grammar, service });
      buffer.setLanguageMode(mode);
      const paint = (view) =>
        Array.from({ length: view.getLineCount() }, (_, row) =>
          view.tokensForScreenRow(row, { highlightingOwner: view }),
        );
      const settle = async () => {
        await editor.whenGrammarSettled();
        mode.requestHighlighting(editor, [[0, editor.getLastBufferRow()]]);
        await mode.refresh();
      };
      try {
        await settle();
        paint(editor);
        for (const version of [1, 2, 0]) {
          mode.requestHighlighting(editor, [[0, 63]], true, { prefetch: false });
          source.text = document(version);
          await buffer.load({ internal: true });
          await editor.whenGrammarSettled();
          await mode.refresh();
          // Scroll into a previously painted region after the initial viewport
          // has settled. Its retained colors may still belong to the old file.
          paint(editor);
          await settle();
          const fresh = lumine.workspace.buildTextEditor();
          try {
            fresh.setText(source.text);
            fresh.getBuffer().setLanguageMode(
              new InlineMode({
                buffer: fresh.getBuffer(),
                grammar,
                grammars: lumine.grammars,
                config: lumine.config,
              }),
            );
            await fresh.whenGrammarSettled();
            const freshMode = fresh.getBuffer().getLanguageMode();
            freshMode.requestHighlighting(fresh, [[0, fresh.getLastBufferRow()]]);
            await freshMode.presentation.flush();
            const analysis = path.join(__dirname, "fixtures/syntax-worker-analysis.js");
            const summary = await editor.analyzeSyntax(analysis, "summary");
            expect(summary.text).toBe(source.text);
            expect(await editor.analyzeSyntax(analysis, "structure")).toEqual(
              await fresh.analyzeSyntax(analysis, "structure"),
            );
            const actual = paint(editor),
              expected = paint(fresh);
            const mismatches = actual.flatMap((tokens, row) =>
              JSON.stringify(tokens) === JSON.stringify(expected[row]) ? [] : [row],
            );
            expect(mismatches).withContext(`stale rows after generation ${version}`).toEqual([]);
          } finally {
            fresh.destroy();
          }
        }
      } finally {
        editor.destroy();
        await service.dispose();
      }
    });
  }
});
