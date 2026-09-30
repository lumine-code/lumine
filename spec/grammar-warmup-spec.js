const path = require("path");
const GrammarRegistry = require("../src/grammar-registry");

describe("Recent grammar warmup", () => {
  let registry;
  let idle;

  beforeEach(() => {
    registry = new GrammarRegistry({ config: lumine.config });
    idle = createIdleScheduler();
  });

  afterEach(() => registry.clear());

  function createGrammar(
    scopeName,
    queryTypes = ["highlightsQuery", "foldsQuery", "indentsQuery"],
  ) {
    const treeSitter = { grammar: "unused.wasm" };
    for (const queryType of queryTypes) treeSitter[queryType] = `${queryType}.scm`;
    const grammar = registry.createGrammar(path.join(__dirname, `${scopeName}.json`), {
      type: "tree-sitter",
      name: scopeName,
      scopeName,
      injectionNames: [],
      treeSitter,
    });
    registry.addGrammar(grammar);
    spyOn(grammar, "getLanguage").and.callFake(() => Promise.resolve({}));
    spyOn(grammar, "getQuery").and.callFake(() => Promise.resolve({}));
    spyOn(grammar, "reportQueryError");
    return grammar;
  }

  function startWarmup(options = {}) {
    registry.warmRecentGrammars({
      requestIdleCallback: idle.schedule,
      cancelIdleCallback: idle.cancel,
      ...options,
    });
  }

  it("persists five recently used root languages in order, without plain text or stale copies", () => {
    const grammars = Array.from({ length: 7 }, (_, index) => createGrammar(`source.test${index}`));
    for (const grammar of grammars) registry.recordGrammarUse(grammar);
    registry.recordGrammarUse(grammars[3]);
    registry.recordGrammarUse(createGrammar("text.plain"));
    const staleGrammar = grammars[6];
    createGrammar(staleGrammar.scopeName);
    registry.recordGrammarUse(staleGrammar);

    const state = registry.serialize();
    expect(state.recentGrammarIds).toEqual([
      "source.test3",
      "source.test6",
      "source.test5",
      "source.test4",
      "source.test2",
    ]);
    registry.clear();
    registry.deserialize(state);
    expect(registry.serialize().recentGrammarIds).toEqual(state.recentGrammarIds);
  });

  it("accepts older state and filters malformed or duplicate persisted entries", () => {
    registry.deserialize({ languageOverridesByBufferId: { 12: "source.test" } });
    expect(registry.serialize().recentGrammarIds).toEqual([]);
    expect(registry.getAssignedLanguageId({ id: "12" })).toBe("source.test");
    registry.deserialize({
      recentGrammarIds: [null, 4, "", "text.plain", "source.a", "source.a", "source.b"],
    });
    expect(registry.serialize().recentGrammarIds).toEqual(["source.a", "source.b"]);
  });

  it("warms only recorded languages and gives every query a separate idle turn", async () => {
    const unused = createGrammar("source.unused");
    const first = createGrammar("source.first");
    const second = createGrammar("source.second", ["highlightsQuery"]);
    registry.recordGrammarUse(second);
    registry.recordGrammarUse(first);
    startWarmup();

    expect(first.getLanguage).not.toHaveBeenCalled();
    await idle.runNext();
    expect(first.getLanguage).toHaveBeenCalledTimes(1);
    expect(first.getQuery).not.toHaveBeenCalled();
    expect(idle.pending()).toBe(1);
    for (const [index, queryType] of ["highlightsQuery", "foldsQuery", "indentsQuery"].entries()) {
      await idle.runNext();
      expect(first.getQuery).toHaveBeenCalledTimes(index + 1);
      expect(first.getQuery.calls.mostRecent().args).toEqual([queryType]);
      expect(second.getLanguage).not.toHaveBeenCalled();
    }
    await idle.runNext();
    expect(second.getLanguage).toHaveBeenCalledTimes(1);
    await idle.runNext();
    expect(second.getQuery.calls.allArgs()).toEqual([["highlightsQuery"]]);
    expect(unused.getLanguage).not.toHaveBeenCalled();
    expect(idle.pending()).toBe(0);
  });

  it("uses only the current registered generation when a queued package is replaced or disabled", async () => {
    const replaced = createGrammar("source.replaced");
    const disabled = createGrammar("source.disabled");
    const invalidated = createGrammar("source.invalidated");
    for (const grammar of [invalidated, disabled, replaced]) registry.recordGrammarUse(grammar);
    startWarmup();
    const replacement = createGrammar(replaced.scopeName);
    registry.removeGrammar(disabled);
    invalidated.queryLoadGeneration++;

    await idle.runNext();
    expect(replaced.getLanguage).not.toHaveBeenCalled();
    expect(replacement.getLanguage).not.toHaveBeenCalled();
    expect(disabled.getLanguage).not.toHaveBeenCalled();
    expect(invalidated.getLanguage).not.toHaveBeenCalled();
    expect(idle.pending()).toBe(0);
  });

  it("cancels pending idle work on clear and does not continue a load that finishes after cancellation", async () => {
    const grammar = createGrammar("source.pending");
    registry.recordGrammarUse(grammar);
    startWarmup();
    registry.clear();
    expect(idle.pending()).toBe(0);
    expect(grammar.getLanguage).not.toHaveBeenCalled();

    registry.addGrammar(grammar);
    registry.recordGrammarUse(grammar);
    let resolveLanguage;
    grammar.getLanguage.and.returnValue(new Promise((resolve) => (resolveLanguage = resolve)));
    startWarmup();
    await idle.runNext();
    registry.cancelGrammarWarmup();
    resolveLanguage({});
    await Promise.resolve();
    expect(grammar.getQuery).not.toHaveBeenCalled();
    expect(idle.pending()).toBe(0);
  });

  it("stops when the window starts unloading", async () => {
    const grammar = createGrammar("source.active");
    registry.recordGrammarUse(grammar);
    let unloading = false;
    startWarmup({ shouldContinue: () => !unloading });
    await idle.runNext();
    unloading = true;
    await idle.runNext();
    expect(grammar.getQuery).not.toHaveBeenCalled();
    expect(idle.pending()).toBe(0);
  });

  it("reports current query errors once and continues with the next recorded language", async () => {
    const next = createGrammar("source.next", []);
    const broken = createGrammar("source.broken");
    registry.recordGrammarUse(next);
    registry.recordGrammarUse(broken);
    const error = new Error("bad highlights query");
    broken.getQuery.and.callFake(() => Promise.reject(error));
    startWarmup();
    await idle.runNext();
    await idle.runNext();
    expect(broken.reportQueryError).toHaveBeenCalledOnceWith(error, "highlightsQuery");
    await idle.runNext();
    expect(next.getLanguage).toHaveBeenCalledTimes(1);
    expect(idle.pending()).toBe(0);
  });

  it("does not report a query failure from a grammar that was removed during loading", async () => {
    const grammar = createGrammar("source.removed");
    registry.recordGrammarUse(grammar);
    let rejectQuery;
    grammar.getQuery.and.callFake(() => new Promise((resolve, reject) => (rejectQuery = reject)));
    startWarmup();
    await idle.runNext();
    await idle.runNext();
    registry.removeGrammar(grammar);
    rejectQuery(new Error("discarded generation"));
    await Promise.resolve();
    expect(grammar.reportQueryError).not.toHaveBeenCalled();
    expect(idle.pending()).toBe(0);
  });
});

function createIdleScheduler() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    schedule(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    pending() {
      return callbacks.size;
    },
    async runNext() {
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id);
      callback({ didTimeout: false, timeRemaining: () => 50 });
      await Promise.resolve();
    },
  };
}
