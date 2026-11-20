const path = require("node:path");
const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");
const { PREVIEW_DOCUMENT_UNITS } = require("../src/syntax-worker-protocol");
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

async function waitForExactPaint(editor, mode, rows, context, requireCurrent) {
  const buffer = editor.getBuffer();
  const worker = mode.asynchronousSyntax;
  const cache = worker ? mode.cache : mode.highlightCache;
  const missingRows = () => {
    if (mode.publicationPending) return rows;
    const stamp = requireCurrent
      ? {
          revision: buffer.getTextRevision(),
          generation: worker ? mode.session.generation : mode.presentation.generation,
          ...(worker ? { presentation: mode.presentationVersion } : {}),
        }
      : null;
    return rows.filter(
      (row) =>
        !cache.covers(
          buffer.clipPosition([row, 0]),
          buffer.clipPosition([row + 1, 0]),
          stamp,
          (snapshot) => snapshot.quality === "exact",
        ),
    );
  };
  const label = `${context} ${worker ? "worker" : "inline"} ${requireCurrent ? "current " : ""}exact paint`;
  try {
    await conditionPromise(() => missingRows().length === 0, label);
  } catch (cause) {
    const coverage = cache.snapshots.map(({ start, end, quality, reason, stamp }) => ({
      start: [start.row, start.column],
      end: [end.row, end.column],
      quality,
      reason,
      revision: stamp?.revision,
      generation: stamp?.generation,
      presentation: stamp?.presentation,
    }));
    throw new Error(
      `${label} still missing rows ${missingRows().join(", ")}. Cached windows ${JSON.stringify(coverage)}`,
      { cause },
    );
  }
}

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
      const exactPaint = !hasLongString && text.length <= PREVIEW_DOCUMENT_UNITS;
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
              // Compare exact tokens independently of scheduler pauses during
              // an inline query. Size and structural limits still apply.
              queryBudget: Mode === InlineMode && exactPaint ? { now: () => 0 } : undefined,
            }),
          );
        }
        const compare = async (phase) => {
          const context = `${scope}, ${phase}`;
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
            // After an edit, unchanged rows may reuse coordinate-adjusted
            // exact paint. Token equality still checks the retained content.
            if (exactPaint)
              await waitForExactPaint(editor, mode, rows, context, phase === "initial");
            states.push({
              rows,
              positions,
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
          const [inline, worker] = states;
          expect(worker.structure).withContext(`${context} structure`).toEqual(inline.structure);
          expect(worker.positions)
            .withContext(`${context} scope positions`)
            .toEqual(inline.positions);
          expect(worker.scopes.length)
            .withContext(`${context} scope count`)
            .toBe(inline.scopes.length);
          expect(worker.rows).withContext(`${context} screen rows`).toEqual(inline.rows);
          for (const [index, position] of inline.positions.entries())
            expect(worker.scopes[index])
              .withContext(`${context} scopes at ${position.join(":")}`)
              .toEqual(inline.scopes[index]);
          for (const [index, row] of inline.rows.entries())
            expect(worker.paint[index])
              .withContext(`${context} tokens at screen row ${row}`)
              .toEqual(inline.paint[index]);
        };
        await compare("initial");
        for (const editor of editors) editor.getBuffer().insert([0, 0], "\n");
        await compare("edited");
        for (const editor of editors) editor.undo();
        await compare("undone");
        for (const editor of editors) editor.redo();
        await compare("redone");
      } finally {
        for (const editor of editors) editor.destroy();
        service.dispose();
      }
    }, 60000);
});
