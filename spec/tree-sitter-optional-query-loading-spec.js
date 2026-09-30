const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Tree-sitter optional query loading", () => {
  let grammar, buffers, modes, extraGrammars, registrations;
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
    const file = require.resolve("language-javascript/grammars/javascript.json");
    grammar = new TreeSitterGrammar(lumine.grammars, file, CSON.readFileSync(file));
    await grammar.getLanguage();
  });
  afterEach(() => {
    for (const buffer of buffers) buffer.destroy();
    for (const registration of registrations) registration.dispose();
    for (const extra of extraGrammars) extra.deactivate();
    grammar.deactivate();
  });

  it("loads only mandatory queries at startup while declaring optional capabilities", async () => {
    const get = spyOn(grammar, "getQuery").and.callThrough();
    const languageMode = await mode();
    expect(
      get.calls
        .allArgs()
        .map(([type]) => type)
        .sort(),
    ).toEqual(["foldsQuery", "highlightsQuery", "indentsQuery"]);
    expect(languageMode.hasQuery("tagsQuery")).toBe(true);
    expect(languageMode.hasQuery("localsQuery")).toBe(true);
    expect(grammar.queryCache.has("tagsQuery")).toBe(false);
    expect(grammar.queryCache.has("localsQuery")).toBe(false);
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
