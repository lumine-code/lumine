const fs = require("fs");
const os = require("os");
const path = require("path");
const { Disposable } = require("@lumine-code/event-kit");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("TreeSitterGrammar lazy query lifecycle", () => {
  let directory;
  let grammar;
  let changed;

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-lazy-query-"));
    const handle = {
      ready: new Promise(() => {}),
      dispose() {},
      onDidChange(callback) {
        changed = callback;
        return new Disposable();
      },
      onDidInvalidate() {
        return new Disposable();
      },
      onDidError() {
        return new Disposable();
      },
    };
    grammar = new TreeSitterGrammar(
      { fileWatchClient: { watchFile: () => handle } },
      path.join(directory, "grammar.json"),
      { name: "Lazy Test", scopeName: "source.lazy-test", treeSitter: { grammar: "unused.wasm" } },
    );
    spyOn(grammar, "getLanguage").and.returnValue(Promise.resolve({}));
    spyOn(grammar, "_createQuery").and.callFake(() => ({ delete: jasmine.createSpy("delete") }));
  });

  afterEach(() => {
    grammar.deactivate();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function watch(queryType, initial = "(identifier) @old") {
    const file = path.join(directory, "query.scm");
    fs.writeFileSync(file, initial);
    grammar[queryType] = initial;
    grammar.observeQueryFile([file], queryType);
    return file;
  }

  function nextChange() {
    return new Promise((resolve) => {
      const subscription = grammar.onDidChangeQuery((event) => {
        subscription.dispose();
        resolve(event);
      });
    });
  }

  it("loads changed cold tags and locals source without compiling it", async () => {
    for (const queryType of ["tagsQuery", "localsQuery"]) {
      const file = watch(queryType);
      fs.writeFileSync(file, "(identifier) @new");
      const event = nextChange();
      changed();
      expect((await event).queryType).toBe(queryType);
      expect(grammar[queryType]).toContain("@new");
      expect(grammar._createQuery).not.toHaveBeenCalled();
      expect(grammar.queryCache.has(queryType)).toBe(false);
    }
  });

  it("continues validating changed requested optional queries", async () => {
    const file = watch("tagsQuery");
    const original = await grammar.getQuery("tagsQuery");
    fs.writeFileSync(file, "(identifier) @new");
    const event = nextChange();
    changed();
    await event;
    expect(grammar._createQuery).toHaveBeenCalledTimes(2);
    expect(grammar.queryCache.get("tagsQuery")).not.toBe(original);
    expect(original.delete).toHaveBeenCalledTimes(1);
  });

  it("treats an explicit synchronous optional query as requested", async () => {
    spyOn(grammar, "getLanguageSync").and.returnValue({});
    const file = watch("localsQuery");
    const original = grammar.getQuerySync("localsQuery");
    fs.writeFileSync(file, "(identifier) @new");
    const event = nextChange();
    changed();
    await event;
    expect(grammar._createQuery).toHaveBeenCalledTimes(2);
    expect(grammar.queryCache.get("localsQuery")).not.toBe(original);
    expect(original.delete).toHaveBeenCalledTimes(1);
  });

  it("preserves eager validation for mandatory query files", async () => {
    const file = watch("highlightsQuery");
    fs.writeFileSync(file, "(identifier) @new");
    const event = nextChange();
    changed();
    await event;
    expect(grammar._createQuery).toHaveBeenCalledTimes(1);
    expect(grammar.queryCache.has("highlightsQuery")).toBe(true);
  });

  function syntaxFailure(source) {
    const error = new Error("Unknown node type");
    Object.assign(error, {
      name: "QueryError",
      kind: 2,
      index: source.indexOf("unknown_node"),
      info: { word: "unknown_node" },
    });
    return error;
  }

  it("maps an unrequested optional error when the query is first requested", async () => {
    const file = watch("tagsQuery");
    grammar._createQuery.and.callFake((_language, source) => {
      throw syntaxFailure(source);
    });
    fs.writeFileSync(file, "; changed header\n(unknown_node) @name\n");
    const event = nextChange();
    changed();
    await event;
    expect(grammar._createQuery).not.toHaveBeenCalled();
    let error;
    try {
      await grammar.getQuery("tagsQuery");
    } catch (rejected) {
      error = rejected;
    }
    expect(error.queryDescriptor.filePath).toBe(file);
    expect(error.queryDescriptor.line).toBe(2);
    expect(error.queryDescriptor.word).toBe("unknown_node");
  });

  it("restores the previous source map after a requested query fails validation", async () => {
    const initial = "(identifier) @old";
    const file = watch("tagsQuery", initial);
    const previousMap = [{ filePath: file, start: 0, end: initial.length }];
    grammar.querySourceMaps.set("tagsQuery", previousMap);
    await grammar.getQuery("tagsQuery");
    const reported = deferred();
    spyOn(grammar, "reportQueryError").and.callFake((error) => reported.resolve(error));
    grammar._createQuery.and.callFake((_language, source) => {
      throw syntaxFailure(source);
    });
    fs.writeFileSync(file, "; changed header\n(unknown_node) @name\n");
    changed();
    const error = await reported.promise;
    expect(error.queryDescriptor.filePath).toBe(file);
    expect(error.queryDescriptor.line).toBe(2);
    expect(grammar.tagsQuery).toBe(initial);
    expect(grammar.querySourceMaps.get("tagsQuery")).toBe(previousMap);
  });

  it("rejects an invalidated pending load without resurrecting the cache", async () => {
    const language = deferred();
    grammar.getLanguage.and.returnValue(language.promise);
    const query = grammar.getQuery("tagsQuery");
    grammar.deactivate();
    language.resolve({});
    let error;
    try {
      await query;
    } catch (rejected) {
      error = rejected;
    }
    expect(error.name).toBe("AbortError");
    expect(error.message).toContain("tagsQuery");
    expect(grammar._createQuery).not.toHaveBeenCalled();
    expect(grammar.queryCache.size).toBe(0);
    expect(grammar.requestedQueryTypes.size).toBe(0);
  });

  it("keeps a newer in-flight slot when an older generation settles", async () => {
    const firstLanguage = deferred();
    const secondLanguage = deferred();
    grammar.getLanguage.and.returnValues(firstLanguage.promise, secondLanguage.promise);
    const first = grammar.getQuery("tagsQuery");
    const firstSettled = first.catch((error) => error);
    grammar.deactivate();
    const second = grammar.getQuery("tagsQuery");
    firstLanguage.resolve({});
    expect((await firstSettled).name).toBe("AbortError");
    expect(grammar.promisesForQueries.get("tagsQuery")).toBe(second);
    secondLanguage.resolve({});
    expect(await second).toBe(grammar.queryCache.get("tagsQuery"));
    expect(grammar._createQuery).toHaveBeenCalledTimes(1);
  });

  it("reuses a query cached synchronously while an asynchronous request waits", async () => {
    const language = deferred();
    grammar.getLanguage.and.returnValue(language.promise);
    spyOn(grammar, "getLanguageSync").and.returnValue({});
    const pending = grammar.getQuery("tagsQuery");
    const synchronous = grammar.getQuerySync("tagsQuery");
    language.resolve({});
    expect(await pending).toBe(synchronous);
    expect(grammar._createQuery).toHaveBeenCalledTimes(1);
    expect(grammar.queryReferenceCounts.get(synchronous)).toBe(1);
  });

  it("deletes a newly created query if activation ends during construction", async () => {
    const created = { delete: jasmine.createSpy("delete") };
    grammar._createQuery.and.callFake(() => {
      grammar.deactivate();
      return created;
    });
    const query = grammar.getQuery("tagsQuery");
    let error;
    try {
      await query;
    } catch (rejected) {
      error = rejected;
    }
    expect(error.name).toBe("AbortError");
    expect(created.delete).toHaveBeenCalledTimes(1);
    expect(grammar.queryCache.size).toBe(0);
  });
});
