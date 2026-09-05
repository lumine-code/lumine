const fs = require("fs");
const path = require("path");

const { CompositeDisposable, Disposable, Emitter } = require("@lumine-code/event-kit");
const RepositoryOperations = require("./repository-operations");

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

// Valid answers from an operation implementation's getOperationRefreshHint():
// which read snapshots the just-finished operation can have invalidated.
const OPERATION_REFRESH_HINTS = new Set(["none", "status", "refs", "both"]);

function normalizePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathAliases(filePath) {
  return [normalizePath(filePath)];
}

async function pathAliasesAsync(filePath) {
  const aliases = new Set(pathAliases(filePath));
  try {
    aliases.add(normalizePath(await fs.promises.realpath(filePath)));
  } catch {
    // Deleted and not-yet-created paths keep their lexical spelling.
  }
  return Array.from(aliases);
}

async function pathIsUnavailable(filePath, { directory = false } = {}) {
  if (!filePath) return false;
  try {
    const stat = await fs.promises.stat(filePath);
    return directory && !stat.isDirectory();
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR";
  }
}

function pathContains(parentPath, childPath) {
  return pathAliases(parentPath).some((parent) =>
    pathAliases(childPath).some((child) => pathContainsNormalized(parent, child)),
  );
}

function pathContainsNormalized(parent, child) {
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child === parent || child.startsWith(prefix);
}

