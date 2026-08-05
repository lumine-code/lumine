"use strict";

// The single definition of "bundled": a dependency IS a Lumine package iff
// its own installed manifest declares an engines.lumine range. There is no
// second registry — the editor, the build metadata, the check scripts, and
// CI all derive the bundled set from this scan.
const fs = require("fs");
const path = require("path");

const scanCache = new Map(); // resolved rootDir -> string[]

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

// Is this directory a Lumine package?
function isLuminePackageDir(dir) {
  const manifest = readManifest(dir);
  return manifest != null && manifest.engines != null && manifest.engines.lumine != null;
}

// Names of the bundled packages: the keys of rootDir/package.json
// "dependencies" whose installed copy under rootDir/node_modules declares
// engines.lumine. Memoized per root — the bundled set cannot change at
// runtime.
function scanBundledPackageNames(rootDir) {
  const key = path.resolve(rootDir);
  if (scanCache.has(key)) return scanCache.get(key);
  const root = readManifest(key);
  const names = Object.keys((root && root.dependencies) || {})
    .filter((name) => isLuminePackageDir(path.join(key, "node_modules", name)))
    .sort();
  scanCache.set(key, names);
  return names;
}

// Resolve a bundled name to the directory that delivers it: a vendored
// packages/ copy wins over the node_modules copy, mirroring the loader's
// dev-mode priority.
function resolveBundledPackageDir(rootDir, name) {
  for (const base of ["packages", "node_modules"]) {
    const dir = path.join(rootDir, base, name);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function clearCache() {
  scanCache.clear();
}

module.exports = {
  isLuminePackageDir,
  scanBundledPackageNames,
  resolveBundledPackageDir,
  clearCache,
};
