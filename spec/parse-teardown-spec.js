const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

// Initial worker work may outlive the buffer. Closing a parser cancels work
// while the binding retains native resources until that work has settled.

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
    buffer?.destroy();
    languageMode?.destroy();
    grammar.deactivate();
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

  it("cancels active native work and releases the pool after settlement", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;
    languageMode.syncTimeoutMicros = 0;
    const language = grammar.getLanguageSync();
    const parser = languageMode.getOrCreateParserForLanguage(language);
    const close = spyOn(parser, "close").and.callThrough();
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const parse = parser.parse.bind(parser);
    spyOn(parser, "parse").and.callFake((...args) => {
      const result = parse(...args);
      started();
      return result;
    });
    const result = languageMode.parseAsync(language, null, undefined, { scopeName: "source.js" });
    await entered;
    languageMode.destroy();
    expect(close).toHaveBeenCalled();
    await expectAsync(result).toBeResolvedTo(null);
    expect(languageMode.parsersByLanguage.size).toBe(0);
  });

  it("closes idle parsers immediately", async () => {
    await startLongParse();

    const language = grammar.getLanguageSync();
    const parser = languageMode.getOrCreateParserForLanguage(language);
    spyOn(parser, "close").and.callThrough();

    languageMode.destroy();

    expect(parser.close).toHaveBeenCalled();
  });

  it("keeps only a bounded number of idle parsers after a burst", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({
      buffer,
      grammar,
      maxIdleParsersPerLanguage: 2,
    });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;

    const language = grammar.getLanguageSync();
    const parsers = Array.from({ length: 6 }, () =>
      languageMode.acquireParserForLanguage(language),
    );
    for (const parser of parsers) spyOn(parser, "close").and.callThrough();
    const pool = languageMode.getParserPoolForLanguage(language);
    expect(pool.active.size).toBe(6);
    expect(pool.idle.length).toBe(0);

    for (const parser of parsers) {
      languageMode.releaseParserForLanguage(language, parser);
    }

    expect(pool.active.size).toBe(0);
    expect(pool.idle.length).toBe(2);
    expect(parsers.filter((parser) => parser.close.calls.count() === 1).length).toBe(4);
  });

  it("lets an acquired parser release itself after the mode is destroyed", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;
    const language = grammar.getLanguageSync();
    const parser = languageMode.acquireParserForLanguage(language);
    spyOn(parser, "close").and.callThrough();
    languageMode.destroy();
    expect(parser.close).toHaveBeenCalled();
    languageMode.releaseParserForLanguage(language, parser);
    languageMode.releaseParserForLanguage(language, parser);
    expect(languageMode.parsersByLanguage.size).toBe(0);
  });

  for (const asynchronous of [false, true]) {
    it(`reuses the parser after a failed ${asynchronous ? "background" : "synchronous"} parse`, async () => {
      buffer = new TextBuffer("const value = 1;");
      languageMode = new TreeSitterLanguageMode({ buffer, grammar });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      languageMode.syncTimeoutMicros = 0;
      const language = grammar.getLanguageSync();
      const parser = languageMode.getOrCreateParserForLanguage(language);
      const method = asynchronous ? "parse" : "parseSync";
      const parse = spyOn(parser, method).and.throwError(new Error("parse failed"));
      const attempt = () =>
        languageMode[asynchronous ? "parseAsync" : "parse"](language, null, undefined, {
          scopeName: "source.js",
        });
      if (asynchronous) await expectAsync(attempt()).toBeRejectedWithError(/parse failed/);
      else expect(attempt).toThrowError(/parse failed/);
      expect(languageMode.getOrCreateParserForLanguage(language)).toBe(parser);
      parse.and.callThrough();
      const tree = await attempt();
      expect(tree.rootNode.type).toBe("program");
      expect(tree.input).toBe(buffer.getText());
    });
  }

  it("retains published node and cursor text after the owning mode closes", async () => {
    buffer = new TextBuffer("const value = 1;");
    languageMode = new TreeSitterLanguageMode({ buffer, grammar });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;
    const node = languageMode.tree.rootNode;
    const cursor = node.walk();
    languageMode.destroy();
    expect(node.text).toBe("const value = 1;");
    expect(cursor.nodeText).toBe(node.text);
    expect(languageMode.parsersByLanguage.size).toBe(0);
  });

  it("ignores an old tree from another language instance", async () => {
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

    const asynchronousTree = await languageMode.parseAsync(
      language,
      incompatibleOldTree,
      undefined,
      { scopeName: "source.js" },
    );
    expect(asynchronousTree.rootNode.type).toBe("program");
  });
});
