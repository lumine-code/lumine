// Verifies that every bundled package's dependencies are installed at versions
// its own manifest admits.
//
//   node script/check-bundled-deps.js
//
// Each bundled package is a git dependency pinned by SHA, and package-lock.json
// records the dependency list that commit declared. Nothing re-derives that list
// from the commit: npm trusts the entry, and it will not re-read a git
// dependency whose lockfile entry already agrees with the manifest. So a
// lockfile that names one commit while describing another installs the wrong
// tree and reports success — which is exactly what happened when pins were
// advanced by rewriting SHAs in the lockfile instead of letting npm regenerate
// it. Neither the suites nor the platform matrix could see it: every package
// was present, at the versions some earlier commit wanted.
//
// This reads each installed package's real manifest and resolves what it
// actually got, so the two can disagree only where a human sees it.

const fs = require("fs");
const path = require("path");
const semver = require("semver");
const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");

const ROOT = path.join(__dirname, "..");

// A pin is resolved by npm from the git URL, not from a published range, so it
// has no version to check here.
const PINNED = /lumine-code|github:|git\+|^file:|^link:/;

// Walking node_modules by hand rather than require.resolve: a package with a
// strict `exports` map refuses to resolve its own package.json, which would
// read as a missing dependency.
function installedManifest(fromDir, name) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8"));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function main() {
  const names = scanBundledPackageNames(ROOT);
  const errors = [];
  let resolved = 0;

  for (const name of names) {
    const dir = resolveBundledPackageDir(ROOT, name);
    if (!dir) {
      errors.push(`${name}: bundled but not installed`);
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    for (const [dependency, range] of Object.entries(manifest.dependencies || {})) {
      if (PINNED.test(String(range))) continue;

      const installed = installedManifest(dir, dependency);
      if (!installed) {
        errors.push(`${name} declares ${dependency} ${range}, which is not installed`);
        continue;
      }

      resolved++;
      if (!semver.satisfies(installed.version, range)) {
        errors.push(
          `${name} declares ${dependency} ${range} but ${installed.version} is installed — ` +
            `package-lock.json describes a different commit of ${name} than it names`,
        );
      }
    }
  }

  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `bundled dependencies: ${names.length} packages, ${resolved} resolved, ` +
      `${errors.length} error(s)`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
