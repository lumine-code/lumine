const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TextBuffer = require("../src/text-buffer");
const { Point, Range } = TextBuffer;

describe("Root language ranges", () => {
  let registry, buffers, grammars, registrations;
  const scope = "source.test.root-ranges";

  function grammar(packageName = "language-javascript", fileName = "javascript", options = {}) {
    const file = require.resolve(`${packageName}/grammars/${fileName}.json`);
    const config = CSON.readFileSync(file);
    const result = new TreeSitterGrammar(registry, file, {
      ...config,
      scopeName: options.scopeName || scope,
      injectionNames: [options.alias || "root-ranges-test"],
      treeSitter: { ...config.treeSitter, ...options.treeSitter },
    });
    grammars.push(result);
    registrations.push(registry.addGrammar(result));
    return result;
  }

  function bodyRanges(buffer) {
    if (!buffer.lineForRow(0).startsWith("%%")) return null;
    if (buffer.getLastRow() === 0) return [];
    return [new Range(new Point(1, 0), buffer.getEndPosition())];
  }

  async function mode(text, provider = bodyRanges, rootGrammar = grammar()) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    if (provider) registry.setRootLanguageRanges(buffer, provider);
    registry.assignLanguageMode(buffer, rootGrammar.scopeName);
    const languageMode = buffer.getLanguageMode();
    await languageMode.ready;
    await languageMode.atGrammarSettlement();
    return { buffer, languageMode, rootGrammar };
  }

  beforeEach(() => {
    jasmine.useRealClock();
    registry = new GrammarRegistry({ config: lumine.config });
    buffers = [];
    grammars = [];
    registrations = [];
  });

  afterEach(() => {
    for (const buffer of buffers) buffer.destroy();
    for (const registration of registrations) registration.dispose();
    for (const entry of grammars) entry.deactivate();
    registry.clear();
  });

  it("excludes a header from the tree, scopes, and language membership", async () => {
    const { languageMode } = await mode("%%time\r\nconst alpha = 1;\r\n");
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    expect(languageMode.tree.rootNode.startPosition).toEqual({ row: 1, column: 0 });
    expect(languageMode.languageLayersAtPoint(new Point(0, 2), { exact: true })).toEqual([]);
    expect(languageMode.scopeDescriptorForPosition(new Point(0, 2)).scopes).not.toContain(scope);
    expect(languageMode.scopeDescriptorForPosition(new Point(1, 8)).scopes).toContain(scope);
    expect(languageMode.getSyntaxNodeAtPosition(new Point(0, 2))).toBeNull();
  });

  for (const source of ["%%time", "%%time\n"]) {
    it(`parses an empty body at EOF (${JSON.stringify(source)})`, async () => {
      const { buffer, languageMode } = await mode(source);
      expect(languageMode.tree.rootNode.hasError).toBe(false);
      expect(languageMode.tree.rootNode.namedChildCount).toBe(0);
      expect(languageMode.tree.rootNode.startIndex).toBe(buffer.getLength());
      expect(languageMode.tree.rootNode.endIndex).toBe(buffer.getLength());
    });
  }

  it("retains the null-policy fast path", async () => {
    const { languageMode } = await mode("const alpha = 1;", () => null);
    expect(languageMode.rootLanguageLayer.rootRangeSet).toBeNull();
    expect(languageMode.rootLanguageLayer.currentRangesLayer.getMarkerCount()).toBe(0);
    expect(languageMode.scopeDescriptorForPosition(new Point(0, 8)).scopes).toContain(scope);
  });

  it("does not reparse when a newly installed or disposed provider is effectively unrestricted", async () => {
    const { buffer, languageMode } = await mode("const alpha = 1;", null);
    const tree = languageMode.tree;
    const parse = spyOn(languageMode, "parseAsync").and.callThrough();
    const registration = registry.setRootLanguageRanges(buffer, () => null);
    registration.dispose();
    expect(parse).not.toHaveBeenCalled();
    expect(languageMode.tree).toBe(tree);
  });

  it("reuses the mode, old tree, root adapter, and marker across body and EOF edits", async () => {
    const { buffer, languageMode } = await mode("%%time\nconst alpha = 1;\n");
    const layer = languageMode.rootLanguageLayer;
    const adapter = layer.rootRangeSet;
    const version = adapter.version;
    const marker = layer.currentRangesLayer.getMarkers()[0];
    const parse = spyOn(languageMode, "parseAsync").and.callThrough();
    const invalidations = [];
    languageMode.onDidChangeHighlighting((range) => invalidations.push(range));
    buffer.setTextInRange(
      [
        [1, 14],
        [1, 15],
      ],
      "2",
    );
    await languageMode.atTransactionEnd();
    buffer.append("const beta = 3;\n");
    await languageMode.atTransactionEnd();
    expect(buffer.getLanguageMode()).toBe(languageMode);
    expect(layer.rootRangeSet).toBe(adapter);
    expect(adapter.version).toBe(version);
    expect(layer.currentRangesLayer.getMarkers()[0]).toBe(marker);
    expect(parse.calls.allArgs().every((args) => args[1] !== null)).toBe(true);
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    expect(invalidations.every((range) => range.start.row > 0)).toBe(true);
  });

  it("evaluates dynamic ranges on edits without replacing the provider", async () => {
    const { buffer, languageMode } = await mode("const alpha = 1;\n");
    buffer.insert(new Point(0, 0), "%%time\n");
    await languageMode.atTransactionEnd();
    expect(languageMode.tree.rootNode.startPosition.row).toBe(1);
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    buffer.setTextInRange(
      [
        [0, 0],
        [1, 0],
      ],
      "",
    );
    await languageMode.atTransactionEnd();
    expect(buffer.getLanguageMode()).toBe(languageMode);
    expect(languageMode.tree.rootNode.startPosition.row).toBe(0);
    expect(languageMode.rootLanguageLayer.rootRangesRestricted).toBe(false);
    expect(languageMode.rootLanguageLayer.currentRangesLayer.getMarkerCount()).toBe(0);
  });

  it("limits the synchronous tree used by autoindent inside a transaction", async () => {
    const rootGrammar = grammar();
    await rootGrammar.setQueryForTest("indentsQuery", '"{" @indent\n"}" @dedent');
    const { buffer, languageMode } = await mode(
      "%%time\nfunction alpha() {\n}\n",
      bodyRanges,
      rootGrammar,
    );
    buffer.transact(() => {
      buffer.insert(new Point(2, 0), "const beta = 1;\n");
      const tree = languageMode.rootLanguageLayer.getOrParseTree();
      expect(tree.rootNode.startPosition.row).toBe(1);
      expect(tree.rootNode.hasError).toBe(false);
      expect(languageMode.suggestedIndentForBufferRow(2, 2)).toBe(1);
    });
    await languageMode.atTransactionEnd();
    expect(languageMode.tree.rootNode.hasError).toBe(false);
  });

  it("restores full parsing on disposal and ignores disposal of a replaced policy", async () => {
    const { buffer, languageMode } = await mode("// header\nconst alpha = 1;", null);
    const first = registry.setRootLanguageRanges(buffer, (source) => [
      new Range(new Point(1, 0), source.getEndPosition()),
    ]);
    await languageMode.atTransactionEnd();
    expect(languageMode.tree.rootNode.descendantsOfType("comment").length).toBe(0);
    const second = registry.setRootLanguageRanges(buffer, () => []);
    await languageMode.atTransactionEnd();
    first.dispose();
    expect(languageMode.tree.rootNode.namedChildCount).toBe(0);
    second.dispose();
    await languageMode.atTransactionEnd();
    expect(languageMode.tree.rootNode.descendantsOfType("comment").length).toBe(1);
    expect(languageMode.rootLanguageLayer.rootRangesRestricted).toBe(false);
  });

  it("follows grammar replacement and releases its provider when the buffer dies", async () => {
    const { buffer, languageMode } = await mode("%%time\nconst alpha = 1;");
    grammar();
    const replacement = buffer.getLanguageMode();
    expect(replacement).not.toBe(languageMode);
    await replacement.ready;
    expect(replacement.tree.rootNode.hasError).toBe(false);
    expect(replacement.tree.rootNode.startPosition.row).toBe(1);
    expect(registry.serialize().rootLanguageRanges).toBeUndefined();
    buffer.destroy();
    expect(registry.rootLanguageRangesByBuffer.get(buffer)).toBeUndefined();
  });

  it("adopts a policy replacement while an earlier parse is suspended", async () => {
    const { buffer, languageMode } = await mode("// header\nconst alpha = 1;", null);
    const originalParse = languageMode.parseAsync.bind(languageMode);
    let resume;
    let suspended = false;
    spyOn(languageMode, "parseAsync").and.callFake((...args) => {
      const tree = originalParse(...args);
      if (suspended) return tree;
      suspended = true;
      return new Promise((resolve) => {
        resume = () => resolve(tree);
      });
    });
    registry.setRootLanguageRanges(buffer, (source) => [
      new Range(new Point(1, 0), source.getEndPosition()),
    ]);
    registry.setRootLanguageRanges(buffer, () => []);
    resume();
    const transaction = await languageMode.atTransactionEnd();
    expect(transaction.parseError).toBeNull();
    expect(languageMode.tree.rootNode.namedChildCount).toBe(0);
    expect(languageMode.tree.rootNode.startIndex).toBe(buffer.getLength());
  });

  it("limits a native Python root parser without modifying source", async () => {
    const rootGrammar = grammar("language-python", "python", {
      treeSitter: {
        runtime: "node",
        languageModule: require.resolve("tree-sitter-python"),
        highlightsQuery: [],
        foldsQuery: [],
        indentsQuery: [],
        tagsQuery: [],
        localsQuery: [],
      },
    });
    const source = "%%time\nvalue = 1\n";
    const { buffer, languageMode } = await mode(source, bodyRanges, rootGrammar);
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    expect(languageMode.tree.rootNode.startPosition.row).toBe(1);
    expect(buffer.getText()).toBe(source);
    buffer.append("next_value = 2\n");
    await languageMode.atTransactionEnd();
    expect(languageMode.tree.rootNode.hasError).toBe(false);
  });

  it("keeps child injections and their whitespace inside disjoint root ranges", async () => {
    const rootGrammar = grammar();
    grammar("language-html", "html", { scopeName: "text.test.root-ranges", alias: "range-html" });
    rootGrammar.addInjectionPoint({
      type: "program",
      language: () => "range-html",
      content: (_node) => ({
        startIndex: 0,
        endIndex: Infinity,
        startPosition: Point.ZERO,
        endPosition: Point.INFINITY,
        childCount: 0,
      }),
      includeChildren: true,
      includeAdjacentWhitespace: true,
      newlinesBetween: true,
    });
    const { languageMode } = await mode(
      "// header\nconst alpha = 1;\n   \nconst beta = 2;\n",
      () => [new Range([1, 0], [2, 0]), new Range([3, 0], [4, 0])],
      rootGrammar,
    );
    const [child] = languageMode.getAllInjectionLayers();
    expect(child).toBeDefined();
    expect(child.getCurrentRanges().map((range) => range.start.row)).toEqual([1, 3]);
    expect(child.containsPoint(new Point(0, 2))).toBe(false);
    expect(child.containsPoint(new Point(2, 1))).toBe(false);
  });

  it("reuses combined child layers when ordinary edits keep the root policy unchanged", async () => {
    const rootGrammar = grammar();
    grammar("language-html", "html", { scopeName: "text.test.root-ranges", alias: "range-html" });
    rootGrammar.addInjectionPoint({
      type: "template_string",
      language: () => "range-html",
      content: (node) => node.namedChildren,
      includeChildren: true,
      combined: true,
    });
    const { buffer, languageMode } = await mode(
      "%%time\nconst first = `<a>one</a>`;\nconst second = `<b>two</b>`;\n",
      bodyRanges,
      rootGrammar,
    );
    const [child] = languageMode.getAllInjectionLayers();
    const rootAdapter = languageMode.rootLanguageLayer.rootRangeSet;
    buffer.setTextInRange(
      [
        [1, 18],
        [1, 21],
      ],
      "new",
    );
    await languageMode.atTransactionEnd();
    expect(languageMode.getAllInjectionLayers()[0]).toBe(child);
    expect(languageMode.rootLanguageLayer.rootRangeSet).toBe(rootAdapter);
    expect(child.tree.rootNode.hasError).toBe(false);
  });
});