function hasPathOrAncestor(paths, filePath) {
  let candidate = filePath;
  while (true) {
    if (paths.has(candidate)) return true;
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

function pathDepth(relativePath) {
  if (!relativePath || relativePath === ".") return 0;
  return relativePath.split(/[\\/]+/).filter(Boolean).length;
}

function relativeToAny(parentPaths, childPath) {
  for (const parent of parentPaths) {
    if (childPath === parent) return "";
    if (childPath.startsWith(`${parent}${path.sep}`)) {
      return childPath
        .slice(parent.length + 1)
        .split(path.sep)
        .join("/");
    }
  }
  return null;
}

// Which snapshots one changed path can have invalidated: `"status"`, `"refs"`,
// `"both"`, or `"none"`.
//
// Anything in the working tree is a status change. Inside the Git directory
// most write traffic is noise — the loose objects a fetch unpacks, the lock
// file every write pairs with — and only HEAD and the refs move a ref.
function refreshHintForChange(gitRelativeDirectory, name) {
  if (gitRelativeDirectory == null) return "status";
  if (name.endsWith(".lock")) return "none";

  const [section] = gitRelativeDirectory.split("/");
  if (section === "objects") return "none";
  if (section === "refs" || section === "logs") return "both";
  if (section === "" && (name === "HEAD" || name === "packed-refs")) return "both";
  // A linked worktree appearing or disappearing changes this repository's
  // worktree list and nothing else about it. Its own Git directory routes to
  // its own entry once it is registered; this covers the worktrees nobody has
  // opened, and the moment one is created or pruned.
  if (section === "worktrees") return "refs";
  return "status";
}

// Combine the hints two changes leave on one repository. Nothing outranks
// "both", and any two different hints together are "both".
function mergeRefreshHints(current, next) {
  if (current == null || current === next) return next;
  return "both";
}

/**
 * @public
 * @status public
 *
 * Every Git repository this window knows about, available as
 * `lumine.repositories`.
 *
 * Project roots are where repositories are discovered and what keeps them
 * alive, but a repository's identity is independent of them: one root can hold
 * several repositories, one repository can span several roots, and a file
 * opened from outside every root still resolves to the repository that
 * contains it.
 *
 * ## Finding a repository
 *
 * {@link #getForPath} answers from what is already known and never touches the
 * filesystem, which is what a renderer wants. {@link #resolveForPath} may discover
 * and register a repository that was not known yet, at the cost of being
 * asynchronous:
 *
 * ```js
 * const repository = lumine.repositories.getForPath(editor.getPath())
 * if (repository) console.log(repository.getShortHead())
 * ```
 *
 * ## Following the one the user is in
 *
 * {@link #observeActiveRepository} tracks the repository behind the active pane
 * item, so a status bar or a panel does not have to work it out itself:
 *
 * ```js
 * lumine.repositories.observeActiveRepository(({ repository, workingDirectory }) => {
 *   // repository is null when the active item belongs to none
 * })
 * ```
 *
 * ## Operations
 *
 * The registry performs no Git work of its own. A package provides an
 * implementation through {@link #addOperationProvider}, and everything under
 * "Operations" and "Running Git" below is routed to whichever provider claims
 * the capability. Ask {@link #canPerformOperation} before offering an action, since
 * a window with no provider installed can answer nothing.
 */
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
    this.activeResolutionGeneration = 0;

    this.entriesById = new Map();
    this.entryByRepository = new WeakMap();
    this.routingDirectoryOwners = new Map();
    this.gitDirectoryOwners = new Map();
    this.operationProviders = [];
    this.workspaceOperationTails = new Map();
    this.pendingWorkspaceOperations = new Map();
    this.bufferOwners = new Map();
    this.rootPaths = [];
    this.scanGeneration = 0;
    this.fileChangeGeneration = 0;
    this.fileChangeValidationTail = Promise.resolve();
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

    // One focus listener for the whole registry, not one per repository: see
    // handleWindowFocus for what focus can actually have made stale.
    if (typeof window !== "undefined") {
      const onWindowFocus = () => this.handleWindowFocus();
      window.addEventListener("focus", onWindowFocus);
      this.subscriptions.add(
        new Disposable(() => window.removeEventListener("focus", onWindowFocus)),
      );
    }

    if (project) this.attachProject(project);
  }

  // Resetting the window runs `PackageManager#reset`, which clears every
  // consumer off the service hub. A subscription made only in the constructor
  // would survive that in name alone and no provider would reach the registry
  // again, so this is re-run from `Environment#reset` the same way Project
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
    this.fileChangeGeneration++;
    this.activeResolutionGeneration++;
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
      entry.pendingRootReconciliation = false;
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

  /**
   * @category Active Repository
   */

  /**
   * @public
   * @status essential
   *
   * The repository the window is currently working in. It follows
   * the active pane item unless a consumer pinned a selection with
   * {@link #setActiveRepository}. An item whose path lies outside every repository
   * clears it; only path-less items keep the current selection.
   *
   * @returns {GitRepository}, or `null` when the active item belongs to none.
   */
  getActiveRepository() {
    return this.activeRepository;
  }

  /**
   * @public
   * @status public
   *
   * The active repository together with the directory it applies to.
   *
   * The working directory is always present while a file-backed item is
   * focused: it is the repository's working directory, or, when the item's path
   * lies outside every repository, the directory a consumer would initialize or
   * clone into — its containing project root, or the item's own directory.
   *
   * * `repository` The active {@link GitRepository}, or `null`.
   * * `workingDirectory` The `String` directory the context applies to, or
   *   `null` when no file-backed item is focused.
   * * `pinned` A `Boolean`, `true` while a manual selection holds.
   *
   * @returns {Object} frozen `Object`.
   */
  getActiveRepositoryContext() {
    return Object.freeze({
      repository: this.activeRepository,
      workingDirectory: this.activeWorkingDirectory,
      pinned: this.activeRepositoryPinned,
    });
  }

  /**
   * @public
   * @status public
   *
   * Whether the active repository is pinned to a manual selection.
   *
   * @returns {Boolean}
   */
  isActiveRepositoryPinned() {
    return this.activeRepositoryPinned;
  }

  /**
   * @public
   * @status public
   *
   * Invoke the callback whenever the active repository context changes.
   *
   * It fires for moves between out-of-repository directories too, while the
   * repository itself stays `null`.
   *
   * @param {Function} callback - called with the context {@link #getActiveRepositoryContext}
   * @returns {Disposable} A subscription that can be disposed to unsubscribe.
   */
  onDidChangeActiveRepository(callback) {
    return this.emitter.on("did-change-active-repository", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the callback with the current context immediately, and
   * again on every change.
   *
   * This is what a status bar or a panel wants: it is called once on
   * subscription, so there is no gap to fill in by hand.
   *
   * @param {Function} callback - called with the context {@link #getActiveRepositoryContext}
   * @returns {Disposable} A subscription that can be disposed to unsubscribe.
   */
  observeActiveRepository(callback) {
    callback(this.getActiveRepositoryContext());
    return this.onDidChangeActiveRepository(callback);
  }

  /**
   * @public
   * @status public
   *
   * Select the active repository manually.
   *
   * Throws a `TypeError` if the repository is unregistered or destroyed.
   *
   * @param repository - The {@link GitRepository} to activate, or `null` to clear any pin and recompute the active repository from the workspace.
   * @param {Object} [options] - Activation options.
   * @param {Boolean} [options.pin=false] - Keep the selection until it is
   *   cleared instead of following the next pane-item change.
   */
  setActiveRepository(repository, { pin = false } = {}) {
    if (this.destroyed) throw new Error("Cannot activate a repository on a destroyed registry");

    if (repository == null) {
      this.activeRepositoryPinned = false;
      this.recomputeActiveRepository({ emitOnPinChange: true });
      return;
    }

    const generation = ++this.activeResolutionGeneration;

    const entry = this.entryByRepository.get(repository) || this.register(repository);
    if (!entry) {
      throw new TypeError("Cannot activate an unregistered or destroyed repository");
    }
    if (generation !== this.activeResolutionGeneration) return;
    this.applyActiveRepository(entry.repository, { pinned: pin });
  }

  /**
   * @public
   * @status public
   *
   * Resolve the repository for a path and make it the active one.
   *
   * Unlike {@link #setActiveRepository} this discovers a repository that was not
   * registered yet, so it is asynchronous.
   *
   * @param filePath - The `String` path to resolve.
   * @param {Object} [options] - Activation options.
   * @param {Boolean} [options.pin=false] - Keep the selection as in
   *   {@link #setActiveRepository}.
   * @returns {Promise} that resolves to the {@link GitRepository}, or to `null` when the path is not in one.
   */
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

  updateActiveRepositoryFromPaneItem(item, { discover = true } = {}) {
    if (this.destroyed || this.activeRepositoryPinned) return;

    const itemPath = RepositoryRegistry.pathForPaneItem(item);
    if (itemPath) {
      // The context follows every file-backed item, even outside all known
      // repositories, so consumers can offer initialize/clone for the focused
      // location instead of showing an unrelated repository.
      const generation = ++this.activeResolutionGeneration;
      const repository = this.getForPath(itemPath);
      this.applyActiveRepository(repository, {
        workingDirectory: repository ? null : this.contextDirectoryFor(item, itemPath),
        pinned: false,
      });
      if (!discover) return;
      this.discoverForPath(itemPath).then(
        (discovered) => {
          if (
            this.destroyed ||
            this.activeRepositoryPinned ||
            generation !== this.activeResolutionGeneration ||
            RepositoryRegistry.pathForPaneItem(
              this.workspace?.getCenter?.().getActivePaneItem?.(),
            ) !== itemPath
          ) {
            this.abandonDiscoveredRepository(discovered, itemPath);
            return;
          }
          this.commitDiscoveredRepository(discovered, itemPath);
          const registered = this.register(discovered);
          if (generation !== this.activeResolutionGeneration) return;
          const registeredRepository =
            registered && this.entriesById.get(registered.id) === registered
              ? registered.repository
              : null;
          const resolved = this.getForPath(itemPath) || registeredRepository;
          this.applyActiveRepository(resolved, {
            workingDirectory: resolved ? null : this.contextDirectoryFor(item, itemPath),
            pinned: false,
          });
        },
        (error) => console.error(`Unable to resolve Git repository for ${itemPath}`, error),
      );
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
    const generation = ++this.activeResolutionGeneration;
    const context = this.deriveActiveContext();
    this.applyActiveRepository(context.repository, {
      workingDirectory: context.workingDirectory,
      pinned: false,
      emitOnPinChange,
    });
    const item = this.workspace?.getCenter?.().getActivePaneItem?.();
    const itemPath = RepositoryRegistry.pathForPaneItem(item);
    if (itemPath) {
      this.discoverForPath(itemPath).then(
        (discovered) => {
          if (
            this.destroyed ||
            this.activeRepositoryPinned ||
            generation !== this.activeResolutionGeneration ||
            RepositoryRegistry.pathForPaneItem(
              this.workspace?.getCenter?.().getActivePaneItem?.(),
            ) !== itemPath
          ) {
            this.abandonDiscoveredRepository(discovered, itemPath);
            return;
          }
          this.commitDiscoveredRepository(discovered, itemPath);
          const registered = this.register(discovered);
          if (generation !== this.activeResolutionGeneration) return;
          const registeredRepository =
            registered && this.entriesById.get(registered.id) === registered
              ? registered.repository
              : null;
          const repository = this.getForPath(itemPath) || registeredRepository;
          this.applyActiveRepository(repository, {
            workingDirectory: repository ? null : this.contextDirectoryFor(item, itemPath),
            pinned: false,
            emitOnPinChange,
          });
        },
        (error) => console.error(`Unable to resolve Git repository for ${itemPath}`, error),
      );
    }
  }

  deriveActiveContext() {
    const item = this.workspace?.getCenter?.().getActivePaneItem?.();
    const itemPath = RepositoryRegistry.pathForPaneItem(item);
    if (itemPath) {
      const repository = this.getForPath(itemPath);
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
      ? this.entryByRepository.get(normalized)?.workingDirectory || normalized.getWorkingDirectory()
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
    this.fileChangeGeneration++;
    this.activeResolutionGeneration++;
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
    this.routingDirectoryOwners.clear();
    this.gitDirectoryOwners.clear();
    for (const entry of entries) {
      entry.destroySubscription.dispose();
      entry.unavailableSubscription.dispose();
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

  /**
   * @category Accessing Repositories
   */

  /**
   * @public
   * @status extended
   *
   * The registered repositories together with the version they were
   * read at.
   *
   * The version increments on every change, so a consumer holding derived state
   * can tell whether its copy is still current without diffing.
   *
   * * `version` A `Number`.
   * * `repositories` A frozen `Array` of {@link GitRepository}.
   *
   * @returns {Object} frozen `Object`.
   */
  getSnapshot() {
    return Object.freeze({
      version: this.version,
      repositories: Object.freeze(this.getRepositories()),
    });
  }

  /**
   * @public
   * @status public
   *
   * Every registered repository.
   *
   * This is a snapshot. Use {@link #observeRepositories} to keep up with the ones
   * registered later.
   *
   * @returns {Array} of {@link GitRepository}.
   */
  getRepositories() {
    return Array.from(this.entriesById.values(), (entry) => entry.repository);
  }

  /**
   * @public
   * @status extended
   *
   * Look a repository up by the id the registry gave it.
   *
   * @param id - The `String` id.
   * @returns {GitRepository}, or `null` if nothing is registered under it.
   */
  getById(id) {
    return this.entriesById.get(id)?.repository || null;
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status essential
   *
   * Invoke the callback with every registered repository, now and in
   * the future.
   *
   * @param {Function} callback - called with each {@link GitRepository}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeRepositories(callback) {
    for (const repository of this.getRepositories()) callback(repository);
    return this.onDidAddRepository(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the callback when a repository is registered.
   *
   * @param {Function} callback - called with the new {@link GitRepository}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddRepository(callback) {
    return this.emitter.on("did-add-repository", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the callback when a repository is removed.
   *
   * Release anything keyed on the repository here: it is destroyed once nothing
   * holds it any more.
   *
   * @param {Function} callback - called with the removed {@link GitRepository}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidRemoveRepository(callback) {
    return this.emitter.on("did-remove-repository", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the callback once per batch of changes to the registered
   * set, with everything that changed together.
   *
   * Cheaper than the individual events when a consumer rebuilds derived state,
   * since adding a project root registers many repositories at once.
   *
   * @param {Function} callback - called with a frozen `Object`.
   * @param callback.version - The `Number` the registry is now at.
   * @param callback.added - An `Array` of newly registered {@link GitRepository}.
   * @param callback.removed - An `Array` of {@link GitRepository} no longer registered.
   * @param callback.updated - An `Array` of {@link GitRepository} whose routing changed.
   * @param callback.rootsAdded - An `Array` of `String` project roots added.
   * @param callback.rootsRemoved - An `Array` of `String` project roots removed.
   * @param callback.routingChangedPrefixes - An `Array` of `String` directories whose path-to-repository routing is no longer what it was.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the callback when a rescan of the project roots begins.
   *
   * @param {Function} callback - called with a frozen `Object`.
   * @param callback.id - A `Number` identifying this rescan.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidStartRescan(callback) {
    return this.emitter.on("did-start-rescan", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the callback when a rescan finishes, whether or not it
   * succeeded.
   *
   * @param {Function} callback - called with a frozen `Object`.
   * @param callback.id - The `Number` of the rescan that started.
   * @param callback.repositories - A frozen `Array` of the {@link GitRepository} it found.
   * @param callback.error - The `Error` that ended the scan, or `null`.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidFinishRescan(callback) {
    return this.emitter.on("did-finish-rescan", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the callback when an operation is queued behind another on
   * the same repository.
   *
   * @param {Function} callback - called with an operation snapshot; see {@link #getPendingOperations}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidQueueOperation(callback) {
    return this.emitter.on("did-queue-operation", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the callback when an operation starts running.
   *
   * @param {Function} callback - called with an operation snapshot; see {@link #getPendingOperations}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidStartOperation(callback) {
    return this.emitter.on("did-start-operation", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the callback when an operation finishes, whether or not it
   * succeeded.
   *
   * @param {Function} callback - called with an operation snapshot; see {@link #getPendingOperations}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidFinishOperation(callback) {
    return this.emitter.on("did-finish-operation", callback);
  }

  /**
   * @category Resolving Paths
   */

  /**
   * @public
   * @status essential
   *
   * The repository a path belongs to, from what is already
   * registered.
   *
   * Synchronous and free of filesystem access, so it is safe on a hot path such
   * as rendering a gutter. When several repositories contain the path, the one
   * with the longest matching working directory wins, which is what a submodule
   * or a nested checkout should do. Use {@link #resolveForPath} when the path may
   * belong to a repository nobody has discovered yet.
   *
   * @param filePath - The `String` path to look up.
   * @returns {GitRepository}, or `null`.
   */
  getForPath(filePath) {
    if (!filePath) return null;

    let bestEntry = null;
    let bestLength = -1;
    const normalizedFilePath = normalizePath(filePath);
    for (const entry of this.entriesById.values()) {
      if (entry.missing || entry.repository.isDestroyed?.()) continue;
      const matchingDirectory = entry.routingDirectories.find(
        (workingDirectory) =>
          this.routingDirectoryOwners.get(workingDirectory) === entry &&
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

    // Routing is purely lexical. Repository discovery resolves symlinks and
    // Windows aliases asynchronously, then registers both the canonical
    // working directory and the spelling through which it was opened.
    return bestEntry?.repository || null;
  }

  /**
   * @public
   * @status public
   *
   * The repository a path belongs to, discovering and registering one
   * if it is not known yet.
   *
   * @param filePath - The `String` path to resolve.
   * @returns {Promise} that resolves to a {@link GitRepository}, or to `null` when the path is not in one.
   */
  async resolveForPath(filePath, { refresh = true } = {}) {
    if (!filePath) return null;
    const repository = await this.discoverForPath(filePath, { refresh });
    this.commitDiscoveredRepository(repository, filePath);
    const registered = this.register(repository);
    if (this.destroyed) return null;
    const registeredRepository =
      registered && this.entriesById.get(registered.id) === registered
        ? registered.repository
        : null;
    return this.getForPath(filePath) || registeredRepository;
  }

  async discoverForPath(filePath, options = {}) {
    if (!filePath) return null;
    if (!this.project) return this.getForPath(filePath);
    const project = this.project;
    const repository = await project.repositoryForPathFromProviders(filePath, options);
    if (this.destroyed || this.project !== project) {
      this.abandonDiscoveredRepository(repository, filePath, project);
      return null;
    }
    return repository;
  }

  commitDiscoveredRepository(repository, filePath) {
    if (repository && this.project) {
      this.project.commitRepositoryForPath?.(repository, filePath);
    }
  }

  abandonDiscoveredRepository(repository, filePath, project = this.project) {
    if (!repository || !project) return;
    queueMicrotask(() => project.abandonRepositoryForPath?.(repository, filePath));
  }

  /**
   * @category Managing Repositories
   */

  /**
   * @public
   * @status public
   *
   * Keep a repository alive for as long as you hold the result.
   *
   * A repository is destroyed once nothing owns it — no project root contains
   * it, no open buffer belongs to it. Retain one you intend to keep using
   * across those changes, and dispose the result when you are done, or it will
   * outlive its usefulness.
   *
   * @param repository - The {@link GitRepository} to hold.
   * @param [source] - A `String` label for the hold, for debugging.
   * @returns {Disposable} that releases the hold.
   */
  retain(repository, source = "pin") {
    const entry = this.entryByRepository.get(repository) || this.register(repository);
    if (!entry || this.entriesById.get(entry.id) !== entry) return new Disposable();

    const token = Symbol(source);
    entry.pins.add(token);
    return new Disposable(() => {
      entry.pins.delete(token);
      this.prune(entry);
    });
  }

  /**
   * @public
   * @status extended
   *
   * Run your own work against a repository, holding it alive for the
   * duration.
   *
   * {@link #retain} for the length of one asynchronous call, without the bookkeeping.
   *
   *
   * Throws an `Error` if the repository cannot be registered.
   *
   * @param repository - The {@link GitRepository} to work with.
   * @param operation - An async `Function` called with the repository.
   * @returns {Promise} for whatever the operation returned.
   */
  async runOperation(repository, operation) {
    const entry = this.entryByRepository.get(repository) || this.register(repository);
    if (!entry || this.entriesById.get(entry.id) !== entry) {
      throw new Error("Cannot run an operation without a live repository");
    }

    const token = Symbol("operation");
    entry.operationOwners.add(token);
    try {
      return await operation(entry.repository);
    } finally {
      entry.operationOwners.delete(token);
      this.prune(entry);
    }
  }

  /**
   * @category Operations
   */

  /**
   * @public
   * @status public
   *
   * Supply the Git implementation behind the registry's operations.
   *
   * The registry routes work but performs none of it. A provider implements at
   * least one of `createRepositoryOperations`, `initializeRepository`,
   * `cloneRepository` or `executeGit`, and the first provider claiming a
   * capability handles it.
   *
   * Throws a `TypeError` if the provider implements none of those methods, and
   * an `Error` if the registry has been destroyed.
   *
   * @param provider - The `Object` implementing the operations.
   * @param {Object} [options] - Provider options.
   * @param {Boolean} [options.fallback=false] - Put the provider last so later
   *   registrations take precedence.
   * @returns {Disposable} that removes the provider and everything it implemented.
   */
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

  /**
   * @public
   * @status public
   *
   * The operations available on a repository.
   *
   * @param repository - The {@link GitRepository}.
   * @returns {Object} of operation functions, or `null` when no provider has claimed the repository.
   */
  getOperations(repository) {
    return this.entryByRepository.get(repository)?.operations || null;
  }

  /**
   * @public
   * @status essential
   *
   * Whether an operation can be performed on a repository right now.
   *
   * Ask before offering an action. A window where no package provides Git can
   * answer nothing, and the honest response is to hide the command rather than
   * to fail when it is invoked.
   *
   * @param repository - The {@link GitRepository}.
   * @param operationName - The `String` name of the operation, such as `"commit"`.
   * @returns {Boolean}
   */
  canPerformOperation(repository, operationName) {
    return this.findOperationImplementation(repository, operationName) != null;
  }

  /**
   * @public
   * @status public
   *
   * Every operation any provider can perform on a repository.
   *
   * @param repository - The {@link GitRepository}.
   * @returns {Array} frozen `Array` of `String` operation names.
   */
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

  /**
   * @public
   * @status public
   *
   * The operations queued or running right now.
   *
   * Operations on one repository run one at a time, so a long fetch leaves the
   * next one queued. This is what a progress indicator reads.
   *
   *
   * * `id` A `Number` identifying the operation.
   * * `name` The `String` operation name.
   * * `status` A `String`, `"queued"` or `"running"`.
   * * `workingDirectory` The `String` directory it runs in, or `null`.
   * * `queuedAt` The `Number` timestamp it was queued at.
   * * `startedAt` The `Number` timestamp it started at, or `null`.
   *
   * @param [repository] - The {@link GitRepository} to report on. Omit it for every repository, plus the workspace operations that belong to none.
   * @param repository - The {@link GitRepository} it runs on, or `null`.
   * @returns {Array} frozen `Array` of frozen `Objects`.
   */
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

  /**
   * @category Creating Repositories
   */

  /**
   * @public
   * @status public
   *
   * Which of `initialize` and `clone` a provider can perform.
   *
   * These belong to no repository — they are what creates one — so they are
   * asked for separately from {@link #getOperationCapabilities}.
   *
   * @returns {Array} frozen `Array` of `String` operation names.
   */
  getWorkspaceOperationCapabilities() {
    const capabilities = [];
    if (this.findWorkspaceOperationProvider("initialize")) capabilities.push("initialize");
    if (this.findWorkspaceOperationProvider("clone")) capabilities.push("clone");
    return Object.freeze(capabilities);
  }

  /**
   * @public
   * @status public
   *
   * Whether a repository-creating operation can be performed.
   *
   * @param operationName - A `String`, `"initialize"` or `"clone"`.
   * @returns {Boolean}
   */
  canPerformWorkspaceOperation(operationName) {
    return this.findWorkspaceOperationProvider(operationName) != null;
  }

  /**
   * @category Running Git
   */

  /**
   * @public
   * @status public
   *
   * Whether any provider can run raw Git commands.
   *
   * @returns {Boolean}
   */
  canExecuteGitCommands() {
    return this.findGitCommandProvider() != null;
  }

  /**
   * @public
   * @status extended
   *
   * Run a Git command through whichever provider offers one.
   *
   * The escape hatch for what the operation set does not cover. Prefer a named
   * operation where one exists — it is the part a provider can implement
   * without shelling out.
   *
   * @param args - An `Array` of `String` arguments, without the leading `git`.
   * @param workingDirectory - The `String` directory to run in.
   * @param {Object} [options] - passed through to the provider.
   * @returns {Promise} for the provider's result. It rejects with a `TypeError` if `args` is not an array, and with an `Error` whose `code` is `ERR_GIT_EXECUTION_UNAVAILABLE` when no provider runs Git commands.
   */
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

  /**
   * @category Creating Repositories
   */

  /**
   * @public
   * @status public
   *
   * Create a repository in a directory and register it.
   *
   * @param directoryPath - The `String` directory to initialize.
   * @param {Object} [options] - passed through to the provider.
   * @returns {Promise} that resolves to the new {@link GitRepository}. It rejects when no provider implements `initialize`, and with an `Error` whose `code` is `ERR_REPOSITORY_DISCOVERY_FAILED` if the command succeeded but nothing was found at the path afterwards.
   */
  initialize(directoryPath, options) {
    return this.performWorkspaceOperation("initialize", directoryPath, [directoryPath, options]);
  }

  /**
   * @public
   * @status public
   *
   * Clone a remote into a directory and register the result.
   *
   * @param remoteUrl - The `String` URL to clone.
   * @param destinationPath - The `String` directory to clone into.
   * @param {Object} [options] - passed through to the provider.
   * @returns {Promise} that resolves to the new {@link GitRepository}, and rejects the same way {@link #initialize} does.
   */
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
    let statusRefresh = null;
    if (
      (hint === "status" || hint === "both") &&
      repository.refreshStatusSnapshot &&
      repository.getStatusSnapshot?.().initialized
    ) {
      // This refresh gates the operation's promise, so it rides the
      // interactive lane along with the operation itself.
      try {
        statusRefresh = Promise.resolve(
          repository.refreshStatusSnapshot({ priority: "interactive" }),
        ).catch((error) => this.reportRefreshFailure(repository, error));
      } catch (error) {
        this.reportRefreshFailure(repository, error);
      }
    }

    // Status is the only refresh that gates the operation. Waiting for it to
    // settle before enqueueing refs also keeps refs out of an already-queued
    // trailing status request; a single microtask is insufficient while
    // another snapshot flight is active.
    if (statusRefresh) await statusRefresh;

    // Every refs consumer is event-driven, so the refs refresh runs detached,
    // freeing its Git commands' worth of wait from ref-moving operations.
    if (
      (hint === "refs" || hint === "both") &&
      repository.refreshRefsSnapshot &&
      repository.getRefsSnapshot?.().initialized
    ) {
      let refsRefresh;
      try {
        refsRefresh = repository.refreshRefsSnapshot();
      } catch (error) {
        this.reportRefreshFailure(repository, error);
      }
      Promise.resolve(refsRefresh).catch((error) => this.reportRefreshFailure(repository, error));
    }
  }

  reportRefreshFailure(repository, error) {
    if (repository.isDestroyed?.()) return;
    // GitRepository owns the once-per-repository reporting policy. Route
    // post-operation failures through the same gate so a combined status+refs
    // refresh cannot produce duplicate warnings.
    if (typeof repository.reportBackgroundSnapshotError === "function") {
      repository.reportBackgroundSnapshotError(error);
      return;
    }
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

  /**
   * @category Managing Repositories
   */

  /**
   * @public
   * @status public
   *
   * Register the repository containing a path, and keep it.
   *
   * For a repository the user chose that no project root covers. It is held
   * until the returned handle is disposed, and by default remembered across
   * window reloads.
   *
   * * `repository` The {@link GitRepository}.
   * * `dispose` A `Function` that releases it.
   *
   * @param filePath - The `String` path inside the repository to add.
   * @param {Object} [options] - Registration options.
   * @param {Boolean} [options.persist=true] - Remember the repository across
   *   window reloads. Pass `false` to keep it for this session only.
   * @returns {Promise} that resolves to an `Object`, or to `null` when the path is not in a repository.
   */
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

  /**
   * @public
   * @status public
   *
   * Drop every manual hold {@link #add} placed on a repository.
   *
   * The repository stays registered while a project root or an open buffer
   * still owns it.
   *
   * @param repository - The {@link GitRepository} to forget.
   * @returns {Boolean} : `true` if the repository was registered.
   */
  forget(repository) {
    const entry = this.entryByRepository.get(repository);
    if (!entry) return false;
    entry.manualOwners.clear();
    this.prune(entry);
    return true;
  }

  setProjectRoots(directories, { scan = true, reconcile = scan } = {}) {
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
    if (rootsAdded.length > 0 || rootsRemoved.length > 0) this.fileChangeGeneration++;
    this.rootPaths = newRoots;

    // Recompute root ownership for existing repositories first. This transfers
    // ownership between overlapping/replaced roots without remove/add churn.
    const updated = [];
    for (const entry of this.entriesById.values()) {
      const hadRootOwner = entry.rootOwners.size > 0 || entry.pendingRootReconciliation;
      entry.rootOwners.clear();
      if (!entry.missing) {
        for (const rootPath of newRoots) {
          if (this.repositoryRelatesToRoot(entry, rootPath)) entry.rootOwners.add(rootPath);
        }
      }
      entry.pendingRootReconciliation =
        reconcile && newRoots.length > 0 && hadRootOwner && entry.rootOwners.size === 0;
    }

    const added = [];
    for (const directory of directories) {
      // Adopt provider-cached repositories synchronously without touching the
      // filesystem. New roots are discovered by scanProjectRoots below.
      const repository = this.project.repositoryForPathFromProvidersCached?.(directory.getPath());
      const entry = this.register(repository, { emit: false });
      if (entry) {
        const wasMissing = entry.missing;
        entry.missing = false;
        entry.pendingRootReconciliation = false;
        if (wasMissing && !updated.includes(entry.repository)) updated.push(entry.repository);
        entry.rootOwners.add(directory.getPath());
        if (entry.newlyRegistered) added.push(entry.repository);
        entry.newlyRegistered = false;
      }
    }

    const removed = [];
    const removedRoutingPrefixes = [];
    for (const entry of Array.from(this.entriesById.values())) {
      if (!this.hasOwners(entry)) {
        const updatedIndex = updated.indexOf(entry.repository);
        if (updatedIndex >= 0) updated.splice(updatedIndex, 1);
        removed.push(entry.repository);
        removedRoutingPrefixes.push(...entry.routingDirectories);
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
          ...rootsAdded.flatMap(pathAliases),
          ...rootsRemoved.flatMap(pathAliases),
          ...removedRoutingPrefixes,
          ...added.flatMap(
            (repository) => this.entryByRepository.get(repository)?.routingDirectories ?? [],
          ),
          ...updated.flatMap(
            (repository) => this.entryByRepository.get(repository)?.routingDirectories ?? [],
          ),
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
      this.setProjectRoots(this.project.getDirectories(), { scan: false, reconcile: true });
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

  /**
   * @public
   * @status public
   *
   * Discover the current repository set again, then refresh every repository's
   * already-active caches and snapshots.
   *
   * Snapshot caches stay lazy: a status or refs snapshot that no consumer has
   * initialized is not loaded merely because of an update. A refresh failure in
   * one repository does not prevent the others from updating.
   *
   * @returns {Promise} that resolves to an `Array` of every registered {@link GitRepository}.
   */
  async update() {
    await this.rescan();
    const repositories = this.getRepositories();

    await Promise.allSettled(
      repositories.map(async (repository) => {
        repository.refreshIndex?.();

        const refreshes = [];
        if (repository.refreshStatus) refreshes.push(repository.refreshStatus());
        if (repository.refreshStatusSnapshot && repository.getStatusSnapshot?.().initialized) {
          refreshes.push(repository.refreshStatusSnapshot());
        }
        if (repository.refreshRefsSnapshot && repository.getRefsSnapshot?.().initialized) {
          refreshes.push(repository.refreshRefsSnapshot());
        }
        await Promise.all(refreshes);
      }),
    );

    return repositories;
  }

  async scanProjectRoots({ generation = this.scanGeneration, depth } = {}) {
    const scanDepth = depth ?? this.config?.get("git.scanDepth") ?? 1;

    const discovered = [];
    let complete = true;
    for (const rootPath of this.rootPaths) {
      const result = await this.scanRoot(rootPath, scanDepth, generation);
      discovered.push(...result.repositories);
      complete &&= result.complete;
    }
    if (this.destroyed || generation !== this.scanGeneration) return discovered;

    // Root ownership follows what this complete scan actually found. This
    // removes vanished repositories without assuming that a custom VCS uses a
    // Git-shaped directory or offers a synchronous presence check.
    if (complete) {
      const discoveredSet = new Set(discovered);
      for (const entry of Array.from(this.entriesById.values())) {
        const wasRootOwned = entry.rootOwners.size > 0 || entry.pendingRootReconciliation;
        entry.pendingRootReconciliation = false;
        if (!wasRootOwned || discoveredSet.has(entry.repository)) continue;
        entry.rootOwners.clear();
        if (!this.hasOwners(entry)) this.removeEntry(entry, { destroy: true });
      }
    }
    return discovered;
  }

  async scanRoot(rootPath, maxDepth, generation) {
    const discovered = [];
    let complete = true;
    const excluded = this.getExcludedDirectoryNames();
    const queue = [{ directoryPath: rootPath, depth: 0 }];

    while (queue.length > 0) {
      if (this.destroyed || generation !== this.scanGeneration) {
        return { repositories: discovered, complete: false };
      }
      if (
        !this.rootPaths.some((candidate) => normalizePath(candidate) === normalizePath(rootPath))
      ) {
        return { repositories: discovered, complete: false };
      }

      const current = queue.shift();
      let children;
      try {
        children = await fs.promises.readdir(current.directoryPath, { withFileTypes: true });
      } catch {
        complete = false;
        continue;
      }

      if (current.depth === 0 || children.some((child) => child.name === ".git")) {
        if (current.depth > 0 && this.automaticRepositoryLimitReached()) {
          return { repositories: discovered, complete: false };
        }

        const repository = await this.discoverForPath(current.directoryPath, { refresh: true });
        if (this.destroyed || generation !== this.scanGeneration) {
          this.abandonDiscoveredRepository(repository, current.directoryPath);
          return { repositories: discovered, complete: false };
        }
        this.commitDiscoveredRepository(repository, current.directoryPath);
        const entry = this.register(repository);
        if (
          this.destroyed ||
          generation !== this.scanGeneration ||
          !this.rootPaths.some((candidate) => normalizePath(candidate) === normalizePath(rootPath))
        ) {
          this.prune(entry);
          return { repositories: discovered, complete: false };
        }
        if (entry) {
          entry.missing = false;
          entry.pendingRootReconciliation = false;
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

    return { repositories: discovered, complete };
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
    const generation = this.fileChangeGeneration;
    const work = this.fileChangeValidationTail.then(async () => {
      if (this.destroyed || generation !== this.fileChangeGeneration) return;
      // Earlier discovery may have transferred an alias to a different
      // repository. Plan against routing as it exists when this batch reaches
      // the front of the serialized lifecycle queue, not when it first arrived.
      const refreshPlan = this.repositoryRefreshPlanForFileChanges(events);
      await this.removeUnavailableRepositories(refreshPlan.deletedRepositories, generation);
      if (this.destroyed || generation !== this.fileChangeGeneration) return;
      this.scheduleRepositoryRefreshPlan(refreshPlan.pending);
      await this.discoverRepositoriesForFileChanges(events);
    });
    const settled = work.catch((error) => {
      console.error("Unable to update repositories from filesystem changes", error);
    });
    this.fileChangeValidationTail = settled;
    return settled;
  }

  async removeUnavailableRepositories(repositories, generation) {
    if (repositories.size === 0 || generation !== this.fileChangeGeneration) return;
    const candidates = Array.from(repositories, (repository) =>
      this.entryByRepository.get(repository),
    ).filter(
      (entry) =>
        entry &&
        !entry.missing &&
        !entry.removing &&
        !entry.repository.isDestroyed?.() &&
        this.entriesById.get(entry.id) === entry,
    );

    await Promise.all(
      candidates.map(async (entry) => {
        const repository = entry.repository;
        const workingDirectory = repository.getWorkingDirectory?.();
        const requiredPaths = [
          { path: workingDirectory, directory: true },
          { path: repository.getPath?.(), directory: true },
          ...(workingDirectory && repository.getType?.() === "git"
            ? [{ path: path.join(workingDirectory, ".git"), directory: false }]
            : []),
        ].filter(({ path: requiredPath }) => Boolean(requiredPath));
        const unavailable = (
          await Promise.all(
            requiredPaths.map(({ path: requiredPath, directory }) =>
              pathIsUnavailable(requiredPath, { directory }),
            ),
          )
        ).some(Boolean);
        if (
          unavailable &&
          !this.destroyed &&
          generation === this.fileChangeGeneration &&
          this.entriesById.get(entry.id) === entry
        ) {
          this.removeUnavailableEntry(entry);
        }
      }),
    );
  }

  // Refresh what window focus can actually have made stale.
  //
  // The project watcher reports changes whether or not the window is focused,
  // so a repository it fully covers — working directory and Git directory both
  // inside a project root — learned about a terminal commit or checkout the
  // moment it happened, and regaining focus tells it nothing new. Focus
  // matters for the repositories the watcher cannot see (one followed through
  // an out-of-root buffer, one whose roots sit below its working tree), and
  // for the active repository, which gets a refresh as a safety net against
  // missed watcher events because its staleness is the one on screen.
  // Everything scheduled here stays subscriber-gated and debounced.
  handleWindowFocus() {
    if (this.destroyed || this.entriesById.size === 0) return;

    const rootAliases = this.rootPaths.flatMap((rootPath) => pathAliases(rootPath));
    for (const entry of this.entriesById.values()) {
      if (entry.missing || entry.repository.isDestroyed?.()) continue;
      if (entry.repository !== this.activeRepository && this.watcherCovers(entry, rootAliases)) {
        continue;
      }
      entry.repository.scheduleStatusSnapshotRefresh?.();
      entry.repository.scheduleRefsSnapshotRefresh?.();
    }
  }

  // Whether the project watcher sees everything that can change this
  // repository's snapshots: its working directory and its Git directory both
  // inside a project root. Checked separately because they can part ways — a
  // linked worktree's Git directory lives under its main repository's, which
  // may be outside every root even when the worktree itself is inside one.
  watcherCovers(entry, rootAliases) {
    const covered = (aliases) =>
      aliases.length > 0 &&
      aliases.some((alias) =>
        rootAliases.some((rootAlias) => pathContainsNormalized(rootAlias, alias)),
      );
    return covered(entry.routingDirectories) && covered(entry.gitDirectoryAliases);
  }

  // Keep the snapshots current with what actually happens on disk.
  //
  // A repository refreshes when one of its own buffers is saved and after its
  // own operations — which covers nothing that reaches the disk any other way.
  // A build run from the terminal, a `git commit` from a panel, a file a
  // package rewrites: every colour derived from Git would stay as it was until
  // something else asked for a refresh. The project already watches every
  // root, so route its events to the repository that owns them; this is what
  // lets handleWindowFocus leave watcher-covered repositories alone. Both
  // schedulers debounce, coalesce, and no-op without a subscriber, so even a
  // noisy batch costs one snapshot request per repository at most.
  repositoryRefreshPlanForFileChanges(events) {
    const pending = new Map();
    const deletedRepositories = new Set();
    const deletedPaths = new Set();
    if (this.destroyed || this.entriesById.size === 0) {
      return { pending, deletedRepositories };
    }

    // Batches run to thousands of events during an install or a checkout, and
    // the paths in one arrive in runs from the same directory. Everything the
    // classification needs is a property of the directory, so each one is
    // resolved — aliases and all — exactly once per batch.
    const contextsByDirectory = new Map();
    const contextsFor = (changedPath) => {
      const directoryPath = path.dirname(changedPath);
      if (!contextsByDirectory.has(directoryPath)) {
        contextsByDirectory.set(directoryPath, this.changeContextsFor(changedPath, directoryPath));
      }
      return contextsByDirectory.get(directoryPath);
    };

    for (const event of events) {
      for (const [changedPath, deleted] of [
        [event.path, event.action === "deleted"],
        [event.oldPath, Boolean(event.oldPath)],
      ]) {
        if (!changedPath) continue;

        const name = path.basename(changedPath);
        if (deleted) {
          const normalizedChangedPath = normalizePath(changedPath);
          deletedPaths.add(normalizedChangedPath);
          for (const exactOwner of [
            this.routingDirectoryOwners.get(normalizedChangedPath),
            this.gitDirectoryOwners.get(normalizedChangedPath),
          ]) {
            if (exactOwner) deletedRepositories.add(exactOwner.repository);
          }
        }
        for (const context of contextsFor(changedPath)) {
          if (deleted) deletedRepositories.add(context.repository);
          if (pending.get(context.repository) === "both") continue;

          const hint = refreshHintForChange(context.gitRelativeDirectory, name);
          if (hint === "none") continue;
          pending.set(context.repository, mergeRefreshHints(pending.get(context.repository), hint));
        }
      }
    }

    // Recursive watchers may collapse a whole removed subtree into one event
    // for its parent. Walk each registered alias toward the filesystem root and
    // test membership in the deleted-path set, making this O(repositories ×
    // path depth) rather than O(repositories × event count).
    if (deletedPaths.size > 0) {
      for (const owners of [this.routingDirectoryOwners, this.gitDirectoryOwners]) {
        for (const [ownedPath, entry] of owners) {
          if (hasPathOrAncestor(deletedPaths, ownedPath)) {
            deletedRepositories.add(entry.repository);
          }
        }
      }
    }

    return { pending, deletedRepositories };
  }

  scheduleRepositoryRefreshPlan(pending) {
    for (const [repository, hint] of pending) {
      const entry = this.entryByRepository.get(repository);
      if (
        !entry ||
        entry.missing ||
        entry.removing ||
        this.entriesById.get(entry.id) !== entry ||
        repository.isDestroyed?.()
      ) {
        continue;
      }
      if (hint !== "refs") repository.scheduleStatusSnapshotRefresh();
      // Re-reading the refs costs several Git processes, so it is reserved for
      // the entries that can actually have moved a ref or a worktree.
      if (hint !== "status") repository.scheduleRefsSnapshotRefresh();
    }
  }

  // Which repositories one changed path belongs to, and where it sits inside
  // each one's Git directory.
  //
  // A path inside a Git directory routes by that directory rather than by a
  // working tree, because the two disagree for a linked worktree: its Git
  // directory lives under its main repository's, so a working-tree match hands
  // every one of its HEAD moves to the main repository and never tells the
  // worktree's own entry at all. The deepest Git directory containing the path
  // owns the change, exactly as the deepest working directory does for an
  // ordinary file.
  //
  // Every enclosing repository is told as well, classified by where the change
  // sits inside *its* Git directory — which says the right thing on its own: a
  // linked worktree's HEAD is `worktrees/<name>/HEAD` to the main repository,
  // and only its worktree list carries that, while a submodule's is
  // `modules/<name>/HEAD`, which does move the gitlink its status reports.
  changeContextsFor(changedPath, directoryPath) {
    const gitMatches = this.matchGitDirectories(directoryPath);
    if (gitMatches.length > 0) {
      return gitMatches.map(({ entry, relativePath }) => ({
        repository: entry.repository,
        gitRelativeDirectory: relativePath,
      }));
    }

    const repository = this.getForPath(changedPath);
    return repository ? [{ repository, gitRelativeDirectory: null }] : [];
  }

  // The registered entries whose Git directory contains a directory, deepest
  // first, each with that directory's "/"-joined path inside it (`""` for the
  // Git directory itself).
  //
  // Both sides are aliases captured during asynchronous discovery, so matching
  // a watcher batch remains purely lexical even when it holds thousands of
  // directories.
  matchGitDirectories(directoryPath) {
    const normalizedDirectory = normalizePath(directoryPath);
    return this.collectGitDirectoryMatches(normalizedDirectory);
  }

  collectGitDirectoryMatches(normalizedDirectory) {
    const matches = [];
    for (const entry of this.entriesById.values()) {
      if (entry.missing || entry.repository.isDestroyed?.()) continue;
      const ownedAliases = entry.gitDirectoryAliases.filter(
        (directory) => this.gitDirectoryOwners.get(directory) === entry,
      );
      const relativePath = relativeToAny(ownedAliases, normalizedDirectory);
      if (relativePath != null) matches.push({ entry, relativePath });
    }
    // A shorter relative path means a closer Git directory, so this puts the
    // owning repository first and its enclosing ones behind it.
    matches.sort((a, b) => a.relativePath.length - b.relativePath.length);
    return matches;
  }

  async discoverRepositoriesForFileChanges(events) {
    if (!this.config?.get("git.watchDiscovery")) return;

    const generation = this.scanGeneration;
    const watchDepth = this.config.get("git.watchDepth") ?? 1;
    const seen = new Set();
    let rootAliasesPromise = null;
    for (const event of events) {
      for (const candidatePath of [event.path, event.oldPath]) {
        if (!candidatePath || path.basename(candidatePath) !== ".git") continue;
        const candidateKey = normalizePath(candidatePath);
        if (seen.has(candidateKey)) continue;
        seen.add(candidateKey);

        const workingDirectory = path.dirname(candidatePath);
        const workingDirectoryAliases = await pathAliasesAsync(workingDirectory);
        rootAliasesPromise ||= Promise.all(
          this.rootPaths.map(async (rootPath) => ({
            rootPath,
            aliases: await pathAliasesAsync(rootPath),
          })),
        );
        const rootAliases = await rootAliasesPromise;
        if (this.destroyed || generation !== this.scanGeneration) return;
        // Measure the depth between aliases, never with a bare `path.relative`:
        // a root known by its long name against a watcher path carrying an 8.3
        // alias produces a `../..` chain out of the drive and back, which is
        // deeper than any watchDepth and silently drops the event.
        const rootPath = rootAliases.find(({ aliases }) =>
          aliases.some((rootAlias) =>
            workingDirectoryAliases.some((workingAlias) => {
              const relativePath = relativeToAny([rootAlias], workingAlias);
              return relativePath != null && pathDepth(relativePath) <= watchDepth;
            }),
          ),
        )?.rootPath;
        if (!rootPath) continue;

        let present = false;
        try {
          await fs.promises.stat(candidatePath);
          present = true;
        } catch {
          // A removed repository is handled below.
        }
        if (this.destroyed || generation !== this.scanGeneration) return;

        if (present) {
          if (this.automaticRepositoryLimitReached()) continue;
          const repository = await this.discoverForPath(workingDirectory, { refresh: true });
          if (this.destroyed || generation !== this.scanGeneration) {
            this.abandonDiscoveredRepository(repository, workingDirectory);
            return;
          }
          this.commitDiscoveredRepository(repository, workingDirectory);
          const entry = this.register(repository);
          if (
            this.destroyed ||
            generation !== this.scanGeneration ||
            !this.rootPaths.some(
              (candidate) => normalizePath(candidate) === normalizePath(rootPath),
            )
          ) {
            this.prune(entry);
            return;
          }
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
                routingChangedPrefixes: [...entry.routingDirectories],
              });
            }
          }
        } else {
          // Match the way routing does. A watcher reports whichever spelling the
          // OS handed it, and a registered repository knows its own — on Windows
          // an 8.3 alias against a long name, anywhere a symlinked root against
          // its target. Comparing the two lexically found nothing, so a deleted
          // `.git` left its repository registered and no consumer was told.
          const removedAliases = workingDirectoryAliases;
          const entry = Array.from(this.entriesById.values()).find((candidate) =>
            candidate.routingDirectories.some((directory) => removedAliases.includes(directory)),
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
                routingChangedPrefixes: [...entry.routingDirectories],
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
      generation: 0,
      resolvingGeneration: null,
      refreshGeneration: null,
      subscriptions: new CompositeDisposable(),
    };
    this.bufferOwners.set(buffer, owner);

    const applyRepository = (repository) => {
      const nextEntry = this.entryByRepository.get(repository) || null;
      const previousEntry = owner.entry;

      if (nextEntry === previousEntry) return;

      // Acquire the new lease before releasing the old one. Moving a buffer
      // between paths in the same repository must not cause destroy/add churn.
      if (nextEntry) nextEntry.bufferOwners.add(buffer);
      owner.entry = nextEntry;
      if (previousEntry) {
        previousEntry.bufferOwners.delete(buffer);
        // Let the remaining buffer path listeners finish before releasing the
        // previous repository lease.
        queueMicrotask(() => this.prune(previousEntry));
      }
    };
    const scheduleOwnerStatusRefresh = (generation = owner.generation) => {
      if (
        this.destroyed ||
        this.bufferOwners.get(buffer) !== owner ||
        generation !== owner.generation
      ) {
        return;
      }

      // A save can land while a new path is still being resolved. Defer it to
      // that resolution so only the authoritative owner is refreshed, never a
      // containing repository found by the fast lexical cache.
      if (owner.resolvingGeneration === generation) {
        owner.refreshGeneration = generation;
        return;
      }

      const repository = owner.entry?.repository;
      if (!repository || repository.isDestroyed?.()) return;
      repository.scheduleStatusSnapshotRefresh?.();
    };
    const update = ({ refreshStatus = false, discover = true } = {}) => {
      const generation = ++owner.generation;
      const bufferPath = buffer.getPath?.();
      owner.resolvingGeneration = bufferPath && discover ? generation : null;
      owner.refreshGeneration = refreshStatus && bufferPath ? generation : null;
      applyRepository(bufferPath ? this.getForPath(bufferPath) : null);
      if (!bufferPath || !discover) {
        if (owner.refreshGeneration === generation) {
          owner.refreshGeneration = null;
          scheduleOwnerStatusRefresh(generation);
        }
        return;
      }
      this.discoverForPath(bufferPath).then(
        (discovered) => {
          if (
            this.destroyed ||
            this.bufferOwners.get(buffer) !== owner ||
            generation !== owner.generation ||
            buffer.getPath?.() !== bufferPath
          ) {
            this.abandonDiscoveredRepository(discovered, bufferPath);
            return;
          }
          owner.resolvingGeneration = null;
          const refreshAfterResolution = owner.refreshGeneration === generation;
          this.commitDiscoveredRepository(discovered, bufferPath);
          const registered = this.register(discovered);
          if (generation !== owner.generation) {
            if (refreshAfterResolution) scheduleOwnerStatusRefresh(owner.generation);
            return;
          }
          const registeredRepository =
            registered && this.entriesById.get(registered.id) === registered
              ? registered.repository
              : null;
          const repository = this.getForPath(bufferPath) || registeredRepository;
          applyRepository(repository);
          if (owner.refreshGeneration === generation) {
            owner.refreshGeneration = null;
            scheduleOwnerStatusRefresh(generation);
          }
        },
        (error) => {
          if (generation === owner.generation) {
            owner.resolvingGeneration = null;
            owner.refreshGeneration = null;
          }
          console.error(`Unable to resolve Git repository for ${bufferPath}`, error);
        },
      );
    };
    owner.update = update;

    owner.subscriptions.add(
      buffer.onDidSave?.(() => scheduleOwnerStatusRefresh()) || new Disposable(),
      buffer.onDidReload?.(() => scheduleOwnerStatusRefresh()) || new Disposable(),
      buffer.onDidChangePath?.(() => update({ refreshStatus: true })) || new Disposable(),
      buffer.onDidDestroy?.(() => {
        owner.generation++;
        owner.resolvingGeneration = null;
        owner.refreshGeneration = null;
        const entry = owner.entry;
        if (entry) entry.bufferOwners.delete(buffer);
        owner.subscriptions.dispose();
        this.bufferOwners.delete(buffer);

        // Other buffer-destroy listeners must finish before releasing the
        // repository lease.
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
    if (known) {
      const { addedRoutingDirectories, displacedEntries } =
        this.synchronizeRepositoryRouting(known);
      if (emit && addedRoutingDirectories.length > 0) {
        this.emitChange({
          added: [],
          removed: [],
          updated: [repository, ...Array.from(displacedEntries, (entry) => entry.repository)],
          rootsAdded: [],
          rootsRemoved: [],
          routingChangedPrefixes: addedRoutingDirectories,
        });
      }
      for (const displaced of displacedEntries) this.prune(displaced);
      return known;
    }

    const repositoryWorkingDirectory = repository.getWorkingDirectory();
    const gitDirectory = repository.getPath?.() || null;
    const workingDirectory = repositoryWorkingDirectory || gitDirectory;
    if (!workingDirectory) return null;
    const id = this.repositoryId(repository, repositoryWorkingDirectory);
    const existing = this.entriesById.get(id);
    if (existing) return existing;

    const entry = {
      id,
      repository,
      workingDirectory,
      workingDirectories: Array.from(
        new Set(
          (
            repository.getWorkingDirectoryAliases?.() || [
              workingDirectory,
              repository.openedWorkingDirectoryPath,
            ]
          ).filter(Boolean),
        ),
      ),
      routingDirectories: Array.from(
        new Set(
          (
            repository.getWorkingDirectoryAliases?.() || [
              workingDirectory,
              repository.openedWorkingDirectoryPath,
            ]
          )
            .filter(Boolean)
            .flatMap(pathAliases),
        ),
      ),
      // Deliberately not in routingDirectories: that array decides which paths
      // *belong* to the repository, and a Git directory belongs to no working
      // tree. Adding it there would let a `.git`-only path claim root
      // ownership in repositoryRelatesToRoot.
      gitDirectoryAliases: Array.from(
        new Set(
          (repository.getGitDirectoryAliases?.() || [gitDirectory])
            .filter(Boolean)
            .flatMap(pathAliases),
        ),
      ),
      rootOwners: new Set(),
      pendingRootReconciliation: false,
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
      unavailableSubscription: null,
    };

    for (const rootPath of this.rootPaths) {
      if (this.repositoryRelatesToRoot(entry, rootPath)) entry.rootOwners.add(rootPath);
    }

    entry.destroySubscription = repository.onDidDestroy(() => {
      if (!entry.removing) this.removeEntry(entry, { destroy: false });
    });
    entry.unavailableSubscription =
      repository.onDidBecomeUnavailable?.(() => this.removeUnavailableEntry(entry)) ||
      new Disposable();

    this.entriesById.set(id, entry);
    this.entryByRepository.set(repository, entry);
    const displacedEntries = new Set();
    for (const directory of entry.routingDirectories) {
      const displaced = this.claimRoutingDirectory(entry, directory);
      if (displaced) displacedEntries.add(displaced);
    }
    for (const directory of entry.gitDirectoryAliases) {
      const displaced = this.claimGitDirectory(entry, directory);
      if (displaced) displacedEntries.add(displaced);
    }
    entry.operations = new RepositoryOperations(this, repository);
    repository.setOperations?.(entry.operations);

    if (emit) {
      entry.newlyRegistered = false;
      this.emitChange({
        added: [repository],
        removed: [],
        updated: Array.from(displacedEntries, (displaced) => displaced.repository),
        rootsAdded: [],
        rootsRemoved: [],
        routingChangedPrefixes: [...entry.routingDirectories, ...entry.gitDirectoryAliases],
      });
    }
    for (const displaced of displacedEntries) this.prune(displaced);

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
    const gitDirectory = repository.getPath?.() || workingDirectory;
    return `${normalizePath(workingDirectory || gitDirectory)}\0${normalizePath(gitDirectory)}`;
  }

  synchronizeRepositoryRouting(entry) {
    const directories = entry.repository.getWorkingDirectoryAliases?.() || [
      entry.workingDirectory,
      entry.repository.openedWorkingDirectoryPath,
    ];
    const addedRoutingDirectories = [];
    const displacedEntries = new Set();
    for (const directory of directories.filter(Boolean)) {
      if (!entry.workingDirectories.includes(directory)) entry.workingDirectories.push(directory);
      for (const alias of pathAliases(directory)) {
        if (!entry.routingDirectories.includes(alias)) {
          entry.routingDirectories.push(alias);
          addedRoutingDirectories.push(alias);
        }
        const displaced = this.claimRoutingDirectory(entry, alias);
        if (displaced) {
          displacedEntries.add(displaced);
          if (!addedRoutingDirectories.includes(alias)) addedRoutingDirectories.push(alias);
        }
      }
    }
    for (const directory of entry.repository.getGitDirectoryAliases?.() || []) {
      for (const alias of pathAliases(directory)) {
        if (!entry.gitDirectoryAliases.includes(alias)) {
          entry.gitDirectoryAliases.push(alias);
          addedRoutingDirectories.push(alias);
        }
        const displaced = this.claimGitDirectory(entry, alias);
        if (displaced) {
          displacedEntries.add(displaced);
          if (!addedRoutingDirectories.includes(alias)) addedRoutingDirectories.push(alias);
        }
      }
    }
    if (addedRoutingDirectories.length > 0) {
      for (const rootPath of this.rootPaths) {
        if (this.repositoryRelatesToRoot(entry, rootPath)) entry.rootOwners.add(rootPath);
      }
    }
    return { addedRoutingDirectories, displacedEntries };
  }

  claimRoutingDirectory(entry, directory) {
    const owner = this.routingDirectoryOwners.get(directory);
    if (owner === entry) return null;
    this.routingDirectoryOwners.set(directory, entry);
    if (!owner) return null;

    owner.routingDirectories = owner.routingDirectories.filter(
      (candidate) => candidate !== directory,
    );
    owner.repository.removeWorkingDirectoryAlias?.(directory);
    owner.rootOwners.clear();
    for (const rootPath of this.rootPaths) {
      if (this.repositoryRelatesToRoot(owner, rootPath)) owner.rootOwners.add(rootPath);
    }
    return owner;
  }

  claimGitDirectory(entry, directory) {
    const owner = this.gitDirectoryOwners.get(directory);
    if (owner === entry) return null;
    this.gitDirectoryOwners.set(directory, entry);
    if (!owner) return null;

    owner.gitDirectoryAliases = owner.gitDirectoryAliases.filter(
      (candidate) => candidate !== directory,
    );
    owner.repository.removeGitDirectoryAlias?.(directory);
    return owner;
  }

  hasRepository(repository) {
    return this.entryByRepository.has(repository);
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

  hasOwners(entry) {
    return (
      entry.rootOwners.size > 0 ||
      entry.pendingRootReconciliation ||
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

  removeUnavailableEntry(entry) {
    if (!entry || entry.removing || this.entriesById.get(entry.id) !== entry) return;
    entry.missing = true;
    entry.rootOwners.clear();
    entry.pendingRootReconciliation = false;
    // Ownership keeps a valid repository alive across root changes. Once its
    // storage itself has disappeared, every lease points at a stale descriptor,
    // so remove it unconditionally and let normal discovery create a new entry
    // if the checkout reappears elsewhere.
    this.removeEntry(entry, { destroy: true });
  }

  removeEntry(entry, { emit = true, destroy = false } = {}) {
    if (!entry || entry.removing || !this.entriesById.has(entry.id)) return;
    entry.removing = true;
    this.entriesById.delete(entry.id);
    for (const directory of entry.routingDirectories) {
      if (this.routingDirectoryOwners.get(directory) === entry) {
        this.routingDirectoryOwners.delete(directory);
      }
    }
    for (const directory of entry.gitDirectoryAliases) {
      if (this.gitDirectoryOwners.get(directory) === entry) {
        this.gitDirectoryOwners.delete(directory);
      }
    }
    entry.destroySubscription.dispose();
    entry.unavailableSubscription.dispose();
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
        routingChangedPrefixes: [...entry.routingDirectories, ...entry.gitDirectoryAliases],
      });
    }
  }

  emitChange(change) {
    if (this.destroyed) return;
    this.project?.invalidateRepositoryPathCache?.(change.routingChangedPrefixes);
    this.synchronizeConsumersForRoutingChange(change.routingChangedPrefixes);
    this.version++;
    const event = Object.freeze({ version: this.version, ...change });

    for (const repository of change.added) this.emitter.emit("did-add-repository", repository);
    for (const repository of change.removed) {
      this.emitter.emit("did-remove-repository", repository);
    }
    this.emitter.emit("did-change", event);
  }

  synchronizeConsumersForRoutingChange(prefixes) {
    const normalizedPrefixes = (prefixes || []).filter(Boolean).map(normalizePath);
    if (normalizedPrefixes.length === 0) return;
    const affected = (filePath) => {
      const normalizedPath = normalizePath(filePath);
      return normalizedPrefixes.some((prefix) => pathContainsNormalized(prefix, normalizedPath));
    };

    for (const [buffer, owner] of this.bufferOwners) {
      const bufferPath = buffer.getPath?.();
      if (bufferPath && affected(bufferPath)) owner.update?.({ discover: false });
    }

    if (!this.activeRepositoryPinned) {
      const item = this.workspace?.getCenter?.().getActivePaneItem?.();
      const itemPath = RepositoryRegistry.pathForPaneItem(item);
      if (itemPath && affected(itemPath)) {
        this.updateActiveRepositoryFromPaneItem(item, { discover: false });
      }
    }
  }
};

module.exports.pathContains = pathContains;
module.exports.pathDepth = pathDepth;
