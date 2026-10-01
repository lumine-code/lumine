const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Combined injection equal-extent holes", () => {
  for (const runtime of ["wasm", "node"]) {
    describe(runtime, () => {
      let registry, grammars, buffers, root, child, grandchild, point;
      function grammar(scopeName, injectionNames) {
        const file = require.resolve("language-python/grammars/python.json");
        const config = CSON.readFileSync(file);
        const value = new TreeSitterGrammar(registry, file, {
          ...config,
          scopeName,
          injectionNames,
          treeSitter:
            runtime === "wasm"
              ? { grammar: config.treeSitter.grammar }
              : { runtime: "node", languageModule: require.resolve("tree-sitter-python") },
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
        ).toBe(1);
        expect(
          mode.getAllInjectionLayers().filter((layer) => layer.grammar === grandchild).length,
        ).toBe(2);
        await expectFresh(buffer, mode);
        await replace(buffer, mode, "3", "9");
        await expectFresh(buffer, mode);
      });
      it("keeps the conservative path for descendant definitions with no current matches", async () => {
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
        ).toBe(1);
        await expectFresh(buffer, mode);
        await replace(buffer, mode, "3", '"abc"');
        expect(
          mode.getAllInjectionLayers().filter((layer) => layer.grammar === grandchild).length,
        ).toBe(1);
        await expectFresh(buffer, mode);
      });
    });
  }
});
