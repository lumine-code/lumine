const path = require("path");
const { Emitter, Disposable } = require("@lumine-code/event-kit");
const { discoverRepositoryDescriptorAsync } = require("./git-repository-descriptor");
const GitHostClient = require("./git-host-client");
const { EMPTY_STATUS_SNAPSHOT } = require("./repository-status-snapshot");
const { EMPTY_REFS_SNAPSHOT } = require("./repository-refs-snapshot");
const { relativize: relativizePath } = require("./repository-paths");
const { assertGitRevision } = require("./git-revision");
const { isRepositoryUnavailableError } = require("./git-error");

// A missing executable is shared by every repository in a window. Key the
// warning by its NotificationManager so one broken git.path does not produce a
// notification storm as each repository's background refresh fails.
const gitExecutableWarningsByManager = new WeakMap();

function deepFreeze(value) {
  if (
    value == null ||
    typeof value !== "object" ||
    Object.isFrozen(value) ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function statusPathKey(filePath) {
  const normalized = filePath.split(path.sep).join("/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function snapshotAbortError() {
  const error = new Error("The Git snapshot refresh was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function yieldToRenderer() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Leave enough of a 60 Hz frame for input, layout, and paint even when a Git
// snapshot contains tens of thousands of paths or refs. The checkpoint returns
// null on the hot path so callers only create/await a Promise when the budget is
// actually exhausted.
const SNAPSHOT_RENDERER_SLICE_BUDGET_MS = 2;

function createSnapshotRendererCheckpoint(repository, signal) {
  let sliceStartedAt = performance.now();
  return () => {
    if (performance.now() - sliceStartedAt < SNAPSHOT_RENDERER_SLICE_BUDGET_MS) return null;
    return yieldToRenderer().then(() => {
      if (signal?.aborted) throw snapshotAbortError();
      if (repository.isDestroyed()) return false;
      sliceStartedAt = performance.now();
      return true;
    });
  };
}

function freezeStatusEntry(entry) {
  if (Object.isFrozen(entry)) return entry;
  if (entry.submodule && typeof entry.submodule === "object") Object.freeze(entry.submodule);
  return Object.freeze(entry);
}

function freezeRefEntry(entry) {
  if (entry == null || typeof entry !== "object" || Object.isFrozen(entry)) return;
  if (entry.upstream && typeof entry.upstream === "object") Object.freeze(entry.upstream);
  if (entry.push && typeof entry.push === "object") Object.freeze(entry.push);
  if (entry.lastCommit && typeof entry.lastCommit === "object") {
    if (Array.isArray(entry.lastCommit.parents)) Object.freeze(entry.lastCommit.parents);
    if (entry.lastCommit.committerDate && typeof entry.lastCommit.committerDate === "object") {
      Object.freeze(entry.lastCommit.committerDate);
    }
    Object.freeze(entry.lastCommit);
  }
  Object.freeze(entry);
}

const REFS_SNAPSHOT_COLLECTIONS = ["branches", "remoteBranches", "tags", "remotes", "worktrees"];

async function freezeRefsSnapshotInRendererSlices(snapshot, checkpoint) {
  freezeRefEntry(snapshot.head);
  for (const collectionName of REFS_SNAPSHOT_COLLECTIONS) {
    const entries = snapshot[collectionName];
    for (let index = 0; index < entries.length; index++) {
      freezeRefEntry(entries[index]);
      const pendingYield = checkpoint();
      if (pendingYield && !(await pendingYield)) return false;
    }
    Object.freeze(entries);
  }
  deepFreeze(snapshot);
  return true;
}

// Classify a snapshot entry using the public repository precedence: modified
// beats added.
function summaryFromStatusEntry(entry) {
  const conflicted = entry.conflicted;
  const modified =
    !conflicted &&
    ((entry.indexStatus != null && entry.indexStatus !== "A") || entry.worktreeStatus != null);
  const added = !conflicted && !modified && (entry.untracked || entry.indexStatus === "A");
  return Object.freeze({
    source: "snapshot",
    conflicted,
    modified,
    added,
    renamed: entry.kind === "renamed" || entry.kind === "copied",
  });
}

/**
 * @public
 * @status extended
 *
 * Represents the underlying git operations performed by Lumine.
 *
 * This class shouldn't be instantiated directly but instead by accessing the
 * `lumine.repositories` and calling `getRepositories()` or `getForPath()`. It is
 * independent from project roots and may represent containing or nested repos.
 *
 * ## Examples
 *
 * ### Logging the URL of the origin remote
 *
 * ```js
 * const git = lumine.repositories.getRepositories()[0]
 * console.log(git.getOriginURL())
 * ```
 *
 * ### Requiring in packages
 *
 * ```js
 * const { GitRepository } = require('lumine')
 * ```
 */
module.exports = class GitRepository {
  /**
   * @category Construction and Destruction
   */

  /**
   * @public
   * @status public
   *
   * Creates a new GitRepository instance.
   *
   * @param path - The `String` path to the Git repository to open.
   * @param options - An optional `Object` with the following keys:
   * @returns {Promise<GitRepository|null>} resolving to an instance or `null` if the repository could not be opened.
   */
  static async open(path, options = {}) {
    if (!path) return null;
    try {
      const descriptor = options.descriptor || (await discoverRepositoryDescriptorAsync(path));
      return descriptor ? new GitRepository(descriptor, options) : null;
    } catch {
      return null;
    }
  }

  constructor(descriptor, options = {}) {
    this.emitter = new Emitter();
    if (!descriptor?.getPath || !descriptor?.getWorkingDirectory) {
      throw new TypeError("GitRepository requires a discovered repository descriptor");
    }
    this.descriptor = descriptor;

    // Cache the working directory and filesystem traits once so path routing
    // (getWorkingDirectory/relativize) needs no filesystem walk per query. These
    // are fixed for the repository's lifetime.
    this.workingDirectoryPath = this.descriptor.getWorkingDirectory();
    this.openedWorkingDirectoryPath = this.descriptor.openedWorkingDirectory || null;
    const gitDirectoryAliases = this.descriptor.getGitDirectoryAliases?.() || [
      this.descriptor.getPath(),
    ];
    this.workingDirectoryAliases = new Set(
      (this.workingDirectoryPath
        ? [this.workingDirectoryPath, this.openedWorkingDirectoryPath]
        : gitDirectoryAliases
      ).filter(Boolean),
    );
    this.gitDirectoryAliases = new Set(gitDirectoryAliases);
    this.caseInsensitiveFs = this.descriptor.caseInsensitiveFs === true;

    // Every read uses one renderer-to-worker contract. Git process creation,
    // parsing, fingerprinting, and line-diff computation stay off the renderer.
    this.gitHostClient = options.gitHostClient || new GitHostClient();
    this.statusSnapshot = EMPTY_STATUS_SNAPSHOT;
    this.statusSnapshotFingerprint = null;
    this.statusEntriesByPath = new Map();
    this.directoryStatusAggregates = new Map();
    this.ignoredFileKeys = new Set();
    this.ignoredDirKeys = [];
    this.submodulePathKeys = new Set();
    this.statusSnapshotSubscriberCount = 0;
    this.statusSnapshotDebounceMs = options.statusSnapshotDebounceMs ?? 150;
    this.refsSnapshot = EMPTY_REFS_SNAPSHOT;
    this.refsSnapshotFingerprint = null;
    this.refsSnapshotSubscriberCount = 0;
    this.refsSnapshotDebounceMs = options.refsSnapshotDebounceMs ?? 150;
    this.snapshotRefreshCoalescer = { flight: null, trailing: null };
    this.snapshotRefreshTimer = null;
    this.scheduledSnapshotKinds = new Set();
    this.backgroundSnapshotWarningShown = false;
    this.repositoryUnavailableError = null;

    this.operations = null;

    // Window-focus freshness is the registry's job (RepositoryRegistry
    // handleWindowFocus): it knows which repositories the project watcher
    // already keeps fresh and which one is on screen. A listener here would
    // put every registered repository on every focus event — one hundred
    // `git status` runs per alt-tab in a many-repository workspace.
  }

  /**
   * @public
   * @status public
   *
   * Destroy this {@link GitRepository} object.
   *
   * This destroys any tasks and subscriptions. Repository operations run in the
   * git-host process and hold no Git process or repository state in the renderer.
   * This method is idempotent.
   */
  destroy() {
    const pendingError = this.repositoryUnavailableError || snapshotAbortError();
    this.cancelSnapshotRequest(this.snapshotRefreshCoalescer.flight, pendingError);
    this.cancelSnapshotRequest(this.snapshotRefreshCoalescer.trailing, pendingError);
    this.descriptor = null;
    this.operations = null;
    this.gitHostClient = null;
    this.statusEntriesByPath.clear();
    this.directoryStatusAggregates.clear();
    this.submodulePathKeys.clear();
    if (this.snapshotRefreshTimer != null) {
      clearTimeout(this.snapshotRefreshTimer);
      this.snapshotRefreshTimer = null;
    }
    this.scheduledSnapshotKinds.clear();

    if (this.emitter) {
      this.emitter.emit("did-destroy");
      this.emitter.dispose();
      this.emitter = null;
    }
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} indicating if this repository has been destroyed.
   */
  isDestroyed() {
    return this.descriptor == null;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Object} stable write facade assigned by lumine.repositories. Its methods are enabled by repositories.operations-provider services.
   */
  getOperations() {
    return this.operations;
  }

  setOperations(operations) {
    this.operations = operations;
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when this GitRepository's destroy() method
   * is invoked.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  // Internal lifecycle event consumed by RepositoryRegistry. A missing working
  // directory means the checkout was moved, renamed, or deleted; it is not a
  // Git failure and must remove the stale routing entry without notifying.
  onDidBecomeUnavailable(callback) {
    return this.emitter.on("did-become-unavailable", callback);
  }

  signalRepositoryUnavailable(error) {
    if (this.isDestroyed() || this.repositoryUnavailableError) return;
    this.repositoryUnavailableError = error;
    this.emitter.emit("did-become-unavailable", Object.freeze({ repository: this, error }));
  }

  async repositoryHostRequest(callback) {
    if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
    if (!this.gitHostClient || this.isDestroyed()) throw new Error("Repository has been destroyed");
    try {
      return await callback(this.gitHostClient, this.getHostDescriptor());
    } catch (error) {
      if (isRepositoryUnavailableError(error)) this.signalRepositoryUnavailable(error);
      throw error;
    }
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the detailed repository status
   * snapshot changes.
   *
   * Subscribing declares interest: the repository lazily loads the first
   * snapshot and keeps it fresh with debounced background refreshes while at
   * least one subscriber exists. Consumers never call
   * {@link #refreshStatusSnapshot} themselves.
   *
   * @param {Function} callback - called with an immutable status snapshot.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeStatusSnapshot(callback) {
    this.statusSnapshotSubscriberCount++;
    this.scheduleStatusSnapshotRefresh();
    const subscription = this.emitter.on("did-change-status-snapshot", callback);
    let disposed = false;
    return new Disposable(() => {
      if (disposed) return;
      disposed = true;
      this.statusSnapshotSubscriberCount--;
      subscription.dispose();
    });
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the repository refs snapshot
   * changes. Subscribing declares interest exactly like
   * {@link #onDidChangeStatusSnapshot}: the first subscriber triggers a lazy load
   * and refs stay fresh with debounced background refreshes.
   *
   * @param {Function} callback - called with an immutable refs snapshot.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeRefsSnapshot(callback) {
    this.refsSnapshotSubscriberCount++;
    this.scheduleRefsSnapshotRefresh();
    const subscription = this.emitter.on("did-change-refs-snapshot", callback);
    let disposed = false;
    return new Disposable(() => {
      if (disposed) return;
      disposed = true;
      this.refsSnapshotSubscriberCount--;
      subscription.dispose();
    });
  }

  /**
   * @category Repository Details
   */

  /**
   * @public
   * @status public
   *
   * A `String` indicating the type of version control system used by
   * this repository.
   *
   * @returns {"git"}.
   */
  getType() {
    return "git";
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} path of the repository.
   */
  getPath() {
    if (this.path == null) {
      if (this.isDestroyed()) throw new Error("Repository has been destroyed");
      this.path = path.resolve(this.descriptor.getPath());
    }
    return this.path;
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} working directory path of the repository.
   */
  getWorkingDirectory() {
    return this.workingDirectoryPath;
  }

  // Structured-clone-safe descriptor consumed by git-host. The renderer has
  // already resolved worktree, submodule, symlink, and bare-repository semantics,
  // so the worker targets exactly this repository without upward discovery.
  getHostDescriptor() {
    if (this.isDestroyed()) throw new Error("Repository has been destroyed");
    const worktreeGitMarker = this.descriptor.getWorktreeGitMarker?.() ?? null;
    return Object.freeze({
      gitDirectory: this.getPath(),
      workingDirectory: this.getWorkingDirectory(),
      worktreeGitMarker: worktreeGitMarker
        ? Object.freeze({
            path: worktreeGitMarker.path,
            kind: worktreeGitMarker.kind,
          })
        : null,
    });
  }

  /**
   * @public
   * @status public
   *
   * Makes a path relative to the repository's working directory.
   */
  relativize(path) {
    return relativizePath(path, this.workingDirectoryAliases, this.caseInsensitiveFs);
  }

  addWorkingDirectoryAlias(directoryPath) {
    if (directoryPath) this.workingDirectoryAliases.add(directoryPath);
  }

  removeWorkingDirectoryAlias(directoryPath) {
    if (!directoryPath) return;
    const normalize = (candidate) => {
      const resolved = path.resolve(candidate);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const target = normalize(directoryPath);
    const primary = this.workingDirectoryPath ? normalize(this.workingDirectoryPath) : null;
    if (target === primary) return;
    for (const alias of this.workingDirectoryAliases) {
      if (normalize(alias) === target) this.workingDirectoryAliases.delete(alias);
    }
    if (this.openedWorkingDirectoryPath && normalize(this.openedWorkingDirectoryPath) === target) {
      this.openedWorkingDirectoryPath = null;
    }
  }

  getWorkingDirectoryAliases() {
    return Array.from(this.workingDirectoryAliases);
  }

  addGitDirectoryAlias(directoryPath) {
    if (!directoryPath) return;
    this.gitDirectoryAliases.add(directoryPath);
    if (!this.workingDirectoryPath) this.workingDirectoryAliases.add(directoryPath);
  }

  removeGitDirectoryAlias(directoryPath) {
    if (!directoryPath) return;
    const normalize = (candidate) => {
      const resolved = path.resolve(candidate);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const target = normalize(directoryPath);
    const primary = normalize(this.getPath());
    if (target === primary) return;
    for (const alias of this.gitDirectoryAliases) {
      if (normalize(alias) === target) this.gitDirectoryAliases.delete(alias);
    }
    if (!this.workingDirectoryPath) {
      for (const alias of this.workingDirectoryAliases) {
        if (normalize(alias) === target) this.workingDirectoryAliases.delete(alias);
      }
    }
  }

  getGitDirectoryAliases() {
    return Array.from(this.gitDirectoryAliases);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} true if the given branch exists.
   */
  hasBranch(branch) {
    return this.getReferenceTarget(`refs/heads/${branch}`) != null;
  }

  /**
   * @public
   * @status public
   *
   * Retrieves a shortened version of the HEAD reference value.
   *
   * This removes the leading segments of `refs/heads`, `refs/tags`, or
   * `refs/remotes`. It also shortens the object id of a detached `HEAD` to 7
   * characters, independent of the repository's object format.
   *
   * @returns {String} The shortened `HEAD` reference.
   */
  getShortHead() {
    if (this.isDestroyed()) throw new Error("Repository has been destroyed");
    // Read the head from whichever snapshot has loaded. Both carry the branch
    // name (or a shortened oid for a detached HEAD); the status snapshot is the
    // one the file-tree/tab UI keeps warm, the refs snapshot backs the branch
    // switcher and window title.
    for (const snapshot of [this.statusSnapshot, this.refsSnapshot]) {
      if (snapshot.initialized && snapshot.head) {
        const head = snapshot.head;
        if (head.name) return head.name;
        if (head.detached && head.oid) return head.oid.slice(0, 7);
      }
    }
    return "";
  }

  /**
   * @public
   * @status public
   *
   * Is the given path a submodule in the repository?
   *
   * @param filePath - The `String` path to check.
   * @returns {Boolean}
   */
  isSubmodule(filePath) {
    if (!filePath || this.isDestroyed()) return false;
    return this.submodulePathKeys.has(statusPathKey(this.relativize(filePath)));
  }

  /**
   * @public
   * @status public
   *
   * @param reference - The `String` branch reference name.
   * @returns {Object} The `ahead` and `behind` commit counts.
   */
  getAheadBehindCount(reference) {
    if (this.refsSnapshot.initialized) {
      const branch = this.refsSnapshotBranchForReference(reference);
      if (branch?.upstream) {
        return { ahead: branch.upstream.ahead, behind: branch.upstream.behind };
      }
    }
    return { ahead: 0, behind: 0 };
  }

  /**
   * @public
   * @status public
   *
   * Get the cached ahead/behind commit counts for the current branch's
   * upstream branch.
   *
   *   * `ahead`  The `Number` of commits ahead.
   *   * `behind` The `Number` of commits behind.
   *
   * @returns {Object} with the following keys:
   */
  getCachedUpstreamAheadBehindCount() {
    if (this.refsSnapshot.initialized) {
      const branch = this.refsSnapshot.branches.find((entry) => entry.isHead);
      if (branch?.upstream) {
        return { ahead: branch.upstream.ahead, behind: branch.upstream.behind };
      }
    }
    return { ahead: 0, behind: 0 };
  }

  /**
   * @public
   * @status public
   *
   * Asynchronously read a git configuration value via the git-host worker.
   * Resolves to the value or `null` when unset.
   *
   * @param {String} key - The configuration key to look up.
   * @returns {Promise<String|null>} The configured value.
   */
  async getConfigValueAsync(key) {
    const values = await this.getConfigValuesAsync([key]);
    return Object.hasOwn(values, key) ? values[key] : null;
  }

  /**
   * @public
   * @status public
   *
   * Read several effective Git configuration values in one repository pass.
   * Every requested key is present on the resolved plain object and maps
   * to a `String` value or `null` when unset.
   *
   * @param {Array<String>} keys - Configuration keys to read.
   * @returns {Promise<Object>} Values keyed by the requested names.
   */
  getConfigValuesAsync(keys) {
    const requested = Array.from(keys || [], String);
    if (requested.length === 0) return Promise.resolve({});
    if (this.isDestroyed()) {
      if (this.repositoryUnavailableError) return Promise.reject(this.repositoryUnavailableError);
      return Promise.resolve(Object.fromEntries(requested.map((key) => [key, null])));
    }
    return this.repositoryHostRequest((client, descriptor) =>
      client.getConfigValues(descriptor, requested),
    ).then((values) =>
      Object.fromEntries(
        requested.map((key) => [key, Object.hasOwn(values || {}, key) ? values[key] : null]),
      ),
    );
  }

  /**
   * @public
   * @status public
   *
   * @returns {String|null} origin url of the repository, read from the refs snapshot's remotes. Returns `null` until the snapshot has loaded or when the repository has no `origin` remote.
   */
  getOriginURL() {
    if (this.refsSnapshot.initialized) {
      const origin = this.refsSnapshot.remotes.find((remote) => remote.name === "origin");
      if (origin) return origin.fetchUrl ?? null;
    }
    return null;
  }

  /**
   * @public
   * @status public
   *
   * @returns {String|null} The upstream branch, such as `refs/remotes/origin/master`, or `null` when HEAD has no upstream.
   */
  getUpstreamBranch() {
    if (this.refsSnapshot.initialized) {
      const branch = this.refsSnapshot.branches.find((entry) => entry.isHead);
      return branch?.upstream?.ref ?? null;
    }
    return null;
  }

  /**
   * @public
   * @status public
   *
   * Gets all the local and remote references.
   *
   *  * `heads`   An `Array` of head reference names.
   *  * `remotes` An `Array` of remote reference names.
   *  * `tags`    An `Array` of tag reference names.
   *
   * @returns {Object} with the following keys:
   */
  getReferences() {
    const snapshot = this.refsSnapshot;
    return {
      heads: snapshot.branches.map((branch) => branch.ref),
      remotes: snapshot.remoteBranches.map((branch) => branch.ref),
      tags: snapshot.tags.map((tag) => tag.ref),
    };
  }

  /**
   * @public
   * @status public
   *
   * @param reference - The `String` reference to get the target of.
   * @returns {String|null} The current SHA for the reference, or `null` when it
   *   is unavailable.
   */
  getReferenceTarget(reference) {
    if (this.refsSnapshot.initialized) {
      const target = this.refsSnapshotReferenceTarget(reference);
      if (target !== undefined) return target;
    }
    return null;
  }

  // Resolve the branch entry a ref/name refers to in the refs snapshot, or the
  // current HEAD branch when no reference is given.
  refsSnapshotBranchForReference(reference) {
    if (!reference) {
      return this.refsSnapshot.branches.find((branch) => branch.isHead) || null;
    }
    return (
      this.refsSnapshot.branches.find(
        (branch) => branch.ref === reference || branch.name === reference,
      ) || null
    );
  }

  // Resolve a fully-qualified ref (or `HEAD`) to its object id using the refs
  // snapshot. Returns `undefined` when the snapshot cannot resolve it, so the
  // caller can fall back to a live lookup.
  refsSnapshotReferenceTarget(reference) {
    if (!reference) return undefined;
    if (reference === "HEAD") return this.refsSnapshot.head?.oid ?? null;
    const snapshot = this.refsSnapshot;
    const branch = snapshot.branches.find((entry) => entry.ref === reference);
    if (branch) return branch.oid;
    const remoteBranch = snapshot.remoteBranches.find((entry) => entry.ref === reference);
    if (remoteBranch) return remoteBranch.oid;
    const tag = snapshot.tags.find((entry) => entry.ref === reference);
    if (tag) return tag.oid;
    return undefined;
  }

  /**
   * @category Reading Status
   */

  /**
   * @public
   * @status public
   *
   * @param path - The `String` path to check.
   * @returns {Boolean} Whether the path is modified in the detailed status snapshot. Returns `false` until the snapshot loads.
   */
  isPathModified(path) {
    const summary = this.getPathStatusSummary(path);
    return Boolean(summary && summary.modified);
  }

  /**
   * @public
   * @status public
   *
   * @param path - The `String` path to check.
   * @returns {Boolean} Whether the path is new in the detailed status snapshot. Returns `false` until the snapshot loads.
   */
  isPathNew(path) {
    const summary = this.getPathStatusSummary(path);
    return Boolean(summary && summary.added);
  }

  /**
   * @public
   * @status public
   *
   * Is the given path ignored? Resolved from the detailed status
   * snapshot's ignored entries; returns false until the snapshot has loaded.
   *
   * @param path - The `String` path to check.
   * @returns {Boolean} that's true if the `path` is ignored.
   */
  isPathIgnored(path) {
    return this.isPathIgnoredCached(path);
  }

  /**
   * @public
   * @status public
   *
   * Whether the given path is ignored, resolved synchronously from the
   * Git status snapshot's ignored entries. Returns false until the first
   * snapshot loads.
   *
   * @param filePath - The `String` path to check.
   * @returns {Boolean} that's true if the `filePath` is ignored.
   */
  isPathIgnoredCached(filePath) {
    if (this.isDestroyed() || !this.statusSnapshot.initialized) return false;

    const relativePath = this.relativize(String(filePath));
    if (relativePath == null || relativePath === "") return false;
    const key = statusPathKey(relativePath);
    if (this.ignoredFileKeys.has(key)) return true;
    return this.ignoredDirKeys.some((dir) => key === dir || key.startsWith(`${dir}/`));
  }

  /**
   * @public
   * @status public
   *
   * @returns {Object} latest immutable detailed status snapshot. It contains `head`, `upstream`, `submodulePaths`, per-file staged/unstaged/conflict state, aggregate `counts`, and a monotonic `generation`. The initial snapshot has `initialized: false`; subscribe with {@link #onDidChangeStatusSnapshot} or call {@link #ensureStatusSnapshot} to load it.
   */
  getStatusSnapshot() {
    return this.statusSnapshot;
  }

  /**
   * @public
   * @status public
   *
   * Resolve with an initialized status snapshot, loading it on first
   * call. Concurrent callers share one in-flight refresh.
   *
   * @returns {Promise} that resolves to the snapshot.
   */
  async ensureStatusSnapshot(options = {}) {
    if (this.statusSnapshot.initialized) return this.statusSnapshot;
    // Any initialized snapshot satisfies an ensure, so the in-flight run is
    // shared instead of queueing a trailing one behind it.
    const flight = this.snapshotRefreshCoalescer.flight;
    if (flight?.mask.has("status") && !flight.controller.signal.aborted) {
      return this.waitForSnapshotRequest(flight, "status", options.signal);
    }
    return this.refreshStatusSnapshot(options);
  }

  // Schedule a background snapshot refresh. Calls within the debounce window
  // coalesce into a single Git subprocess; the window is not extended by
  // repeated calls, so a continuous event stream cannot starve the refresh.
  scheduleStatusSnapshotRefresh() {
    if (this.isDestroyed() || this.statusSnapshotSubscriberCount === 0) return;
    this.scheduleSnapshotRefresh("status", this.statusSnapshotDebounceMs);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Object|null} detailed cached status for a repository path, or `null`.
   */
  getStatusEntry(filePath) {
    if (filePath == null) return null;
    const inputPath = String(filePath);
    const relativePath = path.isAbsolute(inputPath) ? this.relativize(inputPath) : inputPath;
    return this.statusEntriesByPath.get(statusPathKey(relativePath)) || null;
  }

  // Merge status and refs refreshes through one single-flight-plus-trailing
  // coordinator. Synchronous callers share a microtask-sized dispatch window,
  // which lets status and refs requests issued together become one snapshot.
  // Once work has started, later callers join one trailing request whose mask
  // is the union of everything that arrived.
  coalesceSnapshotRefresh(kind, options = {}) {
    const state = this.snapshotRefreshCoalescer;

    const merge = (request, requestedKind, requestedOptions) => {
      request.mask.add(requestedKind);
      if (requestedKind === "status") {
        const includeIgnored = requestedOptions.includeIgnored !== false;
        request.statusIncludeIgnored =
          request.statusIncludeIgnored == null
            ? includeIgnored
            : request.statusIncludeIgnored || includeIgnored;
        request.options.includeIgnored = request.statusIncludeIgnored;
      }
      if (requestedOptions.priority === "interactive") request.options.priority = "interactive";
    };

    const begin = (request) => {
      state.flight = request;
      request.promise = Promise.resolve()
        .then(() => {
          request.started = true;
          if (request.waiters.size === 0) return;
          return this.executeSnapshotRefresh(request.mask, {
            ...request.options,
            signal: request.controller.signal,
          });
        })
        .then(
          () => this.settleSnapshotRequest(request),
          (error) => this.settleSnapshotRequest(request, error),
        )
        .finally(() => {
          if (state.flight === request) state.flight = null;
          const trailing = state.trailing;
          if (trailing) {
            state.trailing = null;
            begin(trailing);
          }
        })
        .catch((error) => console.error("Git snapshot coordinator failed", error));
    };

    if (!state.flight) {
      const requestOptions = { ...options };
      delete requestOptions.signal;
      const request = {
        mask: new Set([kind]),
        options: requestOptions,
        statusIncludeIgnored: kind === "status" ? options.includeIgnored !== false : null,
        controller: new AbortController(),
        waiters: new Set(),
        started: false,
        promise: null,
      };
      const result = this.waitForSnapshotRequest(request, kind, options.signal);
      begin(request);
      return result;
    }

    if (!state.flight.started) {
      merge(state.flight, kind, options);
      return this.waitForSnapshotRequest(state.flight, kind, options.signal);
    }

    if (!state.trailing) {
      const trailingOptions = { ...options };
      delete trailingOptions.signal;
      state.trailing = {
        mask: new Set([kind]),
        options: trailingOptions,
        statusIncludeIgnored: kind === "status" ? options.includeIgnored !== false : null,
        controller: new AbortController(),
        waiters: new Set(),
        started: false,
        promise: null,
      };
    } else {
      merge(state.trailing, kind, options);
    }

    return this.waitForSnapshotRequest(state.trailing, kind, options.signal);
  }

  waitForSnapshotRequest(request, kind, signal) {
    if (signal?.aborted) return Promise.reject(snapshotAbortError());
    return new Promise((resolve, reject) => {
      const waiter = { kind, signal, resolve, reject, onAbort: null };
      waiter.onAbort = () => {
        if (!request.waiters.delete(waiter)) return;
        signal.removeEventListener("abort", waiter.onAbort);
        reject(snapshotAbortError());
        if (request.started && request.waiters.size === 0) request.controller.abort();
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      request.waiters.add(waiter);
    });
  }

  settleSnapshotRequest(request, error = null) {
    for (const waiter of request.waiters) {
      if (waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (error) waiter.reject(error);
      else waiter.resolve(waiter.kind === "status" ? this.statusSnapshot : this.refsSnapshot);
    }
    request.waiters.clear();
  }

  cancelSnapshotRequest(request, error = snapshotAbortError()) {
    if (!request) return;
    request.controller.abort();
    if (globalThis.window?.lumine?.unloading) {
      for (const waiter of request.waiters) {
        if (waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      request.waiters.clear();
      return;
    }
    this.settleSnapshotRequest(request, error);
  }

  scheduleSnapshotRefresh(kind, debounceMs) {
    this.scheduledSnapshotKinds.add(kind);
    if (this.snapshotRefreshTimer != null) return;
    this.snapshotRefreshTimer = setTimeout(() => {
      this.snapshotRefreshTimer = null;
      if (this.isDestroyed()) return;
      const kinds = this.scheduledSnapshotKinds;
      this.scheduledSnapshotKinds = new Set();
      const refreshes = [];
      if (kinds.has("status")) refreshes.push(this.refreshStatusSnapshot());
      if (kinds.has("refs")) refreshes.push(this.refreshRefsSnapshot());
      Promise.all(refreshes).catch((error) => this.reportBackgroundSnapshotError(error));
    }, debounceMs);
  }

  async executeSnapshotRefresh(mask, options = {}) {
    if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
    if (!this.gitHostClient || this.isDestroyed()) throw new Error("Repository has been destroyed");

    const statusRequested = mask.has("status");
    const refsRequested = mask.has("refs");
    const includeIgnored = options.includeIgnored !== false;

    const result = await this.repositoryHostRequest((client, descriptor) =>
      client.getSnapshot(
        descriptor,
        {
          status: statusRequested,
          refs: refsRequested,
          includeIgnored,
          knownFingerprints: {
            ...(statusRequested && this.statusSnapshotFingerprint
              ? { status: this.statusSnapshotFingerprint }
              : {}),
            ...(refsRequested && this.refsSnapshotFingerprint
              ? { refs: this.refsSnapshotFingerprint }
              : {}),
          },
          generations: {
            status: this.statusSnapshot.generation + 1,
            refs: this.refsSnapshot.generation + 1,
          },
        },
        options,
      ),
    );

    if (this.isDestroyed()) {
      return { status: this.statusSnapshot, refs: this.refsSnapshot };
    }
    // Apply every valid section before reporting a missing or malformed sibling.
    const deferCombinedCommit = statusRequested && refsRequested;
    let preparedStatus = null;
    let preparedRefs = null;
    let responseError = null;
    if (statusRequested) {
      try {
        if (!result?.status) throw this.invalidSnapshotResponse("status");
        const applied = await this.applyStatusSnapshotSection(result.status, options.signal, {
          deferCommit: deferCombinedCommit,
        });
        if (deferCombinedCommit && applied?.commit) preparedStatus = applied;
      } catch (error) {
        responseError = error;
      }
    }
    // A combined request must be all-or-cancelled. In particular, an abort
    // observed at a renderer yield while indexing status must not let the refs
    // sibling update state after every waiter has gone away.
    if (options.signal?.aborted) throw responseError || snapshotAbortError();
    if (this.isDestroyed()) {
      return { status: this.statusSnapshot, refs: this.refsSnapshot };
    }
    if (refsRequested) {
      try {
        if (!result?.refs) throw this.invalidSnapshotResponse("refs");
        const applied = await this.applyRefsSnapshotSection(result.refs, options.signal, {
          deferCommit: deferCombinedCommit,
        });
        if (deferCombinedCommit && applied?.commit) preparedRefs = applied;
      } catch (error) {
        responseError ||= error;
      }
    }
    if (options.signal?.aborted) throw responseError || snapshotAbortError();
    if (this.isDestroyed()) {
      return { status: this.statusSnapshot, refs: this.refsSnapshot };
    }
    // Publish both state objects before either event fires, so every observer
    // sees one coherent combined snapshot. Listener failures cannot prevent
    // the sibling event from being delivered.
    preparedStatus?.commit();
    preparedRefs?.commit();
    for (const prepared of [preparedStatus, preparedRefs]) {
      try {
        prepared?.emit();
      } catch (error) {
        responseError ||= error;
      }
    }
    if (responseError) throw responseError;
    return { status: this.statusSnapshot, refs: this.refsSnapshot };
  }

  invalidSnapshotResponse(section) {
    const error = new Error(`Git snapshot omitted the requested ${section} section`);
    error.code = "ERR_GIT_SNAPSHOT";
    error.operation = "snapshot";
    return error;
  }

  async applyStatusSnapshotSection(section, signal, { deferCommit = false } = {}) {
    if (signal?.aborted) throw snapshotAbortError();
    if (section.unchanged) {
      const prepared = {
        commit: () => {
          this.statusSnapshotFingerprint = section.fingerprint;
        },
        emit: () => {},
        value: this.statusSnapshot,
      };
      if (deferCommit) return prepared;
      prepared.commit();
      return prepared.value;
    }
    if (!section.value || section.value.schemaVersion !== 1 || !section.value.initialized) {
      throw this.invalidSnapshotResponse("status value");
    }
    const snapshot = section.value;
    const statusEntriesByPath = new Map();
    const directoryStatusAggregates = new Map();
    const ignoredFileKeys = new Set();
    const ignoredDirKeys = [];
    const checkpoint = createSnapshotRendererCheckpoint(this, signal);
    const submodulePaths = snapshot.submodulePaths || [];
    const submodulePathKeys = new Set();

    for (const submodulePath of submodulePaths) {
      submodulePathKeys.add(statusPathKey(submodulePath));
      const pendingYield = checkpoint();
      if (pendingYield && !(await pendingYield)) return this.statusSnapshot;
    }

    for (let index = 0; index < snapshot.files.length; index++) {
      const entry = freezeStatusEntry(snapshot.files[index]);
      const entryKey = statusPathKey(entry.path);
      statusEntriesByPath.set(entryKey, entry);

      if (entry.ignored) {
        if (entry.path.endsWith("/")) ignoredDirKeys.push(statusPathKey(entry.path.slice(0, -1)));
        else ignoredFileKeys.add(entryKey);
      } else {
        const conflicted = entry.conflicted;
        const modified =
          !conflicted &&
          ((entry.indexStatus != null && entry.indexStatus !== "A") ||
            entry.worktreeStatus != null);
        const added = !conflicted && !modified && (entry.untracked || entry.indexStatus === "A");
        if (conflicted || modified || added) {
          let separatorIndex = entryKey.length;
          do {
            separatorIndex = entryKey.lastIndexOf("/", separatorIndex - 1);
            const key = separatorIndex === -1 ? "" : entryKey.slice(0, separatorIndex);
            let aggregate = directoryStatusAggregates.get(key);
            if (!aggregate) {
              aggregate = { conflicted: false, modified: false, added: false };
              directoryStatusAggregates.set(key, aggregate);
            }
            aggregate.conflicted ||= conflicted;
            aggregate.modified ||= modified;
            aggregate.added ||= added;

            const pendingYield = checkpoint();
            if (pendingYield && !(await pendingYield)) return this.statusSnapshot;
          } while (separatorIndex > 0);
        }
      }

      const pendingYield = checkpoint();
      if (pendingYield && !(await pendingYield)) return this.statusSnapshot;
    }

    Object.freeze(snapshot.files);
    Object.freeze(submodulePaths);
    deepFreeze(snapshot);
    if (signal?.aborted) throw snapshotAbortError();
    if (this.isDestroyed()) return this.statusSnapshot;
    const prepared = {
      commit: () => {
        this.statusSnapshotFingerprint = section.fingerprint;
        this.statusSnapshot = snapshot;
        this.statusEntriesByPath = statusEntriesByPath;
        this.directoryStatusAggregates = directoryStatusAggregates;
        this.ignoredFileKeys = ignoredFileKeys;
        this.ignoredDirKeys = ignoredDirKeys;
        this.submodulePathKeys = submodulePathKeys;
      },
      emit: () => this.emitter.emit("did-change-status-snapshot", snapshot),
      value: snapshot,
    };
    if (deferCommit) return prepared;
    prepared.commit();
    prepared.emit();
    return prepared.value;
  }

  async applyRefsSnapshotSection(section, signal, { deferCommit = false } = {}) {
    if (signal?.aborted) throw snapshotAbortError();
    if (section.unchanged) {
      const prepared = {
        commit: () => {
          this.refsSnapshotFingerprint = section.fingerprint;
        },
        emit: () => {},
        value: this.refsSnapshot,
      };
      if (deferCommit) return prepared;
      prepared.commit();
      return prepared.value;
    }
    if (!section.value || section.value.schemaVersion !== 1 || !section.value.initialized) {
      throw this.invalidSnapshotResponse("refs value");
    }
    const snapshot = section.value;
    const checkpoint = createSnapshotRendererCheckpoint(this, signal);
    if (!(await freezeRefsSnapshotInRendererSlices(snapshot, checkpoint))) {
      return this.refsSnapshot;
    }
    if (signal?.aborted) throw snapshotAbortError();
    if (this.isDestroyed()) return this.refsSnapshot;
    const prepared = {
      commit: () => {
        this.refsSnapshotFingerprint = section.fingerprint;
        this.refsSnapshot = snapshot;
      },
      emit: () => this.emitter.emit("did-change-refs-snapshot", snapshot),
      value: snapshot,
    };
    if (deferCommit) return prepared;
    prepared.commit();
    prepared.emit();
    return prepared.value;
  }

  reportBackgroundSnapshotError(error) {
    if (this.isDestroyed()) return;
    const diagnosticCode = error?.gitCode || error?.code;
    if (isRepositoryUnavailableError(error)) {
      this.signalRepositoryUnavailable(error);
      return;
    }
    console.error("Git snapshot refresh failed", error);
    if (diagnosticCode === "ERR_GIT_EXECUTABLE_NOT_FOUND") {
      const notifications = globalThis.lumine?.notifications;
      if (
        notifications &&
        (typeof notifications === "object" || typeof notifications === "function") &&
        gitExecutableWarningsByManager.get(notifications) !== error.message
      ) {
        gitExecutableWarningsByManager.set(notifications, error.message);
        notifications.addWarning?.("Git executable could not be started", {
          detail: error.message,
          dismissable: true,
        });
      }
      return;
    }
    if (this.backgroundSnapshotWarningShown) return;
    this.backgroundSnapshotWarningShown = true;
    globalThis.lumine?.notifications?.addWarning?.("Git repository data could not be refreshed", {
      detail: error.message,
      dismissable: true,
    });
  }

  /**
   * @public
   * @status public
   *
   * Refresh the detailed branch and file status snapshot with Git.
   * Concurrent calls coalesce into at most one in-flight and one trailing
   * worker request.
   */
  refreshStatusSnapshot(options = {}) {
    return this.coalesceSnapshotRefresh("status", options);
  }

  /**
   * @public
   * @status public
   *
   * Classified status for one path, read from the detailed status
   * snapshot.
   *
   * @param filePath - A `String` path, absolute or repository-relative.
   * @returns {Object|null} frozen `{source, conflicted, modified, added, renamed}` object (`source` is always `"snapshot"`), or `null` for clean, ignored, unknown, and pre-snapshot paths.
   */
  getPathStatusSummary(filePath) {
    if (filePath == null || this.isDestroyed() || !this.statusSnapshot.initialized) return null;

    const entry = this.getStatusEntry(filePath);
    if (!entry || entry.ignored) return null;
    return summaryFromStatusEntry(entry);
  }

  /**
   * @public
   * @status public
   *
   * Aggregate classified status for a directory, including the
   * repository root. Same sourcing and shape as {@link #getPathStatusSummary}
   * (without `renamed`); returns `null` when nothing below the directory has
   * a reportable status.
   */
  getDirectoryStatusSummary(directoryPath) {
    if (directoryPath == null || this.isDestroyed() || !this.statusSnapshot.initialized) {
      return null;
    }
    const relativePath = this.relativize(String(directoryPath));
    if (relativePath == null) return null;

    const aggregate = this.directoryStatusAggregates.get(statusPathKey(relativePath));
    if (!aggregate) return null;
    return Object.freeze({
      source: "snapshot",
      conflicted: aggregate.conflicted,
      modified: aggregate.modified,
      added: aggregate.added,
    });
  }

  /**
   * @public
   * @status public
   *
   * @returns {Object} latest immutable refs snapshot. It contains `head`, local `branches` with upstream tracking, `remoteBranches`, `tags`, `remotes` with fetch and push URLs, `worktrees`, and a monotonic `generation`. Branch and tag entries include `lastCommit` metadata for their target commit. The initial snapshot has `initialized: false`; subscribe with {@link #onDidChangeRefsSnapshot} or call {@link #ensureRefsSnapshot} to load it.
   */
  getRefsSnapshot() {
    return this.refsSnapshot;
  }

  /**
   * @public
   * @status public
   *
   * Resolve with an initialized refs snapshot, loading it on first
   * call. Concurrent callers share one in-flight refresh.
   *
   * @returns {Promise} that resolves to the snapshot.
   */
  async ensureRefsSnapshot(options = {}) {
    if (this.refsSnapshot.initialized) return this.refsSnapshot;
    // Any initialized snapshot satisfies an ensure, so the in-flight run is
    // shared instead of queueing a trailing one behind it.
    const flight = this.snapshotRefreshCoalescer.flight;
    if (flight?.mask.has("refs") && !flight.controller.signal.aborted) {
      return this.waitForSnapshotRequest(flight, "refs", options.signal);
    }
    return this.refreshRefsSnapshot(options);
  }

  // Schedule a background refs refresh with the same coalescing rules as
  // {@link #scheduleStatusSnapshotRefresh}.
  scheduleRefsSnapshotRefresh() {
    if (this.isDestroyed() || this.refsSnapshotSubscriberCount === 0) return;
    this.scheduleSnapshotRefresh("refs", this.refsSnapshotDebounceMs);
  }

  /**
   * @public
   * @status public
   *
   * Refresh the refs snapshot with Git. Concurrent calls coalesce into
   * at most one in-flight and one trailing worker request.
   */
  refreshRefsSnapshot(options = {}) {
    return this.coalesceSnapshotRefresh("refs", options);
  }

  /**
   * @public
   * @status public
   *
   * Compute a structured diff between two endpoints.
   *
   * @param {Object} [options] - Diff options.
   * @param {Object} [options.from] - The starting endpoint.
   * @param {Object} [options.to] - The ending endpoint. Endpoints may be commit,
   *   index, worktree, file, or empty descriptors.
   * @param {Array<String>} [options.paths] - Pathspecs limiting the diff.
   * @param {Number} [options.context=3] - Context lines.
   * @param {Boolean} [options.ignoreWhitespace=false] - Ignore all whitespace.
   * @param {Boolean} [options.detectRenames=true] - Detect renames.
   * @param {String} [options.diffFilter] - A Git diff-filter value.
   * @param {"structured"|"patch"|"both"} [options.format="structured"] -
   *   Select structured files, raw patch text, or both.
   * @param {Number} [options.maxBytes=10485760] - Output limit. Exceeding it
   *   rejects with `ERR_GIT_DIFF_TOO_LARGE`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to a frozen `{schemaVersion, files, rawPatch?}` object; `rawPatch` is present only for `patch` and `both`.
   */
  async getDiff({
    from = { type: "index" },
    to = { type: "worktree" },
    paths = [],
    context = 3,
    ignoreWhitespace = false,
    detectRenames = true,
    diffFilter = null,
    format = "structured",
    maxBytes = 10 * 1024 * 1024,
    signal,
  } = {}) {
    if (!this.gitHostClient || this.isDestroyed()) throw new Error("Repository has been destroyed");

    if (from?.type === "commit") assertGitRevision(from.revision);
    if (to?.type === "commit") assertGitRevision(to.revision);

    if (!new Set(["structured", "patch", "both"]).has(format)) {
      throw new TypeError(`Unsupported diff format: ${format}`);
    }

    const result = await this.repositoryHostRequest((client, descriptor) =>
      client.getDiff(
        descriptor,
        { from, to, paths, context, ignoreWhitespace, detectRenames, diffFilter, format },
        { maxBytes, signal },
      ),
    );
    if (result?.schemaVersion !== 1 || !Array.isArray(result.files)) {
      const error = new Error("Git host returned an invalid structured diff");
      error.code = "ERR_GIT_DIFF";
      error.operation = "diff";
      throw error;
    }
    if (format !== "structured" && typeof result.rawPatch !== "string") {
      const error = new Error("Git host omitted the requested raw diff patch");
      error.code = "ERR_GIT_DIFF";
      error.operation = "diff";
      throw error;
    }
    return Object.freeze({
      schemaVersion: 1,
      files: Object.freeze(format === "patch" ? [] : result.files),
      ...(format === "structured" ? {} : { rawPatch: result.rawPatch }),
    });
  }

  // Turn an absolute or repository-relative path into the forward-slash
  // relative form Git commands expect in pathspecs and `rev:path` arguments.
  posixRelativePath(filePath) {
    const relativePath = this.relativize(String(filePath));
    if (relativePath == null) return String(filePath).split(path.sep).join("/");
    return relativePath.split(path.sep).join("/");
  }

  /**
   * @public
   * @status public
   *
   * Read paginated commit history.
   *
   * @param {Object} [options] - History options.
   * @param {String} [options.revision="HEAD"] - Starting revision.
   * @param {Boolean} [options.allRefs=false] - Walk every local/remote branch and tag instead of one starting revision.
   * @param {String} [options.path] - Limit history to one path and follow renames.
   * @param {Number} [options.limit=50] - Page size.
   * @param {Object} [options.cursor] - The `nextCursor` from a previous page.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to a frozen `{commits, hasMore, nextCursor}` object. Each commit has `sha`, `parents`, `author`, `committer`, `subject`, and `body`. An unborn repository resolves to an empty page.
   */
  async getCommits({
    revision = "HEAD",
    allRefs = false,
    path: pathOption = null,
    limit = 50,
    cursor = null,
    signal,
  } = {}) {
    const effectiveRevision = cursor?.revision ?? revision;
    const effectiveAllRefs = cursor?.allRefs ?? allRefs;
    const skip = cursor?.skip ?? 0;

    if (!effectiveAllRefs) assertGitRevision(effectiveRevision);

    const params = {
      revision: effectiveRevision,
      allRefs: effectiveAllRefs,
      path: pathOption ? this.posixRelativePath(pathOption) : null,
      limit: limit + 1,
      skip,
    };
    const records = await this.repositoryHostRequest((client, descriptor) =>
      client.getHistory(descriptor, params, { signal }),
    );
    const hasMore = records.length > limit;
    const commits = Object.freeze(records.slice(0, limit));
    return Object.freeze({
      commits,
      hasMore,
      nextCursor: hasMore
        ? Object.freeze({
            revision: effectiveRevision,
            ...(effectiveAllRefs ? { allRefs: true } : {}),
            skip: skip + limit,
          })
        : null,
    });
  }

  /**
   * @public
   * @status public
   *
   * Read one commit with its changed-file summary.
   *
   * @param sha - The `String` commit id or any revision expression.
   * @returns {Promise} resolving to the commit object extended with `changedFiles`: `[{path, originalPath, status, similarity}]`.
   */
  async getCommit(sha, { signal } = {}) {
    assertGitRevision(sha, { label: "commit" });
    const result = await this.repositoryHostRequest((client, descriptor) =>
      client.getCommit(descriptor, sha, { signal }),
    );
    if (!result) return null;
    const { files, changedFiles, ...commit } = result;
    return Object.freeze({
      ...commit,
      changedFiles: Object.freeze(changedFiles || files || []),
    });
  }

  /**
   * @public
   * @status public
   *
   * Read a file's contents at a revision.
   *
   * @param filePath - A `String` path, absolute or repository-relative.
   * @param revision - A `String` revision expression.
   * @param {Object} [options] - Read options.
   * @param {String} [options.encoding="utf8"] - Text encoding, or `"buffer"`
   *   for a `Buffer`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to the contents, or `null` when the path does not exist at that revision.
   */
  getFileAtRevision(filePath, revision, { encoding = "utf8", signal } = {}) {
    assertGitRevision(revision);
    return this.repositoryHostRequest((client, descriptor) =>
      client.getFileAtRevision(descriptor, this.posixRelativePath(filePath), revision, {
        encoding: encoding === "buffer" ? "buffer" : encoding,
        signal,
      }),
    );
  }

  /**
   * @public
   * @status public
   *
   * Read a file's staged contents directly from the repository index.
   *
   * @param filePath - A `String` path, absolute or repository-relative.
   * @param {Object} [options] - Read options.
   * @param {String} [options.encoding="utf8"] - Text encoding, or `"buffer"`
   *   for a `Buffer`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to the staged contents, or `null` when the
   *   path has no stage-0 index entry.
   */
  getIndexFile(filePath, { encoding = "utf8", signal } = {}) {
    return this.repositoryHostRequest((client, descriptor) =>
      client.getIndexFile(descriptor, this.posixRelativePath(filePath), {
        encoding: encoding === "buffer" ? "buffer" : encoding,
        signal,
      }),
    );
  }

  /**
   * @public
   * @status public
   *
   * Read a blob's contents by object id (`git cat-file -p <oid>`).
   *
   * @param oid - A `String` blob object id.
   * @param {Object} [options] - Read options.
   * @param {String} [options.encoding="utf8"] - Text encoding, or `"buffer"`
   *   for a `Buffer`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to the contents, or `null` when the oid does not name an object.
   */
  getBlob(oid, { encoding = "utf8", signal } = {}) {
    return this.repositoryHostRequest((client, descriptor) =>
      client.getBlob(descriptor, oid, {
        encoding: encoding === "buffer" ? "buffer" : encoding,
        signal,
      }),
    );
  }

  /**
   * @public
   * @status public
   *
   * Describe HEAD as a ref name (`git describe --contains --all
   * --always`). Returns a `Promise` resolving to the `String` description, or
   * `""` when the branch is unborn.
   */
  getDescription() {
    return this.repositoryHostRequest((client, descriptor) => client.getDescription(descriptor));
  }

  /**
   * @public
   * @status public
   *
   * The fully-qualified refnames of branches that contain a commit
   * (`git branch --contains`).
   *
   * @param commit - A `String` commit id or revision.
   * @param {Object} [options] - Branch filtering options.
   * @param {Boolean} [options.showLocal=false] - Include local branches.
   * @param {Boolean} [options.showRemote=false] - Include remote branches.
   * @param {String} [options.pattern] - Limit branch names by pattern.
   * @returns {Promise} resolving to an `Array` of refname `Strings`.
   */
  getBranchesContaining(commit, { showLocal = false, showRemote = false, pattern = null } = {}) {
    assertGitRevision(commit, { label: "commit" });
    return this.repositoryHostRequest((client, descriptor) =>
      client.getBranchesContaining(descriptor, commit, { showLocal, showRemote, pattern }),
    );
  }

  /**
   * @public
   * @status public
   *
   * The index mode of a path (`git ls-files --stage`).
   *
   * @param filePath - A `String` path, absolute or repository-relative.
   * @returns {Promise} resolving to the `String` mode (e.g. `"100644"`), or `null` when the path is not tracked.
   */
  getFileMode(filePath) {
    return this.repositoryHostRequest((client, descriptor) =>
      client.getFileMode(descriptor, this.posixRelativePath(filePath)),
    );
  }

  /**
   * @public
   * @status public
   *
   * The repository-relative paths declared in `.gitmodules`.
   *
   * @param {Object} [options] - Read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to an `Array` of path `Strings`.
   */
  async getSubmodulePaths(options = {}) {
    if (this.isDestroyed()) {
      if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
      return [];
    }
    const paths = Object.freeze(
      await this.repositoryHostRequest((client, descriptor) =>
        client.getSubmodulePaths(descriptor, options),
      ),
    );
    this.submodulePathKeys = new Set(paths.map((submodulePath) => statusPathKey(submodulePath)));
    return paths;
  }

  /**
   * @public
   * @status public
   *
   * Read line-by-line blame for a file.
   *
   * @param filePath - A `String` path, absolute or repository-relative.
   * @param {Object} [options] - Blame options.
   * @param {String} [options.revision] - Revision to blame.
   * @param {Boolean} [options.ignoreWhitespace] - Ignore whitespace-only changes when attributing a line, so a reindent does not reassign every line it touched.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to a frozen `{revision, lines}` object where each line has `line`, `originalLine`, `sha`, `author`, `summary`.
   */
  async getBlame(filePath, { revision = null, ignoreWhitespace = false, signal } = {}) {
    assertGitRevision(revision, { allowNull: true });
    const lines = await this.repositoryHostRequest((client, descriptor) =>
      client.getBlame(
        descriptor,
        this.posixRelativePath(filePath),
        { revision, ignoreWhitespace },
        { signal },
      ),
    );
    return Object.freeze({
      revision,
      lines: Object.freeze(lines),
    });
  }

  /**
   * @category Retrieving Diffs
   */

  /**
   * @public
   * @status public
   *
   * Computes gutter line diffs off the renderer thread via the git-host worker,
   * fetching and caching the HEAD blob before comparing it with the buffer.
   *
   * @param filePath - The `String` path relative to the repository.
   * @param text - The `String` to compare against the `HEAD` contents.
   * @param {Object} [options] - Diff options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise} resolving to an `Array` of hunk `Objects`, each with `oldStart`, `newStart`, `oldLines`, and `newLines`.
   */
  getLineDiffsAsync(filePath, text, { signal } = {}) {
    if (this.isDestroyed()) {
      return this.repositoryUnavailableError
        ? Promise.reject(this.repositoryUnavailableError)
        : Promise.resolve([]);
    }
    const relativePosixPath = this.relativize(filePath).split(path.sep).join("/");
    // The status snapshot's head oid keys the worker's blob cache; a HEAD move
    // produces a fresh key. Files inside submodules are owned by their own
    // repository, so this repository always keys against its own HEAD.
    const headOid = this.statusSnapshot?.head?.oid ?? null;
    return this.repositoryHostRequest((client, descriptor) =>
      client.getLineDiffs(descriptor, {
        relativePosixPath,
        headOid,
        text,
        ignoreEolWhitespace: process.platform === "win32",
        signal,
      }),
    );
  }

  /**
   * @category Checking Out
   */

  /**
   * @public
   * @status public
   *
   * Restore the contents of a path in the working directory and index
   * to the version at `HEAD`, via the repository operation provider
   * (`git checkout HEAD -- <path>`).
   *
   * @param filePath - The `String` path to checkout.
   * @returns {Promise} resolving to a `Boolean` that's true on success.
   */
  async checkoutHead(filePath) {
    if (this.isDestroyed()) return false;
    const operations = this.getOperations();
    if (!operations) return false;

    // The operation registry already refreshes the status snapshot before the
    // operation resolves; scheduling another refresh here only duplicated it.
    await operations.checkoutFiles([this.posixRelativePath(filePath)], "HEAD");
    return true;
  }

  /**
   * @public
   * @status public
   *
   * Checks out a branch in your repository via the repository operation
   * provider.
   *
   * @param reference - The `String` reference to checkout.
   * @param create - A `Boolean` value which, if true creates the new reference if it doesn't exist.
   * @returns {Promise} resolving to a `Boolean` that's true on success.
   */
  async checkoutReference(reference, create) {
    if (this.isDestroyed()) return false;
    const operations = this.getOperations();
    if (!operations) return false;

    // The operation registry refreshes the status snapshot (awaited) and the
    // refs snapshot (detached) for a checkout; no extra scheduling needed.
    await operations.checkout(reference, { createNew: create });
    return true;
  }

  /**
   * @category Private
   */

  // Subscribes to editor view event.
  async checkoutHeadForEditor(editor) {
    const buffer = editor.getBuffer();
    const bufferPath = buffer.getPath();
    if (!bufferPath) return;

    // Reload the buffer from disk even if the checkout could not run (no
    // operation provider, or a Git failure), matching the previous behavior
    // where the reload always followed the checkout attempt.
    try {
      await this.checkoutHead(bufferPath);
    } catch {
      // Swallowed: the reload below still discards the in-memory edits.
    }
    return buffer.reload();
  }
};
