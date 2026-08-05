// Advances SHA-pinned package dependencies to their remote heads.
//
//   node script/repin.js <name>...
//   node script/repin.js --all [--dry-run] [--no-install]
//
// A repinnable dependency is an unscoped "dependencies" entry whose value is
// https://github.com/lumine-code/<repo>.git#<40-hex sha> — the shape every
// pinned package uses. Scoped @lumine-code libraries are deliberately out of
// scope: their pins advance by hand, when the editor is ready for them.
//
// For each target the script asks the repository for its remote HEAD
// (git ls-remote), rewrites the pin in place, and mirrors the new SHA into
// any legacy github:lumine-code/<repo>#<sha> occurrence of the same pin.
// Unless --no-install is given it finishes with `npm install` so
// package-lock.json follows the manifest, then prints old→new per package.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "package.json");
const PIN = /^https:\/\/github\.com\/lumine-code\/([^/#]+)\.git#([0-9a-f]{40})$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function repinnablePins(manifest) {
  const pins = new Map();
  for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
    const match = name.startsWith("@") ? null : PIN.exec(value);
    if (match) pins.set(name, { repo: match[1], sha: match[2] });
  }
  return pins;
}

function remoteHead(repo) {
  const url = `https://github.com/lumine-code/${repo}.git`;
  const output = execFileSync("git", ["ls-remote", url, "HEAD"], {
    encoding: "utf8",
  });
  const sha = output.split(/\s/, 1)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`No HEAD SHA from ${url}`);
  return sha;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const install = !args.includes("--no-install");
  const all = args.includes("--all");
  const names = args.filter((arg) => !arg.startsWith("--"));
  if (all === names.length > 0) {
    fail("Usage: node script/repin.js <name>... | --all [--dry-run] [--no-install]");
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const pins = repinnablePins(manifest);
  for (const name of names) {
    if (!pins.has(name)) fail(`"${name}" is not a repinnable dependency`);
  }

  const targets = all ? [...pins.keys()] : names;
  let text = fs.readFileSync(MANIFEST_PATH, "utf8");
  const moved = [];
  for (const name of targets) {
    const { repo, sha } = pins.get(name);
    const head = remoteHead(repo);
    if (head === sha) {
      console.log(`${name}: already at ${sha.slice(0, 10)}`);
      continue;
    }
    text = text
      .replaceAll(
        `https://github.com/lumine-code/${repo}.git#${sha}`,
        `https://github.com/lumine-code/${repo}.git#${head}`,
      )
      .replaceAll(`github:lumine-code/${repo}#${sha}`, `github:lumine-code/${repo}#${head}`);
    moved.push(`${name}: ${sha.slice(0, 10)} → ${head.slice(0, 10)}`);
  }

  if (moved.length === 0) {
    console.log("Every pin is already at its remote HEAD.");
    return;
  }
  if (dryRun) {
    console.log(moved.join("\n"));
    console.log(`(dry run: ${moved.length} pin(s) left untouched)`);
    return;
  }

  fs.writeFileSync(MANIFEST_PATH, text);
  if (install) {
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }
  console.log(moved.join("\n"));
  console.log(`Repinned ${moved.length} package(s).`);
}

main();
