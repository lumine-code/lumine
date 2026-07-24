const fs = require("fs");
const path = require("path");
const CSON = require("@lumine-code/season");
// `LANGUAGE_VERSION` / `MIN_COMPATIBLE_VERSION` are assigned during
// `Parser.init()`, so they must be read lazily — not destructured at require
// time, when they are still undefined.
const TreeSitter = require("web-tree-sitter");
const WASMTreeSitterGrammar = require("../src/wasm-tree-sitter-grammar");

// Compiles every query of every bundled Tree-sitter grammar against its
// committed wasm. This is the safety net for grammar bumps: a parser update
// that renames or removes a node type referenced by any `.scm` file fails
// here with the offending grammar, query type, file, and line — including for
// language packages that have no spec suite of their own.

const EXPECTED_GRAMMAR_COUNT = 35;

const packagesDir = path.resolve(__dirname, "..", "packages");

function collectGrammarConfigs() {
  let configs = [];
  for (let packageName of fs.readdirSync(packagesDir)) {
    let grammarsDir = path.join(packagesDir, packageName, "grammars");
    if (!fs.existsSync(grammarsDir)) continue;
    for (let fileName of fs.readdirSync(grammarsDir)) {
      if (!/\.(json|cson)$/.test(fileName)) continue;
      let configPath = path.join(grammarsDir, fileName);
      let config;
      try {
        config = CSON.readFileSync(configPath);
      } catch {
        continue;
      }
      if (config.type !== "modern-tree-sitter") continue;
      configs.push({ packageName, fileName, configPath, config });
    }
  }
  return configs;
}

const grammarConfigs = collectGrammarConfigs();

describe("bundled Tree-sitter grammars", () => {
  beforeEach(() => {
    jasmine.useRealClock();
  });

  it(`enumerates all ${EXPECTED_GRAMMAR_COUNT} bundled grammar configs`, () => {
    // If a grammar is added or removed, update EXPECTED_GRAMMAR_COUNT; this
    // guard exists so that configs silently dropped by a parse error or a
    // layout change fail loudly instead of being skipped.
    expect(
      grammarConfigs.map((entry) => `${entry.packageName}/${entry.fileName}`).sort().length,
    ).toBe(EXPECTED_GRAMMAR_COUNT);
  });

  for (let { packageName, fileName, configPath, config } of grammarConfigs) {
    it(`${packageName}/${fileName} (${config.scopeName}) loads and compiles all queries`, async () => {
      let grammar = new WASMTreeSitterGrammar(atom.grammars, configPath, config);
      try {
        let language = await grammar.getLanguage();

        expect(language.abiVersion).toBeGreaterThanOrEqual(TreeSitter.MIN_COMPATIBLE_VERSION);
        expect(language.abiVersion).toBeLessThanOrEqual(TreeSitter.LANGUAGE_VERSION);

        let failures = [];
        for (let key of Object.keys(config.treeSitter)) {
          if (!key.endsWith("Query")) continue;
          try {
            await grammar.getQuery(key);
          } catch (error) {
            let descriptor = error.queryDescriptor ?? grammar.describeQueryError(error, key);
            failures.push(WASMTreeSitterGrammar.formatQueryErrorDescriptor(descriptor));
          }
        }
        expect(failures).toEqual([]);
      } finally {
        grammar.deactivate();
      }
    });
  }
});
