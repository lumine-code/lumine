const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const { Range } = TextBuffer;
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Tree-sitter complete child-row exclusions", () => {
  for (const runtime of ["wasm", "node"])
    describe(runtime, () => {
      let registry, root, child, buffer;
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
        registry.addGrammar(value);
        return value;
      }
      beforeEach(() => {
        jasmine.useRealClock();
        registry = new GrammarRegistry({ config: lumine.config });
        root = grammar("source.row-root", []);
        child = grammar("source.row-child", ["row-python"]);
      });
      afterEach(() => {
        buffer?.destroy();
        root.deactivate();
        child.deactivate();
        registry.clear();
      });
      const spec = (range, target) => ({
        startIndex: target.characterIndexForPosition(range.start),
        endIndex: target.characterIndexForPosition(range.end),
        startPosition: range.start,
        endPosition: range.end,
      });
      async function start(text, holes, bounds, options = {}) {
        buffer = new TextBuffer({ text });
        root.addInjectionPoint({
          type: "module",
          language: () => "row-python",
          excludeChildrenLines: true,
          content(_node, target) {
            const children = holes(target).map((range) => spec(range, target));
            return {
              ...spec(bounds?.(target) || target.getRange(), target),
              childCount: children.length,
              child: (index) => children[index],
            };
          },
          ...options,
        });
        const mode = new TreeSitterLanguageMode({
          buffer,
          grammar: root,
          grammars: registry,
          config: lumine.config,
        });
        buffer.setLanguageMode(mode);
        await mode.ready;
        await mode.atGrammarSettlement();
        return mode;
      }
      const contents = (layer) =>
        layer.getCurrentRanges().map((range) => buffer.getTextInRange(range));

      it("removes dangling magic RHS rows, merges overlapping rows and retains following Python", async () => {
        const mode = await start(
          "before = (\r\n  1\r\n)\r\ncwd = %pwd; other = !dir\r\nafter = 2\r\n",
          () => [new Range([3, 6], [3, 10]), new Range([3, 20], [3, 24])],
        );
        const layer = mode.getAllInjectionLayers()[0];
        expect(contents(layer)).toEqual(["before = (\r\n  1\r\n)\r\n", "after = 2\r\n"]);
        expect(layer.tree.rootNode.hasError).toBe(false);
        expect(
          layer.tree.rootNode
            .descendantsOfType("assignment")
            .map((node) => node.childForFieldName("left").text),
        ).toEqual(["before", "after"]);
      });

      it("clips exclusions to the content body and EOF without consuming the next row", async () => {
        const mode = await start(
          "prefix keep\nfirst\nsecond\nlast",
          () => [new Range([0, 9], [2, 0]), new Range([3, 2], [3, 4])],
          () => new Range([0, 7], [3, 4]),
        );
        expect(contents(mode.getAllInjectionLayers()[0])).toEqual(["second\n"]);
      });

      it("ignores the row option when children are included and retains root policy identity", async () => {
        const mode = await start("value = 1\n", () => [new Range([0, 8], [0, 9])], null, {
          includeChildren: true,
          combined: true,
        });
        const policy = registry.setRootLanguageRanges(buffer, (target) => [target.getRange()]);
        await mode.atGrammarSettlement();
        const rangeSet = mode.rootLanguageLayer.rootRangeSet;
        const layer = mode.getAllInjectionLayers()[0];
        expect(contents(layer)).toEqual(["value = 1\n"]);
        buffer.setTextInRange(
          [
            [0, 8],
            [0, 9],
          ],
          "22",
        );
        await mode.atTransactionEnd();
        await mode.atGrammarSettlement();
        expect(mode.rootLanguageLayer.rootRangeSet).toBe(rangeSet);
        expect(mode.getAllInjectionLayers()[0]).toBe(layer);
        expect(contents(layer)).toEqual(["value = 22\n"]);
        policy.dispose();
      });

      it("loads the new boolean from a static query without changing ordinary content", async () => {
        await root.setQueryForTest(
          "injectionsQuery",
          '((module) @injection.owner @injection.content (#set! injection.language "row-python") (#set! injection.include-children) (#set! injection.exclude-children-lines))',
        );
        buffer = new TextBuffer({ text: "value = 1\n" });
        const mode = new TreeSitterLanguageMode({
          buffer,
          grammar: root,
          grammars: registry,
          config: lumine.config,
        });
        buffer.setLanguageMode(mode);
        await mode.ready;
        await mode.atGrammarSettlement();
        const layer = mode.getAllInjectionLayers()[0];
        expect(layer.injectionPoint.excludeChildrenLines).toBe(true);
        expect(contents(layer)).toEqual(["value = 1\n"]);
      });
    });
});
