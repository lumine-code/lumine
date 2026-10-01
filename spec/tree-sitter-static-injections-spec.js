const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Tree-sitter static injections", () => {
  for (const runtime of ["wasm", "node"]) {
    describe(runtime, () => {
      let registry, grammars, buffers, root;
      const callQuery = `
        (call
          function: (identifier) @injection.language
          arguments: (argument_list (integer) @injection.content)) @injection.owner
      `;

      function grammar(scopeName, injectionNames = []) {
        const file = require.resolve("language-python/grammars/python.json");
        const config = CSON.readFileSync(file);
        const result = new TreeSitterGrammar(registry, file, {
          ...config,
          scopeName,
          injectionNames,
          treeSitter:
            runtime === "wasm"
              ? { grammar: config.treeSitter.grammar }
              : { runtime: "node", languageModule: require.resolve("tree-sitter-python") },
        });
        grammars.push(result);
        registry.addGrammar(result);
        return result;
      }

      async function start(text, options = {}) {
        const buffer = new TextBuffer({ text });
        buffers.push(buffer);
        const mode = new TreeSitterLanguageMode({
          buffer,
          grammar: root,
          config: lumine.config,
          grammars: registry,
          ...options,
        });
        buffer.setLanguageMode(mode);
        await mode.ready;
        await mode.atGrammarSettlement();
        return { buffer, mode };
      }

      function layers(mode) {
        return mode.getAllInjectionLayers().filter((layer) => layer.depth === 1);
      }

      function contents(layer) {
        return layer.getCurrentRanges().map((range) => layer.buffer.getTextInRange(range));
      }

      async function replace(buffer, mode, from, to) {
        const range = buffer.findSync(from);
        if (!range) throw new Error(`Missing text: ${from}`);
        buffer.setTextInRange(range, to);
        await mode.atTransactionEnd();
        await mode.atGrammarSettlement();
      }

      beforeEach(async () => {
        jasmine.useRealClock();
        registry = new GrammarRegistry({ config: lumine.config });
        grammars = [];
        buffers = [];
        root = grammar("source.static-root");
        grammar("source.static-one", ["one"]);
        grammar("source.static-two", ["two"]);
        await root.setQueryForTest("injectionsQuery", callQuery);
      });

      afterEach(() => {
        for (const buffer of buffers) buffer.destroy();
        for (const item of grammars) item.deactivate();
        registry.clear();
      });

      it("loads static injections for the first parse and groups one owner's fragments", async () => {
        const { mode } = await start("one(10, 20)\ntwo(30)");
        expect(layers(mode).map((layer) => layer.grammar.scopeName)).toEqual([
          "source.static-one",
          "source.static-two",
        ]);
        expect(layers(mode).map(contents)).toEqual([["10", "20"], ["30"]]);
      });

      it("reports an invalid static query while keeping parsing and dynamic injections available", async () => {
        root.uncacheQuery("injectionsQuery");
        root.injectionsQuery = "(integer) @injection.content";
        const report = spyOn(root, "reportQueryError");
        root.addInjectionPoint({ type: "integer", language: () => "one", content: (node) => node });
        const { mode } = await start("value = 10");
        expect(mode.tree.rootNode.hasError).toBe(false);
        expect(report).toHaveBeenCalled();
        expect(layers(mode).map(contents)).toEqual([["10"]]);
      });

      it("validates the injection contract when validating the current buffer's queries", async () => {
        const { mode } = await start("one(10)");
        root.injectionsQuery =
          '((integer) @injection.owner @injection.content (#set! injection.language "one") (#set! injection.unknown "true"))';
        const failures = mode.validateGrammarQueries();
        expect(failures.length).toBe(1);
        expect(failures[0].queryType).toBe("injectionsQuery");
        expect(failures[0].message).toContain("unknown property injection.unknown");
      });

      it("changes the language when its control capture outside the content is edited", async () => {
        const { buffer, mode } = await start("one(10)");
        const old = layers(mode)[0];
        await replace(buffer, mode, "one", "two");
        expect(old.destroyed).toBe(true);
        expect(layers(mode).length).toBe(1);
        expect(layers(mode)[0].grammar.scopeName).toBe("source.static-two");
        expect(contents(layers(mode)[0])).toEqual(["10"]);
        await replace(buffer, mode, "two", "missing");
        expect(layers(mode).length).toBe(0);
      });

      it("reuses untouched layers and their stable pattern descriptors", async () => {
        const { buffer, mode } = await start("prefix = 0\none(10)\ntwo(20)");
        const before = layers(mode);
        const descriptors = before.map((layer) => layer.injectionPoint);
        await replace(buffer, mode, "10", "11");
        expect(layers(mode)).toEqual(before);
        expect(layers(mode).map((layer) => layer.injectionPoint)).toEqual(descriptors);
        await replace(buffer, mode, "prefix", "longer_prefix");
        expect(layers(mode)).toEqual(before);
        expect(layers(mode).map(contents)).toEqual([["11"], ["20"]]);
      });

      it("keeps static rules additive with dynamic rules having identical owners", async () => {
        const dynamic = {
          type: "call",
          language: () => "two",
          content: (node) => node.childForFieldName("arguments").descendantsOfType("integer"),
        };
        root.addInjectionPoint(dynamic);
        const { buffer, mode } = await start("one(10)");
        expect(layers(mode).length).toBe(2);
        const before = layers(mode);
        await replace(buffer, mode, "10", "11");
        expect(layers(mode)).toEqual(before);
        root.removeInjectionPoint(dynamic);
        await mode.atGrammarSettlement();
        expect(layers(mode).length).toBe(1);
        expect(layers(mode)[0].grammar.scopeName).toBe("source.static-one");
      });

      it("repopulates injections and invalidates old descriptors on query reload", async () => {
        const { mode } = await start("one(10)");
        const old = layers(mode)[0];
        await root.setQueryForTest(
          "injectionsQuery",
          `
          ((call arguments: (argument_list (integer) @injection.content)) @injection.owner
           (#set! injection.language "two"))
        `,
        );
        await mode.atGrammarSettlement();
        expect(old.destroyed).toBe(true);
        expect(layers(mode).map((layer) => layer.grammar.scopeName)).toEqual(["source.static-two"]);
        await root.setQueryForTest("injectionsQuery", "; empty");
        await mode.atGrammarSettlement();
        expect(layers(mode).length).toBe(0);
      });

      it("discovers a previously unavailable captured language when its grammar arrives", async () => {
        const { mode } = await start("later(10)");
        expect(layers(mode).length).toBe(0);
        mode.updateInjectionsForGrammar(grammar("source.static-later", ["later"]));
        await mode.atGrammarSettlement();
        expect(layers(mode).map((layer) => layer.grammar.scopeName)).toEqual([
          "source.static-later",
        ]);
      });

      it("bounds combined layers and reuses untouched groups on local edits", async () => {
        await root.setQueryForTest(
          "injectionsQuery",
          `
          ((integer) @injection.owner @injection.content
           (#set! injection.language "one")
           (#set! injection.combined)
           (#set! injection.combined-max-members "2")
           (#set! injection.language-scope "none"))
        `,
        );
        const { buffer, mode } = await start("a = 10\nb = 20\nc = 30\nd = 40\ne = 50");
        const before = layers(mode);
        expect(before.length).toBe(3);
        expect(before.map(contents)).toEqual([["10", "20"], ["30", "40"], ["50"]]);
        await replace(buffer, mode, "30", "31");
        expect(layers(mode)).toEqual(before);
        expect(layers(mode).map(contents)).toEqual([["10", "20"], ["31", "40"], ["50"]]);
        expect(layers(mode).every((layer) => layer.languageScope === null)).toBe(true);
      });

      it("merges matches crossing chunk boundaries without losing or repeating content", async () => {
        const { mode } = await start("one(10, 20, 30, 40, 50, 60)", {
          injectionCandidateChunkCodeUnits: 8,
          injectionReconcileChunkSize: 1,
        });
        expect(layers(mode).length).toBe(1);
        expect(contents(layers(mode)[0])).toEqual(["10", "20", "30", "40", "50", "60"]);
      });

      it("shares the compiled query across buffers and releases layer leases on destruction", async () => {
        const query = await root.getQuery("injectionsQuery");
        const compile = spyOn(root, "_createQuery").and.callThrough();
        const first = await start("one(10)");
        const second = await start("one(20)");
        expect(compile).not.toHaveBeenCalled();
        expect(root.queryReferenceCounts.get(query)).toBe(3);
        first.buffer.destroy();
        second.buffer.destroy();
        expect(root.queryReferenceCounts.get(query)).toBe(1);
      });

      it("cancels a yielded static scan after its buffer is destroyed", async () => {
        let resume;
        spyOn(TreeSitterLanguageMode.prototype, "_yieldForInjectionCandidateScan").and.callFake(
          () =>
            new Promise((resolve) => {
              resume = resolve;
            }),
        );
        const pending = start("one(10, 20, 30)", { injectionCandidateChunkCodeUnits: 4 });
        while (!resume) await new Promise((resolve) => setTimeout(resolve, 0));
        buffers[0].destroy();
        resume();
        const { mode } = await pending;
        expect(mode.destroyed).toBe(true);
        expect(layers(mode).length).toBe(0);
      });
    });
  }
});
