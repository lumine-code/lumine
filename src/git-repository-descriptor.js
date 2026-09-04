const crypto = require("crypto");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const { normalizePath, pathsAreEqual, realpathRecursive } = require("./repository-paths");

const IS_WINDOWS = process.platform === "win32";

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

function isRootPath(candidate) {
  return IS_WINDOWS ? /^[a-zA-Z]+:[\\/]$/.test(candidate) : candidate === path.sep;
}

function statOrNull(candidate) {
  try {
    return fs.statSync(candidate);
  } catch {
    return null;
  }
}

async function statOrNullAsync(candidate) {
  try {
    return await fs.promises.stat(candidate);
  } catch {
    return null;
  }
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
      if (!statOrNull(commonDir)) return false;
    }
  } catch {
    // No commondir file: the directory is its own common directory.
  }
  const objects = statOrNull(path.join(commonDir, "objects"));
  const refs = statOrNull(path.join(commonDir, "refs"));
  return (
    Boolean(statOrNull(path.join(directory, "HEAD"))) &&
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
      if (!(await statOrNullAsync(commonDir))) return false;
    }
  } catch {
    // No commondir file: the directory is its own common directory.
  }
  const [head, objects, refs] = await Promise.all([
    statOrNullAsync(path.join(directory, "HEAD")),
    statOrNullAsync(path.join(commonDir, "objects")),
    statOrNullAsync(path.join(commonDir, "refs")),
  ]);
  return Boolean(head && objects?.isDirectory() && refs?.isDirectory());
}

const GIT_FILE_REGEX = /^gitdir:\s*(.+)$/m;

// Resolve a `.git` file (`gitdir: <path>`) to the directory it points at.
function resolveGitFile(gitFilePath, baseDirectory) {
  try {
    const match = fs.readFileSync(gitFilePath, "utf8").match(GIT_FILE_REGEX);
    if (!match) return null;
    return path.resolve(baseDirectory, match[1].trim());
  } catch {
    return null;
  }
}

async function resolveGitFileAsync(gitFilePath, baseDirectory) {
  try {
    const match = (await fs.promises.readFile(gitFilePath, "utf8")).match(GIT_FILE_REGEX);
    return match ? path.resolve(baseDirectory, match[1].trim()) : null;
  } catch {
    return null;
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
  } catch {
    return {};
  }
}

async function readCoreConfigAsync(gitDir) {
  try {
    return parseCoreConfig(await fs.promises.readFile(path.join(gitDir, "config"), "utf8"));
  } catch {
    return {};
  }
}

function parseGitBoolean(value) {
  return value != null && /^(true|yes|on|1)$/i.test(String(value).trim());
}

// Compute the working directory: null for a bare repository, `core.worktree`
// when set, the pointed-at tree for a linked worktree, and otherwise the
// directory that contains the Git directory.
function computeWorkingDirectory(gitDir) {
  const core = readCoreConfig(gitDir);
  if (parseGitBoolean(core.bare)) return null;
  if (core.worktree) return path.resolve(gitDir, core.worktree);

  const gitdirPointer = path.join(gitDir, "gitdir");
  const pointerStat = statOrNull(gitdirPointer);
  if (pointerStat && pointerStat.isFile()) {
    try {
      const pointed = fs.readFileSync(gitdirPointer, "utf8").trim();
      if (pointed) return path.dirname(pointed);
    } catch {
      // Fall through to the containing directory.
    }
  }

  return path.dirname(gitDir);
}

async function computeWorkingDirectoryAsync(gitDir) {
  const core = await readCoreConfigAsync(gitDir);
  if (parseGitBoolean(core.bare)) return null;
  if (core.worktree) return path.resolve(gitDir, core.worktree);

  const gitdirPointer = path.join(gitDir, "gitdir");
  const pointerStat = await statOrNullAsync(gitdirPointer);
  if (pointerStat?.isFile()) {
    try {
      const pointed = (await fs.promises.readFile(gitdirPointer, "utf8")).trim();
      if (pointed) return path.dirname(pointed);
    } catch {
      // Fall through to the containing directory.
    }
  }
  return path.dirname(gitDir);
}

// Walk up from a starting path to the nearest Git directory.
function discoverGitDirectory(startPath) {
  if (!startPath) return null;
  let current = path.resolve(startPath);

  while (true) {
    const dotGit = path.join(current, ".git");
    const dotGitStat = statOrNull(dotGit);
    if (dotGitStat) {
      if (dotGitStat.isDirectory() && isGitDirectory(dotGit)) return dotGit;
      if (dotGitStat.isFile()) {
        const resolved = resolveGitFile(dotGit, current);
        if (resolved && isGitDirectory(resolved)) return resolved;
      }
    }
    if (isGitDirectory(current)) return current;

    const parent = path.dirname(current);
    if (parent === current || isRootPath(current)) return null;
    current = parent;
  }
}

async function discoverGitDirectoryAsync(startPath) {
  if (!startPath) return null;
  let current = path.resolve(startPath);

  while (true) {
    const dotGit = path.join(current, ".git");
    const dotGitStat = await statOrNullAsync(dotGit);
    if (dotGitStat) {
      if (dotGitStat.isDirectory() && (await isGitDirectoryAsync(dotGit))) return dotGit;
      if (dotGitStat.isFile()) {
        const resolved = await resolveGitFileAsync(dotGit, current);
        if (resolved && (await isGitDirectoryAsync(resolved))) return resolved;
      }
    }
    if (await isGitDirectoryAsync(current)) return current;

    const parent = path.dirname(current);
    if (parent === current || isRootPath(current)) return null;
    current = parent;
  }
}

