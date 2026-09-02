const fs = require("fs");
const path = require("path");
const dedent = require("dedent");
const TextBuffer = require("../src/text-buffer");
const { Point, Range } = TextBuffer;
const CSON = require("@lumine-code/season");
const TextEditor = require("../src/text-editor");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const ScopeResolver = require("../src/scope-resolver");
const Random = require("random-seed");
const { getRandomBufferRange, buildRandomLines } = require("./helpers/random");

// Language packages live in their own repositories and arrive through
// node_modules, so resolve them by name rather than by a path into packages/.
function resolve(modulePath) {
  return require.resolve(modulePath);
}

// Just for syntax highlighting.
function scm(strings) {
  return strings.join("");
}

const cGrammarPath = resolve("language-c/grammars/c.json");
const pythonGrammarPath = resolve("language-python/grammars/python.json");
const jsGrammarPath = resolve("language-javascript/grammars/javascript.json");

const jsRegexGrammarPath = resolve("language-regex/grammars/regex.json");

const jsdocGrammarPath = resolve("language-javascript/grammars/jsdoc.json");
const htmlGrammarPath = resolve("language-html/grammars/html.json");
const ejsGrammarPath = resolve("language-html/grammars/ejs.json");

let jsConfig = {
  ...CSON.readFileSync(jsGrammarPath),
  injectionNames: ["js", "javascript"],
};
let jsRegexConfig = {
  ...CSON.readFileSync(jsRegexGrammarPath),
  injectionNames: ["js-regex"],
};
let cConfig = { ...CSON.readFileSync(cGrammarPath), injectionNames: ["c"] };
let pythonConfig = {
  ...CSON.readFileSync(pythonGrammarPath),
  injectionNames: ["py", "python"],
};
let htmlConfig = { ...CSON.readFileSync(htmlGrammarPath), injectionNames: ["html"] };

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TreeSitterLanguageMode", () => {
  let editor, buffer, grammar;

  beforeEach(async () => {
    grammar = null;
    editor = await lumine.workspace.open("");
    buffer = editor.getBuffer();
    editor.displayLayer.reset({ foldCharacter: "…" });
  });

  afterEach(() => {
    if (grammar) {
      grammar?.subscriptions?.dispose();
    }
  });

  // Callers destructure the result, so the shape has to hold on every path out
  // — including the early one taken before the mode has tokenized.
  describe("atTransactionEnd", () => {
    it("describes a transaction even before the mode has tokenized", async () => {
      jasmine.useRealClock();
      grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
      buffer.setLanguageMode(
        new TreeSitterLanguageMode({ grammar, buffer, config: lumine.config }),
      );
      const languageMode = buffer.getLanguageMode();
      expect(languageMode.tokenized).toBe(false);

      const { range, changeCount, autoIndentRequests } = await languageMode.atTransactionEnd();
      expect(range).toBeNull();
      expect(changeCount).toBe(0);
      expect(autoIndentRequests).toBe(0);
    });
  });

  describe("query reload lifecycle", () => {
    async function buildLanguageLayer() {
      grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      return languageMode.rootLanguageLayer;
    }

    it("unsubscribes a destroyed layer from grammar query changes", async () => {
      const layer = await buildLanguageLayer();
      spyOn(layer, "reloadGrammarQuery").and.resolveTo();

      layer.destroy();
      grammar.emitter.emit("did-change-query", { queryType: "highlightsQuery" });

      expect(layer.reloadGrammarQuery).not.toHaveBeenCalled();
    });

    it("serializes distinct query reloads without dropping either one", async () => {
      const layer = await buildLanguageLayer();
      let releaseFirstReload;
      spyOn(layer, "reloadGrammarQuery").and.callFake((queryType) => {
        if (queryType === "highlightsQuery") {
          return new Promise((resolve) => {
            releaseFirstReload = resolve;
          });
        }
        return Promise.resolve();
      });

      grammar.emitter.emit("did-change-query", { queryType: "highlightsQuery" });
      grammar.emitter.emit("did-change-query", { queryType: "foldsQuery" });
      expect(layer.reloadGrammarQuery.calls.allArgs()).toEqual([["highlightsQuery"]]);

      releaseFirstReload();
      await layer.queryReloadPromise;

      expect(layer.reloadGrammarQuery.calls.allArgs()).toEqual([
        ["highlightsQuery"],
        ["foldsQuery"],
      ]);
    });
  });

  describe("update scheduling", () => {
    it("skips injection work for a grammar with no injection points or layers", async () => {
      jasmine.useRealClock();
      grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
      buffer.setText("const value = 1;");
      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      const rootLayer = languageMode.rootLanguageLayer;
      spyOn(rootLayer, "_collectInjectionCandidateNodes").and.callThrough();

      buffer.append("\nvalue++;");
      await languageMode.atTransactionEnd();

      expect(rootLayer._collectInjectionCandidateNodes).not.toHaveBeenCalled();
    });

    it("coalesces dirty-tree highlight requests until the transaction settles", async () => {
      grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      let settleTransaction;
      languageMode.nextTransaction = new Promise((resolve) => {
        settleTransaction = resolve;
      });
      spyOn(languageMode, "emitRangeUpdate");

      languageMode.scheduleDirtyHighlightUpdate(new Range([1, 0], [3, 0]));
      languageMode.scheduleDirtyHighlightUpdate(new Range([2, 0], [4, 0]));
      expect(languageMode.emitRangeUpdate).not.toHaveBeenCalled();

      settleTransaction();
      await languageMode.dirtyHighlightPromise;

      expect(languageMode.emitRangeUpdate).toHaveBeenCalledOnceWith(new Range([1, 0], [4, 0]));
    });
  });

  describe("highlighting", () => {
    it("applies the most specific scope mapping to each node in the syntax tree", async () => {
      jasmine.useRealClock();
      grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (member_expression object: (identifier) @support)

        (call_expression
          function: (identifier) @support)

        (assignment_expression
          left: (member_expression
            property: (property_identifier) @variable))

        ["="] @keyword

        ["." "(" ")" ";"] @punctuation
      `,
      );

      buffer.setText("aa.bbb = cc(d.eee());");

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      await wait(0);

      expectTokensToEqual(editor, [
        [
          { text: "aa", scopes: ["support"] },
          { text: ".", scopes: ["punctuation"] },
          { text: "bbb", scopes: ["variable"] },
          { text: " ", scopes: [] },
          { text: "=", scopes: ["keyword"] },
          { text: " ", scopes: [] },
          { text: "cc", scopes: ["support"] },
          { text: "(", scopes: ["punctuation"] },
          { text: "d", scopes: ["support"] },
          { text: ".", scopes: ["punctuation"] },
          { text: "eee", scopes: [] },
          { text: "(", scopes: ["punctuation"] },
          { text: ")", scopes: ["punctuation"] },
          { text: ")", scopes: ["punctuation"] },
          { text: ";", scopes: ["punctuation"] },
        ],
      ]);
    });

    it("can start or end multiple scopes at the same position", async () => {
      jasmine.useRealClock();
      grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (member_expression object: (identifier) @support)

        (call_expression
          function: (identifier) @call)

        (call_expression
          function: (member_expression
            property: (property_identifier) @call))

        (assignment_expression left: (identifier) @variable)
        (assignment_expression
          left: (member_expression
            property: (property_identifier) @variable))

        (member_expression object: (identifier) @object
          property: (_) @member)

        "(" @open-paren
        ")" @close-paren
      `,
      );

      buffer.setText("a = bb.ccc();");

      const languageMode = new TreeSitterLanguageMode({
        grammar,
        buffer,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      expectTokensToEqual(editor, [
        [
          { text: "a", scopes: ["variable"] },
          { text: " = ", scopes: [] },
          { text: "bb", scopes: ["support", "object"] },
          { text: ".", scopes: [] },
          { text: "ccc", scopes: ["call", "member"] },
          { text: "(", scopes: ["open-paren"] },
          { text: ")", scopes: ["close-paren"] },
          { text: ";", scopes: [] },
        ],
      ]);
    });

    it("can resume highlighting on a line that starts with whitespace", async () => {
      jasmine.useRealClock();
      grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (member_expression object: (_) @variable)

        (call_expression
          (member_expression property: (_) @function))
      `,
      );

      buffer.setText("a\n  .b();");

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      expectTokensToEqual(editor, [
        [{ text: "a", scopes: ["variable"] }],
        [
          { text: "  ", scopes: ["leading-whitespace"] },
          { text: ".", scopes: [] },
          { text: "b", scopes: ["function"] },
          { text: "();", scopes: [] },
        ],
      ]);
    });

    it("correctly skips over tokens with zero size", async () => {
      jasmine.useRealClock();
      grammar = new TreeSitterGrammar(lumine.grammars, cGrammarPath, cConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (primitive_type) @storage
        (declaration declarator: (identifier) @variable)
        (function_declarator declarator: (identifier) @entity)
      `,
      );
      buffer.setText("int main() {\n  int a\n  int b;\n}");

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);
      // editor.displayLayer.getScreenLines(0, Infinity);

      expect(
        languageMode.tree.rootNode.descendantForPosition(Point(1, 2), Point(1, 6)).toString(),
      ).toBe("(declaration type: (primitive_type)" + ' declarator: (identifier) (MISSING ";"))');

      languageMode.emitRangeUpdate(buffer.getRange());

      expectTokensToEqual(editor, [
        [
          { text: "int", scopes: ["storage"] },
          { text: " ", scopes: [] },
          { text: "main", scopes: ["entity"] },
          { text: "() {", scopes: [] },
        ],
        [
          { text: "  ", scopes: ["leading-whitespace"] },
          { text: "int", scopes: ["storage"] },
          { text: " ", scopes: [] },
          { text: "a", scopes: ["variable"] },
        ],
        [
          { text: "  ", scopes: ["leading-whitespace"] },
          { text: "int", scopes: ["storage"] },
          { text: " ", scopes: [] },
          { text: "b", scopes: ["variable"] },
          { text: ";", scopes: [] },
        ],
        [{ text: "}", scopes: [] }],
      ]);
    });

    it("updates lines' highlighting when they are affected by distant changes", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (call_expression (identifier) @function)
        (property_identifier) @member
      `,
      );

      buffer.setText("a(\nb,\nc\n");

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      // missing closing paren
      expectTokensToEqual(editor, [
        [{ text: "a(", scopes: [] }],
        [{ text: "b,", scopes: [] }],
        [{ text: "c", scopes: [] }],
        [{ text: "", scopes: [] }],
      ]);

      buffer.append(")");

      // TODO: Any way around this?
      await languageMode.nextTransaction;

      expectTokensToEqual(editor, [
        [
          { text: "a", scopes: ["function"] },
          { text: "(", scopes: [] },
        ],
        [{ text: "b,", scopes: [] }],
        [{ text: "c", scopes: [] }],
        [{ text: ")", scopes: [] }],
      ]);
    });

    it("updates the range of the current node in the tree when highlight.invalidateOnChange is set", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        ((template_string) @lorem
          (#match? @lorem "lorem")
          (#set! highlight.invalidateOnChange true))
        ((template_string) @ipsum
          (#not-match? @ipsum "lorem")
          (#set! highlight.invalidateOnChange true))
      `,
      );

      buffer.setText(dedent`\`


        lore


      \``);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      expectTokensToEqual(editor, [
        [{ text: "`", scopes: ["ipsum"] }],
        [{ text: "", scopes: [] }],
        [{ text: "", scopes: [] }],
        [
          { text: "  ", scopes: ["ipsum", "leading-whitespace"] },
          { text: "lore", scopes: ["ipsum"] },
        ],
        [{ text: "", scopes: [] }],
        [{ text: "", scopes: [] }],
        [{ text: "`", scopes: ["ipsum"] }],
      ]);

      editor.setCursorBufferPosition([3, 6]);
      editor.insertText("m");

      // TODO: Any way around this?
      await languageMode.nextTransaction;
      await wait(0);

      expectTokensToEqual(editor, [
        [{ text: "`", scopes: ["lorem"] }],
        [{ text: "", scopes: [] }],
        [{ text: "", scopes: [] }],
        [
          { text: "  ", scopes: ["lorem", "leading-whitespace"] },
          { text: "lorem", scopes: ["lorem"] },
        ],
        [{ text: "", scopes: [] }],
        [{ text: "", scopes: [] }],
        [{ text: "`", scopes: ["lorem"] }],
      ]);
    });

    it("handles edits after tokens that end between CR and LF characters (regression)", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (comment) @comment
        (string) @string
        (property_identifier) @property
      `,
      );

      buffer.setText(["// abc", "", 'a("b").c'].join("\r\n"));

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      expectTokensToEqual(editor, [
        [{ text: "// abc", scopes: ["comment"] }],
        [{ text: "", scopes: [] }],
        [
          { text: "a(", scopes: [] },
          { text: '"b"', scopes: ["string"] },
          { text: ").", scopes: [] },
          { text: "c", scopes: ["property"] },
        ],
      ]);

      buffer.insert([2, 0], "  ");

      await languageMode.nextTransaction;

      expectTokensToEqual(editor, [
        [{ text: "// abc", scopes: ["comment"] }],
        [{ text: "", scopes: [] }],
        [
          { text: "  ", scopes: ["leading-whitespace"] },
          { text: "a(", scopes: [] },
          { text: '"b"', scopes: ["string"] },
          { text: ").", scopes: [] },
          { text: "c", scopes: ["property"] },
        ],
      ]);
    });

    it("handles multi-line nodes with children on different lines (regression)", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (template_string) @string
        ["\${" "}"] @interpolation
      `,
      );

      buffer.setText("`\na${1}\nb${2}\n`;");

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      expectTokensToEqual(editor, [
        [{ text: "`", scopes: ["string"] }],
        [
          { text: "a", scopes: ["string"] },
          { text: "${", scopes: ["string", "interpolation"] },
          { text: "1", scopes: ["string"] },
          { text: "}", scopes: ["string", "interpolation"] },
        ],
        [
          { text: "b", scopes: ["string"] },
          { text: "${", scopes: ["string", "interpolation"] },
          { text: "2", scopes: ["string"] },
          { text: "}", scopes: ["string", "interpolation"] },
        ],
        [
          { text: "`", scopes: ["string"] },
          { text: ";", scopes: [] },
        ],
      ]);
    });

    it("handles folds inside of highlighted tokens", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (comment) @comment
        (call_expression (identifier) @function)
      `,
      );

      buffer.setText(dedent`
        /*
         * Hello
         */

        hello();
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.foldBufferRange([
        [0, 2],
        [2, 0],
      ]);

      expectTokensToEqual(editor, [
        [
          { text: "/*", scopes: ["comment"] },
          { text: "…", scopes: ["fold-marker"] },
          { text: " */", scopes: ["comment"] },
        ],
        [{ text: "", scopes: [] }],
        [
          { text: "hello", scopes: ["function"] },
          { text: "();", scopes: [] },
        ],
      ]);
    });

    it("applies regex match rules when specified", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        ((identifier) @global
          (#match? @global "^(exports|document|window|global)$"))

        ((identifier) @constant
          (#match? @constant "^[A-Z_]+$")
          (#set! capture.final true))

        ((identifier) @constructor
          (#match? @constructor "^[A-Z]"))

        ((identifier) @variable
          (#set! capture.shy true))
      `,
      );
      buffer.setText(`exports.object = Class(SOME_CONSTANT, x)`);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      expectTokensToEqual(editor, [
        [
          { text: "exports", scopes: ["global"] },
          { text: ".object = ", scopes: [] },
          { text: "Class", scopes: ["constructor"] },
          { text: "(", scopes: [] },
          { text: "SOME_CONSTANT", scopes: ["constant"] },
          { text: ", ", scopes: [] },
          { text: "x", scopes: ["variable"] },
          { text: ")", scopes: [] },
        ],
      ]);
    });

    it("handles nodes that start before their first child and end after their last child", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, pythonGrammarPath, pythonConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (string) @string
        (interpolation) @embedded
        ["{" "}"] @punctuation
      `,
      );

      // The interpolation node `{d}` has one named child, the identifier `d`,
      // and that child starts later and ends earlier than the interpolation.
      buffer.setText('a = f"bc{d}ef"');

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      expectTokensToEqual(editor, [
        [
          { text: "a = ", scopes: [] },
          { text: 'f"bc', scopes: ["string"] },
          { text: "{", scopes: ["string", "embedded", "punctuation"] },
          { text: "d", scopes: ["string", "embedded"] },
          { text: "}", scopes: ["string", "embedded", "punctuation"] },
          { text: 'ef"', scopes: ["string"] },
        ],
      ]);
    });

    describe("when a highlighting query changes after load", () => {
      it("updates the highlighting to reflect the new content", async () => {
        jasmine.useRealClock();
        const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        await grammar.setQueryForTest(
          "highlightsQuery",
          scm`
          (identifier) @variable
        `,
        );

        buffer.setText("abc;");

        const languageMode = new TreeSitterLanguageMode({
          buffer,
          grammar,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;
        await wait(0);

        expectTokensToEqual(editor, [
          [
            { text: "abc", scopes: ["variable"] },
            { text: ";", scopes: [] },
          ],
        ]);

        // Set up a promise that resolves when highlighting updates after a
        // query change.
        let highlightingDidUpdate = new Promise((resolve) => {
          let disposable = languageMode.onDidChangeHighlighting(() => {
            disposable.dispose();
            resolve();
          });
        });

        // Change the highlighting query.
        await grammar.setQueryForTest(
          "highlightsQuery",
          scm`
          (identifier) @constant
        `,
        );
        await highlightingDidUpdate;

        // The language mode should automatically reload the query.
        expectTokensToEqual(editor, [
          [
            { text: "abc", scopes: ["constant"] },
            { text: ";", scopes: [] },
          ],
        ]);
      });
    });

    describe("asynchronous parsing (progress-callback time slicing)", () => {
      it("feeds parsers bounded chunks while preserving text for large nodes", async () => {
        jasmine.useRealClock();
        grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
        const contents = "x".repeat(20000);
        buffer.setText(`const value = \`${contents}\`;`);
        const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        const parser = languageMode.getRootParser();
        const parse = parser.parse.bind(parser);
        let largestChunk = 0;
        let parsing = false;
        spyOn(parser, "parse").and.callFake((callback, ...args) => {
          parsing = true;
          try {
            return parse(
              (...callbackArgs) => {
                const chunk = callback(...callbackArgs);
                if (parsing) largestChunk = Math.max(largestChunk, chunk.length);
                return chunk;
              },
              ...args,
            );
          } finally {
            parsing = false;
          }
        });

        const tree = languageMode.parse(languageMode.rootLanguage, null, null);
        const template = tree.rootNode.descendantsOfType("template_string")[0];

        expect(largestChunk).toBeLessThanOrEqual(4096);
        expect(template.text).toBe(`\`${contents}\``);
        tree.delete();
      });

      it("deletes the previous canonical tree only once after an incremental parse", async () => {
        jasmine.useRealClock();
        grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
        buffer.setText("const value = 1;");
        const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        const previousTree = languageMode.tree;
        spyOn(previousTree, "delete").and.callThrough();

        buffer.append("\nvalue++;");
        await languageMode.atTransactionEnd();

        expect(previousTree.delete).toHaveBeenCalledTimes(1);
      });

      it("yields to the event loop when the sync budget is exhausted, then resolves to a complete tree", async () => {
        jasmine.useRealClock();
        grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
        await grammar.setQueryForTest(
          "highlightsQuery",
          scm`
          (identifier) @variable
        `,
        );

        // A modest buffer is enough: with a zero-length sync budget, the very
        // first progress-callback tick cancels each synchronous burst, so any
        // non-trivial incremental reparse is forced onto the async path,
        // regardless of how fast the machine is.
        buffer.setText("function f(a, b) { return a + b; }\n".repeat(100));

        const languageMode = new TreeSitterLanguageMode({
          grammar,
          buffer,
          syncTimeoutMicros: 0,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;
        await languageMode.atTransactionEnd();

        // Capture what each incremental reparse returns so we can prove it went
        // async (a thenable) instead of blocking to completion synchronously.
        const returnValues = [];
        const parseAsync = languageMode.parseAsync.bind(languageMode);
        spyOn(languageMode, "parseAsync").and.callFake((...args) => {
          const result = parseAsync(...args);
          returnValues.push(result);
          return result;
        });

        // A single keystroke-sized edit (a leading empty statement keeps the
        // program valid). Under the zero budget this cannot be re-parsed within
        // the synchronous attempt.
        buffer.setTextInRange(
          [
            [0, 0],
            [0, 0],
          ],
          ";",
        );
        await languageMode.atTransactionEnd();

        expect(returnValues.length).toBeGreaterThan(0);
        expect(returnValues.some((r) => r && typeof r.then === "function")).toBe(true);

        // The deferred parse still produced a complete, error-free tree that is
        // structurally identical to an unbudgeted synchronous parse of the same
        // buffer.
        const tree = languageMode.tree;
        expect(tree).not.toBe(null);
        expect(tree.rootNode.hasError).toBe(false);

        const fullTree = languageMode.parse(languageMode.rootLanguage, null, null);
        expect(tree.rootNode.childCount).toBe(fullTree.rootNode.childCount);
      });
    });

    describe("predicate robustness", () => {
      let languageMode;

      beforeEach(() => {
        jasmine.useRealClock();
        ScopeResolver._clearPredicateWarnings();
        spyOn(lumine.window, "isDevMode").and.returnValue(true);
        spyOn(console, "warn");
        grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
      });

      async function useHighlightsQuery(query) {
        await grammar.setQueryForTest("highlightsQuery", query);
        languageMode = new TreeSitterLanguageMode({ grammar, buffer });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;
      }

      function resolverWarnings() {
        return console.warn.calls
          .allArgs()
          .filter((args) => String(args[0]).includes("ScopeResolver"));
      }

      it("warns once about unknown test/capture/adjustment keys without affecting rendering", async () => {
        buffer.setText("abc;");
        await useHighlightsQuery(scm`
          ((identifier) @variable
            (#set! test.bogusThing true))
        `);

        expectTokensToEqual(editor, [
          [
            { text: "abc", scopes: ["variable"] },
            { text: ";", scopes: [] },
          ],
        ]);
        expect(resolverWarnings().length).toBe(1);
        expect(resolverWarnings()[0][0]).toContain('unknown scope test "test.bogusThing"');

        // A re-highlight does not warn again.
        buffer.append(" def;");
        await languageMode.atTransactionEnd();
        expect(resolverWarnings().length).toBe(1);
      });

      it("warns about unknown un-namespaced #is? tests and keeps the capture", async () => {
        buffer.setText("abc;");
        await useHighlightsQuery(scm`
          ((identifier) @variable
            (#is? test.bogusThing))
        `);

        expectTokensToEqual(editor, [
          [
            { text: "abc", scopes: ["variable"] },
            { text: ";", scopes: [] },
          ],
        ]);
        expect(resolverWarnings().length).toBe(1);
        expect(resolverWarnings()[0][0]).toContain("#is? predicate");
      });

      it("drops only the captures of an invalid adjustment regex", async () => {
        buffer.setText("abc; 123;");
        await useHighlightsQuery(scm`
          ((identifier) @variable
            (#set! adjust.startAndEndAroundFirstMatchOf "(?"))
          ((number) @constant)
        `);

        expectTokensToEqual(editor, [
          [
            { text: "abc; ", scopes: [] },
            { text: "123", scopes: ["constant"] },
            { text: ";", scopes: [] },
          ],
        ]);
        expect(resolverWarnings().length).toBe(1);
        expect(resolverWarnings()[0][0]).toContain("invalid regular expression");
      });

      it("treats a valueless test predicate as a failed test instead of crashing", async () => {
        buffer.setText("abc;");
        await useHighlightsQuery(scm`
          ((identifier) @variable
            (#is? test.type))
        `);

        expectTokensToEqual(editor, [[{ text: "abc;", scopes: [] }]]);
        expect(resolverWarnings().length).toBe(1);
        expect(resolverWarnings()[0][0]).toContain('scope test "test.type" threw');
      });

      it("drops the capture of a valueless adjustment instead of crashing", async () => {
        buffer.setText("abc;");
        await useHighlightsQuery(scm`
          ((identifier) @variable
            (#set! adjust.startAt))
        `);

        expectTokensToEqual(editor, [[{ text: "abc;", scopes: [] }]]);
        expect(resolverWarnings().length).toBe(1);
        expect(resolverWarnings()[0][0]).toContain('adjustment "adjust.startAt" threw');
      });

      it("warns about (and honors) a range that exceeds its capture, even in dev mode", async () => {
        buffer.setText("abc;");
        await useHighlightsQuery(scm`
          ((identifier) @variable
            (#set! adjust.offsetEnd 1))
        `);

        // Dev mode used to throw from inside the highlight pass here; now it
        // warns and proceeds exactly like production.
        expectTokensToEqual(editor, [[{ text: "abc;", scopes: ["variable"] }]]);
        let exceededWarnings = console.warn.calls
          .allArgs()
          .filter((args) => String(args[0]).includes("Cannot extend past original range"));
        expect(exceededWarnings.length).toBeGreaterThan(0);
      });

      it("drops captures whose adjusted range degenerates to invalid", async () => {
        buffer.setText("abc;");
        await useHighlightsQuery(scm`
          ((identifier) @variable
            (#set! adjust.offsetEnd -9999))
        `);

        expectTokensToEqual(editor, [[{ text: "abc;", scopes: [] }]]);
      });
    });

    describe("when the buffer changes during a parse", () => {
      // `syncTimeoutMicros: 10` forces every parse past the synchronous budget,
      // so the second edit below lands while the parse the first started is
      // still in flight. What has to hold is that the layer re-parses once that
      // parse completes rather than settling on the text it was parsing.
      it("re-parses against the final text when an edit lands mid-parse", async () => {
        jasmine.useRealClock();
        const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        await grammar.setQueryForTest(
          "highlightsQuery",
          `
          (identifier) @variable
        `,
        );

        buffer.setText("abc;");

        const languageMode = new TreeSitterLanguageMode({
          buffer,
          grammar,
          syncTimeoutMicros: 10,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.atTransactionEnd();

        expectTokensToEqual(editor, [
          [
            { text: "abc", scopes: ["variable"] },
            { text: ";", scopes: [] },
          ],
        ]);

        // No await between the two edits: the second is the one that has to
        // survive the in-flight parse.
        buffer.setTextInRange(
          [
            [0, 3],
            [0, 3],
          ],
          "()",
        );
        buffer.setTextInRange(
          [
            [0, 0],
            [0, 0],
          ],
          "new ",
        );

        await languageMode.atTransactionEnd();

        expect(buffer.getText()).toBe("new abc();");
        expectTokensToEqual(editor, [
          [
            { text: "new ", scopes: [] },
            { text: "abc", scopes: ["variable"] },
            { text: "();", scopes: [] },
          ],
        ]);
      });
    });

    describe("when changes are small enough to be re-parsed synchronously", () => {
      it("can incorporate multiple consecutive synchronous updates", async () => {
        jasmine.useRealClock();
        const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        await grammar.setQueryForTest(
          "highlightsQuery",
          `
          (call_expression
            (member_expression
              (property_identifier) @method)
              (#set! capture.final true))

          ((property_identifier) @property
            (#set! capture.final true))

          (call_expression (identifier) @function)
        `,
        );

        const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;
        await wait(0);

        buffer.setText("a");
        expectTokensToEqual(editor, [[{ text: "a", scopes: [] }]]);

        buffer.append(".");
        expectTokensToEqual(editor, [[{ text: "a.", scopes: [] }]]);

        buffer.append("b");

        // TODO: The need to defer injection layer highlighting while we load
        // those layers' language modules means that we can't actually do
        // synchronous highlighting in 100% of cases and sometimes have to
        // settle for incredibly-fast-but-technically-async highlighting.
        await languageMode.atTransactionEnd();
        expectTokensToEqual(editor, [
          [
            { text: "a.", scopes: [] },
            { text: "b", scopes: ["property"] },
          ],
        ]);

        buffer.append("()");
        await languageMode.atTransactionEnd();

        expectTokensToEqual(editor, [
          [
            { text: "a.", scopes: [] },
            { text: "b", scopes: ["method"] },
            { text: "()", scopes: [] },
          ],
        ]);

        buffer.delete([
          [0, 1],
          [0, 2],
        ]);
        await languageMode.atTransactionEnd();
        expectTokensToEqual(editor, [
          [
            { text: "ab", scopes: ["function"] },
            { text: "()", scopes: [] },
          ],
        ]);
      });
    });

    describe("injectionPoints and injectionPatterns", () => {
      let jsGrammar, htmlGrammar;

      beforeEach(async () => {
        let tempJsConfig = { ...jsConfig, injectionNames: ["js", "javascript"] };
        jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, tempJsConfig);

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (comment) @comment
          (property_identifier) @property
          (call_expression (identifier) @function)
          (template_string) @string
          (template_substitution
            ["\${" "}"] @interpolation)
        `,
        );

        jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);
        jsGrammar.addInjectionPoint(HTML_INNERHTML_ASSIGNMENT_INJECTION_POINT);
        jsGrammar.addInjectionPoint(JSDOC_INJECTION_POINT);

        let tempHtmlConfig = { ...htmlConfig, injectionNames: ["html"] };
        htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, tempHtmlConfig);

        await htmlGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (document) @html
          (tag_name) @tag
          (attribute_name) @attr
        `,
        );

        htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);
      });

      it("orders coterminous injection layers from deepest to shallowest", async () => {
        buffer.setText("abc");
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        const shallowLayer = { depth: 1, destroy() {} };
        const deepLayer = { depth: 2, destroy() {} };
        const shallowMarker = languageMode.injectionsMarkerLayer.markRange([
          [0, 0],
          [0, 3],
        ]);
        const deepMarker = languageMode.injectionsMarkerLayer.markRange([
          [0, 0],
          [0, 3],
        ]);
        shallowMarker.languageLayer = shallowLayer;
        deepMarker.languageLayer = deepLayer;

        expect(languageMode.injectionLayersAtPoint([0, 1])).toEqual([deepLayer, shallowLayer]);
      });

      it("yields while collecting injection candidates without losing or duplicating nodes", async () => {
        jasmine.useRealClock();
        const seen = [];
        for (const type of ["identifier", "template_string"]) {
          jsGrammar.addInjectionPoint({
            type,
            language(node) {
              seen.push(`${node.type}:${node.startPosition.row}`);
            },
            content(node) {
              return node;
            },
          });
        }

        buffer.setText("a;\nconst value = `\nb\nc\n`;\nd;");
        spyOn(
          TreeSitterLanguageMode.prototype,
          "_yieldForInjectionCandidateScan",
        ).and.callThrough();
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
          injectionCandidateChunkRows: 1,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expect(languageMode._yieldForInjectionCandidateScan).toHaveBeenCalled();
        expect(seen).toEqual(["identifier:0", "identifier:1", "template_string:1", "identifier:5"]);
      });

      it("compiles a large-file injection candidate query only once per grammar", async () => {
        jasmine.useRealClock();
        jsGrammar.addInjectionPoint({
          type: "identifier",
          language() {},
          content(node) {
            return node;
          },
        });
        spyOn(jsGrammar, "createQuerySync").and.callThrough();

        buffer.setText("a;\nb;\nc;");
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
          injectionCandidateChunkRows: 1,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        await languageMode.rootLanguageLayer._populateInjections(buffer.getRange(), null);

        expect(jsGrammar.createQuerySync).toHaveBeenCalledTimes(1);
      });

      it("abandons a stale candidate scan and retries against the final tree", async () => {
        jasmine.useRealClock();
        const seen = [];
        jsGrammar.addInjectionPoint({
          type: "identifier",
          language(node) {
            seen.push(node.text);
          },
          content(node) {
            return node;
          },
        });

        let resumeFirstScan;
        const realYield = TreeSitterLanguageMode.prototype._yieldForInjectionCandidateScan;
        spyOn(TreeSitterLanguageMode.prototype, "_yieldForInjectionCandidateScan").and.callFake(
          function () {
            if (!resumeFirstScan) {
              return new Promise((resolve) => {
                resumeFirstScan = resolve;
              });
            }
            return realYield.call(this);
          },
        );

        buffer.setText("a;\nb;\nc;");
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
          injectionCandidateChunkRows: 1,
        });
        buffer.setLanguageMode(languageMode);
        while (!resumeFirstScan) await Promise.resolve();

        buffer.setText("w;\nx;\ny;\nz;");
        resumeFirstScan();
        await languageMode.ready;

        expect(seen).toEqual(["w", "x", "y", "z"]);
      });

      it("stops a yielded candidate scan safely when destroyed", async () => {
        jasmine.useRealClock();
        const language = jasmine.createSpy("injection language");
        jsGrammar.addInjectionPoint({
          type: "identifier",
          language,
          content(node) {
            return node;
          },
        });

        let resumeScan;
        spyOn(TreeSitterLanguageMode.prototype, "_yieldForInjectionCandidateScan").and.callFake(
          () =>
            new Promise((resolve) => {
              resumeScan = resolve;
            }),
        );

        buffer.setText("a;\nb;\nc;");
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
          injectionCandidateChunkRows: 1,
        });
        buffer.setLanguageMode(languageMode);
        while (!resumeScan) await Promise.resolve();

        const rootLanguageLayer = languageMode.rootLanguageLayer;
        languageMode.destroy();
        resumeScan();
        await languageMode.ready;

        expect(language).not.toHaveBeenCalled();
        expect(rootLanguageLayer.destroyed).toBe(true);
        expect(rootLanguageLayer.childLayerMarkers.size).toBe(0);
      });

      it("keeps coterminous injection points distinct while reusing their layers", async () => {
        jasmine.useRealClock();
        const firstInjectionPoint = {
          type: "template_string",
          language: () => "html",
          content: (node) => node,
          includeChildren: true,
          languageScope: null,
        };
        const secondInjectionPoint = {
          type: "template_string",
          language: () => "html",
          content: (node) => node,
          includeChildren: true,
          languageScope: "source.html.secondary",
          coverShallowerScopes: true,
        };
        jsGrammar.addInjectionPoint(firstInjectionPoint);
        jsGrammar.addInjectionPoint(secondInjectionPoint);

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);
        buffer.setText("const value = `<b>x</b>`;");

        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        const layersForInjectionPoints = () =>
          languageMode
            .getAllInjectionLayers()
            .filter((layer) =>
              [firstInjectionPoint, secondInjectionPoint].includes(layer.injectionPoint),
            );
        const originalLayers = layersForInjectionPoints();
        expect(originalLayers.length).toBe(2);
        const firstLayer = originalLayers.find(
          (layer) => layer.injectionPoint === firstInjectionPoint,
        );
        const secondLayer = originalLayers.find(
          (layer) => layer.injectionPoint === secondInjectionPoint,
        );
        expect(firstLayer.grammar).toBe(htmlGrammar);
        expect(secondLayer.grammar).toBe(htmlGrammar);
        expect(firstLayer.getExtent()).toEqual(secondLayer.getExtent());
        expect(firstLayer.languageScope).toBeNull();
        expect(secondLayer.languageScope).toBe("source.html.secondary");

        buffer.setTextInRange(buffer.findSync("x"), "xy");
        await languageMode.atTransactionEnd();

        const updatedLayers = layersForInjectionPoints();
        expect(updatedLayers.length).toBe(2);
        expect(updatedLayers).toContain(firstLayer);
        expect(updatedLayers).toContain(secondLayer);
      });

      it("highlights code inside of injection points", async () => {
        jasmine.useRealClock();
        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);
        buffer.setText('node.x = html `\na ${b}<img src="d">\n`;');

        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });

        buffer.setLanguageMode(languageMode);
        await languageMode.ready;
        await new Promise(process.nextTick);

        expectTokensToEqual(editor, [
          [
            { text: "node.", scopes: [] },
            { text: "x", scopes: ["property"] },
            { text: " = ", scopes: [] },
            { text: "html", scopes: ["function"] },
            { text: " ", scopes: [] },
            { text: "`", scopes: ["string"] },
            { text: "", scopes: ["string", "html"] },
          ],
          [
            { text: "a ", scopes: ["string", "html"] },
            { text: "${", scopes: ["string", "html", "interpolation"] },
            { text: "b", scopes: ["string", "html"] },
            { text: "}", scopes: ["string", "html", "interpolation"] },
            { text: "<", scopes: ["string", "html"] },
            { text: "img", scopes: ["string", "html", "tag"] },
            { text: " ", scopes: ["string", "html"] },
            { text: "src", scopes: ["string", "html", "attr"] },
            { text: '="d">', scopes: ["string", "html"] },
          ],
          [
            { text: "`", scopes: ["string"] },
            { text: ";", scopes: [] },
          ],
        ]);

        const range = buffer.findSync("html");
        buffer.setTextInRange(range, "xml");
        // await nextHighlightingUpdate(languageMode);
        await new Promise(process.nextTick);

        expectTokensToEqual(editor, [
          [
            { text: "node.", scopes: [] },
            { text: "x", scopes: ["property"] },
            { text: " = ", scopes: [] },
            { text: "xml", scopes: ["function"] },
            { text: " ", scopes: [] },
            { text: "`", scopes: ["string"] },
          ],
          [
            { text: "a ", scopes: ["string"] },
            { text: "${", scopes: ["string", "interpolation"] },
            { text: "b", scopes: ["string"] },
            { text: "}", scopes: ["string", "interpolation"] },
            { text: '<img src="d">', scopes: ["string"] },
          ],
          [
            { text: "`", scopes: ["string"] },
            { text: ";", scopes: [] },
          ],
        ]);
      });

      it("highlights the content after injections", async () => {
        jasmine.useRealClock();
        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);
        buffer.setText("<script>\nhello();\n</script>\n<div>\n</div>");

        const languageMode = new TreeSitterLanguageMode({
          grammar: htmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expectTokensToEqual(editor, [
          [
            { text: "<", scopes: ["html"] },
            { text: "script", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
          [
            { text: "hello", scopes: ["html", "function"] },
            { text: "();", scopes: ["html"] },
          ],
          [
            { text: "</", scopes: ["html"] },
            { text: "script", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
          [
            { text: "<", scopes: ["html"] },
            { text: "div", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
          [
            { text: "</", scopes: ["html"] },
            { text: "div", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
        ]);
      });

      it("updates a buffer's highlighting when a grammar with an injection alias is added", async () => {
        jasmine.useRealClock();
        lumine.grammars.addGrammar(jsGrammar);

        buffer.setText('node.innerHTML = `\na ${b}<img src="d">\n`;');
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expectTokensToEqual(editor, [
          [
            { text: "node.", scopes: [] },
            { text: "innerHTML", scopes: ["property"] },
            { text: " = ", scopes: [] },
            { text: "`", scopes: ["string"] },
          ],
          [
            { text: "a ", scopes: ["string"] },
            { text: "${", scopes: ["string", "interpolation"] },
            { text: "b", scopes: ["string"] },
            { text: "}", scopes: ["string", "interpolation"] },
            { text: '<img src="d">', scopes: ["string"] },
          ],
          [
            { text: "`", scopes: ["string"] },
            { text: ";", scopes: [] },
          ],
        ]);

        lumine.grammars.addGrammar(htmlGrammar);
        await languageMode.nextTransaction;
        // TODO: Still need a `wait(0)` here and I'm not sure why.
        await wait(0);
        expectTokensToEqual(editor, [
          [
            { text: "node.", scopes: [] },
            { text: "innerHTML", scopes: ["property"] },
            { text: " = ", scopes: [] },
            { text: "`", scopes: ["string"] },
            { text: "", scopes: ["string", "html"] },
          ],
          [
            { text: "a ", scopes: ["string", "html"] },
            { text: "${", scopes: ["string", "html", "interpolation"] },
            { text: "b", scopes: ["string", "html"] },
            { text: "}", scopes: ["string", "html", "interpolation"] },
            { text: "<", scopes: ["string", "html"] },
            { text: "img", scopes: ["string", "html", "tag"] },
            { text: " ", scopes: ["string", "html"] },
            { text: "src", scopes: ["string", "html", "attr"] },
            { text: '="d">', scopes: ["string", "html"] },
          ],
          [
            { text: "`", scopes: ["string"] },
            { text: ";", scopes: [] },
          ],
        ]);
      });

      it("removes active injection layers when their target grammar is removed", async () => {
        jasmine.useRealClock();
        lumine.grammars.addGrammar(jsGrammar);
        const htmlRegistration = lumine.grammars.addGrammar(htmlGrammar);
        buffer.setText('node.innerHTML = `<img src="d">`;');
        expect(lumine.grammars.assignLanguageMode(buffer, "source.js")).toBe(true);

        const languageMode = buffer.getLanguageMode();
        await languageMode.ready;
        await wait(0);
        expect(languageMode.getAllInjectionLayers().map((layer) => layer.grammar)).toContain(
          htmlGrammar,
        );

        htmlRegistration.dispose();
        await languageMode.nextTransaction;
        await wait(0);
        expect(languageMode.getAllInjectionLayers().map((layer) => layer.grammar)).not.toContain(
          htmlGrammar,
        );
      });

      it("updates a buffer’s highlighting when a new injection point is added to its grammar", async () => {
        const ejsGrammar = new TreeSitterGrammar(
          lumine.grammars,
          ejsGrammarPath,
          CSON.readFileSync(ejsGrammarPath),
        );

        await ejsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ["<%=" "%>"] @directive
        `,
        );

        ejsGrammar.addInjectionPoint({
          type: "template",
          language: () => "html",
          content: (node) => node.descendantsOfType("content"),
        });

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);

        buffer.setText("<body>\n<script>\nb(<%= c.d %>)\n</script>\n</body>");
        const languageMode = new TreeSitterLanguageMode({
          grammar: ejsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        spyOn(languageMode.rootLanguageLayer, "_populateInjections").and.callThrough();

        ejsGrammar.addInjectionPoint({
          type: "template",
          language: () => "javascript",
          content: (node) => node.descendantsOfType("code"),
        });

        expect(languageMode.rootLanguageLayer._populateInjections).toHaveBeenCalled();
      });

      it("does not update a specific layer’s injections if a newly added grammar is irrelevant to them", async () => {
        jasmine.useRealClock();
        lumine.grammars.addGrammar(jsGrammar);

        buffer.setText('node.innerHTML = `\na ${b}<img src="d">\n`;');
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        spyOn(languageMode.rootLanguageLayer, "_populateInjections").and.callThrough();

        const ejsGrammar = new TreeSitterGrammar(
          lumine.grammars,
          ejsGrammarPath,
          CSON.readFileSync(ejsGrammarPath),
        );

        await ejsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ["<%=" "%>"] @directive
        `,
        );

        lumine.grammars.addGrammar(ejsGrammar);
        await languageMode.nextTransaction;
        // TODO: Still need a `wait(0)` here and I'm not sure why.
        await wait(0);

        expect(languageMode.rootLanguageLayer._populateInjections).not.toHaveBeenCalled();
      });

      it("handles injections that intersect", async () => {
        const ejsGrammar = new TreeSitterGrammar(
          lumine.grammars,
          ejsGrammarPath,
          CSON.readFileSync(ejsGrammarPath),
        );

        await ejsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ["<%=" "%>"] @directive
        `,
        );

        ejsGrammar.addInjectionPoint({
          type: "template",
          language: () => "javascript",
          content: (node) => node.descendantsOfType("code"),
        });

        ejsGrammar.addInjectionPoint({
          type: "template",
          language: () => "html",
          content: (node) => node.descendantsOfType("content"),
        });

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);

        buffer.setText("<body>\n<script>\nb(<%= c.d %>)\n</script>\n</body>");
        const languageMode = new TreeSitterLanguageMode({
          grammar: ejsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expectTokensToEqual(editor, [
          [
            { text: "<", scopes: ["html"] },
            { text: "body", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
          [
            { text: "<", scopes: ["html"] },
            { text: "script", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
          [
            { text: "b", scopes: ["html", "function"] },
            { text: "(", scopes: ["html"] },
            { text: "<%=", scopes: ["html", "directive"] },
            { text: " c.", scopes: ["html"] },
            { text: "d", scopes: ["html", "property"] },
            { text: " ", scopes: ["html"] },
            { text: "%>", scopes: ["html", "directive"] },
            { text: ")", scopes: ["html"] },
          ],
          [
            { text: "</", scopes: ["html"] },
            { text: "script", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
          [
            { text: "</", scopes: ["html"] },
            { text: "body", scopes: ["html", "tag"] },
            { text: ">", scopes: ["html"] },
          ],
        ]);
      });

      it("handles injections that are empty", async () => {
        jasmine.useRealClock();
        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);
        buffer.setText("text = html");

        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expectTokensToEqual(editor, [[{ text: "text = html", scopes: [] }]]);

        buffer.append(" ``;");
        // await nextHighlightingUpdate(languageMode);
        await languageMode.nextTransaction;
        expectTokensToEqual(editor, [
          [
            { text: "text = ", scopes: [] },
            { text: "html", scopes: ["function"] },
            { text: " ", scopes: [] },
            { text: "``", scopes: ["string"] },
            { text: ";", scopes: [] },
          ],
        ]);

        buffer.insert({ row: 0, column: buffer.getText().lastIndexOf("`") }, "<div>");
        await languageMode.nextTransaction;
        expect(buffer.getText()).toEqual(`text = html \`<div>\`;`);
        await wait(100);
        expectTokensToEqual(editor, [
          [
            { text: "text = ", scopes: [] },
            { text: "html", scopes: ["function"] },
            { text: " ", scopes: [] },
            { text: "`", scopes: ["string"] },
            { text: "<", scopes: ["string", "html"] },
            { text: "div", scopes: ["string", "html", "tag"] },
            { text: ">", scopes: ["string", "html"] },
            { text: "`", scopes: ["string"] },
            { text: ";", scopes: [] },
          ],
        ]);

        buffer.undo();
        await languageMode.nextTransaction;
        expectTokensToEqual(editor, [
          [
            { text: "text = ", scopes: [] },
            { text: "html", scopes: ["function"] },
            { text: " ", scopes: [] },
            { text: "``", scopes: ["string"] },
            { text: ";", scopes: [] },
          ],
        ]);
      });

      it("handles injections with no highlights query", async () => {
        jasmine.useRealClock();
        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);
        htmlGrammar.highlightsQuery = false;
        // Pretend this grammar doesn't have a highlights query.
        spyOn(htmlGrammar, "getQuery").and.returnValue(Promise.resolve(null));
        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        buffer.setText("text = html`<p></p>`");
        await languageMode.atTransactionEnd();

        // An injection should still be able to add its root scope even when
        // its grammar has no `highlightsQuery`.
        let descriptor = editor.scopeDescriptorForBufferPosition([0, 15]);

        expect(descriptor.getScopesArray()).toContain("text.html.basic");
      });

      it("terminates comment token at the end of an injection, so that the next injection is NOT a continuation of the comment", async () => {
        jasmine.useRealClock();
        const ejsGrammar = new TreeSitterGrammar(
          lumine.grammars,
          ejsGrammarPath,
          CSON.readFileSync(ejsGrammarPath),
        );

        await ejsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ["<%" "%>"] @directive
        `,
        );

        ejsGrammar.addInjectionPoint({
          type: "template",
          language: () => "javascript",
          content: (node) => node.descendantsOfType("code"),
          newlinesBetween: true,
        });

        ejsGrammar.addInjectionPoint({
          type: "template",
          language: () => "html",
          content: (node) => node.descendantsOfType("content"),
        });

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);

        buffer.setText("<% // js comment %> b\n<% b() %>");
        const languageMode = new TreeSitterLanguageMode({
          grammar: ejsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expectTokensToEqual(editor, [
          [
            { text: "<%", scopes: ["directive"] },
            { text: " ", scopes: [] },
            { text: "// js comment ", scopes: ["comment"] },
            { text: "%>", scopes: ["directive"] },
            { text: " ", scopes: [] },
            { text: "b", scopes: ["html"] },
          ],
          [
            { text: "<%", scopes: ["directive"] },
            { text: " ", scopes: [] },
            { text: "b", scopes: ["function"] },
            { text: "() ", scopes: [] },
            { text: "%>", scopes: ["directive"] },
          ],
        ]);
      });

      it("only covers scope boundaries in parent layers if a nested layer has a boundary at the same position", async () => {
        const jsdocGrammar = new TreeSitterGrammar(lumine.grammars, jsdocGrammarPath, {
          ...CSON.readFileSync(jsdocGrammarPath),
          injectionNames: ["jsdoc"],
        });

        jsdocGrammar.setQueryForTest("highlightsQuery", "");

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(jsdocGrammar);

        editor.setGrammar(jsGrammar);
        editor.setText("/**\n*/\n{\n}");

        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expectTokensToEqual(editor, [
          [{ text: "/**", scopes: ["comment"] }],
          [{ text: "*/", scopes: ["comment"] }],
          [{ text: "{", scopes: [] }],
          [{ text: "}", scopes: [] }],
        ]);
      });

      it("reports scopes from shallower layers when they are at the start or end of an injection", async () => {
        jasmine.useRealClock();
        const jsdocGrammar = new TreeSitterGrammar(lumine.grammars, jsdocGrammarPath, {
          ...CSON.readFileSync(jsdocGrammarPath),
          injectionNames: ["jsdoc"],
        });
        await jsdocGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ((ERROR) @comment.block.js
            (#is? test.root true))
          (document) @comment.block.js

          (tag_name) @storage.type.class.jsdoc
        `,
        );

        const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
        jsGrammar.addInjectionPoint(JSDOC_INJECTION_POINT);
        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ["{" "}"] @punctuation.brace
        `,
        );

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(jsdocGrammar);

        editor.setGrammar(jsGrammar);
        editor.setText("/** @babel */\n{\n}");
        let languageMode = buffer.getLanguageMode();
        if (languageMode.ready) {
          await languageMode.ready;
          await languageMode.nextTransaction;
        }
        expectTokensToEqual(editor, [
          [
            { text: "/** ", scopes: ["comment block js"] },
            {
              text: "@babel",
              scopes: ["comment block js", "storage type class jsdoc"],
            },
            {
              text: " */",
              scopes: ["comment block js"],
            },
          ],
          [
            {
              text: "{",
              scopes: ["punctuation brace"],
            },
          ],
          [
            {
              text: "}",
              scopes: ["punctuation brace"],
            },
          ],
        ]);
      });

      it("respects the `includeChildren` property of injection points", async () => {
        const selfInjectingJsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, {
          ...jsConfig,
        });

        lumine.grammars.addInjectionPoint("source.js", {
          type: "call_expression",
          language() {
            return "javascript";
          },
          content(node) {
            return node.lastChild;
          },
          includeChildren: true,
          languageScope: null,
          coverShallowerScopes: true,
        });

        await selfInjectingJsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (call_expression
            function: (identifier) @macro
            (#set! capture.final true))

          (call_expression
            function: (member_expression
              property: (property_identifier) @function)
              (#set! capture.final true))

          ((property_identifier) @property
            (#set! capture.final true))

          ((identifier) @variable
            (#set! capture.shy true))
        `,
        );

        lumine.grammars.addGrammar(selfInjectingJsGrammar);

        // Call within another call.
        buffer.setText("assertEq(a.b.c(), vec(d.e())); f.g();");

        const languageMode = new TreeSitterLanguageMode({
          grammar: selfInjectingJsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        // There should not be duplicate scopes due to the root layer
        // and for the injected javascript layer.
        expectTokensToEqual(editor, [
          [
            { text: "assertEq", scopes: ["macro"] },
            { text: "(", scopes: [] },
            { text: "a", scopes: ["variable"] },
            { text: ".", scopes: [] },
            { text: "b", scopes: ["property"] },
            { text: ".", scopes: [] },
            { text: "c", scopes: ["function"] },
            { text: "(), ", scopes: [] },
            { text: "vec", scopes: ["macro"] },
            { text: "(", scopes: [] },
            { text: "d", scopes: ["variable"] },
            { text: ".", scopes: [] },
            { text: "e", scopes: ["function"] },
            { text: "())); ", scopes: [] },
            { text: "f", scopes: ["variable"] },
            { text: ".", scopes: [] },
            { text: "g", scopes: ["function"] },
            { text: "();", scopes: [] },
          ],
        ]);
      });

      it("omits the injected grammar's base scope when `languageScope` is `null`", async () => {
        let customJsConfig = { ...jsConfig };
        let customJsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, customJsConfig);

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (comment) @comment
          (property_identifier) @property
          (call_expression (identifier) @function)
          (template_string) @string
          (template_substitution
            ["\${" "}"] @interpolation)
        `,
        );

        let customHtmlConfig = { ...htmlConfig };
        let customHtmlGrammar = new TreeSitterGrammar(
          lumine.grammars,
          htmlGrammarPath,
          customHtmlConfig,
        );

        await htmlGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (document) @html
          (tag_name) @tag
          (attribute_name) @attr
        `,
        );

        customHtmlGrammar.addInjectionPoint({
          ...SCRIPT_TAG_INJECTION_POINT,
          languageScope: null,
        });

        jasmine.useRealClock();
        lumine.grammars.addGrammar(customJsGrammar);
        lumine.grammars.addGrammar(customHtmlGrammar);
        buffer.setText("<script>\nhello();\n</script>\n<div>\n</div>");

        const languageMode = new TreeSitterLanguageMode({
          grammar: customHtmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        let descriptor = languageMode.scopeDescriptorForPosition([1, 1]);
        expect(descriptor.getScopesArray().includes("source.js")).toBe(false);
      });

      it("uses a custom base scope on the injected layer when `languageScope` is a string", async () => {
        let customJsConfig = { ...jsConfig };
        let customJsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, customJsConfig);

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (comment) @comment
          (property_identifier) @property
          (call_expression (identifier) @function)
          (template_string) @string
          (template_substitution
            ["\${" "}"] @interpolation)
        `,
        );

        let customHtmlConfig = { ...htmlConfig };
        let customHtmlGrammar = new TreeSitterGrammar(
          lumine.grammars,
          htmlGrammarPath,
          customHtmlConfig,
        );

        await htmlGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (document) @html
          (tag_name) @tag
          (attribute_name) @attr
        `,
        );

        customHtmlGrammar.addInjectionPoint({
          ...SCRIPT_TAG_INJECTION_POINT,
          languageScope: "source.js.embedded",
        });

        jasmine.useRealClock();
        lumine.grammars.addGrammar(customJsGrammar);
        lumine.grammars.addGrammar(customHtmlGrammar);
        buffer.setText("<script>\nhello();\n</script>\n<div>\n</div>");

        const languageMode = new TreeSitterLanguageMode({
          grammar: customHtmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        let descriptor = languageMode.scopeDescriptorForPosition([1, 1]);
        expect(descriptor.getScopesArray().includes("source.js")).toBe(false);
        expect(descriptor.getScopesArray().includes("source.js.embedded")).toBe(true);
      });

      it("uses a custom base scope on the injected layer when `languageScope` is a function", async () => {
        let customJsConfig = { ...jsConfig };
        let customJsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, customJsConfig);

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (comment) @comment
          (property_identifier) @property
          (call_expression (identifier) @function)
          (template_string) @string
          (template_substitution
            ["\${" "}"] @interpolation)
        `,
        );

        let customHtmlConfig = { ...htmlConfig };
        let customHtmlGrammar = new TreeSitterGrammar(
          lumine.grammars,
          htmlGrammarPath,
          customHtmlConfig,
        );

        await htmlGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (document) @html
          (tag_name) @tag
          (attribute_name) @attr
        `,
        );

        let timestamp = Date.now();

        customHtmlGrammar.addInjectionPoint({
          ...SCRIPT_TAG_INJECTION_POINT,
          languageScope: (grammar) => `${grammar.scopeName}.custom-${timestamp}`,
        });

        jasmine.useRealClock();
        lumine.grammars.addGrammar(customJsGrammar);
        lumine.grammars.addGrammar(customHtmlGrammar);
        buffer.setText("<script>\nhello();\n</script>\n<div>\n</div>");

        const languageMode = new TreeSitterLanguageMode({
          grammar: customHtmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        let descriptor = languageMode.scopeDescriptorForPosition([1, 1]);
        expect(descriptor.getScopesArray().includes("source.js")).toBe(false);
        expect(descriptor.getScopesArray().includes(`source.js.custom-${timestamp}`)).toBe(true);
      });

      it("allows multiple base scopes on the injected layer when `languageScope` is a function", async () => {
        let customJsConfig = { ...jsConfig };
        let customJsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, customJsConfig);

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (comment) @comment
          (property_identifier) @property
          (call_expression (identifier) @function)
          (template_string) @string
          (template_substitution
            ["\${" "}"] @interpolation)
        `,
        );

        let customHtmlConfig = { ...htmlConfig };
        let customHtmlGrammar = new TreeSitterGrammar(
          lumine.grammars,
          htmlGrammarPath,
          customHtmlConfig,
        );

        await htmlGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (document) @html
          (tag_name) @tag
          (attribute_name) @attr
        `,
        );

        customHtmlGrammar.addInjectionPoint({
          ...SCRIPT_TAG_INJECTION_POINT,
          languageScope: (grammar, _buffer, range) => {
            return [grammar.scopeName, `meta.line${range.start.row}`];
          },
        });

        jasmine.useRealClock();
        lumine.grammars.addGrammar(customJsGrammar);
        lumine.grammars.addGrammar(customHtmlGrammar);
        buffer.setText(
          "<script>\nhello();\n</script>\n<div>\n</div>\n<script>\ngoodbye();</script>",
        );

        const languageMode = new TreeSitterLanguageMode({
          grammar: customHtmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        let descriptor = languageMode.scopeDescriptorForPosition([1, 1]);
        expect(descriptor.getScopesArray().includes("source.js")).toBe(true);
        expect(descriptor.getScopesArray().includes(`meta.line0`)).toBe(true);
        expect(descriptor.getScopesArray().includes(`meta.line5`)).toBe(false);

        descriptor = languageMode.scopeDescriptorForPosition([6, 1]);
        expect(descriptor.getScopesArray().includes("source.js")).toBe(true);
        expect(descriptor.getScopesArray().includes(`meta.line5`)).toBe(true);
        expect(descriptor.getScopesArray().includes(`meta.line0`)).toBe(false);
      });

      it("notifies onDidTokenize listeners the first time all syntax highlighting is done", async () => {
        const promise = new Promise((resolve) => {
          editor.onDidTokenize((_event) => {
            expectTokensToEqual(editor, [
              [
                { text: "<", scopes: ["html"] },
                { text: "script", scopes: ["html", "tag"] },
                { text: ">", scopes: ["html"] },
              ],
              [
                { text: "hello", scopes: ["html", "function"] },
                { text: "();", scopes: ["html"] },
              ],
              [
                { text: "</", scopes: ["html"] },
                { text: "script", scopes: ["html", "tag"] },
                { text: ">", scopes: ["html"] },
              ],
            ]);
            resolve();
          });
        });

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);
        buffer.setText("<script>\nhello();\n</script>");

        const languageMode = new TreeSitterLanguageMode({
          grammar: htmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await promise;
      });
    });
  });

  describe("highlighting after random changes", () => {
    let originalTimeout;

    beforeEach(() => {
      originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
      jasmine.DEFAULT_TIMEOUT_INTERVAL = 60 * 1000;
    });

    afterEach(() => {
      jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
    });

    it("matches the highlighting of a freshly-opened editor", async () => {
      jasmine.useRealClock();

      const text = fs.readFileSync(path.join(__dirname, "fixtures", "sample.js"), "utf8");
      lumine.grammars.loadGrammarSync(jsGrammarPath);
      lumine.grammars.assignLanguageMode(buffer, "source.js");
      // buffer.getLanguageMode().syncTimeoutMicros = 0;

      // Seeded by the clock so each run explores different edits. Set
      // `LUMINE_SPEC_SEED` to replay the seed reported by a failure.
      const initialSeed = Number(process.env.LUMINE_SPEC_SEED) || Date.now();
      for (let i = 0, trialCount = 10; i < trialCount; i++) {
        let seed = initialSeed + i;
        const random = Random(seed);

        // Parse the initial content and render all of the screen lines.
        buffer.setText(text);
        buffer.clearUndoStack();
        let languageModeA = buffer.getLanguageMode();
        // await buffer.getLanguageMode().parseCompletePromise();
        expect(languageModeA instanceof TreeSitterLanguageMode).toBe(true);
        await languageModeA.ready;
        editor.displayLayer.getScreenLines();

        // Make several random edits.
        for (let j = 0, editCount = 1 + random(4); j < editCount; j++) {
          const editRoll = random(10);
          const range = getRandomBufferRange(random, buffer);

          if (editRoll < 2) {
            const linesToInsert = buildRandomLines(random, range.getExtent().row + 1);
            // console.log('replace', range.toString(), JSON.stringify(linesToInsert))
            buffer.setTextInRange(range, linesToInsert);
          } else if (editRoll < 5) {
            // console.log('delete', range.toString())
            buffer.delete(range);
          } else {
            const linesToInsert = buildRandomLines(random, 3);
            // console.log('insert', range.start.toString(), JSON.stringify(linesToInsert))
            buffer.insert(range.start, linesToInsert);
          }

          // console.log(buffer.getText())

          // Sometimes, let the parse complete before re-rendering.
          // Sometimes re-render and move on before the parse completes.
          // if (random(2)) await buffer.getLanguageMode().parseCompletePromise();
          await buffer.getLanguageMode().nextTransaction;
          editor.displayLayer.getScreenLines();
        }

        // Revert the edits, because Tree-sitter's error recovery is somewhat path-dependent,
        // and we want a state where the tree parse result is guaranteed.
        while (buffer.undo()) {
          /* revert every edit */
        }

        // Each undo queues another parse. Wait for them to settle, or the
        // incremental highlighting below is read while it is still catching up
        // and reports scopes that simply have not been applied yet.
        await languageModeA.parseCompletePromise();

        // Create a fresh buffer and editor with the same text.
        const buffer2 = new TextBuffer(buffer.getText());
        const editor2 = new TextEditor({ buffer: buffer2 });
        lumine.grammars.assignLanguageMode(buffer2, "source.js");

        // Verify that the two buffers have the same syntax highlighting.
        let languageModeB = buffer2.getLanguageMode();
        expect(languageModeB instanceof TreeSitterLanguageMode).toBe(true);
        await languageModeB.ready;
        await languageModeB.parseCompletePromise();
        expect(languageModeA.tree.rootNode.toString())
          .withContext(`Seed: ${seed}`)
          .toEqual(languageModeB.tree.rootNode.toString());

        // TODO: `wait(0)` works here when awaiting the next transaction
        // doesn't. Not sure why.
        await wait(0);

        for (let j = 0, n = editor.getScreenLineCount(); j < n; j++) {
          const tokens1 = editor.tokensForScreenRow(j);
          const tokens2 = editor2.tokensForScreenRow(j);
          expect(tokens1).withContext(`Seed: ${seed}, screen line: ${j}`).toEqual(tokens2);
        }
      }
    });
  });

  describe(".suggestedIndentForBufferRow", () => {
    let editor;

    describe("javascript", () => {
      beforeEach(async () => {
        editor = await lumine.workspace.open("sample.js", { autoIndent: false });
        await lumine.packages.activatePackage("language-javascript");
        await editor.getBuffer().getLanguageMode().ready;
      });

      it("bases indentation off of the previous non-blank line", () => {
        expect(editor.suggestedIndentForBufferRow(0)).toBe(0);
        expect(editor.suggestedIndentForBufferRow(1)).toBe(1);
        expect(editor.suggestedIndentForBufferRow(2)).toBe(2);
        expect(editor.suggestedIndentForBufferRow(5)).toBe(3);
        expect(editor.suggestedIndentForBufferRow(7)).toBe(2);
        expect(editor.suggestedIndentForBufferRow(9)).toBe(1);
        expect(editor.suggestedIndentForBufferRow(11)).toBe(1);
      });

      it("does not take invisibles into account", () => {
        editor.update({ showInvisibles: true });
        expect(editor.suggestedIndentForBufferRow(0)).toBe(0);
        expect(editor.suggestedIndentForBufferRow(1)).toBe(1);
        expect(editor.suggestedIndentForBufferRow(2)).toBe(2);
        expect(editor.suggestedIndentForBufferRow(5)).toBe(3);
        expect(editor.suggestedIndentForBufferRow(7)).toBe(2);
        expect(editor.suggestedIndentForBufferRow(9)).toBe(1);
        expect(editor.suggestedIndentForBufferRow(11)).toBe(1);
      });
    });

    describe("css", () => {
      beforeEach(async () => {
        editor = await lumine.workspace.open("css.css", { autoIndent: true });
        await lumine.packages.activatePackage("language-source");
        await lumine.packages.activatePackage("language-css");
        await editor.getBuffer().getLanguageMode().ready;
      });

      it("does not return negative values (regression)", async () => {
        jasmine.useRealClock();
        editor.setText(".test {\npadding: 0;\n}");
        await wait(0);
        expect(editor.suggestedIndentForBufferRow(2)).toBe(0);

        editor.setText("@media screen {\n  .test {\n    padding: 0;\n  }\n}");
        await wait(0);
        expect(editor.suggestedIndentForBufferRow(3)).toBe(1);
      });
    });
  });

  describe(".suggestedIndentForBufferRows", () => {
    beforeEach(async () => {
      await lumine.packages.activatePackage("language-javascript");
    });

    it("works correctly when straddling an injection boundary", async () => {
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      // `suggestedIndentForBufferRows` should use the HTML grammar to
      // determine the indent level of `let foo` rather than the JS grammar.
      //
      // And on line 5, it should use the JavaScript grammar to determine
      // `</script>`'s _initial_ indentation level, but the HTML grammar to
      // determine whether to dedent relative to that initial level.
      buffer.setText(dedent`
        <script>
          let foo;
          if (foo) {
            debug(true);
          }
        </script>
      `);

      const languageMode = new TreeSitterLanguageMode({
        grammar: htmlGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      let map = languageMode.suggestedIndentForBufferRows(0, 5, editor.getTabLength());

      expect(Array.from(map.values())).toEqual([0, 1, 1, 2, 1, 0]);
    });

    it("works correctly when straddling an injection boundary, even in the presence of whitespace", async () => {
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      // This is just like the test above, except that we're indented a bit.
      // Now the edge of the injection isn't at the beginning of the line; it's
      // at the beginning of the first _text_ on the line.
      buffer.setText(dedent`
        <html>
          <head>
            <script>
              let foo;
              if (foo) {
                debug(true);
              }
            </script>
          </head>
        </html>
      `);

      const languageMode = new TreeSitterLanguageMode({
        grammar: htmlGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      let map = languageMode.suggestedIndentForBufferRows(0, 9, editor.getTabLength());

      expect(Array.from(map.values())).toEqual([0, 1, 2, 3, 3, 4, 3, 2, 1, 0]);
    });
  });

  describe("folding", () => {
    it("can fold nodes that start and end with specified tokens", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
      [
        (statement_block)
        (switch_body)
        (class_body)
        (object)
        (formal_parameters)
      ] @fold
      `,
      );

      buffer.setText(dedent`
        module.exports =
        class A {
          getB (c,
                d,
                e) {
            return this.f(g)
          }
        }
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.isFoldableAtBufferRow(0)).toBe(false);
      expect(editor.isFoldableAtBufferRow(1)).toBe(true);
      expect(editor.isFoldableAtBufferRow(2)).toBe(true);
      expect(editor.isFoldableAtBufferRow(3)).toBe(false);
      expect(editor.isFoldableAtBufferRow(4)).toBe(true);
      expect(editor.isFoldableAtBufferRow(5)).toBe(false);

      editor.foldBufferRow(2);
      expect(getDisplayText(editor)).toBe(dedent`
        module.exports =
        class A {
          getB (c,…) {
            return this.f(g)
          }
        }
      `);

      editor.foldBufferRow(4);
      expect(getDisplayText(editor)).toBe(dedent`
        module.exports =
        class A {
          getB (c,…) {…}
        }
      `);
    });

    it("folds entire buffer rows when necessary to keep words on separate lines", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
      [
        (switch_body)
        (class_body)
        (object)
        (formal_parameters)
      ] @fold

      ((if_statement
        consequence: (statement_block) @fold)
        (#set! fold.offsetEnd -1))

      (else_clause (statement_block) @fold)

      (statement_block) @fold
      `,
      );

      buffer.setText(dedent`
        if (a) {
          b
        } else if (c) {
          d
        } else {
          e
        }
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      // NOTE: I had to decrement all the line numbers to get this test to
      // pass, but that matches up with my expectations just from experimenting
      // in the editor. I have no idea how the `TreeSitterLanguageMode` specs
      // get this to pass with the wrong line numbers.

      // Avoid bringing the `else if...` up onto the same screen line as the
      // preceding `if`.
      editor.foldBufferRow(0);
      editor.foldBufferRow(2);
      expect(getDisplayText(editor)).toBe(dedent`
        if (a) {…
        } else if (c) {…
        } else {
          e
        }
      `);

      // It's ok to bring the final `}` onto the same screen line as the
      // preceding `else`.
      editor.foldBufferRow(4);
      expect(getDisplayText(editor)).toBe(dedent`
        if (a) {…
        } else if (c) {…
        } else {…}
      `);
    });

    it("can fold nodes of specified types", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
      (jsx_element
        (jsx_opening_element ">" @fold)
        (#set! fold.endAt parent.parent.lastChild.startPosition)
        (#set! fold.offsetEnd -1)
      )

      (jsx_element
        (jsx_opening_element) @fold
        (#set! fold.endAt lastChild.previousSibling.endPosition))

      ((jsx_self_closing_element) @fold
        (#set! fold.endAt lastChild.startPosition))
      `,
      );

      buffer.setText(dedent`
        const element1 = <Element
          className='submit'
          id='something' />

        const element2 = <Element>
          <span>hello</span>
          <span>world</span>
        </Element>
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.isFoldableAtBufferRow(0)).toBe(true);
      expect(editor.isFoldableAtBufferRow(1)).toBe(false);
      expect(editor.isFoldableAtBufferRow(2)).toBe(false);
      expect(editor.isFoldableAtBufferRow(3)).toBe(false);
      expect(editor.isFoldableAtBufferRow(4)).toBe(true);
      expect(editor.isFoldableAtBufferRow(5)).toBe(false);

      editor.foldBufferRow(0);
      expect(getDisplayText(editor)).toBe(dedent`
        const element1 = <Element…/>

        const element2 = <Element>
          <span>hello</span>
          <span>world</span>
        </Element>
      `);

      editor.foldBufferRow(4);
      expect(getDisplayText(editor)).toBe(dedent`
        const element1 = <Element…/>

        const element2 = <Element>…
        </Element>
      `);
    });

    it("updates its fold cache properly when `fold.invalidateOnChange` is specified", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        scm`
        (element
          (start_tag
            (tag_name) @_IGNORE_
             ">" @fold)
          (#set! fold.endAt parent.parent.lastNamedChild.startPosition)
          (#set! fold.adjustToEndOfPreviousRow true)
        )

        (element
          (start_tag
            (tag_name) @_IGNORE_) @fold
          (#set! fold.invalidateOnChange true)
          (#set! fold.endAt lastChild.startPosition)
          (#set! fold.adjustToEndOfPreviousRow true))
      `,
      );

      // This is almost the exact scenario that created the need for this
      // predicate. Since we use `adjustToEndOfPreviousRow`, this fold won't be
      // valid in the below scenario because it'd start and end on row 0.
      buffer.setText(dedent`
        <div
          foo="bar">
          <span>hello</span>
          <span>world</span>
        </div>
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.isFoldableAtBufferRow(0)).toBe(false);
      expect(editor.isFoldableAtBufferRow(1)).toBe(true);
      expect(editor.isFoldableAtBufferRow(2)).toBe(false);
      expect(editor.isFoldableAtBufferRow(3)).toBe(false);
      expect(editor.isFoldableAtBufferRow(4)).toBe(false);

      editor.setCursorBufferPosition([1, 11]);
      editor.insertText("\n");
      await languageMode.atTransactionEnd();

      // It's only after we make this edit — and `start_tag` ends on row 2
      // instead of row 1 — that the fold becomes valid, since now the fold
      // range will start at row 0 and end at row 1. But without
      // `fold.invalidateOnChange`, we wouldn't know that the change on line 1
      // could have any effect on whether row 0 was foldable.
      expect(editor.getText()).toBe(dedent`
        <div
          foo="bar"
        >
          <span>hello</span>
          <span>world</span>
        </div>
      `);

      expect(editor.isFoldableAtBufferRow(0)).toBe(true);
      expect(editor.isFoldableAtBufferRow(1)).toBe(false);
      expect(editor.isFoldableAtBufferRow(2)).toBe(true);
      expect(editor.isFoldableAtBufferRow(3)).toBe(false);
      expect(editor.isFoldableAtBufferRow(4)).toBe(false);
    });

    it("understands custom predicates", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        scm`
        ((element
          (start_tag
            (tag_name) @_IGNORE_.tag)) @_IGNORE_.element
            (#eq? @_IGNORE_.tag "div")
            (#set! isDiv true))

        ; Make self-closing elements foldable only when they're ancestors of
        ; DIVs. This is a very silly thing to do.
        ((element
          (start_tag
            (tag_name) @_IGNORE_) @fold)
          (#match? @_IGNORE_ "^(area|base|br|col|embed|hr|img|input|keygen|link|meta|param|source|track|wbr)$")
          (#set! test.descendantOfNodeWithData "isDiv")
          (#set! capture.final)
        )

      `,
      );

      buffer.setText(dedent`
        <img
          foo="bar"
          baz="thud"
          troz="zort"
        >

        <div>
          <img
            foo="bar"
            baz="thud"
            troz="zort"
          >
        </div>
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.isFoldableAtBufferRow(0)).toBe(false);
      expect(editor.isFoldableAtBufferRow(7)).toBe(true);
    });

    it("can fold entire nodes when no start or end parameters are specified", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
      ((comment) @fold
        (#set! fold.endAt endPosition)
        (#set! fold.adjustEndColumn 0))
      `,
      );

      buffer.setText(dedent`
        /**
         * Important
         */
        const x = 1 /*
          Also important
        */
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.isFoldableAtBufferRow(0)).toBe(true);
      expect(editor.isFoldableAtBufferRow(1)).toBe(false);
      expect(editor.isFoldableAtBufferRow(2)).toBe(false);
      expect(editor.isFoldableAtBufferRow(3)).toBe(true);
      expect(editor.isFoldableAtBufferRow(4)).toBe(false);

      editor.foldBufferRow(0);
      expect(getDisplayText(editor)).toBe(dedent`
        /**… */
        const x = 1 /*
          Also important
        */
      `);

      editor.foldBufferRow(3);
      expect(getDisplayText(editor)).toBe(dedent`
        /**… */
        const x = 1 /*…*/
      `);
    });

    it("folds between arbitrary points in the buffer with @fold.start and @fold.end markers", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, cGrammarPath, cConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
      ["#ifndef" "#ifdef" "#elif" "#else"] @fold.start
      ["#elif" "#else" "#endif"] @fold.end
      `,
      );

      buffer.setText(dedent`
        #ifndef FOO_H_
        #define FOO_H_

        #ifdef _WIN32

        #include <windows.h>
        const char *path_separator = "\\";

        #elif defined MACOS

        #include <carbon.h>
        const char *path_separator = "/";

        #else

        #include <dirent.h>
        const char *path_separator = "/";

        #endif

        #endif
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.isFoldableAtBufferRow(0)).toBe(true);

      editor.foldBufferRow(3);
      expect(getDisplayText(editor)).toBe(dedent`
        #ifndef FOO_H_
        #define FOO_H_

        #ifdef _WIN32…
        #elif defined MACOS

        #include <carbon.h>
        const char *path_separator = "/";

        #else

        #include <dirent.h>
        const char *path_separator = "/";

        #endif

        #endif
      `);

      editor.foldBufferRow(8);
      expect(getDisplayText(editor)).toBe(dedent`
        #ifndef FOO_H_
        #define FOO_H_

        #ifdef _WIN32…
        #elif defined MACOS…
        #else

        #include <dirent.h>
        const char *path_separator = "/";

        #endif

        #endif
      `);

      editor.foldBufferRow(0);
      expect(getDisplayText(editor)).toBe(dedent`
        #ifndef FOO_H_…
        #endif
      `);

      console.time("folding all");
      editor.foldAllAtIndentLevel(1);
      console.timeEnd("folding all");
      expect(getDisplayText(editor)).toBe(dedent`
        #ifndef FOO_H_
        #define FOO_H_

        #ifdef _WIN32…
        #elif defined MACOS…
        #else…
        #endif

        #endif
      `);
    });

    it("allows fold adjustments to be applied to @fold.end markers", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, cGrammarPath, cConfig);

      // In addition to nudging the fold ending position forward one character,
      // it also precludes the automatic “adjust to end of previous line”
      // behavior. So the fold will expand by one row and one column.
      await grammar.setQueryForTest(
        "foldsQuery",
        `
      ["#ifndef" "#ifdef" "#elif" "#else"] @fold.start
      (["#elif" "#else" "#endif"] @fold.end
       (#set! fold.offsetEnd 1))
      `,
      );

      buffer.setText(dedent`
        #ifndef FOO_H_
        #define FOO_H_

        #ifdef _WIN32

        #include <windows.h>
        const char *path_separator = "\\";

        #elif defined MACOS

        #include <carbon.h>
        const char *path_separator = "/";

        #else

        #include <dirent.h>
        const char *path_separator = "/";

        #endif

        #endif
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.isFoldableAtBufferRow(0)).toBe(true);

      editor.foldBufferRow(3);
      expect(getDisplayText(editor)).toBe(dedent`
        #ifndef FOO_H_
        #define FOO_H_

        #ifdef _WIN32…elif defined MACOS

        #include <carbon.h>
        const char *path_separator = "/";

        #else

        #include <dirent.h>
        const char *path_separator = "/";

        #endif

        #endif
      `);
    });

    it("does not fold when the start and end parameters match the same child", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
        (element) @fold
      `,
      );

      buffer.setText(dedent`
        <head>
        <meta name='key-1' content='value-1'>
        <meta name='key-2' content='value-2'>
        </head>
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      // Void elements have only one child
      expect(editor.isFoldableAtBufferRow(1)).toBe(false);
      expect(editor.isFoldableAtBufferRow(2)).toBe(false);

      editor.foldBufferRow(0);
      expect(getDisplayText(editor)).toBe(dedent`
        <head>…</head>
      `);
    });

    it("does not enumerate redundant folds", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
        (statement_block) @fold
        (object) @fold
      `,
      );

      // This odd way of formatting code produces a scenario where two folds
      // would start on the same line. The second of the two folds would never
      // be seen when toggling the fold on that line, so we shouldn't treat it
      // as a valid fold for any other purpose.
      buffer.setText(dedent`
        if (foo) {results.push({
          bar: 'baz'
        })}
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      let ranges = languageMode.getFoldableRanges();
      expect(ranges.length).toBe(1);
    });

    it("is not flummoxed by redundant folds when performing foldAllAtIndentLevel", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
        (statement_block) @fold
        (object) @fold
      `,
      );

      buffer.setText(dedent`
        function foo() {
          if (true) {
            if (foo) {results.push({
              bar: 'baz'
            })}
          }
        }

        function bar() {
          if (false) {
            // TODO
          }
        }
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.foldAllAtIndentLevel(1);
      expect(getDisplayText(editor)).toBe(dedent`
        function foo() {
          if (true) {…}
        }

        function bar() {
          if (false) {…}
        }
      `);

      buffer.setText(dedent`
        function foo() {
          if (true) {
            if (foo) {
            results.push({
              bar: 'baz'
            })}
          }
        }

        function bar() {
          if (false) {
            // TODO
          }
        }
      `);
      await languageMode.atTransactionEnd();

      editor.foldAllAtIndentLevel(1);
      expect(getDisplayText(editor)).toBe(dedent`
        function foo() {
          if (true) {…}
        }

        function bar() {
          if (false) {…}
        }
      `);
    });

    it("can handle folds that share boundaries with other folds", async () => {
      const grammar = new TreeSitterGrammar(
        lumine.grammars,
        pythonGrammarPath,
        CSON.readFileSync(pythonGrammarPath),
      );
      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);

      buffer.setText(dedent`
        class Example:
            def get_dimension_values(self):
                while True:
                    do_something()

            def wont_fold(self):
                pass
      `);
      await languageMode.ready;

      editor.foldAllAtIndentLevel(1);

      expect(getDisplayText(editor)).toBe(dedent`
        class Example:
            def get_dimension_values(self):…

            def wont_fold(self):…
      `);
    });

    it("can target named vs anonymous nodes as fold boundaries", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, pythonGrammarPath, pythonConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
        ((if_statement
          alternative: [(elif_clause) (else_clause)]) @fold
          (#set! fold.endAt firstNamedChild.nextNamedSibling.nextNamedSibling.startPosition)
          (#set! fold.offsetEnd -1))

        ((elif_clause
          consequence: (block)) @fold
          (#set! fold.endAt endPosition))

        ((else_clause) @fold
          (#set! fold.endAt endPosition))

        (if_statement) @fold
      `,
      );

      buffer.setText(dedent`
        if a:
          b
        elif c:
          d
        else:
          e
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(languageMode.tree.rootNode.toString()).toBe(
        "(module (if_statement condition: (identifier) consequence: (block " +
          "(identifier)) " +
          "alternative: (elif_clause condition: (identifier) consequence: (block " +
          "(identifier))) " +
          "alternative: (else_clause body: (block " +
          "(identifier)))))",
      );

      editor.foldBufferRow(2);
      expect(getDisplayText(editor)).toBe(dedent`
        if a:
          b
        elif c:…
        else:
          e
      `);

      editor.foldBufferRow(4);
      expect(getDisplayText(editor)).toBe(dedent`
        if a:
          b
        elif c:…
        else:…
      `);
    });

    it("updates fold locations when the buffer changes", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "foldsQuery",
        `
        [
          (switch_body)
          (class_body)
          (object)
          (formal_parameters)
          (statement_block) @fold
        ] @fold
      `,
      );

      buffer.setText(dedent`
        class A {
          // a
          constructor (b) {
            this.b = b
          }
        }
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      languageMode.isFoldableCache = [];

      expect(languageMode.isFoldableAtRow(0)).toBe(true);
      expect(languageMode.isFoldableAtRow(1)).toBe(false);
      expect(languageMode.isFoldableAtRow(2)).toBe(true);
      expect(languageMode.isFoldableAtRow(3)).toBe(false);
      expect(languageMode.isFoldableAtRow(4)).toBe(false);

      buffer.insert([0, 0], "\n");

      expect(languageMode.isFoldableAtRow(0)).toBe(false);
      expect(languageMode.isFoldableAtRow(1)).toBe(true);
      expect(languageMode.isFoldableAtRow(2)).toBe(false);
      expect(languageMode.isFoldableAtRow(3)).toBe(true);
      expect(languageMode.isFoldableAtRow(4)).toBe(false);
    });

    describe("when folding a node that ends with a line break", () => {
      it("ends the fold at the end of the previous line", async () => {
        const grammar = new TreeSitterGrammar(
          lumine.grammars,
          pythonGrammarPath,
          CSON.readFileSync(pythonGrammarPath),
        );

        await grammar.setQueryForTest(
          "foldsQuery",
          `
        ([
          (function_definition)
          (class_definition)

          (while_statement)
          (for_statement)
          (with_statement)
          (try_statement)
          (match_statement)

          (elif_clause)
          (else_clause)
          (case_clause)

          (import_from_statement)
          (parameters)
          (argument_list)

          (parenthesized_expression)
          (generator_expression)
          (list_comprehension)
          (set_comprehension)
          (dictionary_comprehension)

          (tuple)
          (list)
          (set)
          (dictionary)

          (string)
        ] @fold (#set! fold.endAt endPosition))

        `,
        );

        buffer.setText(dedent`
          def ab():
            print 'a'
            print 'b'

          def cd():
            print 'c'
            print 'd'
        `);

        let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        editor.foldBufferRow(0);

        expect(getDisplayText(editor)).toBe(dedent`
          def ab():…

          def cd():
            print 'c'
            print 'd'
        `);
      });
    });

    it("folds code in injected languages", async () => {
      jasmine.useRealClock();
      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      await htmlGrammar.setQueryForTest(
        "foldsQuery",
        `
        [(element) (script_element)] @fold
      `,
      );

      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await jsGrammar.setQueryForTest(
        "foldsQuery",
        `
        (template_string) @fold
        ((arguments) @fold
          (#set! fold.adjustEndColumn 0)
          (#set! fold.offsetEnd -1))
      `,
      );

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      lumine.grammars.addGrammar(htmlGrammar);

      buffer.setText(
        `a = html \`
            <div>
              c\${def(
                1,
                2,
                3,
              )}e\${f}g
            </div>
          \`
        `,
      );
      const languageMode = new TreeSitterLanguageMode({
        grammar: jsGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.foldBufferRow(2);
      expect(getDisplayText(editor)).toBe(
        `a = html \`
            <div>
              c\${def(…
              )}e\${f}g
            </div>
          \`
        `,
      );

      editor.foldBufferRow(1);
      expect(getDisplayText(editor)).toBe(
        `a = html \`
            <div>…</div>
          \`
        `,
      );

      editor.foldBufferRow(0);
      expect(getDisplayText(editor)).toBe(
        `a = html \`…\`
        `,
      );
    });
  });

  describe(".scopeDescriptorForPosition", () => {
    it("returns a scope descriptor representing the given position in the syntax tree", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (property_identifier) @property.name
        (comment) @comment.block
      `,
      );

      buffer.setText("foo({bar: baz});");

      let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(
        editor.scopeDescriptorForBufferPosition([0, "foo({b".length]).getScopesArray(),
      ).toEqual(["source.js", "property.name"]);
      expect(editor.scopeDescriptorForBufferPosition([0, "foo({".length]).getScopesArray()).toEqual(
        ["source.js", "property.name"],
      );

      // Drive-by test for .tokenForPosition()
      const token = editor.tokenForBufferPosition([0, "foo({b".length]);
      expect(token.value).toBe("bar");
      expect(token.scopes).toEqual(["source.js", "property.name"]);

      buffer.setText("// baz\n");

      // Adjust position when at end of line

      languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(
        editor.scopeDescriptorForBufferPosition([0, "// baz".length]).getScopesArray(),
      ).toEqual(["source.js", "comment.block"]);
    });

    it("includes nodes in injected syntax trees", async () => {
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await jsGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (template_string) @string.quoted
        (property_identifier) @property.name
      `,
      );

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      await htmlGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (script_element) @script.tag
      `,
      );
      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      buffer.setText(`
        <div>
          <script>
            html \`
              <span>\${person.name}</span>
            \`
          </script>
        </div>
      `);

      const languageMode = new TreeSitterLanguageMode({
        grammar: htmlGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      const position = buffer.findSync("name").start;
      expect(languageMode.scopeDescriptorForPosition(position).getScopesArray()).toEqual([
        "text.html.basic",
        "script.tag",
        "source.js",
        "string.quoted",
        "property.name",
      ]);
    });

    it("reports scopes correctly at boundaries where more than one layer adds a scope", async () => {
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await jsGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (template_string) @string.quoted
        ((template_string) @string-insides
          (#set! adjust.startAfterFirstMatchOf "^\`")
          (#set! adjust.endBeforeFirstMatchOf "\`$"))
        "\`" @punctuation
        (property_identifier) @property.name
      `,
      );

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      await htmlGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (start_tag) @tag
      `,
      );
      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      buffer.setText(dedent`
        html\`<span>\${person.name}</span>\`
      `);

      const languageMode = new TreeSitterLanguageMode({
        grammar: jsGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      const position = buffer.findSync("html`").end;
      expect(languageMode.scopeDescriptorForPosition(position).getScopesArray()).toEqual([
        "source.js",
        "string.quoted",
        "string-insides",
        "text.html.basic",
        "tag",
      ]);
    });

    it("includes the root scope name even when the given position is in trailing whitespace at EOF", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (property_identifier) @property.name
      `,
      );

      buffer.setText("a; ");

      let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.scopeDescriptorForBufferPosition([0, 3]).getScopesArray()).toEqual([
        "source.js",
      ]);
    });

    it("works when the given position is between tokens", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (comment) @comment.block
      `,
      );

      buffer.setText("a  // b");

      let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.scopeDescriptorForBufferPosition([0, 2]).getScopesArray()).toEqual([
        "source.js",
      ]);
      expect(editor.scopeDescriptorForBufferPosition([0, 3]).getScopesArray()).toEqual([
        "source.js",
        "comment.block",
      ]);
    });

    it("works when a scope range has been adjusted", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (comment) @comment.block
        ((comment) @punctuation.definition.comment.begin
          (#set! adjust.startAndEndAroundFirstMatchOf "^/\\\\*"))
      `,
      );

      buffer.setText("\n/* lorem ipsum dolor sit amet */");

      let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.scopeDescriptorForBufferPosition([1, 0]).getScopesArray()).toEqual([
        "source.js",
        "comment.block",
        "punctuation.definition.comment.begin",
      ]);
      expect(editor.scopeDescriptorForBufferPosition([1, 1]).getScopesArray()).toEqual([
        "source.js",
        "comment.block",
        "punctuation.definition.comment.begin",
      ]);
      expect(editor.scopeDescriptorForBufferPosition([1, 2]).getScopesArray()).toEqual([
        "source.js",
        "comment.block",
      ]);
    });

    it("ignores a parent's scopes if an injection layer sets `coverShallowerScopes`", async () => {
      jasmine.useRealClock();
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      let tempJsRegexConfig = {
        ...jsRegexConfig,
        injectionNames: ["js-regex-for-test"],
      };

      const regexGrammar = new TreeSitterGrammar(
        lumine.grammars,
        jsRegexGrammarPath,
        tempJsRegexConfig,
      );

      await regexGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (pattern) @string.regexp
        (optional "?" @keyword.operator.optional)
      `,
      );

      jsGrammar.addInjectionPoint({
        type: "regex_pattern",
        language(_regex) {
          return "js-regex-for-test";
        },
        content(regex) {
          return regex;
        },
        includeChildren: true,
        languageScope: null,
        coverShallowerScopes: true,
      });

      await jsGrammar.setQueryForTest(
        "highlightsQuery",
        `
        ((regex) @gadfly
          (#set! adjust.startAndEndAroundFirstMatchOf "lor\\\\?em"))
        (regex) @regex-outer
        (regex_pattern) @regex-inner
      `,
      );

      lumine.grammars.addGrammar(regexGrammar);
      lumine.grammars.addGrammar(jsGrammar);

      buffer.setText(dedent`
        let foo = /patt.lor?em.ern/;
      `);

      const languageMode = new TreeSitterLanguageMode({
        grammar: jsGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      // Wait for injections.
      await wait(100);

      let injectionLayers = languageMode.getAllInjectionLayers();
      expect(injectionLayers.length).toBe(1);

      let descriptor = languageMode.scopeDescriptorForPosition(new Point(0, 19));
      let scopes = descriptor.getScopesArray();
      expect(scopes.includes("gadfly")).toBe(false);
      expect(scopes.includes("regex-outer")).toBe(true);
      expect(scopes.includes("regex-inner")).toBe(false);
    });

    it("arranges scopes in the proper order when scopes from several layers were already open at a given point", async () => {
      jasmine.useRealClock();
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      let tempJsRegexConfig = {
        ...jsRegexConfig,
        injectionNames: ["js-regex-for-test"],
      };

      const regexGrammar = new TreeSitterGrammar(
        lumine.grammars,
        jsRegexGrammarPath,
        tempJsRegexConfig,
      );

      await regexGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (pattern) @string.regexp
      `,
      );

      jsGrammar.addInjectionPoint({
        type: "regex_pattern",
        language(_regex) {
          return "js-regex-for-test";
        },
        content(regex) {
          return regex;
        },
        includeChildren: true,
        languageScope: null,
      });

      await jsGrammar.setQueryForTest(
        "highlightsQuery",
        `
        ((regex_pattern) @gadfly
          (#set! adjust.startAndEndAroundFirstMatchOf "lor\\\\?em"))
        (regex) @regex-outer
        (regex_pattern) @regex-inner
      `,
      );

      lumine.grammars.addGrammar(regexGrammar);
      lumine.grammars.addGrammar(jsGrammar);

      buffer.setText(dedent`
        let foo = /patt.lor?em.ern/;
      `);

      const languageMode = new TreeSitterLanguageMode({
        grammar: jsGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      // Wait for injections.
      await wait(100);

      let injectionLayers = languageMode.getAllInjectionLayers();
      expect(injectionLayers.length).toBe(1);

      let descriptor = languageMode.scopeDescriptorForPosition(new Point(0, 19));
      let scopes = descriptor.getScopesArray();
      expect(scopes).toEqual([
        "source.js",
        "regex-outer",
        "regex-inner",
        "string.regexp",
        "gadfly",
      ]);
    });
  });

  describe(".syntaxTreeScopeDescriptorForPosition", () => {
    it("returns a scope descriptor representing the given position in the syntax tree", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      buffer.setText("foo({bar: baz});");

      let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(editor.syntaxTreeScopeDescriptorForBufferPosition([0, 6]).getScopesArray()).toEqual([
        "source.js",
        "program",
        "expression_statement",
        "call_expression",
        "arguments",
        "object",
        "pair",
        "property_identifier",
      ]);

      languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setText("//bar\n");
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await languageMode.nextTransaction;

      expect(editor.syntaxTreeScopeDescriptorForBufferPosition([0, 5]).getScopesArray()).toEqual([
        "source.js",
        "program",
        "comment",
      ]);
    });

    it("includes nodes in injected syntax trees", async () => {
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      buffer.setText(`
        <div>
          <script>
            html \`
              <span>\${person.name}</span>
            \`
          </script>
        </div>
      `);

      const languageMode = new TreeSitterLanguageMode({
        grammar: htmlGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      const position = buffer.findSync("name").start;
      expect(editor.syntaxTreeScopeDescriptorForBufferPosition(position).getScopesArray()).toEqual([
        "text.html.basic",
        "document",
        "element",
        "script_element",
        "raw_text",
        "program",
        "expression_statement",
        "call_expression",
        "template_string",
        "document",
        "element",
        "template_substitution",
        "member_expression",
        "property_identifier",
      ]);
    });
  });

  describe(".bufferRangeForScopeAtPosition(selector?, position)", () => {
    describe("when selector = null", () => {
      it("returns the range of the smallest node at position", async () => {
        const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        buffer.setText("foo({bar: baz});");

        let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expect(editor.bufferRangeForScopeAtPosition(null, [0, 6])).toEqual([
          [0, 5],
          [0, 8],
        ]);
        expect(editor.bufferRangeForScopeAtPosition(null, [0, 8])).toEqual([
          [0, 8],
          [0, 9],
        ]);
      });

      it("includes nodes in injected syntax trees", async () => {
        const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (property_identifier) @property
        `,
        );

        const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

        htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);

        buffer.setText(`
          <div>
            <script>
              html \`
                <span>\${person.name}</span>
              \`
            </script>
          </div>
        `);

        const languageMode = new TreeSitterLanguageMode({
          grammar: htmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        const nameProperty = buffer.findSync("name");
        const { start } = nameProperty;
        const position = {
          ...start,
          column: start.column + 2,
        };
        expect(languageMode.bufferRangeForScopeAtPosition(null, position)).toEqual(nameProperty);
      });
    });

    describe("with a selector", () => {
      it("returns the range of the smallest matching node at position", async () => {
        const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        await grammar.setQueryForTest(
          "highlightsQuery",
          `
          (property_identifier) @variable.other.object.property
          (template_string) @string.quoted.template
        `,
        );

        buffer.setText("a(`${b({ccc: ddd})} eee`);");

        let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        expect(editor.bufferRangeForScopeAtPosition(".variable.property", [0, 9])).toEqual([
          [0, 8],
          [0, 11],
        ]);
        expect(editor.bufferRangeForScopeAtPosition(".string.quoted", [0, 6])).toEqual([
          [0, 2],
          [0, 24],
        ]);
      });

      it("includes nodes in injected syntax trees", async () => {
        const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
        jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);
        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (property_identifier) @variable.other.object.property
        `,
        );

        const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

        htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);
        await htmlGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (element) @meta.element.html
        `,
        );

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);

        buffer.setText(`
          <div>
            <script>
              html \`
                <span>\${person.name}</span>
              \`
            </script>
          </div>
        `);

        const languageMode = new TreeSitterLanguageMode({
          grammar: htmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        const nameProperty = buffer.findSync("name");
        const { start } = nameProperty;
        const position = Object.assign({}, start, { column: start.column + 2 });
        expect(languageMode.bufferRangeForScopeAtPosition(".object.property", position)).toEqual(
          nameProperty,
        );
        expect(languageMode.bufferRangeForScopeAtPosition(".meta.element.html", position)).toEqual(
          buffer.findSync("<span>\\${person\\.name}</span>"),
        );
      });

      it("reports results correctly when scope ranges have been adjusted", async () => {
        jasmine.useRealClock();
        const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ((regex) @keyword.operator.optional
            (#set! adjust.startAndEndAroundFirstMatchOf "\\\\?"))
          (regex) @string.regexp.js
          ((comment) @comment.block.js)
          ((comment) @punctuation.definition.comment.begin.js
            (#set! adjust.endAfterFirstMatchOf "^/\\\\*"))
        `,
        );

        lumine.grammars.addGrammar(jsGrammar);

        buffer.setText(dedent`
          let foo = /patt?ern/;
          /* this is a block comment */
        `);

        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        let range = languageMode.bufferRangeForScopeAtPosition("keyword", new Point(0, 15));
        expect(range.toString()).toBe(`[(0, 15) - (0, 16)]`);

        range = languageMode.bufferRangeForScopeAtPosition("punctuation", new Point(1, 0));
        expect(range.toString()).toBe(`[(1, 0) - (1, 2)]`);

        range = languageMode.bufferRangeForScopeAtPosition("comment.block", new Point(1, 0));
        expect(range.toString()).toBe(`[(1, 0) - (1, 29)]`);
      });

      it("ignores scopes that are not present because they are covered by a deeper layer", async () => {
        // A similar test to the one above, except now we expect not to see the
        // scope because it's being covered by the injection layer.
        jasmine.useRealClock();
        const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        let tempJsRegexConfig = {
          ...jsRegexConfig,
          injectionNames: ["js-regex-for-test"],
        };

        const regexGrammar = new TreeSitterGrammar(
          lumine.grammars,
          jsRegexGrammarPath,
          tempJsRegexConfig,
        );

        await regexGrammar.setQueryForTest(
          "highlightsQuery",
          `
          (pattern) @string.regexp
        `,
        );

        jsGrammar.addInjectionPoint({
          type: "regex_pattern",
          language(_regex) {
            return "js-regex-for-test";
          },
          content(regex) {
            return regex;
          },
          languageScope: null,
          coverShallowerScopes: true,
        });

        await jsGrammar.setQueryForTest(
          "highlightsQuery",
          `
          ((regex) @keyword.operator.optional
            (#set! adjust.startAndEndAroundFirstMatchOf "\\\\?"))
          ((regex_pattern) @string.regexp.js)
        `,
        );

        lumine.grammars.addGrammar(regexGrammar);
        lumine.grammars.addGrammar(jsGrammar);

        buffer.setText(dedent`
          let foo = /patt?ern/;
        `);

        const languageMode = new TreeSitterLanguageMode({
          grammar: jsGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);

        await languageMode.ready;
        await wait(100);

        let point = new Point(0, 15);
        let range = languageMode.bufferRangeForScopeAtPosition("keyword", point);
        expect(range).toBe(undefined);
      });

      it("accepts node-matching functions as selectors", async () => {
        const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

        jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

        await jsGrammar.setQueryForTest("highlightsQuery", ";");

        const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

        htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);
        await htmlGrammar.setQueryForTest("highlightsQuery", ";");

        lumine.grammars.addGrammar(jsGrammar);
        lumine.grammars.addGrammar(htmlGrammar);

        buffer.setText(`
          <div>
            <script>
              html \`
                <span>\${person.name}</span>
              \`
            </script>
          </div>
        `);

        const languageMode = new TreeSitterLanguageMode({
          grammar: htmlGrammar,
          buffer,
          config: lumine.config,
          grammars: lumine.grammars,
        });
        buffer.setLanguageMode(languageMode);
        await languageMode.ready;

        const nameProperty = buffer.findSync("name");
        const { start } = nameProperty;
        const position = Object.assign({}, start, { column: start.column + 2 });
        const templateStringInCallExpression = (node) =>
          node.type === "template_string" && node.parent.type === "call_expression";
        expect(
          languageMode.bufferRangeForScopeAtPosition(templateStringInCallExpression, position),
        ).toEqual([
          [3, 19],
          [5, 15],
        ]);
      });
    });
  });

  describe(".getSyntaxNodeAtPosition(position, where?)", () => {
    it("returns the range of the smallest matching node at position", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      buffer.setText("foo(bar({x: 2}));");
      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      expect(languageMode.getSyntaxNodeAtPosition([0, 6]).range).toEqual(buffer.findSync("bar"));

      const findFoo = (node) => node.type === "call_expression" && node.firstChild.text === "foo";

      expect(languageMode.getSyntaxNodeAtPosition([0, 6], findFoo).range).toEqual([
        [0, 0],
        [0, buffer.getText().length - 1],
      ]);
    });
  });

  describe(".commentStringsForPosition(position)", () => {
    beforeEach(() => {
      lumine.config.unset("editor.commentDelimiters", { scopeSelector: ".source.js" });
      lumine.config.unset("editor.commentStart", { scopeSelector: ".source.js" });
      lumine.config.unset("editor.commentEnd", { scopeSelector: ".source.js" });
      lumine.config.unset("editor.commentDelimiters", { scopeSelector: ".text.html.basic" });
      lumine.config.unset("editor.commentStart", { scopeSelector: ".text.html.basic" });
      lumine.config.unset("editor.commentEnd", { scopeSelector: ".text.html.basic" });
    });

    it("returns the correct comment strings for nested languages", async () => {
      jasmine.useRealClock();
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      lumine.config.set(
        "editor.commentDelimiters",
        {
          line: "//",
          block: ["/*", "*/"],
        },
        { scopeSelector: ".source.js" },
      );

      lumine.config.set("editor.commentStart", "//", { scopeSelector: ".source.js" });

      lumine.config.set(
        "editor.commentDelimiters",
        {
          block: ["<!--", "-->"],
        },
        { scopeSelector: ".text.html.basic" },
      );

      lumine.config.set("editor.commentStart", "<!--", { scopeSelector: ".text.html.basic" });

      lumine.config.set("editor.commentEnd", "-->", { scopeSelector: ".text.html.basic" });

      const languageMode = new TreeSitterLanguageMode({
        grammar: htmlGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      buffer.setText(
        `
<div>hi</div>
<script>
  const node = document.getElementById('some-id');
  node.innerHTML = html \`
    <span>bye</span>
  \`
</script>
      `.trim(),
      );

      const htmlCommentStrings = {
        commentStartString: "<!--",
        commentEndString: "-->",
        commentDelimiters: {
          line: undefined,
          block: ["<!--", "-->"],
        },
      };
      const jsCommentStrings = {
        commentStartString: "//",
        commentEndString: undefined,
        commentDelimiters: {
          line: "//",
          block: ["/*", "*/"],
        },
      };

      // Needs a short delay to allow injection grammars to be loaded.
      await languageMode.nextTransaction;

      expect(languageMode.commentStringsForPosition(new Point(0, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(1, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(2, 0))).toEqual(jsCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(3, 0))).toEqual(jsCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(4, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(5, 0))).toEqual({
        // This is the curveball. Original position is inside the HTML, so
        // that's what the delimiters will be. But `commentStartString` will be
        // `// ` because it looks up the scope of the first non-whitespace
        // content on the row.
        commentStartString: "//",
        commentEndString: undefined,
        commentDelimiters: {
          line: undefined,
          block: ["<!--", "-->"],
        },
      });
      expect(languageMode.commentStringsForPosition(new Point(6, 0))).toEqual(htmlCommentStrings);
    });

    it("uses grammar comment settings when config data is missing", async () => {
      jasmine.useRealClock();
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      const languageMode = new TreeSitterLanguageMode({
        grammar: htmlGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      buffer.setText(
        `
<div>hi</div>
<script>
  const node = document.getElementById('some-id');
  node.innerHTML = html \`
    <span>bye</span>
  \`
</script>
      `.trim(),
      );

      const htmlCommentStrings = {
        commentStartString: "<!--",
        commentEndString: "-->",
        commentDelimiters: {
          line: undefined,
          block: ["<!--", "-->"],
        },
      };
      const jsCommentStrings = {
        commentStartString: "//",
        commentEndString: undefined,
        commentDelimiters: {
          line: "//",
          block: ["/*", "*/"],
        },
      };

      // Needs a short delay to allow injection grammars to be loaded.
      await languageMode.nextTransaction;

      expect(languageMode.commentStringsForPosition(new Point(0, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(1, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(2, 0))).toEqual(jsCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(3, 0))).toEqual(jsCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(4, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(5, 0))).toEqual({
        // This is the curveball. Original position is inside the HTML, so
        // that's what the delimiters will be. But `commentStartString` will be
        // `// ` because it looks up the scope of the first non-whitespace
        // content on the row.
        commentStartString: "//",
        commentEndString: undefined,
        commentDelimiters: {
          line: undefined,
          block: ["<!--", "-->"],
        },
      });
      expect(languageMode.commentStringsForPosition(new Point(6, 0))).toEqual(htmlCommentStrings);
    });

    it("constructs the right comment settings when grammar data is missing", async () => {
      jasmine.useRealClock();
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);

      spyOn(jsGrammar, "getCommentDelimiters").and.returnValue({
        line: undefined,
        block: undefined,
      });
      spyOn(htmlGrammar, "getCommentDelimiters").and.returnValue({
        line: undefined,
        block: undefined,
      });

      lumine.config.set(
        "editor.commentDelimiters",
        {
          line: "//",
          block: ["/*", "*/"],
        },
        { scopeSelector: ".source.js" },
      );

      lumine.config.set(
        "editor.commentDelimiters",
        {
          block: ["<!--", "-->"],
        },
        { scopeSelector: ".text.html.basic" },
      );

      htmlGrammar.addInjectionPoint(SCRIPT_TAG_INJECTION_POINT);

      lumine.grammars.addGrammar(jsGrammar);
      lumine.grammars.addGrammar(htmlGrammar);

      const languageMode = new TreeSitterLanguageMode({
        grammar: htmlGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      buffer.setText(
        `
<div>hi</div>
<script>
  const node = document.getElementById('some-id');
  node.innerHTML = html \`
    <span>bye</span>
  \`
</script>
      `.trim(),
      );

      const htmlCommentStrings = {
        commentStartString: "<!--",
        commentEndString: "-->",
        commentDelimiters: {
          line: undefined,
          block: ["<!--", "-->"],
        },
      };
      const jsCommentStrings = {
        commentStartString: "//",
        commentEndString: undefined,
        commentDelimiters: {
          line: "//",
          block: ["/*", "*/"],
        },
      };

      // Needs a short delay to allow injection grammars to be loaded.
      await languageMode.nextTransaction;

      expect(languageMode.commentStringsForPosition(new Point(0, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(1, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(2, 0))).toEqual(jsCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(3, 0))).toEqual(jsCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(4, 0))).toEqual(htmlCommentStrings);
      expect(languageMode.commentStringsForPosition(new Point(5, 0))).toEqual({
        // This is the curveball. Original position is inside the HTML, so
        // that's what the delimiters will be. But `commentStartString` will be
        // `// ` because it looks up the scope of the first non-whitespace
        // content on the row.
        commentStartString: "//",
        commentEndString: undefined,
        commentDelimiters: {
          line: undefined,
          block: ["<!--", "-->"],
        },
      });
      expect(languageMode.commentStringsForPosition(new Point(6, 0))).toEqual(htmlCommentStrings);
    });
  });

  describe("TextEditor.selectLargerSyntaxNode and .selectSmallerSyntaxNode", () => {
    it("expands and contracts the selection based on the syntax tree", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "highlightsQuery",
        `
        (program) @source
      `,
      );

      buffer.setText(dedent`
        function a (b, c, d) {
          eee.f()
          g()
        }
      `);

      let languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.setCursorBufferPosition([1, 3]);
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("eee");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("eee.f");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("eee.f()");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("{\n  eee.f()\n  g()\n}");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("function a (b, c, d) {\n  eee.f()\n  g()\n}");

      editor.selectSmallerSyntaxNode();
      expect(editor.getSelectedText()).toBe("{\n  eee.f()\n  g()\n}");
      editor.selectSmallerSyntaxNode();
      expect(editor.getSelectedText()).toBe("eee.f()");
      editor.selectSmallerSyntaxNode();
      expect(editor.getSelectedText()).toBe("eee.f");
      editor.selectSmallerSyntaxNode();
      expect(editor.getSelectedText()).toBe("eee");
      editor.selectSmallerSyntaxNode();
      expect(editor.getSelectedBufferRange()).toEqual([
        [1, 3],
        [1, 3],
      ]);
    });

    it("handles injected languages", async () => {
      const jsGrammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await jsGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (property_identifier) @property
        (call_expression (identifier) @function)
        (template_string) @string
        (template_substitution
          ["\${" "}"] @interpolation)
      `,
      );

      jsGrammar.addInjectionPoint(HTML_TEMPLATE_LITERAL_INJECTION_POINT);

      const htmlGrammar = new TreeSitterGrammar(lumine.grammars, htmlGrammarPath, htmlConfig);
      await htmlGrammar.setQueryForTest(
        "highlightsQuery",
        `
        (document) @html
        (tag_name) @tag
        (attribute_name) @attr
      `,
      );

      lumine.grammars.addGrammar(htmlGrammar);

      buffer.setText("a = html ` <b>c${def()}e${f}g</b> `");
      const languageMode = new TreeSitterLanguageMode({
        grammar: jsGrammar,
        buffer,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.setCursorBufferPosition({
        row: 0,
        column: buffer.getText().indexOf("ef()"),
      });
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("def");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("def()");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("${def()}");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("c${def()}e${f}g");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("<b>c${def()}e${f}g</b>");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("<b>c${def()}e${f}g</b> ");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("` <b>c${def()}e${f}g</b> `");
      editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("html ` <b>c${def()}e${f}g</b> `");
    });
  });

  describe("indentation", () => {
    beforeEach(async () => {
      await lumine.packages.activatePackage("whitespace");
      lumine.config.set("whitespace.removeTrailingWhitespace", false);
    });

    it("interprets @indent and @dedent captures", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "indentsQuery",
        `
        "if" @indent
        "else" @dedent
      `,
      );

      const originalText = "if (foo)";
      buffer.setText(originalText);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.setCursorBufferPosition([0, 8]);
      editor.insertText("\n", { autoIndent: true, autoIndentNewline: true });
      await new Promise(process.nextTick);

      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(1, 2)");

      editor.insertText('console.log("bar");\n', { autoIndent: true, autoIndentNewline: true });

      editor.insertText("else", { autoIndent: true });
      await new Promise(process.nextTick);

      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(2, 4)");

      editor.undo();
      editor.undo();
      editor.undo();

      expect(buffer.getText()).toEqual(originalText);
    });

    it("allows @dedents to cancel out @indents when appropriate", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        "{" @indent
        "}" @dedent
      `,
      );

      buffer.setText("if (foo) { bar(); }");

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      // await wait(0);

      editor.setCursorBufferPosition([0, 19]);
      editor.insertText("\n", { autoIndentNewline: true });
      await wait(0);
      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(1, 0)");

      // a } that comes before a { should not cancel it out.
      buffer.setText("} else if (foo) {");
      editor.setCursorBufferPosition([0, 17]);
      await wait(0);
      editor.insertText("\n", { autoIndent: true, autoIndentNewline: true });
      await wait(0);

      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(1, 2)");
    });

    it("allows @dedent.next to decrease the indent of the next line before any typing takes place", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      // Pretend we're in a universe where lines after comments should be
      // dedented.
      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        (comment) @dedent.next
      `,
      );

      buffer.setText("  // lorem ipsum");

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.setCursorBufferPosition([0, 14]);
      editor.insertText("\n", { autoIndentNewline: true });
      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(1, 0)");
    });

    it("allows @match.next to decrease the indent of the next line before any typing takes place", async () => {
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      // When the comparison row contains the end of a lexical declaration, we
      // want the next line to match the indentation of whichever line _began_
      // that lexical declaration. (But for this test we'll add an offset of 1
      // so we can be sure we're not just defaulting to column 0 for some other
      // reason.)
      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ((lexical_declaration) @match.next
          (#is? indent.matchesComparisonRow endPosition)
          (#set! indent.match startPosition)
          (#set! indent.offset 1)
        )
      `,
      );

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      buffer.setText(dedent`
        let foo = longMethodWithArguments(1, 2, 3, 4, 5,
                    6, 7, 8);
      `);

      await languageMode.atTransactionEnd();

      editor.setCursorBufferPosition([1, 21]);
      editor.insertText("\n", { autoIndentNewline: true });
      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(2, 2)");
    });

    it("resolves @match captures", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        (template_string
          "\`" @match
          (#is? test.last true)
          (#set! indent.matchIndentOf parent.firstChild.startPosition))
      `,
      );

      buffer.setText(dedent`
        \`
                  this is a ridiculous amount of indentation
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.setCursorBufferPosition([1, 52]);
      editor.getLastCursor().moveToEndOfLine();
      editor.insertText("\n", { autoDecreaseIndent: true, autoIndentNewline: true });
      await wait(0);
      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(2, 10)");

      editor.insertText("`", { autoIndent: true, autoDecreaseIndent: true });
      await wait(0);
      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(2, 1)");
    });

    it("prefers a @match capture even if a @dedent matches first", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        (template_string
          "\`" @dedent @match
          (#is? test.last true)
          (#set! indent.match parent.firstChild.startPosition))
      `,
      );

      buffer.setText(dedent`
        \`
                  this is a ridiculous amount of indentation
      `);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.setCursorBufferPosition([1, 52]);
      editor.getLastCursor().moveToEndOfLine();
      editor.insertText("\n", { autoDecreaseIndent: true, autoIndentNewline: true });
      await wait(0);
      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(2, 10)");

      editor.insertText("`", { autoIndent: true, autoDecreaseIndent: true });
      await wait(0);
      expect(editor.getLastCursor().getBufferPosition().toString()).toEqual("(2, 1)");
    });

    it("adjusts correctly when text is pasted", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      expect(editor.getUndoGroupingInterval()).toBe(300);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let textToPaste = `// this is a comment\n// and this is another`;
      buffer.setText(textToPaste);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });

      // Don't rely on this method to give us an accurate answer.
      spyOn(languageMode, "suggestedIndentForLineAtBufferRow").and.returnValue(9);

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.selectAll();
      editor.cutSelectedText();

      let emptyClassText = dedent`
        class Example {

        }
      `;

      buffer.setText(emptyClassText);
      await wait(0);

      editor.setCursorBufferPosition([1, 2]);
      editor.pasteText({ autoIndent: true });
      await wait(0);

      expect(editor.lineTextForBufferRow(1)).toEqual(`  // this is a comment`);

      expect(editor.lineTextForBufferRow(2)).toEqual(`  // and this is another`);

      editor.undo();
      await wait(0);

      expect(editor.getText()).toEqual(emptyClassText);
    });

    it('skips trying to insert at the correct indentation level when "paste without formatting" is invoked', async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      expect(editor.getUndoGroupingInterval()).toBe(300);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let textToPaste = `// this is a comment\n  // and this is another`;
      buffer.setText(textToPaste);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.selectAll();
      editor.cutSelectedText();

      let emptyClassText = dedent`
        class Example {

        }
      `;

      buffer.setText(emptyClassText);
      await wait(0);

      editor.setCursorBufferPosition([1, 0]);
      // These are the same options used by the
      // `editor:paste-without-reformatting` command.
      editor.pasteText({
        normalizeLineEndings: false,
        autoIndent: false,
        preserveTrailingLineIndentation: true,
      });
      await wait(0);

      expect(editor.lineTextForBufferRow(1)).toEqual(`// this is a comment`);

      expect(editor.lineTextForBufferRow(2)).toEqual(`  // and this is another`);

      editor.undo();
      await wait(0);

      expect(editor.getText()).toEqual(emptyClassText);
    });

    it("preserves relative indentation across pasted text", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      expect(editor.getUndoGroupingInterval()).toBe(300);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let textToPaste = `// this is a comment\n  // and this is another`;
      buffer.setText(textToPaste);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.selectAll();
      editor.cutSelectedText();

      let emptyClassText = dedent`
        class Example {

        }
      `;

      buffer.setText(emptyClassText);
      await wait(0);

      editor.setCursorBufferPosition([1, 0]);
      editor.pasteText({ autoIndent: true });
      await wait(0);

      expect(editor.lineTextForBufferRow(1)).toEqual(`  // this is a comment`);

      expect(editor.lineTextForBufferRow(2)).toEqual(`    // and this is another`);

      expect(editor.lineTextForBufferRow(3)).toEqual(`}`);

      editor.undo();
      await wait(0);

      expect(editor.getText()).toEqual(emptyClassText);
    });

    it("preserves relative indentation across pasted text (when the pasted text ends in a newline)", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      expect(editor.getUndoGroupingInterval()).toBe(300);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let textToPaste = `// this is a comment\n  // and this is another\n`;
      buffer.setText(textToPaste);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.selectAll();
      editor.cutSelectedText();

      let emptyClassText = dedent`
        class Example {
        }
      `;

      buffer.setText(emptyClassText);
      await wait(0);

      editor.setCursorBufferPosition([1, 0]);
      editor.pasteText({ autoIndent: true });
      await wait(0);

      expect(editor.lineTextForBufferRow(1)).toEqual(`  // this is a comment`);

      expect(editor.lineTextForBufferRow(2)).toEqual(`    // and this is another`);

      expect(editor.lineTextForBufferRow(3)).toEqual(`}`);

      editor.undo();
      await wait(0);

      expect(editor.getText()).toEqual(emptyClassText);
    });

    it("auto-indents correctly if any change in a transaction wants auto-indentation", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
      editor.updateAutoIndent(true);

      // Pretend we're in a universe where a line comment should cause the next
      // line to be indented, but only in a class body.
      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
        ((comment) @indent
          (#is? test.descendantOfType class_body))
      `,
      );

      let emptyClassText = dedent`
        class Example {

        }
      `;

      buffer.setText(emptyClassText);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      // Force this test to use async indent in all cases.
      languageMode.transactionReparseBudgetMs = 0;
      languageMode.currentTransactionReparseBudgetMs = 0;
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      spyOn(languageMode, "suggestedIndentForBufferRows").and.callThrough();

      editor.setCursorBufferPosition([0, 15]);
      editor.transact(() => {
        // This is a transaction in which each indentation decision is
        // contingent on the previous indentation decisions that have been
        // made. But in async indent mode, we cannot make any indentation
        // suggestions until the end of the transaction.
        //
        // Still, in some scenarios, this will be OK. Either we can make each
        // of these indentation decisions in order once the transaction is
        // done, or we can give up and auto-indent the whole range covered by
        // the transaction when we're done.
        //
        // This is an imperfect heuristic and won't produce good results in
        // many cases, which is why we flip to async indent reluctantly and
        // only in certain scenarios. But it's better than committing to N
        // re-parses (where N equals the number of indentation suggestions
        // we're asked to make during a given transaction) no matter how high N
        // may be. And it's also better than performing no indentation at all
        // in these cases.
        editor.insertNewline();
        editor.insertText("// this is a comment", { autoIndent: true, autoDecreaseIndent: true });
        editor.insertNewline();
        editor.insertText("// and this is another", { autoIndent: true, autoDecreaseIndent: true });
        editor.insertNewline();
      });

      await wait(0);

      expect(languageMode.suggestedIndentForBufferRows).toHaveBeenCalled();

      expect(editor.lineTextForBufferRow(1)).toEqual(`  // this is a comment`);

      expect(editor.lineTextForBufferRow(2)).toEqual(`    // and this is another`);

      editor.undo();
      await wait(0);

      expect(editor.getText()).toEqual(emptyClassText);
    });

    it("does not auto-indent if no change in a transaction wants auto-indentation", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      // Pretend we're in a universe where a line comment should cause the next
      // line to be indented, but only in a class body.
      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
        ((comment) @indent
          (#is? test.descendantOfType class_body))
      `,
      );

      let emptyClassText = dedent`
        class Example {

        }
      `;

      buffer.setText(emptyClassText);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.setCursorBufferPosition([1, 0]);
      editor.transact(() => {
        editor.insertText("// this is a comment", { autoIndent: false });
        editor.insertNewline();
        editor.insertText("// and this is another", { autoIndent: false });
        editor.insertNewline();
      });
      await wait(0);

      expect(editor.lineTextForBufferRow(1)).toEqual(`// this is a comment`);

      expect(editor.lineTextForBufferRow(2)).toEqual(`// and this is another`);

      editor.undo();
      await wait(0);

      expect(editor.getText()).toEqual(emptyClassText);
    });

    it("auto-dedents exactly once and not after each new insertion on a line", async () => {
      jasmine.useRealClock();
      editor.updateAutoIndent(true);
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);
      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let emptyClassText = dedent`
        class Example {
          if (foo) {

        }
      `;

      buffer.setText(emptyClassText);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);
      editor.setCursorBufferPosition([2, 0]);
      editor.insertText("    ");
      await wait(0);
      editor.insertText("}", { autoIndent: true });

      await languageMode.atTransactionEnd();
      await wait(0);
      expect(editor.lineTextForBufferRow(2)).toEqual(`  }`);

      editor.indentSelectedRows();
      editor.insertText(" ", { autoIndent: true });
      await languageMode.atTransactionEnd();
      expect(editor.lineTextForBufferRow(2)).toEqual(`    } `);
    });

    it("maintains indent level through multiple newlines (removeTrailingWhitespace: true)", async () => {
      jasmine.useRealClock();
      editor.updateAutoIndent(true);
      lumine.config.set("whitespace.removeTrailingWhitespace", true);
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let emptyClassText = dedent`
          class Example {

          }
        `;

      buffer.setText(emptyClassText);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.setCursorBufferPosition([1, 0]);
      editor.indent();
      await languageMode.atTransactionEnd();
      editor.insertText("// this is a comment", { autoIndent: true });
      await languageMode.atTransactionEnd();
      expect(editor.lineTextForBufferRow(1)).toEqual("  // this is a comment");

      editor.insertNewline();
      await languageMode.atTransactionEnd();
      await wait(0);
      expect(editor.lineTextForBufferRow(2)).toEqual("  ");

      editor.insertNewline();
      await languageMode.atTransactionEnd();
      await wait(0);
      expect(editor.lineTextForBufferRow(3)).toEqual("  ");

      editor.insertNewline();
      await languageMode.atTransactionEnd();
      await wait(0);
      expect(editor.lineTextForBufferRow(4)).toEqual("  ");
    });

    it("does not attempt to adjust indent on pasted text without a newline", async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      expect(editor.getUndoGroupingInterval()).toBe(300);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let textToPaste = `a comment`;
      buffer.setText(textToPaste);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });

      buffer.setLanguageMode(languageMode);
      await languageMode.ready;
      await wait(0);

      editor.selectAll();
      editor.cutSelectedText();

      let emptyClassText = dedent`
        class Example {
              // this is…
        }
      `;

      buffer.setText(emptyClassText);
      await wait(0);

      editor.setCursorBufferPosition([1, 18]);
      editor.pasteText({ autoIndent: true });
      await wait(0);

      expect(editor.lineTextForBufferRow(1)).toEqual(`      // this is…a comment`);

      editor.undo();
      await wait(0);

      expect(editor.getText()).toEqual(emptyClassText);
    });

    it("maintains indent level through multiple newlines (removeTrailingWhitespace: false)", async () => {
      jasmine.useRealClock();
      editor.updateAutoIndent(true);
      lumine.config.set("whitespace.removeTrailingWhitespace", false);
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      let emptyClassText = dedent`
      class Example {

      }
      `;

      buffer.setText(emptyClassText);

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      editor.setCursorBufferPosition([1, 0]);
      editor.indent();
      await languageMode.atTransactionEnd();
      editor.insertText("// this is a comment", { autoIndent: true });
      await languageMode.atTransactionEnd();
      expect(editor.lineTextForBufferRow(1)).toEqual("  // this is a comment");

      editor.insertNewline();
      await languageMode.atTransactionEnd();
      await wait(0);
      expect(editor.lineTextForBufferRow(2)).toEqual("  ");

      editor.insertNewline();
      await languageMode.atTransactionEnd();
      await wait(0);
      expect(editor.lineTextForBufferRow(3)).toEqual("  ");

      editor.insertNewline();
      await languageMode.atTransactionEnd();
      await wait(0);
      expect(editor.lineTextForBufferRow(4)).toEqual("  ");
    });

    it(`can indent properly in a multi-cursor environment without auto-indenting large ranges of the buffer`, async () => {
      jasmine.useRealClock();
      const grammar = new TreeSitterGrammar(lumine.grammars, jsGrammarPath, jsConfig);

      expect(editor.getUndoGroupingInterval()).toBe(300);

      await grammar.setQueryForTest(
        "indentsQuery",
        scm`
        ["{"] @indent
        ["}"] @dedent
      `,
      );

      const languageMode = new TreeSitterLanguageMode({ grammar, buffer });
      // Force this test to use async indent in all cases.
      languageMode.transactionReparseBudgetMs = 0;
      languageMode.currentTransactionReparseBudgetMs = 0;
      spyOn(languageMode, "suggestedIndentForBufferRows").and.callThrough();
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      // No spaces after the `{`s in these examples so that we can more easily
      // compare expected output to actual output.
      buffer.setText(dedent`
        function test () {return }

        function test () {return }

        function test () {return }
      `);

      expect(languageMode.suggestedIndentForBufferRows).not.toHaveBeenCalled();

      editor.setCursorBufferPosition([0, 18]);
      editor.addCursorAtBufferPosition([2, 18]);
      editor.addCursorAtBufferPosition([4, 18]);

      editor.insertNewline({
        autoIndent: true,
        autoIndentNewline: true,
        autoDecreaseIndent: true,
      });

      await wait(0);

      expect(buffer.getText()).toBe(dedent`
        function test () {
          return }

        function test () {
          return }

        function test () {
          return }
      `);
    });
  });
});

function getDisplayText(editor) {
  return editor.displayLayer.getText();
}

function expectTokensToEqual(editor, expectedTokenLines) {
  const lastRow = editor.getLastScreenRow();

  let languageMode = editor.getBuffer().getLanguageMode();
  let layers = languageMode.getAllLanguageLayers();
  let baseScopeClasses = new Set();

  // Ignore the base scope applied within each language layer.
  for (let layer of layers) {
    let grammar = layer.grammar;
    if (!grammar) {
      continue;
    }
    let scopeClass = layer.grammar.scopeName
      .split(".")
      .map((p) => `syntax--${p}`)
      .join(" ");
    baseScopeClasses.add(scopeClass);
  }

  // Assert that the correct tokens are returned regardless of which row
  // the highlighting iterator starts on.
  for (let startRow = 0; startRow <= lastRow; startRow++) {
    // Clear the screen line cache between iterations, but not on the first
    // iteration, so that the first iteration tests that the cache has been
    // correctly invalidated by any changes.
    if (startRow > 0) {
      editor.displayLayer.clearSpatialIndex();
    }

    editor.displayLayer.getScreenLines(startRow, Infinity);

    const tokenLines = [];
    for (let row = startRow; row <= lastRow; row++) {
      let lineTokens = editor.tokensForScreenRow(row);
      let result = [];

      for (let token of lineTokens) {
        let { text, scopes: rawScopes } = token;
        let scopes = [];
        for (let scope of rawScopes) {
          if (baseScopeClasses.has(scope)) {
            continue;
          }
          scopes.push(
            scope
              .split(" ")
              .map((c) => c.replace("syntax--", ""))
              .join(" "),
          );
        }
        result.push({ text, scopes });
      }
      tokenLines[row] = result;
    }

    // console.log('EXPECTED:', expectedTokenLines);
    // console.log('ACTUAL:', tokenLines);

    for (let row = startRow; row <= lastRow; row++) {
      const tokenLine = tokenLines[row];
      const expectedTokenLine = expectedTokenLines[row];

      for (let i = 0; i < tokenLine.length; i++) {
        expect(tokenLine[i]).toEqual(
          expectedTokenLine[i],
          `Token ${i}, row: ${row}, startRow: ${startRow}`,
        );
      }
    }
  }

  // Fully populate the screen line cache again so that cache invalidation
  // due to subsequent edits can be tested.
  editor.displayLayer.getScreenLines(0, Infinity);
}

const HTML_INNERHTML_ASSIGNMENT_INJECTION_POINT = {
  type: "assignment_expression",

  language(callExpression) {
    const { firstChild } = callExpression;
    if (firstChild.type === "member_expression") {
      if (firstChild.lastChild.text === "innerHTML") {
        return "html";
      }
    }
  },

  content(callExpression) {
    const { lastChild } = callExpression;
    if (lastChild.type === "template_string") {
      return stringFragmentsOfTemplateString(lastChild);
    }
  },
};

const HTML_TEMPLATE_LITERAL_INJECTION_POINT = {
  type: "call_expression",
  language(node) {
    if (node.lastChild?.type === "template_string" && node.firstChild?.type === "identifier") {
      return node.firstChild?.text;
    }
  },
  content(node) {
    return stringFragmentsOfTemplateString(node.lastChild);
  },
};

const SCRIPT_TAG_INJECTION_POINT = {
  type: "script_element",
  language() {
    return "javascript";
  },
  content(node) {
    return node?.child(1);
  },
};

const JSDOC_INJECTION_POINT = {
  type: "comment",
  language(comment) {
    if (comment.text?.startsWith("/**")) return "jsdoc";
  },
  content(comment) {
    return comment;
  },
};

function stringFragmentsOfTemplateString(templateStringNode) {
  return templateStringNode.children.filter((c) => c.type === "string_fragment");
}
