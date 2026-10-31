const CSON = require("@lumine-code/season");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Conservative syntax indentation", () => {
  let editor, grammar;
  beforeEach(async () => {
    jasmine.useRealClock();
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, tabLength: 2, softTabs: true });
  });
  afterEach(() => {
    editor.destroy();
    grammar?.deactivate();
  });

  async function start(text, query) {
    const grammarPath = require.resolve("language-javascript/grammars/javascript.json");
    const config = CSON.readFileSync(grammarPath);
    grammar = new TreeSitterGrammar(lumine.grammars, grammarPath, {
      ...config,
      treeSitter: { ...config.treeSitter, injectionsQuery: [] },
    });
    await grammar.setQueryForTest("indentsQuery", query);
    editor.setText(text);
    const mode = new TreeSitterLanguageMode({
      grammars: lumine.grammars,
      grammar,
      buffer: editor.getBuffer(),
      config: lumine.config,
    });
    editor.getBuffer().setLanguageMode(mode);
    await mode.ready;
    await editor.whenGrammarSettled();
    return mode;
  }

  it("does not dedent a blank edited row for a parser-inserted closing delimiter", async () => {
    const mode = await start("function work() {\n  call();\n    ", '"}" @dedent');
    const captures = mode.rootLanguageLayer.queries.indentsQuery.captures(
      mode.rootLanguageLayer.tree.rootNode,
    );
    expect(captures.some(({ node }) => node.isMissing)).toBe(true);
    expect(await mode.suggestedIndentForEditedBufferRow(2, 2)).toBe(2);
  });

  it("still dedents a closing delimiter typed alone on its row", async () => {
    const mode = await start("function work() {\n  call();\n    }", '"}" @dedent');
    expect(await mode.suggestedIndentForEditedBufferRow(2, 2)).toBe(0);
  });

  it("leaves manual indentation alone when a closing delimiter is followed by code", async () => {
    const mode = await start("function work() {\n  call();\n    } // deliberate", '"}" @dedent');
    expect(await mode.suggestedIndentForEditedBufferRow(2, 2)).toBe(2);
  });
});
