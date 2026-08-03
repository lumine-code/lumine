const path = require("path");

// Compiles every query this package declares against its committed wasm.
//
// The editor's own sweep (`spec/grammar-query-validation-spec.js`) only covers
// grammars it ships, so a package living in its own repository needs this or it
// has no query gate at all — and a broken highlights query does NOT fail the
// grammar's other specs. LanguageLayer degrades to a placeholder instead, so
// everything else stays green while highlighting is silently dead.
//
// Bump EXPECTED_GRAMMARS when a grammar config is added or removed. Its job is
// to catch a config dropped by a JSON error or a renamed directory, which a
// count derived at runtime could never do.

const PACKAGE_NAME = "{{name}}";
const EXPECTED_GRAMMARS = 1;

describe(`${PACKAGE_NAME} Tree-sitter queries`, () => {
  let grammars;

  beforeEach(async () => {
    jasmine.useRealClock();
    await atom.packages.activatePackage(PACKAGE_NAME);

    // Every bundled grammar is registered too; keep only this package's.
    const packageDir = path.resolve(__dirname, "..");
    grammars = atom.grammars
      .getGrammars({ includeTreeSitter: true })
      .filter((grammar) => grammar.constructor.name === "TreeSitterGrammar")
      .filter((grammar) => grammar.grammarFilePath?.startsWith(packageDir));
  });

  it(`registers all ${EXPECTED_GRAMMARS} Tree-sitter grammar config(s)`, () => {
    expect(grammars.length).toBe(EXPECTED_GRAMMARS);
  });

  it("loads every parser and compiles every query", async () => {
    const failures = [];
    for (const grammar of grammars) {
      // Rejects outright if the wasm's ABI is outside the runtime's window.
      await grammar.getLanguage();

      for (const key of Object.keys(grammar.queryPaths ?? {})) {
        if (!key.endsWith("Query")) continue;
        try {
          await grammar.getQuery(key);
        } catch (error) {
          const descriptor = error.queryDescriptor ?? grammar.describeQueryError(error, key);
          failures.push(grammar.constructor.formatQueryErrorDescriptor(descriptor));
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
