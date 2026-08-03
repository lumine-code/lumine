/*
 * Rebuilds a bundled Tree-sitter grammar wasm reproducibly from its pinned
 * `parserSource`, verifies the result against the installed `web-tree-sitter`
 * runtime, and installs it (plus provenance metadata) into every grammar
 * config that shares the same source.
 *
 * Usage:
 *   node script/build-grammar-wasm.js <path-to-grammar-config.json> [options]
 *   node script/build-grammar-wasm.js --all [options]
 *   node script/build-grammar-wasm.js --check
 *
 * Options:
 *   --source <github:org/repo[/subdir]#ref>  bump parserSource before building
 *   --cli-version <x.y.z>  override the default tree-sitter-cli version
 *   --cache-dir <dir>      cache root (default ~/.lumine-grammar-cache, or
 *                          env LUMINE_GRAMMAR_CACHE)
 *   --package-root <dir>   additional package root to scan, repeatable; also
 *                          read from LUMINE_GRAMMAR_PACKAGE_ROOTS. Use for
 *                          grammar packages that live in their own repository
 *                          rather than in packages/. The package owning an
 *                          explicitly passed config is always in scope, so a
 *                          single-config build needs no flag.
 *   --diff-node-types      diff node types/fields of old vs new wasm
 *   --regenerate           run `tree-sitter generate` instead of using the
 *                          shipped src/parser.c (lifts the wasm to this CLI's
 *                          ABI; needs the grammar's npm deps in some repos)
 *   --check                no build: load every committed wasm, report ABI,
 *                          exit 1 if any falls outside the supported window
 *   --dry-run              build and verify but do not touch the repo
 *
 * Requires emscripten: `emcc` on PATH, or an emsdk checkout at $EMSDK or
 * ~/.lumine-grammar-cache/emsdk (clone emscripten-core/emsdk there and run
 * `emsdk install latest && emsdk activate latest`).
 */

const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const CSON = require("@lumine-code/season");

