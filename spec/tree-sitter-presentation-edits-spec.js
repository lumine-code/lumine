const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const CSON = require("@lumine-code/season");

describe("Incremental scope presentation", () => {
  let grammar;
  const buffers = [];
  beforeEach(async () => {
    jasmine.useRealClock();
    const file = require.resolve("language-javascript/grammars/javascript.json");
    const config = CSON.readFileSync(file);
    grammar = new TreeSitterGrammar(lumine.grammars, file, {
      ...config,
      treeSitter: { ...config.treeSitter, injectionsQuery: [] },
    });
    await grammar.setQueryForTest(
      "highlightsQuery",
      `
      ((template_string) @before (#not-match? @before "lorem") (#set! highlight.invalidateOnChange true))
      ((template_string) @after (#match? @after "lorem") (#set! highlight.invalidateOnChange true))
      (identifier) @variable
    `,
    );
  });
  afterEach(() => {
    for (const buffer of buffers.splice(0)) buffer.destroy();
    grammar?.deactivate();
  });
  async function model(text) {
    const buffer = new TextBuffer(text);
    buffers.push(buffer);
    const mode = new TreeSitterLanguageMode({ buffer, grammar, grammars: lumine.grammars });
    buffer.setLanguageMode(mode);
    await mode.atGrammarSettlement();
    const display = buffer.addDisplayLayer({ softWrapColumn: 40, tabLength: 4 });
    return { buffer, mode, display };
  }
  function view({ display }, start, end) {
    return display.getScreenLines(start, end).map((line) => ({
      text: line.lineText,
      tags: line.tags.map((tag) =>
        tag >= 0 ? tag : `${display.isOpenTag(tag) ? "+" : "-"}${display.classNameForTag(tag)}`,
      ),
    }));
  }

  it("matches fresh highlighting after local edits, row shifts, predicate changes and undo", async () => {
    const source =
      "const one = `\n" +
      "value\n".repeat(140) +
      "`;\nconst two = `\n" +
      "next\n".repeat(140) +
      "`;\n";
    const actual = await model(source);
    const windows = [
      [0, 12],
      [64, 80],
      [128, 144],
      [254, 270],
    ];
    for (const [start, end] of windows) view(actual, start, end);
    async function compare() {
      const expected = await model(actual.buffer.getText());
      try {
        for (const [start, end] of windows)
          expect(view(actual, start, end)).toEqual(view(expected, start, end));
      } finally {
        expected.buffer.destroy();
      }
    }
    actual.buffer.insert([80, 0], "lorem");
    await compare();
    actual.buffer.transact(() => {
      actual.buffer.insert([0, 0], "\n".repeat(5));
      actual.buffer.delete([
        [85, 0],
        [85, 5],
      ]);
      actual.buffer.insert([200, 0], "lorem");
    });
    await compare();
    let seed = 761;
    for (let i = 0; i < 20; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const row = 40 + (seed % 200);
      if (i % 3 === 0) actual.buffer.insert([row, 0], "\n");
      else if (i % 3 === 1)
        actual.buffer.delete([
          [row, 0],
          [row + 1, 0],
        ]);
      else actual.buffer.insert([row, 0], "lorem");
      await compare();
      if (i % 4 === 0) {
        actual.buffer.undo();
        await compare();
      }
    }
  });
});
