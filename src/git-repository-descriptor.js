const fs = require("@lumine-code/fs-plus");
const path = require("path");
const { normalizePath, pathsAreEqual, realpathRecursive } = require("./repository-paths");

const IS_WINDOWS = process.platform === "win32";
const ERR_GIT_REPOSITORY_UNAVAILABLE = "ERR_GIT_REPOSITORY_UNAVAILABLE";
const MISSING_PATH_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);

function isMissingPathError(error) {
  return MISSING_PATH_ERROR_CODES.has(error?.code);
}

function normalizeLexicalPath(filePath) {
  const resolved = path.resolve(filePath);
  return IS_WINDOWS ? resolved.replace(/\\/g, "/") : resolved;
}

function trimTrailingSeparator(filePath) {
  const root = normalizeLexicalPath(path.parse(filePath).root);
  return filePath !== root ? filePath.replace(/\/$/, "") : filePath;
}

function canonicalMarkerPath(markerPath) {
  return normalizeLexicalPath(
    path.join(realpath(path.dirname(markerPath)), path.basename(markerPath)),
  );
}

async function canonicalMarkerPathAsync(markerPath) {
  const parentDirectory = await realpathAsync(path.dirname(markerPath));
  return normalizeLexicalPath(path.join(parentDirectory, path.basename(markerPath)));
}

// Given any path inside (or at) a Git repository, discover the Git directory,
// working directory, filesystem case sensitivity, and configured submodule
// paths needed for repository identity and routing. This handles real paths,
// Windows short names, worktrees, submodules, and bare repositories directly.

function realpath(unrealPath) {
  try {
    return typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(unrealPath)
      : fs.realpathSync(unrealPath);
  } catch {
    return unrealPath;
  }
}

async function realpathAsync(unrealPath) {
  try {
    return await fs.promises.realpath(unrealPath);
  } catch {
    return unrealPath;
  }
}

async function normalizePathAsync(unrealPath, useRealpath = true) {
  let normalized = unrealPath;
  if (useRealpath || IS_WINDOWS) normalized = await realpathAsync(unrealPath);
  return IS_WINDOWS ? normalized.replace(/\\/g, "/") : normalized;
}

async function normalizeExistingPathAsync(unrealPath) {
  const normalized = await fs.promises.realpath(unrealPath);
  return IS_WINDOWS ? normalized.replace(/\\/g, "/") : normalized;
}

// Resolve a possibly missing path without performing any synchronous
// filesystem work on the renderer. The first existing ancestor is resolved
// and the missing suffix is reattached, matching realpathRecursive().
async function realpathRecursiveAsync(unrealPath) {
  if (!path.isAbsolute(unrealPath)) return normalizePathAsync(unrealPath);

  let currentPath = unrealPath;
  let resolvedPath = unrealPath;
  let remainder = "";
  while (!isRootPath(currentPath)) {
    try {
      resolvedPath = await fs.promises.realpath(currentPath);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") return normalizePathAsync(unrealPath, false);
      currentPath = path.resolve(currentPath, "..");
      remainder = path.relative(currentPath, unrealPath);
    }
  }
  if (isRootPath(currentPath)) return normalizePathAsync(unrealPath, false);

  return normalizePathAsync(path.join(resolvedPath, remainder), false);
}

function normalizedPathsAreEqual(pathA, pathB, caseInsensitive) {
  if (IS_WINDOWS) {
    pathA = pathA.replace(/\\/g, "/");
    pathB = pathB.replace(/\\/g, "/");
  }
  if (IS_WINDOWS || caseInsensitive) {
    pathA = pathA.toLowerCase();
    pathB = pathB.toLowerCase();
  }
  return pathA === pathB;
}

function isRootPath(candidate) {
  return IS_WINDOWS ? /^[a-zA-Z]+:[\\/]$/.test(candidate) : candidate === path.sep;
}

