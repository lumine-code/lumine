const fs = require("@lumine-code/fs-plus");
const path = require("path");
const os = require("os");
const picomatch = require("picomatch");

const IS_WINDOWS = process.platform === "win32";
const ERR_GIT_REPOSITORY_UNAVAILABLE = "ERR_GIT_REPOSITORY_UNAVAILABLE";
const MISSING_PATH_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);
const MAX_SHARED_DISCOVERY_READS = 4096;
const pendingDiscoveryReads = new Map();
const sharedDiscoveryFilesystem = Object.fromEntries(
  ["stat", "lstat", "readFile", "realpath"].map((method) => [
    method,
    (targetPath, ...options) => {
      const key = `${method}\0${targetPath}\0${JSON.stringify(options)}`;
      let pending = pendingDiscoveryReads.get(key);
      if (!pending) {
        if (pendingDiscoveryReads.size >= MAX_SHARED_DISCOVERY_READS) {
          return fs.promises[method](targetPath, ...options);
        }
        pending = Promise.resolve().then(() => fs.promises[method](targetPath, ...options));
        pendingDiscoveryReads.set(key, pending);
        const forget = () => {
          if (pendingDiscoveryReads.get(key) === pending) pendingDiscoveryReads.delete(key);
        };
        pending.then(forget, forget);
      }
      return pending;
    },
  ]),
);

function isMissingPathError(error) {
  return MISSING_PATH_ERROR_CODES.has(error?.code);
}

function filesystemIdentity(stats) {
  const device = String(stats.dev);
  const inode = String(stats.ino);
  if (inode === "0") return null;
  const birthtime = stats.birthtimeNs == null ? null : String(stats.birthtimeNs);
  return Object.freeze({
    device,
    inode,
    ...(birthtime && birthtime !== "0" ? { birthtime } : {}),
  });
}

