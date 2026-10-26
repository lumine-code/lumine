const path = require("node:path");
const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");
const fixtures = [
  [
    "source.js",
    "// 😀\r\nfunction work(value) {\r\n  return /abc+/g.test(`hello ${value}`);\r\n}\r\n",
  ],
  ["source.python", "# 😀\nclass Example:\n    def method(self):\n        return 'text'\n"],
  [
    "text.html.basic",
    "<style>.item { color: #fff }</style>\n<script>function work() { return 1; }</script>\n",
  ],
  [
    "text.html.php.blade",
    "@if ($value)\n<div>{{ '<fake>' }}</div>\n<x-alert :message=\"$value\" />\n@endif\n",
  ],
  ["source.gfm", '# Title\n\n```js\nfunction work() {}\n```\n\n<div class="item">text</div>\n'],
  ["source.python.ipy", "# %%\nvalue = !echo hello\n# %% [raw]\nraw text\n# %%\nresult = 1\n"],
  ["source.js", "const value = '" + "x".repeat(70000) + "';\n", true],
  ["source.js", "const value = '" + "x".repeat(70000) + "';", true],
  ["source.js", "function work() {\n  return 1;\n}\n".repeat(18000)],
];

describe("Syntax owner parity", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of [
      "language-javascript",
      "language-python",
      "language-html",
      "language-css",
      "language-regex",
      "language-php",
      "language-blade",
      "language-gfm",
      "language-ipython",
    ])
      await lumine.packages.activatePackage(name);
  });
  for (const [scope, text, hasLongString] of fixtures)
    it(`matches trees, scopes and paint for ${scope} (${text.length} UTF-16 units) through edits and undo`, async () => {
      const service = new Service(lumine.grammars);
      const editors = [];
      try {
        for (const Mode of [InlineMode, WorkerMode]) {
          const editor = lumine.workspace.buildTextEditor();
          editors.push(editor);
          editor.setText(text);
          editor.getBuffer().setLanguageMode(
            new Mode({
              buffer: editor.getBuffer(),
              grammar: lumine.grammars.grammarForScopeName(scope),
              config: lumine.config,
              grammars: lumine.grammars,
              service,
            }),
          );
        }
        const compare = async () => {
          const states = [];
          for (const editor of editors) {
            await editor.whenGrammarSettled();
            const mode = editor.getBuffer().getLanguageMode();
            const rows = [
              ...new Set([
                0,
                1,
                Math.floor(editor.getLastBufferRow() / 2),
                editor.getLastBufferRow(),
              ]),
            ].filter((row) => row <= editor.getLastBufferRow());
            mode.requestHighlighting(
              editor,
              rows.map((row) => [row, row]),
            );
            if (mode.asynchronousSyntax) await mode.refresh();
            else await mode.presentation.flush();
            const structure = await editor.analyzeSyntax(
              path.join(__dirname, "fixtures/syntax-worker-analysis.js"),
              "structure",
            );
            const positions = rows.flatMap((row) =>
              [0, Math.floor(editor.lineTextForBufferRow(row).length / 2)].map((column) => [
                row,
                column,
              ]),
            );
            const scopes = await editor.getScopeDescriptorsForBufferPositions(positions);
            states.push({
              structure,
              scopes: scopes.map((value) => value.getScopesArray()),
              paint: rows.map((row) =>
                editor.tokensForScreenRow(row, { highlightingOwner: editor, maxTokens: 64 }),
              ),
            });
            if (hasLongString) {
              const cache = mode.asynchronousSyntax ? mode.cache : mode.highlightCache;
              const limited = cache.snapshots.filter(
                (snapshot) =>
                  snapshot.stamp?.revision === editor.getBuffer().getTextRevision() &&
                  snapshot.quality === "limited" &&
                  snapshot.reason === "source-window",
              );
              expect(limited.length).toBeGreaterThan(0);
              expect(limited.every((snapshot) => snapshot.events.length < 128)).toBe(true);
              const insideString = positions.findIndex(
                ([row, column]) => editor.lineTextForBufferRow(row).length > 70000 && column > 0,
              );
              expect(insideString).toBeGreaterThanOrEqual(0);
              expect(
                states.at(-1).scopes[insideString].some((scope) => scope.startsWith("string.")),
              ).toBe(true);
            }
            expect(mode.error).toBeFalsy();
          }
          expect(states[1]).toEqual(states[0]);
        };
        await compare();
        for (const editor of editors) editor.getBuffer().insert([0, 0], "\n");
        await compare();
        for (const editor of editors) editor.undo();
        await compare();
        for (const editor of editors) editor.redo();
        await compare();
      } finally {
        for (const editor of editors) editor.destroy();
        service.dispose();
      }
    }, 60000);
});
