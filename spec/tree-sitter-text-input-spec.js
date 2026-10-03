const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const CSON = require("@lumine-code/season");

const grammarPath = require.resolve("language-javascript/grammars/javascript.json");

describe("Tree-sitter bounded text input", () => {
  let buffer, grammar;

  beforeEach(() => {
    jasmine.useRealClock();
    buffer = new TextBuffer();
    grammar = null;
  });

  afterEach(() => {
    buffer.destroy();
    grammar?.subscriptions?.dispose();
  });

  async function buildLanguageMode(source) {
    const config = CSON.readFileSync(grammarPath);
    grammar = new TreeSitterGrammar(lumine.grammars, grammarPath, {
      ...config,
      treeSitter: { ...config.treeSitter, injectionsQuery: [] },
    });
    buffer.setText(source);
    const mode = new TreeSitterLanguageMode({
      grammars: lumine.grammars,
      grammar,
      buffer,
      syncTimeoutMicros: 1000000,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    return mode;
  }

  function readChunk(index, size) {
    return TreeSitterLanguageMode.prototype.getTextInputChunk.call({ buffer }, index, size);
  }

  function modeWithParser(parser) {
    return Object.assign(Object.create(TreeSitterLanguageMode.prototype), {
      buffer,
      acquireParserForLanguage: () => parser,
      resetParserForLanguage: () => parser,
      releaseParserForLanguage: jasmine.createSpy("releaseParserForLanguage"),
    });
  }

  it("preserves exact UTF-16 slices inside CRLF and surrogate pairs", () => {
    const source = "a\r\n😀\r\nbc\n終\r\n";
    buffer.setText(source);
    const getText = spyOn(buffer, "getText").and.throwError("Unexpected full-buffer copy");

    for (let index = 0; index <= source.length + 1; index++) {
      for (const size of [1, 2, 3, 4, 4096, 32768]) {
        expect(readChunk(index, size))
          .withContext(`index ${index}, size ${size}`)
          .toBe(source.slice(index, index + size));
      }
    }
    expect(getText).not.toHaveBeenCalled();
  });

  it("reads exact chunks across CRLF split between native patch layers", () => {
    buffer.setText("first\nsecond\n");
    buffer.insert([0, 5], "\r", { normalizeLineEndings: false });
    buffer.insert([1, 6], "\r", { normalizeLineEndings: false });
    const source = "first\r\nsecond\r\n";

    for (let index = 0; index <= source.length; index++) {
      expect(readChunk(index, 1)).toBe(source.slice(index, index + 1));
      expect(readChunk(index, 6)).toBe(source.slice(index, index + 6));
    }
  });

  it("completes incremental parsing without materializing the whole buffer", async () => {
    const mode = await buildLanguageMode("const alpha = 1;\r\n");
    const getText = spyOn(buffer, "getText").and.callThrough();

    buffer.append("const beta = 2;\r\n");
    await mode.atTransactionEnd();

    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(mode.tree.rootNode.descendantsOfType("identifier").map((node) => node.text)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(getText).not.toHaveBeenCalled();
  });

  it("freezes async input before yielding and returns to live reads after completion", async () => {
    const source = "const first = 1;";
    buffer.setText(source);
    const getText = spyOn(buffer, "getText").and.callThrough();
    let callback,
      attempts = 0;
    const parser = {
      parse(input) {
        callback = input;
        attempts++;
        if (attempts === 1) {
          expect(input(0)).toBe(source);
          return null;
        }
        return { parsedText: input(0) };
      },
    };
    const mode = modeWithParser(parser);

    const result = mode.parseAsync({}, null, null);
    expect(getText).toHaveBeenCalledTimes(1);
    buffer.setText("const later = 2;");
    const tree = await result;

    expect(tree.parsedText).toBe(source);
    expect(callback(0)).toBe("const later = 2;");
    expect(getText).toHaveBeenCalledTimes(1);
    expect(mode.releaseParserForLanguage).toHaveBeenCalledTimes(1);
  });

  it("releases the parser if freezing async input fails", () => {
    buffer.setText("const value = 1;");
    const mode = modeWithParser({ parse: () => null });
    spyOn(buffer, "getText").and.throwError("Cannot freeze text");

    expect(() => mode.parseAsync({}, null, null)).toThrowError(/Cannot freeze text/);
    expect(mode.releaseParserForLanguage).toHaveBeenCalledTimes(1);
  });

  it("preserves large node text when parser chunks split CRLF and surrogate pairs", async () => {
    // Put CR at the last code unit of a parser chunk, and later put the first
    // half of an astral character at another chunk boundary.
    const prefix = "const value = `";
    const contents = `${"a".repeat(4095 - prefix.length)}\r\n${"b".repeat(4094)}😀${"c".repeat(40000)}`;
    const source = `${prefix}${contents}\`;`;
    const mode = await buildLanguageMode(source);
    const getText = spyOn(buffer, "getText").and.throwError("Unexpected full-buffer copy");
    const tree = mode.parse(mode.rootLanguage, null, null);

    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType("template_string")[0].text).toBe(`\`${contents}\``);
      expect(getText).not.toHaveBeenCalled();
    } finally {
      tree.delete();
    }
  });

  it("reads current text through a dirty tree without rebuilding the full string", async () => {
    const mode = await buildLanguageMode("const value = `old text`;\r\n");
    const tree = mode.parse(mode.rootLanguage, null, null);
    const template = tree.rootNode.descendantsOfType("template_string")[0];
    const getText = spyOn(buffer, "getText").and.throwError("Unexpected full-buffer copy");

    try {
      buffer.setTextInRange(
        [
          [0, 15],
          [0, 23],
        ],
        "new text",
      );
      tree.edit({
        startIndex: 15,
        oldEndIndex: 23,
        newEndIndex: 23,
        startPosition: { row: 0, column: 15 },
        oldEndPosition: { row: 0, column: 23 },
        newEndPosition: { row: 0, column: 23 },
      });

      expect(template.text).toBe("`new text`");
      expect(getText).not.toHaveBeenCalled();
      await mode.atTransactionEnd();
    } finally {
      tree.delete();
    }
  });
});
