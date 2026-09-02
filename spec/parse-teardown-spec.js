const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

// A parse long enough to go async resumes on `setImmediate`, so a batch can
// still be queued when the buffer is destroyed. `destroy` used to delete every
// parser it owned, including that one, and the next batch then read wasm memory
// that had just been freed — `RuntimeError: memory access out of bounds`, with a
// stack that stops at `Parser.parse` and names nothing useful.
//
// It shows up constantly in spec runs, which open and tear down windows in
// quick succession, and for a user on closing a large file mid-parse.

const jsGrammarPath = require.resolve("language-javascript/grammars/javascript.json");

function buildSource(lines) {
  const parts = [];
  for (let i = 0; i < lines; i++) {
    parts.push(`function handler${i}(alpha, beta) { return alpha * ${i} + beta; }`);
  }
  return parts.join("\n");
}

describe("destroying a buffer during an async parse", () => {
  let buffer, languageMode, grammar;

  beforeEach(() => {
    jasmine.useRealClock();
    grammar = new TreeSitterGrammar(
      lumine.grammars,
      jsGrammarPath,
      CSON.readFileSync(jsGrammarPath),
    );
  });

  afterEach(() => {
    languageMode?.destroy();
  });

  async function startLongParse() {
    buffer = new TextBuffer(buildSource(20000));
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await grammar.getLanguage();
  }

  it("stops the parse loop instead of faulting on a freed parser", async () => {
    await startLongParse();

    const language = grammar.getLanguageSync();
    const result = languageMode.parseAsync(language, null, undefined, { scopeName: "source.js" });

    // A buffer this size cannot finish inside the initial budget, so this must
    // be the async path — otherwise the case under test never happens.
    expect(typeof result.then).toBe("function");

    languageMode.destroy();

    // The loop notices and abandons the parse rather than reading freed memory.
    await expectAsync(result).toBeResolvedTo(null);
  });

  it("does not create a root layer when destroyed before the grammar loads", async () => {
    const language = await grammar.getLanguage();
    let releaseLanguage;
    spyOn(grammar, "getLanguage").and.returnValue(
      new Promise((resolve) => {
        releaseLanguage = () => resolve(language);
      }),
    );
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    const didTokenize = jasmine.createSpy("did-tokenize");
    languageMode.onDidTokenize(didTokenize);

    languageMode.destroy();
    releaseLanguage();
    await languageMode.ready;

    expect(languageMode.rootLanguageLayer).toBeNull();
    expect(languageMode.parsersByLanguage.size).toBe(0);
    expect(didTokenize).not.toHaveBeenCalled();
  });

  it("leaves a parser that is still mid-parse for the loop to delete", async () => {
    await startLongParse();

    const language = grammar.getLanguageSync();
    const parser = languageMode.getOrCreateParserForLanguage(language);
    spyOn(parser, "delete").and.callThrough();

    const result = languageMode.parseAsync(language, null, undefined, { scopeName: "source.js" });
    expect(typeof result.then).toBe("function");

    languageMode.destroy();
    // Deleting here is what freed the memory the next batch read.
    expect(parser.delete).not.toHaveBeenCalled();

    await result;
    expect(parser.delete).toHaveBeenCalled();
  });

  it("still deletes parsers that are not in use", async () => {
    await startLongParse();

    const language = grammar.getLanguageSync();
    const parser = languageMode.getOrCreateParserForLanguage(language);
    spyOn(parser, "delete").and.callThrough();

    languageMode.destroy();

    expect(parser.delete).toHaveBeenCalled();
  });

  it("replaces a parser whose Wasm handle faults during reset", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;

    const language = grammar.getLanguageSync();
    const staleParser = languageMode.getOrCreateParserForLanguage(language);
    spyOn(staleParser, "delete").and.callThrough();
    spyOn(staleParser, "reset").and.throwError(
      new WebAssembly.RuntimeError("memory access out of bounds"),
    );

    const tree = await languageMode.parseAsync(language, null, undefined, {
      scopeName: "source.js",
    });

    expect(tree.rootNode.type).toBe("program");
    expect(staleParser.delete).not.toHaveBeenCalled();
    const replacement = languageMode.getOrCreateParserForLanguage(language);
    expect(replacement).not.toBe(staleParser);
    tree.delete();

    const secondTree = await languageMode.parseAsync(language, null, undefined, {
      scopeName: "source.js",
    });
    expect(languageMode.getOrCreateParserForLanguage(language)).toBe(replacement);
    secondTree.delete();
  });

  it("also replaces a stale parser before a synchronous parse", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;

    const language = grammar.getLanguageSync();
    const staleParser = languageMode.getOrCreateParserForLanguage(language);
    spyOn(staleParser, "delete").and.callThrough();
    spyOn(staleParser, "reset").and.throwError(
      new WebAssembly.RuntimeError("memory access out of bounds"),
    );

    const tree = languageMode.parse(language, null, undefined, { scopeName: "source.js" });

    expect(tree.rootNode.type).toBe("program");
    expect(staleParser.delete).not.toHaveBeenCalled();
    const replacement = languageMode.getOrCreateParserForLanguage(language);
    expect(replacement).not.toBe(staleParser);
    tree.delete();

    const secondTree = languageMode.parse(language, null, undefined, { scopeName: "source.js" });
    expect(languageMode.getOrCreateParserForLanguage(language)).toBe(replacement);
    secondTree.delete();
  });

  it("does not hide ordinary parser reset failures", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;

    const language = grammar.getLanguageSync();
    const parser = languageMode.getOrCreateParserForLanguage(language);
    spyOn(parser, "reset").and.throwError(new Error("unexpected reset failure"));

    expect(() =>
      languageMode.parse(language, null, undefined, { scopeName: "source.js" }),
    ).toThrowError(/unexpected reset failure/);
    expect(languageMode.getOrCreateParserForLanguage(language)).toBe(parser);
  });

  it("drops an old Wasm tree from another language instance", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;

    const language = grammar.getLanguageSync();
    const incompatibleOldTree = { language: {} };
    const synchronousTree = languageMode.parse(language, incompatibleOldTree, undefined, {
      scopeName: "source.js",
    });
    expect(synchronousTree.rootNode.type).toBe("program");
    synchronousTree.delete();

    const asynchronousTree = await languageMode.parseAsync(
      language,
      incompatibleOldTree,
      undefined,
      { scopeName: "source.js" },
    );
    expect(asynchronousTree.rootNode.type).toBe("program");
    asynchronousTree.delete();
  });
});
