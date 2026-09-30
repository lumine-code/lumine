const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");

describe("Injection registration lifecycle", () => {
  let registry, grammars;
  const scope = "source.test.injection-lifecycle";
  const point = { type: "comment", language: () => "html", content: (node) => node };

  function addGrammar() {
    const file = require.resolve("language-javascript/grammars/javascript.json");
    const grammar = new TreeSitterGrammar(registry, file, {
      ...CSON.readFileSync(file),
      scopeName: scope,
      injectionNames: ["injection-lifecycle-test"],
    });
    grammars.push(grammar);
    registry.addGrammar(grammar);
    return grammar;
  }

  beforeEach(() => {
    registry = new GrammarRegistry({ config: lumine.config });
    grammars = [];
  });

  afterEach(() => {
    for (const grammar of grammars) grammar.deactivate();
    registry.clear();
  });

  it("removes an owned injection from a grammar removed before its provider disposes", () => {
    const grammar = addGrammar();
    const registration = registry.addInjectionPoint(scope, point);
    registry.removeGrammar(grammar);
    registration.dispose();
    expect(grammar.injectionPointsByType.comment).toBeUndefined();
    registry.addGrammar(grammar);
    const next = registry.addInjectionPoint(scope, point);
    expect(grammar.injectionPointsByType.comment).toEqual([point]);
    next.dispose();
    expect(grammar.injectionPointsByType.comment).toBeUndefined();
  });

  it("also cleans the grammar that received a registration initially stored on a stub", () => {
    const registration = registry.addInjectionPoint(scope, point);
    const grammar = addGrammar();
    expect(grammar.injectionPointsByType.comment).toEqual([point]);
    registry.removeGrammar(grammar);
    registration.dispose();
    expect(grammar.injectionPointsByType.comment).toBeUndefined();
  });

  it("cleans both the captured grammar and a current replacement carrying the same injection", () => {
    const original = addGrammar();
    const registration = registry.addInjectionPoint(scope, point);
    const replacement = addGrammar();
    replacement.addInjectionPoint(point);
    registration.dispose();
    expect(original.injectionPointsByType.comment).toBeUndefined();
    expect(replacement.injectionPointsByType.comment).toBeUndefined();
  });

  it("does not remove unrelated injections from the replacement grammar", () => {
    const original = addGrammar();
    const registration = registry.addInjectionPoint(scope, point);
    const replacement = addGrammar();
    const other = { ...point };
    replacement.addInjectionPoint(other);
    registration.dispose();
    expect(original.injectionPointsByType.comment).toBeUndefined();
    expect(replacement.injectionPointsByType.comment).toEqual([other]);
  });
});
