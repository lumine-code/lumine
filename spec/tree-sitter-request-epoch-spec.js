const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TextBuffer = require("../src/text-buffer");
const os = require("node:os");
const path = require("node:path");

describe("Inline syntax request epochs", () => {
  let registry, buffer, mode, grammar, grammars, registrations;
  const scope = "source.test.request-epoch";

  function addGrammar(scopeName = scope) {
    const file = require.resolve("language-javascript/grammars/javascript.json");
    const config = CSON.readFileSync(file);
    const entry = new TreeSitterGrammar(registry, file, {
      ...config,
      scopeName,
      injectionNames: [scopeName],
    });
    grammars.push(entry);
    registrations.push(registry.addGrammar(entry));
    return entry;
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    registry = new GrammarRegistry({ config: lumine.config, syntaxExecution: "inline" });
    grammars = [];
    registrations = [];
    grammar = addGrammar();
    buffer = new TextBuffer({ text: "const value = 1;\n" });
    registry.assignLanguageMode(buffer, scope);
    mode = buffer.getLanguageMode();
    await mode.ready;
    await mode.atGrammarSettlement();
  });

  afterEach(() => {
    buffer.destroy();
    for (const registration of registrations) registration.dispose();
    for (const entry of grammars) entry.deactivate();
    registry.clear();
  });

  it("retains request ownership through an unchanged-text parser update", async () => {
    const revision = buffer.getTextRevision();
    const generation = mode.getSyntaxGeneration();
    const epoch = mode.getSyntaxRequestEpoch();
    mode.requestDocumentUpdate();
    await mode.atGrammarSettlement();
    expect(buffer.getTextRevision()).toBe(revision);
    expect(mode.getSyntaxGeneration()).toBeGreaterThan(generation);
    expect(mode.getSyntaxRequestEpoch()).toBe(epoch);
  });

  it("keeps content generations separate from configuration during an edit", async () => {
    const epoch = mode.getSyntaxRequestEpoch();
    const generation = mode.getSyntaxGeneration();
    buffer.insert([0, 0], " ");
    await mode.atGrammarSettlement();
    expect(mode.getSyntaxGeneration()).toBeGreaterThan(generation);
    expect(mode.getSyntaxRequestEpoch()).toBe(epoch);
  });

  it("invalidates requests when root-range policy is installed or removed", () => {
    const before = mode.getSyntaxRequestEpoch();
    const registration = registry.setRootLanguageRanges(buffer, () => null);
    const installed = mode.getSyntaxRequestEpoch();
    expect(installed).toBeGreaterThan(before);
    registration.dispose();
    expect(mode.getSyntaxRequestEpoch()).toBeGreaterThan(installed);
  });

  it("invalidates root-range policy changes while the parser is still cold", async () => {
    const language = await grammar.getLanguage();
    let release;
    spyOn(grammar, "getLanguage").and.returnValue(new Promise((resolve) => (release = resolve)));
    const coldBuffer = new TextBuffer({ text: "const cold = 1;" });
    registry.assignLanguageMode(coldBuffer, scope);
    const coldMode = coldBuffer.getLanguageMode();
    try {
      expect(coldMode.rootLanguageLayer).toBeNull();
      const before = coldMode.getSyntaxRequestEpoch();
      const policy = registry.setRootLanguageRanges(coldBuffer, () => null);
      expect(coldMode.getSyntaxRequestEpoch()).toBeGreaterThan(before);
      policy.dispose();
      release(language);
      await coldMode.ready;
    } finally {
      release(language);
      coldBuffer.destroy();
    }
  });

  it("invalidates requests when its buffer path changes", () => {
    const before = mode.getSyntaxRequestEpoch();
    buffer.setPath(path.join(os.tmpdir(), "request-epoch.js"));
    expect(mode.getSyntaxRequestEpoch()).toBeGreaterThan(before);
  });

  it("invalidates requests when highlight configuration changes", () => {
    const before = mode.getSyntaxRequestEpoch();
    mode.highlightConfigurationChanged();
    expect(mode.getSyntaxRequestEpoch()).toBeGreaterThan(before);
  });

  it("invalidates requests when a query is replaced", async () => {
    const before = mode.getSyntaxRequestEpoch();
    await grammar.setQueryForTest("highlightsQuery", "(identifier) @variable.test");
    await mode.atGrammarSettlement();
    expect(mode.getSyntaxRequestEpoch()).toBeGreaterThan(before);
  });

  it("retains request ownership while an existing query reload is processed", async () => {
    const before = mode.getSyntaxRequestEpoch();
    await mode.rootLanguageLayer.scheduleQueryReload("highlightsQuery");
    expect(mode.getSyntaxRequestEpoch()).toBe(before);
  });

  it("invalidates requests when injection points are added or removed", () => {
    const before = mode.getSyntaxRequestEpoch();
    const registration = registry.addInjectionPoint(scope, {
      type: "comment",
      language: () => null,
      content: (node) => node,
    });
    const installed = mode.getSyntaxRequestEpoch();
    expect(installed).toBeGreaterThan(before);
    registration.dispose();
    expect(mode.getSyntaxRequestEpoch()).toBeGreaterThan(installed);
  });

  it("invalidates requests when an injection grammar is added or removed", () => {
    const before = mode.getSyntaxRequestEpoch();
    addGrammar("source.test.request-epoch-injection");
    const added = mode.getSyntaxRequestEpoch();
    expect(added).toBeGreaterThan(before);
    registrations.pop().dispose();
    expect(mode.getSyntaxRequestEpoch()).toBeGreaterThan(added);
  });

  it("invalidates requests when its language mode is destroyed", () => {
    const before = mode.getSyntaxRequestEpoch();
    buffer.destroy();
    expect(mode.getSyntaxRequestEpoch()).toBeGreaterThan(before);
  });
});
