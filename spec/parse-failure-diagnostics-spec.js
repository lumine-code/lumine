const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

// A fault inside a grammar's wasm arrives as a bare
// `RuntimeError: memory access out of bounds` whose stack stops at
// `Parser.parse`. It names neither the grammar nor what was being parsed, and
// because injection layers parse through the same path, the file's own grammar
// is not even a reliable guess. Everything here is about the message.

const jsGrammarPath = require.resolve("language-javascript/grammars/tree-sitter-javascript.json");

describe("parse failure diagnostics", () => {
  let buffer, languageMode, grammar;

  beforeEach(async () => {
    jasmine.useRealClock();
    buffer = new TextBuffer("const answer = 42;\n");
    grammar = new TreeSitterGrammar(atom.grammars, jsGrammarPath, CSON.readFileSync(jsGrammarPath));
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;
  });

  afterEach(() => {
    languageMode.destroy();
  });

  function breakTheParser() {
    const language = grammar.getLanguageSync();
    const parser = languageMode.getOrCreateParserForLanguage(language);
    spyOn(parser, "parse").and.throwError(new Error("memory access out of bounds"));
    return language;
  }

  it("names the grammar and the buffer when a synchronous parse faults", () => {
    const language = breakTheParser();

    let error = null;
    try {
      languageMode.parse(language, null, undefined, { scopeName: "source.js" });
    } catch (err) {
      error = err;
    }

    expect(error).not.toBe(null);
    expect(error.message).toContain("source.js");
    expect(error.message).toContain("memory access out of bounds");
    expect(error.message).toContain(`buffer length ${buffer.getLength()}`);
    expect(error.cause).toBeTruthy();
  });

  it("names the grammar when an asynchronous parse faults", async () => {
    const language = breakTheParser();

    let error = null;
    try {
      await languageMode.parseAsync(language, null, undefined, { scopeName: "source.js" });
    } catch (err) {
      error = err;
    }

    expect(error).not.toBe(null);
    expect(error.message).toContain("source.js");
    expect(error.message).toContain("memory access out of bounds");
  });

  it("reports the included range count, so an injection layer is recognisable", () => {
    const language = breakTheParser();
    const includedRanges = [
      {
        startIndex: 0,
        endIndex: 5,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: 5 },
      },
    ];

    let error = null;
    try {
      languageMode.parse(language, null, includedRanges, { scopeName: "source.js.regexp" });
    } catch (err) {
      error = err;
    }

    expect(error.message).toContain("source.js.regexp");
    expect(error.message).toContain("1 included range(s)");
  });

  it("releases the parser back to the pool when a parse faults", () => {
    const language = breakTheParser();
    const parser = languageMode.getOrCreateParserForLanguage(language);

    try {
      languageMode.parseAsync(language, null, undefined, { scopeName: "source.js" });
    } catch {
      // expected
    }

    // A parser left marked in-use is never handed out again, so every
    // subsequent parse builds a fresh one and the old one leaks.
    expect(languageMode.getOrCreateParserForLanguage(language)).toBe(parser);
  });
});
