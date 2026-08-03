/*
 * Clones the upstream parser a grammar package is built from into the
 * package's gitignored `.dev/` directory, checked out at the pinned ref.
 *
 * Usage:
 *   node script/clone-parser.js <package-dir>...
 *   node script/clone-parser.js --all --package-root <dir-of-packages>
 *
 * Working on a grammar means constantly asking what the parse tree actually
 * looks like — which node types exist, which tokens are anonymous, what the
 * upstream queries say. Answering that from a shallow clone that has to be
 * fetched each time is slow enough that people guess instead, and guessing is
 * how a query ends up compiling cleanly and matching nothing.
 *
 * The clone is deliberately not the build cache: this one belongs to the
 * package, sits at the ref the package ships, and survives a cache wipe.
 */

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const CSON = require("@lumine-code/season");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
  if (result.status !== 0) {
    return { ok: false, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
  }
  return { ok: true, output: (result.stdout ?? "").trim() };
}

// `github:org/repo[/subdir]#ref` — the subdir names a grammar inside a
// multi-grammar repository and is not part of the clone URL.
function parseSource(parserSource) {
  const match = /^github:([^/#]+)\/([^/#]+)(\/[^#]+)?#(.+)$/.exec(parserSource ?? "");
  if (!match) return null;
  const [, org, repo, , ref] = match;
  return { org, repo, ref, url: `https://github.com/${org}/${repo}.git` };
}

function sourcesFor(packageDir) {
  const grammarsDir = path.join(packageDir, "grammars");
  if (!fs.existsSync(grammarsDir)) return [];
  const sources = new Map();
  for (const fileName of fs.readdirSync(grammarsDir)) {
    if (!/\.(json|cson)$/.test(fileName)) continue;
    let config;
    try {
      config = CSON.readFileSync(path.join(grammarsDir, fileName));
    } catch {
      continue;
    }
    const source = parseSource(config?.treeSitter?.parserSource);
    if (source) sources.set(`${source.org}/${source.repo}`, source);
  }
  return [...sources.values()];
}

function cloneInto(packageDir, source) {
  const target = path.join(packageDir, ".dev", source.repo);
  const label = `${path.basename(packageDir)} -> .dev/${source.repo}@${source.ref}`;

  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const clone = run("git", ["clone", "--quiet", source.url, target]);
    if (!clone.ok) return `FAILED  ${label}: ${clone.output.split("\n")[0]}`;
  } else {
    run("git", ["-C", target, "fetch", "--quiet", "--tags", "origin"]);
  }

  const checkout = run("git", ["-C", target, "checkout", "--quiet", "--detach", source.ref]);
  if (!checkout.ok) return `FAILED  ${label}: ${checkout.output.split("\n")[0]}`;
  return `ok      ${label}`;
}

function main() {
  const argv = process.argv.slice(2);
  const roots = [];
  const dirs = [];
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--all") all = true;
    else if (argv[i] === "--package-root")
      roots.push(argv[++i] ?? fail("--package-root needs a value"));
    else dirs.push(argv[i]);
  }

  if (all) {
    if (roots.length === 0) fail("--all needs at least one --package-root");
    for (const root of roots) {
      for (const name of fs.readdirSync(path.resolve(root))) {
        dirs.push(path.join(path.resolve(root), name));
      }
    }
  }
  if (dirs.length === 0)
    fail("give one or more package directories, or --all --package-root <dir>");

  let cloned = 0;
  for (const dir of dirs) {
    const packageDir = path.resolve(dir);
    for (const source of sourcesFor(packageDir)) {
      console.log(cloneInto(packageDir, source));
      cloned++;
    }
  }
  console.log(`\n${cloned} parser clone(s) up to date.`);
}

module.exports = { parseSource, sourcesFor };

if (require.main === module) main();
