const path = require("path");
const { Emitter, Disposable } = require("@lumine-code/event-kit");
const { discoverRepositoryDescriptorAsync } = require("./git-repository-descriptor");
const GitHostClient = require("./git-host-client");
const { EMPTY_STATUS_SNAPSHOT } = require("./repository-status-snapshot");
const { EMPTY_REFS_SNAPSHOT } = require("./repository-refs-snapshot");
const { relativize: relativizePath } = require("./repository-paths");
const { assertGitRevision } = require("./git-revision");
const { isRepositoryUnavailableError } = require("./git-error");
const completeCleanup = require("./complete-cleanup");

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

function cachedHeadsEqual(left, right) {
  return (
    left === right ||
    ((left?.name ?? null) === (right?.name ?? null) &&
      (left?.oid ?? null) === (right?.oid ?? null) &&
      Boolean(left?.detached) === Boolean(right?.detached) &&
      Boolean(left?.unborn) === Boolean(right?.unborn))
  );
}

function snapshotAbortError() {
  const error = new Error("The Git snapshot refresh was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function repositoryDestroyedError() {
  const error = new Error("Repository has been destroyed");
  error.code = "ERR_GIT_REPOSITORY_DESTROYED";
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
    staged: Boolean(entry.staged),
    unstaged: Boolean(entry.unstaged),
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
   * @param {String} path - The `String` path to the Git repository to open.
   * @param {Object} [options] - Optional repository construction settings.
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
    this.gitDirectoryIdentity = this.descriptor.getGitDirectoryIdentity?.() ?? null;
    this.workingDirectoryIdentity = this.descriptor.getWorkingDirectoryIdentity?.() ?? null;
    this.caseInsensitiveFs = this.descriptor.caseInsensitiveFs === true;

    // Every read uses one renderer-to-worker contract. Git process creation,
    // parsing, fingerprinting, and line-diff computation stay off the renderer.
    this.gitHostClient = options.gitHostClient || new GitHostClient();
    this.statusSnapshot = EMPTY_STATUS_SNAPSHOT;
    this.snapshotHead = null;
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
    this.debouncedSnapshotWaiters = new Map();
    this.backgroundSnapshotWarningShown = false;
    this.repositoryUnavailableError = null;
    this.repositoryReadControllers = new Set();

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
    for (const controller of this.repositoryReadControllers) controller.abort(pendingError);
    this.repositoryReadControllers.clear();
    this.cancelSnapshotRequest(this.snapshotRefreshCoalescer.flight, pendingError);
    this.cancelSnapshotRequest(this.snapshotRefreshCoalescer.trailing, pendingError);
    for (const kind of this.debouncedSnapshotWaiters.keys()) {
      for (const waiter of this.takeDebouncedSnapshotWaiters(kind)) waiter.reject(pendingError);
    }
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
      const emitter = this.emitter;
      this.emitter = null;
      let listenerError = null;
      try {
        emitter.emit("did-destroy");
      } catch (error) {
        listenerError = error;
      } finally {
        emitter.dispose();
      }
      if (listenerError) throw listenerError;
    }
  }

  /**
   * @public
   * @status public
   *
   * Check whether this repository has been destroyed.
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
   * Get the repository write facade supplied by operation providers.
   *
   * @returns {Object|null} stable write facade assigned by lumine.repositories. Its methods are enabled by repositories.operations-provider services.
   * @category Operations
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
   * @category Event Subscription
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
    try {
      this.emitter.emit("did-become-unavailable", Object.freeze({ repository: this, error }));
    } catch {
      // Repository unavailability is the operation's canonical failure. A
      // lifecycle observer must not replace it with its own exception.
    }
  }

  async repositoryHostRequest(callback, { signal = null } = {}) {
    if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
    if (!this.gitHostClient || this.isDestroyed()) throw repositoryDestroyedError();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.repositoryReadControllers.add(controller);
    try {
      const result = await callback(
        this.gitHostClient,
        this.getHostDescriptor(),
        controller.signal,
      );
      if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
      if (!this.gitHostClient || this.isDestroyed()) throw repositoryDestroyedError();
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (isRepositoryUnavailableError(error)) this.signalRepositoryUnavailable(error);
      if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.repositoryReadControllers.delete(controller);
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
    if (this.statusSnapshotSubscriberCount === 1) this.scheduleStatusSnapshotRefresh();
    const subscription = this.emitter.on("did-change-status-snapshot", callback);
    let disposed = false;
    return new Disposable(() => {
      if (disposed) return;
      disposed = true;
      this.statusSnapshotSubscriberCount--;
      if (this.statusSnapshotSubscriberCount === 0) this.cancelScheduledSnapshotRefresh("status");
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
    if (this.refsSnapshotSubscriberCount === 1) this.scheduleRefsSnapshotRefresh();
    const subscription = this.emitter.on("did-change-refs-snapshot", callback);
    let disposed = false;
    return new Disposable(() => {
      if (disposed) return;
      disposed = true;
      this.refsSnapshotSubscriberCount--;
      if (this.refsSnapshotSubscriberCount === 0) this.cancelScheduledSnapshotRefresh("refs");
      subscription.dispose();
    });
  }

  /**
   * @public
   * @status public
   *
   * Observe accepted changes to the cached status, refs or effective HEAD.
   * Unlike the snapshot subscriptions, this declares no interest, schedules no
   * refresh and performs no Git or filesystem work. It does not replay the
   * current state. Combined refreshes publish both caches before notifying.
   *
   * @param {Function} callback - called with a frozen `{repository, kind, snapshot}` object, where `kind` is `status` or `refs` and `snapshot` is the accepted immutable cache.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeCachedState(callback) {
    return this.emitter.on("did-change-cached-state", callback);
  }

  emitCachedStateChange(kind, snapshot) {
    this.emitter.emit(
      "did-change-cached-state",
      Object.freeze({ repository: this, kind, snapshot }),
    );
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
   * Get the absolute path of the repository Git directory.
   *
   * @returns {String} path of the repository.
   */
  getPath() {
    if (this.path == null) {
      if (this.isDestroyed()) throw repositoryDestroyedError();
      this.path = path.resolve(this.descriptor.getPath());
    }
    return this.path;
  }

  /**
   * @public
   * @status public
   *
   * Get the repository working directory.
   *
   * @returns {String|null} The working directory path, or `null` for a bare repository.
   */
  getWorkingDirectory() {
    return this.workingDirectoryPath;
  }

  /**
   * @public
   * @status public
   *
   * Get the Git directory shared by linked worktrees.
   *
   * @returns {String} directory shared by linked worktrees for refs and configuration.
   */
  getCommonDirectory() {
    return path.resolve(this.descriptor.getCommonDirectory?.() ?? this.getPath());
  }

  // Structured-clone-safe descriptor consumed by git-host. The renderer has
  // already resolved worktree, submodule, symlink, and bare-repository semantics,
  // so the worker targets exactly this repository without upward discovery.
  getHostDescriptor() {
    if (this.isDestroyed()) throw repositoryDestroyedError();
    const worktreeGitMarker = this.descriptor.getWorktreeGitMarker?.() ?? null;
    const gitDirectoryIdentity = this.descriptor.getGitDirectoryIdentity?.() ?? null;
    const workingDirectoryIdentity = this.descriptor.getWorkingDirectoryIdentity?.() ?? null;
    const commonDirectoryIdentity = this.descriptor.getCommonDirectoryIdentity?.() ?? null;
    const cloneIdentity = (identity) =>
      identity
        ? Object.freeze({
            device: identity.device,
            inode: identity.inode,
            ...(identity.birthtime == null ? {} : { birthtime: identity.birthtime }),
          })
        : null;
    return Object.freeze({
      gitDirectory: this.getPath(),
      workingDirectory: this.getWorkingDirectory(),
      worktreeGitMarker: worktreeGitMarker
        ? Object.freeze({
            path: worktreeGitMarker.path,
            kind: worktreeGitMarker.kind,
          })
        : null,
      gitDirectoryIdentity: cloneIdentity(gitDirectoryIdentity),
      workingDirectoryIdentity: cloneIdentity(workingDirectoryIdentity),
      commonDirectory: this.descriptor.getCommonDirectory?.() ?? this.getPath(),
      commonDirectoryIdentity: cloneIdentity(commonDirectoryIdentity),
    });
  }

  getGitDirectoryIdentity() {
    return this.gitDirectoryIdentity;
  }

  getWorkingDirectoryIdentity() {
    return this.workingDirectoryIdentity;
  }

  /**
   * @public
   * @status public
   *
   * Makes a path relative to the repository's working directory.
   * @param {String} path - An absolute or repository-relative path.
   * @returns {String} A relative path inside the working directory, or the input path when it lies outside.
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
   * @category References
   */

  /**
   * @public
   * @status public
   *
   * Check whether a branch exists in the cached refs snapshot.
   *
   * @param {String} branch - The local branch name.
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
    if (this.isDestroyed()) throw repositoryDestroyedError();
    // Both snapshots carry HEAD, but refresh independently. Use the latest
    // successfully refreshed section so a refs-only branch switch cannot be
    // hidden by an older status snapshot (or the other way around).
    const head = this.snapshotHead;
    if (head?.name) return head.name;
    if (head?.detached && head.oid) return head.oid.slice(0, 7);
    return "";
  }

  /**
   * @public
   * @status public
   *
   * Is the given path a submodule in the repository?
   *
   * @param {String} filePath - The `String` path to check.
   * @returns {Boolean}
   * @category Repository Details
   */
  isSubmodule(filePath) {
    if (!filePath || this.isDestroyed()) return false;
    return this.submodulePathKeys.has(statusPathKey(this.relativize(filePath)));
  }

  /**
   * @public
   * @status public
   *
   * Get cached ahead and behind counts for a branch reference.
   *
   * @param {String} [reference] - The branch reference name; omit it for the current HEAD branch.
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
   * @category Git Configuration
   */

  /**
   * @public
   * @status public
   *
   * Asynchronously read a git configuration value via the git-host worker.
   * Resolves to the value or `null` when unset.
   *
   * @param {String} key - The configuration key to look up.
   * @param {Object} [options] - Read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<String|null>} The configured value.
   */
  async getConfigValueAsync(key, options = {}) {
    const values = await this.getConfigValuesAsync([key], options);
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
   * @param {Object} [options] - Read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<Object>} Values keyed by the requested names.
   */
  getConfigValuesAsync(keys, { signal } = {}) {
    const requested = Array.from(keys || [], String);
    if (requested.length === 0) return Promise.resolve({});
    if (this.isDestroyed()) {
      if (this.repositoryUnavailableError) return Promise.reject(this.repositoryUnavailableError);
      return Promise.resolve(Object.fromEntries(requested.map((key) => [key, null])));
    }
    return this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getConfigValues(descriptor, requested, { signal: requestSignal }),
      { signal },
    ).then((values) =>
      Object.fromEntries(
        requested.map((key) => [key, Object.hasOwn(values || {}, key) ? values[key] : null]),
      ),
    );
  }

  /**
   * @category References
   */

  /**
   * @public
   * @status public
   *
   * Get the fetch URL of the origin remote from the refs snapshot.
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
   * Get the current branch upstream reference from the refs snapshot.
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
   * Get the object ID of a reference from the refs snapshot.
   *
   * @param {String} reference - The `String` reference to get the target of.
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
   * Check whether a cached status entry marks a path as modified.
   *
   * @param {String} path - The `String` path to check.
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
   * Check whether a cached status entry marks a path as newly added.
   *
   * @param {String} path - The `String` path to check.
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
   * @param {String} path - The `String` path to check.
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
   * @param {String} filePath - The `String` path to check.
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
   * Get the latest immutable repository status snapshot.
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
   * @param {Object} [options] - Snapshot read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @param {Boolean} [options.includeIgnored=true] - Include ignored paths in the status snapshot.
   * @returns {Promise<Object>} that resolves to the snapshot.
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
   * Get the detailed cached status entry for a repository path.
   *
   * @param {String} filePath - An absolute or repository-relative path.
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
    if (options.signal?.aborted) return Promise.reject(snapshotAbortError());
    const state = this.snapshotRefreshCoalescer;

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
      this.absorbScheduledSnapshotRefresh(request, kind);
      begin(request);
      return result;
    }

    if (!state.flight.started) {
      this.mergeSnapshotRefreshOptions(state.flight, kind, options);
      const result = this.waitForSnapshotRequest(state.flight, kind, options.signal);
      this.absorbScheduledSnapshotRefresh(state.flight, kind);
      return result;
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
      this.mergeSnapshotRefreshOptions(state.trailing, kind, options);
    }

    const result = this.waitForSnapshotRequest(state.trailing, kind, options.signal);
    this.absorbScheduledSnapshotRefresh(state.trailing, kind);
    return result;
  }

  mergeSnapshotRefreshOptions(request, kind, options) {
    request.mask.add(kind);
    if (kind === "status") {
      const includeIgnored = options.includeIgnored !== false;
      request.statusIncludeIgnored =
        request.statusIncludeIgnored == null
          ? includeIgnored
          : request.statusIncludeIgnored || includeIgnored;
      request.options.includeIgnored = request.statusIncludeIgnored;
    }
    if (options.priority === "interactive") request.options.priority = "interactive";
  }

  debounceSnapshotRefresh(kind, options) {
    if (options.signal?.aborted) return Promise.reject(snapshotAbortError());
    if (this.repositoryUnavailableError) return Promise.reject(this.repositoryUnavailableError);
    if (this.isDestroyed()) return Promise.reject(repositoryDestroyedError());
    return new Promise((resolve, reject) => {
      let waiters = this.debouncedSnapshotWaiters.get(kind);
      if (!waiters) {
        waiters = new Set();
        this.debouncedSnapshotWaiters.set(kind, waiters);
      }
      const { debounce: _debounce, signal, ...requestOptions } = options;
      const waiter = { resolve, reject, signal, options: requestOptions, onAbort: null };
      waiter.onAbort = () => {
        if (!waiters.delete(waiter)) return;
        signal.removeEventListener("abort", waiter.onAbort);
        if (waiters.size === 0) this.debouncedSnapshotWaiters.delete(kind);
        this.cancelUnneededSnapshotRefreshTimer();
        reject(snapshotAbortError());
      };
      waiters.add(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.ensureSnapshotRefreshTimer(
        kind === "status" ? this.statusSnapshotDebounceMs : this.refsSnapshotDebounceMs,
      );
    });
  }

  takeDebouncedSnapshotWaiters(kind) {
    const waiters = this.debouncedSnapshotWaiters.get(kind);
    if (!waiters) return new Set();
    this.debouncedSnapshotWaiters.delete(kind);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    return waiters;
  }

  dispatchDebouncedSnapshotRefresh(kind) {
    const waiters = this.debouncedSnapshotWaiters.get(kind);
    const waiter = waiters?.values().next().value;
    if (!waiter) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.debouncedSnapshotWaiters.delete(kind);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    // The first caller starts or joins the coordinator; it absorbs the other
    // deferred callers synchronously, before worker dispatch can begin.
    this.coalesceSnapshotRefresh(kind, { ...waiter.options, signal: waiter.signal }).then(
      waiter.resolve,
      waiter.reject,
    );
  }

  // An explicit refresh already starts after the pending background trigger,
  // so it can fulfill that trigger without another run when the timer fires.
  // Keep background interest as its own waiter: aborting the explicit caller
  // must not cancel the update that existing snapshot subscribers requested.
  absorbScheduledSnapshotRefresh(request, kind) {
    const backgroundRequested = this.scheduledSnapshotKinds.has(kind);
    const waiters = this.takeDebouncedSnapshotWaiters(kind);
    if (!backgroundRequested && waiters.size === 0) return;
    this.cancelScheduledSnapshotRefresh(kind);
    if (backgroundRequested && kind === "status") {
      this.mergeSnapshotRefreshOptions(request, kind, { includeIgnored: true });
    }
    for (const waiter of waiters) {
      this.mergeSnapshotRefreshOptions(request, kind, waiter.options);
      this.waitForSnapshotRequest(request, kind, waiter.signal).then(waiter.resolve, waiter.reject);
    }
    if (backgroundRequested) {
      this.waitForSnapshotRequest(request, kind).catch((error) => {
        if (request.backgroundErrorReported) return;
        request.backgroundErrorReported = true;
        this.reportBackgroundSnapshotError(error);
      });
    }
  }

  cancelScheduledSnapshotRefresh(kind) {
    this.scheduledSnapshotKinds.delete(kind);
    this.cancelUnneededSnapshotRefreshTimer();
  }

  cancelUnneededSnapshotRefreshTimer() {
    if (
      this.scheduledSnapshotKinds.size === 0 &&
      this.debouncedSnapshotWaiters.size === 0 &&
      this.snapshotRefreshTimer != null
    ) {
      clearTimeout(this.snapshotRefreshTimer);
      this.snapshotRefreshTimer = null;
    }
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
    this.ensureSnapshotRefreshTimer(debounceMs);
  }

  ensureSnapshotRefreshTimer(debounceMs) {
    if (this.snapshotRefreshTimer != null) return;
    this.snapshotRefreshTimer = setTimeout(() => {
      this.snapshotRefreshTimer = null;
      if (this.isDestroyed()) return;
      const kinds = new Set([
        ...this.scheduledSnapshotKinds,
        ...this.debouncedSnapshotWaiters.keys(),
      ]);
      const refreshes = [];
      for (const kind of kinds) {
        if (this.scheduledSnapshotKinds.delete(kind)) {
          refreshes.push(this.coalesceSnapshotRefresh(kind));
        } else {
          this.dispatchDebouncedSnapshotRefresh(kind);
        }
      }
      Promise.all(refreshes).catch((error) => this.reportBackgroundSnapshotError(error));
    }, debounceMs);
  }

  async executeSnapshotRefresh(mask, options = {}) {
    if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
    if (!this.gitHostClient || this.isDestroyed()) throw repositoryDestroyedError();

    const statusRequested = mask.has("status");
    const refsRequested = mask.has("refs");
    const includeIgnored = options.includeIgnored !== false;

    const result = await this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
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
          { ...options, signal: requestSignal },
        ),
      { signal: options.signal },
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
      let headChanged = false;
      const prepared = {
        commit: () => {
          headChanged = !cachedHeadsEqual(this.snapshotHead, this.statusSnapshot.head);
          this.statusSnapshotFingerprint = section.fingerprint;
          this.snapshotHead = this.statusSnapshot.head;
        },
        emit: () => {
          if (headChanged) this.emitCachedStateChange("status", this.statusSnapshot);
        },
        value: this.statusSnapshot,
      };
      if (deferCommit) return prepared;
      prepared.commit();
      prepared.emit();
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
              aggregate = {
                conflicted: false,
                modified: false,
                added: false,
                staged: false,
                unstaged: false,
              };
              directoryStatusAggregates.set(key, aggregate);
            }
            aggregate.conflicted ||= conflicted;
            aggregate.modified ||= modified;
            aggregate.added ||= added;
            aggregate.staged ||= Boolean(entry.staged);
            aggregate.unstaged ||= Boolean(entry.unstaged);

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
        this.snapshotHead = snapshot.head;
        this.statusEntriesByPath = statusEntriesByPath;
        this.directoryStatusAggregates = directoryStatusAggregates;
        this.ignoredFileKeys = ignoredFileKeys;
        this.ignoredDirKeys = ignoredDirKeys;
        this.submodulePathKeys = submodulePathKeys;
      },
      emit: () =>
        completeCleanup(
          [
            () => this.emitter.emit("did-change-status-snapshot", snapshot),
            () => this.emitCachedStateChange("status", snapshot),
          ],
          "Unable to notify repository status observers",
        ),
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
      let headChanged = false;
      const prepared = {
        commit: () => {
          headChanged = !cachedHeadsEqual(this.snapshotHead, this.refsSnapshot.head);
          this.refsSnapshotFingerprint = section.fingerprint;
          this.snapshotHead = this.refsSnapshot.head;
        },
        emit: () => {
          if (headChanged) this.emitCachedStateChange("refs", this.refsSnapshot);
        },
        value: this.refsSnapshot,
      };
      if (deferCommit) return prepared;
      prepared.commit();
      prepared.emit();
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
        this.snapshotHead = snapshot.head;
      },
      emit: () =>
        completeCleanup(
          [
            () => this.emitter.emit("did-change-refs-snapshot", snapshot),
            () => this.emitCachedStateChange("refs", snapshot),
          ],
          "Unable to notify repository refs observers",
        ),
      value: snapshot,
    };
    if (deferCommit) return prepared;
    prepared.commit();
    prepared.emit();
    return prepared.value;
  }

  reportBackgroundSnapshotError(error) {
    if (this.isDestroyed()) return;
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return;
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
   * @param {Object} [options] - Snapshot read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @param {Boolean} [options.includeIgnored=true] - Include ignored paths in the status snapshot.
   * @param {Boolean} [options.debounce=false] - Coalesce filesystem triggers through the background debounce window while awaiting a fresh snapshot.
   * @returns {Promise<Object>} The refreshed immutable status snapshot.
   */
  refreshStatusSnapshot(options = {}) {
    if (options.debounce) return this.debounceSnapshotRefresh("status", options);
    return this.coalesceSnapshotRefresh("status", options);
  }

  /**
   * @public
   * @status public
   *
   * Classified status for one path, read from the detailed status
   * snapshot.
   *
   * @param {String} filePath - A `String` path, absolute or repository-relative.
   * @returns {Object|null} frozen `{source, conflicted, modified, added, renamed, staged, unstaged}` object (`source` is always `"snapshot"`), or `null` for clean, ignored, unknown, and pre-snapshot paths. Both `staged` and `unstaged` can be true.
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
   * @param {String} directoryPath - An absolute or repository-relative directory path.
   * @returns {Object|null} The aggregate classified status, or `null` when the directory has no reportable changes.
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
      staged: aggregate.staged,
      unstaged: aggregate.unstaged,
    });
  }

  /**
   * @category References
   */

  /**
   * @public
   * @status public
   *
   * Get the latest immutable repository refs snapshot.
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
   * @param {Object} [options] - Snapshot read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<Object>} that resolves to the snapshot.
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
   * @param {Object} [options] - Snapshot read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @param {Boolean} [options.debounce=false] - Coalesce filesystem triggers through the background debounce window while awaiting a fresh snapshot.
   * @returns {Promise<Object>} The refreshed immutable refs snapshot.
   */
  refreshRefsSnapshot(options = {}) {
    if (options.debounce) return this.debounceSnapshotRefresh("refs", options);
    return this.coalesceSnapshotRefresh("refs", options);
  }

  /**
   * @category Retrieving Diffs
   */

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
   * @param {Array<String>} [options.paths] - Literal file or directory paths limiting the diff.
   * @param {Number} [options.context=3] - Context lines.
   * @param {Boolean} [options.ignoreWhitespace=false] - Ignore all whitespace.
   * @param {Boolean} [options.detectRenames=true] - Detect renames.
   * @param {String} [options.diffFilter] - A Git diff-filter value.
   * @param {"structured"|"patch"|"both"} [options.format="structured"] -
   *   Select structured files, raw patch text, or both.
   * @param {Number} [options.maxBytes=10485760] - Output limit. Exceeding it
   *   rejects with `ERR_GIT_DIFF_TOO_LARGE`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<Object>} resolving to a frozen `{schemaVersion, files, rawPatch?}` object; `rawPatch` is present only for `patch` and `both`.
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
    if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
    if (!this.gitHostClient || this.isDestroyed()) throw repositoryDestroyedError();

    if (from?.type === "commit") assertGitRevision(from.revision);
    if (to?.type === "commit") assertGitRevision(to.revision);

    if (!new Set(["structured", "patch", "both"]).has(format)) {
      throw new TypeError(`Unsupported diff format: ${format}`);
    }

    const result = await this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getDiff(
          descriptor,
          { from, to, paths, context, ignoreWhitespace, detectRenames, diffFilter, format },
          { maxBytes, signal: requestSignal },
        ),
      { signal },
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
   * @category Reading History
   */

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
   * @returns {Promise<Object>} resolving to a frozen `{commits, hasMore, nextCursor}` object. Each commit has `sha`, `parents`, `author`, `committer`, `subject`, and `body`. An unborn repository resolves to an empty page.
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
    const records = await this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getHistory(descriptor, params, { signal: requestSignal }),
      { signal },
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
   * @param {String} sha - The `String` commit id or any revision expression.
   * @param {Object} [options] - Read options.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<Object|null>} resolving to the commit object extended with `changedFiles`: `[{path, originalPath, status, similarity}]`.
   */
  async getCommit(sha, { signal } = {}) {
    assertGitRevision(sha, { label: "commit" });
    const result = await this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getCommit(descriptor, sha, { signal: requestSignal }),
      { signal },
    );
    if (!result) return null;
    const { files, changedFiles, ...commit } = result;
    return Object.freeze({
      ...commit,
      changedFiles: Object.freeze(changedFiles || files || []),
    });
  }

  /**
   * @category Reading File Contents
   */

  /**
   * @public
   * @status public
   *
   * Read a file's contents at a revision.
   *
   * @param {String} filePath - A `String` path, absolute or repository-relative.
   * @param {String} revision - A `String` revision expression.
   * @param {Object} [options] - Read options.
   * @param {String} [options.encoding="utf8"] - Text encoding, or `"buffer"`
   *   for a `Buffer`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<String|Buffer|null>} resolving to the contents, or `null` when the path does not exist at that revision.
   */
  getFileAtRevision(filePath, revision, { encoding = "utf8", signal } = {}) {
    assertGitRevision(revision);
    return this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getFileAtRevision(descriptor, this.posixRelativePath(filePath), revision, {
          encoding: encoding === "buffer" ? "buffer" : encoding,
          signal: requestSignal,
        }),
      { signal },
    );
  }

  /**
   * @public
   * @status public
   *
   * Read a file's staged contents directly from the repository index.
   *
   * @param {String} filePath - A `String` path, absolute or repository-relative.
   * @param {Object} [options] - Read options.
   * @param {String} [options.encoding="utf8"] - Text encoding, or `"buffer"`
   *   for a `Buffer`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<String|Buffer|null>} resolving to the staged contents, or `null` when the
   *   path has no stage-0 index entry.
   */
  getIndexFile(filePath, { encoding = "utf8", signal } = {}) {
    return this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getIndexFile(descriptor, this.posixRelativePath(filePath), {
          encoding: encoding === "buffer" ? "buffer" : encoding,
          signal: requestSignal,
        }),
      { signal },
    );
  }

  /**
   * @public
   * @status public
   *
   * Read a blob's contents by object id (`git cat-file -p <oid>`).
   *
   * @param {String} oid - A `String` blob object id.
   * @param {Object} [options] - Read options.
   * @param {String} [options.encoding="utf8"] - Text encoding, or `"buffer"`
   *   for a `Buffer`.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<String|Buffer|null>} resolving to the contents, or `null` when the oid does not name an object.
   */
  getBlob(oid, { encoding = "utf8", signal } = {}) {
    return this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getBlob(descriptor, oid, {
          encoding: encoding === "buffer" ? "buffer" : encoding,
          signal: requestSignal,
        }),
      { signal },
    );
  }

  /**
   * @public
   * @status public
   *
   * Describe HEAD as a ref name (`git describe --contains --all
   * --always`). Returns a `Promise` resolving to the `String` description, or
   * `""` when the branch is unborn.
   * @returns {Promise<String>} The ref description of HEAD, or an empty string for an unborn branch.
   * @category References
   */
  getDescription() {
    return this.repositoryHostRequest((client, descriptor, requestSignal) =>
      client.getDescription(descriptor, { signal: requestSignal }),
    );
  }

  /**
   * @public
   * @status public
   *
   * The fully-qualified refnames of branches that contain a commit
   * (`git branch --contains`).
   *
   * @param {String} commit - A `String` commit id or revision.
   * @param {Object} [options] - Branch filtering options.
   * @param {Boolean} [options.showLocal=false] - Include local branches.
   * @param {Boolean} [options.showRemote=false] - Include remote branches.
   * @param {String} [options.pattern] - Limit branch names by pattern.
   * @returns {Promise<Array<String>>} resolving to an `Array` of refname `Strings`.
   * @category References
   */
  getBranchesContaining(commit, { showLocal = false, showRemote = false, pattern = null } = {}) {
    assertGitRevision(commit, { label: "commit" });
    return this.repositoryHostRequest((client, descriptor, requestSignal) =>
      client.getBranchesContaining(
        descriptor,
        commit,
        { showLocal, showRemote, pattern },
        { signal: requestSignal },
      ),
    );
  }

  /**
   * @public
   * @status public
   *
   * The index mode of a path (`git ls-files --stage`).
   *
   * @param {String} filePath - A `String` path, absolute or repository-relative.
   * @returns {Promise<String|null>} resolving to the `String` mode (e.g. `"100644"`), or `null` when the path is not tracked.
   * @category Repository Details
   */
  getFileMode(filePath) {
    return this.repositoryHostRequest((client, descriptor, requestSignal) =>
      client.getFileMode(descriptor, this.posixRelativePath(filePath), {
        signal: requestSignal,
      }),
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
   * @returns {Promise<Array<String>>} resolving to an `Array` of path `Strings`.
   * @category Repository Details
   */
  async getSubmodulePaths(options = {}) {
    if (this.isDestroyed()) {
      if (this.repositoryUnavailableError) throw this.repositoryUnavailableError;
      return [];
    }
    const paths = Object.freeze(
      await this.repositoryHostRequest(
        (client, descriptor, requestSignal) =>
          client.getSubmodulePaths(descriptor, { ...options, signal: requestSignal }),
        { signal: options.signal },
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
   * @param {String} filePath - A `String` path, absolute or repository-relative.
   * @param {Object} [options] - Blame options.
   * @param {String} [options.revision] - Revision to blame.
   * @param {Boolean} [options.ignoreWhitespace] - Ignore whitespace-only changes when attributing a line, so a reindent does not reassign every line it touched.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<Object>} resolving to a frozen `{revision, lines}` object where each line has `line`, `originalLine`, `sha`, `author`, `summary`.
   * @category Reading History
   */
  async getBlame(filePath, { revision = null, ignoreWhitespace = false, signal } = {}) {
    assertGitRevision(revision, { allowNull: true });
    const lines = await this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getBlame(
          descriptor,
          this.posixRelativePath(filePath),
          { revision, ignoreWhitespace },
          { signal: requestSignal },
        ),
      { signal },
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
   * fetching and caching the selected baseline blob before comparing it with
   * the buffer. A path absent from that baseline is compared as empty text
   * unless `skipMissingBaseline` is enabled.
   *
   * @param {String} filePath - The `String` path relative to the repository.
   * @param {String} text - The `String` buffer contents to compare.
   * @param {Object} [options] - Diff options.
   * @param {"head"|"index"} [options.base="head"] - The comparison baseline.
   * @param {Boolean} [options.skipMissingBaseline=false] - Return no hunks when the baseline path is absent, while retaining additions to an existing empty file.
   * @param {AbortSignal} [options.signal] - Cancellation signal.
   * @returns {Promise<Array<Object>>} resolving to an `Array` of hunk `Objects`, each with `oldStart`, `newStart`, `oldLines`, and `newLines`.
   */
  getLineDiffsAsync(filePath, text, { base = "head", skipMissingBaseline = false, signal } = {}) {
    if (base !== "head" && base !== "index") {
      throw new TypeError(`Unsupported line diff baseline: ${base}`);
    }
    if (this.isDestroyed()) {
      return this.repositoryUnavailableError
        ? Promise.reject(this.repositoryUnavailableError)
        : Promise.resolve([]);
    }
    const relativePosixPath = this.relativize(filePath).split(path.sep).join("/");
    const entry = this.getStatusEntry(filePath);
    const headOid = this.statusSnapshot?.head?.oid ?? null;
    // Status carries immutable blob identities, including the source blob for
    // renames. Keeping the index identity also makes a same-status stage edit
    // change the snapshot fingerprint. A clean path's index equals HEAD, so
    // buffer edits need no repeated reads of the mutable index.
    const baselineOid = entry ? (base === "index" ? entry.indexBlobOid : entry.headBlobOid) : null;
    const baselineKnownMissing =
      baselineOid == null && (entry != null || this.statusSnapshot?.head?.unborn === true);
    const baselinePath =
      base === "head" ? (entry?.originalPath ?? relativePosixPath) : relativePosixPath;
    const effectiveBase =
      base === "index" && !entry && this.statusSnapshot.initialized ? "head" : base;
    return this.repositoryHostRequest(
      (client, descriptor, requestSignal) =>
        client.getLineDiffs(descriptor, {
          relativePosixPath,
          headOid,
          base: effectiveBase,
          baselineOid,
          baselinePath,
          baselineKnownMissing,
          skipMissingBaseline,
          text,
          ignoreEolWhitespace: process.platform === "win32",
          signal: requestSignal,
        }),
      { signal },
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
   * @param {String} filePath - The `String` path to checkout.
   * @returns {Promise<Boolean>} resolving to a `Boolean` that's true on success.
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
   * @param {String} reference - The `String` reference to checkout.
   * @param {Boolean} [create=false] - A `Boolean` value which, if true creates the new reference if it doesn't exist.
   * @returns {Promise<Boolean>} resolving to a `Boolean` that's true on success.
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

    if (!(await this.checkoutHead(bufferPath))) return false;
    // Checkout may have waited behind another write. Only reload the buffer
    // that still represents the restored file when the operation completes.
    if (buffer.isDestroyed() || buffer.getPath() !== bufferPath) return false;
    return buffer.reload();
  }
};
