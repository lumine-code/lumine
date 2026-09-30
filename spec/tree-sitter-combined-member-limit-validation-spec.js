const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");

describe("Combined injection member limit registration", () => {
  let registry, grammar;
  const scope = "source.test.combined-member-limit";
  const point = () => ({
    type: "comment",
    combined: true,
    language: () => "html",
    content: (node) => node,
  });

  beforeEach(() => {
    registry = new GrammarRegistry({ config: lumine.config });
    const file = require.resolve("language-javascript/grammars/javascript.json");
    grammar = new TreeSitterGrammar(registry, file, {
      ...CSON.readFileSync(file),
      scopeName: scope,
      injectionNames: ["combined-member-limit-test"],
    });
  });

  afterEach(() => {
    grammar.deactivate();
    registry.clear();
  });

  it("rejects invalid limits before an unloaded grammar receives a stub", () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity, "128", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        registry.addInjectionPoint(scope, { ...point(), combinedMaxMembers: limit }),
      ).toThrowError(TypeError, "combinedMaxMembers must be a positive safe integer");
      expect(registry.treeSitterGrammarsById[scope]).toBeUndefined();
    }
  });

  it("rejects invalid direct registrations without storing or emitting them", () => {
    const onAdded = jasmine.createSpy("onAdded");
    const subscription = grammar.onDidAddInjectionPoint(onAdded);
    try {
      for (const limit of [0, -1, 1.5, NaN, Infinity, "128", null]) {
        expect(() =>
          grammar.addInjectionPoint({ ...point(), combinedMaxMembers: limit }),
        ).toThrowError(TypeError, "combinedMaxMembers must be a positive safe integer");
        expect(grammar.injectionPointsByType.comment).toBeUndefined();
      }
      expect(onAdded).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
    }
  });

  it("retains an explicit positive limit when a queued registration reaches a grammar", () => {
    const descriptor = { ...point(), combinedMaxMembers: 1 };
    const registration = registry.addInjectionPoint(scope, descriptor);
    registry.addGrammar(grammar);
    expect(grammar.injectionPointsByType.comment).toEqual([descriptor]);
    expect(grammar.injectionPointsByType.comment[0].combinedMaxMembers).toBe(1);
    registration.dispose();
    expect(grammar.injectionPointsByType.comment).toBeUndefined();
  });

  it("accepts an omitted limit on a loaded grammar", () => {
    registry.addGrammar(grammar);
    const descriptor = point();
    const registration = registry.addInjectionPoint(scope, descriptor);
    expect(grammar.injectionPointsByType.comment).toEqual([descriptor]);
    registration.dispose();
    expect(grammar.injectionPointsByType.comment).toBeUndefined();
  });
});
