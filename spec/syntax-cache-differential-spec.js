const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");
const TextBuffer = require("../src/text-buffer");

const view = (display, first, last) => {
  const start = display.translateBufferPosition([first, 0]).row;
  const end = display.translateBufferPosition([last, 0]).row;
  return display.getScreenLines(start, end).map((line) => ({
    text: line.lineText,
    tags: line.tags.map((tag) =>
      tag >= 0 ? tag : `${display.isOpenTag(tag) ? "+" : "-"}${display.classNameForTag(tag)}`,
    ),
  }));
};

describe("Syntax cache differential stress", () => {
  for (const scenario of [
    {
      package: "language-javascript",
      scope: "source.js",
      open: "/*",
      close: "*/",
      line: 'const value = "text"; // comment',
      replacement: "//",
    },
    {
      package: "language-python",
      scope: "source.python",
      open: 'value = """',
      close: '"""',
      line: 'value = "text" # comment',
      replacement: 'value = "" #',
    },
    {
      package: "language-html",
      scope: "text.html.basic",
      open: "<script> /*",
      close: "*/ </script>",
      line: 'const value = "text"; // comment',
      replacement: "<script> //",
    },
  ]) {
    it(`matches a fresh parse through eviction, cold jumps and context-changing edits in ${scenario.scope}`, async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage(scenario.package);
      const grammar = lumine.grammars.grammarForScopeName(scenario.scope);
      const text = Array.from({ length: 6 }, () =>
        [scenario.open, ...Array(140).fill(scenario.line), scenario.close, scenario.line].join(
          "\n",
        ),
      ).join("\n");
      const buffer = new TextBuffer(text),
        service = new Service(lumine.grammars);
      const mode = new WorkerMode({ buffer, grammar, service });
      buffer.setLanguageMode(mode);
      const display = buffer.addDisplayLayer({ softWrapColumn: 24, tabLength: 4 });
      const owner = {};
      const windows = [
        [0, 25],
        [120, 160],
        [420, 455],
        [250, 290],
        [700, 740],
        [120, 160],
        [0, 25],
      ];
      async function compare() {
        await mode.atGrammarSettlement();
        const reference = new TextBuffer(buffer.getText());
        reference.setLanguageMode(
          new InlineMode({
            buffer: reference,
            grammar,
            grammars: lumine.grammars,
            config: lumine.config,
            queryBudget: { now: () => 0 },
          }),
        );
        try {
          await reference.getLanguageMode().atGrammarSettlement();
          const fresh = reference.addDisplayLayer({ softWrapColumn: 24, tabLength: 4 });
          for (const [first, last] of windows) {
            // Materialize stale/cold screen lines before asynchronous paint.
            view(display, first, last);
            mode.requestHighlighting(owner, [[first, last]], false, { prefetch: false });
            await mode.refresh();
            expect(view(display, first, last)).toEqual(view(fresh, first, last));
            expect(mode.getHighlightingStatus().state).toBe("ready");
          }
        } finally {
          reference.destroy();
        }
      }
      try {
        await mode.ready;
        mode.cache.maxSnapshots = 2;
        mode.cache.maxEvents = 3000;
        await compare();
        buffer.setTextInRange(
          [
            [0, 0],
            [0, scenario.open.length],
          ],
          scenario.replacement,
        );
        await compare();
        buffer.undo();
        await compare();
        buffer.insert([127, 0], "\n\n");
        await compare();
        buffer.delete([
          [140, 0],
          [145, 0],
        ]);
        await compare();
        buffer.undo();
        await compare();
        buffer.redo();
        await compare();
      } finally {
        buffer.destroy();
        await service.dispose();
      }
    });
  }
});
