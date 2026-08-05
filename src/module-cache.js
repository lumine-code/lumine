const Module = require("module");
const path = require("path");
const semver = require("semver");

// Extend semver.Range to memoize matched versions for speed
class Range extends semver.Range {
  constructor() {
    super(...arguments);
    this.matchedVersions = new Set();
    this.unmatchedVersions = new Set();
  }

  test(version) {
    if (this.matchedVersions.has(version)) return true;
    if (this.unmatchedVersions.has(version)) return false;

    const matches = super.test(...arguments);
    if (matches) {
      this.matchedVersions.add(version);
    } else {
      this.unmatchedVersions.add(version);
    }
    return matches;
  }
}

let nativeModules = null;

const cache = {
  builtins: {},
  debug: false,
  dependencies: {},
  extensions: {},
  folders: {},
  ranges: {},
  registered: false,
  resourcePath: null,
  resourcePathWithTrailingSlash: null,
};

// isAbsolute is inlined from fs-plus so that fs-plus itself can be required
// from this cache.
let isAbsolute;
if (process.platform === "win32") {
  isAbsolute = (pathToCheck) =>
    pathToCheck && (pathToCheck[1] === ":" || (pathToCheck[0] === "\\" && pathToCheck[1] === "\\"));
} else {
  isAbsolute = (pathToCheck) => pathToCheck && pathToCheck[0] === "/";
}

const isCorePath = (pathToCheck) => pathToCheck.startsWith(cache.resourcePathWithTrailingSlash);

function satisfies(version, rawRange) {
  let parsedRange;
  if (!(parsedRange = cache.ranges[rawRange])) {
    parsedRange = new Range(rawRange);
    cache.ranges[rawRange] = parsedRange;
  }
  return parsedRange.test(version);
}

function resolveFilePath(relativePath, parentModule) {
  if (!relativePath) return;
  if (!(parentModule && parentModule.filename)) return;
  if (relativePath[0] !== "." && !isAbsolute(relativePath)) return;

  const resolvedPath = path.resolve(path.dirname(parentModule.filename), relativePath);
  if (!isCorePath(resolvedPath)) return;

  let extension = path.extname(resolvedPath);
  if (extension) {
    if (cache.extensions[extension] && cache.extensions[extension].has(resolvedPath))
      return resolvedPath;
  } else {
    for (extension in cache.extensions) {
      const paths = cache.extensions[extension];
      const resolvedPathWithExtension = `${resolvedPath}${extension}`;
      if (paths.has(resolvedPathWithExtension)) {
        return resolvedPathWithExtension;
      }
    }
  }
}

function resolveModulePath(relativePath, parentModule) {
  if (!relativePath) return;
  if (!(parentModule && parentModule.filename)) return;

  // eslint-disable-next-line n/no-deprecated-api -- low-level native-module listing
  if (!nativeModules) nativeModules = process.binding("natives");
  if (Object.hasOwn(nativeModules, relativePath)) return;
  if (relativePath[0] === ".") return;
  if (isAbsolute(relativePath)) return;

  const folderPath = path.dirname(parentModule.filename);

  const range = cache.folders[folderPath] && cache.folders[folderPath][relativePath];
  if (!range) {
    const builtinPath = cache.builtins[relativePath];
    if (builtinPath) {
      return builtinPath;
    } else {
      return;
    }
  }

  const candidates = cache.dependencies[relativePath];
  if (candidates == null) return;

  for (let version in candidates) {
    const resolvedPath = candidates[version];
    if (Module._cache[resolvedPath] || isCorePath(resolvedPath)) {
      if (satisfies(version, range)) return resolvedPath;
    }
  }
}

function registerBuiltins(devMode) {
  if (devMode || !cache.resourcePath.startsWith(`${process.resourcesPath}${path.sep}`)) {
    const fs = require("@lumine-code/fs-plus");
    const atomJsPath = path.join(cache.resourcePath, "exports", "atom.js");
    if (fs.isFileSync(atomJsPath)) {
      cache.builtins.atom = atomJsPath;
    }
  }
  if (cache.builtins.atom == null) {
    cache.builtins.atom = path.join(cache.resourcePath, "exports", "atom.js");
  }
}

exports.register = function ({ resourcePath, devMode } = {}) {
  if (cache.registered) return;

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (...args) {
    let [relativePath, parentModule] = args;
    let resolvedPath = resolveModulePath(relativePath, parentModule);
    if (!resolvedPath) {
      resolvedPath = resolveFilePath(relativePath, parentModule);
    }
    return resolvedPath || originalResolveFilename(...args);
  };

  cache.registered = true;
  cache.resourcePath = resourcePath;
  cache.resourcePathWithTrailingSlash = `${resourcePath}${path.sep}`;
  registerBuiltins(devMode);
};

exports.add = function (directoryPath, metadata) {
  // path.join isn't used in this function for speed since path.join calls
  // path.normalize and all the paths are already normalized here.

  if (metadata == null) {
    try {
      metadata = require(`${directoryPath}${path.sep}package.json`);
    } catch {
      return;
    }
  }

  const cacheToAdd = metadata && metadata._atomModuleCache;
  if (!cacheToAdd) return;

  for (const dependency of cacheToAdd.dependencies || []) {
    if (!cache.dependencies[dependency.name]) {
      cache.dependencies[dependency.name] = {};
    }
    if (!cache.dependencies[dependency.name][dependency.version]) {
      cache.dependencies[dependency.name][dependency.version] =
        `${directoryPath}${path.sep}${dependency.path}`;
    }
  }

  for (const entry of cacheToAdd.folders || []) {
    for (const folderPath of entry.paths) {
      if (folderPath) {
        cache.folders[`${directoryPath}${path.sep}${folderPath}`] = entry.dependencies;
      } else {
        cache.folders[directoryPath] = entry.dependencies;
      }
    }
  }

  for (const extension in cacheToAdd.extensions) {
    const paths = cacheToAdd.extensions[extension];
    if (!cache.extensions[extension]) {
      cache.extensions[extension] = new Set();
    }
    for (let filePath of paths) {
      cache.extensions[extension].add(`${directoryPath}${path.sep}${filePath}`);
    }
  }
};

exports.cache = cache;

exports.Range = Range;