async function commonDirectoryLocationAsync(gitDirectory) {
  let commonDirectory = gitDirectory;
  try {
    const value = (await fs.promises.readFile(path.join(gitDirectory, "commondir"), "utf8")).trim();
    if (value) commonDirectory = path.resolve(gitDirectory, value);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const canonicalPath = trimTrailingSeparator(
    normalizeLexicalPath(await realpathAsync(commonDirectory)),
  );
  return {
    path: canonicalPath,
    identity: filesystemIdentity(await fs.promises.stat(canonicalPath, { bigint: true })),
  };
}

function normalizeLexicalPath(filePath) {
  const resolved = path.resolve(filePath);
  return IS_WINDOWS ? resolved.replace(/\\/g, "/") : resolved;
}

function trimTrailingSeparator(filePath) {
  const root = normalizeLexicalPath(path.parse(filePath).root);
  return filePath !== root ? filePath.replace(/\/$/, "") : filePath;
}

async function canonicalMarkerPathAsync(markerPath) {
  const parentDirectory = await realpathAsync(path.dirname(markerPath));
  return normalizeLexicalPath(path.join(parentDirectory, path.basename(markerPath)));
}

// Given any path inside (or at) a Git repository, discover the Git directory,
// working directory, filesystem case sensitivity, and configured submodule
// paths needed for repository identity and routing. This handles real paths,
// Windows short names, worktrees, submodules, and bare repositories directly.

async function realpathAsync(unrealPath, filesystem = fs.promises) {
  try {
    return await filesystem.realpath(unrealPath);
  } catch {
    return unrealPath;
  }
}

async function normalizePathAsync(unrealPath, useRealpath = true, filesystem = fs.promises) {
  let normalized = unrealPath;
  if (useRealpath || IS_WINDOWS) normalized = await realpathAsync(unrealPath, filesystem);
  return IS_WINDOWS ? normalized.replace(/\\/g, "/") : normalized;
}

async function normalizeExistingPathAsync(unrealPath) {
  const normalized = await fs.promises.realpath(unrealPath);
  return IS_WINDOWS ? normalized.replace(/\\/g, "/") : normalized;
}

// Discovery is authoritative: a symlink may have been retargeted since the
// last lookup. Resolve existing ancestors afresh and retain a missing suffix.

// Resolve a possibly missing path without performing any synchronous
// filesystem work on the renderer. The first existing ancestor is resolved
// and the missing suffix is reattached, matching realpathRecursive().
async function realpathRecursiveAsync(unrealPath, filesystem = fs.promises) {
  if (!unrealPath) return unrealPath;
  if (!path.isAbsolute(unrealPath)) return normalizePathAsync(unrealPath, true, filesystem);

  let currentPath = unrealPath;
  let resolvedPath = unrealPath;
  let remainder = "";
  while (!isRootPath(currentPath)) {
    try {
      resolvedPath = await filesystem.realpath(currentPath);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") return normalizePathAsync(unrealPath, false, filesystem);
      const parentPath = path.resolve(currentPath, "..");
      if (parentPath === currentPath) return normalizePathAsync(unrealPath, false, filesystem);
      currentPath = parentPath;
      remainder = path.relative(currentPath, unrealPath);
    }
  }
  if (isRootPath(currentPath)) return normalizePathAsync(unrealPath, false, filesystem);

  return normalizePathAsync(path.join(resolvedPath, remainder), false, filesystem);
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
  return path.dirname(candidate) === candidate;
}

async function statOrNullAsync(candidate) {
  try {
    return await fs.promises.stat(candidate);
  } catch {
    return null;
  }
}

async function statForDiscoveryAsync(candidate, filesystem = fs.promises) {
  try {
    return await filesystem.stat(candidate);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function lstatForDiscoveryAsync(candidate, filesystem = fs.promises) {
  try {
    return await filesystem.lstat(candidate);
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

async function isGitDirectoryAsync(directory, filesystem = fs.promises) {
  let commonDir = directory;
  try {
    const commonDirValue = (
      await filesystem.readFile(path.join(directory, "commondir"), "utf8")
    ).trim();
    if (commonDirValue) {
      commonDir = path.resolve(directory, commonDirValue);
      if (!(await statForDiscoveryAsync(commonDir, filesystem))?.isDirectory()) return false;
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const [head, objects, refs] = await Promise.all([
    statForDiscoveryAsync(path.join(directory, "HEAD"), filesystem),
    statForDiscoveryAsync(path.join(commonDir, "objects"), filesystem),
    statForDiscoveryAsync(path.join(commonDir, "refs"), filesystem),
  ]);
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory());
}

function parseGitFile(contents) {
  const match = /^gitdir:[ \t]*(.*\S)[ \t]*(?:\r?\n)?$/.exec(contents);
  return match ? match[1] : null;
}

// Resolve a `.git` file (`gitdir: <path>`) to the directory it points at.

async function resolveGitFileAsync(gitFilePath, baseDirectory, filesystem = fs.promises) {
  try {
    const target = parseGitFile(await filesystem.readFile(gitFilePath, "utf8"));
    return target ? path.resolve(baseDirectory, target) : null;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function pathsResolveToSameLocationAsync(pathA, pathB, filesystem = fs.promises) {
  const [leftStats, rightStats] = await Promise.all([
    filesystem.stat(pathA, { bigint: true }),
    filesystem.stat(pathB, { bigint: true }),
  ]);
  const leftIdentity = filesystemIdentity(leftStats);
  const rightIdentity = filesystemIdentity(rightStats);
  return leftIdentity && rightIdentity
    ? leftIdentity.device === rightIdentity.device && leftIdentity.inode === rightIdentity.inode
    : normalizedPathsMatch(
        await realpathAsync(pathA, filesystem),
        await realpathAsync(pathB, filesystem),
      );
}

// A linked-worktree Git directory normally points back to the `.git` gitfile
// that selected it. When discovery starts inside the Git directory rather than
// in the worktree, retain that marker instead of fabricating a worktree from
// the metadata directory's parent.

async function linkedWorktreeMarkerAsync(gitDirectory, filesystem = fs.promises) {
  try {
    const pointer = (await filesystem.readFile(path.join(gitDirectory, "gitdir"), "utf8")).trim();
    if (!pointer) return null;
    const markerPath = path.isAbsolute(pointer) ? pointer : path.resolve(gitDirectory, pointer);
    if (!(await statForDiscoveryAsync(markerPath, filesystem))?.isFile()) return null;
    const target = await resolveGitFileAsync(markerPath, path.dirname(markerPath), filesystem);
    if (!target || !(await pathsResolveToSameLocationAsync(target, gitDirectory, filesystem)))
      return null;
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
function invalidConfigError(configPath) {
  const error = new SyntaxError(
    `Invalid Git repository config${configPath ? `: ${configPath}` : ""}`,
  );
  error.code = "ERR_GIT_CONFIG_INVALID";
  if (configPath) error.path = configPath;
  return error;
}

function stripConfigComment(text, configPath) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (character === "#" || character === ";")) {
      return text.slice(0, index);
    }
  }
  if (quoted || escaped) throw invalidConfigError(configPath);
  return text;
}

function parseConfigValue(text, configPath) {
  const characters = [];
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted && character === "\\") {
      const escaped = text[++index];
      if (escaped == null || !['"', "\\", "n", "t", "b"].includes(escaped)) {
        throw invalidConfigError(configPath);
      }
      const decoded = { n: "\n", t: "\t", b: "\b" }[escaped] ?? escaped;
      characters.push({ character: decoded, quoted: true });
      continue;
    }
    if (!quoted && character === "\\") {
      if (text[index + 1] !== "\\") throw invalidConfigError(configPath);
      characters.push({ character: "\\", quoted: false });
      index++;
      continue;
    }
    characters.push({ character, quoted });
  }
  if (quoted) throw invalidConfigError(configPath);
  while (characters[0] && !characters[0].quoted && /\s/.test(characters[0].character)) {
    characters.shift();
  }
  while (characters.at(-1) && !characters.at(-1).quoted && /\s/.test(characters.at(-1).character)) {
    characters.pop();
  }
  return characters.map(({ character }) => character).join("");
}

function configLineContinues(line, initiallyQuoted) {
  let quoted = initiallyQuoted;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (character === "#" || character === ";")) {
      return { continues: false, quoted };
    }
  }
  const trailingBackslashes = /\\+$/.exec(line)?.[0].length || 0;
  return { continues: trailingBackslashes % 2 === 1, quoted };
}

function parseRepositoryConfig(text, configPath = null) {
  const entries = [];
  let currentSection = null;
  let currentSubsection = null;
  const logicalLines = [];
  let continuedLine = "";
  let continuedQuoted = false;
  for (const physicalLine of text.split(/\r?\n/)) {
    continuedLine += physicalLine;
    const continuation = configLineContinues(physicalLine, continuedQuoted);
    if (continuation.continues) {
      continuedLine = continuedLine.slice(0, -1);
      continuedQuoted = continuation.quoted;
      continue;
    }
    logicalLines.push(continuedLine);
    continuedLine = "";
    continuedQuoted = false;
  }
  if (continuedLine) throw invalidConfigError(configPath);

  for (const rawLine of logicalLines) {
    const line = stripConfigComment(rawLine, configPath).trim();
    if (!line) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (section) {
      currentSection = section[1].toLowerCase();
      currentSubsection =
        section[2] === undefined ? null : parseConfigValue(`"${section[2]}"`, configPath);
      continue;
    }
    if (line.startsWith("[")) throw invalidConfigError(configPath);
    const kv = /^([A-Za-z0-9-]+)(?:\s*=\s*(.*))?$/.exec(line);
    if (!kv) throw invalidConfigError(configPath);
    if (!currentSection) throw invalidConfigError(configPath);
    entries.push({
      section: currentSection,
      subsection: currentSubsection,
      key: kv[1].toLowerCase(),
      value: kv[2] == null ? "true" : parseConfigValue(kv[2], configPath),
    });
  }
  return entries;
}

function emptyRepositoryConfig() {
  return { core: {}, extensions: {} };
}

function mergeRepositoryConfig(target, source) {
  Object.assign(target.core, source.core);
  Object.assign(target.extensions, source.extensions);
}

async function repositoryConfigKeyAsync(configPath) {
  const resolved = path.resolve(await realpathAsync(configPath));
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function includeConditionMatches(condition, configPath, gitDirectory) {
  if (!condition || !gitDirectory) return false;
  const match = /^gitdir(\/i)?:([\s\S]*)$/i.exec(condition);
  if (!match) return false;
  let pattern = match[2].replace(/\\/g, "/");
  if (pattern === "~") {
    pattern = normalizeLexicalPath(os.homedir());
  } else if (pattern.startsWith("~/")) {
    pattern = normalizeLexicalPath(path.join(os.homedir(), pattern.slice(2)));
  } else if (pattern.startsWith("./")) {
    pattern = normalizeLexicalPath(path.resolve(path.dirname(configPath), pattern.slice(2)));
  } else if (!path.isAbsolute(pattern) && !pattern.startsWith("**/")) {
    pattern = `**/${pattern}`;
  }
  if (pattern.endsWith("/")) pattern += "**";
  return picomatch.isMatch(normalizeLexicalPath(gitDirectory), pattern, {
    dot: true,
    nocase: Boolean(match[1]),
  });
}

async function readRepositoryConfigAsync(
  configPath,
  { gitDirectory = null, stack = new Set() } = {},
) {
  let text;
  try {
    text = await fs.promises.readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return emptyRepositoryConfig();
    throw error;
  }
  const key = await repositoryConfigKeyAsync(configPath);
  if (stack.has(key) || stack.size >= 10) throw invalidConfigError(configPath);
  stack.add(key);
  const config = emptyRepositoryConfig();
  try {
    for (const entry of parseRepositoryConfig(text, configPath)) {
      if (
        entry.subsection === null &&
        (entry.section === "core" || entry.section === "extensions")
      ) {
        config[entry.section][entry.key] = entry.value;
      } else if (entry.section === "include" && entry.subsection === null && entry.key === "path") {
        mergeRepositoryConfig(
          config,
          await readRepositoryConfigAsync(
            resolveConfiguredPath(path.dirname(configPath), entry.value),
            { gitDirectory, stack },
          ),
        );
      } else if (
        entry.section === "includeif" &&
        entry.subsection !== null &&
        entry.key === "path" &&
        includeConditionMatches(entry.subsection, configPath, gitDirectory)
      ) {
        mergeRepositoryConfig(
          config,
          await readRepositoryConfigAsync(
            resolveConfiguredPath(path.dirname(configPath), entry.value),
            { gitDirectory, stack },
          ),
        );
      }
    }
    return config;
  } finally {
    stack.delete(key);
  }
}

async function readCoreConfigAsync(gitDir, commonDirectory = gitDir) {
  const config = await readRepositoryConfigAsync(path.join(commonDirectory, "config"), {
    gitDirectory: gitDir,
  });
  if (parseConfiguredGitBoolean(config.extensions.worktreeconfig) !== true) return config.core;
  const worktreeConfig = await readRepositoryConfigAsync(path.join(gitDir, "config.worktree"), {
    gitDirectory: gitDir,
  });
  return { ...config.core, ...worktreeConfig.core };
}

function parseConfiguredGitBoolean(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["", "false", "no", "off", "0"].includes(normalized)) return false;
  return null;
}

function resolveConfiguredPath(baseDirectory, value) {
  const configuredPath = String(value);
  if (configuredPath === "~") return os.homedir();
  if (configuredPath.startsWith(`~${path.sep}`) || configuredPath.startsWith("~/")) {
    return path.join(os.homedir(), configuredPath.slice(2));
  }
  return path.resolve(baseDirectory, configuredPath);
}

// Compute the working directory from an authoritative relationship: null for
// a bare repository, the marker that discovery actually found, or an explicit
// core.worktree. A standalone non-bare Git directory does not prove which
// working tree it belongs to.

async function computeWorkingDirectoryAsync(
  gitDir,
  discoveredWorkingDirectory = null,
  commonDirectory = gitDir,
) {
  const core = await readCoreConfigAsync(gitDir, commonDirectory);
  if (parseConfiguredGitBoolean(core.bare) === true) return null;
  if (discoveredWorkingDirectory) return discoveredWorkingDirectory;
  if (core.worktree) return resolveConfiguredPath(gitDir, core.worktree);

  return undefined;
}

// Walk up from a starting path to the nearest Git directory, retaining the
// exact `.git` marker that established a worktree relationship. A gitfile is
// authoritative even when its target has no legacy `gitdir` backlink (as with
// `--separate-git-dir`).

async function discoverRepositoryLocationAsync(
  startPath,
  openedStartPath = startPath,
  filesystem = fs.promises,
) {
  if (!startPath) return null;
  let current = path.resolve(startPath);
  const resolvedStartPath = current;
  const sameSpelling = normalizedPathsAreEqual(
    normalizeLexicalPath(openedStartPath),
    normalizeLexicalPath(resolvedStartPath),
    false,
  );
  while (!(await statForDiscoveryAsync(current, filesystem))?.isDirectory()) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }

  while (true) {
    const openedCurrent = path.resolve(openedStartPath, path.relative(resolvedStartPath, current));
    const markerDirectory =
      sameSpelling ||
      normalizedPathsAreEqual(
        await realpathRecursiveAsync(openedCurrent, filesystem),
        normalizeLexicalPath(current),
        false,
      )
        ? openedCurrent
        : current;
    const dotGit = path.join(markerDirectory, ".git");
    const dotGitEntry = await lstatForDiscoveryAsync(dotGit, filesystem);
    if (dotGitEntry) {
      let dotGitStat;
      try {
        dotGitStat = await statForDiscoveryAsync(dotGit, filesystem);
      } catch (error) {
        if (error.code === "ELOOP") return { invalidMarker: true };
        throw error;
      }
      if (!dotGitStat) return { invalidMarker: true };
      if (dotGitStat.isDirectory() && (await isGitDirectoryAsync(dotGit, filesystem))) {
        return {
          gitDirectory: dotGit,
          discoveredWorkingDirectory: current,
          worktreeGitMarker: { path: dotGit, kind: "directory" },
        };
      }
      if (dotGitStat.isFile()) {
        const resolved = await resolveGitFileAsync(dotGit, current, filesystem);
        if (resolved && (await isGitDirectoryAsync(resolved, filesystem))) {
          return {
            gitDirectory: resolved,
            discoveredWorkingDirectory: current,
            worktreeGitMarker: { path: dotGit, kind: "gitfile" },
          };
        }
      }
      return { invalidMarker: true };
    }
    if (await isGitDirectoryAsync(current, filesystem)) {
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
      const linkedMarker = await linkedWorktreeMarkerAsync(current, filesystem);
      if (linkedMarker) return { gitDirectory: current, ...linkedMarker };
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

// When the opened path is reached through a symlink, remember the unresolved
// directory that maps to the working directory so paths arriving through that
// symlink still route.

async function computeOpenedWorkingDirectoryAsync(
  startPath,
  workingDirectory,
  caseInsensitive,
  resolvedStartPath = null,
) {
  if (!workingDirectory) return null;
  const normalizedStartPath = normalizeLexicalPath(startPath);
  if (
    normalizedPathsAreEqual(
      resolvedStartPath || (await realpathRecursiveAsync(startPath)),
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
  constructor(gitDir, resolved) {
    this.gitDir = resolved.gitDir;
    this.gitDirectoryAliases = new Set([this.gitDir, normalizeLexicalPath(gitDir)]);
    for (const alias of resolved.gitDirectoryAliases || []) {
      if (alias) this.gitDirectoryAliases.add(alias);
    }
    this.worktreeGitMarker = resolved.worktreeGitMarker || null;
    this.gitDirectoryIdentity = resolved.gitDirectoryIdentity || null;
    this.workingDirectoryIdentity = resolved.workingDirectoryIdentity || null;
    this.commonDirectory = resolved.commonDirectory || this.gitDir;
    this.commonDirectoryIdentity = resolved.commonDirectoryIdentity || null;
    this.workingDirectory = resolved.workingDirectory;
    this.caseInsensitiveFs = resolved.caseInsensitiveFs;
    this.openedWorkingDirectory = resolved.openedWorkingDirectory;
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

  getGitDirectoryIdentity() {
    return this.gitDirectoryIdentity;
  }

  getWorkingDirectoryIdentity() {
    return this.workingDirectoryIdentity;
  }

  getCommonDirectory() {
    return this.commonDirectory;
  }

  getCommonDirectoryIdentity() {
    return this.commonDirectoryIdentity;
  }

  getGitDirectoryAliases() {
    return Array.from(this.gitDirectoryAliases);
  }
}

// Discover the repository for a starting path and build its descriptor, or null
// when the path is not inside a repository.

async function discoverRepositoryDescriptorAsync(startPath) {
  // Share only the candidate walk. Identity, config and marker construction
  // below start fresh; an earlier request must not supply their final reads.
  const resolvedStartPath = startPath
    ? await realpathRecursiveAsync(path.resolve(startPath), sharedDiscoveryFilesystem)
    : null;
  const location = await discoverRepositoryLocationAsync(
    resolvedStartPath,
    startPath,
    sharedDiscoveryFilesystem,
  );
  if (!location || location.invalidMarker) return null;

  const gitDir = await realpathAsync(location.gitDirectory);
  const gitDirectoryIdentity = filesystemIdentity(await fs.promises.stat(gitDir, { bigint: true }));
  const commonDirectory = await commonDirectoryLocationAsync(gitDir);
  const rawWorkingDirectory = await computeWorkingDirectoryAsync(
    gitDir,
    location.discoveredWorkingDirectory,
    commonDirectory.path,
  );
  if (rawWorkingDirectory === undefined) return null;
  const workingDirectory = rawWorkingDirectory
    ? trimTrailingSeparator(await normalizePathAsync(rawWorkingDirectory))
    : null;
  let workingDirectoryIdentity = null;
  if (workingDirectory) {
    try {
      workingDirectoryIdentity = filesystemIdentity(
        await fs.promises.stat(workingDirectory, { bigint: true }),
      );
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }
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
    resolvedStartPath,
  );
  const openedGitDirectory = openedWorkingDirectory
    ? worktreeGitMarker?.kind === "directory"
      ? normalizeLexicalPath(path.join(openedWorkingDirectory, ".git"))
      : null
    : await computeOpenedWorkingDirectoryAsync(
        startPath,
        gitDir,
        caseInsensitiveFs,
        resolvedStartPath,
      );
  return new GitRepositoryDescriptor(location.gitDirectory, {
    gitDir,
    workingDirectory,
    worktreeGitMarker,
    gitDirectoryIdentity,
    workingDirectoryIdentity,
    commonDirectory: commonDirectory.path,
    commonDirectoryIdentity: commonDirectory.identity,
    caseInsensitiveFs,
    openedWorkingDirectory,
    gitDirectoryAliases: [openedGitDirectory],
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

function repositoryDescriptorParts(descriptor, { requireComplete = false } = {}) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("A repository descriptor is required");
  }

  if (requireComplete) {
    const requiredFields = [
      ["gitDirectory", "getPath"],
      ["workingDirectory", "getWorkingDirectory"],
      ["worktreeGitMarker", "getWorktreeGitMarker"],
      ["gitDirectoryIdentity", "getGitDirectoryIdentity"],
      ["workingDirectoryIdentity", "getWorkingDirectoryIdentity"],
      ["commonDirectory", "getCommonDirectory"],
      ["commonDirectoryIdentity", "getCommonDirectoryIdentity"],
    ];
    const missing = requiredFields.find(
      ([field, getter]) =>
        !Object.prototype.hasOwnProperty.call(descriptor, field) &&
        typeof descriptor[getter] !== "function",
    );
    if (missing) {
      const error = new TypeError(`Repository descriptor is missing ${missing[0]}`);
      error.code = "ERR_GIT_REPOSITORY_DESCRIPTOR";
      throw error;
    }
  }

  const gitDirectory = descriptor.gitDirectory ?? descriptor.gitDir ?? descriptor.getPath?.();
  const workingDirectory = Object.prototype.hasOwnProperty.call(descriptor, "workingDirectory")
    ? descriptor.workingDirectory
    : descriptor.getWorkingDirectory?.();
  const worktreeGitMarker = Object.prototype.hasOwnProperty.call(descriptor, "worktreeGitMarker")
    ? descriptor.worktreeGitMarker
    : (descriptor.getWorktreeGitMarker?.() ?? null);
  const gitDirectoryIdentity =
    descriptor.gitDirectoryIdentity ?? descriptor.getGitDirectoryIdentity?.() ?? null;
  const workingDirectoryIdentity =
    descriptor.workingDirectoryIdentity ?? descriptor.getWorkingDirectoryIdentity?.() ?? null;
  const commonDirectory = descriptor.commonDirectory ?? descriptor.getCommonDirectory?.() ?? null;
  const commonDirectoryIdentity =
    descriptor.commonDirectoryIdentity ?? descriptor.getCommonDirectoryIdentity?.() ?? null;

  if (typeof gitDirectory !== "string" || gitDirectory.length === 0) {
    throw new TypeError("Repository descriptor gitDirectory must be a path");
  }
  if (workingDirectory !== null && typeof workingDirectory !== "string") {
    throw new TypeError("Repository descriptor workingDirectory must be a path or null");
  }
  if (
    commonDirectory !== null &&
    (typeof commonDirectory !== "string" || commonDirectory.length === 0)
  ) {
    throw new TypeError("Repository descriptor commonDirectory must be a path or null");
  }
  for (const [name, identity] of [
    ["gitDirectoryIdentity", gitDirectoryIdentity],
    ["workingDirectoryIdentity", workingDirectoryIdentity],
    ["commonDirectoryIdentity", commonDirectoryIdentity],
  ]) {
    if (
      identity !== null &&
      (typeof identity !== "object" || identity.device == null || identity.inode == null)
    ) {
      const error = new TypeError(`Repository descriptor ${name} must be an identity or null`);
      error.code = "ERR_GIT_REPOSITORY_DESCRIPTOR";
      throw error;
    }
  }
  if (requireComplete && commonDirectory === null) {
    const error = new TypeError("Repository descriptor commonDirectory must be a path");
    error.code = "ERR_GIT_REPOSITORY_DESCRIPTOR";
    throw error;
  }

  return {
    gitDirectory,
    workingDirectory,
    worktreeGitMarker: worktreeGitMarker ?? null,
    gitDirectoryIdentity,
    workingDirectoryIdentity,
    commonDirectory,
    commonDirectoryIdentity,
  };
}

function filesystemIdentityMatches(actual, expected) {
  return (
    !expected ||
    (actual &&
      actual.device === String(expected.device) &&
      actual.inode === String(expected.inode) &&
      (expected.birthtime == null || actual.birthtime === String(expected.birthtime)))
  );
}

function normalizedPathsMatch(pathA, pathB) {
  const normalizeForIdentity = (candidate) => {
    let normalized = normalizeLexicalPath(candidate);
    if (IS_WINDOWS && /^[A-Z]:/.test(normalized)) {
      normalized = `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
    }
    return normalized;
  };
  return normalizeForIdentity(pathA) === normalizeForIdentity(pathB);
}

function directoryPathsMatch(actualPath, actualIdentity, expectedPath, expectedIdentity) {
  if (normalizedPathsMatch(actualPath, expectedPath)) return true;
  // Case-insensitive filesystems preserve identity across a case-only rename.
  // Identity is required: folding alone would merge distinct case-sensitive
  // directories or accept replacement of the old path by another repository.
  return Boolean(
    actualIdentity &&
    expectedIdentity &&
    normalizedPathsMatch(actualPath.toLowerCase(), expectedPath.toLowerCase()) &&
    filesystemIdentityMatches(actualIdentity, expectedIdentity),
  );
}

async function inspectDirectoryAsync(candidate, missingReason, wrongTypeReason, signal) {
  throwIfAborted(signal);
  let stats;
  try {
    stats = await fs.promises.stat(candidate, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return { reason: missingReason };
    if (error.code === "ELOOP") return { reason: wrongTypeReason };
    throw error;
  }
  if (!stats.isDirectory()) return { reason: wrongTypeReason };

  try {
    const canonicalPath = trimTrailingSeparator(await normalizeExistingPathAsync(candidate));
    throwIfAborted(signal);
    stats = await fs.promises.stat(candidate, { bigint: true });
    if (!stats.isDirectory()) return { reason: wrongTypeReason };
    throwIfAborted(signal);
    return {
      path: canonicalPath,
      identity: filesystemIdentity(stats),
    };
  } catch (error) {
    if (isMissingPathError(error)) return { reason: missingReason };
    if (error.code === "ELOOP") return { reason: wrongTypeReason };
    throw error;
  }
}

function directoryInspectionsMatch(left, right) {
  if (
    !left?.path ||
    !right?.path ||
    !directoryPathsMatch(right.path, right.identity, left.path, left.identity)
  )
    return false;
  if (!left.identity && !right.identity) return true;
  return Boolean(
    left.identity &&
    right.identity &&
    left.identity.device === right.identity.device &&
    left.identity.inode === right.identity.inode &&
    (left.identity.birthtime == null ||
      right.identity.birthtime == null ||
      left.identity.birthtime === right.identity.birthtime),
  );
}

async function inspectCommonDirectoryAsync(gitDirectory, signal, gitDirectoryInspection = null) {
  const pointerPath = path.join(gitDirectory, "commondir");
  let pointerStats;
  try {
    pointerStats = await fs.promises.stat(pointerPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return (
        gitDirectoryInspection ||
        inspectDirectoryAsync(
          gitDirectory,
          "git-directory-missing",
          "git-directory-not-directory",
          signal,
        )
      );
    }
    if (error.code === "ELOOP") return { reason: "common-directory-not-directory" };
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
  const inspection = await inspectDirectoryAsync(
    commonDirectory,
    "common-directory-missing",
    "common-directory-not-directory",
    signal,
  );
  return inspection;
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
    if (error.code === "ELOOP") return { reason: "worktree-marker-invalid" };
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
    if (error.code === "ELOOP") return { reason: "worktree-marker-invalid" };
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
      if (error.code === "ELOOP") return { reason: "worktree-marker-invalid" };
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
  const target = parseGitFile(markerContents);
  if (!target) return { reason: "worktree-marker-invalid" };

  const targetPath = path.resolve(path.dirname(markerPath), target);
  let targetStats;
  let markerTarget;
  try {
    [targetStats, markerTarget] = await Promise.all([
      fs.promises.stat(targetPath),
      normalizeExistingPathAsync(targetPath),
    ]);
  } catch (error) {
    if (isMissingPathError(error)) return { reason: "worktree-marker-mismatch" };
    if (error.code === "ELOOP") return { reason: "worktree-marker-invalid" };
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
    const configuredPath = resolveConfiguredPath(gitDirectory, core.worktree);
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

async function inspectRepositoryDescriptorAsync(
  descriptor,
  { signal, checkGitMetadata = false } = {},
) {
  const parts = repositoryDescriptorParts(descriptor);
  throwIfAborted(signal);

  let workingDirectory = null;
  let inspectedWorkingDirectory = null;
  if (parts.workingDirectory !== null) {
    inspectedWorkingDirectory = await inspectDirectoryAsync(
      parts.workingDirectory,
      "working-directory-missing",
      "working-directory-not-directory",
      signal,
    );
    if (!inspectedWorkingDirectory.path) {
      return unavailableInspection(inspectedWorkingDirectory.reason);
    }
    if (
      !directoryPathsMatch(
        inspectedWorkingDirectory.path,
        inspectedWorkingDirectory.identity,
        trimTrailingSeparator(normalizeLexicalPath(parts.workingDirectory)),
        parts.workingDirectoryIdentity,
      ) ||
      !filesystemIdentityMatches(inspectedWorkingDirectory.identity, parts.workingDirectoryIdentity)
    ) {
      return unavailableInspection("working-directory-mismatch");
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
  if (
    !directoryPathsMatch(
      inspectedGitDirectory.path,
      inspectedGitDirectory.identity,
      trimTrailingSeparator(normalizeLexicalPath(parts.gitDirectory)),
      parts.gitDirectoryIdentity,
    ) ||
    !filesystemIdentityMatches(inspectedGitDirectory.identity, parts.gitDirectoryIdentity)
  ) {
    return unavailableInspection("git-directory-mismatch");
  }
  const gitDirectory = inspectedGitDirectory.path;

  const inspectedCommonDirectory = await inspectCommonDirectoryAsync(
    gitDirectory,
    signal,
    inspectedGitDirectory,
  );
  if (!inspectedCommonDirectory.path) {
    return unavailableInspection(inspectedCommonDirectory.reason);
  }
  if (
    (parts.commonDirectory &&
      !directoryPathsMatch(
        inspectedCommonDirectory.path,
        inspectedCommonDirectory.identity,
        trimTrailingSeparator(normalizeLexicalPath(parts.commonDirectory)),
        parts.commonDirectoryIdentity,
      )) ||
    !filesystemIdentityMatches(inspectedCommonDirectory.identity, parts.commonDirectoryIdentity)
  ) {
    return unavailableInspection("common-directory-mismatch");
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
    const core = await readCoreConfigAsync(gitDirectory, inspectedCommonDirectory.path);
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

  const finalWorkingDirectory = workingDirectory
    ? await inspectDirectoryAsync(
        parts.workingDirectory,
        "working-directory-missing",
        "working-directory-not-directory",
        signal,
      )
    : null;
  if (
    workingDirectory &&
    !directoryInspectionsMatch(inspectedWorkingDirectory, finalWorkingDirectory)
  ) {
    return unavailableInspection(
      finalWorkingDirectory.path ? "working-directory-mismatch" : finalWorkingDirectory.reason,
    );
  }

  const finalGitDirectory = await inspectDirectoryAsync(
    parts.gitDirectory,
    "git-directory-missing",
    "git-directory-not-directory",
    signal,
  );
  if (!directoryInspectionsMatch(inspectedGitDirectory, finalGitDirectory)) {
    return unavailableInspection(
      finalGitDirectory.path ? "git-directory-mismatch" : finalGitDirectory.reason,
    );
  }

  const finalCommonDirectory = await inspectCommonDirectoryAsync(
    finalGitDirectory.path,
    signal,
    finalGitDirectory,
  );
  if (!directoryInspectionsMatch(inspectedCommonDirectory, finalCommonDirectory)) {
    return unavailableInspection(
      finalCommonDirectory.path ? "common-directory-mismatch" : finalCommonDirectory.reason,
    );
  }

  if (parts.worktreeGitMarker) {
    const finalMarker = await inspectWorktreeMarkerAsync(
      parts.worktreeGitMarker,
      finalGitDirectory.path,
      finalWorkingDirectory.path,
      signal,
    );
    if (!finalMarker.marker) return unavailableInspection(finalMarker.reason);
    worktreeGitMarker = finalMarker.marker;
  } else {
    const finalCore = await readCoreConfigAsync(finalGitDirectory.path, finalCommonDirectory.path);
    throwIfAborted(signal);
    if (finalWorkingDirectory === null) {
      if (finalCore.worktree || parseConfiguredGitBoolean(finalCore.bare) === false) {
        return unavailableInspection("core-worktree-mismatch");
      }
    } else if (
      !(await configuredWorktreeMatchesAsync(
        finalCore,
        finalGitDirectory.path,
        finalWorkingDirectory.path,
        signal,
      ))
    ) {
      return unavailableInspection("core-worktree-mismatch");
    }
  }

  // Recursive removal can leave the Git directory in place after its HEAD or
  // object database has gone. Directory identity alone cannot classify that
  // command failure as the end of a repository's lifetime. Check its structure
  // on failure reinspection without adding metadata reads to every preflight.
  if (checkGitMetadata && !(await isGitDirectoryAsync(finalGitDirectory.path))) {
    throwIfAborted(signal);
    return unavailableInspection("git-metadata-missing");
  }
  throwIfAborted(signal);

  const normalizedDescriptor = Object.freeze({
    gitDirectory: finalGitDirectory.path,
    workingDirectory: finalWorkingDirectory?.path ?? null,
    worktreeGitMarker,
    gitDirectoryIdentity: finalGitDirectory.identity,
    workingDirectoryIdentity: workingDirectory === null ? null : finalWorkingDirectory.identity,
    commonDirectory: finalCommonDirectory.path,
    commonDirectoryIdentity: finalCommonDirectory.identity,
  });
  return Object.freeze({ available: true, descriptor: normalizedDescriptor });
}

async function assertRepositoryDescriptorAvailableAsync(
  descriptor,
  { signal, operation, checkGitMetadata = false } = {},
) {
  const parts = repositoryDescriptorParts(descriptor, { requireComplete: true });
  const inspection = await inspectRepositoryDescriptorAsync(descriptor, {
    signal,
    checkGitMetadata,
  });
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
  discoverRepositoryDescriptorAsync,
  inspectRepositoryDescriptorAsync,
  assertRepositoryDescriptorAvailableAsync,
  ERR_GIT_REPOSITORY_UNAVAILABLE,
};
