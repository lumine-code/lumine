const fs = require("node:fs");
const path = require("node:path");
const FindParentDir = require("../../src/find-parent-dir");
const { resolveBundledPackageDir } = require("../../src/bundled-packages");

function readManifest(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function isPackage(directory, name) {
  const manifest = directory && readManifest(directory);
  return manifest?.name === name && typeof manifest.engines?.lumine === "string";
}

module.exports = function resolveSpecPackagePaths({
  testPaths,
  userHome,
  resourcePath,
  extraNames = [],
}) {
  const packagePath = FindParentDir.sync(testPaths[0], "package.json");
  const manifest = packagePath && readManifest(packagePath);
  const declaredNames = manifest?.specPackages ?? [];
  if (!Array.isArray(declaredNames))
    throw new TypeError("specPackages must be an array of package names");
  const names = new Set([...declaredNames, ...extraNames]);
  const packages = new Map();
  for (const name of names) {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new TypeError(`Invalid spec package name: ${String(name)}`);
    const candidates = [
      ...(manifest?.name === name ? [packagePath] : []),
      path.join(userHome, "packages", name),
      ...(packagePath ? [path.join(path.dirname(packagePath), name)] : []),
      resolveBundledPackageDir(resourcePath, name),
    ];
    const directory = candidates.find((candidate) => isPackage(candidate, name));
    if (!directory)
      throw new Error(
        `Unable to resolve spec package '${name}' declared by ${manifest?.name ?? packagePath}`,
      );
    packages.set(name, directory);
  }
  return { packagePath, packageName: manifest?.name, packages };
};