function statForDiscovery(candidate) {
  try {
    return fs.statSync(candidate);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function statOrNullAsync(candidate) {
  try {
    return await fs.promises.stat(candidate);
  } catch {
    return null;
  }
}

async function statForDiscoveryAsync(candidate) {
  try {
    return await fs.promises.stat(candidate);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

let caseInsensitiveFsPromise = null;

function isCaseInsensitiveAsync() {
  if (!caseInsensitiveFsPromise) {
    caseInsensitiveFsPromise = Promise.all([
      statOrNullAsync(process.execPath.toLowerCase()),
      statOrNullAsync(process.execPath.toUpperCase()),
    ]).then(([lowerCaseStat, upperCaseStat]) =>
      Boolean(
        lowerCaseStat &&
        upperCaseStat &&
        lowerCaseStat.dev === upperCaseStat.dev &&
        lowerCaseStat.ino === upperCaseStat.ino,
      ),
    );
  }
  return caseInsensitiveFsPromise;
}

// A directory is a Git directory when it has a HEAD file plus objects/ and refs/
// directories, following the `commondir` pointer used by linked worktrees.
// objects/ and refs/ must be directories — a bare file of the same name (as in
// the "invalid repository" specs) does not qualify.
function isGitDirectory(directory) {
  let commonDir = directory;
  try {
    const commonDirValue = fs.readFileSync(path.join(directory, "commondir"), "utf8").trim();
    if (commonDirValue) {
      commonDir = path.resolve(directory, commonDirValue);
      if (!statForDiscovery(commonDir)?.isDirectory()) return false;
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const head = statForDiscovery(path.join(directory, "HEAD"));
  const objects = statForDiscovery(path.join(commonDir, "objects"));
  const refs = statForDiscovery(path.join(commonDir, "refs"));
  return (
    Boolean(head?.isFile()) &&
    Boolean(objects && objects.isDirectory()) &&
    Boolean(refs && refs.isDirectory())
  );
}

async function isGitDirectoryAsync(directory) {
  let commonDir = directory;
  try {
    const commonDirValue = (
      await fs.promises.readFile(path.join(directory, "commondir"), "utf8")
    ).trim();
    if (commonDirValue) {
      commonDir = path.resolve(directory, commonDirValue);
      if (!(await statForDiscoveryAsync(commonDir))?.isDirectory()) return false;
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const [head, objects, refs] = await Promise.all([
    statForDiscoveryAsync(path.join(directory, "HEAD")),
    statForDiscoveryAsync(path.join(commonDir, "objects")),
    statForDiscoveryAsync(path.join(commonDir, "refs")),
  ]);
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory());
}

const GIT_FILE_REGEX = /^gitdir:\s*(.+)$/m;

// Resolve a `.git` file (`gitdir: <path>`) to the directory it points at.
function resolveGitFile(gitFilePath, baseDirectory) {
  try {
    const match = fs.readFileSync(gitFilePath, "utf8").match(GIT_FILE_REGEX);
    if (!match) return null;
    return path.resolve(baseDirectory, match[1].trim());
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function resolveGitFileAsync(gitFilePath, baseDirectory) {
  try {
    const match = (await fs.promises.readFile(gitFilePath, "utf8")).match(GIT_FILE_REGEX);
    return match ? path.resolve(baseDirectory, match[1].trim()) : null;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function pathsResolveToSameLocation(pathA, pathB) {
  return normalizedPathsAreEqual(
    normalizeLexicalPath(realpath(pathA)),
    normalizeLexicalPath(realpath(pathB)),
    false,
  );
}

async function pathsResolveToSameLocationAsync(pathA, pathB) {
  return normalizedPathsAreEqual(
    normalizeLexicalPath(await realpathAsync(pathA)),
    normalizeLexicalPath(await realpathAsync(pathB)),
    false,
  );
}

// A linked-worktree Git directory normally points back to the `.git` gitfile
// that selected it. When discovery starts inside the Git directory rather than
// in the worktree, retain that marker instead of fabricating a worktree from
// the metadata directory's parent.
function linkedWorktreeMarker(gitDirectory) {
  try {
    const pointer = fs.readFileSync(path.join(gitDirectory, "gitdir"), "utf8").trim();
    if (!pointer) return null;
    const markerPath = path.isAbsolute(pointer) ? pointer : path.resolve(gitDirectory, pointer);
    if (!statForDiscovery(markerPath)?.isFile()) return null;
    const target = resolveGitFile(markerPath, path.dirname(markerPath));
    if (!target || !pathsResolveToSameLocation(target, gitDirectory)) return null;
    return {
      discoveredWorkingDirectory: path.dirname(markerPath),
      worktreeGitMarker: { path: markerPath, kind: "gitfile" },
    };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function linkedWorktreeMarkerAsync(gitDirectory) {
  try {
    const pointer = (await fs.promises.readFile(path.join(gitDirectory, "gitdir"), "utf8")).trim();
    if (!pointer) return null;
    const markerPath = path.isAbsolute(pointer) ? pointer : path.resolve(gitDirectory, pointer);
    if (!(await statForDiscoveryAsync(markerPath))?.isFile()) return null;
    const target = await resolveGitFileAsync(markerPath, path.dirname(markerPath));
    if (!target || !(await pathsResolveToSameLocationAsync(target, gitDirectory))) return null;
    return {
      discoveredWorkingDirectory: path.dirname(markerPath),
      worktreeGitMarker: { path: markerPath, kind: "gitfile" },
    };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

// Shallow parse of the repository's own config for the handful of `core` keys
// that determine the working directory. These keys only ever live in the
// repository config (never global/system), so `<gitDir>/config` is authoritative.
function parseCoreConfig(text) {
  const core = {};
  let inCore = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]/.exec(line);
    if (section) {
      inCore = section[1].trim().toLowerCase() === "core";
      continue;
    }
    if (!inCore) continue;
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (kv) core[kv[1].toLowerCase()] = kv[2].trim();
  }
  return core;
}

function readCoreConfig(gitDir) {
  try {
    return parseCoreConfig(fs.readFileSync(path.join(gitDir, "config"), "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) return {};
    throw error;
  }
}

async function readCoreConfigAsync(gitDir) {
  try {
    return parseCoreConfig(await fs.promises.readFile(path.join(gitDir, "config"), "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) return {};
    throw error;
  }
}

function parseConfiguredGitBoolean(value) {
  if (value == null) return null;
  const normalized = unquoteConfigValue(String(value).trim()).toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  return null;
}

// Compute the working directory from an authoritative relationship: null for
// a bare repository, the marker that discovery actually found, or an explicit
// core.worktree. A standalone non-bare Git directory does not prove which
// working tree it belongs to.
function computeWorkingDirectory(gitDir, discoveredWorkingDirectory = null) {
  const core = readCoreConfig(gitDir);
  if (parseConfiguredGitBoolean(core.bare) === true) return null;
  if (discoveredWorkingDirectory) return discoveredWorkingDirectory;
  if (core.worktree) return path.resolve(gitDir, unquoteConfigValue(core.worktree));

  return undefined;
}

async function computeWorkingDirectoryAsync(gitDir, discoveredWorkingDirectory = null) {
  const core = await readCoreConfigAsync(gitDir);
  if (parseConfiguredGitBoolean(core.bare) === true) return null;
  if (discoveredWorkingDirectory) return discoveredWorkingDirectory;
  if (core.worktree) return path.resolve(gitDir, unquoteConfigValue(core.worktree));

  return undefined;
}

// Walk up from a starting path to the nearest Git directory, retaining the
// exact `.git` marker that established a worktree relationship. A gitfile is
// authoritative even when its target has no legacy `gitdir` backlink (as with
// `--separate-git-dir`).
function discoverRepositoryLocation(startPath) {
  if (!startPath) return null;
  let current = path.resolve(startPath);

  while (true) {
    const dotGit = path.join(current, ".git");
    const dotGitStat = statForDiscovery(dotGit);
    if (dotGitStat) {
      if (dotGitStat.isDirectory() && isGitDirectory(dotGit)) {
        return {
          gitDirectory: dotGit,
          discoveredWorkingDirectory: current,
          worktreeGitMarker: { path: dotGit, kind: "directory" },
        };
      }
      if (dotGitStat.isFile()) {
        const resolved = resolveGitFile(dotGit, current);
        if (resolved && isGitDirectory(resolved)) {
          return {
            gitDirectory: resolved,
            discoveredWorkingDirectory: current,
            worktreeGitMarker: { path: dotGit, kind: "gitfile" },
          };
        }
      }
    }
    if (isGitDirectory(current)) {
      if (
        normalizedPathsAreEqual(
          normalizeLexicalPath(current),
          normalizeLexicalPath(path.join(path.dirname(current), ".git")),
          false,
        )
      ) {
        return {
          gitDirectory: current,
          discoveredWorkingDirectory: path.dirname(current),
          worktreeGitMarker: { path: current, kind: "directory" },
        };
      }
      const linkedMarker = linkedWorktreeMarker(current);
      if (linkedMarker) return { gitDirectory: current, ...linkedMarker };
      if (statForDiscovery(path.join(current, "commondir"))?.isFile()) {
        return { gitDirectory: current, unresolvedWorktree: true };
      }
      return {
        gitDirectory: current,
        discoveredWorkingDirectory: null,
        worktreeGitMarker: null,
      };
    }

    const parent = path.dirname(current);
    if (parent === current || isRootPath(current)) return null;
    current = parent;
  }
}

async function discoverRepositoryLocationAsync(startPath) {
  if (!startPath) return null;
  let current = path.resolve(startPath);

  while (true) {
    const dotGit = path.join(current, ".git");
    const dotGitStat = await statForDiscoveryAsync(dotGit);
    if (dotGitStat) {
      if (dotGitStat.isDirectory() && (await isGitDirectoryAsync(dotGit))) {
        return {
          gitDirectory: dotGit,
          discoveredWorkingDirectory: current,
          worktreeGitMarker: { path: dotGit, kind: "directory" },
        };
      }
      if (dotGitStat.isFile()) {
        const resolved = await resolveGitFileAsync(dotGit, current);
        if (resolved && (await isGitDirectoryAsync(resolved))) {
          return {
            gitDirectory: resolved,
            discoveredWorkingDirectory: current,
            worktreeGitMarker: { path: dotGit, kind: "gitfile" },
          };
        }
      }
    }
    if (await isGitDirectoryAsync(current)) {
      if (
        normalizedPathsAreEqual(
          normalizeLexicalPath(current),
          normalizeLexicalPath(path.join(path.dirname(current), ".git")),
          false,
        )
      ) {
        return {
          gitDirectory: current,
          discoveredWorkingDirectory: path.dirname(current),
          worktreeGitMarker: { path: current, kind: "directory" },
        };
      }
      const linkedMarker = await linkedWorktreeMarkerAsync(current);
      if (linkedMarker) return { gitDirectory: current, ...linkedMarker };
      if ((await statForDiscoveryAsync(path.join(current, "commondir")))?.isFile()) {
        return { gitDirectory: current, unresolvedWorktree: true };
      }
      return {
        gitDirectory: current,
        discoveredWorkingDirectory: null,
        worktreeGitMarker: null,
      };
    }

    const parent = path.dirname(current);
    if (parent === current || isRootPath(current)) return null;
    current = parent;
  }
}

function discoverGitDirectory(startPath) {
  const location = discoverRepositoryLocation(startPath);
  return location?.unresolvedWorktree ? null : (location?.gitDirectory ?? null);
}

// When the opened path is reached through a symlink, remember the unresolved
// directory that maps to the working directory so paths arriving through that
// symlink still route.
function computeOpenedWorkingDirectory(startPath, workingDirectory, caseInsensitive) {
  if (!workingDirectory) return null;
  const normalizedStartPath = normalizeLexicalPath(startPath);
  if (realpathRecursive(startPath) === normalizedStartPath) return null;

  let candidate = normalizedStartPath;
  while (!isRootPath(candidate)) {
    if (pathsAreEqual(candidate, workingDirectory, caseInsensitive)) return candidate;
    candidate = path.resolve(candidate, "..");
  }
  return null;
}

async function computeOpenedWorkingDirectoryAsync(startPath, workingDirectory, caseInsensitive) {
  if (!workingDirectory) return null;
  const normalizedStartPath = normalizeLexicalPath(startPath);
  if (
    normalizedPathsAreEqual(
      await realpathRecursiveAsync(startPath),
      normalizedStartPath,
      caseInsensitive,
    )
  ) {
    return null;
  }

  let candidate = normalizedStartPath;
  while (!isRootPath(candidate)) {
    if (
      normalizedPathsAreEqual(
        await realpathRecursiveAsync(candidate),
        workingDirectory,
        caseInsensitive,
      )
    ) {
      return candidate;
    }
    candidate = path.resolve(candidate, "..");
  }
  return null;
}

class GitRepositoryDescriptor {
  constructor(gitDir, startPath, resolved = null) {
    this.gitDir = resolved ? resolved.gitDir : realpath(gitDir);
    this.gitDirectoryAliases = new Set([this.gitDir, normalizeLexicalPath(gitDir)]);
    this.worktreeGitMarker = resolved?.worktreeGitMarker || null;

    if (resolved) {
      this.workingDirectory = resolved.workingDirectory;
      this.caseInsensitiveFs = resolved.caseInsensitiveFs;
      this.openedWorkingDirectory = resolved.openedWorkingDirectory;
    } else {
      const rawWorkingDirectory = computeWorkingDirectory(this.gitDir);
      this.workingDirectory = rawWorkingDirectory
        ? trimTrailingSeparator(normalizePath(rawWorkingDirectory, true))
        : null;
      this.caseInsensitiveFs = fs.isCaseInsensitive();
      this.openedWorkingDirectory = computeOpenedWorkingDirectory(
        startPath ?? gitDir,
        this.workingDirectory,
        this.caseInsensitiveFs,
      );
    }
  }

  // The repository's Git directory path.
  getPath() {
    return this.gitDir;
  }

  getWorkingDirectory() {
    return this.workingDirectory;
  }

  getWorktreeGitMarker() {
    return this.worktreeGitMarker;
  }

  getGitDirectoryAliases() {
    return Array.from(this.gitDirectoryAliases);
  }
}

// Discover the repository for a starting path and build its descriptor, or null
// when the path is not inside a repository.
function discoverRepositoryDescriptor(startPath) {
  const location = discoverRepositoryLocation(startPath);
  if (!location || location.unresolvedWorktree) return null;

  const gitDir = realpath(location.gitDirectory);
  const rawWorkingDirectory = computeWorkingDirectory(gitDir, location.discoveredWorkingDirectory);
  if (rawWorkingDirectory === undefined) return null;
  const workingDirectory = rawWorkingDirectory
    ? trimTrailingSeparator(normalizePath(rawWorkingDirectory, true))
    : null;
  const worktreeGitMarker =
    workingDirectory && location.worktreeGitMarker
      ? Object.freeze({
          path: canonicalMarkerPath(location.worktreeGitMarker.path),
          kind: location.worktreeGitMarker.kind,
        })
      : null;
  const caseInsensitiveFs = fs.isCaseInsensitive();
  const openedWorkingDirectory = computeOpenedWorkingDirectory(
    startPath ?? location.gitDirectory,
    workingDirectory,
    caseInsensitiveFs,
  );
  return new GitRepositoryDescriptor(location.gitDirectory, startPath, {
    gitDir,
    workingDirectory,
    worktreeGitMarker,
    caseInsensitiveFs,
    openedWorkingDirectory,
  });
}

async function discoverRepositoryDescriptorAsync(startPath) {
  const location = await discoverRepositoryLocationAsync(startPath);
  if (!location || location.unresolvedWorktree) return null;

  const gitDir = await realpathAsync(location.gitDirectory);
  const rawWorkingDirectory = await computeWorkingDirectoryAsync(
    gitDir,
    location.discoveredWorkingDirectory,
  );
  if (rawWorkingDirectory === undefined) return null;
  const workingDirectory = rawWorkingDirectory
    ? trimTrailingSeparator(await normalizePathAsync(rawWorkingDirectory))
    : null;
  const worktreeGitMarker =
    workingDirectory && location.worktreeGitMarker
      ? Object.freeze({
          path: await canonicalMarkerPathAsync(location.worktreeGitMarker.path),
          kind: location.worktreeGitMarker.kind,
        })
      : null;
  const caseInsensitiveFs = await isCaseInsensitiveAsync();
  const openedWorkingDirectory = await computeOpenedWorkingDirectoryAsync(
    startPath ?? location.gitDirectory,
    workingDirectory,
    caseInsensitiveFs,
  );
  return new GitRepositoryDescriptor(location.gitDirectory, startPath, {
    gitDir,
    workingDirectory,
    worktreeGitMarker,
    caseInsensitiveFs,
    openedWorkingDirectory,
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function unavailableInspection(reason) {
  return Object.freeze({ available: false, reason });
}

function repositoryDescriptorParts(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("A repository descriptor is required");
  }

  const gitDirectory = descriptor.gitDirectory ?? descriptor.gitDir ?? descriptor.getPath?.();
  const workingDirectory = Object.prototype.hasOwnProperty.call(descriptor, "workingDirectory")
    ? descriptor.workingDirectory
    : descriptor.getWorkingDirectory?.();
  const worktreeGitMarker = Object.prototype.hasOwnProperty.call(descriptor, "worktreeGitMarker")
    ? descriptor.worktreeGitMarker
    : (descriptor.getWorktreeGitMarker?.() ?? null);

  if (typeof gitDirectory !== "string" || gitDirectory.length === 0) {
    throw new TypeError("Repository descriptor gitDirectory must be a path");
  }
  if (workingDirectory !== null && typeof workingDirectory !== "string") {
    throw new TypeError("Repository descriptor workingDirectory must be a path or null");
  }

  return { gitDirectory, workingDirectory, worktreeGitMarker: worktreeGitMarker ?? null };
}

function normalizedPathsMatch(pathA, pathB) {
  return normalizedPathsAreEqual(pathA, pathB, false);
}

async function inspectDirectoryAsync(candidate, missingReason, wrongTypeReason, signal) {
  throwIfAborted(signal);
  let stats;
  try {
    stats = await fs.promises.stat(candidate);
  } catch (error) {
    if (isMissingPathError(error)) return { reason: missingReason };
    throw error;
  }
  if (!stats.isDirectory()) return { reason: wrongTypeReason };

  try {
    const canonicalPath = trimTrailingSeparator(await normalizeExistingPathAsync(candidate));
    throwIfAborted(signal);
    return { path: canonicalPath };
  } catch (error) {
    if (isMissingPathError(error)) return { reason: missingReason };
    throw error;
  }
}

async function inspectCommonDirectoryAsync(gitDirectory, signal) {
  const pointerPath = path.join(gitDirectory, "commondir");
  let pointerStats;
  try {
    pointerStats = await fs.promises.stat(pointerPath);
  } catch (error) {
    if (isMissingPathError(error)) return { path: gitDirectory };
    throw error;
  }
  if (!pointerStats.isFile()) return { reason: "common-directory-not-directory" };

  let pointer;
  try {
    pointer = (await fs.promises.readFile(pointerPath, "utf8")).trim();
  } catch (error) {
    if (isMissingPathError(error)) return { reason: "common-directory-missing" };
    throw error;
  }
  throwIfAborted(signal);

  const commonDirectory = path.resolve(gitDirectory, pointer);
  return inspectDirectoryAsync(
    commonDirectory,
    "common-directory-missing",
    "common-directory-not-directory",
    signal,
  );
}

async function readCoreConfigForInspectionAsync(commonDirectory) {
  try {
    return parseCoreConfig(
      await fs.promises.readFile(path.join(commonDirectory, "config"), "utf8"),
    );
  } catch (error) {
    if (isMissingPathError(error)) return {};
    throw error;
  }
}

function unquoteConfigValue(value) {
  if (!value?.startsWith('"')) return value;
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (!match) return value;
  return match[1].replace(/\\([\\"]|n|t|b)/g, (_match, escaped) => {
    if (escaped === "n") return "\n";
    if (escaped === "t") return "\t";
    if (escaped === "b") return "\b";
    return escaped;
  });
}

async function inspectWorktreeMarkerAsync(marker, gitDirectory, workingDirectory, signal) {
  if (
    !marker ||
    typeof marker.path !== "string" ||
    !["directory", "gitfile"].includes(marker.kind)
  ) {
    return { reason: "worktree-marker-invalid" };
  }
  if (!workingDirectory) return { reason: "worktree-marker-mismatch" };

  let markerParent;
  try {
    markerParent = trimTrailingSeparator(
      await normalizeExistingPathAsync(path.dirname(marker.path)),
    );
  } catch (error) {
    if (isMissingPathError(error)) return { reason: "worktree-marker-missing" };
    throw error;
  }
  const markerPath = normalizeLexicalPath(path.join(markerParent, path.basename(marker.path)));
  const expectedMarkerPath = normalizeLexicalPath(path.join(workingDirectory, ".git"));
  if (!normalizedPathsMatch(markerPath, expectedMarkerPath)) {
    return { reason: "worktree-marker-mismatch" };
  }

  let markerStats;
  try {
    markerStats = await fs.promises.stat(markerPath);
  } catch (error) {
    if (isMissingPathError(error)) return { reason: "worktree-marker-missing" };
    throw error;
  }
  const expectedTypeMatches =
    marker.kind === "directory" ? markerStats.isDirectory() : markerStats.isFile();
  if (!expectedTypeMatches) return { reason: "worktree-marker-wrong-type" };
  throwIfAborted(signal);

  if (marker.kind === "directory") {
    let markerTarget;
    try {
      markerTarget = await normalizeExistingPathAsync(markerPath);
    } catch (error) {
      if (isMissingPathError(error)) return { reason: "worktree-marker-missing" };
      throw error;
    }
    return normalizedPathsMatch(markerTarget, gitDirectory)
      ? { marker: Object.freeze({ path: markerPath, kind: marker.kind }) }
      : { reason: "worktree-marker-mismatch" };
  }

  let markerContents;
  try {
    markerContents = await fs.promises.readFile(markerPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { reason: "worktree-marker-missing" };
    throw error;
  }
  const match = /^gitdir:[ \t]*(.+?)[ \t]*(?:\r?\n)?$/.exec(markerContents);
  if (!match) return { reason: "worktree-marker-invalid" };

  const targetPath = path.resolve(path.dirname(markerPath), match[1]);
  let targetStats;
  let markerTarget;
  try {
    [targetStats, markerTarget] = await Promise.all([
      fs.promises.stat(targetPath),
      normalizeExistingPathAsync(targetPath),
    ]);
  } catch (error) {
    if (isMissingPathError(error)) return { reason: "worktree-marker-mismatch" };
    throw error;
  }
  if (!targetStats.isDirectory() || !normalizedPathsMatch(markerTarget, gitDirectory)) {
    return { reason: "worktree-marker-mismatch" };
  }
  throwIfAborted(signal);
  return { marker: Object.freeze({ path: markerPath, kind: marker.kind }) };
}

async function configuredWorktreeMatchesAsync(core, gitDirectory, workingDirectory, signal) {
  if (parseConfiguredGitBoolean(core.bare) === true) return false;

  if (core.worktree) {
    const configuredPath = path.resolve(gitDirectory, unquoteConfigValue(core.worktree));
    const configuredDirectory = await inspectDirectoryAsync(
      configuredPath,
      "core-worktree-mismatch",
      "core-worktree-mismatch",
      signal,
    );
    return Boolean(
      configuredDirectory.path && normalizedPathsMatch(configuredDirectory.path, workingDirectory),
    );
  }

  return false;
}

async function inspectRepositoryDescriptorAsync(descriptor, { signal } = {}) {
  const parts = repositoryDescriptorParts(descriptor);
  throwIfAborted(signal);

  let workingDirectory = null;
  if (parts.workingDirectory !== null) {
    const inspectedWorkingDirectory = await inspectDirectoryAsync(
      parts.workingDirectory,
      "working-directory-missing",
      "working-directory-not-directory",
      signal,
    );
    if (!inspectedWorkingDirectory.path) {
      return unavailableInspection(inspectedWorkingDirectory.reason);
    }
    workingDirectory = inspectedWorkingDirectory.path;
  }

  const inspectedGitDirectory = await inspectDirectoryAsync(
    parts.gitDirectory,
    "git-directory-missing",
    "git-directory-not-directory",
    signal,
  );
  if (!inspectedGitDirectory.path) {
    return unavailableInspection(inspectedGitDirectory.reason);
  }
  const gitDirectory = inspectedGitDirectory.path;

  const inspectedCommonDirectory = await inspectCommonDirectoryAsync(gitDirectory, signal);
  if (!inspectedCommonDirectory.path) {
    return unavailableInspection(inspectedCommonDirectory.reason);
  }

  let worktreeGitMarker = null;
  if (parts.worktreeGitMarker) {
    const inspectedMarker = await inspectWorktreeMarkerAsync(
      parts.worktreeGitMarker,
      gitDirectory,
      workingDirectory,
      signal,
    );
    if (!inspectedMarker.marker) return unavailableInspection(inspectedMarker.reason);
    worktreeGitMarker = inspectedMarker.marker;
  } else {
    const core = await readCoreConfigForInspectionAsync(inspectedCommonDirectory.path);
    throwIfAborted(signal);
    if (workingDirectory === null) {
      if (core.worktree || parseConfiguredGitBoolean(core.bare) === false) {
        return unavailableInspection("core-worktree-mismatch");
      }
    } else if (
      !(await configuredWorktreeMatchesAsync(core, gitDirectory, workingDirectory, signal))
    ) {
      return unavailableInspection("core-worktree-mismatch");
    }
  }

  const normalizedDescriptor = Object.freeze({
    gitDirectory,
    workingDirectory,
    worktreeGitMarker,
  });
  return Object.freeze({ available: true, descriptor: normalizedDescriptor });
}

async function assertRepositoryDescriptorAvailableAsync(descriptor, { signal, operation } = {}) {
  const parts = repositoryDescriptorParts(descriptor);
  const inspection = await inspectRepositoryDescriptorAsync(descriptor, { signal });
  if (inspection.available) return inspection.descriptor;

  const error = new Error(
    `Git repository is unavailable${operation ? ` during ${operation}` : ""}: ${inspection.reason}`,
  );
  error.code = ERR_GIT_REPOSITORY_UNAVAILABLE;
  error.reason = inspection.reason;
  error.gitDirectory = normalizeLexicalPath(parts.gitDirectory);
  error.workingDirectory =
    parts.workingDirectory === null ? null : normalizeLexicalPath(parts.workingDirectory);
  if (operation != null) error.operation = operation;
  throw error;
}

module.exports = {
  discoverRepositoryDescriptor,
  discoverRepositoryDescriptorAsync,
  discoverGitDirectory,
  inspectRepositoryDescriptorAsync,
  assertRepositoryDescriptorAvailableAsync,
  ERR_GIT_REPOSITORY_UNAVAILABLE,
};