// When the opened path is reached through a symlink, remember the unresolved
// directory that maps to the working directory so paths arriving through that
// symlink still route.
function computeOpenedWorkingDirectory(startPath, workingDirectory, caseInsensitive) {
  if (!workingDirectory) return null;
  const normalizedStartPath = normalizePath(startPath, false);
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
  const normalizedStartPath = normalizePath(startPath, false);
  if (realpathRecursive(startPath) === normalizedStartPath) return null;

  let candidate = normalizedStartPath;
  while (!isRootPath(candidate)) {
    if (pathsAreEqual(candidate, workingDirectory, caseInsensitive)) return candidate;
    candidate = path.resolve(candidate, "..");
  }
  return null;
}

class GitRepositoryDescriptor {
  constructor(gitDir, startPath, resolved = null) {
    this.gitDir = resolved ? resolved.gitDir : realpath(gitDir);

    if (resolved) {
      this.workingDirectory = resolved.workingDirectory;
      this.caseInsensitiveFs = resolved.caseInsensitiveFs;
      this.openedWorkingDirectory = resolved.openedWorkingDirectory;
    } else {
      const rawWorkingDirectory = computeWorkingDirectory(this.gitDir);
      this.workingDirectory = rawWorkingDirectory
        ? normalizePath(rawWorkingDirectory, true).replace(/\/$/, "")
        : null;
      this.caseInsensitiveFs = fs.isCaseInsensitive();
      this.openedWorkingDirectory = computeOpenedWorkingDirectory(
        startPath ?? gitDir,
        this.workingDirectory,
        this.caseInsensitiveFs,
      );
    }

    this._submoduleCache = {
      signature: null,
      hash: null,
      paths: Object.freeze([]),
    };
  }

  // The repository's Git directory path.
  getPath() {
    return this.gitDir;
  }

  getWorkingDirectory() {
    return this.workingDirectory;
  }

  // Configured submodule working-tree paths (POSIX, relative to the working
  // directory), read from `.gitmodules`. The manifest may change when a branch
  // is checked out, so cache it by file metadata and content rather than for the
  // lifetime of this descriptor.
  getSubmodulePaths() {
    if (!this.workingDirectory) return this._submoduleCache.paths;

    const manifestPath = path.join(this.workingDirectory, ".gitmodules");
    let stat;
    try {
      stat = fs.statSync(manifestPath);
    } catch {
      if (this._submoduleCache.signature !== "missing") {
        this._submoduleCache = {
          signature: "missing",
          hash: null,
          paths: Object.freeze([]),
        };
      }
      return this._submoduleCache.paths;
    }

    const signature = `${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.size}`;
    if (signature === this._submoduleCache.signature) return this._submoduleCache.paths;

    let text;
    try {
      text = fs.readFileSync(manifestPath, "utf8");
    } catch {
      // An atomic checkout may replace the file between stat and read. Do not
      // retain the old branch's paths; the next query will retry the read.
      this._submoduleCache = {
        signature: null,
        hash: null,
        paths: Object.freeze([]),
      };
      return this._submoduleCache.paths;
    }

    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (hash === this._submoduleCache.hash) {
      this._submoduleCache.signature = signature;
      return this._submoduleCache.paths;
    }

    const paths = [];
    let inSubmodule = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^\[submodule\b/i.test(line)) {
        inSubmodule = true;
        continue;
      }
      if (line.startsWith("[")) {
        inSubmodule = false;
        continue;
      }
      if (!inSubmodule) continue;
      const match = /^path\s*=\s*(.+)$/.exec(line);
      if (match) paths.push(match[1].trim());
    }
    this._submoduleCache = {
      signature,
      hash,
      paths: Object.freeze(paths),
    };
    return this._submoduleCache.paths;
  }

  // Whether a repository-relative path is a configured submodule.
  isSubmodule(relativePath) {
    if (!relativePath) return false;
    const normalized = relativePath.split(path.sep).join("/");
    return this.getSubmodulePaths().includes(normalized);
  }
}

// Discover the repository for a starting path and build its descriptor, or null
// when the path is not inside a repository.
function discoverRepositoryDescriptor(startPath) {
  const gitDir = discoverGitDirectory(startPath);
  if (!gitDir) return null;
  return new GitRepositoryDescriptor(gitDir, startPath);
}

async function discoverRepositoryDescriptorAsync(startPath) {
  const discoveredGitDir = await discoverGitDirectoryAsync(startPath);
  if (!discoveredGitDir) return null;

  const gitDir = await realpathAsync(discoveredGitDir);
  const rawWorkingDirectory = await computeWorkingDirectoryAsync(gitDir);
  const workingDirectory = rawWorkingDirectory
    ? normalizePath(rawWorkingDirectory, true).replace(/\/$/, "")
    : null;
  const caseInsensitiveFs = fs.isCaseInsensitive();
  const openedWorkingDirectory = await computeOpenedWorkingDirectoryAsync(
    startPath ?? discoveredGitDir,
    workingDirectory,
    caseInsensitiveFs,
  );
  return new GitRepositoryDescriptor(discoveredGitDir, startPath, {
    gitDir,
    workingDirectory,
    caseInsensitiveFs,
    openedWorkingDirectory,
  });
}

module.exports = {
  GitRepositoryDescriptor,
  discoverRepositoryDescriptor,
  discoverRepositoryDescriptorAsync,
  discoverGitDirectory,
  discoverGitDirectoryAsync,
  computeWorkingDirectory,
  computeWorkingDirectoryAsync,
};
