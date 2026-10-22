const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");

describe("Duplicated line presentation with worker syntax", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
  });

  const source = 'def calculate(value):\n    result = value + 42\n    return "hello"\n';
  for (const scenario of [
    { name: "an indented line", text: source, rows: [1], order: [0, 1, 1, 2, 3] },
    { name: "the first line", text: source, rows: [0], order: [0, 0, 1, 2, 3] },
    {
      name: "the last line without a newline",
      text: source.trimEnd(),
      rows: [2],
      order: [0, 1, 2, 2],
    },
    {
      name: "CRLF lines",
      text: source.replaceAll("\n", "\r\n"),
      rows: [1],
      order: [0, 1, 1, 2, 3],
    },
    { name: "multiple cursors", text: source, rows: [0, 2], order: [0, 0, 1, 2, 2, 3] },
    {
      name: "a selected block",
      text: source,
      selection: [
        [1, 0],
        [3, 0],
      ],
      order: [0, 1, 2, 1, 2, 3],
    },
    {
      name: "a delimiter that changes the following context",
      text: 'value = """\ntext\n"""\nprint(42)\n',
      rows: [2],
      order: [0, 1, 2, 2, 3, 4],
    },
  ]) {
    it(`retains copied colors immediately for ${scenario.name} and replaces them with verified syntax`, async () => {
      const service = new Service(lumine.grammars);
      const editor = lumine.workspace.buildTextEditor();
      const grammar = lumine.grammars.grammarForScopeName("source.python");
      editor.setText(scenario.text);
      const mode = new WorkerMode({ buffer: editor.getBuffer(), grammar, service });
      editor.getBuffer().setLanguageMode(mode);
      const paint = (view) =>
        Array.from({ length: view.getLineCount() }, (_, row) =>
          view.tokensForScreenRow(row, { highlightingOwner: view }),
        );
      const settle = async () => {
        await editor.whenGrammarSettled();
        mode.requestHighlighting(editor, [[0, editor.getLastBufferRow()]]);
        await mode.refresh();
      };
      const compareFresh = async () => {
        await settle();
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
          expect(paint(editor)).toEqual(paint(fresh));
        } finally {
          fresh.destroy();
        }
      };
      try {
        await settle();
        const before = paint(editor);
        if (scenario.selection) editor.setSelectedBufferRange(scenario.selection);
        else
          editor.setSelectedBufferRanges(
            scenario.rows.map((row) => [
              [row, 0],
              [row, 0],
            ]),
          );
        editor.duplicateLines();
        // No await: a fast worker cannot hide an uncolored intermediate frame.
        const immediate = paint(editor);
        expect(immediate).toEqual(scenario.order.map((row) => before[row]));
        await compareFresh();
        editor.undo();
        await compareFresh();
        expect(editor.getText()).toBe(scenario.text);
        editor.redo();
        await compareFresh();
      } finally {
        editor.destroy();
        await service.dispose();
      }
    });
  }
});
