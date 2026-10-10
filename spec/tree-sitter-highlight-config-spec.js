const Config = require("../src/config");
const ScopeResolver = require("../src/scope-resolver");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const CSON = require("@lumine-code/season");

const grammarPath = require.resolve("language-javascript/grammars/javascript.json");
const grammarConfig = CSON.readFileSync(grammarPath);

describe("Tree-sitter configuration-dependent highlighting", () => {
  let config, editors, grammars;

  beforeEach(() => {
    jasmine.useRealClock();
    editors = [];
    grammars = [];
    config = new Config({ mainSource: "highlight-test.json", saveCallback() {} });
    config.setSchema("syntax", {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        unrelated: { type: "boolean", default: false },
      },
    });
    config.resetUserSettings({ "*": {} });
  });

  afterEach(() => {
    for (const editor of editors) editor.destroy();
    for (const grammar of grammars) grammar.deactivate();
    ScopeResolver.clearConfigCache();
  });

  async function setUp(predicate = '(#is? test.config "syntax.enabled true")') {
    const editor = await lumine.workspace.open("");
    editors.push(editor);
    const buffer = editor.getBuffer();
    buffer.setText("VALUE");
    const grammar = new TreeSitterGrammar(lumine.grammars, grammarPath, {
      ...grammarConfig,
      treeSitter: { ...grammarConfig.treeSitter, injectionsQuery: [] },
    });
    grammars.push(grammar);
    await grammar.setQueryForTest(
      "highlightsQuery",
      `((identifier) @constant.other.test
         ${predicate}
         (#set! capture.final true))
       ((identifier) @variable.other.test
         (#set! capture.shy true))`,
    );
    const mode = new TreeSitterLanguageMode({
      buffer,
      grammar,
      config,
      grammars: lumine.grammars,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    return { editor, buffer, grammar, mode };
  }

  function scopesAt(mode) {
    return mode.scopeDescriptorForPosition([0, 2]).getScopesArray();
  }

  function iteratorScopes(mode) {
    const iterator = mode.buildHighlightIterator();
    return iterator
      .seek({ row: 0, column: 2 }, 0)
      .map((id) => mode.grammar.scopeNameForScopeId(id));
  }

  it("defers global grammar observation until construction has returned", async () => {
    const editor = await lumine.workspace.open("");
    editors.push(editor);
    const buffer = editor.getBuffer();
    buffer.setText("VALUE");
    const grammar = new TreeSitterGrammar(lumine.grammars, grammarPath, {
      ...grammarConfig,
      treeSitter: { ...grammarConfig.treeSitter, injectionsQuery: [] },
    });
    grammars.push(grammar);
    await grammar.setQueryForTest(
      "highlightsQuery",
      "((identifier) @constant.other.test (#is? test.config syntax.enabled))",
    );
    spyOn(lumine.grammars, "onDidAddGrammar").and.callThrough();
    const mode = new TreeSitterLanguageMode({
      buffer,
      grammar,
      config,
      grammars: lumine.grammars,
    });
    expect(lumine.grammars.onDidAddGrammar).not.toHaveBeenCalled();
    buffer.setLanguageMode(mode);
    await mode.ready;
    expect(lumine.grammars.onDidAddGrammar).toHaveBeenCalled();
    expect(scopesAt(mode)).toContain("constant.other.test");
    config.set("syntax.enabled", false);
    expect(scopesAt(mode)).not.toContain("constant.other.test");
    config.set("syntax.enabled", true);
    expect(scopesAt(mode)).toContain("constant.other.test");
  });

  it("updates cached descriptors, iterators and rendered lines synchronously without parsing", async () => {
    const { editor, buffer, mode } = await setUp();
    const tree = mode.rootLanguageLayer.tree;
    const firstDescriptor = mode.scopeDescriptorForPosition([0, 2]);
    const firstLine = editor.displayLayer.getScreenLines(0, 1)[0];
    expect(firstDescriptor.getScopesArray()).toContain("constant.other.test");
    expect(iteratorScopes(mode)).toContain("constant.other.test");
    const observedScopes = [];
    const subscription = mode.onDidChangeHighlighting((range) => {
      expect(range).toEqual(buffer.getRange());
      observedScopes.push(scopesAt(mode));
    });
    spyOn(mode.rootLanguageLayer, "update").and.callThrough();
    spyOn(mode, "emitFoldUpdate").and.callThrough();

    config.set("syntax.enabled", false);
    expect(scopesAt(mode)).toContain("variable.other.test");
    expect(scopesAt(mode)).not.toContain("constant.other.test");
    expect(iteratorScopes(mode)).toContain("variable.other.test");
    expect(mode.scopeDescriptorForPosition([0, 2])).not.toBe(firstDescriptor);
    const disabledLine = editor.displayLayer.getScreenLines(0, 1)[0];
    expect(disabledLine).not.toBe(firstLine);
    expect(disabledLine.tags).not.toEqual(firstLine.tags);

    config.set("syntax.enabled", true);
    expect(scopesAt(mode)).toContain("constant.other.test");
    expect(iteratorScopes(mode)).toContain("constant.other.test");
    expect(editor.displayLayer.getScreenLines(0, 1)[0].tags).toEqual(firstLine.tags);
    expect(observedScopes.map((scopes) => scopes.at(-1))).toEqual([
      "variable.other.test",
      "constant.other.test",
    ]);
    expect(mode.rootLanguageLayer.tree).toBe(tree);
    expect(mode.rootLanguageLayer.update).not.toHaveBeenCalled();
    expect(mode.emitFoldUpdate).not.toHaveBeenCalled();
    subscription.dispose();
  });

  for (const [description, predicate, initiallyEnabled] of [
    ["refuted", "(#is-not? test.config syntax.enabled)", false],
    ["set", "(#set! test.config syntax.enabled)", true],
  ]) {
    it(`refreshes ${description} configuration predicates`, async () => {
      const { mode } = await setUp(predicate);
      expect(scopesAt(mode).includes("constant.other.test")).toBe(initiallyEnabled);
      config.set("syntax.enabled", false);
      expect(scopesAt(mode).includes("constant.other.test")).toBe(!initiallyEnabled);
      config.set("syntax.enabled", true);
      expect(scopesAt(mode).includes("constant.other.test")).toBe(initiallyEnabled);
    });
  }

  it("keeps highlight caches when unrelated settings change", async () => {
    const { editor, mode } = await setUp();
    const descriptor = mode.scopeDescriptorForPosition([0, 2]);
    const line = editor.displayLayer.getScreenLines(0, 1)[0];
    const changed = jasmine.createSpy("highlighting changed");
    const subscription = mode.onDidChangeHighlighting(changed);
    config.set("syntax.unrelated", true);
    expect(mode.scopeDescriptorForPosition([0, 2])).toBe(descriptor);
    expect(editor.displayLayer.getScreenLines(0, 1)[0]).toBe(line);
    expect(changed).not.toHaveBeenCalled();
    subscription.dispose();
  });

  it("refreshes scoped settings and broader configuration resets", async () => {
    const { mode } = await setUp();
    expect(scopesAt(mode)).toContain("constant.other.test");
    config.set("syntax.enabled", false, { scopeSelector: ".source.js" });
    expect(scopesAt(mode)).toContain("variable.other.test");
    config.resetUserSettings({ "*": {} });
    expect(config.get("syntax.enabled", { scope: ["source.js"] })).toBe(true);
    expect(scopesAt(mode)).toContain("constant.other.test");
  });

  it("disposes a destroyed mode's listener while another mode stays subscribed", async () => {
    const { mode } = await setUp();
    const { mode: remainingMode } = await setUp();
    spyOn(mode, "highlightConfigurationChanged").and.callThrough();
    config.set("syntax.enabled", false);
    expect(mode.highlightConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(scopesAt(remainingMode)).toContain("variable.other.test");
    mode.destroy();
    config.set("syntax.enabled", true);
    expect(mode.highlightConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(scopesAt(remainingMode)).toContain("constant.other.test");
  });

  it("subscribes to the current emitter after the same configuration object is reset", async () => {
    const { mode } = await setUp();
    expect(scopesAt(mode)).toContain("constant.other.test");
    mode.destroy();
    config.clear();
    config.setSchema("syntax", {
      type: "object",
      properties: { enabled: { type: "boolean", default: true } },
    });
    config.resetUserSettings({ "*": {} });
    const { mode: replacementMode } = await setUp();
    expect(scopesAt(replacementMode)).toContain("constant.other.test");
    config.set("syntax.enabled", false);
    expect(scopesAt(replacementMode)).toContain("variable.other.test");
    config.set("syntax.enabled", true);
    expect(scopesAt(replacementMode)).toContain("constant.other.test");
  });
});
