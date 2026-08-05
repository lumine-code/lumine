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
// is a warning: a scope can legitimately carry the segment somewhere other than
// last (`meta.diff.header`, whose family is fixed by the TextMate diff bundle),
// so gating on it would mean maintaining an allowlist, and an allowlist rots.

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

// The bundled set is defined by src/bundled-packages.js: every dependency
// whose own manifest declares an engines.lumine range, resolved wherever the
// copy lives.
function bundledPackageDirs() {
  const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");
  return scanBundledPackageNames(ROOT)
    .map((name) => resolveBundledPackageDir(ROOT, name))
    .filter(Boolean);
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

// The language segment is read off the queries — the segment most of the
// captures already end in — rather than derived from the scope name, which is
// wrong for text.html.basic (html), source.json.jsonc (json), source.makefile
// (make) and source.python.ipy (python).
//
// It has to be an outright majority. A "used at least N times" threshold looks
// equivalent and is not: `begin`, `end` and `control` each end enough captures
// to clear one, so a package that had never been segmented at all read as a
// handful of stragglers. The two cases are far apart once measured — a file
// that carries its segment carries it on essentially every capture
// (ipython-highlights.scm 3/3, python's highlights.scm 139/139), while
// language-clojure's unsegmented queries peaked at 19%.
function dominantSegment(captures) {
  if (captures.length < 3) return null;
  const tally = new Map();
  for (const capture of captures) {
    const last = capture.split(".").pop();
    tally.set(last, (tally.get(last) ?? 0) + 1);
  }
  for (const [segment, count] of tally) {
    if (count * 2 > captures.length) return segment;
  }
  return null;
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

    // Pool the package's captures as a fallback, so an injection grammar with
    // two captures is judged by what the package as a whole uses rather than by
    // its own handful.
    const pooled = files.flatMap((queryPath) => capturesIn(queryPath));
    const packageSegments = new Set(["_LANG_", ...declaredSegments]);
    const pooledSegment = dominantSegment(pooled);
    if (pooledSegment) packageSegments.add(pooledSegment);

    for (const queryPath of files) {
      scanned++;
      const captures = capturesIn(queryPath);
      if (captures.length === 0) continue;

      // A file gets its own segment too. language-python's ipython queries are
      // wholly `.ipython`, but they load alongside 139 `.python` captures, so
      // the package-wide answer buries them; the same goes for any package
      // shipping more than one language (csv/tsv, the five git grammars).
      const accepted = new Set(packageSegments);
      const ownSegment = dominantSegment(captures);
      if (ownSegment) accepted.add(ownSegment);

      const where = path.relative(ROOT, queryPath).replace(/\\/g, "/");

      const notScopes = [...new Set(captures.filter((c) => !SCOPE_ROOTS.has(c.split(".")[0])))];
      if (notScopes.length > 0) {
        errors.push(`${where}: not a TextMate scope: ${notScopes.join(" ")}`);
      }

      // Any position counts, not just the last. `meta.diff.header` and
      // `meta.diff.range.unified` are the scope names the TextMate diff bundle
      // fixed a decade ago, and the tree-sitter grammar has to match its own
      // TextMate twin; appending a second `.diff` to satisfy a last-segment
      // rule would be the wrong fix.
      const odd = [
        ...new Set(captures.filter((c) => !c.split(".").some((segment) => accepted.has(segment)))),
      ];
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
