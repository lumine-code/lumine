const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");

describe("Retained presentation for moved text", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
  });
  for (const scenario of [
    {
      name: "line up",
      command: "moveLineUp",
      range: [
        [1, 0],
        [1, 0],
      ],
    },
    {
      name: "line down",
      command: "moveLineDown",
      range: [
        [1, 0],
        [1, 0],
      ],
    },
    {
      name: "EOF up",
      command: "moveLineUp",
      range: [
        [3, 0],
        [3, 0],
      ],
      eof: true,
    },
    {
      name: "into EOF",
      command: "moveLineDown",
      range: [
        [2, 0],
        [2, 0],
      ],
      eof: true,
    },
    {
      name: "block up",
      command: "moveLineUp",
      range: [
        [1, 0],
        [3, 0],
      ],
    },
    {
      name: "CRLF block down",
      command: "moveLineDown",
      range: [
        [0, 0],
        [2, 0],
      ],
      crlf: true,
    },
    {
      name: "multiple cursors",
      command: "moveLineUp",
      ranges: [
        [
          [1, 0],
          [1, 0],
        ],
        [
          [3, 0],
          [3, 0],
        ],
      ],
    },
  ]) {
    it(`preserves every moved and neighbouring token before syntax settles: ${scenario.name}`, async () => {
      const service = new Service(lumine.grammars),
        editor = lumine.workspace.buildTextEditor();
      const grammar = lumine.grammars.grammarForScopeName("source.python");
      const lines = ["first = 11", 'second = "two"', "# third comment", "fourth = 44"];
      const text =
        lines.join(scenario.crlf ? "\r\n" : "\n") +
        (scenario.eof ? "" : scenario.crlf ? "\r\n" : "\n");
      editor.setText(text);
      spyOn(editor, "shouldAutoIndent").and.returnValue(false);
      const buffer = editor.getBuffer(),
        mode = new WorkerMode({ buffer, grammar, service });
      buffer.setLanguageMode(mode);
      const paint = () =>
        Array.from({ length: editor.getLineCount() }, (_, row) =>
          editor.tokensForScreenRow(row, { highlightingOwner: editor }),
        );
      try {
        await editor.whenGrammarSettled();
        mode.requestHighlighting(editor, [[0, editor.getLastBufferRow()]]);
        await mode.refresh();
        const original = paint(),
          byText = new Map(lines.map((text, row) => [text, original[row]]));
        const refresh = spyOn(mode, "refresh").and.callFake(async () => {});
        editor.setSelectedBufferRanges(scenario.ranges ?? [scenario.range]);
        editor[scenario.command]();
        const assertPaint = () => {
          const current = paint();
          for (let row = 0; row < editor.getLineCount(); row++) {
            const line = buffer.lineForRow(row);
            if (line) expect(current[row]).withContext(line).toEqual(byText.get(line));
          }
        };
        assertPaint();
        await new Promise(requestAnimationFrame);
        assertPaint();
        editor.undo();
        expect(editor.getText()).toBe(text);
        assertPaint();
        editor.redo();
        assertPaint();
        refresh.and.callThrough();
        await editor.whenGrammarSettled();
        await mode.refresh();
        assertPaint();
        const fresh = lumine.workspace.buildTextEditor();
        try {
          fresh.setText(editor.getText());
          fresh
            .getBuffer()
            .setLanguageMode(
              new InlineMode({
                buffer: fresh.getBuffer(),
                grammar,
                grammars: lumine.grammars,
                config: lumine.config,
              }),
            );
          await fresh.whenGrammarSettled();
          for (let row = 0; row < editor.getLineCount(); row++)
            expect(editor.tokensForScreenRow(row)).toEqual(fresh.tokensForScreenRow(row));
        } finally {
          fresh.destroy();
        }
      } finally {
        editor.destroy();
        await service.dispose();
      }
    });
  }

  for (const [command, range, order] of [
    [
      "moveSelectionLeft",
      [
        [0, 3],
        [0, 6],
      ],
      [0, 1, 3, 4, 5, 2],
    ],
    [
      "moveSelectionRight",
      [
        [0, 0],
        [0, 2],
      ],
      [2, 0, 1, 3, 4, 5],
    ],
    [
      "transpose",
      [
        [0, 3],
        [0, 3],
      ],
      [0, 1, 3, 2, 4, 5],
    ],
  ])
    it(`retains a transferred operator through ${command} and history`, async () => {
      const editor = lumine.workspace.buildTextEditor(),
        service = new Service(lumine.grammars);
      editor.setText("a + 42\n");
      const buffer = editor.getBuffer(),
        mode = new WorkerMode({
          buffer,
          grammar: lumine.grammars.grammarForScopeName("source.python"),
          service,
        });
      buffer.setLanguageMode(mode);
      const roles = () =>
        editor
          .tokensForScreenRow(0, { highlightingOwner: editor })
          .flatMap((token) => Array.from(token.text, () => token.scopes));
      try {
        await editor.whenGrammarSettled();
        mode.requestHighlighting(editor, [[0, 1]]);
        await mode.refresh();
        const original = roles();
        spyOn(mode, "refresh").and.callFake(async () => {});
        editor.setSelectedBufferRange(range);
        editor[command]();
        expect(roles()).toEqual(order.map((index) => original[index]));
        editor.undo();
        expect(roles()).toEqual(original);
        editor.redo();
        expect(roles()).toEqual(order.map((index) => original[index]));
      } finally {
        editor.destroy();
        await service.dispose();
      }
    });
});
