const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Combined injection equal-extent holes", () => {
  let registry, grammars, buffers, root, child, grandchild, point;
  function grammar(scopeName, injectionNames) {
    const file = require.resolve("language-python/grammars/python.json");
    const config = CSON.readFileSync(file);
    const value = new TreeSitterGrammar(registry, file, {
      ...config,
      scopeName,
      injectionNames,
      treeSitter: { grammar: config.treeSitter.grammar },
    });
    grammars.push(value);
    registry.addGrammar(value);
    return value;
  }
  async function start(text) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    const mode = new TreeSitterLanguageMode({
      buffer,
      grammar: root,
      config: lumine.config,
      grammars: registry,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    await mode.atGrammarSettlement();
    return { buffer, mode };
  }
  const layers = (mode) =>
    mode.getAllInjectionLayers().filter((layer) => layer.injectionPoint === point);
  async function replace(buffer, mode, from, to) {
    const range = buffer.findSync(from);
    expect(range).not.toBeNull();
    buffer.setTextInRange(range, to);
    await mode.atGrammarSettlement();
  }
  async function expectFresh(buffer, mode) {
    const fresh = await start(buffer.getText());
    const state = (value) =>
      value
        .getAllInjectionLayers()
        .map((layer) => ({
          scope: layer.grammar.scopeName,
          depth: layer.depth,
          ranges: layer.getCurrentRanges().map((range) => range.serialize()),
          syntax: layer.tree.rootNode.toString(),
        }))
        .sort((a, b) => a.scope.localeCompare(b.scope) || a.depth - b.depth);
    expect(state(mode)).toEqual(state(fresh.mode));
    for (let index = 0; index < buffer.getLength(); index++) {
      const position = buffer.positionForCharacterIndex(index);
      expect(mode.scopeDescriptorForPosition(position).getScopesArray()).toEqual(
        fresh.mode.scopeDescriptorForPosition(position).getScopesArray(),
      );
    }
  }
  function deferPopulation(layer) {
    const original = layer._populateInjections;
    let entered,
      resume,
      first = true;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise((resolve) => {
      resume = resolve;
    });
    spyOn(layer, "_populateInjections").and.callFake(async (...args) => {
      if (first) {
        first = false;
        entered();
        await waiting;
      }
      return original.apply(layer, args);
    });
    return { reached, resume };
  }
  function addDescendants() {
    child.addInjectionPoint({
      type: "integer",
      language: () => "hole-grandchild",
      content: (node) => node,
      languageScope: null,
    });
  }
  beforeEach(() => {
    jasmine.useRealClock();
    registry = new GrammarRegistry({ config: lumine.config });
    grammars = [];
    buffers = [];
    root = grammar("source.hole-root", []);
    child = grammar("source.hole-child", ["hole-child"]);
    grammar("source.hole-other", ["hole-other"]);
    grandchild = grammar("source.hole-grandchild", ["hole-grandchild"]);
    point = {
      type: "assignment",
      language: () => "hole-child",
      content: (node) => node.childForFieldName("right"),
      combined: true,
      newlinesBetween: true,
      includeChildren: true,
      languageScope: null,
    };
    root.addInjectionPoint(point);
  });
  afterEach(() => {
    for (const buffer of buffers) buffer.destroy();
    for (const item of grammars) item.deactivate();
    registry.clear();
  });
  it("keeps the leaf tree and rangeSet when an owner changes outside its included content", async () => {
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    const layer = layers(mode)[0],
      tree = layer.tree,
      ranges = layer.getCurrentRanges();
    const rangeSet = layer.marker.combinedInjectionGroup.rangeSet;
    spyOn(mode, "parseAsync").and.callThrough();
    spyOn(tree, "edit").and.callThrough();
    await replace(buffer, mode, "alpha", "gamma");
    expect(layers(mode)[0]).toBe(layer);
    expect(layer.tree === tree).toBe(true);
    expect(layer.marker.combinedInjectionGroup.rangeSet === rangeSet).toBe(true);
    expect(layer.getCurrentRanges() === ranges).toBe(true);
    expect(tree.edit).not.toHaveBeenCalled();
    expect(
      mode.parseAsync.calls.allArgs().filter((args) => args[3]?.scopeName === child.scopeName)
        .length,
    ).toBe(0);
    await expectFresh(buffer, mode);
  });
  it("reparses actual included content with its old tree", async () => {
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    const layer = layers(mode)[0],
      tree = layer.tree;
    spyOn(mode, "parseAsync").and.callThrough();
    await replace(buffer, mode, "3", "9");
    const calls = mode.parseAsync.calls
      .allArgs()
      .filter((args) => args[3]?.scopeName === child.scopeName);
    expect(calls.length).toBe(1);
    expect(calls[0][1] === tree).toBe(true);
    expect(layer.tree === tree).toBe(false);
    await expectFresh(buffer, mode);
  });
  it("handles boundary insertions, deletions, shifts and moving EOF like a fresh parse", async () => {
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    buffer.insert(layers(mode)[0].getCurrentRanges()[0].start, "5");
    await mode.atGrammarSettlement();
    await expectFresh(buffer, mode);
    await replace(buffer, mode, "53", "3");
    await expectFresh(buffer, mode);
    await replace(buffer, mode, "alpha", "longer_name");
    await expectFresh(buffer, mode);
    buffer.insert([0, 0], "prefix = 1\n");
    await mode.atGrammarSettlement();
    await expectFresh(buffer, mode);
    buffer.append("final = 5\n");
    await mode.atGrammarSettlement();
    await expectFresh(buffer, mode);
    await replace(buffer, mode, "final = 5\n", "");
    await expectFresh(buffer, mode);
  });
  it("rediscovers changed language and retired members despite an equal-extent owner edit", async () => {
    point.language = (node) =>
      node.childForFieldName("left").text === "omega" ? "hole-other" : "hole-child";
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    await replace(buffer, mode, "alpha", "omega");
    expect(
      layers(mode)
        .map((layer) => layer.grammar.scopeName)
        .sort(),
    ).toEqual(["source.hole-child", "source.hole-other"]);
    await expectFresh(buffer, mode);
    await replace(buffer, mode, "omega = 3", "pass     ");
    expect(layers(mode).map((layer) => layer.grammar.scopeName)).toEqual(["source.hole-child"]);
    await expectFresh(buffer, mode);
  });
  it("retains existing descendant injections across a hole edit and a real source edit", async () => {
    child.addInjectionPoint({
      type: "integer",
      language: () => "hole-grandchild",
      content: (node) => node,
      languageScope: null,
    });
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    expect(
      mode.getAllInjectionLayers().filter((layer) => layer.grammar === grandchild).length,
    ).toBe(2);
    spyOn(mode, "parseAsync").and.callThrough();
    await replace(buffer, mode, "alpha", "gamma");
    expect(
      mode.parseAsync.calls.allArgs().filter((args) => args[3]?.scopeName === child.scopeName)
        .length,
    ).toBe(0);
    expect(
      mode.getAllInjectionLayers().filter((layer) => layer.grammar === grandchild).length,
    ).toBe(2);
    await expectFresh(buffer, mode);
    await replace(buffer, mode, "3", "9");
    await expectFresh(buffer, mode);
  });
  it("lets a module-owner callback read the latest hole text from the retained tree", async () => {
    const observed = [];
    child.addInjectionPoint({
      type: "module",
      language: (node) => {
        observed.push(node.text);
        return "hole-grandchild";
      },
      content: (node) => node,
      includeChildren: true,
      languageScope: null,
    });
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    const layer = layers(mode)[0],
      tree = layer.tree;
    expect(observed.some((text) => text.includes("beta"))).toBe(true);
    // The joined newline ends at [1, 0], so replacing the whole identifier
    // would touch a boundary. Change only the interior of this real hole.
    expect(
      layer.currentRangesLayer.findMarkers({ intersectsRange: buffer.findSync("eta") }).length,
    ).toBe(0);
    observed.length = 0;
    spyOn(mode, "parseAsync").and.callThrough();
    await replace(buffer, mode, "eta", "ota");
    expect(layer.tree === tree).toBe(true);
    expect(
      mode.parseAsync.calls.allArgs().filter((args) => args[3]?.scopeName === child.scopeName)
        .length,
    ).toBe(0);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((text) => text.includes("bota") && !text.includes("beta"))).toBe(true);
    await expectFresh(buffer, mode);
  });
  it("discovers new descendants when actual included content changes", async () => {
    child.addInjectionPoint({
      type: "string",
      language: () => "hole-grandchild",
      content: (node) => node,
      includeChildren: true,
      languageScope: null,
    });
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    expect(
      mode.getAllInjectionLayers().filter((layer) => layer.grammar === grandchild).length,
    ).toBe(0);
    spyOn(mode, "parseAsync").and.callThrough();
    await replace(buffer, mode, "alpha", "gamma");
    expect(
      mode.parseAsync.calls.allArgs().filter((args) => args[3]?.scopeName === child.scopeName)
        .length,
    ).toBe(0);
    await expectFresh(buffer, mode);
    await replace(buffer, mode, "3", '"abc"');
    expect(
      mode.getAllInjectionLayers().filter((layer) => layer.grammar === grandchild).length,
    ).toBe(1);
    await expectFresh(buffer, mode);
  });
  for (const change of ["source", "ranges"]) {
    it(`retries normal parsing when ${change} changes during retained-tree descendant discovery`, async () => {
      addDescendants();
      const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
      const layer = layers(mode)[0],
        gate = deferPopulation(layer);
      spyOn(mode, "parseAsync").and.callThrough();
      buffer.setTextInRange(buffer.findSync("alpha"), "gamma");
      await gate.reached;
      if (change === "source") buffer.setTextInRange(buffer.findSync("3"), "9");
      else buffer.insert(layer.getCurrentRanges()[0].start, "5");
      gate.resume();
      await mode.atGrammarSettlement();
      expect(
        mode.parseAsync.calls.allArgs().some((args) => args[3]?.scopeName === child.scopeName),
      ).toBe(true);
      await expectFresh(buffer, mode);
    });
  }
  it("retries descendant registration changes during local discovery without parsing unchanged source", async () => {
    addDescendants();
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    const layer = layers(mode)[0],
      gate = deferPopulation(layer);
    spyOn(mode, "parseAsync").and.callThrough();
    buffer.setTextInRange(buffer.findSync("alpha"), "gamma");
    await gate.reached;
    child.addInjectionPoint({
      type: "integer",
      language: () => "hole-other",
      content: (node) => node,
      languageScope: null,
    });
    gate.resume();
    await mode.atGrammarSettlement();
    expect(mode.getAllInjectionLayers().filter((item) => item.depth === 2).length).toBe(4);
    await expectFresh(buffer, mode);
  });
  it("drops queued discovery safely when its buffer is destroyed during an await", async () => {
    addDescendants();
    const { buffer, mode } = await start("alpha = 3\nbeta = 4\n");
    const layer = layers(mode)[0],
      gate = deferPopulation(layer);
    buffer.setTextInRange(buffer.findSync("alpha"), "gamma");
    await gate.reached;
    const pending = mode.atGrammarSettlement();
    buffer.destroy();
    gate.resume();
    await pending;
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
    expect(mode.getAllLanguageLayers().filter(Boolean).length).toBe(0);
    expect(mode.parsersByLanguage.size).toBe(0);
    expect(layer.pendingInjectionPopulationRequests.length).toBe(0);
  });
});
