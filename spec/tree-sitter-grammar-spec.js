const fs = require("fs");
const os = require("os");
const path = require("path");
const CSON = require("@lumine-code/season");
const { Language: WebLanguage } = require("web-tree-sitter");
const { Disposable } = require("@lumine-code/event-kit");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

// Language packages live in their own repositories and arrive through
// node_modules, so resolve by name rather than by a path into packages/.
const jsGrammarPath = require.resolve("language-javascript/grammars/javascript.json");

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
    return new TreeSitterGrammar(lumine.grammars, path.join(tempDir, "grammar.json"), {
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

  describe("WASM runtime", () => {
    it("finishes subscriptions and query cleanup when a removal observer throws", async () => {
      const queryPath = writeQueryFile("highlights.scm", "(identifier) @variable");
      const grammar = makeGrammar({ highlightsQuery: path.basename(queryPath) });
      grammar.activate();
      const query = await grammar.getQuery("highlightsQuery");
      const internalQuery = grammar._getOrCreateInternalQuerySync("(identifier) @internal");
      const queryDeleted = spyOn(query, "delete").and.callThrough();
      const internalDeleted = spyOn(internalQuery, "delete").and.callThrough();
      const subscriptions = grammar.subscriptions;
      const subscriptionCleanup = jasmine.createSpy("subscriptionCleanup");
      subscriptions.add(new Disposable(subscriptionCleanup));
      const generation = grammar.queryLoadGeneration;
      const primary = new Error("Grammar removal observer failed");
      const observer = lumine.grammars.onDidRemoveGrammar((removed) => {
        if (removed !== grammar) return;
        expect(grammar.registration).toBeNull();
        expect(grammar.subscriptions).toBeNull();
        expect(grammar.queryLoadGeneration).toBe(generation + 1);
        expect(grammar.queryCache.size).toBe(0);
        expect(grammar.internalQueryCache.size).toBe(0);
        throw primary;
      });

      let failure;
      try {
        grammar.deactivate();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBe(primary);
      expect(subscriptionCleanup).toHaveBeenCalledTimes(1);
      expect(subscriptions.disposed).toBe(true);
      expect(queryDeleted).toHaveBeenCalledTimes(1);
      expect(internalDeleted).toHaveBeenCalledTimes(1);
      expect(grammar.queryReferenceCounts.size).toBe(0);
      expect(grammar.getLanguageSync()).toBeNull();
      expect(lumine.grammars.grammarForId(grammar.scopeName)).toBeUndefined();
      observer.dispose();
      expect(() => grammar.deactivate()).not.toThrow();
    });

    it("keeps cleanup errors in order and attempts later query deletion", async () => {
      const grammar = makeGrammar();
      grammar.activate();
      await grammar.getLanguage();
      const first = grammar._getOrCreateInternalQuerySync("(identifier) @first");
      const later = grammar._getOrCreateInternalQuerySync("(identifier) @later");
      const primary = new Error("Grammar removal observer failed");
      const subscriptionError = new Error("Grammar subscription cleanup failed");
      const queryError = new Error("Grammar query cleanup failed");
      const originalDelete = first.delete.bind(first);
      spyOn(first, "delete").and.callFake(() => {
        originalDelete();
        throw queryError;
      });
      const laterDeleted = spyOn(later, "delete").and.callThrough();
      grammar.subscriptions.add(
        new Disposable(() => {
          throw subscriptionError;
        }),
      );
      const observer = lumine.grammars.onDidRemoveGrammar((removed) => {
        if (removed === grammar) throw primary;
      });

      let failure;
      try {
        grammar.deactivate();
      } catch (error) {
        failure = error;
      }

      expect(failure.errors).toEqual([primary, subscriptionError, queryError]);
      expect(failure.cause).toBe(primary);
      expect(laterDeleted).toHaveBeenCalledTimes(1);
      expect(grammar.internalQueryCache.size).toBe(0);
      expect(grammar.subscriptions).toBeNull();
      observer.dispose();
      expect(() => grammar.deactivate()).not.toThrow();
    });

    it("preserves a reentrant activation and its subscriptions during old teardown", async () => {
      const grammar = makeGrammar();
      grammar.activate();
      await grammar.getLanguage();
      const oldQuery = grammar._getOrCreateInternalQuerySync("(identifier) @old");
      const oldDeleted = spyOn(oldQuery, "delete").and.callThrough();
      const oldSubscriptions = grammar.subscriptions;
      const oldCleanup = jasmine.createSpy("oldCleanup");
      const currentCleanup = jasmine.createSpy("currentCleanup");
      oldSubscriptions.add(new Disposable(oldCleanup));
      const primary = new Error("Old grammar removal observer failed");
      const observer = lumine.grammars.onDidRemoveGrammar((removed) => {
        if (removed !== grammar) return;
        grammar.activate();
        grammar.subscriptions.add(new Disposable(currentCleanup));
        throw primary;
      });

      let failure;
      try {
        grammar.deactivate();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBe(primary);
      expect(lumine.grammars.grammarForId(grammar.scopeName)).toBe(grammar);
      expect(grammar.registration).not.toBeNull();
      expect(grammar.subscriptions).not.toBe(oldSubscriptions);
      expect(grammar.subscriptions.disposed).toBe(false);
      expect(oldCleanup).toHaveBeenCalledTimes(1);
      expect(currentCleanup).not.toHaveBeenCalled();
      expect(oldDeleted).toHaveBeenCalledTimes(1);
      await grammar.getLanguage();
      const current = grammar._getOrCreateInternalQuerySync("(identifier) @current");
      const currentDeleted = spyOn(current, "delete").and.callThrough();

      observer.dispose();
      grammar.deactivate();
      expect(currentCleanup).toHaveBeenCalledTimes(1);
      expect(currentDeleted).toHaveBeenCalledTimes(1);
      expect(lumine.grammars.grammarForId(grammar.scopeName)).toBeUndefined();
    });

    it("requires a grammar asset path", () => {
      expect(() => makeGrammar({ grammar: undefined })).toThrowError(/treeSitter.grammar/);
    });

    it("keeps a registered grammar lazy until its language is requested", async () => {
      const load = spyOn(WebLanguage, "load").and.callThrough();
      const grammar = makeGrammar();

      await Promise.resolve();
      expect(load).not.toHaveBeenCalled();

      await grammar.getLanguage();
      expect(load).toHaveBeenCalledTimes(1);
      grammar.deactivate();
    });

    it("shares one in-flight language load between grammars using the same Wasm", async () => {
      const originalLoad = WebLanguage.load;
      const load = spyOn(WebLanguage, "load").and.callFake(async (input) => {
        await wait(10);
        return originalLoad(input);
      });
      const first = makeGrammar();
      const second = makeGrammar();

      await Promise.all([first.getLanguage(), second.getLanguage()]);

      expect(load).toHaveBeenCalledTimes(1);
    });

    it("does not revive a grammar disabled during its language load", async () => {
      let resolveLanguage;
      const pending = new Promise((resolve) => (resolveLanguage = resolve));
      const load = spyOn(TreeSitterGrammar, "loadLanguage").and.returnValue(pending);
      const grammar = makeGrammar({ highlightsQuery: "unused.scm" });
      const queries = spyOn(grammar, "loadQueryFiles").and.callThrough();
      const loading = grammar.getLanguage();
      const rejected = expectAsync(loading).toBeRejectedWithError(/invalidated/);
      await conditionPromise(() => load.calls.any());

      grammar.deactivate();
      resolveLanguage({});
      await rejected;

      expect(grammar.getLanguageSync()).toBeNull();
      expect(queries).not.toHaveBeenCalled();
      expect(grammar.subscriptions).toBeNull();
    });

    it("keeps a reactivated grammar when an old query-file read finishes", async () => {
      const queryPath = writeQueryFile("highlights.scm", "(identifier) @current");
      const originalRead = fs.promises.readFile;
      let resolveOldRead;
      const oldRead = new Promise((resolve) => (resolveOldRead = resolve));
      let reads = 0;
      spyOn(fs.promises, "readFile").and.callFake((file, ...args) => {
        if (file === queryPath && reads++ === 0) return oldRead;
        return originalRead.call(fs.promises, file, ...args);
      });
      const grammar = makeGrammar({ highlightsQuery: "highlights.scm" });
      grammar.activate();
      const loaded = spyOn(grammar.emitter, "emit").and.callThrough();
      const loading = grammar.getLanguage();
      const rejected = expectAsync(loading).toBeRejectedWithError(/invalidated/);
      await conditionPromise(() => reads === 1);

      grammar.deactivate();
      grammar.activate();
      const currentLanguage = await grammar.getLanguage();
      resolveOldRead("(identifier) @discarded");
      await rejected;

      expect(grammar.getLanguageSync()).toBe(currentLanguage);
      expect(grammar.highlightsQuery).toContain("@current");
      expect(grammar.highlightsQuery).not.toContain("@discarded");
      expect(
        loaded.calls.allArgs().filter(([name]) => name === "did-load-query-files").length,
      ).toBe(1);
      grammar.deactivate();
    });

    it("invalidates a pending query-file read even when the removal observer throws", async () => {
      const queryPath = writeQueryFile("highlights.scm", "(identifier) @current");
      const originalRead = fs.promises.readFile;
      let resolveOldRead;
      const oldRead = new Promise((resolve) => (resolveOldRead = resolve));
      let reads = 0;
      spyOn(fs.promises, "readFile").and.callFake((file, ...args) => {
        if (file === queryPath && reads++ === 0) return oldRead;
        return originalRead.call(fs.promises, file, ...args);
      });
      const grammar = makeGrammar({ highlightsQuery: "highlights.scm" });
      grammar.activate();
      const loading = grammar.getLanguage();
      const rejected = expectAsync(loading).toBeRejectedWithError(/invalidated/);
      await conditionPromise(() => reads === 1);
      const primary = new Error("Pending grammar removal observer failed");
      const observer = lumine.grammars.onDidRemoveGrammar((removed) => {
        if (removed === grammar) throw primary;
      });

      let failure;
      try {
        grammar.deactivate();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(primary);
      observer.dispose();
      grammar.activate();
      const currentLanguage = await grammar.getLanguage();
      resolveOldRead("(identifier) @discarded");
      await rejected;

      expect(grammar.getLanguageSync()).toBe(currentLanguage);
      expect(grammar.highlightsQuery).toContain("@current");
      expect(grammar.highlightsQuery).not.toContain("@discarded");
      expect(grammar.subscriptions.disposed).toBe(false);
      grammar.deactivate();
    });

    it("rejects a missing query file and allows the load to be retried", async () => {
      const grammar = makeGrammar({ highlightsQuery: "missing.scm" });

      await expectAsync(grammar.getLanguage()).toBeRejectedWithError(/ENOENT/);

      writeQueryFile("missing.scm", "(identifier) @variable");
      await expectAsync(grammar.getLanguage()).toBeResolved();
      await expectAsync(grammar.getQuery("highlightsQuery")).toBeResolved();

      grammar.deactivate();
    });

    it("shares internal queries and deletes them when the grammar deactivates", async () => {
      const grammar = makeGrammar();
      await grammar.getLanguage();
      const query = { delete: jasmine.createSpy("delete") };
      spyOn(grammar, "createQuerySync").and.returnValue(query);

      expect(grammar._getOrCreateInternalQuerySync("(identifier) @candidate")).toBe(query);
      expect(grammar._getOrCreateInternalQuerySync("(identifier) @candidate")).toBe(query);
      expect(grammar.createQuerySync).toHaveBeenCalledTimes(1);

      grammar.deactivate();

      expect(query.delete).toHaveBeenCalledTimes(1);
      expect(grammar.internalQueryCache.size).toBe(0);
    });

    it("re-reads query files after the same grammar object is reactivated", async () => {
      const queryPath = writeQueryFile("highlights.scm", "(identifier) @variable");
      const grammar = makeGrammar({ highlightsQuery: path.basename(queryPath) });
      grammar.activate();
      await grammar.getLanguage();
      const firstSubscriptions = grammar.subscriptions;
      expect(grammar.highlightsQuery).toContain("@variable");

      grammar.deactivate();
      fs.writeFileSync(queryPath, "(identifier) @constant");
      grammar.activate();
      await grammar.getLanguage();

      expect(grammar.subscriptions).not.toBe(firstSubscriptions);
      expect(grammar.highlightsQuery).toContain("@constant");
      grammar.deactivate();
    });
  });

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

      let editor = await lumine.workspace.open("");
      let buffer = editor.getBuffer();
      let languageMode = new TreeSitterLanguageMode({ buffer, grammar });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      spyOn(lumine.notifications, "addSuccess");
      spyOn(lumine.notifications, "addError");

      expect(languageMode.validateGrammarQueries()).toEqual([]);
      expect(lumine.notifications.addSuccess).toHaveBeenCalled();
      expect(lumine.notifications.addError).not.toHaveBeenCalled();

      // Simulate a query source that broke after initial load; validation
      // compiles from the current source, not from the query cache.
      grammar.highlightsQuery = "(bad_node_name) @x";
      let failures = languageMode.validateGrammarQueries();
      expect(failures.length).toBe(1);
      expect(failures[0].queryType).toBe("highlightsQuery");
      expect(failures[0].word).toBe("bad_node_name");
      expect(lumine.notifications.addError).toHaveBeenCalled();

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

      let editor = await lumine.workspace.open("");
      let buffer = editor.getBuffer();
      buffer.setText("function f() { return 1; }\n");
      let languageMode = new TreeSitterLanguageMode({ buffer, grammar });
      buffer.setLanguageMode(languageMode);
      await languageMode.ready;

      // Folding and indentation are prepared after first highlighting, or
      // immediately when requested. Exercise their independent failure paths.
      let layer = languageMode.rootLanguageLayer;
      await Promise.all([layer.ensureQuery("foldsQuery"), layer.ensureQuery("indentsQuery")]);

      // Both failures were reported — not just the first.
      let reportedTypes = grammar.reportQueryError.calls
        .allArgs()
        .map(([, queryType]) => queryType)
        .sort();
      expect(reportedTypes).toEqual(["foldsQuery", "highlightsQuery"]);

      // The layer still activated, recovered highlighting with a placeholder,
      // and compiled the valid indents query.
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
