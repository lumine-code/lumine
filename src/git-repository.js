const path = require("path");
const fs = require("@lumine-code/fs-plus");
const { Emitter, Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const { discoverRepositoryDescriptor } = require("./git-repository-descriptor");
const {
  GitHostSnapshotProvider,
  GitHostStatusProvider,
  GitHostRefsProvider,
  GitHostConfigProvider,
  GitHostDiffProvider,
  GitHostHistoryProvider,
} = require("./git-host-providers");
const { parseDiffPatch } = require("./repository-diff");
const {
  parseCommitRecords,
  parseNameStatusTokens,
  parseBlamePorcelain,
} = require("./repository-history");
const { EMPTY_STATUS_SNAPSHOT, parseStatusSnapshot } = require("./repository-status-snapshot");
const { EMPTY_REFS_SNAPSHOT, parseRefsSnapshot } = require("./repository-refs-snapshot");
const { relativize: relativizePath } = require("./repository-paths");
const { assertGitRevision } = require("./git-revision");

let nextId = 0;

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

// Classify a snapshot entry using the public repository precedence: modified
// beats added, matching the existing isStatusModified-first checks.
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
 * This class handles submodules automatically by taking a `path` argument to many
 * of the methods.  This `path` argument will determine which underlying
 * repository is used.
 *
 * For a repository with submodules this would have the following outcome:
 *
 * ```js
 * const repo = lumine.repositories.getRepositories()[0]
 * repo.getShortHead() // 'master'
 * repo.getShortHead('vendor/path/to/a/submodule') // 'dead1234'
 * ```
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
  static exists(path) {
    const git = this.open(path);
    if (git) {
      git.destroy();
      return true;
    } else {
      return false;
    }
  }

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
   * @param options.project - A {@link Project} whose buffer saves keep this repository's status snapshot fresh.
   * @param options.config - The config consulted for Git settings.
   * @returns {GitRepository} instance or `null` if the repository could not be opened.
   */
  static open(path, options) {
    if (!path) {
      return null;
    }
    try {
      return new GitRepository(path, options);
    } catch {
      return null;
    }
  }

  constructor(path, options = {}) {
    this.id = nextId++;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.descriptor = options.descriptor || discoverRepositoryDescriptor(path);
    if (this.descriptor == null) {
      throw new Error(`No Git repository found searching path: ${path}`);
    }

    // Cache the working directory and filesystem traits once so path routing
    // (getWorkingDirectory/relativize) needs no filesystem walk per query. These
    // are fixed for the repository's lifetime.
    this.workingDirectoryPath = this.descriptor.getWorkingDirectory();
    this.openedWorkingDirectoryPath = this.descriptor.openedWorkingDirectory || null;
    this.caseInsensitiveFs = this.descriptor.caseInsensitiveFs === true;

    this.snapshotProvider = options.snapshotProvider || new GitHostSnapshotProvider();
    this.usesCombinedStatusSnapshots = options.statusSnapshotProvider == null;
    this.usesCombinedRefsSnapshots = options.refsSnapshotProvider == null;
    this.statusSnapshotProvider = options.statusSnapshotProvider || new GitHostStatusProvider();
    this.statusSnapshot = EMPTY_STATUS_SNAPSHOT;
    this.statusSnapshotCacheKey = null;
    this.statusSnapshotFingerprint = null;
    this.statusSnapshotRefreshCount = 0;
    this.statusEntriesByPath = new Map();
    this.directoryStatusAggregates = new Map();
    this.ignoredFileKeys = new Set();
    this.ignoredDirKeys = [];
    this.statusSnapshotSubscriberCount = 0;
    this.statusSnapshotDebounceMs = options.statusSnapshotDebounceMs ?? 150;
    this.statusSnapshotRefreshTimer = null;
    this.statusRefreshCoalescer = { flight: null, trailing: null };
    this.refsSnapshotProvider = options.refsSnapshotProvider || new GitHostRefsProvider();
    this.refsSnapshot = EMPTY_REFS_SNAPSHOT;
    this.refsSnapshotCacheKey = null;
    this.refsSnapshotFingerprint = null;
    this.refsSnapshotRefreshCount = 0;
    this.refsSnapshotSubscriberCount = 0;
    this.refsSnapshotDebounceMs = options.refsSnapshotDebounceMs ?? 150;
    this.refsSnapshotRefreshTimer = null;
    this.refsRefreshCoalescer = { flight: null, trailing: null };
    this.combinedSnapshotRefreshCoalescer = { flight: null, trailing: null };
    this.combinedSnapshotRefreshTimer = null;
    this.combinedSnapshotScheduledKinds = new Set();
    this.backgroundSnapshotWarningShown = false;
    this.diffProvider = options.diffProvider || new GitHostDiffProvider();
    this.historyProvider = options.historyProvider || new GitHostHistoryProvider();
    this.configProvider = options.configProvider || new GitHostConfigProvider();
    this.upstream = { ahead: 0, behind: 0 };

    this.project = options.project;
    this.config = options.config;
    this.operations = null;

    // Window-focus freshness is the registry's job (RepositoryRegistry
    // handleWindowFocus): it knows which repositories the project watcher
    // already keeps fresh and which one is on screen. A listener here would
    // put every registered repository on every focus event — one hundred
    // `git status` runs per alt-tab in a many-repository workspace.

    if (this.project != null) {
      this.project.getBuffers().forEach((buffer) => this.subscribeToBuffer(buffer));
      this.subscriptions.add(
        this.project.onDidAddBuffer((buffer) => this.subscribeToBuffer(buffer)),
      );
    }
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
    this.statusSnapshotRefreshCount++;
    this.refsSnapshotRefreshCount++;
    this.descriptor = null;
    this.operations = null;
    this.statusSnapshotProvider = null;
    this.snapshotProvider = null;
    this.refsSnapshotProvider = null;
    this.diffProvider = null;
    this.historyProvider = null;
    this.configProvider = null;
    this.statusEntriesByPath.clear();
    this.directoryStatusAggregates.clear();
    if (this.statusSnapshotRefreshTimer != null) {
      clearTimeout(this.statusSnapshotRefreshTimer);
      this.statusSnapshotRefreshTimer = null;
    }
    if (this.refsSnapshotRefreshTimer != null) {
      clearTimeout(this.refsSnapshotRefreshTimer);
      this.refsSnapshotRefreshTimer = null;
    }
    if (this.combinedSnapshotRefreshTimer != null) {
      clearTimeout(this.combinedSnapshotRefreshTimer);
      this.combinedSnapshotRefreshTimer = null;
    }
    this.combinedSnapshotScheduledKinds.clear();

    if (this.emitter) {
      this.emitter.emit("did-destroy");
      this.emitter.dispose();
      this.emitter = null;
    }

    if (this.subscriptions) {
      this.subscriptions.dispose();
      this.subscriptions = null;
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
   * @returns {Boolean} whether this repository's Git directory still exists.
   */
  isPresent() {
    return !this.isDestroyed() && fs.existsSync(this.path || this.getPath());
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

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when a specific file's status has
   * changed. When a file is updated, reloaded, etc, and the status changes, this
   * will be fired.
   *
   *
   * Note: prefer {@link #onDidChangeStatusSnapshot}, which fires for every status
   * change; this legacy per-path event is retained for API compatibility.
   *
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {String} callback.event.path - the path whose status changed
   * @param {Number} callback.event.pathStatus - representing the status.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeStatus(callback) {
    return this.emitter.on("did-change-status", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when multiple files' statuses have
   * changed. Prefer {@link #onDidChangeStatusSnapshot}; this legacy event is retained
   * for API compatibility.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeStatuses(callback) {
    return this.emitter.on("did-change-statuses", callback);
  }

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
      this.path = fs.absolute(this.descriptor.getPath());
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
    return Object.freeze({
      gitDirectory: this.getPath(),
      workingDirectory: this.getWorkingDirectory(),
    });
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} true if at the root, false if in a subfolder of the repository.
   */
  isProjectAtRoot() {
    if (this.projectAtRoot == null) {
      this.projectAtRoot =
        this.project && this.project.relativize(this.getWorkingDirectory()) === "";
    }
    return this.projectAtRoot;
  }

  /**
   * @public
   * @status public
   *
   * Makes a path relative to the repository's working directory.
   */
  relativize(path) {
    return relativizePath(
      path,
      this.workingDirectoryPath,
      this.openedWorkingDirectoryPath,
      this.caseInsensitiveFs,
    );
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
    return this.descriptor.isSubmodule(this.relativize(filePath));
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
    return this.upstream;
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
    if (!this.configProvider || this.isDestroyed()) {
      return Promise.resolve(Object.fromEntries(requested.map((key) => [key, null])));
    }
    return this.configProvider
      .getConfigValues(this.getHostDescriptor(), requested)
      .then((values) =>
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
   * @returns {Object} latest immutable detailed status snapshot. It contains `head`, `upstream`, per-file staged/unstaged/conflict state, aggregate `counts`, and a monotonic `generation`. The initial snapshot has `initialized: false`; subscribe with {@link #onDidChangeStatusSnapshot} or call {@link #ensureStatusSnapshot} to load it.
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
    if (
      this.usesCombinedStatusSnapshots &&
      this.combinedSnapshotRefreshCoalescer.flight?.mask.has("status")
    ) {
      return this.combinedSnapshotRefreshCoalescer.flight.promise.then(() => this.statusSnapshot);
    }
    if (this.statusRefreshCoalescer.flight) return this.statusRefreshCoalescer.flight;
    return this.refreshStatusSnapshot(options);
  }

  // Schedule a background snapshot refresh. Calls within the debounce window
  // coalesce into a single Git subprocess; the window is not extended by
  // repeated calls, so a continuous event stream cannot starve the refresh.
  scheduleStatusSnapshotRefresh() {
    if (this.isDestroyed() || this.statusSnapshotSubscriberCount === 0) return;
    if (this.usesCombinedStatusSnapshots) {
      this.scheduleCombinedSnapshotRefresh("status", this.statusSnapshotDebounceMs);
      return;
    }
    if (this.statusSnapshotRefreshTimer != null) return;
    this.statusSnapshotRefreshTimer = setTimeout(() => {
      this.statusSnapshotRefreshTimer = null;
      if (this.isDestroyed()) return;
      // Background refreshes must never surface as unhandled rejections; the
      // stale-suppression counter and cache key keep failed runs harmless.
      this.refreshStatusSnapshot().catch((error) => this.reportBackgroundSnapshotError(error));
    }, this.statusSnapshotDebounceMs);
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

  // Shared single-flight-plus-trailing scheduler for both snapshot refreshes.
  // A request arriving while a run is in flight never joins that run — its git
  // process may have started before the state the caller wants captured — but
  // joins (or creates) one trailing run that starts after the flight settles.
  // This guarantees the run backing a returned promise starts at or after the
  // request, which is the freshness the post-operation contract needs, while
  // bounding each snapshot to one running and one queued subprocess per repo.
  coalesceSnapshotRefresh(state, options, execute) {
    const begin = (runOptions) => {
      const promise = execute(runOptions).finally(() => {
        state.flight = null;
        const trailing = state.trailing;
        if (trailing) {
          state.trailing = null;
          // Promote synchronously so no request can slip in between the
          // flight settling and the trailing run becoming the new flight.
          trailing.begin();
        }
      });
      state.flight = promise;
      return promise;
    };

    if (!state.flight) return begin(options);

    if (!state.trailing) {
      // The trailing run is shared by every requester that piggybacks on it,
      // so no single requester's AbortSignal may cancel it.
      const trailingOptions = { ...options };
      delete trailingOptions.signal;
      const trailing = { options: trailingOptions };
      trailing.promise = new Promise((resolve, reject) => {
        trailing.begin = () => begin(trailing.options).then(resolve, reject);
      });
      state.trailing = trailing;
      return trailing.promise;
    }

    const merged = state.trailing.options;
    // Ignored entries are included unless every requester opted out, and one
    // interactive requester makes the shared run interactive.
    if (options.includeIgnored !== false) delete merged.includeIgnored;
    if (options.priority === "interactive") merged.priority = "interactive";
    return state.trailing.promise;
  }

  // Merge status and refs refreshes through one single-flight-plus-trailing
  // coordinator. Synchronous callers share a microtask-sized dispatch window,
  // which lets status and refs requests issued together become one snapshot.
  // Once work has started, later callers join one trailing request whose mask
  // is the union of everything that arrived.
  coalesceCombinedSnapshotRefresh(kind, options = {}) {
    const state = this.combinedSnapshotRefreshCoalescer;

    const merge = (request, requestedKind, requestedOptions) => {
      request.mask.add(requestedKind);
      // Once a flight is shared, no one requester's signal may cancel it.
      delete request.options.signal;
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
      const flight = { ...request, started: false, promise: null };
      flight.promise = Promise.resolve()
        .then(() => {
          flight.started = true;
          return this.executeCombinedSnapshotRefresh(flight.mask, flight.options);
        })
        .finally(() => {
          state.flight = null;
          const trailing = state.trailing;
          if (trailing) {
            state.trailing = null;
            trailing.begin();
          }
        });
      state.flight = flight;
      return flight.promise;
    };

    if (!state.flight) {
      const requestOptions = { ...options };
      return begin({
        mask: new Set([kind]),
        options: requestOptions,
        statusIncludeIgnored: kind === "status" ? options.includeIgnored !== false : null,
      }).then(() => (kind === "status" ? this.statusSnapshot : this.refsSnapshot));
    }

    if (!state.flight.started) {
      merge(state.flight, kind, options);
      return state.flight.promise.then(() =>
        kind === "status" ? this.statusSnapshot : this.refsSnapshot,
      );
    }

    if (!state.trailing) {
      const trailingOptions = { ...options };
      delete trailingOptions.signal;
      const trailing = {
        mask: new Set([kind]),
        options: trailingOptions,
        statusIncludeIgnored: kind === "status" ? options.includeIgnored !== false : null,
      };
      trailing.promise = new Promise((resolve, reject) => {
        trailing.begin = () => begin(trailing).then(resolve, reject);
      });
      state.trailing = trailing;
    } else {
      merge(state.trailing, kind, options);
    }

    return state.trailing.promise.then(() =>
      kind === "status" ? this.statusSnapshot : this.refsSnapshot,
    );
  }

  scheduleCombinedSnapshotRefresh(kind, debounceMs) {
    this.combinedSnapshotScheduledKinds.add(kind);
    if (this.combinedSnapshotRefreshTimer != null) return;
    this.combinedSnapshotRefreshTimer = setTimeout(() => {
      this.combinedSnapshotRefreshTimer = null;
      if (this.isDestroyed()) return;
      const kinds = this.combinedSnapshotScheduledKinds;
      this.combinedSnapshotScheduledKinds = new Set();
      const refreshes = [];
      if (kinds.has("status")) refreshes.push(this.refreshStatusSnapshot());
      if (kinds.has("refs")) refreshes.push(this.refreshRefsSnapshot());
      Promise.all(refreshes).catch((error) => this.reportBackgroundSnapshotError(error));
    }, debounceMs);
  }

  async executeCombinedSnapshotRefresh(mask, options = {}) {
    const provider = this.snapshotProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");

    const statusRequested = mask.has("status");
    const refsRequested = mask.has("refs");
    const statusRefreshCount = statusRequested ? ++this.statusSnapshotRefreshCount : null;
    const refsRefreshCount = refsRequested ? ++this.refsSnapshotRefreshCount : null;
    const includeIgnored = options.includeIgnored !== false;

    const result = await provider.getSnapshot(
      this.getHostDescriptor(),
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
    );

    if (this.isDestroyed()) {
      return { status: this.statusSnapshot, refs: this.refsSnapshot };
    }
    // Apply every valid section before reporting a missing or malformed sibling.
    let responseError = null;
    if (statusRequested && statusRefreshCount === this.statusSnapshotRefreshCount) {
      try {
        if (result?.status) this.applyStatusSnapshotSection(result.status);
        else throw this.invalidSnapshotResponse("status");
      } catch (error) {
        responseError = error;
      }
    }
    if (refsRequested && refsRefreshCount === this.refsSnapshotRefreshCount) {
      try {
        if (result?.refs) this.applyRefsSnapshotSection(result.refs);
        else throw this.invalidSnapshotResponse("refs");
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

  applyStatusSnapshotSection(section) {
    if (section.unchanged) {
      this.statusSnapshotFingerprint = section.fingerprint;
      return this.statusSnapshot;
    }
    if (!section.value || section.value.schemaVersion !== 1 || !section.value.initialized) {
      throw this.invalidSnapshotResponse("status value");
    }
    const snapshot = deepFreeze(section.value);
    this.statusSnapshotFingerprint = section.fingerprint;
    this.statusSnapshot = snapshot;
    this.statusSnapshotCacheKey = null;
    this.statusEntriesByPath = new Map(
      snapshot.files.map((entry) => [statusPathKey(entry.path), entry]),
    );
    this.directoryStatusAggregates = this.buildDirectoryStatusAggregates(snapshot);
    this.rebuildIgnoredIndex(snapshot);
    this.emitter.emit("did-change-status-snapshot", snapshot);
    return snapshot;
  }

  applyRefsSnapshotSection(section) {
    if (section.unchanged) {
      this.refsSnapshotFingerprint = section.fingerprint;
      return this.refsSnapshot;
    }
    if (!section.value || section.value.schemaVersion !== 1 || !section.value.initialized) {
      throw this.invalidSnapshotResponse("refs value");
    }
    const snapshot = deepFreeze(section.value);
    this.refsSnapshotFingerprint = section.fingerprint;
    this.refsSnapshot = snapshot;
    this.refsSnapshotCacheKey = null;
    this.emitter.emit("did-change-refs-snapshot", snapshot);
    return snapshot;
  }

  reportBackgroundSnapshotError(error) {
    if (this.isDestroyed()) return;
    console.error("Git snapshot refresh failed", error);
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
   * subprocess; see `coalesceSnapshotRefresh`.
   */
  refreshStatusSnapshot(options = {}) {
    if (this.usesCombinedStatusSnapshots) {
      return this.coalesceCombinedSnapshotRefresh("status", options);
    }
    return this.coalesceSnapshotRefresh(this.statusRefreshCoalescer, options, (runOptions) =>
      this.executeStatusSnapshotRefresh(runOptions),
    );
  }

  // The actual status snapshot refresh. This is intentionally independent from
  // the synchronous legacy cache so hot path coloring never waits for Git work.
  async executeStatusSnapshotRefresh(options = {}) {
    const provider = this.statusSnapshotProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");

    const refreshCount = ++this.statusSnapshotRefreshCount;
    // Ignored entries are included by default so tree-view/tabs can resolve
    // ignore state synchronously from the snapshot ({@link #isPathIgnoredCached}).
    // Pass `includeIgnored: false` explicitly to opt out.
    const includeIgnored = options.includeIgnored !== false;
    const output = await provider.getStatus(this.getWorkingDirectory(), {
      ...options,
      includeIgnored,
    });

    if (this.isDestroyed() || refreshCount !== this.statusSnapshotRefreshCount) {
      return this.statusSnapshot;
    }

    const cacheKey = `${includeIgnored ? "ignored" : "tracked"}\0${output}`;
    if (cacheKey === this.statusSnapshotCacheKey) return this.statusSnapshot;

    const snapshot = parseStatusSnapshot(output, {
      generation: this.statusSnapshot.generation + 1,
      includesIgnored: includeIgnored,
    });
    this.statusSnapshot = snapshot;
    this.statusSnapshotCacheKey = cacheKey;
    this.statusEntriesByPath = new Map(
      snapshot.files.map((entry) => [statusPathKey(entry.path), entry]),
    );
    this.directoryStatusAggregates = this.buildDirectoryStatusAggregates(snapshot);
    this.rebuildIgnoredIndex(snapshot);
    this.emitter.emit("did-change-status-snapshot", snapshot);
    return snapshot;
  }

  // Index the snapshot's ignored entries for O(1) `isPathIgnoredCached` lookups.
  // `git status --ignored=matching` collapses a fully-ignored directory to a
  // single `path/` entry, so those are kept as directory prefixes and everything
  // beneath them counts as ignored; individually-ignored files are exact keys.
  rebuildIgnoredIndex(snapshot) {
    const ignoredFileKeys = new Set();
    const ignoredDirKeys = [];
    for (const entry of snapshot.files) {
      if (!entry.ignored) continue;
      if (entry.path.endsWith("/")) {
        ignoredDirKeys.push(statusPathKey(entry.path.slice(0, -1)));
      } else {
        ignoredFileKeys.add(statusPathKey(entry.path));
      }
    }
    this.ignoredFileKeys = ignoredFileKeys;
    this.ignoredDirKeys = ignoredDirKeys;
  }

  // One pass over the snapshot's changed files, OR-ing each file's
  // classification into every ancestor directory ("" is the repository root),
  // so directory queries never rescan the file list.
  buildDirectoryStatusAggregates(snapshot) {
    const aggregates = new Map();
    for (const entry of snapshot.files) {
      if (entry.ignored) continue;
      const summary = summaryFromStatusEntry(entry);
      if (!summary.conflicted && !summary.modified && !summary.added) continue;

      let key = statusPathKey(entry.path);
      do {
        const separatorIndex = key.lastIndexOf("/");
        key = separatorIndex === -1 ? "" : key.slice(0, separatorIndex);
        let aggregate = aggregates.get(key);
        if (!aggregate) {
          aggregate = { conflicted: false, modified: false, added: false };
          aggregates.set(key, aggregate);
        }
        aggregate.conflicted = aggregate.conflicted || summary.conflicted;
        aggregate.modified = aggregate.modified || summary.modified;
        aggregate.added = aggregate.added || summary.added;
      } while (key !== "");
    }
    return aggregates;
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
    if (
      this.usesCombinedRefsSnapshots &&
      this.combinedSnapshotRefreshCoalescer.flight?.mask.has("refs")
    ) {
      return this.combinedSnapshotRefreshCoalescer.flight.promise.then(() => this.refsSnapshot);
    }
    if (this.refsRefreshCoalescer.flight) return this.refsRefreshCoalescer.flight;
    return this.refreshRefsSnapshot(options);
  }

  // Schedule a background refs refresh with the same coalescing rules as
  // {@link #scheduleStatusSnapshotRefresh}.
  scheduleRefsSnapshotRefresh() {
    if (this.isDestroyed() || this.refsSnapshotSubscriberCount === 0) return;
    if (this.usesCombinedRefsSnapshots) {
      this.scheduleCombinedSnapshotRefresh("refs", this.refsSnapshotDebounceMs);
      return;
    }
    if (this.refsSnapshotRefreshTimer != null) return;
    this.refsSnapshotRefreshTimer = setTimeout(() => {
      this.refsSnapshotRefreshTimer = null;
      if (this.isDestroyed()) return;
      this.refreshRefsSnapshot().catch((error) => this.reportBackgroundSnapshotError(error));
    }, this.refsSnapshotDebounceMs);
  }

  /**
   * @public
   * @status public
   *
   * Refresh the refs snapshot with Git. Concurrent calls coalesce into
   * at most one in-flight and one trailing refresh; see
   * `coalesceSnapshotRefresh`.
   */
  refreshRefsSnapshot(options = {}) {
    if (this.usesCombinedRefsSnapshots) {
      return this.coalesceCombinedSnapshotRefresh("refs", options);
    }
    return this.coalesceSnapshotRefresh(this.refsRefreshCoalescer, options, (runOptions) =>
      this.executeRefsSnapshotRefresh(runOptions),
    );
  }

  // The actual refs snapshot refresh. Reads branches, tags, remotes,
  // worktrees, and the exact HEAD state in one pass; stale out-of-order
  // responses are discarded and identical raw output does not emit a change
  // event.
  async executeRefsSnapshotRefresh(options = {}) {
    const provider = this.refsSnapshotProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");

    const refreshCount = ++this.refsSnapshotRefreshCount;
    const outputs = await provider.getRefs(this.getWorkingDirectory(), options);

    if (this.isDestroyed() || refreshCount !== this.refsSnapshotRefreshCount) {
      return this.refsSnapshot;
    }

    const cacheKey = [
      outputs.forEachRef,
      outputs.remotes,
      outputs.worktrees,
      outputs.symbolicHead,
      outputs.headOid,
    ].join("\0");
    if (cacheKey === this.refsSnapshotCacheKey) return this.refsSnapshot;

    const snapshot = parseRefsSnapshot(outputs, {
      generation: this.refsSnapshot.generation + 1,
    });
    this.refsSnapshot = snapshot;
    this.refsSnapshotCacheKey = cacheKey;
    this.emitter.emit("did-change-refs-snapshot", snapshot);
    return snapshot;
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
    const provider = this.diffProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");

    if (from?.type === "commit") assertGitRevision(from.revision);
    if (to?.type === "commit") assertGitRevision(to.revision);

    if (!new Set(["structured", "patch", "both"]).has(format)) {
      throw new TypeError(`Unsupported diff format: ${format}`);
    }

    try {
      if (typeof provider.getDiff === "function") {
        const result = await provider.getDiff(
          this.getHostDescriptor(),
          { from, to, paths, context, ignoreWhitespace, detectRenames, diffFilter, format },
          { maxBytes, signal },
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
        return deepFreeze({
          schemaVersion: 1,
          files: format === "patch" ? [] : result.files,
          ...(format === "structured" ? {} : { rawPatch: result.rawPatch }),
        });
      }

      // Direct provider injection is retained as a test seam. Production
      // providers implement getDiff() and never parse CLI patch text.
      const rawPatch = await provider.getDiffPatch(
        this.getWorkingDirectory(),
        { from, to, paths, context, ignoreWhitespace, detectRenames, diffFilter },
        { maxBuffer: maxBytes, signal },
      );
      const { files } = parseDiffPatch(rawPatch);
      return deepFreeze({
        schemaVersion: 1,
        files: format === "patch" ? [] : files,
        ...(format === "structured" ? {} : { rawPatch }),
      });
    } catch (error) {
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        const tooLarge = new Error(
          `Git diff output exceeded the ${maxBytes} byte limit; raise maxBytes or narrow paths`,
        );
        tooLarge.code = "ERR_GIT_DIFF_TOO_LARGE";
        tooLarge.cause = error;
        throw tooLarge;
      }
      throw error;
    }
  }

  // Turn an absolute or repository-relative path into the forward-slash
  // relative form Git commands expect in pathspecs and `rev:path` arguments.
  posixRelativePath(filePath) {
    const relativePath = this.relativize(String(filePath));
    if (relativePath == null) return String(filePath).split(path.sep).join("/");
    return relativePath.split(path.sep).join("/");
  }

  requireHistoryProvider() {
    const provider = this.historyProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");
    return provider;
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
    const provider = this.requireHistoryProvider();
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
    let records;
    if (params.path && typeof provider.getLogFollow === "function") {
      records = parseCommitRecords(
        await provider.getLogFollow(this.getHostDescriptor(), params, { signal }),
      );
    } else if (!params.path && typeof provider.getHistory === "function") {
      records = await provider.getHistory(
        this.getHostDescriptor(),
        {
          revision: params.revision,
          allRefs: params.allRefs,
          limit: params.limit,
          skip: params.skip,
        },
        { signal },
      );
    } else {
      // Direct legacy provider injection remains a test seam. The production
      // provider statically routes only path-limited history to Git CLI.
      records = parseCommitRecords(
        await provider.getLog(this.getWorkingDirectory(), params, { signal }),
      );
    }
    const hasMore = records.length > limit;
    const commits = deepFreeze(records.slice(0, limit));
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
    const provider = this.requireHistoryProvider();
    if (typeof provider.getCommit === "function") {
      const result = await provider.getCommit(this.getHostDescriptor(), sha, { signal });
      if (!result) return null;
      const { files, changedFiles, ...commit } = result;
      return deepFreeze({ ...commit, changedFiles: changedFiles || files || [] });
    }

    const workingDirectory = this.getWorkingDirectory();
    const logOutput = await provider.getLog(
      workingDirectory,
      { revision: sha, limit: 1 },
      { signal },
    );
    const [commit] = parseCommitRecords(logOutput);
    if (!commit) return null;
    const nameStatusOutput = await provider.getNameStatus(workingDirectory, commit.sha, {
      signal,
      parent: commit.parents[0] || null,
    });
    return Object.freeze({
      ...commit,
      changedFiles: Object.freeze(parseNameStatusTokens(nameStatusOutput)),
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
    const provider = this.requireHistoryProvider();
    return provider.getFileAtRevision(
      typeof provider.readObjects === "function"
        ? this.getHostDescriptor()
        : this.getWorkingDirectory(),
      this.posixRelativePath(filePath),
      revision,
      { encoding: encoding === "buffer" ? "buffer" : encoding, signal },
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
    const provider = this.requireHistoryProvider();
    if (typeof provider.getIndexFile !== "function") {
      const error = new Error("The history provider cannot read index objects");
      error.code = "ERR_GIT_READ_OBJECTS";
      error.operation = "readObjects";
      return Promise.reject(error);
    }
    return provider.getIndexFile(this.getHostDescriptor(), this.posixRelativePath(filePath), {
      encoding: encoding === "buffer" ? "buffer" : encoding,
      signal,
    });
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
    const provider = this.requireHistoryProvider();
    return provider.getBlob(
      typeof provider.readObjects === "function"
        ? this.getHostDescriptor()
        : this.getWorkingDirectory(),
      oid,
      {
        encoding: encoding === "buffer" ? "buffer" : encoding,
        signal,
      },
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
    const provider = this.refsSnapshotProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");
    return provider.getDescription(this.getHostDescriptor());
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
    const provider = this.refsSnapshotProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");
    return provider.getBranchesContaining(this.getHostDescriptor(), commit, {
      showLocal,
      showRemote,
      pattern,
    });
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
    const provider = this.statusSnapshotProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");
    return provider.getFileMode(this.getHostDescriptor(), this.posixRelativePath(filePath));
  }

  /**
   * @public
   * @status public
   *
   * The repository-relative paths of the repository's submodules
   * (`git submodule status`).
   *
   * @returns {Promise} resolving to an `Array` of path `Strings`.
   */
  getSubmodulePaths() {
    const provider = this.statusSnapshotProvider;
    if (!provider || this.isDestroyed()) throw new Error("Repository has been destroyed");
    return provider.getSubmodulePaths(this.getHostDescriptor());
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
    const provider = this.requireHistoryProvider();
    const output = await provider.getBlame(
      typeof provider.readObjects === "function"
        ? this.getHostDescriptor()
        : this.getWorkingDirectory(),
      this.posixRelativePath(filePath),
      { revision, ignoreWhitespace },
      { signal },
    );
    return deepFreeze({
      revision,
      lines: Array.isArray(output) ? output : parseBlamePorcelain(output),
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
   * @returns {Promise} resolving to an `Array` of hunk `Objects`, each with `oldStart`, `newStart`, `oldLines`, and `newLines`.
   */
  getLineDiffsAsync(filePath, text) {
    if (this.isDestroyed()) return Promise.resolve([]);
    const relativePosixPath = this.relativize(filePath).split(path.sep).join("/");
    // The status snapshot's head oid keys the worker's blob cache; a HEAD move
    // produces a fresh key. Files inside submodules are owned by their own
    // repository, so this repository always keys against its own HEAD.
    const headOid = this.statusSnapshot?.head?.oid ?? null;
    return this.diffProvider.getLineDiffs(this.getHostDescriptor(), {
      relativePosixPath,
      headOid,
      text,
      ignoreEolWhitespace: process.platform === "win32",
    });
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

  // Subscribes to buffer events.
  subscribeToBuffer(buffer) {
    // Every repository hears about every buffer in the window, but only a save
    // inside this repository's own working tree can change its status.
    // relativize hands a path outside the working tree back unchanged — still
    // absolute — so "no longer absolute" is the containment test.
    const refreshStatusForBuffer = () => {
      if (this.isDestroyed()) return;
      const bufferPath = buffer.getPath();
      if (!bufferPath) return;
      const relativePath = this.relativize(bufferPath);
      if (relativePath == null || path.isAbsolute(relativePath)) return;
      this.scheduleStatusSnapshotRefresh();
    };

    const bufferSubscriptions = new CompositeDisposable();
    bufferSubscriptions.add(buffer.onDidSave(refreshStatusForBuffer));
    bufferSubscriptions.add(buffer.onDidReload(refreshStatusForBuffer));
    bufferSubscriptions.add(buffer.onDidChangePath(refreshStatusForBuffer));
    bufferSubscriptions.add(
      buffer.onDidDestroy(() => {
        bufferSubscriptions.dispose();
        return this.subscriptions.remove(bufferSubscriptions);
      }),
    );
    this.subscriptions.add(bufferSubscriptions);
  }

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
