/*
 * This script is called via `validate-wasm-grammars.yml`
 * It's purpose is to ensure that everytime a `.wasm` file is changed in a PR
 * That the `parserSource` key or WASM build metadata of the grammar that uses
 * that specific `.wasm` file is also updated. This way we can ensure that the
 * `parserSource` is always accurate and ABI-only rebuilds are documented.
 */

const cp = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const CSON = require("@lumine-code/season");

const objectFileExtensions = new Set([".json", ".jsonc", ".cson"]);

// Change this if you want more logs
let verbose = true;

// Lets first find our common ancestor commit
// This lets us determine the commit where the branch or fork departed from
const commonAncestorCmd = cp.spawnSync("git", ["merge-base", "origin/master", "HEAD^"]);

if (commonAncestorCmd.status !== 0 || commonAncestorCmd.stderr.toString().length > 0) {
  console.error("Git Command has failed!");
  console.error("'git merge-base origin/master HEAD^'");
  console.error(commonAncestorCmd.stderr.toString());
  process.exit(1);
}

const commit = commonAncestorCmd.stdout.toString().trim();

if (verbose) {
  console.log(`Common Ancestor Commit: '${commit}'`);
}

const cmd = cp.spawnSync("git", ["diff", "--name-only", "-r", "HEAD", commit]);

if (cmd.status !== 0 || cmd.stderr.toString().length > 0) {
  console.error("Git Command has failed!");
  console.error(`'git diff --name-only -r HEAD ${commit}'`);
  console.error(cmd.stderr.toString());
  process.exit(1);
}

const changedFiles = cmd.stdout.toString().split("\n");
// This gives us an array of the name and path of every single changed file from the last two commits
// Now to check if there's any changes we care about.

if (verbose) {
  console.log("Array of changed files between commits:");
  console.log(changedFiles);
}

const wasmFilesChanged = changedFiles.filter((element) => element.endsWith(".wasm"));

if (wasmFilesChanged.length === 0) {
  // No WASM files have been modified. Return success
  console.log("No WASM files have been changed.");
  process.exit(0);
}

// Now for every single wasm file that's been changed, we must validate those
// changes are also accompanied by a change in the parser source or build
// metadata.

// Maps every grammar config to the absolute path of the wasm it declares.
// Matching on that path rather than on a filename matters twice over: a wasm
// stored more than one directory below its config was skipped outright, which
// left the jsdoc and JavaScript regex grammars ungated, and two grammars that
// happen to share a wasm filename could otherwise be taken for one another.
function collectGrammarConfigs() {
  const configs = [];
  const packagesDir = path.join(__dirname, "..", "packages");

  for (const pkg of fs.readdirSync(packagesDir)) {
    const grammarsDir = path.join(packagesDir, pkg, "grammars");
    if (!fs.existsSync(grammarsDir)) continue;

    for (const file of fs.readdirSync(grammarsDir)) {
      if (!objectFileExtensions.has(path.extname(file))) continue;

      const configPath = path.join(grammarsDir, file);
      if (!fs.lstatSync(configPath).isFile()) continue;

      let contents;
      try {
        contents = CSON.readFileSync(configPath);
      } catch {
        // Not a grammar config we can read; nothing to gate.
        continue;
      }

      const grammar = contents?.treeSitter?.grammar;
      if (!grammar) continue;

      configs.push({
        file,
        configPath,
        contents,
        wasmPath: path.resolve(path.dirname(configPath), grammar),
      });
    }
  }

  return configs;
}

// Windows reports paths that differ only by case, so compare them folded.
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const grammarConfigs = collectGrammarConfigs();

for (const wasmFile of wasmFilesChanged) {
  // Ignore files that have been deleted or moved.
  if (!fs.existsSync(wasmFile)) {
    console.log(`Skipping file that no longer exists: ${wasmFile}`);
    continue;
  }

  console.log(`Detected changes to: ${wasmFile}`);

  const owners = grammarConfigs.filter((config) => samePath(config.wasmPath, wasmFile));

  if (owners.length === 0) {
    console.error(`No grammar config declares '${wasmFile}', so its provenance cannot be checked.`);
    process.exit(1);
  }

  for (const { file, configPath, contents } of owners) {
    // `git show` wants a repo-relative path with forward slashes.
    const relativePath = path.relative(process.cwd(), configPath).split(path.sep).join("/");
    console.log(`Checking: ${relativePath}`);

    // In order to check the previous state of what the key is, we first must
    // retrieve the file prior to this PR.
    const getPrevFile = cp.spawnSync("git", ["show", `${commit}:./${relativePath}`]);

    if (getPrevFile.status !== 0 || getPrevFile.stderr.toString().length > 0) {
      // This can fail for two major reasons
      // 1. The `git show` command has returned an error code other than `0`, failing.
      // 2. This is a new file, and it failed to find an earlier copy (which didn't exist)
      // So that we don't fail brand new TreeSitter grammars, we manually check for number 2

      if (getPrevFile.stderr.toString().includes("exists on disk, but not in")) {
        // Looks like this file is new. Skip this check
        if (verbose) {
          console.log("Looks like this file is new. Skipping...");
        }
        continue;
      }

      console.error("Git command failed!");
      console.error(`'git show ${commit}:./${relativePath}'`);
      console.error(getPrevFile.stderr.toString());
      process.exit(1);
    }

    // The loader picks its parser from the file extension, so the previous
    // revision goes through a scratch file — in the temp directory rather than
    // beside the real config, which used to leave `OLD-*` files behind in the
    // working tree for a stray `git add` to pick up.
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-wasm-validate-"));
    let oldContents;
    try {
      const scratchFile = path.join(scratchDir, file);
      fs.writeFileSync(scratchFile, getPrevFile.stdout.toString());
      oldContents = CSON.readFileSync(scratchFile);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }

    const oldParserSource = oldContents.treeSitter?.parserSource ?? "";
    const newParserSource = contents.treeSitter?.parserSource ?? "";
    const oldWasmBuildTool = oldContents.treeSitter?.wasmBuildTool ?? "";
    const newWasmBuildTool = contents.treeSitter?.wasmBuildTool ?? "";
    const oldWasmBuildPatch = oldContents.treeSitter?.wasmBuildPatch ?? "";
    const newWasmBuildPatch = contents.treeSitter?.wasmBuildPatch ?? "";

    if (newParserSource.length === 0) {
      console.error(`Failed to find the new \`parserSource\` within: '${relativePath}'`);
      console.error(contents.treeSitter);
      process.exit(1);
    }

    if (
      oldParserSource == newParserSource &&
      oldWasmBuildTool == newWasmBuildTool &&
      oldWasmBuildPatch == newWasmBuildPatch
    ) {
      console.error(
        `Neither \`parserSource\` nor WASM build metadata of '${relativePath}' has been updated!`,
      );
      console.error(`Current parserSource: ${newParserSource} - Old: ${oldParserSource}`);
      console.error(`Current wasmBuildTool: ${newWasmBuildTool} - Old: ${oldWasmBuildTool}`);
      console.error(`Current wasmBuildPatch: ${newWasmBuildPatch} - Old: ${oldWasmBuildPatch}`);
      process.exit(1);
    }

    // Else it looks like it has been updated properly
    console.log(`Validated WASM metadata has been updated within '${relativePath}' properly.`);
  }
}
