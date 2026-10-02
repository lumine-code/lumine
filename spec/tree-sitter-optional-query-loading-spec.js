const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Tree-sitter optional query loading", () => {
  let grammar, buffers, modes, extraGrammars, registrations, paintJobs;
  function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  async function waitFor(condition) {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for optional query loading");
  }
  async function mode(text = "function alpha() {}\nfunction beta() {}") {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    const result = new TreeSitterLanguageMode({
      buffer,
      grammar,
      config: lumine.config,
      grammars: lumine.grammars,
    });
    modes.push(result);
    buffer.setLanguageMode(result);
    await result.ready;
    return result;
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    buffers = [];
    modes = [];
    extraGrammars = [];
    registrations = [];
    paintJobs = [];
    spyOn(TreeSitterLanguageMode.prototype, "scheduleAfterHighlightPaint").and.callFake(
      (callback) => {
        const job = { callback, cancelled: false };
        paintJobs.push(job);
        return () => {
          job.cancelled = true;
        };
      },
    );
    const file = require.resolve("language-javascript/grammars/javascript.json");
    const config = CSON.readFileSync(file);
    // Keep this fixture focused on staged query loading as the shipped grammar adds injections.
    grammar = new TreeSitterGrammar(lumine.grammars, file, {
      ...config,
      treeSitter: { ...config.treeSitter, injectionsQuery: [] },
    });
    await grammar.getLanguage();
  });
  afterEach(() => {
    for (const buffer of buffers) buffer.destroy();
    for (const registration of registrations) registration.dispose();
    for (const extra of extraGrammars) extra.deactivate();
    grammar.deactivate();
  });

  it("parses and highlights before compiling cold folding and indentation queries", async () => {
    const get = spyOn(grammar, "getQuery").and.callThrough();
    const languageMode = await mode();
    expect(
      get.calls
        .allArgs()
        .map(([type]) => type)
        .sort(),
    ).toEqual(["highlightsQuery"]);
    expect(languageMode.tree).toBeTruthy();
    expect(languageMode.rootLanguageLayer.queries.highlightsQuery).toBeTruthy();
    expect(languageMode.rootLanguageLayer.queries.foldsQuery).toBeUndefined();
    expect(languageMode.rootLanguageLayer.queries.indentsQuery).toBeUndefined();
    expect(paintJobs.length).toBe(1);
    // Reading the gutter and pre-filling caches must not undo the staging.
    expect(languageMode.isFoldableAtRowForRendering(0)).toBe(false);
    languageMode.prefillFoldCache(languageMode.buffer.getRange());
    await languageMode.atGrammarSettlement();
    expect(get.calls.count()).toBe(1);
    expect(languageMode.hasQuery("tagsQuery")).toBe(true);
    expect(languageMode.hasQuery("localsQuery")).toBe(true);
    expect(grammar.queryCache.has("tagsQuery")).toBe(false);
    expect(grammar.queryCache.has("localsQuery")).toBe(false);
  });

  it("compiles deferred queries separately and refreshes the gutter after folds arrive", async () => {
    const languageMode = await mode("function alpha() {\n  return 1;\n}");
    const layer = languageMode.rootLanguageLayer;
    expect(languageMode.isFoldableAtRowForRendering(0)).toBe(false);
    const update = spyOn(languageMode, "emitRangeUpdate").and.callThrough();
    paintJobs[0].callback();
    await waitFor(() => layer.queries.foldsQuery && paintJobs.length === 2);
    expect(layer.queries.indentsQuery).toBeUndefined();
    expect(update).toHaveBeenCalled();
    expect(languageMode.isFoldableAtRow(0)).toBe(true);
    paintJobs[1].callback();
    await waitFor(() => layer.queries.indentsQuery);
  });

  it("answers the first explicit fold and indent requests before idle work runs", async () => {
    // Ordinary JavaScript braces use editor regex indentation settings; give
    // this standalone mode a query whose result proves the cold demand works.
    grammar.indentsQuery = '"{" @indent\n"}" @dedent';
    const languageMode = await mode("function alpha() {\n  return 1;\n}");
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    expect(languageMode.isFoldableAtRowForRendering(0)).toBe(false);
    expect(languageMode.isFoldableAtRow(0)).toBe(true);
    const range = languageMode.getFoldRangeForRow(0);
    expect(range.start.row).toBe(0);
    expect(range.end.row).toBe(2);
    expect(languageMode.suggestedIndentForBufferRow(1, 2)).toBe(1);
    expect(compile).toHaveBeenCalledTimes(2);
    // A pending background callback sees the demanded handles and skips them.
    paintJobs[0].callback();
    await languageMode.atGrammarSettlement();
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("attaches warm ancillary query handles immediately without a paint callback", async () => {
    const folds = await grammar.getQuery("foldsQuery");
    const indents = await grammar.getQuery("indentsQuery");
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    const languageMode = await mode();
    expect(languageMode.rootLanguageLayer.queries.foldsQuery).toBe(folds);
    expect(languageMode.rootLanguageLayer.queries.indentsQuery).toBe(indents);
    expect(paintJobs).toEqual([]);
    expect(compile).toHaveBeenCalledTimes(1); // highlights remains cold.
  });

  it("cancels queued ancillary work when the buffer is destroyed", async () => {
    const languageMode = await mode();
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    languageMode.buffer.destroy();
    expect(paintJobs[0].cancelled).toBe(true);
    paintJobs[0].callback();
    await Promise.resolve();
    expect(compile).not.toHaveBeenCalled();
  });

  it("waits for a rendering frame before scheduling cancellable idle compilation", async () => {
    TreeSitterLanguageMode.prototype.scheduleAfterHighlightPaint.and.callThrough();
    const frames = [],
      idle = [];
    const frame = spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = spyOn(window, "cancelAnimationFrame");
    spyOn(window, "requestIdleCallback").and.callFake((callback) => {
      idle.push(callback);
      return idle.length;
    });
    const languageMode = await mode();
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    expect(frame).toHaveBeenCalledTimes(1);
    expect(idle).toEqual([]);
    await languageMode.atGrammarSettlement();
    expect(compile).not.toHaveBeenCalled();
    frames[0]();
    expect(idle.length).toBe(1);
    expect(compile).not.toHaveBeenCalled();
    idle[0]();
    await waitFor(() => languageMode.rootLanguageLayer.queries.foldsQuery && frames.length === 2);
    expect(compile).toHaveBeenCalledTimes(1);
    languageMode.buffer.destroy();
    expect(cancelFrame).toHaveBeenCalledWith(2);
  });

  it("cancels idle work after the frame when its layer is destroyed", async () => {
    TreeSitterLanguageMode.prototype.scheduleAfterHighlightPaint.and.callThrough();
    let afterFrame;
    spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
      afterFrame = callback;
      return 17;
    });
    spyOn(window, "requestIdleCallback").and.returnValue(23);
    const cancelIdle = spyOn(window, "cancelIdleCallback");
    const languageMode = await mode();
    afterFrame();
    languageMode.buffer.destroy();
    expect(cancelIdle).toHaveBeenCalledWith(23);
  });

  it("includes an already-started ancillary load in grammar settlement", async () => {
    const languageMode = await mode();
    const layer = languageMode.rootLanguageLayer;
    const query = await grammar.createQuery("(statement_block) @fold");
    const pending = deferred();
    const getQuery = grammar.getQuery.bind(grammar);
    spyOn(grammar, "getQuery").and.callFake((type) =>
      type === "foldsQuery" ? pending.promise : getQuery(type),
    );
    paintJobs[0].callback();
    await waitFor(() => layer.queryLoadPromises.size === 1);
    let settled = false;
    const settlement = languageMode.atGrammarSettlement().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve(query);
    await settlement;
    expect(layer.queries.foldsQuery).toBe(query);
    expect(settled).toBe(true);
    // A synthetic query is retained by the layer rather than the grammar cache.
    // The afterEach buffer cleanup releases its only handle.
  });

  it("reports a broken ancillary query once and recovers after a source fix", async () => {
    const languageMode = await mode();
    grammar.foldsQuery = "(no_such_node) @fold";
    const report = spyOn(grammar, "reportQueryError");
    expect(languageMode.getFoldRangeForRow(0)).toBeNull();
    expect(languageMode.getFoldRangeForRow(0)).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    await grammar.setQueryForTest("foldsQuery", "(statement_block) @fold");
    await languageMode.atGrammarSettlement();
    expect(languageMode.rootLanguageLayer.queries.foldsQuery).toBeTruthy();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("does not retain a late ancillary handle after destruction", async () => {
    const languageMode = await mode();
    const layer = languageMode.rootLanguageLayer;
    const pending = deferred();
    const query = await grammar.createQuery("(statement_block) @fold");
    grammar.cacheQuery("foldsQuery", query);
    spyOn(grammar, "getQuery").and.returnValue(pending.promise);
    paintJobs[0].callback();
    const load = layer.queryLoadPromises.get("foldsQuery");
    languageMode.buffer.destroy();
    pending.resolve(query);
    await load;
    expect(layer.queries).toEqual({});
    expect(grammar.queryReferenceCounts.get(query)).toBe(1);
  });

  it("stops deferred compilation when the grammar generation is discarded", async () => {
    const languageMode = await mode();
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    grammar.deactivate();
    paintJobs[0].callback();
    await languageMode.atGrammarSettlement();
    expect(compile).not.toHaveBeenCalled();
    expect(paintJobs.length).toBe(1);
  });

  it("does not warm a reactivated grammar from its old standalone layer", async () => {
    const languageMode = await mode();
    const language = grammar.getLanguageSync();
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    grammar.deactivate();
    grammar.activate();
    await grammar.getLanguage();
    expect(grammar.getLanguageSync()).toBe(language);
    paintJobs[0].callback();
    await Promise.resolve();
    expect(compile).not.toHaveBeenCalled();
    expect(languageMode.rootLanguageLayer.queries.foldsQuery).toBeUndefined();
    expect(paintJobs.length).toBe(1);
  });

  it("shares a true compiled Query across concurrent requests and layers", async () => {
    const first = await mode();
    const second = await mode();
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    const groups = await Promise.all([
      first.getQueryCaptureGroups("tagsQuery"),
      first.getQueryCaptureGroups("tagsQuery"),
      second.getQueryCaptureGroups("tagsQuery"),
    ]);
    expect(groups.every((group) => group.length === 1)).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
    const query = grammar.queryCache.get("tagsQuery");
    expect(first.rootLanguageLayer.queries.tagsQuery).toBe(query);
    expect(second.rootLanguageLayer.queries.tagsQuery).toBe(query);
    expect(await grammar.getQuery("tagsQuery")).toBe(query);
    expect(grammar.queryReferenceCounts.get(query)).toBe(3);
    first.destroy();
    second.destroy();
    expect(grammar.queryReferenceCounts.get(query)).toBe(1);
  });

  it("does not eagerly compile a cold optional query after its source changes", async () => {
    const languageMode = await mode();
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    grammar.tagsQuery = "(identifier) @changed";
    grammar.emitter.emit("did-change-query", { queryType: "tagsQuery" });
    await languageMode.atGrammarSettlement();
    expect(compile).not.toHaveBeenCalled();
    expect(languageMode.rootLanguageLayer.queries.tagsQuery).toBeUndefined();
    const groups = await languageMode.getQueryCaptureGroups("tagsQuery");
    expect(compile).toHaveBeenCalledTimes(1);
    expect(groups[0].captures.map((capture) => capture.name)).toEqual(["changed", "changed"]);
  });

  it("keeps settlement pending while a requested optional load is in flight", async () => {
    const languageMode = await mode();
    const pending = deferred();
    const query = await grammar.createQuery("(identifier) @name");
    grammar.cacheQuery("tagsQuery", query);
    spyOn(grammar, "getQuery").and.returnValue(pending.promise);
    const request = languageMode.getQueryCaptureGroups("tagsQuery");
    await waitFor(() => languageMode.rootLanguageLayer.queryLoadPromises.size === 1);
    let settled = false;
    const settlement = languageMode.atGrammarSettlement().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    pending.resolve(query);
    await Promise.all([request, settlement]);
    expect(settled).toBe(true);
  });

  it("drops late optional results after destruction without retaining their handles", async () => {
    const languageMode = await mode();
    const pending = deferred();
    const query = await grammar.createQuery("(identifier) @name");
    grammar.cacheQuery("tagsQuery", query);
    spyOn(grammar, "getQuery").and.returnValue(pending.promise);
    const request = languageMode.getQueryCaptureGroups("tagsQuery");
    await waitFor(() => languageMode.rootLanguageLayer.queryLoadPromises.size === 1);
    const layer = languageMode.rootLanguageLayer;
    languageMode.destroy();
    pending.resolve(query);
    expect(await request).toEqual([]);
    expect(layer.queries).toEqual({});
    expect(grammar.queryReferenceCounts.get(query)).toBe(1);
  });

  it("reports a broken optional query once on demand and retries after a source fix", async () => {
    const languageMode = await mode();
    grammar.tagsQuery = "(no_such_node) @name";
    const report = spyOn(grammar, "reportQueryError");
    const compile = spyOn(grammar, "_createQuery").and.callThrough();
    expect(await languageMode.getQueryCaptureGroups("tagsQuery")).toEqual([]);
    expect(await languageMode.getQueryCaptureGroups("tagsQuery")).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.calls.mostRecent().args[0].name).toBe("QueryError");
    expect(report.calls.mostRecent().args[1]).toBe("tagsQuery");
    expect(compile).toHaveBeenCalledTimes(1);
    grammar.tagsQuery = "(identifier) @name";
    grammar.emitter.emit("did-change-query", { queryType: "tagsQuery" });
    await languageMode.atGrammarSettlement();
    const groups = await languageMode.getQueryCaptureGroups("tagsQuery");
    expect(groups[0].captures.length).toBe(2);
  });

  it("ignores aborts from a discarded generation without phantom notifications", async () => {
    const languageMode = await mode();
    const pending = deferred();
    const report = spyOn(grammar, "reportQueryError");
    spyOn(grammar, "getQuery").and.returnValue(pending.promise);
    const request = languageMode.getQueryCaptureGroups("tagsQuery");
    await waitFor(() => languageMode.rootLanguageLayer.queryLoadPromises.size === 1);
    grammar.deactivate();
    const error = new Error("obsolete query generation");
    error.name = "AbortError";
    pending.reject(error);
    expect(await request).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });

  it("retries the latest source when a query changes during its first requested load", async () => {
    const languageMode = await mode();
    const pending = deferred();
    const original = grammar.getQuery.bind(grammar);
    let requests = 0;
    spyOn(grammar, "getQuery").and.callFake((type) => {
      if (type === "tagsQuery" && ++requests === 1) return pending.promise;
      return original(type);
    });
    const stale = await grammar.createQuery("(identifier) @stale");
    const request = languageMode.getQueryCaptureGroups("tagsQuery");
    await waitFor(() => requests === 1);
    grammar.tagsQuery = "(identifier) @latest";
    grammar.emitter.emit("did-change-query", { queryType: "tagsQuery" });
    pending.resolve(stale);
    const groups = await request;
    expect(groups[0].captures.map((capture) => capture.name)).toEqual(["latest", "latest"]);
    expect(languageMode.rootLanguageLayer.queries.tagsQuery).toBe(
      grammar.queryCache.get("tagsQuery"),
    );
    stale.delete();
  });

  it("loads an optional query declared only by a nested language layer", async () => {
    delete grammar.tagsQuery;
    delete grammar.queryPaths.tagsQuery;
    const file = require.resolve("language-html/grammars/html.json");
    const nested = new TreeSitterGrammar(lumine.grammars, file, {
      ...CSON.readFileSync(file),
      injectionNames: ["optional-query-html"],
    });
    extraGrammars.push(nested);
    await nested.getLanguage();
    nested.tagsQuery = "(text) @name";
    registrations.push(lumine.grammars.addGrammar(nested));
    grammar.addInjectionPoint({
      type: "template_string",
      language: () => "optional-query-html",
      content: (node) => node.children.filter((child) => child.type === "string_fragment"),
    });
    const languageMode = await mode("const value = html `<b>alpha</b>`;");
    expect(languageMode.hasQuery("tagsQuery")).toBe(true);
    expect(nested.queryCache.has("tagsQuery")).toBe(false);
    const groups = await languageMode.getQueryCaptureGroups("tagsQuery");
    expect(groups.length).toBe(1);
    expect(groups[0].grammar).toBe(nested);
    expect(groups[0].captures[0].node.text).toBe("alpha");
    const nestedLayer = languageMode
      .getAllInjectionLayers()
      .find((layer) => layer.grammar === nested);
    expect(nestedLayer.queries.tagsQuery).toBe(await nested.getQuery("tagsQuery"));
  });

  it("returns no captures for a request aborted while its optional query was loading", async () => {
    const languageMode = await mode();
    const pending = deferred();
    const query = await grammar.createQuery("(identifier) @name");
    grammar.cacheQuery("tagsQuery", query);
    spyOn(grammar, "getQuery").and.returnValue(pending.promise);
    const controller = new AbortController();
    const request = languageMode.getQueryCaptureGroups("tagsQuery", { signal: controller.signal });
    await waitFor(() => languageMode.rootLanguageLayer.queryLoadPromises.size === 1);
    controller.abort();
    pending.resolve(query);
    expect(await request).toEqual([]);
    expect(grammar.queryReferenceCounts.get(query)).toBe(2);
  });
});
