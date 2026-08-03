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

const jsGrammarPath = require.resolve("language-javascript/grammars/tree-sitter-javascript.json");

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
    grammar = new TreeSitterGrammar(atom.grammars, jsGrammarPath, CSON.readFileSync(jsGrammarPath));
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
});
