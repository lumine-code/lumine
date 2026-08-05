const fs = require("fs");
const path = require("path");

const { CompositeDisposable, Disposable, Emitter } = require("event-kit");
const RepositoryOperations = require("./repository-operations");

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

// Valid answers from an operation implementation's getOperationRefreshHint():
// which read snapshots the just-finished operation can have invalidated.
const OPERATION_REFRESH_HINTS = new Set(["none", "status", "refs", "both"]);

function normalizePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalPath(filePath) {
  let resolved = path.resolve(filePath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Deleted and not-yet-created paths still need lexical routing.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathAliases(filePath) {
  return Array.from(new Set([normalizePath(filePath), canonicalPath(filePath)]));
}

function pathContains(parentPath, childPath) {
  return pathAliases(parentPath).some((parent) =>
    pathAliases(childPath).some((child) => pathContainsNormalized(parent, child)),
  );
}

function pathContainsNormalized(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function pathDepth(relativePath) {
  if (!relativePath || relativePath === ".") return 0;
  return relativePath.split(/[\\/]+/).filter(Boolean).length;
}

// Public: Every Git repository this window knows about, available as
// `atom.repositories`.
//
// Project roots are where repositories are discovered and what keeps them
// alive, but a repository's identity is independent of them: one root can hold
// several repositories, one repository can span several roots, and a file
// opened from outside every root still resolves to the repository that
// contains it.
//
// ## Finding a repository
//
// {::getForPath} answers from what is already known and never touches the
// filesystem, which is what a renderer wants. {::resolveForPath} may discover
// and register a repository that was not known yet, at the cost of being
// asynchronous:
//
// ```js
// const repository = atom.repositories.getForPath(editor.getPath())
// if (repository) console.log(repository.getShortHead())
// ```
//
// ## Following the one the user is in
//
// {::observeActiveRepository} tracks the repository behind the active pane
// item, so a status bar or a panel does not have to work it out itself:
//
// ```js
// atom.repositories.observeActiveRepository(({ repository, workingDirectory }) => {
//   // repository is null when the active item belongs to none
// })
// ```
//
// ## Operations
//
// The registry performs no Git work of its own. A package provides an
// implementation through {::addOperationProvider}, and everything under
// "Operations" and "Running Git" below is routed to whichever provider claims
// the capability. Ask {::canPerformOperation} before offering an action, since
// a window with no provider installed can answer nothing.
module.exports = class RepositoryRegistry {
  constructor({ project, config, notificationManager, packageManager }) {
    this.project = null;
    this.config = config;
    this.notificationManager = notificationManager;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.projectSubscriptions = new CompositeDisposable();
    this.workspaceSubscriptions = new CompositeDisposable();
    this.workspace = null;
    this.activeRepository = null;
    this.activeWorkingDirectory = null;
    this.activeRepositoryPinned = false;
    this.activeRepositoryPin = null;

    this.entriesById = new Map();
    this.entryByRepository = new WeakMap();
    this.operationProviders = [];
    this.workspaceOperationTails = new Map();
    this.pendingWorkspaceOperations = new Map();
    this.bufferOwners = new Map();
    this.rootPaths = [];
    this.scanGeneration = 0;
    this.version = 0;
    this.nextOperationId = 1;
    this.nextRescanId = 1;
    this.destroyed = false;
    this.didNotifyRepositoryLimit = false;

    if (this.config?.onDidChange) {
      this.subscriptions.add(
        this.config.onDidChange("git.scanDepth", () => this.rescan()),
        this.config.onDidChange("git.excludedDirectories", () => this.rescan()),
      );
    }

    this.consumeServices(packageManager);

    if (project) this.attachProject(project);
  }

  // Resetting the window runs `PackageManager#reset`, which clears every
  // consumer off the service hub. A subscription made only in the constructor
  // would survive that in name alone and no provider would reach the registry
  // again, so this is re-run from `AtomEnvironment#reset` the same way Project
  // and Workspace re-run theirs.
  consumeServices(packageManager) {
    this.serviceSubscription?.dispose();
    this.serviceSubscription = packageManager?.serviceHub?.consume(
      "repositories.operations-provider",
      "^1.0.0",
      (provider) => this.addOperationProvider(provider),
    );
  }

  attachProject(project) {
    if (this.destroyed) throw new Error("Cannot attach a destroyed RepositoryRegistry");
    if (this.project && this.project !== project) {
      throw new Error("RepositoryRegistry is already attached to another Project");
    }
    this.project = project;
    this.resetProjectSubscriptions();
    for (const buffer of this.project.getBuffers()) this.trackBuffer(buffer);
  }

  detachProject(project) {
    if (this.project !== project) return;

    this.scanGeneration++;
    this.projectSubscriptions.dispose();
    this.projectSubscriptions = new CompositeDisposable();

    for (const [buffer, owner] of this.bufferOwners) {
      owner.subscriptions.dispose();
      if (owner.entry) owner.entry.bufferOwners.delete(buffer);
    }
    this.bufferOwners.clear();
    this.rootPaths = [];

    // Release the active repository before pruning so its keep-alive pin
    // cannot hold a repository across a project detach.
    this.applyActiveRepository(null, { pinned: false });

    for (const entry of Array.from(this.entriesById.values())) {
      entry.rootOwners.clear();
      this.prune(entry);
    }
    this.project = null;
  }

  // Follow the workspace's active pane item to maintain the active repository.
  // Safe to call again after the workspace resets its pane containers.
  attachWorkspace(workspace) {
    if (this.destroyed) throw new Error("Cannot attach a destroyed RepositoryRegistry");
    this.workspaceSubscriptions.dispose();
    this.workspaceSubscriptions = new CompositeDisposable();
    this.workspace = workspace;
    this.workspaceSubscriptions.add(
      workspace.getCenter().onDidChangeActivePaneItem((item) => {
        this.updateActiveRepositoryFromPaneItem(item);
      }),
    );
    this.updateActiveRepositoryFromPaneItem(workspace.getCenter().getActivePaneItem());
  }

  detachWorkspace(workspace) {
    if (this.workspace !== workspace) return;
    this.workspaceSubscriptions.dispose();
    this.workspaceSubscriptions = new CompositeDisposable();
    this.workspace = null;
  }

  /*
  Section: Active Repository
  */

  // Essential: The repository the window is currently working in. It follows
  // the active pane item unless a consumer pinned a selection with
  // {::setActiveRepository}. An item whose path lies outside every repository
  // clears it; only path-less items keep the current selection.
  //
  // Returns a {GitRepository}, or `null` when the active item belongs to none.
  getActiveRepository() {
    return this.activeRepository;
  }

  // Public: The active repository together with the directory it applies to.
  //
  // The working directory is always present while a file-backed item is
  // focused: it is the repository's working directory, or, when the item's path
  // lies outside every repository, the directory a consumer would initialize or
  // clone into — its containing project root, or the item's own directory.
  //
  // Returns a frozen {Object}.
  // * `repository` The active {GitRepository}, or `null`.
  // * `workingDirectory` The {String} directory the context applies to, or
  //   `null` when no file-backed item is focused.
  // * `pinned` A {Boolean}, `true` while a manual selection holds.
  getActiveRepositoryContext() {
    return Object.freeze({
      repository: this.activeRepository,
      workingDirectory: this.activeWorkingDirectory,
      pinned: this.activeRepositoryPinned,
    });
  }

  // Public: Whether the active repository is pinned to a manual selection.
  //
  // Returns a {Boolean}.
  isActiveRepositoryPinned() {
    return this.activeRepositoryPinned;
  }

  // Public: Invoke the callback whenever the active repository context changes.
  //
  // It fires for moves between out-of-repository directories too, while the
  // repository itself stays `null`.
  //
  // * `callback` {Function} called with the context {::getActiveRepositoryContext}
  //   returns.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeActiveRepository(callback) {
    return this.emitter.on("did-change-active-repository", callback);
  }

  // Essential: Invoke the callback with the current context immediately, and
  // again on every change.
  //
  // This is what a status bar or a panel wants: it is called once on
  // subscription, so there is no gap to fill in by hand.
  //
  // * `callback` {Function} called with the context {::getActiveRepositoryContext}
  //   returns.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeActiveRepository(callback) {
    callback(this.getActiveRepositoryContext());
    return this.onDidChangeActiveRepository(callback);
  }

  // Public: Select the active repository manually.
  //
  // * `repository` The {GitRepository} to activate, or `null` to clear any pin
  //   and recompute the active repository from the workspace.
  // * `options` (optional) {Object}
  //   * `pin` (optional) {Boolean} keeps the selection until it is cleared.
  //     Without it the next pane item change may move the active repository
  //     again.
  //
  // Throws a {TypeError} if the repository is unregistered or destroyed.
  setActiveRepository(repository, { pin = false } = {}) {
    if (this.destroyed) throw new Error("Cannot activate a repository on a destroyed registry");

    if (repository == null) {
      this.activeRepositoryPinned = false;
      this.recomputeActiveRepository({ emitOnPinChange: true });
      return;
    }

    const entry = this.entryByRepository.get(repository) || this.register(repository);
    if (!entry) {
      throw new TypeError("Cannot activate an unregistered or destroyed repository");
    }
    this.applyActiveRepository(entry.repository, { pinned: pin });
  }

  // Public: Resolve the repository for a path and make it the active one.
  //
  // Unlike {::setActiveRepository} this discovers a repository that was not
  // registered yet, so it is asynchronous.
  //
  // * `filePath` The {String} path to resolve.
  // * `options` (optional) {Object}
  //   * `pin` (optional) {Boolean} keeps the selection, as in
  //     {::setActiveRepository}.
  //
  // Returns a {Promise} that resolves to the {GitRepository}, or to `null` when
  // the path is not in one.
  async setActiveRepositoryForPath(filePath, { pin = false } = {}) {
    const repository = await this.resolveForPath(filePath);
    if (!repository || this.destroyed) return null;
    this.setActiveRepository(repository, { pin });
    return repository;
  }

  // Items may report the repository they belong to either through a file path
  // or, for path-less views such as terminals and diff panes, through a
  // working directory.
  static pathForPaneItem(item) {
    if (typeof item?.getWorkingDirectory === "function") {
      const workingDirectory = item.getWorkingDirectory();
      if (workingDirectory) return workingDirectory;
    }
    return typeof item?.getPath === "function" ? item.getPath() : null;
  }

  updateActiveRepositoryFromPaneItem(item) {
    if (this.destroyed || this.activeRepositoryPinned) return;

    const itemPath = RepositoryRegistry.pathForPaneItem(item);
    if (itemPath) {
      // The context follows every file-backed item, even outside all known
      // repositories, so consumers can offer initialize/clone for the focused
      // location instead of showing an unrelated repository.
      const repository = this.resolveForPathSync(itemPath);
      this.applyActiveRepository(repository, {
        workingDirectory: repository ? null : this.contextDirectoryFor(item, itemPath),
        pinned: false,
      });
      return;
    }

    // Path-less items (settings tabs, untitled buffers) keep the current
    // context so transient tabs never blank it out.
    if (this.activeRepository && !this.activeRepository.isDestroyed?.()) {
      return;
    }
    if (!this.activeRepository && this.activeWorkingDirectory) {
      return;
    }
    const context = this.defaultActiveContext();
    this.applyActiveRepository(context.repository, {
      workingDirectory: context.workingDirectory,
      pinned: false,
    });
  }

  recomputeActiveRepository({ emitOnPinChange = false } = {}) {
    const context = this.deriveActiveContext();
    this.applyActiveRepository(context.repository, {
      workingDirectory: context.workingDirectory,
      pinned: false,
      emitOnPinChange,
    });
  }

  deriveActiveContext() {
    const item = this.workspace?.getCenter?.().getActivePaneItem?.();
    const itemPath = RepositoryRegistry.pathForPaneItem(item);
    if (itemPath) {
      const repository = this.resolveForPathSync(itemPath);
      return {
        repository,
        workingDirectory: repository ? null : this.contextDirectoryFor(item, itemPath),
      };
    }
    if (this.activeRepository && !this.activeRepository.isDestroyed?.()) {
      return { repository: this.activeRepository, workingDirectory: null };
    }
    if (this.activeWorkingDirectory) {
      // A repository may have appeared at the focused out-of-repository
      // directory (for example after `initialize` completes).
      const repository = this.getForPath(this.activeWorkingDirectory);
      return { repository, workingDirectory: repository ? null : this.activeWorkingDirectory };
    }
    return this.defaultActiveContext();
  }

  defaultActiveContext() {
    // Adopt a repository as the default only when the workspace center is empty
    // (no active pane item). When any item is focused — a file, even one in a
    // no-repo root, or a path-less tab such as the About page — the panel
    // follows that item instead of jumping to an arbitrary discovered repo.
    const centerItem = this.workspace?.getCenter?.().getActivePaneItem?.();
    if (centerItem) {
      return { repository: null, workingDirectory: null };
    }

    for (const rootPath of this.rootPaths) {
      const repository = this.getForPath(rootPath);
      if (repository) {
        return { repository, workingDirectory: null };
      }
    }
    const repositories = this.getRepositories();
    if (repositories.length > 0) {
      return { repository: repositories[0], workingDirectory: null };
    }
    // A window whose roots hold no repositories still gets a context, so a
    // fresh project can offer initialize/clone for its first root.
    if (this.rootPaths.length > 0) {
      return { repository: null, workingDirectory: this.rootPaths[0] };
    }
    return { repository: null, workingDirectory: null };
  }

  contextDirectoryFor(item, itemPath) {
    const containingRoot = this.rootPaths.find((rootPath) => pathContains(rootPath, itemPath));
    if (containingRoot) return containingRoot;
    // pathForPaneItem prefers getWorkingDirectory, so a truthy working
    // directory means itemPath already names a directory.
    if (typeof item?.getWorkingDirectory === "function" && item.getWorkingDirectory()) {
      return itemPath;
    }
    return path.dirname(itemPath);
  }

  applyActiveRepository(
    repository,
    { workingDirectory = null, pinned, emitOnPinChange = true } = {},
  ) {
    const normalized = repository && !repository.isDestroyed?.() ? repository : null;
    const nextWorkingDirectory = normalized
      ? normalized.getWorkingDirectory()
      : workingDirectory || null;
    const nextPinned = normalized ? pinned : false;
    const repositoryChanged = normalized !== this.activeRepository;
    const workingDirectoryChanged =
      (nextWorkingDirectory ? normalizePath(nextWorkingDirectory) : null) !==
      (this.activeWorkingDirectory ? normalizePath(this.activeWorkingDirectory) : null);
    const pinChanged = nextPinned !== this.activeRepositoryPinned;
    if (!repositoryChanged && !workingDirectoryChanged && !(pinChanged && emitOnPinChange)) {
      this.activeRepositoryPinned = nextPinned;
      return;
    }

    // Only a pinned manual selection keeps its repository alive; an
    // automatically selected repository follows the normal ownership
    // lifecycle and falls back through removeEntry when it goes away.
    // Acquire the new pin before releasing the old one so a pin-state-only
    // change can never prune the repository in between.
    const nextPin = normalized && nextPinned ? this.retain(normalized, "active-repository") : null;
    if (this.activeRepositoryPin) this.activeRepositoryPin.dispose();
    this.activeRepositoryPin = nextPin;
    this.activeRepository = normalized;
    this.activeWorkingDirectory = nextWorkingDirectory;
    this.activeRepositoryPinned = nextPinned;
    this.emitter.emit(
      "did-change-active-repository",
      Object.freeze({
        repository: normalized,
        workingDirectory: nextWorkingDirectory,
        pinned: nextPinned,
      }),
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scanGeneration++;
    this.subscriptions.dispose();
    this.serviceSubscription?.dispose();
    this.projectSubscriptions.dispose();
    this.workspaceSubscriptions.dispose();
    this.workspace = null;
    this.activeRepository = null;
    this.activeWorkingDirectory = null;
    this.activeRepositoryPin = null;

    for (const owner of this.bufferOwners.values()) owner.subscriptions.dispose();
    this.bufferOwners.clear();

    const entries = Array.from(this.entriesById.values());
    this.entriesById.clear();
    for (const entry of entries) {
      entry.destroySubscription.dispose();
      this.disposeOperationImplementations(entry, { force: true });
      entry.repository.setOperations?.(null);
      if (!entry.repository.isDestroyed?.()) entry.repository.destroy();
    }
    this.operationProviders = [];

    this.emitter.dispose();
  }

  resetProjectSubscriptions() {
    if (!this.project || this.destroyed) return;
    this.projectSubscriptions.dispose();
    this.projectSubscriptions = new CompositeDisposable(
      this.project.onDidAddBuffer((buffer) => this.trackBuffer(buffer)),
      this.project.onDidChangeFiles((events) => this.handleProjectFileChanges(events)),
    );
  }

  /*
  Section: Accessing Repositories
  */

  // Extended: The registered repositories together with the version they were
  // read at.
  //
  // The version increments on every change, so a consumer holding derived state
  // can tell whether its copy is still current without diffing.
  //
  // Returns a frozen {Object}.
  // * `version` A {Number}.
  // * `repositories` A frozen {Array} of {GitRepository}.
  getSnapshot() {
    return Object.freeze({
      version: this.version,
      repositories: Object.freeze(this.getRepositories()),
    });
  }

  // Public: Every registered repository.
  //
  // This is a snapshot. Use {::observeRepositories} to keep up with the ones
  // registered later.
  //
  // Returns an {Array} of {GitRepository}.
  getRepositories() {
    return Array.from(this.entriesById.values(), (entry) => entry.repository);
  }

  // Extended: Look a repository up by the id the registry gave it.
  //
  // * `id` The {String} id.
  //
  // Returns a {GitRepository}, or `null` if nothing is registered under it.
  getById(id) {
    return this.entriesById.get(id)?.repository || null;
  }

  /*
  Section: Event Subscription
  */

  // Essential: Invoke the callback with every registered repository, now and in
  // the future.
  //
  // * `callback` {Function} called with each {GitRepository}.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeRepositories(callback) {
    for (const repository of this.getRepositories()) callback(repository);
    return this.onDidAddRepository(callback);
  }

  // Public: Invoke the callback when a repository is registered.
  //
  // * `callback` {Function} called with the new {GitRepository}.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddRepository(callback) {
    return this.emitter.on("did-add-repository", callback);
  }

  // Public: Invoke the callback when a repository is removed.
  //
  // Release anything keyed on the repository here: it is destroyed once nothing
  // holds it any more.
  //
  // * `callback` {Function} called with the removed {GitRepository}.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveRepository(callback) {
    return this.emitter.on("did-remove-repository", callback);
  }

  // Extended: Invoke the callback once per batch of changes to the registered
  // set, with everything that changed together.
  //
  // Cheaper than the individual events when a consumer rebuilds derived state,
  // since adding a project root registers many repositories at once.
  //
  // * `callback` {Function} called with a frozen {Object}.
  //   * `version` The {Number} the registry is now at.
  //   * `added` An {Array} of newly registered {GitRepository}.
  //   * `removed` An {Array} of {GitRepository} no longer registered.
  //   * `updated` An {Array} of {GitRepository} whose routing changed.
  //   * `rootsAdded` An {Array} of {String} project roots added.
  //   * `rootsRemoved` An {Array} of {String} project roots removed.
  //   * `routingChangedPrefixes` An {Array} of {String} directories whose
  //     path-to-repository routing is no longer what it was.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  // Extended: Invoke the callback when a rescan of the project roots begins.
  //
  // * `callback` {Function} called with a frozen {Object}.
  //   * `id` A {Number} identifying this rescan.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidStartRescan(callback) {
    return this.emitter.on("did-start-rescan", callback);
  }

  // Extended: Invoke the callback when a rescan finishes, whether or not it
  // succeeded.
  //
  // * `callback` {Function} called with a frozen {Object}.
  //   * `id` The {Number} of the rescan that started.
  //   * `repositories` A frozen {Array} of the {GitRepository} it found.
  //   * `error` The {Error} that ended the scan, or `null`.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidFinishRescan(callback) {
    return this.emitter.on("did-finish-rescan", callback);
  }

  // Extended: Invoke the callback when an operation is queued behind another on
  // the same repository.
  //
  // * `callback` {Function} called with an operation snapshot; see
  //   {::getPendingOperations}.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidQueueOperation(callback) {
    return this.emitter.on("did-queue-operation", callback);
  }

  // Extended: Invoke the callback when an operation starts running.
  //
  // * `callback` {Function} called with an operation snapshot; see
  //   {::getPendingOperations}.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidStartOperation(callback) {
    return this.emitter.on("did-start-operation", callback);
  }

  // Extended: Invoke the callback when an operation finishes, whether or not it
  // succeeded.
  //
  // * `callback` {Function} called with an operation snapshot; see
  //   {::getPendingOperations}.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidFinishOperation(callback) {
    return this.emitter.on("did-finish-operation", callback);
  }

  /*
  Section: Resolving Paths
  */

  // Essential: The repository a path belongs to, from what is already
  // registered.
  //
  // Synchronous and free of filesystem access, so it is safe on a hot path such
  // as rendering a gutter. When several repositories contain the path, the one
  // with the longest matching working directory wins, which is what a submodule
  // or a nested checkout should do. Use {::resolveForPath} when the path may
  // belong to a repository nobody has discovered yet.
  //
  // * `filePath` The {String} path to look up.
  //
  // Returns a {GitRepository}, or `null`.
  getForPath(filePath) {
    if (!filePath) return null;

    let bestEntry = null;
    let bestLength = -1;
    const normalizedFilePath = normalizePath(filePath);
    for (const entry of this.entriesById.values()) {
      if (entry.missing || entry.repository.isDestroyed?.()) continue;
      const matchingDirectory = entry.routingDirectories.find((workingDirectory) =>
        pathContainsNormalized(workingDirectory, normalizedFilePath),
      );
      if (matchingDirectory) {
        const candidateLength = matchingDirectory.length;
        if (candidateLength > bestLength) {
          bestEntry = entry;
          bestLength = candidateLength;
        }
      }
    }

    if (!bestEntry && process.platform === "win32" && /~\d/.test(normalizedFilePath)) {
      const canonicalFilePath = canonicalPath(filePath);
      for (const entry of this.entriesById.values()) {
        if (entry.missing || entry.repository.isDestroyed?.()) continue;
        const matchingDirectory = entry.routingDirectories.find((workingDirectory) =>
          pathContainsNormalized(workingDirectory, canonicalFilePath),
        );
        if (matchingDirectory && matchingDirectory.length > bestLength) {
          bestEntry = entry;
          bestLength = matchingDirectory.length;
        }
      }
    }

    // Routing aliases are canonicalized once, when a repository is registered.
    // Normal paths perform no filesystem I/O; only an unresolved Windows 8.3
    // alias needs a realpath fallback. New discovery uses resolveForPath(Sync).
    return bestEntry?.repository || null;
  }

  // Public: The repository a path belongs to, discovering and registering one
  // if it is not known yet.
  //
  // * `filePath` The {String} path to resolve.
  //
  // Returns a {Promise} that resolves to a {GitRepository}, or to `null` when
  // the path is not in one.
  async resolveForPath(filePath) {
    if (!filePath) return null;
    if (!this.project) return this.getForPath(filePath);
    const directory = this.project.getDirectoryForProjectPath(filePath);
    const repository = await this.project.repositoryForDirectoryFromProviders(directory);
    return this.register(repository)?.repository || this.getForPath(filePath);
  }

  // Extended: {::resolveForPath}, synchronously.
  //
  // Discovery reads the filesystem, so this blocks the renderer. Prefer
  // {::getForPath} when the repository is expected to be known already, and
  // {::resolveForPath} when it is not.
  //
  // * `filePath` The {String} path to resolve.
  //
  // Returns a {GitRepository}, or `null`.
  resolveForPathSync(filePath) {
    if (!filePath) return null;
    if (!this.project) return this.getForPath(filePath);
    const directory = this.project.getDirectoryForProjectPath(filePath);
    const repository = this.project.repositoryForDirectoryFromProvidersSync(directory);
    return this.register(repository)?.repository || this.getForPath(filePath);
  }

  // Extended: The repository for a {Directory}, discovering and registering one
  // if it is not known yet.
  //
  // * `directory` The {Directory} to resolve.
  //
  // Returns a {Promise} that resolves to a {GitRepository}, or to `null`.
  async resolveDirectory(directory) {
    const repository = await this.project.repositoryForDirectoryFromProviders(directory);
    return this.register(repository)?.repository || null;
  }

  // Extended: {::resolveDirectory}, synchronously. Reads the filesystem.
  //
  // * `directory` The {Directory} to resolve.
  //
  // Returns a {GitRepository}, or `null`.
  resolveDirectorySync(directory) {
    const repository = this.project.repositoryForDirectoryFromProvidersSync(directory);
    return this.register(repository)?.repository || null;
  }

  /*
  Section: Managing Repositories
  */

  // Public: Keep a repository alive for as long as you hold the result.
  //
  // A repository is destroyed once nothing owns it — no project root contains
  // it, no open buffer belongs to it. Retain one you intend to keep using
  // across those changes, and dispose the result when you are done, or it will
  // outlive its usefulness.
  //
  // * `repository` The {GitRepository} to hold.
  // * `source` (optional) A {String} label for the hold, for debugging.
  //
  // Returns a {Disposable} that releases the hold.
  retain(repository, source = "pin") {
    const entry = this.entryByRepository.get(repository) || this.register(repository);
    if (!entry) return new Disposable();

    const token = Symbol(source);
    entry.pins.add(token);
    return new Disposable(() => {
      entry.pins.delete(token);
      this.prune(entry);
    });
  }

  // Extended: Run your own work against a repository, holding it alive for the
  // duration.
  //
  // {::retain} for the length of one asynchronous call, without the bookkeeping.
  //
  // * `repository` The {GitRepository} to work with.
  // * `operation` An async {Function} called with the repository.
  //
  // Throws an {Error} if the repository cannot be registered.
  //
  // Returns a {Promise} for whatever the operation returned.
  async runOperation(repository, operation) {
    const entry = this.entryByRepository.get(repository) || this.register(repository);
    if (!entry) throw new Error("Cannot run an operation without a live repository");

    const token = Symbol("operation");
    entry.operationOwners.add(token);
    try {
      return await operation(entry.repository);
    } finally {
      entry.operationOwners.delete(token);
      this.prune(entry);
    }
  }

  /*
  Section: Operations
  */

  // Public: Supply the Git implementation behind the registry's operations.
  //
  // The registry routes work but performs none of it. A provider implements at
  // least one of `createRepositoryOperations`, `initializeRepository`,
  // `cloneRepository` or `executeGit`, and the first provider claiming a
  // capability handles it.
  //
  // * `provider` The {Object} implementing the operations.
  // * `options` (optional) {Object}
  //   * `fallback` (optional) {Boolean} puts the provider last instead of
  //     first, so anything registered later takes precedence over it.
  //
  // Throws a {TypeError} if the provider implements none of those methods, and
  // an {Error} if the registry has been destroyed.
  //
  // Returns a {Disposable} that removes the provider and everything it
  // implemented.
  addOperationProvider(provider, { fallback = false } = {}) {
    if (this.destroyed) throw new Error("Cannot add a provider to a destroyed RepositoryRegistry");
    if (
      !provider ||
      (typeof provider.createRepositoryOperations !== "function" &&
        typeof provider.initializeRepository !== "function" &&
        typeof provider.cloneRepository !== "function" &&
        typeof provider.executeGit !== "function")
    ) {
      throw new TypeError(
        "Repository operation providers must implement repository, workspace, or Git transport operations",
      );
    }

    if (fallback) this.operationProviders.push(provider);
    else this.operationProviders.unshift(provider);
    this.emitOperationProviderChange();

    return new Disposable(() => {
      const index = this.operationProviders.indexOf(provider);
      if (index < 0) return;
      this.operationProviders.splice(index, 1);
      for (const entry of this.entriesById.values()) {
        if (entry.operationImplementations.has(provider)) {
          const record = entry.operationImplementations.get(provider);
          entry.operationImplementations.delete(provider);
          this.disposeOperationImplementation(record);
        }
      }
      this.emitOperationProviderChange();
    });
  }

  // Public: The operations available on a repository.
  //
  // * `repository` The {GitRepository}.
  //
  // Returns an {Object} of operation functions, or `null` when no provider has
  // claimed the repository.
  getOperations(repository) {
    return this.entryByRepository.get(repository)?.operations || null;
  }

  // Essential: Whether an operation can be performed on a repository right now.
  //
  // Ask before offering an action. A window where no package provides Git can
  // answer nothing, and the honest response is to hide the command rather than
  // to fail when it is invoked.
  //
  // * `repository` The {GitRepository}.
  // * `operationName` The {String} name of the operation, such as `"commit"`.
  //
  // Returns a {Boolean}.
  canPerformOperation(repository, operationName) {
    return this.findOperationImplementation(repository, operationName) != null;
  }

  // Public: Every operation any provider can perform on a repository.
  //
  // * `repository` The {GitRepository}.
  //
  // Returns a frozen {Array} of {String} operation names.
  getOperationCapabilities(repository) {
    const capabilities = new Set();
    for (const provider of this.operationProviders) {
      const record = this.getOperationImplementation(repository, provider);
      if (!record) continue;

      for (const operationName of RepositoryOperations.standardCapabilities) {
        if (this.operationImplementationSupports(record, operationName)) {
          capabilities.add(operationName);
        }
      }
      const customCapabilities = record.implementation.getCapabilities?.() || [];
      for (const operationName of customCapabilities) {
        if (this.operationImplementationSupports(record, operationName)) {
          capabilities.add(operationName);
        }
      }
    }
    return Object.freeze(Array.from(capabilities));
  }

  // Public: The operations queued or running right now.
  //
  // Operations on one repository run one at a time, so a long fetch leaves the
  // next one queued. This is what a progress indicator reads.
  //
  // * `repository` (optional) The {GitRepository} to report on. Omit it for
  //   every repository, plus the workspace operations that belong to none.
  //
  // Returns a frozen {Array} of frozen {Object}s.
  // * `id` A {Number} identifying the operation.
  // * `repository` The {GitRepository} it runs on, or `null`.
  // * `name` The {String} operation name.
  // * `status` A {String}, `"queued"` or `"running"`.
  // * `workingDirectory` The {String} directory it runs in, or `null`.
  // * `queuedAt` The {Number} timestamp it was queued at.
  // * `startedAt` The {Number} timestamp it started at, or `null`.
  getPendingOperations(repository) {
    const entries = repository
      ? [this.entryByRepository.get(repository)].filter(Boolean)
      : Array.from(this.entriesById.values());
    const operations = entries.flatMap((entry) =>
      Array.from(entry.pendingOperations.values(), (operation) =>
        this.operationSnapshot(operation),
      ),
    );
    if (!repository) {
      operations.push(
        ...Array.from(this.pendingWorkspaceOperations.values(), (operation) =>
          this.operationSnapshot(operation),
        ),
      );
    }
    return Object.freeze(operations);
  }

  getWorkspaceOperationCapabilities() {
    const capabilities = [];
    if (this.findWorkspaceOperationProvider("initialize")) capabilities.push("initialize");
    if (this.findWorkspaceOperationProvider("clone")) capabilities.push("clone");
    return Object.freeze(capabilities);
  }

  canPerformWorkspaceOperation(operationName) {
    return this.findWorkspaceOperationProvider(operationName) != null;
  }

  canExecuteGitCommands() {
    return this.findGitCommandProvider() != null;
  }

  executeGit(args, workingDirectory, options) {
    if (this.destroyed) {
      return Promise.reject(new Error("Cannot execute Git with a destroyed RepositoryRegistry"));
    }
    if (!Array.isArray(args)) {
      return Promise.reject(new TypeError("Git arguments must be an array"));
    }

    const provider = this.findGitCommandProvider();
    if (!provider) {
      const error = new Error("No provider implements raw Git command execution");
      error.code = "ERR_GIT_EXECUTION_UNAVAILABLE";
      return Promise.reject(error);
    }
    return provider.executeGit(args, workingDirectory, options);
  }

  getGitExecutablePath() {
    return this.findGitCommandProvider()?.getGitExecutablePath?.() || null;
  }

  initialize(directoryPath, options) {
    return this.performWorkspaceOperation("initialize", directoryPath, [directoryPath, options]);
  }

  clone(remoteUrl, destinationPath, options) {
    return this.performWorkspaceOperation("clone", destinationPath, [
      remoteUrl,
      destinationPath,
      options,
    ]);
  }

  async registerCreatedRepository(directoryPath, operationName) {
    const registration = await this.add(directoryPath);
    if (registration) return registration.repository;

    const error = new Error(
      `Git ${operationName} completed, but no repository was found at: ${directoryPath}`,
    );
    error.code = "ERR_REPOSITORY_DISCOVERY_FAILED";
    error.operation = operationName;
    error.directoryPath = directoryPath;
    throw error;
  }

  performWorkspaceOperation(operationName, workingDirectory, args) {
    if (this.destroyed) {
      return Promise.reject(new Error("Cannot run an operation on a destroyed RepositoryRegistry"));
    }
    const queueKey = normalizePath(workingDirectory);
    const operation = {
      id: this.nextOperationId++,
      repository: null,
      workingDirectory,
      name: operationName,
      status: "queued",
      queuedAt: Date.now(),
      startedAt: null,
    };
    this.pendingWorkspaceOperations.set(operation.id, operation);
    if (!this.destroyed) {
      this.emitter.emit("did-queue-operation", this.operationSnapshot(operation));
    }

    const execute = async () => {
      operation.status = "running";
      operation.startedAt = Date.now();
      if (!this.destroyed) {
        this.emitter.emit("did-start-operation", this.operationSnapshot(operation));
      }

      let operationError = null;
      try {
        const provider = this.findWorkspaceOperationProvider(operationName);
        if (!provider) {
          const error = new Error(`No provider implements repository operation: ${operationName}`);
          error.code = "ERR_REPOSITORY_OPERATION_UNAVAILABLE";
          error.operation = operationName;
          throw error;
        }
        const methodName =
          operationName === "initialize" ? "initializeRepository" : "cloneRepository";
        await provider[methodName](...args);
        return await this.registerCreatedRepository(workingDirectory, operationName);
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        this.pendingWorkspaceOperations.delete(operation.id);
        if (!this.destroyed) {
          this.emitter.emit(
            "did-finish-operation",
            Object.freeze({
              ...this.operationSnapshot(operation),
              status: operationError ? "failed" : "succeeded",
              finishedAt: Date.now(),
              error: operationError,
            }),
          );
        }
      }
    };

    const previous = this.workspaceOperationTails.get(queueKey) || Promise.resolve();
    const result = previous.then(execute);
    const tail = result.catch(() => {});
    this.workspaceOperationTails.set(queueKey, tail);
    tail.then(() => {
      if (this.workspaceOperationTails.get(queueKey) === tail) {
        this.workspaceOperationTails.delete(queueKey);
      }
    });
    return result;
  }

  findWorkspaceOperationProvider(operationName) {
    const methodName =
      operationName === "initialize"
        ? "initializeRepository"
        : operationName === "clone"
          ? "cloneRepository"
          : null;
    if (!methodName) return null;
    return (
      this.operationProviders.find((provider) => typeof provider[methodName] === "function") || null
    );
  }

  findGitCommandProvider() {
    return (
      this.operationProviders.find((provider) => typeof provider.executeGit === "function") || null
    );
  }

  performOperation(repository, operationName, args = []) {
    if (typeof operationName !== "string" || operationName.length === 0) {
      return Promise.reject(new TypeError("Repository operation name must be a non-empty string"));
    }

    return this.runOperation(repository, () => {
      const entry = this.entryByRepository.get(repository);
      const operation = {
        id: this.nextOperationId++,
        repository,
        name: operationName,
        status: "queued",
        queuedAt: Date.now(),
        startedAt: null,
      };
      entry.pendingOperations.set(operation.id, operation);
      if (!this.destroyed) {
        this.emitter.emit("did-queue-operation", this.operationSnapshot(operation));
      }

      const execute = async () => {
        operation.status = "running";
        operation.startedAt = Date.now();
        if (!this.destroyed) {
          this.emitter.emit("did-start-operation", this.operationSnapshot(operation));
        }

        let operationError = null;
        try {
          const record = this.findOperationImplementation(repository, operationName);
          if (!record) {
            const error = new Error(
              `No provider implements repository operation: ${operationName}`,
            );
            error.code = "ERR_REPOSITORY_OPERATION_UNAVAILABLE";
            error.operation = operationName;
            throw error;
          }

          record.activeOperations++;
          try {
            const result = await record.implementation[operationName](...args);
            await this.refreshRepositoryAfterOperation(
              repository,
              this.operationRefreshHint(record.implementation, operationName, args),
            );
            return result;
          } finally {
            record.activeOperations--;
            if (record.pendingDisposal && record.activeOperations === 0) {
              record.implementation.destroy?.();
            }
          }
        } catch (error) {
          operationError = error;
          throw error;
        } finally {
          entry.pendingOperations.delete(operation.id);
          if (!this.destroyed) {
            this.emitter.emit(
              "did-finish-operation",
              Object.freeze({
                ...this.operationSnapshot(operation),
                status: operationError ? "failed" : "succeeded",
                finishedAt: Date.now(),
                error: operationError,
              }),
            );
          }
        }
      };

      const result = entry.operationTail.then(execute);
      entry.operationTail = result.catch(() => {});
      return result;
    });
  }

  operationSnapshot(operation) {
    return Object.freeze({
      id: operation.id,
      repository: operation.repository,
      name: operation.name,
      status: operation.status,
      workingDirectory: operation.workingDirectory || null,
      queuedAt: operation.queuedAt,
      startedAt: operation.startedAt,
    });
  }

  findOperationImplementation(repository, operationName) {
    for (const provider of this.operationProviders) {
      const record = this.getOperationImplementation(repository, provider);
      if (record && this.operationImplementationSupports(record, operationName)) return record;
    }
    return null;
  }

  operationImplementationSupports(record, operationName) {
    if (typeof record.implementation[operationName] !== "function") return false;
    if (RepositoryOperations.standardCapabilities.includes(operationName)) return true;
    return (record.implementation.getCapabilities?.() || []).includes(operationName);
  }

  getOperationImplementation(repository, provider) {
    const entry = this.entryByRepository.get(repository);
    if (!entry || !this.operationProviders.includes(provider)) return null;
    if (entry.operationImplementations.has(provider)) {
      return entry.operationImplementations.get(provider);
    }
    if (typeof provider.createRepositoryOperations !== "function") {
      entry.operationImplementations.set(provider, null);
      return null;
    }

    const implementation = provider.createRepositoryOperations({
      repository,
      workingDirectory: entry.workingDirectory,
      gitDirectory: repository.getPath?.() || null,
    });
    const record = implementation
      ? { implementation, activeOperations: 0, pendingDisposal: false }
      : null;
    entry.operationImplementations.set(provider, record);
    return record;
  }

  disposeOperationImplementation(record, { force = false } = {}) {
    if (!record) return;
    if (!force && record.activeOperations > 0) {
      record.pendingDisposal = true;
    } else {
      record.implementation.destroy?.();
    }
  }

  disposeOperationImplementations(entry, options) {
    for (const record of entry.operationImplementations.values()) {
      this.disposeOperationImplementation(record, options);
    }
    entry.operationImplementations.clear();
  }

  // Ask the operation implementation which snapshots the operation can have
  // invalidated. Implementations declare this through the optional
  // `getOperationRefreshHint(name, args)` member; anything absent, unknown, or
  // throwing refreshes both snapshots — the behavior every operation had
  // before hints existed.
  operationRefreshHint(implementation, operationName, args) {
    if (typeof implementation.getOperationRefreshHint !== "function") return "both";
    try {
      const hint = implementation.getOperationRefreshHint(operationName, args);
      return OPERATION_REFRESH_HINTS.has(hint) ? hint : "both";
    } catch {
      return "both";
    }
  }

  async refreshRepositoryAfterOperation(repository, hint = "both") {
    if (hint === "none" || repository.isDestroyed?.()) return;
    // Every refs consumer is event-driven, so the refs refresh never gates the
    // operation's promise: it runs detached, freeing five git commands' worth
    // of wait from ref-moving operations. The status refresh stays awaited —
    // callers rely on the operation resolving with a fresh status snapshot.
    if (
      (hint === "refs" || hint === "both") &&
      repository.refreshRefsSnapshot &&
      repository.getRefsSnapshot?.().initialized
    ) {
      Promise.resolve(repository.refreshRefsSnapshot()).catch((error) => {
        this.reportRefreshFailure(repository, error);
      });
    }
    if (
      (hint === "status" || hint === "both") &&
      repository.refreshStatusSnapshot &&
      repository.getStatusSnapshot?.().initialized
    ) {
      try {
        // This refresh gates the operation's promise, so it rides the
        // interactive lane along with the operation itself.
        await repository.refreshStatusSnapshot({ priority: "interactive" });
      } catch (error) {
        this.reportRefreshFailure(repository, error);
      }
    }
  }

  reportRefreshFailure(repository, error) {
    if (repository.isDestroyed?.()) return;
    // The Git command has already succeeded. Never report it as failed (and
    // invite a dangerous retry) merely because the read cache did not refresh.
    this.notificationManager?.addWarning("Repository refresh failed after Git operation", {
      detail: error.message,
      dismissable: true,
    });
  }

  emitOperationProviderChange() {
    if (this.destroyed || this.entriesById.size === 0) return;
    const repositories = this.getRepositories();
    this.emitChange({
      added: [],
      removed: [],
      updated: repositories,
      rootsAdded: [],
      rootsRemoved: [],
      routingChangedPrefixes: [],
    });
  }

  async add(filePath, { persist = true } = {}) {
    const repository = await this.resolveForPath(filePath);
    if (!repository) return null;

    const entry = this.entryByRepository.get(repository);
    const token = Symbol("manual");
    if (persist) entry.manualOwners.add(token);
    else entry.pins.add(token);

    return {
      repository,
      dispose: () => {
        entry.manualOwners.delete(token);
        entry.pins.delete(token);
        this.prune(entry);
      },
    };
  }

  forget(repository) {
    const entry = this.entryByRepository.get(repository);
    if (!entry) return false;
    entry.manualOwners.clear();
    this.prune(entry);
    return true;
  }

  setProjectRoots(directories, { scan = true } = {}) {
    if (this.destroyed) return;

    // Buffer events may be delivered while project roots are changing or the
    // project emitter is being reset. Revalidate these leases before pruning
    // repositories so an open editor can never be left with a destroyed repo.
    this.synchronizeBufferOwners();

    const oldRoots = this.rootPaths;
    const newRoots = directories.map((directory) => directory.getPath());
    const rootsAdded = newRoots.filter(
      (rootPath) => !oldRoots.some((oldRoot) => normalizePath(oldRoot) === normalizePath(rootPath)),
    );
    const rootsRemoved = oldRoots.filter(
      (rootPath) => !newRoots.some((newRoot) => normalizePath(newRoot) === normalizePath(rootPath)),
    );

    this.scanGeneration++;
    this.rootPaths = newRoots;

    // Recompute root ownership for existing repositories first. This transfers
    // ownership between overlapping/replaced roots without remove/add churn.
    const updated = [];
    for (const entry of this.entriesById.values()) {
      const wasMissing = entry.missing;
      entry.missing = !this.repositoryExists(entry);
      if (entry.missing !== wasMissing) updated.push(entry.repository);
      entry.rootOwners.clear();
      if (!entry.missing) {
        for (const rootPath of newRoots) {
          if (this.repositoryRelatesToRoot(entry, rootPath)) entry.rootOwners.add(rootPath);
        }
      }
    }

    const added = [];
    for (const directory of directories) {
      const repository = this.project.repositoryForDirectoryFromProvidersSync(directory);
      const entry = this.register(repository, { emit: false });
      if (entry && this.repositoryExists(entry)) {
        const wasMissing = entry.missing;
        entry.missing = false;
        if (wasMissing && !updated.includes(entry.repository)) updated.push(entry.repository);
        entry.rootOwners.add(directory.getPath());
        if (entry.newlyRegistered) added.push(entry.repository);
        entry.newlyRegistered = false;
      }
    }

    const removed = [];
    for (const entry of Array.from(this.entriesById.values())) {
      if (!this.hasOwners(entry)) {
        const updatedIndex = updated.indexOf(entry.repository);
        if (updatedIndex >= 0) updated.splice(updatedIndex, 1);
        removed.push(entry.repository);
        this.removeEntry(entry, { emit: false, destroy: true });
      }
    }

    if (
      added.length ||
      removed.length ||
      updated.length ||
      rootsAdded.length ||
      rootsRemoved.length
    ) {
      this.emitChange({
        added,
        removed,
        updated,
        rootsAdded,
        rootsRemoved,
        routingChangedPrefixes: [
          ...rootsAdded,
          ...rootsRemoved,
          ...updated.map((repository) => repository.getWorkingDirectory()),
        ],
      });
    }

    // Recompute the active context only to adopt a repository that arrived with
    // the roots, or to invalidate a no-repository context whose directory was
    // removed. Do NOT eagerly default to a no-repository first root here: at
    // startup, repositories are still being discovered asynchronously, and
    // defaulting now flashes an empty "initialize here" context before the real
    // repository is adopted. A genuinely repository-less window still gets its
    // no-repository context from deriveActiveContext when an item is focused.
    const activeDirInvalidated =
      this.activeWorkingDirectory &&
      rootsRemoved.some((rootPath) => pathContains(rootPath, this.activeWorkingDirectory));
    if (
      !this.activeRepositoryPinned &&
      !this.activeRepository &&
      (added.length > 0 || activeDirInvalidated)
    ) {
      this.recomputeActiveRepository();
    }

    if (scan) {
      const generation = this.scanGeneration;
      queueMicrotask(() => {
        if (!this.destroyed && generation === this.scanGeneration) {
          this.scanProjectRoots({ generation }).catch((error) => {
            this.notificationManager?.addWarning("Repository scan failed", {
              detail: error.message,
              dismissable: true,
            });
          });
        }
      });
    }
  }

  async rescan() {
    const id = this.nextRescanId++;
    this.emitter.emit("did-start-rescan", Object.freeze({ id }));

    let repositories = [];
    let error = null;
    try {
      if (!this.project) return repositories;
      this.setProjectRoots(this.project.getDirectories(), { scan: false });
      repositories = await this.scanProjectRoots({ generation: this.scanGeneration });
      return repositories;
    } catch (caughtError) {
      error = caughtError;
      throw caughtError;
    } finally {
      if (!this.destroyed) {
        this.emitter.emit(
          "did-finish-rescan",
          Object.freeze({ id, repositories: Object.freeze(repositories.slice()), error }),
        );
      }
    }
  }

  async scanProjectRoots({ generation = this.scanGeneration, depth } = {}) {
    const scanDepth = depth ?? this.config?.get("git.scanDepth") ?? 1;
    if (scanDepth < 1) return [];

    const discovered = [];
    for (const rootPath of this.rootPaths) {
      const results = await this.scanRoot(rootPath, scanDepth, generation);
      discovered.push(...results);
    }
    return discovered;
  }

  async scanRoot(rootPath, maxDepth, generation) {
    const discovered = [];
    const excluded = this.getExcludedDirectoryNames();
    const queue = [{ directoryPath: rootPath, depth: 0 }];

    while (queue.length > 0) {
      if (this.destroyed || generation !== this.scanGeneration) return discovered;
      if (
        !this.rootPaths.some((candidate) => normalizePath(candidate) === normalizePath(rootPath))
      ) {
        return discovered;
      }

      const current = queue.shift();
      let children;
      try {
        children = await fs.promises.readdir(current.directoryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      if (current.depth > 0 && children.some((child) => child.name === ".git")) {
        if (this.automaticRepositoryLimitReached()) return discovered;

        const directory = this.project.getDirectoryForProjectPath(current.directoryPath);
        const repository = this.project.repositoryForDirectoryFromProvidersSync(directory);
        const entry = this.register(repository);
        if (entry && this.repositoryExists(entry)) {
          entry.missing = false;
          entry.rootOwners.add(rootPath);
          if (!discovered.includes(entry.repository)) discovered.push(entry.repository);
        }
      }

      if (current.depth >= maxDepth) continue;
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink() || excluded.has(child.name)) continue;
        queue.push({
          directoryPath: path.join(current.directoryPath, child.name),
          depth: current.depth + 1,
        });
      }

      // Yield between directories so large scans do not monopolize startup.
      await new Promise((resolve) => setImmediate(resolve));
    }

    return discovered;
  }

  getExcludedDirectoryNames() {
    const excluded = new Set(DEFAULT_EXCLUDED_DIRECTORIES);
    const configured = this.config?.get("git.excludedDirectories") || [];
    for (const name of configured) excluded.add(name);
    return excluded;
  }

  automaticRepositoryLimitReached() {
    const maximum = this.config?.get("git.maxCount") ?? 100;
    if (maximum === 0) return false;
    if (this.entriesById.size < maximum) return false;

    if (!this.didNotifyRepositoryLimit) {
      this.didNotifyRepositoryLimit = true;
      this.notificationManager?.addInfo("Repository discovery limit reached", {
        detail: `Lumine stopped automatic discovery after finding ${maximum} repositories. You can raise git.maxCount or add another repository manually.`,
        dismissable: true,
      });
    }
    return true;
  }

  handleProjectFileChanges(events) {
    if (!this.config?.get("git.watchDiscovery")) return;

    const watchDepth = this.config.get("git.watchDepth") ?? 1;
    for (const event of events) {
      for (const candidatePath of [event.path, event.oldPath]) {
        if (!candidatePath || path.basename(candidatePath) !== ".git") continue;

        const workingDirectory = path.dirname(candidatePath);
        const rootPath = this.rootPaths.find((root) => {
          if (!pathContains(root, workingDirectory)) return false;
          return pathDepth(path.relative(root, workingDirectory)) <= watchDepth;
        });
        if (!rootPath) continue;

        if (fs.existsSync(candidatePath)) {
          if (this.automaticRepositoryLimitReached()) continue;
          const directory = this.project.getDirectoryForProjectPath(workingDirectory);
          const repository = this.project.repositoryForDirectoryFromProvidersSync(directory);
          const entry = this.register(repository);
          if (entry) {
            const wasMissing = entry.missing;
            entry.missing = false;
            entry.rootOwners.add(rootPath);
            if (wasMissing) {
              this.emitChange({
                added: [],
                removed: [],
                updated: [entry.repository],
                rootsAdded: [],
                rootsRemoved: [],
                routingChangedPrefixes: [entry.workingDirectory],
              });
            }
          }
        } else {
          const entry = Array.from(this.entriesById.values()).find(
            (candidate) =>
              normalizePath(candidate.workingDirectory) === normalizePath(workingDirectory),
          );
          if (entry) {
            entry.missing = true;
            entry.rootOwners.clear();
            if (this.hasOwners(entry)) {
              this.emitChange({
                added: [],
                removed: [],
                updated: [entry.repository],
                rootsAdded: [],
                rootsRemoved: [],
                routingChangedPrefixes: [entry.workingDirectory],
              });
            } else {
              this.prune(entry);
            }
          }
        }
      }
    }
  }

  trackBuffer(buffer) {
    if (!buffer || this.bufferOwners.has(buffer)) return;

    const owner = {
      entry: null,
      subscriptions: new CompositeDisposable(),
    };
    this.bufferOwners.set(buffer, owner);

    const update = () => {
      const bufferPath = buffer.getPath?.();
      const repository = bufferPath ? this.resolveForPathSync(bufferPath) : null;
      const nextEntry = this.entryByRepository.get(repository) || null;
      const previousEntry = owner.entry;

      if (nextEntry === previousEntry) return;

      // Acquire the new lease before releasing the old one. Moving a buffer
      // between paths in the same repository must not cause destroy/add churn.
      if (nextEntry) nextEntry.bufferOwners.add(buffer);
      owner.entry = nextEntry;
      if (previousEntry) {
        previousEntry.bufferOwners.delete(buffer);
        // A repository also listens to buffer path changes. Let every listener
        // finish before releasing the old native handle.
        queueMicrotask(() => this.prune(previousEntry));
      }
    };
    owner.update = update;

    owner.subscriptions.add(
      buffer.onDidChangePath?.(update) || new Disposable(),
      buffer.onDidDestroy?.(() => {
        const entry = owner.entry;
        if (entry) entry.bufferOwners.delete(buffer);
        owner.subscriptions.dispose();
        this.bufferOwners.delete(buffer);

        // Other buffer-destroy listeners (including GitRepository itself) must
        // finish before releasing the repository's native handle.
        if (entry) queueMicrotask(() => this.prune(entry));
      }) || new Disposable(),
    );
    update();
  }

  synchronizeBufferOwners() {
    // A destroyed Project detaches itself; root changes delivered afterwards
    // have no buffers to reconcile.
    if (!this.project) return;
    for (const buffer of this.project.getBuffers()) {
      const owner = this.bufferOwners.get(buffer);
      if (owner) owner.update();
      else this.trackBuffer(buffer);
    }
  }

  register(repository, { emit = true } = {}) {
    if (this.destroyed || !repository || repository.isDestroyed?.()) return null;

    const known = this.entryByRepository.get(repository);
    if (known) return known;

    const workingDirectory = repository.getWorkingDirectory();
    const openedWorkingDirectory = repository.openedWorkingDirectoryPath;
    const id = this.repositoryId(repository, workingDirectory);
    const existing = this.entriesById.get(id);
    if (existing) return existing;

    const entry = {
      id,
      repository,
      workingDirectory,
      workingDirectories: Array.from(
        new Set([workingDirectory, openedWorkingDirectory].filter(Boolean)),
      ),
      routingDirectories: Array.from(
        new Set([workingDirectory, openedWorkingDirectory].filter(Boolean).flatMap(pathAliases)),
      ),
      rootOwners: new Set(),
      bufferOwners: new Set(),
      manualOwners: new Set(),
      pins: new Set(),
      operationOwners: new Set(),
      operationTail: Promise.resolve(),
      pendingOperations: new Map(),
      operationImplementations: new Map(),
      operations: null,
      missing: false,
      newlyRegistered: true,
      removing: false,
      destroySubscription: null,
    };

    for (const rootPath of this.rootPaths) {
      if (this.repositoryRelatesToRoot(entry, rootPath)) entry.rootOwners.add(rootPath);
    }

    entry.destroySubscription = repository.onDidDestroy(() => {
      if (!entry.removing) this.removeEntry(entry, { destroy: false });
    });

    this.entriesById.set(id, entry);
    this.entryByRepository.set(repository, entry);
    entry.operations = new RepositoryOperations(this, repository);
    repository.setOperations?.(entry.operations);

    if (emit) {
      entry.newlyRegistered = false;
      this.emitChange({
        added: [repository],
        removed: [],
        updated: [],
        rootsAdded: [],
        rootsRemoved: [],
        routingChangedPrefixes: [workingDirectory],
      });
    }

    // A window without an active repository adopts the first one that appears.
    if (!this.activeRepository) {
      queueMicrotask(() => {
        if (!this.destroyed && !this.activeRepository) {
          this.recomputeActiveRepository();
        }
      });
    }

    return entry;
  }

  repositoryId(repository, workingDirectory) {
    let gitDirectory = repository.getPath?.() || workingDirectory;
    try {
      gitDirectory = fs.realpathSync.native(gitDirectory);
    } catch {
      // The provider has already validated the repository. Keep the resolved
      // path if a transient filesystem race prevents canonicalization.
    }
    return `${normalizePath(workingDirectory)}\0${normalizePath(gitDirectory)}`;
  }

  repositoryRelatesToRoot(entry, rootPath) {
    return pathAliases(rootPath).some((rootAlias) =>
      entry.routingDirectories.some(
        (workingDirectory) =>
          pathContainsNormalized(workingDirectory, rootAlias) ||
          pathContainsNormalized(rootAlias, workingDirectory),
      ),
    );
  }

  repositoryExists(entry) {
    return entry.repository.isPresent?.() ?? true;
  }

  hasOwners(entry) {
    return (
      entry.rootOwners.size > 0 ||
      entry.bufferOwners.size > 0 ||
      entry.manualOwners.size > 0 ||
      entry.pins.size > 0 ||
      entry.operationOwners.size > 0
    );
  }

  prune(entry) {
    if (!entry || entry.removing || this.hasOwners(entry)) return;
    this.removeEntry(entry, { destroy: true });
  }

  removeEntry(entry, { emit = true, destroy = false } = {}) {
    if (!entry || entry.removing || !this.entriesById.has(entry.id)) return;
    entry.removing = true;
    this.entriesById.delete(entry.id);
    entry.destroySubscription.dispose();
    this.disposeOperationImplementations(entry);
    entry.repository.setOperations?.(null);

    if (entry.repository === this.activeRepository) {
      this.applyActiveRepository(null, { pinned: false });
      queueMicrotask(() => {
        if (!this.destroyed && !this.activeRepository) {
          this.recomputeActiveRepository({ emitOnPinChange: true });
        }
      });
    }

    if (destroy && !entry.repository.isDestroyed?.()) entry.repository.destroy();

    if (emit && !this.destroyed) {
      this.emitChange({
        added: [],
        removed: [entry.repository],
        updated: [],
        rootsAdded: [],
        rootsRemoved: [],
        routingChangedPrefixes: [entry.workingDirectory],
      });
    }
  }

  emitChange(change) {
    if (this.destroyed) return;
    this.version++;
    const event = Object.freeze({ version: this.version, ...change });

    for (const repository of change.added) this.emitter.emit("did-add-repository", repository);
    for (const repository of change.removed) {
      this.emitter.emit("did-remove-repository", repository);
    }
    this.emitter.emit("did-change", event);
  }
};

module.exports.pathContains = pathContains;
module.exports.pathDepth = pathDepth;
