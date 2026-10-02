const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const { Point, Range } = TextBuffer;

describe("Tree-sitter injection change routing", () => {
  let registry, grammars, buffers, rootGrammar, childGrammar, point;

  function createGrammar(scopeName, injectionNames) {
    const file = require.resolve("language-python/grammars/python.json");
    const config = CSON.readFileSync(file);
    const grammar = new TreeSitterGrammar(registry, file, {
      ...config,
      scopeName,
      injectionNames,
      treeSitter: { grammar: config.treeSitter.grammar },
    });
    grammars.push(grammar);
    registry.addGrammar(grammar);
    return grammar;
  }

  async function start(text) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    const mode = new TreeSitterLanguageMode({
      buffer,
      grammar: rootGrammar,
      config: lumine.config,
      grammars: registry,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    await mode.atGrammarSettlement();
    return { buffer, mode };
  }

  function layers(mode) {
    return mode.getAllInjectionLayers().filter((layer) => layer.injectionPoint === point);
  }

  function replace(buffer, from, to) {
    const range = buffer.findSync(from);
    if (!range) throw new Error(`Missing source text: ${from}`);
    buffer.setTextInRange(range, to);
  }

  async function expectFresh(buffer, mode) {
    const fresh = await start(buffer.getText());
    expect(mode.tree.rootNode.toString()).toBe(fresh.mode.tree.rootNode.toString());
    expect(
      layers(mode).map((layer) => ({
        ranges: layer.getCurrentRanges().map((range) => range.serialize()),
        syntax: layer.tree.rootNode.toString(),
      })),
    ).toEqual(
      layers(fresh.mode).map((layer) => ({
        ranges: layer.getCurrentRanges().map((range) => range.serialize()),
        syntax: layer.tree.rootNode.toString(),
      })),
    );
    expect(mode.getFoldableRanges().map((range) => range.serialize())).toEqual(
      fresh.mode.getFoldableRanges().map((range) => range.serialize()),
    );
    for (let index = 0; index < buffer.getLength(); index++) {
      const position = buffer.positionForCharacterIndex(index);
      expect(mode.scopeDescriptorForPosition(position).getScopesArray()).toEqual(
        fresh.mode.scopeDescriptorForPosition(position).getScopesArray(),
      );
    }
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    registry = new GrammarRegistry({ config: lumine.config });
    grammars = [];
    buffers = [];
    rootGrammar = createGrammar("source.routing-root", []);
    childGrammar = createGrammar("source.routing-child", ["routing-child"]);
    await childGrammar.setQueryForTest("highlightsQuery", "(integer) @constant.numeric.routing");
    point = {
      type: "integer",
      language: (node) => (Number(node.text) >= 3 ? "routing-child" : null),
      content: (node) => node,
    };
    rootGrammar.addInjectionPoint(point);
  });

  afterEach(() => {
    for (const buffer of buffers) buffer.destroy();
    for (const grammar of grammars) grammar.deactivate();
    registry.clear();
  });

  it("keeps the tree and ranges while invalidating an unchanged later injection's fold cache", async () => {
    const { buffer, mode } = await start("prefix = 0\ninjected = 3\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const ranges = layer.getCurrentRanges();
    const foldRowCache = mode.isFoldableCache;
    const boundaries = { cached: true };
    const boundaryRange = layer.getExtent();
    layer.foldResolver.boundaries = boundaries;
    layer.foldResolver.boundariesRange = boundaryRange;
    layer.foldResolver.boundariesTree = tree;
    layer.foldResolver.dividedFoldEndsByStartNodeId.set(7, [new Point(0, 0)]);
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();
    spyOn(layer.foldResolver, "reset").and.callThrough();

    replace(buffer, "prefix", "rename");
    await mode.atTransactionEnd();

    expect(layer.handleTextChange).not.toHaveBeenCalled();
    expect(tree.edit).not.toHaveBeenCalled();
    expect(layer.foldResolver.reset).toHaveBeenCalledTimes(1);
    expect(layer.tree).toBe(tree);
    expect(layer.getCurrentRanges()).toBe(ranges);
    expect(mode.isFoldableCache).toBe(foldRowCache);
    expect(layer.foldResolver.boundaries).toBeNull();
    expect(layer.foldResolver.boundariesRange).toBeNull();
    expect(layer.foldResolver.boundariesTree).toBeNull();
    expect(layer.foldResolver.dividedFoldEndsByStartNodeId.size).toBe(0);
    await expectFresh(buffer, mode);
  });

  it("routes equal-extent edits that touch the leading owner boundary", async () => {
    const { buffer, mode } = await start("prefix = 0\ninjected = 3\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const boundaryStart = layer.getExtent().start;
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    buffer.setTextInRange(
      new Range(new Point(boundaryStart.row, boundaryStart.column - 1), boundaryStart),
      "\t",
    );

    expect(layer.handleTextChange).toHaveBeenCalledTimes(1);
    expect(tree.edit).toHaveBeenCalledTimes(1);
    await mode.atTransactionEnd();
    await expectFresh(buffer, mode);
  });

  it("keeps the tree and ranges while invalidating an unchanged earlier injection's fold cache", async () => {
    const { buffer, mode } = await start("injected = 3\nsuffix = 0\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const ranges = layer.getCurrentRanges();
    const foldRowCache = mode.isFoldableCache;
    const boundaries = { cached: true };
    const boundaryRange = layer.getExtent();
    layer.foldResolver.boundaries = boundaries;
    layer.foldResolver.boundariesRange = boundaryRange;
    layer.foldResolver.boundariesTree = tree;
    layer.foldResolver.dividedFoldEndsByStartNodeId.set(7, [new Point(0, 0)]);
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();
    spyOn(layer.foldResolver, "reset").and.callThrough();

    replace(buffer, "suffix", "rename");
    await mode.atTransactionEnd();

    expect(layer.handleTextChange).not.toHaveBeenCalled();
    expect(tree.edit).not.toHaveBeenCalled();
    expect(layer.foldResolver.reset).toHaveBeenCalledTimes(1);
    expect(layer.tree).toBe(tree);
    expect(layer.getCurrentRanges()).toBe(ranges);
    expect(mode.isFoldableCache).toBe(foldRowCache);
    expect(layer.foldResolver.boundaries).toBeNull();
    expect(layer.foldResolver.boundariesRange).toBeNull();
    expect(layer.foldResolver.boundariesTree).toBeNull();
    expect(layer.foldResolver.dividedFoldEndsByStartNodeId.size).toBe(0);
    await expectFresh(buffer, mode);
  });

  it("routes equal-extent edits that touch the trailing owner boundary", async () => {
    const { buffer, mode } = await start("injected = 3   \nsuffix = 0\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const boundaryEnd = layer.getExtent().end;
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    buffer.setTextInRange(
      new Range(boundaryEnd, new Point(boundaryEnd.row, boundaryEnd.column + 1)),
      "\t",
    );

    expect(layer.handleTextChange).toHaveBeenCalledTimes(1);
    expect(tree.edit).toHaveBeenCalledTimes(1);
    await mode.atTransactionEnd();
    await expectFresh(buffer, mode);
  });

  it("invalidates the boolean fold cache once when skipped content ranges are unknown", async () => {
    const { buffer, mode } = await start("first = 3\nsecond = 4\nsuffix = 0\n");
    const children = layers(mode);
    const trees = children.map((layer) => layer.tree);
    expect(children.length).toBe(2);
    let cache = mode.isFoldableCache;
    let replacements = 0;
    const originalCache = cache;
    Object.defineProperty(mode, "isFoldableCache", {
      configurable: true,
      enumerable: true,
      get: () => cache,
      set: (value) => {
        cache = value;
        replacements++;
      },
    });
    for (const layer of children) {
      layer.currentRangesCache = undefined;
      spyOn(layer, "handleTextChange").and.callThrough();
      spyOn(layer.tree, "edit").and.callThrough();
    }

    replace(buffer, "suffix", "rename");
    expect(cache).not.toBe(originalCache);
    expect(replacements).toBe(1);
    await mode.atTransactionEnd();

    expect(replacements).toBe(1);
    for (let index = 0; index < children.length; index++) {
      const layer = children[index];
      expect(layer.handleTextChange).not.toHaveBeenCalled();
      expect(trees[index].edit).not.toHaveBeenCalled();
      expect(layer.tree).toBe(trees[index]);
    }
    await expectFresh(buffer, mode);
  });

  it("reevaluates fold predicates that inspect text before the injection on its row", async () => {
    rootGrammar.removeInjectionPoint(point);
    point = {
      type: "function_definition",
      language: () => "routing-child",
      content: (node) => node,
      includeChildren: true,
    };
    rootGrammar.addInjectionPoint(point);
    await childGrammar.setQueryForTest(
      "foldsQuery",
      `((function_definition) @fold
        (#is? test.firstTextOnRow true)
        (#set! fold.endAt endPosition))`,
    );
    const { buffer, mode } = await start("   def value():\n       return 3\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const ranges = layer.getCurrentRanges();
    expect(mode.getFoldableRanges().length).toBe(1);
    expect(mode.isFoldableAtRow(0)).toBe(true);
    expect(layer.foldResolver.boundariesTree).toBe(tree);
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    buffer.transact(() => {
      buffer.setTextInRange(new Range([0, 0], [0, 1]), "x");
      expect(layer.handleTextChange).not.toHaveBeenCalled();
      expect(tree.edit).not.toHaveBeenCalled();
      expect(layer.tree).toBe(tree);
      expect(layer.getCurrentRanges()).toBe(ranges);
      expect(mode.getFoldableRanges()).toEqual([]);
      expect(mode.isFoldableAtRow(0)).toBe(false);
    });
    await mode.atTransactionEnd();
    expect(mode.isFoldableAtRow(0)).toBe(false);
    await expectFresh(buffer, mode);

    const currentTree = layer.tree;
    const currentRanges = layer.getCurrentRanges();
    buffer.transact(() => {
      buffer.setTextInRange(new Range([0, 0], [0, 1]), " ");
      expect(layer.tree).toBe(currentTree);
      expect(layer.getCurrentRanges()).toBe(currentRanges);
      expect(mode.getFoldableRanges().length).toBe(1);
      expect(mode.isFoldableAtRow(0)).toBe(true);
    });
    await mode.atTransactionEnd();
    expect(mode.getFoldableRanges().length).toBe(1);
    expect(mode.isFoldableAtRow(0)).toBe(true);
    await expectFresh(buffer, mode);
  });

  it("reevaluates fold predicates that inspect text after the injection on its row", async () => {
    rootGrammar.removeInjectionPoint(point);
    point = {
      type: "string",
      language: () => "routing-child",
      content: (node) => node,
      includeChildren: true,
    };
    rootGrammar.addInjectionPoint(point);
    await childGrammar.setQueryForTest(
      "foldsQuery",
      `((string) @fold
        (#is? test.lastTextOnRow true)
        (#set! fold.endAt endPosition))`,
    );
    const { buffer, mode } = await start('"""value\nmore\n"""   \n');
    const [layer] = layers(mode);
    const tree = layer.tree;
    const ranges = layer.getCurrentRanges();
    const end = layer.getExtent().end;
    const suffix = new Range([end.row, end.column + 1], [end.row, end.column + 2]);
    expect(mode.getFoldableRanges().length).toBe(1);
    expect(mode.isFoldableAtRow(0)).toBe(true);
    expect(layer.foldResolver.getFoldRangeForRow(0)).not.toBeNull();
    expect(layer.foldResolver.boundariesTree).toBe(tree);
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    buffer.transact(() => {
      buffer.setTextInRange(suffix, ";");
      expect(layer.handleTextChange).not.toHaveBeenCalled();
      expect(tree.edit).not.toHaveBeenCalled();
      expect(layer.tree).toBe(tree);
      expect(layer.getCurrentRanges()).toBe(ranges);
      expect(mode.getFoldableRanges()).toEqual([]);
      expect(layer.foldResolver.getFoldRangeForRow(0)).toBeNull();
      expect(mode.isFoldableAtRow(0)).toBe(false);
    });
    await mode.atTransactionEnd();
    expect(layers(mode)).toEqual([layer]);
    expect(mode.isFoldableAtRow(0)).toBe(false);
    await expectFresh(buffer, mode);

    const currentTree = layer.tree;
    const currentRanges = layer.getCurrentRanges();
    buffer.transact(() => {
      buffer.setTextInRange(suffix, " ");
      expect(layer.handleTextChange).not.toHaveBeenCalled();
      expect(tree.edit).not.toHaveBeenCalled();
      expect(layer.tree).toBe(currentTree);
      expect(layer.getCurrentRanges()).toBe(currentRanges);
      expect(mode.getFoldableRanges().length).toBe(1);
      expect(layer.foldResolver.getFoldRangeForRow(0)).not.toBeNull();
      expect(mode.isFoldableAtRow(0)).toBe(true);
    });
    await mode.atTransactionEnd();
    expect(layers(mode)).toEqual([layer]);
    expect(mode.getFoldableRanges().length).toBe(1);
    expect(mode.isFoldableAtRow(0)).toBe(true);
    await expectFresh(buffer, mode);
  });

  it("translates rows when equal code-unit lengths have different end positions", async () => {
    const { buffer, mode } = await start("# pre\ninjected = 3\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const startIndex = tree.rootNode.startIndex;
    const startPosition = tree.rootNode.startPosition;
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    replace(buffer, "# pre", "\n#pre");

    expect(layer.handleTextChange).toHaveBeenCalledTimes(1);
    expect(tree.edit).toHaveBeenCalledTimes(1);
    expect(tree.rootNode.startIndex).toBe(startIndex);
    expect(tree.rootNode.startPosition).toEqual({
      row: startPosition.row + 1,
      column: startPosition.column,
    });
    await mode.atTransactionEnd();
    await expectFresh(buffer, mode);
  });

  it("translates indices when identical end positions have different code-unit lengths", async () => {
    const { buffer, mode } = await start("##\n# before\ninjected = 3\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const startIndex = tree.rootNode.startIndex;
    const startPosition = tree.rootNode.startPosition;
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    replace(buffer, "##\n", "#\n");

    expect(layer.handleTextChange).toHaveBeenCalledTimes(1);
    expect(tree.edit).toHaveBeenCalledTimes(1);
    expect(tree.rootNode.startIndex).toBe(startIndex - 1);
    expect(tree.rootNode.startPosition).toEqual(startPosition);
    await mode.atTransactionEnd();
    await expectFresh(buffer, mode);
  });

  it("preserves a preceding dirty child edit when skipping the later prefix edit", async () => {
    const { buffer, mode } = await start("prefix = 0\ninjected = 3\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    buffer.transact(() => {
      replace(buffer, "3", "4");
      replace(buffer, "prefix", "rename");
    });

    expect(layer.handleTextChange).toHaveBeenCalledTimes(1);
    expect(tree.edit).toHaveBeenCalledTimes(1);
    await mode.atTransactionEnd();
    expect(layers(mode)).toEqual([layer]);
    expect(layer.treeIsDirty).toBe(false);
    expect(layer.editedRange).toBeNull();
    expect(layer.tree.rootNode.text).toBe("4");
    await expectFresh(buffer, mode);
  });

  it("reconciles topology when an equal-extent prefix edit hides an injection", async () => {
    const { buffer, mode } = await start("pass; injected = 3\n");
    const [layer] = layers(mode);
    spyOn(layer, "handleTextChange").and.callThrough();

    replace(buffer, "pass;", "#xxxx");
    await mode.atTransactionEnd();

    expect(layer.handleTextChange).not.toHaveBeenCalled();
    expect(layer.destroyed).toBe(true);
    expect(layers(mode)).toEqual([]);
    await expectFresh(buffer, mode);

    buffer.undo();
    await mode.atTransactionEnd();
    expect(layers(mode).length).toBe(1);
    await expectFresh(buffer, mode);
  });

  it("routes edits to custom content that precedes its owner node", async () => {
    point.content = () => ({
      startIndex: 0,
      endIndex: 6,
      startPosition: new Point(0, 0),
      endPosition: new Point(0, 6),
    });
    const { buffer, mode } = await start("prefix = 0\ninjected = 3\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    expect(layer.getCurrentRanges()).toEqual([new Range([0, 0], [0, 6])]);
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    replace(buffer, "prefix", "rename");

    expect(layer.handleTextChange).toHaveBeenCalledTimes(1);
    expect(tree.edit).toHaveBeenCalledTimes(1);
    await mode.atTransactionEnd();
  });

  it("keeps a combined parser unchanged after an equal-extent leading edit", async () => {
    point.combined = true;
    const { buffer, mode } = await start("prefix = 0\nfirst = 3\nsecond = 4\n");
    const [layer] = layers(mode);
    const tree = layer.tree;
    const ranges = layer.getCurrentRanges();
    expect(ranges.length).toBe(2);
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(tree, "edit").and.callThrough();

    replace(buffer, "prefix", "rename");
    await mode.atTransactionEnd();

    expect(layer.handleTextChange).not.toHaveBeenCalled();
    expect(tree.edit).not.toHaveBeenCalled();
    expect(layer.tree).toBe(tree);
    expect(layer.getCurrentRanges()).toBe(ranges);
    await expectFresh(buffer, mode);
  });

  it("retains relevant edits while a child parse is suspended", async () => {
    const { buffer, mode } = await start("prefix = 0\ninjected = 3\n");
    const [layer] = layers(mode);
    const parseAsync = mode.parseAsync.bind(mode);
    let resume;
    let entered;
    const enteredPromise = new Promise((resolve) => (entered = resolve));
    const resumePromise = new Promise((resolve) => (resume = resolve));
    let suspended = false;
    spyOn(layer, "handleTextChange").and.callThrough();
    spyOn(mode, "parseAsync").and.callFake((language, oldTree, ranges, params) => {
      const result = parseAsync(language, oldTree, ranges, params);
      if (params.scopeName !== childGrammar.scopeName || suspended) return result;
      suspended = true;
      entered();
      return Promise.resolve(result).then((tree) => resumePromise.then(() => tree));
    });

    replace(buffer, "3", "4");
    try {
      await enteredPromise;
      replace(buffer, "prefix", "rename");
      replace(buffer, "4", "5");
      expect(layer.handleTextChange).toHaveBeenCalledTimes(2);
      const changes = layer.patchSinceCurrentParseStarted.getChanges();
      expect(changes.length).toBe(1);
      expect(changes[0].oldText).toBe("4");
      expect(changes[0].newText).toBe("5");
    } finally {
      resume();
    }
    await mode.atTransactionEnd();
    expect(layers(mode)).toEqual([layer]);
    expect(layer.tree.rootNode.text).toBe("5");
    expect(layer.patchSinceCurrentParseStarted).toBeNull();
    await expectFresh(buffer, mode);
  });
});
