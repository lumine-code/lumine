const fs = require("fs");
const path = require("path");
const CSON = require("@lumine-code/season");
// `LANGUAGE_VERSION` / `MIN_COMPATIBLE_VERSION` are assigned during
// `Parser.init()`, so they must be read lazily — not destructured at require
// time, when they are still undefined.
const TreeSitter = require("web-tree-sitter");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");

// Compiles every query of every bundled Tree-sitter grammar against its
// committed wasm. This is the safety net for grammar bumps: a parser update
// that renames or removes a node type referenced by any `.scm` file fails
// here with the offending grammar, query type, file, and line — including for
// language packages that have no spec suite of their own.

const EXPECTED_GRAMMAR_COUNT = 50;

const repoRoot = path.resolve(__dirname, "..");
const packageDependencies = Object.keys(require("../package.json").packageDependencies ?? {});

// Bundled packages are either vendored into `packages/` or delivered through
// `node_modules/` from a Git pin, so enumerate `packageDependencies` rather
// than reading `packages/` — that is the actual definition of "bundled", and
// it is how `PackageManager.getBundledPackageDescriptors` resolves them too.
function resolveBundledPackageDir(packageName) {
  for (let base of ["packages", "node_modules"]) {
    let packageDir = path.join(repoRoot, base, packageName);
    if (fs.existsSync(packageDir)) return packageDir;
  }
  return null;
}

// Grammar packages under development live outside this repository entirely,
// before they are pinned and installed. Point `LUMINE_GRAMMAR_PACKAGE_ROOTS`
// at a package checkout or at a directory of them to sweep those too. They are
// compiled but deliberately not counted: `EXPECTED_GRAMMAR_COUNT` guards the
// shipped set, and a tripwire whose value depends on a developer's environment
// is not a tripwire.
function packageDirsInRoot(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.existsSync(path.join(root, "grammars"))) return [root];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(root, dirent.name));
}

function extraPackageDirs() {
  return (process.env.LUMINE_GRAMMAR_PACKAGE_ROOTS ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((root) => packageDirsInRoot(path.resolve(root)));
}

function collectConfigsInPackage(packageDir, bundled) {
  let configs = [];
  let grammarsDir = path.join(packageDir, "grammars");
  if (!fs.existsSync(grammarsDir)) return configs;
  let packageName = path.basename(packageDir);
  for (let fileName of fs.readdirSync(grammarsDir)) {
    if (!/\.(json|cson)$/.test(fileName)) continue;
    let configPath = path.join(grammarsDir, fileName);
    let config;
    try {
      config = CSON.readFileSync(configPath);
    } catch {
      continue;
    }
    if (config.type !== "tree-sitter") continue;
    configs.push({ packageName, fileName, configPath, config, bundled });
  }
  return configs;
}

function collectGrammarConfigs() {
  let configs = [];
  let seen = new Set();
  let roots = [
    ...packageDependencies
      .map(resolveBundledPackageDir)
      .filter(Boolean)
      .map((dir) => [dir, true]),
    ...extraPackageDirs().map((dir) => [dir, false]),
  ];
  for (let [packageDir, bundled] of roots) {
    for (let entry of collectConfigsInPackage(packageDir, bundled)) {
      // A `file:` dependency resolves under both `packages/` and
      // `node_modules/`, and an extra root may overlap the repository.
      let key = entry.configPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      configs.push(entry);
    }
  }
  return configs;
}

const grammarConfigs = collectGrammarConfigs();
const bundledGrammarConfigs = grammarConfigs.filter((entry) => entry.bundled);

describe("bundled Tree-sitter grammars", () => {
  beforeEach(() => {
    jasmine.useRealClock();
  });

  it(`enumerates all ${EXPECTED_GRAMMAR_COUNT} bundled grammar configs`, () => {
    // If a grammar is added or removed, update EXPECTED_GRAMMAR_COUNT; this
    // guard exists so that configs silently dropped by a parse error or a
    // layout change fail loudly instead of being skipped.
    expect(
      bundledGrammarConfigs.map((entry) => `${entry.packageName}/${entry.fileName}`).sort().length,
    ).toBe(EXPECTED_GRAMMAR_COUNT);
  });

  for (let { packageName, fileName, configPath, config, bundled } of grammarConfigs) {
    let label = bundled ? `${packageName}/${fileName}` : `${packageName}/${fileName} (out of tree)`;
    it(`${label} (${config.scopeName}) loads and compiles all queries`, async () => {
      let grammar = new TreeSitterGrammar(atom.grammars, configPath, config);
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
            failures.push(TreeSitterGrammar.formatQueryErrorDescriptor(descriptor));
          }
        }
        expect(failures).toEqual([]);
      } finally {
        grammar.deactivate();
      }
    });
  }
});
