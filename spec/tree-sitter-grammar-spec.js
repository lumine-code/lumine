const fs = require("fs");
const os = require("os");
const path = require("path");
const CSON = require("@lumine-code/season");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

// Language packages live in their own repositories and arrive through
// node_modules, so resolve by name rather than by a path into packages/.
const jsGrammarPath = require.resolve("language-javascript/grammars/tree-sitter-javascript.json");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function conditionPromise(predicate, timeoutMs = 4000) {
  let start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await wait(10);
  }
}

describe("TreeSitterGrammar", () => {
  let tempDir, wasmPath;

  beforeEach(() => {
    jasmine.useRealClock();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-grammar-spec-"));
    // Copy the real JavaScript grammar wasm beside the temp query files. A
    // copy (rather than a relative path to the original) keeps the config
    // valid even when the temp dir sits on a different drive than the repo.
    let jsConfig = CSON.readFileSync(jsGrammarPath);
    let originalWasm = path.join(path.dirname(jsGrammarPath), jsConfig.treeSitter.grammar);
    wasmPath = path.join(tempDir, "grammar.wasm");
    fs.copyFileSync(originalWasm, wasmPath);
  });

  afterEach(() => {
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function writeQueryFile(name, contents) {
    let filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  function makeGrammar(treeSitterOverrides = {}) {
    return new TreeSitterGrammar(atom.grammars, path.join(tempDir, "grammar.json"), {
      name: "Test JavaScript",
      scopeName: "source.test-js",
      type: "tree-sitter",
      parser: "tree-sitter-javascript",
      treeSitter: {
        grammar: "grammar.wasm",
        ...treeSitterOverrides,
      },
    });
  }

  describe("query error descriptors", () => {
    it("maps an unknown node type to the offending file and line in a multi-file query", async () => {
      writeQueryFile("first.scm", "; first file\n(identifier) @variable\n");
      writeQueryFile(
        "second.scm",
        "; second file\n(identifier) @constant\n(bogus_node_type) @oops\n",
      );
      let grammar = makeGrammar({ highlightsQuery: ["first.scm", "second.scm"] });

      let error = null;
      try {
        await grammar.getQuery("highlightsQuery");
      } catch (err) {
        error = err;
      }

      expect(error).not.toBe(null);
      // The original error object is rethrown, not wrapped.
      expect(error.name).toBe("QueryError");
      let descriptor = error.queryDescriptor;
      expect(descriptor).toBeDefined();
      expect(descriptor.scopeName).toBe("source.test-js");
      expect(descriptor.queryType).toBe("highlightsQuery");
      expect(path.basename(descriptor.filePath)).toBe("second.scm");
      expect(descriptor.line).toBe(3);
      expect(descriptor.kindLabel).toBe("unknown node type");
      expect(descriptor.word).toBe("bogus_node_type");
      expect(descriptor.lineText).toContain("bogus_node_type");

      let formatted = TreeSitterGrammar.formatQueryErrorDescriptor(descriptor);
      expect(formatted).toContain("second.scm:3");
      expect(formatted).toContain("unknown node type: 'bogus_node_type'");
    });

    it("reports exact line numbers in files that use ._LANG_ substitution", async () => {
      writeQueryFile(
        "langy.scm",
        "((identifier) @variable._LANG_)\n((identifier) @support._LANG_)\n(not_a_node) @bad\n",
      );
      let grammar = makeGrammar({
        highlightsQuery: "langy.scm",
        languageSegment: "js",
      });

      let error = null;
      try {
        await grammar.getQuery("highlightsQuery");
      } catch (err) {
        error = err;
      }

      expect(error).not.toBe(null);
      expect(error.queryDescriptor.line).toBe(3);
      expect(error.queryDescriptor.word).toBe("not_a_node");
      expect(path.basename(error.queryDescriptor.filePath)).toBe("langy.scm");
    });

    it("describes predicate errors without offsets by listing candidate files", async () => {
      writeQueryFile("predicate.scm", '((identifier) @v\n  (#match? @v "(?"))\n');
      let grammar = makeGrammar({ highlightsQuery: "predicate.scm" });

      let error = null;
      try {
        await grammar.getQuery("highlightsQuery");
      } catch (err) {
        error = err;
      }

      expect(error).not.toBe(null);
      let descriptor = error.queryDescriptor;
      expect(descriptor).toBeDefined();
      expect(descriptor.filePath).toBe(null);
      expect(descriptor.candidateFiles.length).toBe(1);
      expect(path.basename(descriptor.candidateFiles[0])).toBe("predicate.scm");
      expect(descriptor.message).toBeTruthy();

      let formatted = TreeSitterGrammar.formatQueryErrorDescriptor(descriptor);
      expect(formatted).toContain("predicate.scm");
      expect(formatted).toContain(descriptor.message);
    });

    it("attaches descriptors on the synchronous compilation path too", async () => {
      writeQueryFile("sync.scm", "(mystery_node) @x\n");
      let grammar = makeGrammar({ highlightsQuery: "sync.scm" });
      await grammar.getLanguage();

      let error = null;
      try {
        grammar.getQuerySync("highlightsQuery");
      } catch (err) {
        error = err;
      }

      expect(error).not.toBe(null);
      expect(error.name).toBe("QueryError");
      expect(error.queryDescriptor.word).toBe("mystery_node");
      expect(path.basename(error.queryDescriptor.filePath)).toBe("sync.scm");
    });
  });

  describe("reportQueryError", () => {
    it("reports a given error once, and re-arms when the query source changes", async () => {
      spyOn(console, "error");
      writeQueryFile("broken.scm", "(never_heard_of_it) @x\n");
      let grammar = makeGrammar({ highlightsQuery: "broken.scm" });

      let error = null;
      try {
        await grammar.getQuery("highlightsQuery");
      } catch (err) {
        error = err;
      }

      grammar.reportQueryError(error, "highlightsQuery");
      grammar.reportQueryError(error, "highlightsQuery");
      expect(console.error.calls.count()).toBe(1);

      // A change to the query source re-arms reporting for that query type.
      writeQueryFile("broken.scm", "; different now\n(never_heard_of_it) @x\n");
      await grammar.loadQueryFile([path.join(tempDir, "broken.scm")], "highlightsQuery");
      grammar.reportQueryError(error, "highlightsQuery");
      expect(console.error.calls.count()).toBe(2);
    });
  });

  describe("validateGrammarQueries", () => {
    it("recompiles queries freshly and reports failures per query type", async () => {
      writeQueryFile("ok.scm", "(identifier) @variable\n");
      let grammar = makeGrammar({ highlightsQuery: "ok.scm" });

      let editor = await atom.workspace.open("");
      let buffer = editor.getBuffer();
      let languageMode = new TreeSitterLanguageMode({ buffer, grammar });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      spyOn(atom.notifications, "addSuccess");
      spyOn(atom.notifications, "addError");

      expect(languageMode.validateGrammarQueries()).toEqual([]);
      expect(atom.notifications.addSuccess).toHaveBeenCalled();
      expect(atom.notifications.addError).not.toHaveBeenCalled();

      // Simulate a query source that broke after initial load; validation
      // compiles from the current source, not from the query cache.
      grammar.highlightsQuery = "(bad_node_name) @x";
      let failures = languageMode.validateGrammarQueries();
      expect(failures.length).toBe(1);
      expect(failures[0].queryType).toBe("highlightsQuery");
      expect(failures[0].word).toBe("bad_node_name");
      expect(atom.notifications.addError).toHaveBeenCalled();

      languageMode.destroy();
    });
  });

  describe("language layer degradation", () => {
    it("reports every broken query, still activates, and keeps working queries", async () => {
      spyOn(console, "error");
      writeQueryFile("broken-highlights.scm", "(no_such_node) @variable\n");
      writeQueryFile("broken-folds.scm", "(also_missing) @fold\n");
      writeQueryFile("good-indents.scm", '("{" @indent)\n("}" @dedent)\n');
      let grammar = makeGrammar({
        highlightsQuery: "broken-highlights.scm",
        foldsQuery: "broken-folds.scm",
        indentsQuery: "good-indents.scm",
      });
      spyOn(grammar, "reportQueryError").and.callThrough();

      let editor = await atom.workspace.open("");
      let buffer = editor.getBuffer();
      buffer.setText("function f() { return 1; }\n");
      let languageMode = new TreeSitterLanguageMode({ buffer, grammar });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      // Both failures were reported — not just the first.
      let reportedTypes = grammar.reportQueryError.calls
        .allArgs()
        .map(([, queryType]) => queryType)
        .sort();
      expect(reportedTypes).toEqual(["foldsQuery", "highlightsQuery"]);

      // The layer still activated, recovered highlighting with a placeholder,
      // and compiled the valid indents query.
      let layer = languageMode.rootLanguageLayer;
      expect(layer.ready).toBe(true);
      await conditionPromise(() => grammar.highlightsQuery === "; (placeholder)");
      expect(layer.queries.indentsQuery).toBeTruthy();
      expect(layer.queries.foldsQuery).toBeUndefined();

      // Parsing itself is unaffected.
      expect(languageMode.tree).toBeTruthy();
      expect(languageMode.tree.rootNode.hasError).toBe(false);

      languageMode.destroy();
    });
  });
});
