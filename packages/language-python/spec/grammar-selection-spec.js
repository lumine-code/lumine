// The "Use Tree-Sitter Parsers" setting only breaks ties between grammars
// that match a file; a fileTypes entry present only in the TextMate grammar
// routes that extension to TextMate no matter what the setting says. These
// specs pin that every python file type is listed by the tree-sitter grammar
// too, so the setting stays in control.
describe("Python grammar selection", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("language-python");
  });

  it("selects the tree-sitter grammar for python file types when enabled", () => {
    atom.config.set("language.useTreeSitterParsers", true);
    for (const name of ["main.py", "types.pyi", "gui.pyw"]) {
      const grammar = atom.grammars.selectGrammar(name, "");
      expect(grammar.scopeName).toBe("source.python");
      expect(grammar.constructor.name).toBe("WASMTreeSitterGrammar");
    }
  });

  it("selects the IPython tree-sitter grammar for .ipy files when enabled", () => {
    atom.config.set("language.useTreeSitterParsers", true);
    const grammar = atom.grammars.selectGrammar("main.ipy", "");
    expect(grammar.name).toBe("IPython");
    expect(grammar.scopeName).toBe("source.python.ipy");
    expect(grammar.constructor.name).toBe("WASMTreeSitterGrammar");
  });

  it("falls back to the TextMate grammar when tree-sitter is disabled", () => {
    atom.config.set("language.useTreeSitterParsers", false);
    const grammar = atom.grammars.selectGrammar("main.ipy", "");
    expect(grammar.scopeName).toBe("source.python");
    expect(grammar.constructor.name).not.toBe("WASMTreeSitterGrammar");
  });
});
