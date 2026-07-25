const { Point } = require("atom");

// The IPython grammar (source.python.ipy) is backed by the lumine-code fork of
// tree-sitter-python, which adds statement-level rules for IPython-only syntax
// so .ipy sources parse without ERROR nodes corrupting their neighbors.
describe("IPython grammar (modern Tree-sitter)", () => {
  let editor;
  let languageMode;

  const setUp = async (text) => {
    editor = await atom.workspace.open();
    const buffer = editor.getBuffer();
    buffer.setText(text);
    atom.grammars.assignLanguageMode(buffer, "source.python.ipy");
    languageMode = buffer.getLanguageMode();
    await languageMode.ready;
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };

  beforeEach(async () => {
    atom.config.set("language.useTreeSitterParsers", true);
    await atom.packages.activatePackage("language-python");
  });

  it("parses magics, shell escapes, and help requests without errors", async () => {
    await setUp("%matplotlib inline\n!pip install numpy\nnp.mean??\n?np.mean\n%%timeit\nf(x)\n");
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    expect(languageMode.getSyntaxNodeAtPosition(new Point(0, 2)).type).toBe("magic_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(1, 2)).type).toBe("shell_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(2, 2)).type).toBe("help_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(3, 2)).type).toBe("help_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(4, 2)).type).toBe("magic_statement");
  });

  it("keeps statements after a magic line intact", async () => {
    await setUp("a = 1\n%cd ..\nb = 2\n");
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    // Before the fork, the magic's ERROR swallowed the next line and `b = 2`
    // mis-parsed as an attribute chain.
    let node = languageMode.getSyntaxNodeAtPosition(new Point(2, 0));
    while (node && node.type !== "assignment") node = node.parent;
    expect(node.type).toBe("assignment");
    expect(node.startPosition.row).toBe(2);
  });

  it("leaves plain python syntax untouched", async () => {
    await setUp('c = a % b\nd = a != b\nx = f"{v!r}"\n');
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    const modulo = languageMode.getSyntaxNodeAtPosition(new Point(0, 6));
    let binary = modulo;
    while (binary && binary.type !== "binary_operator") binary = binary.parent;
    expect(binary.type).toBe("binary_operator");
  });

  it("highlights the IPython statements with dedicated scopes", async () => {
    await setUp("%matplotlib inline\n!ls\nnp.mean?\n");
    expect(editor.scopeDescriptorForBufferPosition([0, 2]).toString()).toContain(
      "support.function.magic.ipython",
    );
    expect(editor.scopeDescriptorForBufferPosition([1, 1]).toString()).toContain(
      "string.unquoted.shell.ipython",
    );
    expect(editor.scopeDescriptorForBufferPosition([2, 2]).toString()).toContain(
      "keyword.operator.help.ipython",
    );
  });

  it("keeps python folds working, including multiline strings", async () => {
    await setUp("doc.x('''\n11\n''')\n%pwd\n");
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    expect(editor.isFoldableAtBufferRow(0)).toBe(true);
  });
});

// The TextMate twin of the grammar above, used when tree-sitter parsers are
// disabled. IPython lines get the same scopes; everything else delegates to
// the TextMate python grammar via `include source.python`.
describe("IPython grammar (TextMate)", () => {
  let grammar;

  beforeEach(async () => {
    atom.config.set("language.useTreeSitterParsers", false);
    await atom.packages.activatePackage("language-python");
    grammar = atom.grammars.grammarForScopeName("source.python.ipy");
  });

  afterEach(() => {
    atom.config.set("language.useTreeSitterParsers", true);
  });

  it("is the TextMate grammar when tree-sitter is disabled", () => {
    expect(grammar).toBeDefined();
    expect(grammar.name).toBe("IPython");
    expect(grammar.constructor.name).not.toBe("WASMTreeSitterGrammar");
  });

  it("tokenizes IPython statements with the dedicated scopes", () => {
    expect(grammar.tokenizeLine("%matplotlib inline").tokens[0].scopes).toContain(
      "support.function.magic.ipython",
    );
    expect(grammar.tokenizeLine("%%timeit").tokens[0].scopes).toContain(
      "support.function.magic.ipython",
    );
    expect(grammar.tokenizeLine("!pip install numpy").tokens[0].scopes).toContain(
      "string.unquoted.shell.ipython",
    );
    expect(grammar.tokenizeLine("?np.mean").tokens[0].scopes).toContain(
      "keyword.operator.help.ipython",
    );
    expect(grammar.tokenizeLine("np.mean??").tokens[0].scopes).toContain(
      "keyword.operator.help.ipython",
    );
  });

  it("delegates plain python lines to source.python", () => {
    const { tokens } = grammar.tokenizeLine("def foo():");
    expect(tokens[0].value).toBe("def");
    expect(tokens[0].scopes).toContain("storage.type.function.python");
  });

  it("leaves continuation-style operator lines untouched", () => {
    // Break-before-operator formatting must not be mistaken for IPython.
    expect(grammar.tokenizeLine("!= b").tokens[0].scopes).not.toContain(
      "string.unquoted.shell.ipython",
    );
    expect(grammar.tokenizeLine("% b").tokens[0].scopes).not.toContain(
      "support.function.magic.ipython",
    );
  });
});
