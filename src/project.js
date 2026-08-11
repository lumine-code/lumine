const path = require("path");

const _ = require("@lumine-code/underscore-plus");
const fs = require("@lumine-code/fs-plus");
const { Emitter, Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const TextBuffer = require("./text-buffer");
const { watchPath } = require("./path-watcher");

const DefaultDirectoryProvider = require("./default-directory-provider");
const Model = require("./model");
const GitRepositoryProvider = require("./git-repository-provider");

/**
 * @public
 * @status extended
 *
 * Represents a project that's opened in Lumine.
 *
 * An instance of this class is always available as the `lumine.project` global.
 */
module.exports = class Project extends Model {
  /**
   * @category Construction and Destruction
   */

  constructor({
    notificationManager,
    packageManager,
    config,
    applicationDelegate,
    grammarRegistry,
    repositoryRegistry,
    restoreState,
  }) {
    super();
    this.notificationManager = notificationManager;
    this.applicationDelegate = applicationDelegate;
    this.grammarRegistry = grammarRegistry;
    this.config = config;
    // Built on first request; see {@link #fileIndexOrBuild}.
    this.fileIndex = null;
    // Supplied by the environment, which is the only thing that can reach the
    // window state store and the workspace. See {@link #setState}.
    this.restoreState = restoreState;

    this.emitter = new Emitter();
    this.buffers = [];
    this.rootDirectories = [];
    this.directoryProviders = [];
    this.defaultDirectoryProvider = new DefaultDirectoryProvider();
    this.repositoryPromisesByPath = new Map();
    this.repositoryProviders = [new GitRepositoryProvider(this, config)];
    if (!repositoryRegistry) throw new Error("Project requires a RepositoryRegistry");
    this.repositoryRegistry = repositoryRegistry;
    this.loadPromisesByPath = {};
    this.watcherPromisesByPath = {};
    this.retiredBufferIDs = new Set();
    this.retiredBufferPaths = new Set();
    this.subscriptions = new CompositeDisposable();
    this.repositoryRegistry.attachProject(this);
    this.consumeServices(packageManager);
  }

  destroyed() {
    for (let buffer of this.buffers.slice()) {
      buffer.destroy();
    }
    this.repositoryRegistry.detachProject(this);
    this.destroyFileIndex();
    for (let path in this.watcherPromisesByPath) {
      this.watcherPromisesByPath[path].then(
        (watcher) => {
          watcher.dispose();
        },
        () => {},
      );
    }
    this.rootDirectories = [];
  }

  reset(packageManager) {
    // Dropped rather than re-attached: a window that used the index once and was
    // then reset is back to paying nothing for it, and there is no long-lived
    // subscription to go stale against the emitter replaced below — the next
    // request rebuilds against the new one.
    this.destroyFileIndex();

    this.emitter.dispose();
    this.emitter = new Emitter();

    this.subscriptions.dispose();
    this.subscriptions = new CompositeDisposable();

    for (let buffer of this.buffers) {
      if (buffer != null) buffer.destroy();
    }
    this.buffers = [];
    // Specs may destroy the window's project and then reset it. Destroying
    // detached this project from the repository registry, so re-attach before
    // any root or buffer bookkeeping runs (attaching also resets the
    // registry's project subscriptions against the fresh emitter).
    if (!this.repositoryRegistry.destroyed) this.repositoryRegistry.attachProject(this);
    this.setPaths([]);
    this.loadPromisesByPath = {};
    this.retiredBufferIDs = new Set();
    this.retiredBufferPaths = new Set();
    this.consumeServices(packageManager);
  }

  destroyUnretainedBuffers() {
    for (let buffer of this.getBuffers()) {
      if (!buffer.isRetained()) buffer.destroy();
    }
  }

  // Layers the contents of a project's file's config
  // on top of the current global config.
  replace(projectSpecification) {
    if (projectSpecification == null) {
      lumine.config.clearProjectSettings();
      this.setPaths([]);
    } else {
      if (projectSpecification.originPath == null) {
        return;
      }

      // If no path is specified, set to directory of originPath.
      if (!Array.isArray(projectSpecification.paths)) {
        projectSpecification.paths = [path.dirname(projectSpecification.originPath)];
      }
      lumine.config.resetProjectSettings(
        projectSpecification.config,
        projectSpecification.originPath,
      );
      this.setPaths(projectSpecification.paths);
    }
    this.emitter.emit("did-replace", projectSpecification);
  }

  onDidReplace(callback) {
    return this.emitter.on("did-replace", callback);
  }

  /**
   * @category Serialization
   */

  deserialize(state) {
    this.retiredBufferIDs = new Set();
    this.retiredBufferPaths = new Set();

    const handleBufferState = (bufferState) => {
      if (bufferState.shouldDestroyOnFileDelete == null) {
        bufferState.shouldDestroyOnFileDelete = () =>
          lumine.config.get("core.closeDeletedFileTabs");
      }

      // Use a little guilty knowledge of the way TextBuffers are serialized.
      // This allows TextBuffers that have never been saved (but have filePaths) to be deserialized, but prevents
      // TextBuffers backed by files that have been deleted from being saved.
      bufferState.mustExist = bufferState.digestWhenLastPersisted !== false;

      return TextBuffer.deserialize(bufferState).catch((_) => {
        this.retiredBufferIDs.add(bufferState.id);
        this.retiredBufferPaths.add(bufferState.filePath);
        return null;
      });
    };

    const bufferPromises = [];
    for (let bufferState of state.buffers) {
      bufferPromises.push(handleBufferState(bufferState));
    }

    return Promise.all(bufferPromises).then((buffers) => {
      this.buffers = buffers.filter(Boolean);
      for (let buffer of this.buffers) {
        this.grammarRegistry.maintainLanguageMode(buffer);
        this.subscribeToBuffer(buffer);
      }
      this.setPaths(state.paths || [], { mustExist: true, exact: true });
    });
  }

  serialize(options = {}) {
    return {
      deserializer: "Project",
      paths: this.getPaths(),
      buffers: _.compact(
        this.buffers.map(function (buffer) {
          if (buffer.isRetained()) {
            const isUnloading = options.isUnloading === true;
            return buffer.serialize({
              markerLayers: isUnloading,
              history: isUnloading,
            });
          }
        }),
      ),
    };
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the project paths change.
   *
   * @param {Function} callback - to be called after the project paths change.
   * @param callback.projectPaths - An `Array` of `String` project paths.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangePaths(callback) {
    return this.emitter.on("did-change-paths", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when a text buffer is added to the
   * project.
   *
   * @param {Function} callback - to be called when a text buffer is added.
   * @param callback.buffer - A {@link TextBuffer} item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddBuffer(callback) {
    return this.emitter.on("did-add-buffer", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback with all current and future text
   * buffers in the project.
   *
   * @param {Function} callback - to be called with current and future text buffers.
   * @param callback.buffer - A {@link TextBuffer} item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeBuffers(callback) {
    for (let buffer of this.getBuffers()) {
      callback(buffer);
    }
    return this.onDidAddBuffer(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke a callback when a filesystem change occurs within any open
   * project path.
   *
   * ```js
   * const disposable = lumine.project.onDidChangeFiles(events => {
   *   for (const event of events) {
   *     // "created", "updated", or "deleted"
   *     console.log(`Event action: ${event.action}`)
   *
   *     // absolute path to the filesystem entry that was touched
   *     console.log(`Event path: ${event.path}`)
   *   }
   * })
   *
   * disposable.dispose()
   * ```
   *
   * Project roots are watched recursively, and the recursive backend reports a
   * move as a `"deleted"` followed by a `"created"` — it never emits
   * `"renamed"` and never sets `oldPath`. Handle the move as the two events it
   * arrives as; a `"renamed"` branch written against this method is dead code.
   * Only the non-recursive watchers behind {@link PathWatcher} report renames.
   *
   * Paths are absolute and spelled the way the root was registered, matching
   * {@link #getPaths} and {@link #relativizePath}, so an event path can be
   * compared against a stored one directly.
   *
   * To watch paths outside of open projects, use the `watchPaths` function instead; see {@link PathWatcher}.
   *
   * When writing tests against functionality that uses this method, be sure to wait for the
   * `Promise` returned by {@link #getWatcherPromise} before manipulating the filesystem to ensure that
   * the watcher is receiving events.
   *
   * @param {Function} callback - to be called with batches of filesystem events reported by the operating system.
   * @param callback.events - An `Array` of objects that describe a batch of filesystem events.
   * @param {String} callback.events.action - describing the filesystem action that occurred. One of `"created"`, `"updated"`, or `"deleted"`.
   * @param {String} callback.events.path - containing the absolute path to the filesystem entry that was acted upon.
   * @returns {Disposable} to manage this event subscription.
   */
  onDidChangeFiles(callback) {
    return this.emitter.on("did-change-files", callback);
  }

  /**
   * @category Accessing the git repository
   */

  /**
   * @public
   * @status public
   *
   * Get the repository for a given directory asynchronously.
   *
   *
   * * `null` if no repository can be created for the given directory.
   *
   * @param {Directory} directory - for which to get a {@link GitRepository}.
   * @returns {Promise} that resolves with either: * {@link GitRepository} if a repository can be created for the given directory
   */
  repositoryForDirectory(directory) {
    return this.repositoryRegistry.resolveDirectory(directory);
  }

  /**
   * @public
   * @status public
   *
   * Get the repository that contains a given file or directory path
   * asynchronously.
   *
   * This is a convenience over {@link #repositoryForDirectory} for callers that have
   * a path `String` rather than a `Directory`. The path is resolved to its
   * containing `Directory` (a file path resolves to its parent directory), so
   * callers no longer need to construct a `Directory` themselves.
   *
   *
   * * `null` if no repository can be created for the given path.
   *
   * @param {String} filePath - path of a file or directory.
   * @returns {Promise} that resolves with either: * {@link GitRepository} if a repository can be created for the given path
   */
  repositoryForPath(filePath) {
    if (!filePath) return Promise.resolve(null);
    return this.repositoryForDirectory(this.getDirectoryForProjectPath(filePath));
  }

  repositoryForDirectoryFromProviders(directory) {
    const pathForDirectory = directory.getRealPathSync();
    let promise = this.repositoryPromisesByPath.get(pathForDirectory);
    if (!promise) {
      const promises = this.repositoryProviders.map((provider) =>
        provider.repositoryForDirectory(directory),
      );
      promise = Promise.all(promises).then((repositories) => {
        const repo = repositories.find((repo) => repo != null) || null;

        // If no repository is found, remove the entry for the directory in
        // @repositoryPromisesByPath in case some other RepositoryProvider is
        // registered in the future that could supply a Repository for the
        // directory.
        if (repo == null) this.repositoryPromisesByPath.delete(pathForDirectory);

        if (repo && repo.onDidDestroy) {
          repo.onDidDestroy(() => this.repositoryPromisesByPath.delete(pathForDirectory));
        }

        return repo;
      });
      this.repositoryPromisesByPath.set(pathForDirectory, promise);
    }
    return promise;
  }

  repositoryForDirectoryFromProvidersSync(directory) {
    for (const provider of this.repositoryProviders) {
      const repository = provider.repositoryForDirectorySync?.(directory);
      if (repository) return repository;
    }
    return null;
  }

  /**
   * @category Managing Paths
   */

  /**
   * @public
   * @status public
   *
   * Get an `Array` of `Strings` containing the paths of the project's
   * directories.
   */
  getPaths() {
    try {
      return this.rootDirectories.map((rootDirectory) => rootDirectory.getPath());
    } catch {
      lumine.notifications.addError(
        "Please clear Lumine's window state with: lumine --clear-window-state",
      );
    }
  }

  /**
   * @public
   * @status public
   *
   * Set the paths of the project's directories.
   *
   * @param {Array} projectPaths - of `String` paths.
   * @param options - An optional `Object` that may contain the following keys:
   * @param options.mustExist - If `true`, throw an Error if any `projectPaths` do not exist. Any remaining `projectPaths` that do exist will still be added to the project. Default: `false`.
   * @param options.exact - If `true`, only add a `projectPath` if it names an existing directory. If `false` and any `projectPath` is a file or does not exist, its parent directory will be added instead. Default: `false`.
   */
  setPaths(projectPaths, options = {}) {
    this.rootDirectories = [];

    for (let path in this.watcherPromisesByPath) {
      this.watcherPromisesByPath[path].then(
        (watcher) => {
          watcher.dispose();
        },
        () => {},
      );
    }
    this.watcherPromisesByPath = {};

    const missingProjectPaths = [];
    for (let projectPath of projectPaths) {
      try {
        this.addPath(projectPath, {
          emitEvent: false,
          reconcileRepositories: false,
          mustExist: true,
          exact: options.exact === true,
        });
      } catch (e) {
        if (e.missingProjectPaths != null) {
          missingProjectPaths.push(...e.missingProjectPaths);
        } else {
          throw e;
        }
      }
    }

    this.repositoryRegistry.setProjectRoots(this.rootDirectories);
    this.emitter.emit("did-change-paths", projectPaths);

    if (options.mustExist === true && missingProjectPaths.length > 0) {
      const err = new Error("One or more project directories do not exist");
      err.missingProjectPaths = missingProjectPaths;
      throw err;
    }
  }

  /**
   * @public
   * @status public
   *
   * Open a different project in this window.
   *
   *
   * Where {@link #setPaths} changes the folders and leaves everything else alone —
   * so the editors open on the old project stay open on the new one — this
   * changes the whole state: the current folders and the editors open on them
   * are saved together, and whatever was last saved for `projectPaths` is
   * restored in their place. No new window is opened, so packages, themes and
   * grammars stay loaded.
   *
   * Only the workspace center is restored. Docks belong to the window rather
   * than to the project it has open, so a tree view, a terminal or a panel
   * keeps running across the change — as does anything a package put there.
   *
   * Three things are worth knowing before reaching for this:
   *
   * * Development and safe mode belong to the window, so they cannot change
   *   here. Use `LumineEnvironment.open` with `newWindow` for those.
   * * State is keyed by the set of folders, so a project already open in
   *   another window shares one saved state with it and the last window to
   *   save wins.
   * * Package state is not re-applied. A package that follows the project
   *   observes {@link #onDidChangePaths} and rebuilds itself.
   *
   * @param {Array} projectPaths - of `String` paths to the directories the window should have open.
   * @returns {Promise} that resolves to `true` once the new state is in place, or to `false` if the window was left as it was — because the paths were already open, none was given, or the user cancelled at the save prompt.
   */
  async setState(projectPaths) {
    // A project built outside an environment has no window state to set.
    if (!this.restoreState) return false;
    return this.restoreState(projectPaths);
  }

  /**
   * @public
   * @status public
   *
   * Add a path to the project's list of root paths
   *
   * @param {String} projectPath - The path to the directory to add.
   * @param options - An optional `Object` that may contain the following keys:
   * @param options.mustExist - If `true`, throw an Error if the `projectPath` does not exist. If `false`, a `projectPath` that does not exist is ignored. Default: `false`.
   * @param options.exact - If `true`, only add `projectPath` if it names an existing directory. If `false`, if `projectPath` is a a file or does not exist, its parent directory will be added instead.
   */
  addPath(projectPath, options = {}) {
    const directory = this.getDirectoryForProjectPath(projectPath);
    let ok = true;
    if (options.exact === true) {
      ok = directory.getPath() === projectPath;
    }
    ok = ok && directory.existsSync();

    if (!ok) {
      if (options.mustExist === true) {
        const err = new Error(`Project directory ${directory} does not exist`);
        err.missingProjectPaths = [projectPath];
        throw err;
      } else {
        return;
      }
    }

    for (let existingDirectory of this.getDirectories()) {
      if (existingDirectory.getPath() === directory.getPath()) {
        return;
      }
    }

    this.rootDirectories.push(directory);

    const didChangeCallback = (events) => {
      // Stop event delivery immediately on removal of a rootDirectory, even if its watcher
      // promise has yet to resolve at the time of removal
      if (this.rootDirectories.includes(directory)) {
        this.emitter.emit("did-change-files", events);
      }
    };

    // We'll use the directory's custom onDidChangeFiles callback, if available.
    // CustomDirectory::onDidChangeFiles should match the signature of
    // Project::onDidChangeFiles below (although it may resolve asynchronously)
    //
    // `realPaths: false` so events come back spelled the way the root was
    // registered. A watcher resolves its root with `fs.realpath` and would
    // otherwise report a symlinked root's files under the link's target, and on
    // Windows an 8.3 alias under its long name — while `getPaths()`,
    // `getDirectories()` and `relativizePath()` all speak the registered
    // spelling. Nothing else reconciles the two, so every consumer comparing an
    // event path against a path it stored got this subtly wrong.
    const watcherPromise =
      directory.onDidChangeFiles != null
        ? Promise.resolve(directory.onDidChangeFiles(didChangeCallback))
        : watchPath(directory.getPath(), { realPaths: false }, didChangeCallback);
    // A watch that fails to arm (root deleted mid-arm, watcher-worker restart)
    // must not surface as an unhandled rejection attributed to unrelated work;
    // consumers still observe the failure through getWatcherPromise.
    watcherPromise.catch(() => {});
    this.watcherPromisesByPath[directory.getPath()] = watcherPromise;

    for (let watchedPath in this.watcherPromisesByPath) {
      if (!this.rootDirectories.find((dir) => dir.getPath() === watchedPath)) {
        this.watcherPromisesByPath[watchedPath].then(
          (watcher) => {
            watcher.dispose();
          },
          () => {},
        );
      }
    }

    if (options.reconcileRepositories !== false) {
      this.repositoryRegistry.setProjectRoots(this.rootDirectories);
    }

    if (options.emitEvent !== false) {
      this.emitter.emit("did-change-paths", this.getPaths());
    }
  }

  /**
   * @public
   * @status public
   *
   * Add multiple paths to the project's list of root paths,
   * emitting a single `did-change-paths` event after all paths are added.
   *
   * @param projectPaths - An `Array` of `String` paths to add.
   * @param options - An optional `Object` passed to {@link #addPath} for each path.
   */
  addPaths(projectPaths, options = {}) {
    const pathsBefore = this.getPaths().length;
    for (const projectPath of projectPaths) {
      this.addPath(projectPath, {
        ...options,
        emitEvent: false,
        reconcileRepositories: false,
      });
    }
    if (this.getPaths().length !== pathsBefore) {
      this.repositoryRegistry.setProjectRoots(this.rootDirectories);
      this.emitter.emit("did-change-paths", this.getPaths());
    }
  }

  getProvidedDirectoryForProjectPath(projectPath) {
    for (let provider of this.directoryProviders) {
      if (typeof provider.directoryForURISync === "function") {
        const directory = provider.directoryForURISync(projectPath);
        if (directory) {
          return directory;
        }
      }
    }
    return null;
  }

  getDirectoryForProjectPath(projectPath) {
    let directory = this.getProvidedDirectoryForProjectPath(projectPath);
    if (directory == null) {
      directory = this.defaultDirectoryProvider.directoryForURISync(projectPath);
    }
    return directory;
  }

  /**
   * @public
   * @status extended
   *
   * Access a `Promise` that resolves when the filesystem watcher associated with a project
   * root directory is ready to begin receiving events.
   *
   * This is especially useful in test cases, where it's important to know that the watcher is
   * ready before manipulating the filesystem to produce events.
   *
   * @param {String} projectPath - One of the project's root directories.
   * @returns {Promise} that resolves with the {@link PathWatcher} associated with this project root once it has initialized and is ready to start sending events. The Promise will reject with an error instead if `projectPath` is not currently a root directory.
   */
  getWatcherPromise(projectPath) {
    return (
      this.watcherPromisesByPath[projectPath] ||
      Promise.reject(new Error(`${projectPath} is not a project root`))
    );
  }

  /**
   * @public
   * @status public
   *
   * remove a path from the project's list of root paths.
   *
   * @param {String} projectPath - The path to remove.
   */
  removePath(projectPath) {
    // The projectPath may be a URI, in which case it should not be normalized.
    if (!this.getPaths().includes(projectPath)) {
      projectPath = this.defaultDirectoryProvider.normalizePath(projectPath);
    }

    let indexToRemove = null;
    for (let i = 0; i < this.rootDirectories.length; i++) {
      const directory = this.rootDirectories[i];
      if (directory.getPath() === projectPath) {
        indexToRemove = i;
        break;
      }
    }

    if (indexToRemove != null) {
      this.rootDirectories.splice(indexToRemove, 1);
      if (this.watcherPromisesByPath[projectPath] != null) {
        this.watcherPromisesByPath[projectPath].then(
          (w) => w.dispose(),
          () => {},
        );
      }
      delete this.watcherPromisesByPath[projectPath];
      this.repositoryRegistry.setProjectRoots(this.rootDirectories);
      this.emitter.emit("did-change-paths", this.getPaths());
      return true;
    } else {
      return false;
    }
  }

  /**
   * @public
   * @status public
   *
   * Get an `Array` of `Directorys` associated with this project.
   */
  getDirectories() {
    return this.rootDirectories;
  }

  resolvePath(uri) {
    if (!uri) {
      return;
    }

    if (uri.match(/[A-Za-z0-9+-.]+:\/\//)) {
      // leave path alone if it has a scheme
      return uri;
    } else {
      let projectPath;
      if (fs.isAbsolute(uri)) {
        return this.defaultDirectoryProvider.normalizePath(fs.resolveHome(uri));
        // TODO: what should we do here when there are multiple directories?
      } else if ((projectPath = this.getPaths()[0])) {
        return this.defaultDirectoryProvider.normalizePath(
          fs.resolveHome(path.join(projectPath, uri)),
        );
      } else {
        return undefined;
      }
    }
  }

  relativize(fullPath) {
    return this.relativizePath(fullPath)[1];
  }

  /**
   * @public
   * @status public
   *
   * Get the path to the project directory that contains the given path,
   * and the relative path from that project directory to the given path.
   *
   *
   * * `projectPath` The `String` path to the project directory that contains the
   *   given path, or `null` if none is found.
   * * `relativePath` `String` The relative path from the project directory to
   *   the given path.
   *
   * @param {String} fullPath - An absolute path.
   * @returns {Array} with two elements:
   */
  relativizePath(fullPath) {
    let result = [null, fullPath];
    if (fullPath != null) {
      for (let rootDirectory of this.rootDirectories) {
        const relativePath = rootDirectory.relativize(fullPath);
        if (relativePath != null && relativePath.length < result[1].length) {
          result = [rootDirectory.getPath(), relativePath];
        }
      }
    }
    return result;
  }

  /**
   * @public
   * @status public
   *
   * Determines whether the given path (real or symbolic) is inside the
   * project's directory.
   *
   * This method does not actually check if the path exists, it just checks their
   * locations relative to each other.
   *
   * ## Examples
   *
   * Basic operation
   *
   * ```js
   * // Project's root directory is /foo/bar
   * project.contains('/foo/bar/baz')        // => true
   * project.contains('/usr/lib/baz')        // => false
   * ```
   *
   * Existence of the path is not required
   *
   * ```js
   * // Project's root directory is /foo/bar
   * fs.existsSync('/foo/bar/baz')           // => false
   * project.contains('/foo/bar/baz')        // => true
   * ```
   *
   * @param {String} pathToCheck - path
   * @returns {Boolean} whether the path is inside the project's root directory.
   */
  contains(pathToCheck) {
    return this.rootDirectories.some((dir) => dir.contains(pathToCheck));
  }

  /**
   * @category Crawling files
   */

  /**
   * @public
   * @status public
   *
   * Lists the files under the project's directories.
   *
   * The crawl runs in a separate process (the bundled ripgrep binary), honors
   * `.gitignore` unless told otherwise, and streams results as it finds them
   * rather than resolving with one large array. Prefer it over walking the
   * filesystem yourself: `core.ignoredNames` and `core.excludeVcsIgnoredPaths`
   * are respected here in one place.
   *
   * ```js
   * const crawl = lumine.project.crawl({
   *   didFindPaths: (paths) => results.push(...paths),
   * });
   * await crawl;
   * ```
   *
   * @param {Object} [options]
   * @param {Function} options.didFindPaths - called with an `Array` of absolute paths as they are found. Called several times over the life of one crawl.
   * @param options.directoryPaths - an `Array` of `String` paths to crawl. Defaults to the project's root directories.
   * @param {String} options.inclusion - glob scoping the crawl. `**` means "everything".
   * @param options.ignoredNames - an `Array` of `String` globs to exclude. Defaults to `core.ignoredNames`.
   * @param {Boolean} options.followSymlinks - whether to descend into symlinked directories. Defaults to `core.followSymlinks`.
   * @param {Boolean} options.excludeVcsIgnoredPaths - whether to honor VCS ignore files. Defaults to `core.excludeVcsIgnoredPaths`. Only takes effect inside a repository — a directory with no `.git` above it lists everything.
   * @param {Boolean} options.sort - whether to return paths in a stable order. Costs ripgrep its parallel walk, so only ask when the order is observable.
   * @returns {Promise} with a `cancel()` method that resolves the crawl early.
   */
  crawl(options = {}) {
    if (!this.fileCrawler) {
      const RipgrepFileCrawler = require("./ripgrep-file-crawler");
      this.fileCrawler = new RipgrepFileCrawler();
    }

    const config = lumine.config;
    const directoryPaths = options.directoryPaths ?? this.getPaths() ?? [];

    return this.fileCrawler.crawl(directoryPaths, {
      didFindPaths: options.didFindPaths,
      inclusion: options.inclusion,
      ignoredNames: options.ignoredNames ?? config.get("core.ignoredNames") ?? [],
      followSymlinks: options.followSymlinks ?? config.get("core.followSymlinks"),
      excludeVcsIgnoredPaths:
        options.excludeVcsIgnoredPaths ?? config.get("core.excludeVcsIgnoredPaths"),
      sort: options.sort,
    });
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback with the project's file paths, now and whenever
   * they change.
   *
   * Where {@link #crawl} answers "what is there right now" once, the file index
   * keeps the answer, streams it as it arrives, and maintains it against the
   * filesystem watcher. Prefer these methods over crawling on a timer or
   * rebuilding on {@link #onDidChangeFiles} by hand: a package that does either
   * is reimplementing this one, and the ignore semantics are easy to get subtly
   * wrong.
   *
   * The first call is synchronous and reports everything currently indexed as
   * `added`, so a consumer has exactly one code path: apply `removed`, then
   * apply `added`.
   *
   * ```js
   * const disposable = lumine.project.observeFilePaths(({ added, removed, indexing }) => {
   *   for (const filePath of removed) this.items.delete(filePath);
   *   for (const filePath of added) this.items.set(filePath, this.build(filePath));
   *   this.setLoading(indexing);
   * });
   * ```
   *
   * Changes are coalesced, so one call can carry a whole batch, and during the
   * first crawl the callback fires repeatedly with partial results — check
   * `indexing` rather than assuming the first call is complete. A deleted
   * directory reports every file that was under it, so no consumer needs its own
   * prefix sweep.
   *
   * The whole-index array is deliberately not passed: rebuilding derived state
   * from it on every call is quadratic over a progressive crawl. Call
   * {@link #getFilePaths} if you want it — that is memoized, so asking on every
   * callback costs nothing extra.
   *
   * @param {Function} callback - to be called with each batch of changes.
   * @param callback.added - An `Array` of `String` absolute paths new to the index.
   * @param callback.removed - An `Array` of `String` absolute paths no longer in it.
   * @param callback.indexing - A `Boolean`, `true` while a crawl is still running.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeFilePaths(callback) {
    return this.fileIndexOrBuild().observe(callback);
  }

  /**
   * @public
   * @status public
   *
   * Every file under the project's root directories.
   *
   * Files only, and project roots only — for a glob subset, a directory listing,
   * or anywhere outside the project, use {@link #crawl}. The index applies core
   * policy only (`core.ignoredNames`, `core.excludeVcsIgnoredPaths`,
   * `core.followSymlinks`), so it is a superset of what any one consumer wants
   * and a package's own exclusions stay a cheap filter over it.
   *
   * Paths are absolute and spelled from the registered root, matching
   * {@link #getPaths} and {@link #relativizePath}. They are not sorted: sorting
   * costs the crawl its parallel walk, and only one consumer has ever observed
   * the order, so it sorts for itself.
   *
   * The array is memoized and shared, rebuilt only when the index changes.
   * **Do not mutate it** — like {@link #getDirectories}, this hands back the
   * index's own array rather than copying six figures' worth of strings per call.
   *
   * The first call to any file-path method builds the index and starts the
   * crawl, so this returns an empty array until that settles; see
   * {@link #isIndexing}. Ask when the feature that needs it is first used rather
   * than during package activation, or the crawl happens in every window whether
   * anything wanted it or not.
   *
   * @returns {Array} of `String` absolute paths.
   */
  getFilePaths() {
    return this.fileIndexOrBuild().getPaths();
  }

  /**
   * @public
   * @status public
   *
   * Every indexed file under one project root.
   *
   * A file reachable through two nested roots is listed under both, because each
   * root is crawled independently. Memoized and shared on the same terms as
   * {@link #getFilePaths}.
   *
   * @param {String|Directory} root - a project root path, or its `Directory`.
   * @returns {Array} of `String` absolute paths, empty for a path that is not a project root.
   */
  getFilePathsForRoot(root) {
    return this.fileIndexOrBuild().getPathsForRoot(root);
  }

  /**
   * @public
   * @status public
   *
   * Whether a path is in the file index.
   *
   * Constant time, where scanning {@link #getFilePaths} is not. The path must be
   * spelled the way the index spells it: absolute, from the registered root.
   *
   * This is a different question from {@link #contains}, which asks only whether
   * a path lies under a root and answers for a file that is ignored, or that
   * does not exist at all.
   *
   * @param {String} filePath - an absolute path.
   * @returns {Boolean}
   */
  hasFilePath(filePath) {
    return this.fileIndexOrBuild().has(filePath);
  }

  /**
   * @public
   * @status public
   *
   * How many files are indexed.
   *
   * Cheaper than `getFilePaths().length`, which materializes the array.
   *
   * @returns {Number}
   */
  getFilePathCount() {
    return this.fileIndexOrBuild().getPathCount();
  }

  /**
   * @public
   * @status public
   *
   * Whether the file index is crawling.
   *
   * True for the first crawl and for every later refresh alike, so a spinner
   * driven by this shows during background reindexing too.
   *
   * @returns {Boolean}
   */
  isIndexing() {
    return this.fileIndexOrBuild().isIndexing();
  }

  /**
   * @public
   * @status public
   *
   * Crawl the project again and update the file index.
   *
   * Rarely needed: the index follows {@link #onDidChangeFiles} and re-crawls a
   * root by itself when the evidence says it must. Reach for this to back a
   * user-facing "reindex" command, or after changing something on disk that the
   * watcher cannot see. The index is shared, so this re-crawls for every
   * consumer, not just the caller.
   *
   * Existing contents stay readable and are replaced when the crawl completes,
   * so a refresh does not empty a list the user is looking at.
   *
   * @param {Object} [options]
   * @param options.rootPaths - An `Array` of `String` roots to re-crawl. Defaults to all of them.
   * @returns {Promise} that resolves when the crawl settles.
   */
  refreshFilePaths(options = {}) {
    return this.fileIndexOrBuild().refresh(options);
  }

  /**
   * @category Private
   */

  // The file index, built and started on first request. A window where no
  // package asks for a file path constructs nothing, subscribes to nothing and
  // crawls nothing — so every consumer must ask when its feature is first used
  // rather than during activation, or the laziness is defeated for everyone.
  fileIndexOrBuild() {
    if (!this.fileIndex) {
      // Deferred like the crawler above, to keep it out of the startup snapshot.
      const FileIndex = require("./file-index");
      this.fileIndex = new FileIndex({ config: this.config });
      this.fileIndex.attachProject(this);
    }
    return this.fileIndex;
  }

  destroyFileIndex() {
    if (!this.fileIndex) return;
    this.fileIndex.destroy();
    this.fileIndex = null;
  }

  consumeServices({ serviceHub }) {
    serviceHub.consume("project.directory-provider", "^1.0.0", (provider) => {
      this.directoryProviders.unshift(provider);
      return new Disposable(() => {
        return this.directoryProviders.splice(this.directoryProviders.indexOf(provider), 1);
      });
    });

    return serviceHub.consume("project.repository-provider", "^1.0.0", (provider) => {
      this.repositoryProviders.unshift(provider);
      this.repositoryPromisesByPath.clear();
      this.repositoryRegistry.rescan();
      return new Disposable(() => {
        this.repositoryPromisesByPath.clear();
        return this.repositoryProviders.splice(this.repositoryProviders.indexOf(provider), 1);
      });
    });
  }

  // Retrieves all the {@link TextBuffer TextBuffers} in the project; that is, the
  // buffers for all open files.
  //
  // Returns an `Array` of {@link TextBuffer TextBuffers}.
  getBuffers() {
    return this.buffers.slice();
  }

  // Is the buffer for the given path modified?
  isPathModified(filePath) {
    const bufferForPath = this.findBufferForPath(this.resolvePath(filePath));
    return bufferForPath && bufferForPath.isModified();
  }

  findBufferForPath(filePath) {
    return _.find(this.buffers, (buffer) => buffer.getPath() === filePath);
  }

  findBufferForId(id) {
    return _.find(this.buffers, (buffer) => buffer.getId() === id);
  }

  // Only to be used in specs
  bufferForPathSync(filePath) {
    const absoluteFilePath = this.resolvePath(filePath);
    if (this.retiredBufferPaths.has(absoluteFilePath)) {
      return null;
    }

    let existingBuffer;
    if (filePath) {
      existingBuffer = this.findBufferForPath(absoluteFilePath);
    }
    return existingBuffer != null ? existingBuffer : this.buildBufferSync(absoluteFilePath);
  }

  // Only to be used when deserializing
  bufferForIdSync(id) {
    if (this.retiredBufferIDs.has(id)) {
      return null;
    }

    let existingBuffer;
    if (id) {
      existingBuffer = this.findBufferForId(id);
    }
    return existingBuffer != null ? existingBuffer : this.buildBufferSync();
  }

  // Given a file path, this retrieves or creates a new {@link TextBuffer}.
  //
  // If the `filePath` already has a `buffer`, that value is used instead. Otherwise,
  // `text` is used as the contents of the new buffer.
  //
  // * `filePath` A `String` representing a path. If `null`, an "Untitled" buffer is created.
  //
  // Returns a `Promise` that resolves to the {@link TextBuffer}.
  bufferForPath(absoluteFilePath) {
    let existingBuffer;
    if (absoluteFilePath != null) {
      existingBuffer = this.findBufferForPath(absoluteFilePath);
    }
    if (existingBuffer) {
      return Promise.resolve(existingBuffer);
    } else {
      return this.buildBuffer(absoluteFilePath);
    }
  }

  shouldDestroyBufferOnFileDelete() {
    return lumine.config.get("core.closeDeletedFileTabs");
  }

  // Still needed when deserializing a tokenized buffer
  buildBufferSync(absoluteFilePath) {
    const params = {
      shouldDestroyOnFileDelete: this.shouldDestroyBufferOnFileDelete,
    };

    let buffer;
    if (absoluteFilePath != null) {
      buffer = TextBuffer.loadSync(absoluteFilePath, params);
    } else {
      buffer = new TextBuffer(params);
    }
    this.addBuffer(buffer);
    return buffer;
  }

  // Given a file path, this sets its {@link TextBuffer}.
  //
  // * `absoluteFilePath` A `String` representing a path.
  // * `text` The `String` text to use as a buffer.
  //
  // Returns a `Promise` that resolves to the {@link TextBuffer}.
  async buildBuffer(absoluteFilePath) {
    const params = {
      shouldDestroyOnFileDelete: this.shouldDestroyBufferOnFileDelete,
    };

    let buffer;
    if (absoluteFilePath != null) {
      if (this.loadPromisesByPath[absoluteFilePath] == null) {
        this.loadPromisesByPath[absoluteFilePath] = TextBuffer.load(absoluteFilePath, params)
          .then((result) => {
            delete this.loadPromisesByPath[absoluteFilePath];
            return result;
          })
          .catch((error) => {
            delete this.loadPromisesByPath[absoluteFilePath];
            throw error;
          });
      }
      buffer = await this.loadPromisesByPath[absoluteFilePath];
    } else {
      buffer = new TextBuffer(params);
    }

    this.grammarRegistry.autoAssignLanguageMode(buffer);

    this.addBuffer(buffer);
    return buffer;
  }

  addBuffer(buffer, _options = {}) {
    this.buffers.push(buffer);
    this.subscriptions.add(this.grammarRegistry.maintainLanguageMode(buffer));
    this.subscribeToBuffer(buffer);
    this.emitter.emit("did-add-buffer", buffer);
    return buffer;
  }

  // Removes a {@link TextBuffer} association from the project.
  //
  // Returns the removed {@link TextBuffer}.
  removeBuffer(buffer) {
    const index = this.buffers.indexOf(buffer);
    if (index !== -1) {
      return this.removeBufferAtIndex(index);
    }
  }

  removeBufferAtIndex(index, _options = {}) {
    const [buffer] = this.buffers.splice(index, 1);
    return buffer != null ? buffer.destroy() : undefined;
  }

  eachBuffer(...args) {
    let subscriber;
    if (args.length > 1) {
      subscriber = args.shift();
    }
    const callback = args.shift();

    for (let buffer of this.getBuffers()) {
      callback(buffer);
    }
    if (subscriber) {
      return subscriber.subscribe(this, "buffer-created", (buffer) => callback(buffer));
    } else {
      return this.on("buffer-created", (buffer) => callback(buffer));
    }
  }

  subscribeToBuffer(buffer) {
    buffer.onWillSave(async ({ path }) => this.applicationDelegate.emitWillSavePath(path));
    buffer.onDidSave(({ path }) => this.applicationDelegate.emitDidSavePath(path));
    buffer.onDidDestroy(() => this.removeBuffer(buffer));
    buffer.onDidChangePath(() => {
      if (!(this.getPaths().length > 0)) {
        this.setPaths([path.dirname(buffer.getPath())]);
      }
    });
    buffer.onWillThrowWatchError(({ error, handle }) => {
      handle();
      const message =
        `Unable to read file after file \`${error.eventType}\` event.` +
        `Make sure you have permission to access \`${buffer.getPath()}\`.`;
      this.notificationManager.addWarning(message, {
        detail: error.message,
        dismissable: true,
      });
    });
  }
};
