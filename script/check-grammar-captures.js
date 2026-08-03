// Verifies that every capture in a Tree-sitter grammar's highlights query is
// actually a TextMate scope.
//
// This exists because the failure it catches is invisible everywhere else. A
// capture left with its Neovim name — `@tag.delimiter`, `@spell`, `@embedded` —
// *compiles*, and it *matches*. `spec/grammar-query-validation-spec.js` proves
// the query compiles, so it passes. The package's own specs pass. The grammar
// loads. The only symptom is that the capture themes as nothing and no scope
// selector can see it, which nobody notices until someone asks why a token is
// grey. Twenty grammars had shipped in that state.
//
//   node script/check-grammar-captures.js
//   node script/check-grammar-captures.js --package-root ../language-lua
//
// Only `highlightsQuery` is checked. folds, indents, tags and locals have
// vocabularies of their own (`@fold`, `@indent`, `@name`, `@local.scope`), so
// measuring them against scope names would be meaningless.
//
// Two classes are reported. A capture whose first segment is not a TextMate
// root is an error and fails the build. A capture missing its language segment
// is a warning: several are legitimate scope names that simply carry no segment
// (`markup.list.numbered`, `meta.diff.header`), so gating on it would mean
// maintaining an allowlist, and an allowlist rots.

const fs = require("fs");
const path = require("path");
const CSON = require("@lumine-code/season");

const ROOT = path.join(__dirname, "..");

// Every TextMate scope begins with one of these. Anything else is a capture the
// port left behind.
const SCOPE_ROOTS = new Set([
  "comment",
  "constant",
  "entity",
  "invalid",
  "keyword",
  "markup",
  "meta",
  "punctuation",
  "source",
  "storage",
  "string",
  "support",
  "text",
  "variable",
]);

function parseArgs(argv) {
  const packageRoots = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package-root") {
      const value = argv[++i];
      if (!value) {
        console.error("ERROR: --package-root needs a value");
        process.exit(1);
      }
      packageRoots.push(value);
    } else {
      console.error(`ERROR: unknown option: ${argv[i]}`);
      process.exit(1);
    }
  }
  return { packageRoots };
}

// A bundled package is either vendored into packages/ or delivered through
// node_modules/ from a Git pin, which is the same rule the grammar sweep and
// the wasm builder use.
function bundledPackageDirs() {
  const names = Object.keys(require(path.join(ROOT, "package.json")).packageDependencies ?? {});
  const dirs = [];
  for (const name of names) {
    for (const base of ["packages", "node_modules"]) {
      const dir = path.join(ROOT, base, name);
      if (fs.existsSync(dir)) {
        dirs.push(dir);
        break;
      }
    }
  }
  return dirs;
}

// A root is either a package checkout (it holds grammars/ itself) or a
// directory of them.
function packageDirsInRoot(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.existsSync(path.join(root, "grammars"))) return [root];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

// Returns the package's highlight queries, and the language segments its
// configs declare. Those declared segments matter: the frequency heuristic
// below needs a few captures to work with, and a small query file (an injection
// grammar, a one-rule dialect) never has them.
function highlightsIn(packageDir) {
  const grammarsDir = path.join(packageDir, "grammars");
  if (!fs.existsSync(grammarsDir)) return { files: [], declaredSegments: new Set() };

  const files = [];
  const declaredSegments = new Set();

  for (const fileName of fs.readdirSync(grammarsDir)) {
    if (!/\.(json|jsonc|cson)$/.test(fileName)) continue;
    let config;
    try {
      config = CSON.readFileSync(path.join(grammarsDir, fileName));
    } catch {
      continue;
    }
    if (config?.type !== "tree-sitter") continue;

    if (config.treeSitter?.languageSegment) declaredSegments.add(config.treeSitter.languageSegment);
    if (config.scopeName) declaredSegments.add(config.scopeName.split(".").pop());

    for (const relative of [].concat(config.treeSitter?.highlightsQuery ?? [])) {
      const queryPath = path.join(grammarsDir, relative);
      if (fs.existsSync(queryPath)) files.push(queryPath);
    }
  }
  return { files, declaredSegments };
}

// Strings before comments, and comments to end-of-line. A CSS query writes
// `"@media"` and an Objective-C one `"@interface"` — those at-signs belong to
// the language, not to a capture — and `; @interface :(` is a trailing comment.
// Reversing this order reports a dozen grammars that are perfectly fine.
function capturesIn(queryPath) {
  let source = fs.readFileSync(queryPath, "utf8");
  source = source.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  source = source.replace(/;.*$/gm, "");

  const captures = [];
  for (const match of source.matchAll(/@([A-Za-z_][A-Za-z0-9_.-]*)/g)) {
    const capture = match[1];
    if (capture === "_IGNORE_" || capture.startsWith("_IGNORE_.")) continue;
    captures.push(capture);
  }
  return captures;
}

// The language segment is read off the file — the final segment most of its own
// captures already end in — rather than derived from the scope name, which is
// wrong for text.html.basic (html), source.json.jsonc (json), source.makefile
// (make) and source.python.ipy (python).
function segmentsUsedBy(captures) {
  const tally = new Map();
  for (const capture of captures) {
    const last = capture.split(".").pop();
    tally.set(last, (tally.get(last) ?? 0) + 1);
  }
  const used = new Set(["_LANG_"]);
  for (const [segment, count] of tally) if (count >= 3) used.add(segment);
  return used;
}

function main() {
  const { packageRoots } = parseArgs(process.argv.slice(2));

  const packageDirs = [
    ...bundledPackageDirs(),
    ...packageRoots.flatMap((root) => packageDirsInRoot(path.resolve(root))),
  ];

  const errors = [];
  const warnings = [];
  let scanned = 0;

  for (const packageDir of packageDirs) {
    const { files, declaredSegments } = highlightsIn(packageDir);

    // Pool the package's captures before measuring segment frequency, so a
    // dialect or injection grammar with three captures is judged by what the
    // package as a whole uses rather than by its own handful.
    const pooled = files.flatMap((queryPath) => capturesIn(queryPath));
    const accepted = new Set([...segmentsUsedBy(pooled), ...declaredSegments]);

    for (const queryPath of files) {
      scanned++;
      const captures = capturesIn(queryPath);
      if (captures.length === 0) continue;

      const where = path.relative(ROOT, queryPath).replace(/\\/g, "/");

      const notScopes = [...new Set(captures.filter((c) => !SCOPE_ROOTS.has(c.split(".")[0])))];
      if (notScopes.length > 0) {
        errors.push(`${where}: not a TextMate scope: ${notScopes.join(" ")}`);
      }

      const odd = [...new Set(captures.filter((c) => !accepted.has(c.split(".").pop())))];
      if (odd.length > 0) {
        warnings.push(`${where}: no language segment: ${odd.join(" ")}`);
      }
    }
  }

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `grammar captures: ${packageDirs.length} packages, ${scanned} highlights quer${scanned === 1 ? "y" : "ies"} scanned, ` +
      `${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