const DEFAULT_TREE_SITTER_CLI = "0.26.11";
const REPO_ROOT = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
// An emsdk checkout inside the build cache keeps the whole toolchain
// self-contained: `git clone https://github.com/emscripten-core/emsdk` there,
// then `emsdk install latest && emsdk activate latest`. `ensureEmscripten`
// resolves it against $EMSDK, the active cache dir, and the default cache.

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  const result = cp.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) {
    fail(`'${printable}' failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    fail(`'${printable}' exited with status ${result.status}`);
  }
  return result.stdout ?? "";
}

function tryRun(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return result.error ? { status: -1, stdout: "", stderr: String(result.error) } : result;
}

// --- argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const options = {
    configPath: null,
    all: false,
    check: false,
    dryRun: false,
    regenerate: false,
    diffNodeTypes: false,
    source: null,
    cliVersion: DEFAULT_TREE_SITTER_CLI,
    cacheDir:
      process.env.LUMINE_GRAMMAR_CACHE || path.join(os.homedir(), ".lumine-grammar-cache"),
    packageRoots: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--all":
        options.all = true;
        break;
      case "--check":
        options.check = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--regenerate":
        options.regenerate = true;
        break;
      case "--diff-node-types":
        options.diffNodeTypes = true;
        break;
      case "--source":
        options.source = argv[++i] ?? fail("--source needs a value");
        break;
      case "--cli-version":
        options.cliVersion = argv[++i] ?? fail("--cli-version needs a value");
        break;
      case "--cache-dir":
        options.cacheDir = argv[++i] ?? fail("--cache-dir needs a value");
        break;
      case "--package-root":
        options.packageRoots.push(argv[++i] ?? fail("--package-root needs a value"));
        break;
      default:
        if (arg.startsWith("--")) fail(`Unknown option: ${arg}`);
        if (options.configPath) fail("Only one grammar config may be given");
        options.configPath = path.resolve(arg);
    }
  }
  if (!options.check && !options.all && !options.configPath) {
    fail("Give a grammar config path, --all, or --check. See the header of this script.");
  }
  return options;
}

// --- grammar config handling ------------------------------------------------

// `parserSource` format: `github:ORG/REPO[/SUBDIR...]#REF` (the gfm grammars
// are the precedent for the SUBDIR form).
function parseParserSource(parserSource) {
  const match = /^github:([^/#]+)\/([^/#]+)((?:\/[^#]+)?)#(.+)$/.exec(parserSource ?? "");
  if (!match) {
    return null;
  }
  const [, org, repo, subdirRaw, ref] = match;
  return {
    org,
    repo,
    subdir: subdirRaw ? subdirRaw.replace(/^\//, "") : null,
    ref,
    url: `https://github.com/${org}/${repo}.git`,
  };
}

// A root is either a single package checkout (it holds `grammars/` itself, as
// a language-* repository does) or a directory of packages (`packages/`).
function packageDirsInRoot(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.existsSync(path.join(root, "grammars"))) return [root];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(root, dirent.name));
}

function collectAllConfigs(roots = [PACKAGES_DIR]) {
  const configs = [];
  const seen = new Set();
  for (const root of roots) {
    for (const packageDir of packageDirsInRoot(root)) {
      const grammarsDir = path.join(packageDir, "grammars");
      if (!fs.existsSync(grammarsDir)) continue;
      for (const fileName of fs.readdirSync(grammarsDir)) {
        if (!/\.(json|cson)$/.test(fileName)) continue;
        const configPath = path.join(grammarsDir, fileName);
        // Roots may overlap; a config must never join a family twice.
        const key = configPath.toLowerCase();
        if (seen.has(key)) continue;
        let config;
        try {
          config = CSON.readFileSync(configPath);
        } catch {
          continue;
        }
        if (config.type !== "tree-sitter" || !config.treeSitter?.grammar) continue;
        seen.add(key);
        configs.push({ packageName: path.basename(packageDir), configPath, config });
      }
    }
  }
  return configs;
}

// `--all` and `--check` deliberately default to this repository's packages
// only: a gate whose membership depends on what happens to be checked out
// beside it means something different on CI than it does on a developer's
// disk. Extra roots are always opt-in, via `--package-root` or the env var.
function resolvePackageRoots(options) {
  const roots = [
    PACKAGES_DIR,
    ...(process.env.LUMINE_GRAMMAR_PACKAGE_ROOTS ?? "").split(path.delimiter).filter(Boolean),
    ...options.packageRoots,
  ];
  // The package owning an explicitly passed config is always in scope, so
  // building an out-of-tree grammar needs no flags at all.
  if (options.configPath) roots.push(path.resolve(path.dirname(options.configPath), ".."));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function wasmPathForConfig(entry) {
  return path.join(path.dirname(entry.configPath), entry.config.treeSitter.grammar);
}

// Updates `parserSource` / `wasmBuildTool` by targeted raw-text replacement so
// comments and formatting in the config file survive (never parse/stringify).
function writeBackMetadata(configPath, { parserSource, wasmBuildTool }) {
  let text = fs.readFileSync(configPath, "utf8");

  const replaceValue = (key, value) => {
    const pattern = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, "g");
    const matches = text.match(pattern);
    if (!matches || matches.length !== 1) {
      fail(`Expected exactly one "${key}" entry in ${configPath}, found ${matches?.length ?? 0}`);
    }
    text = text.replace(pattern, `$1${value}$2`);
  };

  if (parserSource) replaceValue("parserSource", parserSource);
  if (wasmBuildTool) {
    if (text.includes('"wasmBuildTool"')) {
      replaceValue("wasmBuildTool", wasmBuildTool);
    } else {
      // Insert directly beneath the parserSource line, matching its indent.
      const lineMatch = /^([ \t]*)("parserSource"\s*:\s*"[^"]*",?)\s*$/m.exec(text);
      if (!lineMatch) fail(`Cannot find a "parserSource" line in ${configPath}`);
      const [line, indent, entry] = lineMatch;
      // A comma on the parserSource line means more keys follow it, so the
      // inserted line needs one too. Without it the object is invalid JSON.
      // When parserSource is the last key the comma moves onto it instead,
      // because the inserted line becomes the last one.
      const trailingComma = entry.endsWith(",") ? "," : "";
      const entryWithComma = trailingComma ? entry : `${entry},`;
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      text = text.replace(
        line,
        `${indent}${entryWithComma}${newline}${indent}"wasmBuildTool": "${wasmBuildTool}"${trailingComma}`,
      );
    }
  }
  fs.writeFileSync(configPath, text);
}

// --- toolchain acquisition ---------------------------------------------------

function ensureRepoCheckout(sourceInfo, cacheDir) {
  const repoDir = path.join(cacheDir, "repos", `${sourceInfo.org}__${sourceInfo.repo}`);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    console.log(`Cloning ${sourceInfo.url} …`);
    run("git", ["clone", "-c", "core.autocrlf=false", sourceInfo.url, repoDir]);
  } else {
    run("git", ["-C", repoDir, "fetch", "--tags", "--force", "origin"]);
  }
  let checkout = tryRun("git", ["-C", repoDir, "checkout", "--detach", "--force", sourceInfo.ref]);
  if (checkout.status !== 0) {
    // A SHA that no branch/tag reaches may need an explicit fetch.
    run("git", ["-C", repoDir, "fetch", "origin", sourceInfo.ref]);
    run("git", ["-C", repoDir, "checkout", "--detach", "--force", "FETCH_HEAD"]);
  }
  run("git", ["-C", repoDir, "clean", "-fdx"]);
  return repoDir;
}

function ensureTreeSitterCli(version, cacheDir) {
  const cliDir = path.join(cacheDir, "cli", version);
  const binary = path.join(
    cliDir,
    "node_modules",
    "tree-sitter-cli",
    process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter",
  );
  if (fs.existsSync(binary)) return binary;

  console.log(`Installing tree-sitter-cli@${version} …`);
  fs.mkdirSync(cliDir, { recursive: true });
  // npm needs a shell on Windows; pass one pre-joined command string so the
  // arguments are not concatenated behind our back (DEP0190).
  run(`npm install --prefix "${cliDir}" tree-sitter-cli@${version} --ignore-scripts`, [], {
    shell: true,
  });
  // The postinstall (binary download) is blocked by --ignore-scripts; run it
  // deliberately.
  run(process.execPath, [path.join(cliDir, "node_modules", "tree-sitter-cli", "install.js")], {
    cwd: path.join(cliDir, "node_modules", "tree-sitter-cli"),
  });
  if (!fs.existsSync(binary)) fail(`tree-sitter-cli install produced no binary at ${binary}`);
  return binary;
}

function ensureEmscripten(cacheDir) {
  const probe = tryRun("emcc --version", [], { shell: true });
  if (probe.status === 0) {
    return { env: process.env, version: probe.stdout.split("\n")[0].trim() };
  }
  // Fall back to a local emsdk if one exists. The emsdk lives inside the build
  // cache, so a relocated cache has to be searched too — otherwise moving the
  // cache silently breaks the fallback and reports emcc as simply missing.
  const candidates = [
    ...(process.env.EMSDK ? [process.env.EMSDK] : []),
    ...(cacheDir ? [path.join(cacheDir, "emsdk")] : []),
    path.join(os.homedir(), ".lumine-grammar-cache", "emsdk"),
  ];
  for (const emsdkDir of [...new Set(candidates.map((dir) => path.resolve(dir)))]) {
    const emscriptenDir = path.join(emsdkDir, "upstream", "emscripten");
    if (!fs.existsSync(emscriptenDir)) continue;
    const env = {
      ...process.env,
      EMSDK: emsdkDir,
      PATH: `${emscriptenDir}${path.delimiter}${emsdkDir}${path.delimiter}${process.env.PATH}`,
    };
    const retry = tryRun("emcc --version", [], { shell: true, env });
    if (retry.status === 0) {
      return { env, version: retry.stdout.split("\n")[0].trim() };
    }
  }
  fail(
    "emcc not found. Run in an emscripten-activated shell, or clone " +
      "emscripten-core/emsdk into the build cache (or $EMSDK) and run " +
      "`emsdk install latest && emsdk activate latest` there. Looked in: " +
      candidates.join(", "),
  );
  return null;
}

// --- wasm verification -------------------------------------------------------

let webTreeSitterModule = null;
async function loadWebTreeSitter() {
  if (!webTreeSitterModule) {
    webTreeSitterModule = require("web-tree-sitter");
    await webTreeSitterModule.Parser.init();
  }
  return webTreeSitterModule;
}

async function inspectWasm(wasmPath) {
  const TreeSitter = await loadWebTreeSitter();
  const language = await TreeSitter.Language.load(fs.readFileSync(wasmPath));
  const namedNodeTypes = new Set();
  for (let id = 0; id < language.nodeTypeCount; id++) {
    if (language.nodeTypeIsNamed(id)) {
      const name = language.nodeTypeForId(id);
      if (name) namedNodeTypes.add(name);
    }
  }
  const fieldNames = new Set();
  for (let id = 0; id < language.fieldCount; id++) {
    const name = language.fieldNameForId(id);
    if (name) fieldNames.add(name);
  }
  return {
    abiVersion: language.abiVersion,
    namedNodeTypes,
    fieldNames,
    window: [TreeSitter.MIN_COMPATIBLE_VERSION, TreeSitter.LANGUAGE_VERSION],
  };
}

function diffSets(before, after) {
  const added = [...after].filter((item) => !before.has(item)).sort();
  const removed = [...before].filter((item) => !after.has(item)).sort();
  return { added, removed };
}

// --- main modes --------------------------------------------------------------

async function checkAllWasms(roots) {
  const entries = collectAllConfigs(roots);
  const seen = new Map();
  let bad = 0;
  for (const entry of entries) {
    const wasmPath = wasmPathForConfig(entry);
    const key = wasmPath.toLowerCase();
    if (seen.has(key)) continue;
    const info = await inspectWasm(wasmPath);
    seen.set(key, info);
    const [min, max] = info.window;
    const inWindow = info.abiVersion >= min && info.abiVersion <= max;
    if (!inWindow) bad++;
    console.log(
      `${inWindow ? "ok " : "BAD"}  ABI ${info.abiVersion}  ${path.relative(REPO_ROOT, wasmPath)}`,
    );
  }
  console.log(
    `\n${seen.size} wasm files checked; supported ABI window is [${[...seen.values()][0]?.window}].`,
  );
  if (bad > 0) fail(`${bad} wasm file(s) outside the supported ABI window`);
}

async function buildOne(entry, options, toolchain) {
  const { configPath, config } = entry;
  const treeSitter = config.treeSitter;
  const parserSource = options.source ?? treeSitter.parserSource;
  const sourceInfo = parseParserSource(parserSource);
  if (!sourceInfo) {
    console.log(
      `SKIP ${path.relative(REPO_ROOT, configPath)} — unparseable parserSource: ${parserSource}`,
    );
    return null;
  }

  console.log(`\n=== ${path.relative(REPO_ROOT, configPath)}`);
  console.log(`    source ${parserSource}`);

  const repoDir = ensureRepoCheckout(sourceInfo, options.cacheDir);
  const grammarDir = sourceInfo.subdir ? path.join(repoDir, sourceInfo.subdir) : repoDir;
  if (!fs.existsSync(grammarDir)) fail(`Grammar directory does not exist: ${grammarDir}`);

  const needsGenerate =
    options.regenerate || !fs.existsSync(path.join(grammarDir, "src", "parser.c"));
  if (needsGenerate) {
    console.log(`    generating parser.c with tree-sitter-cli@${options.cliVersion} …`);
    run(toolchain.cli, ["generate"], { cwd: grammarDir, env: toolchain.emscripten.env });
  }

  const outDir = path.join(options.cacheDir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const targetWasmName = path.basename(treeSitter.grammar);
  const builtWasm = path.join(outDir, targetWasmName);
  console.log(`    building with emcc (${toolchain.emscripten.version}) …`);
  run(toolchain.cli, ["build", "--wasm", "-o", builtWasm, grammarDir], {
    env: toolchain.emscripten.env,
  });

  const info = await inspectWasm(builtWasm);
  const [min, max] = info.window;
  console.log(`    built ABI ${info.abiVersion} (supported window [${min}, ${max}])`);
  if (info.abiVersion < min || info.abiVersion > max) {
    fail(`Built wasm ABI ${info.abiVersion} is outside the supported window [${min}, ${max}]`);
  }

  const installedWasm = wasmPathForConfig(entry);
  if (options.diffNodeTypes && fs.existsSync(installedWasm)) {
    const before = await inspectWasm(installedWasm);
    const nodeDiff = diffSets(before.namedNodeTypes, info.namedNodeTypes);
    const fieldDiff = diffSets(before.fieldNames, info.fieldNames);
    console.log(`    node types: +${nodeDiff.added.length} −${nodeDiff.removed.length}`);
    for (const name of nodeDiff.added) console.log(`      + ${name}`);
    for (const name of nodeDiff.removed)
      console.log(`      - ${name}   <-- check queries for this`);
    console.log(`    fields: +${fieldDiff.added.length} −${fieldDiff.removed.length}`);
    for (const name of fieldDiff.added) console.log(`      + ${name}`);
    for (const name of fieldDiff.removed)
      console.log(`      - ${name}   <-- check queries for this`);
  }

  const changed =
    !fs.existsSync(installedWasm) ||
    !fs.readFileSync(installedWasm).equals(fs.readFileSync(builtWasm));

  if (options.dryRun) {
    console.log(
      `    dry run: built wasm left at ${builtWasm} (bytes ${changed ? "differ" : "identical"})`,
    );
    return { changed, builtWasm };
  }

  // Fan out to every config sharing the same parserSource AND wasm basename
  // (the regex wasm is copied into three packages; shared-wasm pairs like
  // json/jsonc live in one package).
  const wasmBuildTool = `tree-sitter-cli#v${options.cliVersion}`;
  const family = collectAllConfigs(options.roots).filter(
    (candidate) =>
      candidate.config.treeSitter.parserSource === treeSitter.parserSource &&
      path.basename(candidate.config.treeSitter.grammar) === targetWasmName,
  );
  // A config built by path is always its own family member. Without this a
  // config outside every known root would compile for ten minutes and then be
  // thrown away for having no one to install into.
  const isSameConfig = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!family.some((member) => isSameConfig(member.configPath, entry.configPath))) {
    family.unshift(entry);
  }
  if (family.length === 0) fail("Internal error: config family is empty");

  for (const member of family) {
    const memberWasm = wasmPathForConfig(member);
    // A grammar being added for the first time has no query directory yet.
    fs.mkdirSync(path.dirname(memberWasm), { recursive: true });
    fs.copyFileSync(builtWasm, memberWasm);
    writeBackMetadata(member.configPath, {
      parserSource: options.source ?? null,
      wasmBuildTool,
    });
    console.log(`    installed -> ${path.relative(REPO_ROOT, memberWasm)}`);
  }

  // The provenance gate only runs on this repository, so the warning would be
  // wrong for a config that lives in its own package repo.
  const isInRepo = entry.configPath.toLowerCase().startsWith(PACKAGES_DIR.toLowerCase());
  if (isInRepo && changed && !options.source && wasmBuildTool === treeSitter.wasmBuildTool) {
    console.log(
      "    WARNING: wasm bytes changed but neither parserSource nor wasmBuildTool did — " +
        "script/validate-wasm-grammar-prs.js will reject this commit.",
    );
  }
  return { changed, builtWasm };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.roots = resolvePackageRoots(options);

  if (options.check) {
    await checkAllWasms(options.roots);
    return;
  }

  const toolchain = {
    emscripten: ensureEmscripten(options.cacheDir),
    cli: ensureTreeSitterCli(options.cliVersion, options.cacheDir),
  };

  if (options.all) {
    if (options.source) fail("--source cannot be combined with --all");
    // Build each distinct (parserSource, wasm basename) family once.
    const entries = collectAllConfigs(options.roots);
    const families = new Map();
    for (const entry of entries) {
      const key = `${entry.config.treeSitter.parserSource}::${path.basename(entry.config.treeSitter.grammar)}`;
      if (!families.has(key)) families.set(key, entry);
    }
    console.log(`Building ${families.size} distinct grammar wasm(s) …`);
    let changedCount = 0;
    for (const entry of families.values()) {
      const result = await buildOne(entry, options, toolchain);
      if (result?.changed) changedCount++;
    }
    console.log(`\nDone. ${changedCount} wasm file(s) changed bytes.`);
    return;
  }

  const config = CSON.readFileSync(options.configPath);
  if (config.type !== "tree-sitter" || !config.treeSitter?.grammar) {
    fail(`${options.configPath} is not a tree-sitter grammar config`);
  }
  await buildOne({ configPath: options.configPath, config }, options, toolchain);
}

// Exported for `spec/build-grammar-wasm-spec.js`; running as a CLI is still
// the only thing that starts a build.
module.exports = { packageDirsInRoot, collectAllConfigs, resolvePackageRoots, PACKAGES_DIR };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
