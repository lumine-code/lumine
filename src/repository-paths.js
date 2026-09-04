const fs = require("fs");
const path = require("path");

const IS_WINDOWS = process.platform === "win32";

// Repository path helpers handle realpath resolution, Windows 8.3 short names,
// case-insensitive filesystems, and symlinked working directories consistently.

// Resolving a path is a filesystem round trip, and the git integration asks
// about the same handful of paths relentlessly: every open editor's path
// against every repository, once per interested package, on every status
// refresh — and on Windows every comparison resolves both sides to normalize
// 8.3 short names. A canonical form does not change while a window is open,
// since a rename arrives as a different input string, so successful
// resolutions are remembered. Failures are not: a path that does not exist
// yet may exist later.
const realpathCache = new Map();
const realpathRecursiveCache = new Map();
// Large enough that no real session evicts, small enough to bound a runaway.
const REALPATH_CACHE_LIMIT = 20000;

function rememberRealpath(cache, key, value) {
  if (cache.size >= REALPATH_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

function realpathSyncNative(target) {
  return typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(target)
    : fs.realpathSync(target);
}

function realpath(unrealPath) {
  const cached = realpathCache.get(unrealPath);
  if (cached !== undefined) return cached;
  try {
    return rememberRealpath(realpathCache, unrealPath, realpathSyncNative(unrealPath));
  } catch {
    return unrealPath;
  }
}

// Forgets every remembered resolution. Only needed when the filesystem is
// rearranged underneath a running window — a spec moving fixtures around, or a
// symlink being retargeted.
function clearRealpathCache() {
  realpathCache.clear();
  realpathRecursiveCache.clear();
}

function isRootPath(candidate) {
  return IS_WINDOWS ? /^[a-zA-Z]+:[\\/]$/.test(candidate) : candidate === path.sep;
}

function trimPath(filePath) {
  if (!filePath.endsWith("/")) return filePath;
  return filePath.replace(/\/$/, "");
}

function normalizePath(filePath, useRealpath = true) {
  if (typeof filePath !== "string") return filePath;
  // On Windows always resolve realpath so 8.3 short names normalize to their
  // long form; off Windows only when asked.
  if (useRealpath || IS_WINDOWS) filePath = realpath(filePath);
  if (!IS_WINDOWS) return filePath;
  return filePath.replace(/\\/g, "/");
}

// Resolve a (possibly non-existent) path to its real path by walking up to the
// first existing ancestor and reattaching the remainder.
function realpathRecursive(unrealPath) {
  let currentPath = unrealPath;
  let result = unrealPath;
  let remainder = "";
  if (!path.isAbsolute(unrealPath)) return realpath(unrealPath);
  const cached = realpathRecursiveCache.get(unrealPath);
  if (cached !== undefined) return cached;
  while (!isRootPath(currentPath)) {
    try {
      result = realpathSyncNative(currentPath);
      break;
    } catch (error) {
      if (error.code === "ENOENT") {
        currentPath = path.resolve(currentPath, "..");
        remainder = path.relative(currentPath, unrealPath);
      } else {
        return unrealPath;
      }
    }
  }
  // A path with no existing ancestor is not resolvable yet, and may become so.
  if (isRootPath(currentPath)) return unrealPath;
  const resolved = normalizePath(trimPath(`${result}/${remainder}`));
  // Only a path that exists resolves to a stable canonical form. One
  // reconstructed from a tail that does not exist yet can resolve differently
  // the moment it is created — a new directory picks up its own short name on
  // Windows — so that answer is computed fresh every time.
  if (remainder === "") rememberRealpath(realpathRecursiveCache, unrealPath, resolved);
  return resolved;
}

function pathStartsWith(pathA, pathB, caseInsensitive = false, useRealpath = true) {
  if (IS_WINDOWS) {
    pathA = normalizePath(pathA, useRealpath);
    pathB = normalizePath(pathB, useRealpath);
  }
  if (caseInsensitive) {
    pathA = pathA.toLowerCase();
    pathB = pathB.toLowerCase();
  }
  if (!pathB.endsWith("/")) pathB = `${pathB}/`;
  return pathA.startsWith(pathB);
}

function pathsAreEqual(pathA, pathB, caseInsensitive = false, useRealpath = true) {
  if (typeof pathA !== "string" || typeof pathB !== "string") return false;

  pathA = normalizePath(pathA, useRealpath);
  pathB = normalizePath(pathB, useRealpath);

  if (IS_WINDOWS || caseInsensitive) {
    pathA = pathA.toLowerCase();
    pathB = pathB.toLowerCase();
  }

  const result = pathA === pathB;
  if (result || !IS_WINDOWS) return result;
  if (!pathA.includes("~") && !pathB.includes("~")) return result;

  // One side is an 8.3 short name; compare filesystem identity.
  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) return result;
  const statA = fs.statSync(pathA);
  const statB = fs.statSync(pathB);
  return statA.ino === statB.ino && statA.dev === statB.dev;
}

// Make `filePath` relative to the repository working directory. Return "" for
// the working directory itself and pass paths outside it through unchanged.
function relativize(filePath, workingDirectory, openedWorkingDirectory, caseInsensitive) {
  if (!filePath) return filePath;
  filePath = realpathRecursive(filePath);

  if (!IS_WINDOWS && filePath[0] !== "/") return filePath;

  for (const directory of [workingDirectory, openedWorkingDirectory]) {
    if (!directory) continue;
    if (pathStartsWith(filePath, directory, caseInsensitive, false)) {
      return filePath.substring(directory.length + 1);
    } else if (pathsAreEqual(filePath, directory, caseInsensitive, false)) {
      return "";
    }
  }

  return filePath;
}

module.exports = {
  relativize,
  normalizePath,
  pathStartsWith,
  pathsAreEqual,
  realpathRecursive,
  clearRealpathCache,
};
