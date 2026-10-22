const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");

describe("Worker newline presentation", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-javascript");
  });

  const scenarios = [
    {
      name: "a Python multiline string",
      text: 'def work():\n    value = """abc\n    xyz\n    """',
      rows: [1],
      column: Infinity,
      immediate: 4,
    },
    {
      name: "a JavaScript template",
      text: "if (ok) {\n    const value = `abc\n    xyz`;\n}",
      rows: [1],
      column: Infinity,
      immediate: 4,
      scope: "source.js",
    },
    {
      name: "a JavaScript block comment",
      text: "if (ok) {\n    /* comment\n    more */\n}",
      rows: [1],
      column: Infinity,
      immediate: 4,
      scope: "source.js",
    },
    {
      name: "Python spaces",
      text: "def work():\n    value = 1",
      rows: [1],
      column: Infinity,
      immediate: 4,
    },
    {
      name: "Python tabs",
      text: "def work():\n\tvalue = 1",
      rows: [1],
      column: Infinity,
      immediate: 1,
      softTabs: false,
    },
    {
      name: "mixed tabs and spaces",
      text: "def work():\n\t  value = 1",
      rows: [1],
      column: Infinity,
      immediate: 3,
      softTabs: false,
    },
    {
      name: "a blank indented line",
      text: "def work():\n    ",
      rows: [1],
      column: Infinity,
      immediate: 4,
    },
    {
      name: "a split inside indentation",
      text: "def work():\n    value = 1",
      rows: [1],
      column: 2,
      immediate: 2,
    },
    {
      name: "CRLF",
      text: "def work():\r\n    value = 1",
      rows: [1],
      column: Infinity,
      immediate: 4,
      newline: "\r\n",
    },
    {
      name: "multiple cursors",
      text: "def first():\n    value = 1\ndef second():\n    value = 2",
      rows: [1, 3],
      column: Infinity,
      immediate: 4,
    },
    {
      name: "retained suffix whitespace",
      text: "if (ok) {\n    one();   two();\n}",
      rows: [1],
      column: 10,
      immediate: 4,
      scope: "source.js",
    },
    {
      name: "a closing delimiter that requires dedent",
      text: "if (ok) {\n    one();}",
      rows: [1],
      column: 10,
      immediate: 4,
      scope: "source.js",
    },
    {
      name: "a Python return that requires dedent",
      text: "def work():\n    return 1",
      rows: [1],
      column: Infinity,
      immediate: 4,
    },
  ];

  for (const scenario of scenarios) {
    it(`inserts inherited indentation atomically for ${scenario.name} and matches the final inline result`, async () => {
      const service = new Service(lumine.grammars);
      const editors = [];
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      try {
        for (const Mode of [WorkerMode, InlineMode]) {
          const editor = lumine.workspace.buildTextEditor({
            autoIndent: true,
            tabLength: 4,
            softTabs: scenario.softTabs ?? true,
          });
          editors.push(editor);
          editor.setText(scenario.text);
          editor.getBuffer().setLanguageMode(
            new Mode({
              buffer: editor.getBuffer(),
              grammar: lumine.grammars.grammarForScopeName(scenario.scope ?? "source.python"),
              service,
              grammars: lumine.grammars,
              config: lumine.config,
            }),
          );
          await editor.whenGrammarSettled();
          editor.update({ autoIndent: true, tabLength: 4, softTabs: scenario.softTabs ?? true });
          editor.setSelectedBufferRanges(
            scenario.rows.map((row) => [
              [row, scenario.column],
              [row, scenario.column],
            ]),
          );
          editor.getBuffer().clearUndoStack();
        }
        const [worker, inline] = editors;
        const mode = worker.getBuffer().getLanguageMode();
        const suggest = mode.suggestedIndentForBufferRowsAtRows.bind(mode);
        spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.callFake(async (...args) => {
          await gate;
          return suggest(...args);
        });
        const columns = [];
        const subscription = worker.onDidChangeCursorPosition(({ newBufferPosition }) => {
          if (!scenario.rows.includes(newBufferPosition.row))
            columns.push(newBufferPosition.column);
        });
        try {
          worker.insertText(scenario.newline ?? "\n");
          expect(worker.getCursorBufferPositions().map((p) => p.column)).toEqual(
            scenario.rows.map(() => scenario.immediate),
          );
          expect(columns).not.toContain(0);
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          expect(worker.getCursorBufferPositions().map((p) => p.column)).toEqual(
            scenario.rows.map(() => scenario.immediate),
          );
        } finally {
          subscription.dispose();
          release();
        }
        inline.insertText(scenario.newline ?? "\n");
        await Promise.all(editors.map((editor) => editor.whenGrammarSettled()));
        expect(worker.getText()).toBe(inline.getText());
        expect(worker.getCursorBufferPositions()).toEqual(inline.getCursorBufferPositions());
        worker.undo();
        expect(worker.getText()).toBe(scenario.text);
      } finally {
        release();
        for (const editor of editors) editor.destroy();
        await service.dispose();
      }
    });
  }
});
