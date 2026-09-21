const path = require("path");
let normalizePackageData = null;

const _ = require("@lumine-code/underscore-plus");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const fs = require("@lumine-code/fs-plus");
const CSON = require("@lumine-code/season");
const ServiceHub = require("./service-hub");
const ActivationHooks = require("./activation-hooks");
const Package = require("./package");
const ThemePackage = require("./theme-package");
const { scanBundledPackageNames } = require("./bundled-packages");
const packageJSON = require("../package.json");

// Resolves true if `promise` settles within `ms`, false if it is still pending
// then. The timer is always cleared: a pending one keeps the process alive, and
// the caller here is trying to let the window go.
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).then((settled) => {
    clearTimeout(timer);
    return settled;
  });
}

class PackageActivationCancelledError extends Error {
  constructor(packageName) {
    super(`Activation of package '${packageName}' was cancelled`);
    this.name = "PackageActivationCancelledError";
    this.code = "PACKAGE_ACTIVATION_CANCELLED";
    this.packageName = packageName;
  }
}

/**
 * @public
 * @status extended
 *
 * Package manager for coordinating the lifecycle of Lumine packages.
 *
 * An instance of this class is always available as the `lumine.packages` global.
 *
 * Packages can be loaded, activated, and deactivated, and unloaded:
 *  * Loading a package reads and parses the package's metadata and resources
 *    such as keymaps, menus, stylesheets, etc.
 *  * Activating a package registers the loaded resources and calls `activate()`
 *    on the package's main module.
 *  * Deactivating a package unregisters the package's resources  and calls
 *    `deactivate()` on the package's main module.
 *  * Unloading a package removes it completely from the package manager.
 *
 * Packages can be enabled/disabled via the `core.disabledPackages` config
 * settings and also by calling `enablePackage()/disablePackage()`.
 */
module.exports = class PackageManager {
  constructor(params) {
    ({
      config: this.config,
      styleManager: this.styleManager,
      notificationManager: this.notificationManager,
      keymapManager: this.keymapManager,
      commandRegistry: this.commandRegistry,
      grammarRegistry: this.grammarRegistry,
      deserializerManager: this.deserializerManager,
      viewRegistry: this.viewRegistry,
      uriHandlerRegistry: this.uriHandlerRegistry,
    } = params);

    this.emitter = new Emitter();
    this.packageDirPaths = [];
    this.packageManifestCache = new Map();
    this.packageRootEntriesCache = new Map();
    this.availablePackagesByNameDuringLoad = null;
    this.packagesCache = packageJSON._luminePackages != null ? packageJSON._luminePackages : {};
    this.bundledPackageNames = null;
    this.initialPackagesLoaded = false;
    this.initialPackagesInitializing = false;
    this.initialPackagesInitialized = false;
    this.initialPackagesActivated = false;
    this.initialPackagesActivationTime = null;
    this.loadedPackages = {};
    this.activePackages = {};
    this.packageLifecycles = new Map();
    this.packageStates = {};
    this.themePackRegistrationsByPackageName = new Map();
    this.virtualThemeNamesByPackageName = new Map();
    this.virtualThemeOwnerByName = new Map();
    this.serviceProviders = new Map();
    this.serviceHub = new ServiceHub();
    // Public, sticky window hooks used by package-owned lazy features. This
    // registry is independent of package activation and is populated only by
    // core code; package manifests do not participate in hook delivery.
    this.hooks = new ActivationHooks();

    this.packageActivators = [];
    this.registerPackageActivator(this, ["lumine"]);
  }

  initialize(params) {
    this.devMode = params.devMode;
    this.resourcePath = params.resourcePath;
    if (params.configDirPath != null && !params.safeMode) {
      this.userPackagesPath = path.join(params.configDirPath, "packages");
      this.devPackagesPath = path.join(params.configDirPath, "packages-dev");
      // Ordered by descending priority: a package name claimed by an earlier
      // directory shadows every later copy of that name. Dev packages outrank
      // manual installs, which outrank the packages bundled with the editor —
      // those are delivered through node_modules and enumerated by the
      // engines.lumine scan, never through a directory of their own.
      if (this.devMode) this.packageDirPaths.push(this.devPackagesPath);
      this.packageDirPaths.push(this.userPackagesPath);
    }
  }

  setContextMenuManager(contextMenuManager) {
    this.contextMenuManager = contextMenuManager;
  }

  setMenuManager(menuManager) {
    this.menuManager = menuManager;
  }

  setThemeManager(themeManager) {
    this.themeManager = themeManager;
  }

  async reset() {
    this.serviceHub.clear();
    await this.unloadPackages({ serialize: false });
    this.unobserveDisabledPackages();
    this.unobservePackagesWithKeymapsDisabled();
    this.packageManifestCache.clear();
    this.packageRootEntriesCache.clear();
    this.availablePackagesByNameDuringLoad = null;
    this.loadedPackages = {};
    this.activePackages = {};
    this.packageLifecycles.clear();
    this.initialPackagesLoaded = false;
    this.initialPackagesInitializing = false;
    this.initialPackagesInitialized = false;
    this.initialPackagesActivated = false;
    this.initialPackagesActivationTime = null;
    this.packageStates = {};
    this.themePackRegistrationsByPackageName.clear();
    this.virtualThemeNamesByPackageName.clear();
    this.virtualThemeOwnerByName.clear();
    this.packagesCache = packageJSON._luminePackages != null ? packageJSON._luminePackages : {};
    this.bundledPackageNames = null;
    this.hooks.clear();
    this.serviceProviders.clear();
    this.activatePromise = null;
    this.emitter.dispose();
    this.emitter = new Emitter();
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when all packages have been loaded.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidLoadInitialPackages(callback) {
    return this.emitter.on("did-load-initial-packages", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when all packages have been activated.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidActivateInitialPackages(callback) {
    return this.emitter.on("did-activate-initial-packages", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback after all initial package facades have been
   * initialized, before workspace restore begins.
   */
  onDidInitializeInitialPackages(callback) {
    return this.emitter.on("did-initialize-initial-packages", callback);
  }

  getActivatePromise() {
    if (this.activatePromise) {
      return this.activatePromise;
    } else {
      return Promise.resolve();
    }
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when a package is activated.
   *
   * @param callback - A `Function` to be invoked when a package is activated.
   * @param callback.package - The {@link Package} that was activated.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidActivatePackage(callback) {
    return this.emitter.on("did-activate-package", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when a package is deactivated.
   *
   * @param callback - A `Function` to be invoked when a package is deactivated.
   * @param callback.package - The {@link Package} that was deactivated.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDeactivatePackage(callback) {
    return this.emitter.on("did-deactivate-package", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when a package is loaded.
   *
   * @param callback - A `Function` to be invoked when a package is loaded.
   * @param callback.package - The {@link Package} that was loaded.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidLoadPackage(callback) {
    return this.emitter.on("did-load-package", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when a package is unloaded.
   *
   * @param callback - A `Function` to be invoked when a package is unloaded.
   * @param callback.package - The {@link Package} that was unloaded.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidUnloadPackage(callback) {
    return this.emitter.on("did-unload-package", callback);
  }

  /**
   * @category Package system data
   */

  /**
   * @public
   * @status public
   *
   * Get the paths being used to look for packages.
   *
   * @returns {Array} of `String` directory paths.
   */
  getPackageDirPaths() {
    return _.clone(this.packageDirPaths);
  }

  /**
   * @category General package data
   */

  /**
   * @public
   * @status public
   *
   * Resolve the given package name to a path on disk.
   *
   * @param name - The `String` package name.
   * @returns {String} folder path or undefined if it could not be resolved.
   */
  resolvePackagePath(name) {
    const availablePackage = this.resolveAvailablePackage(name);
    return availablePackage != null ? availablePackage.path : null;
  }

  // Resolve a package name — or a path to a package directory — to the
  // descriptor of the copy that owns that name.
  //
  // Returns a package descriptor or null.
  resolveAvailablePackage(nameOrPath) {
    if (fs.isDirectorySync(nameOrPath)) {
      return this.describePackagePath(nameOrPath);
    }

    const availablePackage = this.getAvailablePackage(nameOrPath);
    if (availablePackage != null) {
      return availablePackage;
    }

    // A package inside node_modules that no manifest pins, recognised by its
    // Lumine engine declaration alone.
    const packagePath = path.join(this.resourcePath, "node_modules", nameOrPath);
    if (this.hasLumineEngine(packagePath)) {
      return this.describePackagePath(packagePath);
    }

    return null;
  }

  // Build the descriptor for a single package directory: what it is called,
  // where it lives, and which tier it belongs to.
  describePackagePath(packagePath, options = {}) {
    const dirname = path.basename(packagePath);
    const isBundled =
      options.isBundled != null ? options.isBundled : this.isBundledPackagePath(packagePath);
    const manifest = this.readPackageManifest(packagePath, isBundled);
    const name = manifest.name || dirname;
    // Everything downstream reads the identity off the metadata as well.
    manifest.metadata.name = name;
    return {
      name,
      dirname,
      path: packagePath,
      tier: options.tier != null ? options.tier : this.getPackageDirTier(path.dirname(packagePath)),
      isBundled,
      metadata: manifest.metadata,
      packageRootEntries: this.readPackageRootEntries(packagePath, isBundled),
      nameSource: manifest.name ? "manifest" : "dirname",
      error: manifest.error,
    };
  }

  /**
   * @public
   * @status public
   *
   * Is the package with the given name bundled with Lumine?
   *
   * @param name - The `String` package name.
   * @returns {Boolean}
   */
  isBundledPackage(name) {
    return this.getBundledPackageNames().has(name);
  }

  /**
   * @category Enabling and disabling packages
   */

  /**
   * @public
   * @status public
   *
   * Enable the package with the given name.
   *
   * @param name - The `String` package name.
   * @returns {Promise<Package|null>} Resolves when the enabled package is initialized or active.
   */
  async enablePackage(name) {
    const pack = this.loadPackage(name);
    if (pack == null) return null;
    pack.enable();
    if (pack.isTheme()) {
      await this.themeManager?.whenThemesSettled();
    } else {
      await this.startPackage(name);
    }
    return pack;
  }

  /**
   * @public
   * @status public
   *
   * Disable the package with the given name.
   *
   * @param name - The `String` package name.
   * @returns {Promise<Package|null>} Resolves after the package is fully deactivated.
   */
  async disablePackage(name) {
    const pack = this.loadPackage(name);
    if (pack == null) return null;
    if (!this.isPackageDisabled(name)) pack.disable();
    if (pack.isTheme()) {
      await this.themeManager?.whenThemesSettled();
    } else {
      await this.deactivatePackage(name);
    }
    return pack;
  }

  /**
   * @public
   * @status public
   *
   * Is the package with the given name disabled?
   *
   * @param name - The `String` package name.
   * @returns {Boolean}
   */
  isPackageDisabled(name) {
    return _.include(this.config.get("core.disabledPackages") || [], name);
  }

  /**
   * @category Accessing active packages
   */

  /**
   * @public
   * @status public
   *
   * Get an `Array` of all the active {@link Package Packages}.
   */
  getActivePackages() {
    return _.values(this.activePackages);
  }

  // Move already-active package names to the end of the active ordering in the
  // supplied order. ThemeManager uses this to keep stylesheet precedence
  // explicit without mutating PackageManager's lifecycle index directly.
  reorderActivePackages(packageNames) {
    for (const name of packageNames) delete this.activePackages[name];
    for (const name of packageNames) {
      const record = this.packageLifecycles.get(name);
      if (record?.state === "active") {
        // Resolve the current generation only after any asynchronous theme
        // transition. A ThemePackage object captured before reconciliation must
        // never be reinserted into the manager-owned active index.
        this.activePackages[name] = record.pack;
      }
    }
  }

  /**
   * @public
   * @status public
   *
   * Get the active {@link Package} with the given name.
   *
   * @param name - The `String` package name.
   * @returns {Package} or undefined.
   */
  getActivePackage(name) {
    const record = this.packageLifecycles.get(name);
    return record?.state === "active" ? record.pack : undefined;
  }

  /**
   * @public
   * @status public
   *
   * Is the {@link Package} with the given name active?
   *
   * @param name - The `String` package name.
   * @returns {Boolean}
   */
  isPackageActive(name) {
    return this.getActivePackage(name) != null;
  }

  /**
   * @public
   * @status public
   *
   * Return the package's explicit lifecycle state.
   *
   * @param name - Package name.
   * @returns {String|undefined} One of `loaded`, `activating`, `active`, or
   * `deactivating`. An unloaded or unknown package has no current lifecycle record.
   */
  getPackageLifecycleState(name) {
    return this.packageLifecycles.get(name)?.state;
  }

  getPackageLifecycleRecord(name) {
    return this.packageLifecycles.get(name);
  }

  registerPackageLifecycle(pack) {
    const record = {
      pack,
      state: "loaded",
      generation: 0,
      abortController: null,
      activationPromise: null,
      activationTask: null,
      rawActivationPromise: null,
      rejectCancellation: null,
      deactivationPromise: null,
      unloadRequested: false,
    };
    pack.lifecycleState = "loaded";
    this.packageLifecycles.set(pack.name, record);
    return record;
  }

  setPackageLifecycleState(record, state) {
    record.state = state;
    record.pack.lifecycleState = state;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} indicating whether package activation has occurred.
   */
  hasActivatedInitialPackages() {
    return this.initialPackagesActivated;
  }

  /**
   * @category Accessing loaded packages
   */

  /**
   * @public
   * @status public
   *
   * Get an `Array` of all the loaded {@link Package Packages}
   */
  getLoadedPackages() {
    return _.values(this.loadedPackages);
  }

  // Get packages for a certain package type
  //
  // * `types` an `Array` of package type `Strings`.
  getLoadedPackagesForTypes(types) {
    return this.getLoadedPackages().filter((p) => types.includes(p.getType()));
  }

  /**
   * @public
   * @status public
   *
   * Get the loaded {@link Package} with the given name.
   *
   * @param name - The `String` package name.
   * @returns {Package} or undefined.
   */
  getLoadedPackage(name) {
    return this.loadedPackages[name];
  }

  /**
   * @public
   * @status public
   *
   * Is the package with the given name loaded?
   *
   * @param name - The `String` package name.
   * @returns {Boolean}
   */
  isPackageLoaded(name) {
    return this.getLoadedPackage(name) != null;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} indicating whether package loading has occurred.
   */
  hasLoadedInitialPackages() {
    return this.initialPackagesLoaded;
  }

  /**
   * @public
   * @status extended
   *
   * @returns {Boolean} indicating whether the initial package bootstrap has
   * completed.
   */
  hasInitializedInitialPackages() {
    return this.initialPackagesInitialized;
  }

  /**
   * @category Accessing available packages
   */

  /**
   * @public
   * @status public
   *
   * @returns {Array} of `Strings` of all the available package paths.
   */
  getAvailablePackagePaths() {
    return this.getAvailablePackages().map((a) => a.path);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array} of `Strings` of all the available package names.
   */
  getAvailablePackageNames() {
    return this.getAvailablePackages().map((a) => a.name);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array} of `Strings` of all the available package metadata.
   */
  getAvailablePackageMetadata() {
    const packages = [];
    for (const pack of this.getAvailablePackages()) {
      const loadedPackage = this.getLoadedPackage(pack.name);
      const metadata =
        loadedPackage != null ? loadedPackage.metadata : this.loadPackageMetadata(pack, true);
      packages.push(metadata);
    }
    return packages;
  }

  /**
   * @public
   * @status public
   *
   * @param {Object} [options]
   * @param options.includeShadowed - When `true`, also returns the copies whose name is owned by another directory. Those never load; they exist so the UI can list every directory on disk.
   * @returns {Array} Available package descriptors that own their names, sorted by name.
   */
  getAvailablePackages(options) {
    const packages = this.scanAvailablePackages();
    const visible =
      options != null && options.includeShadowed ? packages : packages.filter((p) => p.isWinner);
    return visible.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  /**
   * @public
   * @status public
   *
   * Get the available package that owns the given name.
   *
   * @returns {Object|undefined} package descriptor or undefined.
   */
  getAvailablePackage(name) {
    if (this.availablePackagesByNameDuringLoad != null) {
      return this.availablePackagesByNameDuringLoad.get(name);
    }
    return this.scanAvailablePackages().find((pack) => pack.isWinner && pack.name === name);
  }

  /**
   * @public
   * @status public
   *
   * Forget everything read from package manifests.
   *
   * The directory scan itself always runs fresh, so this only has to be called
   * when a manifest changes on disk — after an install, update, or uninstall.
   */
  refreshPackageIndex() {
    this.packageManifestCache.clear();
    this.packageRootEntriesCache.clear();
  }

  // Index the names in an external package's root once. Resource loading can
  // then avoid probing conventional directories that are known not to exist.
  // A failed read remains "unknown" so callers retain their normal fallback.
  readPackageRootEntries(packagePath, isBundled) {
    if (isBundled && this.packagesCache[path.basename(packagePath)] != null) return null;
    if (this.packageRootEntriesCache.has(packagePath)) {
      return this.packageRootEntriesCache.get(packagePath);
    }

    let entries = null;
    try {
      entries = new Set(fs.readdirSync(packagePath));
    } catch {
      // Leave the index unknown; resource loaders will probe as before.
    }
    this.packageRootEntriesCache.set(packagePath, entries);
    return entries;
  }

  // Scan every package directory and decide which copy owns each package name.
  //
  // A package's identity is the `name` in its manifest; the directory name only
  // breaks ties. Directories are visited in `packageDirPaths` order — dev, then
  // installed, then bundled — and within a directory in dirname order, so the
  // first copy carrying a name is the one that loads. Every later copy is
  // returned as a shadowed descriptor: it never loads, but it is real, it is on
  // disk, and the UI lists it.
  scanAvailablePackages() {
    const packages = [];
    const winnersByName = new Map();
    const bundledNames = new Set();

    const add = (packagePath, options) => {
      const pack = this.describePackagePath(packagePath, options);

      // A bundled package vendored into packages/ is delivered through
      // node_modules/ as well, by the `file:` pin that installs it. Those are
      // two deliveries of one bundled package, not two copies to choose
      // between, so only the first is listed.
      if (pack.tier === "bundled") {
        if (bundledNames.has(pack.name)) return;
        bundledNames.add(pack.name);
      }

      const winner = winnersByName.get(pack.name);
      if (winner == null) {
        pack.isWinner = true;
        winnersByName.set(pack.name, pack);
      } else {
        pack.isWinner = false;
        pack.shadowedBy = {
          name: winner.name,
          dirname: winner.dirname,
          path: winner.path,
          tier: winner.tier,
        };
      }

      packages.push(pack);
    };

    for (const packageDirPath of this.packageDirPaths) {
      if (!fs.isDirectorySync(packageDirPath)) continue;

      const tier = this.getPackageDirTier(packageDirPath);
      // dirent is faster than stat, but a symlink needs stat to know whether it
      // points at a directory.
      const dirnames = fs
        .readdirSync(packageDirPath, { withFileTypes: true })
        .filter(
          (dirent) =>
            !dirent.name.startsWith(".") &&
            (dirent.isDirectory() ||
              (dirent.isSymbolicLink() &&
                fs.isDirectorySync(path.join(packageDirPath, dirent.name)))),
        )
        .map((dirent) => dirent.name)
        .sort((a, b) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0));

      for (const dirname of dirnames) {
        add(path.join(packageDirPath, dirname), { isBundled: false, tier });
      }
    }

    for (const packageName of this.getBundledPackageNames()) {
      // Bundled packages delivered through node_modules — every dependency
      // whose own manifest declares an engines.lumine range. Derive isBundled
      // from the path so that, in dev mode running from source, they are
      // treated as non-bundled like the packages/ entries instead of being
      // singled out under "Bundled Packages".
      const packagePath = path.join(this.resourcePath, "node_modules", packageName);
      add(packagePath, { isBundled: this.isBundledPackagePath(packagePath), tier: "bundled" });
    }

    return packages;
  }

  // Which tier a package directory belongs to. Spec fixture directories and
  // anything else pushed onto `packageDirPaths` report "other".
  getPackageDirTier(packageDirPath) {
    if (packageDirPath === this.devPackagesPath) return "dev";
    if (packageDirPath === this.userPackagesPath) return "installed";
    return "other";
  }

  // Read a package manifest for the scan: the parsed metadata, the name it
  // declares (if any), and the error that stopped it from parsing (if any).
  // Results are memoized per path until `refreshPackageIndex()`.
  readPackageManifest(packagePath, isBundled) {
    let manifest = this.packageManifestCache.get(packagePath);
    if (manifest != null) return manifest;

    manifest = { metadata: {}, name: null, error: null };
    const cacheName = path.basename(packagePath);
    if (isBundled && this.packagesCache[cacheName] != null) {
      manifest.metadata = this.packagesCache[cacheName].metadata || {};
    } else {
      const metadataPath = fs.resolve(packagePath, "package", ["json", "jsonc"]);
      if (metadataPath) {
        try {
          manifest.metadata = CSON.readFileSync(metadataPath) || {};
          this.normalizePackageMetadata(manifest.metadata);
        } catch (error) {
          manifest.error = error;
        }
      }
    }

    const name = manifest.metadata.name;
    if (typeof name === "string" && name.length > 0) manifest.name = name;

    const { repository } = manifest.metadata;
    if (repository && repository.type === "git" && typeof repository.url === "string") {
      repository.url = repository.url.replace(/(^git\+)|(\.git$)/g, "");
    }

    this.packageManifestCache.set(packagePath, manifest);
    return manifest;
  }

  /**
   * @category Private
   */

  getPackageState(name) {
    return this.packageStates[name];
  }

  setPackageState(name, state) {
    this.packageStates[name] = state;
  }

  // The names of the packages that ship with the editor. In a packaged build
  // the baked _luminePackages metadata is the authority (generated by the same
  // scan at build time); from source, the dependency manifests are scanned
  // directly.
  getBundledPackageNames() {
    if (this.bundledPackageNames == null) {
      const baked = Object.keys(this.packagesCache);
      this.bundledPackageNames = new Set(
        baked.length > 0 ? baked : scanBundledPackageNames(this.resourcePath),
      );
    }
    return this.bundledPackageNames;
  }

  hasLumineEngine(packagePath) {
    const metadata = this.loadPackageMetadata(packagePath, true);
    return metadata != null && metadata.engines != null && metadata.engines.lumine != null;
  }

  unobserveDisabledPackages() {
    if (this.disabledPackagesSubscription != null) {
      this.disabledPackagesSubscription.dispose();
    }
    this.disabledPackagesSubscription = null;
  }

  observeDisabledPackages() {
    if (this.disabledPackagesSubscription != null) {
      return;
    }

    this.disabledPackagesSubscription = this.config.onDidChange(
      "core.disabledPackages",
      ({ newValue, oldValue }) => {
        const packagesToEnable = _.difference(oldValue, newValue);
        const packagesToDisable = _.difference(newValue, oldValue);
        packagesToDisable.forEach((name) => {
          this.deactivatePackage(name).catch((error) => {
            console.error(`Failed to deactivate disabled package '${name}'`, error);
          });
        });
        packagesToEnable.forEach((name) => {
          this.startPackage(name).catch((error) => {
            console.error(`Failed to start enabled package '${name}'`, error);
          });
        });
        return null;
      },
    );
  }

  unobservePackagesWithKeymapsDisabled() {
    if (this.packagesWithKeymapsDisabledSubscription != null) {
      this.packagesWithKeymapsDisabledSubscription.dispose();
    }
    this.packagesWithKeymapsDisabledSubscription = null;
  }

  observePackagesWithKeymapsDisabled() {
    if (this.packagesWithKeymapsDisabledSubscription != null) {
      return;
    }

    const performOnLoadedActivePackages = (packageNames, disabledPackageNames, action) => {
      for (const packageName of packageNames) {
        if (!disabledPackageNames.has(packageName)) {
          const pack = this.getLoadedPackage(packageName);
          if (pack != null) {
            action(pack);
          }
        }
      }
    };

    this.packagesWithKeymapsDisabledSubscription = this.config.onDidChange(
      "core.packagesWithKeymapsDisabled",
      ({ newValue, oldValue }) => {
        const keymapsToEnable = _.difference(oldValue, newValue);
        const keymapsToDisable = _.difference(newValue, oldValue);

        const disabledPackageNames = new Set(this.config.get("core.disabledPackages"));
        performOnLoadedActivePackages(keymapsToDisable, disabledPackageNames, (p) =>
          p.deactivateKeymaps(),
        );
        performOnLoadedActivePackages(keymapsToEnable, disabledPackageNames, (p) =>
          p.activateKeymaps(),
        );
        return null;
      },
    );
  }

  loadPackages({ initialize = false } = {}) {
    // Ensure lumine exports is already in the require cache so the load time
    // of the first package isn't skewed by being the first to require lumine
    require("../exports/lumine");

    const disabledPackageNames = new Set(this.config.get("core.disabledPackages"));
    const availablePackages = this.getAvailablePackages();
    this.availablePackagesByNameDuringLoad = new Map(
      availablePackages.map((pack) => [pack.name, pack]),
    );
    try {
      this.config.transact(() => {
        for (const pack of availablePackages) {
          this.loadAvailablePackage(pack, disabledPackageNames);
        }
      });
    } finally {
      this.availablePackagesByNameDuringLoad = null;
    }
    this.rebuildServiceProviders();
    this.initialPackagesLoaded = true;
    // Bootstrap before announcing the load when the real window requests the
    // new lifecycle. Unit callers can still load metadata/resources alone and
    // explicitly initialize later.
    if (initialize) this.initializePackages();
    this.emitter.emit("did-load-initial-packages");
  }

  /**
   * Initialize every enabled package before workspace state is restored.
   *
   * Initialization is deliberately synchronous and is the package-facing
   * bootstrap phase: packages may register deserializers, openers, commands,
   * lightweight UI hosts, and service facades here. Expensive work belongs in
   * an explicit package-owned ensure method and must not be started from this
   * phase. Keeping this separate from activation lets workspace restoration
   * use those registrations without making `activate()` responsible for
   * deserialization ordering.
   *
   * @public
   * @status extended
   */
  initializePackages() {
    if (!this.initialPackagesLoaded || this.initialPackagesInitialized) return;
    if (this.initialPackagesInitializing) return;

    this.initialPackagesInitializing = true;
    try {
      const packages = this.getLoadedPackagesForTypes(["lumine"]).filter(
        (pack) => !this.isPackageDisabled(pack.name) && !pack.loadError,
      );
      // Require every entrypoint before invoking any package initializer so a
      // bootstrap never depends on directory/activation order. Initializers
      // themselves remain the only phase allowed to publish package state.
      for (const pack of packages) pack.requireMainModule();
      this.config.transact(() => {
        for (const pack of packages) {
          pack.initializeForExternalUse("initial package bootstrap");
        }
      });
      this.initialPackagesInitialized = true;
      this.emitter.emit("did-initialize-initial-packages");
    } finally {
      this.initialPackagesInitializing = false;
    }
  }

  loadPackage(nameOrPath) {
    if (path.basename(nameOrPath)[0].match(/^\./)) {
      // primarily to skip .git folder
      return null;
    }

    const pack = this.getLoadedPackage(nameOrPath);
    if (pack) {
      return pack;
    }

    const availablePackage = this.resolveAvailablePackage(nameOrPath);
    if (availablePackage) {
      return this.loadAvailablePackage(availablePackage);
    }

    console.warn(`Could not resolve '${nameOrPath}' to a package path`);
    return null;
  }

  // Make the loaded copy of `name` match the copy that currently owns the name
  // on disk. Loading a package is the point where its keymaps, menus, config
  // schema, and deserializers become visible, so only ever one copy of a name
  // is loaded — this is what swaps that copy when an install or an uninstall
  // changes who wins.
  //
  // * `name` - The `String` package name.
  // * `options` (optional) `Object`
  //   * `lifecycleState` State to restore when the old copy was already
  //     unloaded by an atomic file swap.
  //
  // Returns a `Promise` that resolves with the loaded {@link Package}, or null when
  // no copy of the name is left on disk.
  async reconcilePackage(name, options = {}) {
    this.refreshPackageIndex();

    const availablePackage = this.getAvailablePackage(name);
    const loadedPackage = this.getLoadedPackage(name);
    if (
      loadedPackage != null &&
      availablePackage != null &&
      loadedPackage.path === availablePackage.path
    ) {
      return loadedPackage;
    }

    const previousState = Object.hasOwn(options, "lifecycleState")
      ? options.lifecycleState
      : loadedPackage != null
        ? this.getPackageLifecycleState(name)
        : "loaded";
    if (loadedPackage != null) {
      await this.unloadPackage(name);
    }

    if (availablePackage == null) return null;

    const pack = this.loadAvailablePackage(availablePackage);
    if (pack == null) return null;

    return this.restorePackageLifecycle(pack, previousState);
  }

  async restorePackageLifecycle(pack, lifecycleState) {
    if (pack == null || this.isPackageDisabled(pack.name)) return pack;
    if (lifecycleState === "active" || lifecycleState === "activating") {
      if (pack.isTheme() && this.themeManager) {
        await this.themeManager.reconcilePackage(pack.name, lifecycleState);
      } else {
        await this.activatePackageInstance(pack, null, { type: "reconcile" });
      }
    }
    const virtualThemeNames = this.virtualThemeNamesByPackageName.get(pack.name);
    if (virtualThemeNames?.size > 0 && this.themeManager) {
      const configuredThemes = this.config.get(this.themeManager.getActiveThemesKeyPath());
      if (
        Array.isArray(configuredThemes) &&
        configuredThemes.some((name) => virtualThemeNames.has(name))
      ) {
        await this.themeManager.queueThemeSwitch();
      }
    }
    return pack;
  }

  loadAvailablePackage(availablePackage, disabledPackageNames) {
    if (disabledPackageNames != null && disabledPackageNames.has(availablePackage.name)) {
      return null;
    }

    const loadedPackage = this.getLoadedPackage(availablePackage.name);
    if (loadedPackage != null) {
      return loadedPackage;
    }

    let metadata;
    try {
      metadata = this.loadPackageMetadata(availablePackage) || {};
    } catch (error) {
      this.handleMetadataError(error, availablePackage.path);
      return null;
    }

    // A multi-theme package (a `themes` array in package.json) additionally
    // registers one ThemePackage per declared theme. The container package
    // itself still loads normally below, so its `main`/`configSchema` apply.
    if (Array.isArray(metadata.themes) && metadata.themes.length > 0) {
      this.registerThemesFromPackage(availablePackage, metadata);
    }

    const options = {
      path: availablePackage.path,
      name: availablePackage.name,
      metadata,
      packageRootEntries: availablePackage.packageRootEntries,
      bundledPackage: availablePackage.isBundled,
      packageManager: this,
      config: this.config,
      styleManager: this.styleManager,
      commandRegistry: this.commandRegistry,
      keymapManager: this.keymapManager,
      notificationManager: this.notificationManager,
      grammarRegistry: this.grammarRegistry,
      themeManager: this.themeManager,
      menuManager: this.menuManager,
      contextMenuManager: this.contextMenuManager,
      deserializerManager: this.deserializerManager,
      viewRegistry: this.viewRegistry,
    };

    const pack = metadata.theme ? new ThemePackage(options) : new Package(options);
    pack.load();
    this.loadedPackages[pack.name] = pack;
    this.registerPackageLifecycle(pack);
    this.registerThemePacksFromPackage(pack);
    if (this.initialPackagesLoaded) {
      this.rebuildServiceProviders();
    }
    this.emitter.emit("did-load-package", pack);
    return pack;
  }

  // Register declarative light/dark theme packs from a package manifest.
  // Registrations are tied to the containing package's lifecycle; virtual
  // themes created from its `themes` array do not inherit these definitions.
  registerThemePacksFromPackage(pack) {
    if (
      !this.themeManager ||
      this.themePackRegistrationsByPackageName.has(pack.name) ||
      !Array.isArray(pack.metadata.themePacks)
    ) {
      return;
    }

    const registrations = new CompositeDisposable();
    let registrationCount = 0;
    for (const themePack of pack.metadata.themePacks) {
      try {
        registrations.add(this.themeManager.registerThemePack(themePack));
        registrationCount++;
      } catch (error) {
        console.warn(
          `Ignoring an invalid theme pack in the '${pack.name}' package: ${error.message}`,
        );
      }
    }

    if (registrationCount > 0) {
      this.themePackRegistrationsByPackageName.set(pack.name, registrations);
    } else {
      registrations.dispose();
    }
  }

  unregisterThemePacksForPackage(packageName) {
    const registrations = this.themePackRegistrationsByPackageName.get(packageName);
    if (!registrations) return;
    registrations.dispose();
    this.themePackRegistrationsByPackageName.delete(packageName);
  }

  // Register one virtual ThemePackage per entry of a `themes` array. Each
  // entry has a `name`, a `theme` type ("ui" or "syntax"), and optionally a
  // `styles` directory relative to the package root (defaults to
  // `styles/<theme name>`). `extends` accepts a package-qualified glob string
  // or an ordered list of them (`package-name::styles/**/*.css`); matching
  // styles load first, followed by this theme's override styles. The
  // containing package is loaded separately as a normal package (see
  // loadAvailablePackage).
  registerThemesFromPackage(availablePackage, metadata) {
    const virtualThemeNames = new Set();
    for (const entry of metadata.themes) {
      if (!entry || typeof entry.name !== "string" || !entry.theme) {
        console.warn(
          `Ignoring an invalid entry in the 'themes' of the '${availablePackage.name}' package.`,
        );
        continue;
      }

      // A real package owning the name always beats a virtual theme, wherever
      // that package lives.
      if (
        this.getLoadedPackage(entry.name) != null ||
        this.getAvailablePackage(entry.name) != null
      ) {
        continue;
      }

      const themeMetadata = { ...metadata, name: entry.name, theme: entry.theme };
      delete themeMetadata.themes;
      delete themeMetadata.themePacks;
      delete themeMetadata.main;
      delete themeMetadata.configSchema;

      // `styles` may be a single directory or an ordered list (shared
      // directories first, the theme's own directory last).
      const stylesDirs = Array.isArray(entry.styles)
        ? entry.styles
        : [entry.styles ?? path.join("styles", entry.name)];
      const styleExtensions = this.resolveThemeStyleExtensions(entry.extends, availablePackage);

      const pack = new ThemePackage({
        path: availablePackage.path,
        name: entry.name,
        metadata: themeMetadata,
        themeStyleExtensions: styleExtensions,
        themeStylesDirectories: stylesDirs.map((dir) => path.join(availablePackage.path, dir)),
        bundledPackage: availablePackage.isBundled,
        packageManager: this,
        config: this.config,
        styleManager: this.styleManager,
        commandRegistry: this.commandRegistry,
        keymapManager: this.keymapManager,
        notificationManager: this.notificationManager,
        grammarRegistry: this.grammarRegistry,
        themeManager: this.themeManager,
        menuManager: this.menuManager,
        contextMenuManager: this.contextMenuManager,
        deserializerManager: this.deserializerManager,
        viewRegistry: this.viewRegistry,
      });
      pack.load();
      this.loadedPackages[pack.name] = pack;
      this.registerPackageLifecycle(pack);
      virtualThemeNames.add(pack.name);
      this.virtualThemeOwnerByName.set(pack.name, availablePackage.name);
      this.emitter.emit("did-load-package", pack);
    }
    if (virtualThemeNames.size > 0) {
      this.virtualThemeNamesByPackageName.set(availablePackage.name, virtualThemeNames);
    }
  }

  resolveThemeStyleExtensions(extensions, availablePackage) {
    if (extensions == null) return [];

    const references = Array.isArray(extensions) ? extensions : [extensions];
    const stylesheetGlobs = [];

    for (const reference of references) {
      if (typeof reference !== "string") {
        console.warn(`Ignoring an invalid theme extension in '${availablePackage.name}'.`);
        continue;
      }

      const separatorIndex = reference.indexOf("::");
      const packageName = reference.slice(0, separatorIndex);
      const pattern = reference.slice(separatorIndex + 2).replaceAll("\\", "/");
      if (
        separatorIndex <= 0 ||
        pattern.length === 0 ||
        path.posix.isAbsolute(pattern) ||
        /^[A-Za-z]:/.test(pattern) ||
        pattern.split("/").includes("..")
      ) {
        console.warn(
          `Ignoring invalid theme extension '${reference}' in '${availablePackage.name}'.`,
        );
        continue;
      }

      const packagePath =
        packageName === availablePackage.name
          ? availablePackage.path
          : this.resolvePackagePath(packageName);
      if (!packagePath) {
        console.warn(
          `Ignoring theme extension from missing package '${packageName}' in '${availablePackage.name}'.`,
        );
        continue;
      }

      stylesheetGlobs.push({
        packagePath,
        pattern,
        watchDirectory: this.getThemeExtensionWatchDirectory(packagePath, pattern),
      });
    }

    return stylesheetGlobs;
  }

  getThemeExtensionWatchDirectory(packagePath, pattern) {
    const segments = pattern.split("/");
    const firstGlobSegment = segments.findIndex((segment) => /[*?[\]{}()]/.test(segment));
    const staticSegments =
      firstGlobSegment === -1 ? segments.slice(0, -1) : segments.slice(0, firstGlobSegment);
    return path.join(packagePath, ...staticSegments);
  }

  unloadPackages({ serialize = true } = {}) {
    return Promise.all(
      _.keys(this.loadedPackages).map((name) =>
        this.unloadPackage(name, { serialize }).catch((error) => {
          console.error(`Error unloading package '${name}'`, error);
        }),
      ),
    );
  }

  /**
   * @public
   * @status public
   *
   * Atomically deactivate and unload a package in any lifecycle state. The
   * current generation is stopped before the loaded instance is removed.
   *
   * @param name - Package name.
   * @param options
   * @param options.serialize - Serialize an active package before teardown. Defaults to true.
   * @returns {Promise<Package>} Resolves with the unloaded package after teardown.
   */
  unloadPackage(name, { serialize = true, preserveModuleCache = false } = {}) {
    const pack = this.getLoadedPackage(name);
    if (!pack) return Promise.reject(new Error(`No loaded package for name '${name}'`));
    const record = this.packageLifecycles.get(pack.name);
    if (!record || record.pack !== pack) {
      return Promise.reject(new Error(`No lifecycle record for loaded package '${name}'`));
    }
    if (record.unloadPromise) return record.unloadPromise;

    record.unloadRequested = true;
    record.generation++;
    // Block load-scope proxies immediately and wait for asynchronous resource
    // discovery before discarding this generation. Its callbacks check the
    // cancelled token and can no longer publish settings or notifications.
    const loadScopePromise = pack.prepareToUnload();
    loadScopePromise.catch(() => {});
    const finish = async () => {
      await loadScopePromise;
      return this.finishUnloadPackageTree(record, { serialize, preserveModuleCache });
    };

    const unloadPromise = this.deactivatePackage(name, { serialize }).then(
      finish,
      async (error) => {
        // A lifecycle error cannot be allowed to leave the old package reachable
        // after an update/uninstall requested an unload. Finish ownership cleanup
        // and then surface the original error.
        try {
          await finish();
        } catch (finishError) {
          throw new AggregateError(
            [error, finishError],
            `Package '${name}' failed to deactivate and unload cleanly`,
            { cause: finishError },
          );
        }
        throw error;
      },
    );
    unloadPromise.catch(() => {});
    record.unloadPromise = unloadPromise;
    return unloadPromise;
  }

  async finishUnloadPackageTree(record, { serialize, preserveModuleCache }) {
    const ownedThemeNames = [...(this.virtualThemeNamesByPackageName.get(record.pack.name) || [])];
    const errors = [];
    const results = await Promise.allSettled(
      ownedThemeNames.map((name) => {
        if (!this.isPackageLoaded(name)) return null;
        return this.unloadPackage(name, { serialize, preserveModuleCache });
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    let pack;
    try {
      pack = this.finishUnloadPackage(record, { preserveModuleCache });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Package '${record.pack.name}' failed to unload cleanly`);
    }
    return pack;
  }

  finishUnloadPackage(record, { preserveModuleCache = false } = {}) {
    const { pack } = record;
    if (this.packageLifecycles.get(pack.name) !== record) return pack;
    let unloadError;
    try {
      if (pack.isTheme()) this.themeManager?.removeActiveThemeClasses([pack]);
      this.unregisterThemePacksForPackage(pack.name);
      pack.unload({ preserveModuleCache });
    } catch (error) {
      unloadError = error;
    } finally {
      const ownerName = this.virtualThemeOwnerByName.get(pack.name);
      if (ownerName) {
        this.virtualThemeOwnerByName.delete(pack.name);
        const names = this.virtualThemeNamesByPackageName.get(ownerName);
        names?.delete(pack.name);
        if (names?.size === 0) this.virtualThemeNamesByPackageName.delete(ownerName);
      }
      this.virtualThemeNamesByPackageName.delete(pack.name);
      delete this.activePackages[pack.name];
      if (this.loadedPackages[pack.name] === pack) delete this.loadedPackages[pack.name];
      this.packageLifecycles.delete(pack.name);
      record.generation++;
      this.setPackageLifecycleState(record, "unloaded");
      this.rebuildServiceProviders();
      this.emitter.emit("did-unload-package", pack);
    }
    if (unloadError) throw unloadError;
    return pack;
  }

  // Activate all the packages that should be activated.
  activate() {
    const activationStartTime = window.performance.now();
    this.initialPackagesActivationTime = null;
    let promises = [];
    for (let [activator, types] of this.packageActivators) {
      const packages = this.getLoadedPackagesForTypes(types);
      promises = promises.concat(activator.activatePackages(packages));
    }
    this.activatePromise = Promise.all(promises).then(async () => {
      this.initialPackagesActivationTime = Math.round(
        window.performance.now() - activationStartTime,
      );
      this.initialPackagesActivated = true;
      this.emitter.emit("did-activate-initial-packages");
      this.activatePromise = null;
    });
    return this.activatePromise;
  }

  registerURIHandlerForPackage(packageName, handler) {
    return this.uriHandlerRegistry.registerHostHandler(packageName, handler);
  }

  rebuildServiceProviders() {
    this.serviceProviders.clear();
    for (const pack of this.getLoadedPackages()) {
      if (pack.getType() !== "lumine") continue;
      const providedServices = pack.metadata && pack.metadata.providedServices;
      if (!providedServices || typeof providedServices !== "object") continue;
      for (const [keyPath, descriptor] of Object.entries(providedServices)) {
        if (!descriptor) continue;
        const versions = Object.keys(descriptor.versions || {});
        const provider = { pack, versions };
        if (!this.serviceProviders.has(keyPath)) {
          this.serviceProviders.set(keyPath, []);
        }
        this.serviceProviders.get(keyPath).push(provider);
      }
    }
  }

  /**
   * @public
   * @status public
   *
   * Check whether a compatible service has already been published. Service
   * lookup never activates a provider; providers are ordinary active packages.
   *
   * @param keyPath - Exact service name.
   * @param versionRange - Semantic version range required by the caller.
   * @returns {Promise<Boolean>} Whether a compatible non-null service is published.
   */
  async requestService(keyPath, versionRange) {
    return this.serviceHub.hasProvider(keyPath, versionRange);
  }

  // another type of package manager can handle other package types.
  // See ThemeManager
  registerPackageActivator(activator, types) {
    this.packageActivators.push([activator, types]);
  }

  activatePackages(packages) {
    const transaction = this.config.transactAsync(() =>
      Promise.all(packages.map((pack) => this.startPackage(pack.name))),
    );
    this.observeDisabledPackages();
    this.observePackagesWithKeymapsDisabled();
    // Package activators return an array because PackageManager#activate
    // concatenates several activators' work. Returning the transaction itself
    // ensures did-activate-initial-packages cannot beat Config#endTransaction.
    return [transaction];
  }

  /**
   * @public
   * @status public
   *
   * Start a package according to its manifest. The synchronous facade is
   * published during the call; the returned promise also settles after core
   * grammar/settings resources finish loading. Expensive feature work remains
   * package-owned and lazy.
   *
   * @param name - Package name or path.
   * @returns {Promise<Package>} The started package. This never waits for a future trigger.
   */
  startPackage(name) {
    if (this.isPackageDisabled(name)) {
      return Promise.reject(new Error(`Cannot start disabled package '${name}'`));
    }

    let pack;
    try {
      pack = this.loadPackage(name);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!pack) {
      return Promise.reject(new Error(`Failed to load package '${name}'`));
    }
    if (pack.loadError) return Promise.reject(pack.loadError);
    this.registerThemePacksFromPackage(pack);

    return this.activatePackageInstance(pack, null, { type: "start" });
  }

  /**
   * @public
   * @status public
   *
   * Fully activate a package and wait for its main module and services to be ready.
   * Concurrent requests share one activation. Deactivation while activating
   * rejects with an error whose code is `PACKAGE_ACTIVATION_CANCELLED`.
   *
   * @param name - Package name or path.
   * @returns {Promise<Package>} The active package.
   */
  activatePackage(name) {
    if (this.isPackageDisabled(name)) {
      return Promise.reject(new Error(`Cannot activate disabled package '${name}'`));
    }
    let pack;
    try {
      pack = this.loadPackage(name);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!pack) return Promise.reject(new Error(`Failed to load package '${name}'`));
    this.registerThemePacksFromPackage(pack);
    return this.activatePackageInstance(pack, null, { type: "explicit" });
  }

  activatePackageInstance(pack, generation = null, cause = { type: "internal" }) {
    const record = this.packageLifecycles.get(pack.name);
    if (
      !record ||
      record.pack !== pack ||
      record.state === "unloaded" ||
      record.unloadRequested ||
      (generation != null && generation !== record.generation)
    ) {
      return Promise.reject(new PackageActivationCancelledError(pack.name));
    }
    if (this.isPackageDisabled(pack.name)) {
      return Promise.reject(new Error(`Cannot activate disabled package '${pack.name}'`));
    }
    if (record.state === "active") return Promise.resolve(pack);
    if (record.state === "activating") return record.activationPromise;
    if (record.state === "deactivating") {
      if (generation != null) return Promise.reject(new PackageActivationCancelledError(pack.name));
      return (record.deactivationPromise || Promise.resolve()).then(() =>
        this.activatePackageInstance(pack, null, cause),
      );
    }

    if (record.state !== "loaded") {
      return Promise.reject(new PackageActivationCancelledError(pack.name));
    }

    const activationGeneration = ++record.generation;
    const abortController = new AbortController();
    record.abortController = abortController;
    this.setPackageLifecycleState(record, "activating");

    // Publish the completion-shaped promise before invoking package code. A
    // view provider, deserializer, or service callback can re-enter the
    // manager while the synchronous bootstrap is still on the stack.
    let resolveActivation;
    let rejectActivation;
    const readiness = new Promise((resolve, reject) => {
      resolveActivation = resolve;
      rejectActivation = reject;
    });
    readiness.catch(() => {});
    record.activationPromise = readiness;
    record.activationTask = readiness;
    record.rejectCancellation = rejectActivation;

    // Package activation is intentionally synchronous. Invoke the package
    // immediately so commands, openers, deserializers and service facades are
    // visible before this method returns. The Promise returned to existing
    // lifecycle callers is only a completion-shaped wrapper; it no longer
    // gates the bootstrap on asynchronous feature work.
    try {
      pack.activateMain({
        signal: abortController.signal,
        cause,
        generation: activationGeneration,
      });
    } catch (error) {
      const rollbackPromise = this.rollbackFailedActivation(record, error);
      record.deactivationPromise = rollbackPromise;
      const failed = rollbackPromise.then(
        () => rejectActivation(error),
        () => rejectActivation(error),
      );
      failed.catch(() => {});
      // Keep the published promise stable for re-entrant callers; the
      // rollback continuation rejects it with the original activation error.
      record.rawActivationPromise = null;
      return readiness;
    }

    const current = this.packageLifecycles.get(pack.name);
    if (
      current !== record ||
      record.state !== "activating" ||
      record.generation !== activationGeneration ||
      record.unloadRequested ||
      this.isPackageDisabled(pack.name)
    ) {
      record.rejectCancellation = null;
      rejectActivation(new PackageActivationCancelledError(pack.name));
      return readiness;
    }

    this.setPackageLifecycleState(record, "active");
    this.activePackages[pack.name] = pack;
    record.abortController = null;
    record.rawActivationPromise = null;
    this.emitter.emit("did-activate-package", pack);

    // The package hook itself is synchronous, but grammar/settings discovery
    // started by the bootstrap still forms the lifecycle completion boundary.
    // Callers that await `activatePackage()` therefore retain a fully usable
    // grammar registry, while `activate()` has already published commands,
    // openers and services synchronously.
    const resourceLoad = pack.resourceLoadPromise;
    if (resourceLoad) {
      resourceLoad.then(
        () => {
          record.rejectCancellation = null;
          resolveActivation(pack);
        },
        (error) => {
          if (
            this.packageLifecycles.get(pack.name) !== record ||
            record.state !== "active" ||
            record.generation !== activationGeneration
          ) {
            rejectActivation(error);
            return;
          }
          const rollbackPromise = this.rollbackFailedActivation(record, error);
          record.deactivationPromise = rollbackPromise;
          rollbackPromise.then(
            () => {
              record.rejectCancellation = null;
              rejectActivation(error);
            },
            () => {
              record.rejectCancellation = null;
              rejectActivation(error);
            },
          );
        },
      );
    } else {
      record.rejectCancellation = null;
      resolveActivation(pack);
    }
    return readiness;
  }

  async rollbackFailedActivation(record, error) {
    const { pack } = record;
    this.setPackageLifecycleState(record, "deactivating");
    record.generation++;
    pack.disposeActivationEntryPoints();
    record.abortController?.abort();
    try {
      await pack.deactivate();
    } finally {
      pack.finishDeactivation();
      if (this.packageLifecycles.get(pack.name) === record && !record.unloadRequested) {
        this.setPackageLifecycleState(record, "loaded");
      }
      delete this.activePackages[pack.name];
      record.abortController = null;
      record.activationPromise = null;
      record.activationTask = null;
      record.rawActivationPromise = null;
      record.rejectCancellation = null;
      record.deactivationPromise = null;
      this.emitter.emit("did-deactivate-package", pack);
    }

    this.reportPackageActivationError(pack, error);
  }

  reportPackageActivationError(pack, error) {
    if (
      error?.code === "PACKAGE_ACTIVATION_CANCELLED" ||
      error?.packageLoadReported ||
      error?.packageActivationReported
    ) {
      return;
    }
    try {
      const kind = pack.getType() === "theme" ? "theme" : "package";
      pack.handleError(`Failed to activate the ${pack.name} ${kind}`, error);
    } catch {
      // Spec mode intentionally throws from handleError; activation still
      // rejects with the original failure after lifecycle rollback.
    }
  }

  serialize() {
    for (const pack of this.getActivePackages()) {
      this.serializePackage(pack);
    }
    return this.packageStates;
  }

  serializePackage(pack) {
    if (typeof pack.serialize === "function") {
      this.setPackageState(pack.name, pack.serialize());
    }
  }

  // Deactivate all packages.
  //
  // * `options` (optional) `Object`
  //   * `timeout` (optional) `Number` of milliseconds to wait for any one
  //     package. Omit to wait indefinitely.
  //
  // Deactivation runs on the unload path, where the main process is waiting on
  // the reply before it may reload or close the window. A package that never
  // settles would hold that open for good, and a package that rejects would
  // refuse the unload on everyone else's behalf, so on that path each one is
  // bounded and contained. Whatever a straggler is still doing is left to the
  // window going away.
  async deactivatePackages({ timeout } = {}) {
    const abandoned = [];
    await this.config.transactAsync(() =>
      Promise.all(
        this.getLoadedPackages().map(async (pack) => {
          const deactivation = this.deactivatePackage(pack.name, { serialize: false }).catch(
            (error) => {
              console.error(`Error deactivating package '${pack.name}'`, error);
            },
          );
          if (timeout == null) return deactivation;
          if (!(await settlesWithin(deactivation, timeout))) abandoned.push(pack.name);
        }),
      ),
    );
    if (abandoned.length > 0) {
      console.warn(`Stopped waiting for ${abandoned.join(", ")} to deactivate after ${timeout}ms`);
    }
    this.unobserveDisabledPackages();
    this.unobservePackagesWithKeymapsDisabled();
  }

  /**
   * @public
   * @status public
   *
   * Deactivate a loaded package and await its teardown before it reaches the
   * loaded state again.
   *
   * @param name - Package name.
   * @param options
   * @param options.serialize - Serialize an active package before teardown. Defaults to true.
   * @returns {Promise<void>} Resolves when the package reaches `loaded`.
   */
  async deactivatePackage(name, { serialize = true } = {}) {
    const pack = this.getLoadedPackage(name);
    if (pack == null) return;
    const record = this.packageLifecycles.get(pack.name);
    if (
      !record ||
      record.pack !== pack ||
      (record.state === "loaded" && !pack.mainInitialized) ||
      record.state === "unloaded"
    ) {
      return;
    }
    if (record.state === "deactivating") return record.deactivationPromise;

    if (serialize && record.state === "active") {
      this.serializePackage(pack);
    }

    const wasActivating = record.state === "activating";
    this.setPackageLifecycleState(record, "deactivating");
    record.generation++;
    // Remove URI registrations immediately; arbitrary package code is then
    // allowed to finish/abort before teardown.
    pack.disposeActivationEntryPoints();
    record.abortController?.abort();
    if (wasActivating) {
      record.rejectCancellation?.(new PackageActivationCancelledError(pack.name));
    }
    delete this.activePackages[pack.name];

    const deactivationPromise = (async () => {
      let deactivationError;
      try {
        if (record.rawActivationPromise) {
          try {
            await record.rawActivationPromise;
          } catch {
            // Activation failures are reported on the activation path. Teardown
            // must still run and reach a stable state.
          }
        }
        if (record.activationPromise) {
          try {
            await record.activationPromise;
          } catch {
            // Activation/resource failures are reported on their own path;
            // teardown still has to reach a stable loaded state.
          }
        }
        this.unregisterThemePacksForPackage(pack.name);
        await pack.deactivate();
      } catch (error) {
        deactivationError = error;
      } finally {
        pack.finishDeactivation();
        if (this.packageLifecycles.get(pack.name) === record && !record.unloadRequested) {
          this.setPackageLifecycleState(record, "loaded");
        }
        record.abortController = null;
        record.activationPromise = null;
        record.activationTask = null;
        record.rawActivationPromise = null;
        record.rejectCancellation = null;
        record.deactivationPromise = null;
        this.emitter.emit("did-deactivate-package", pack);
      }
      if (deactivationError) throw deactivationError;
    })();
    record.deactivationPromise = deactivationPromise;
    try {
      await deactivationPromise;
    } finally {
      delete this.activePackages[pack.name];
    }
  }

  handleMetadataError(error, packagePath) {
    const metadataPath = path.join(packagePath, "package.json");
    const detail = `${error.message} in ${metadataPath}`;
    const stack = `${error.stack}\n  at ${metadataPath}:1:1`;
    const message = `Failed to load the ${path.basename(packagePath)} package`;
    this.notificationManager.addError(message, {
      stack,
      detail,
      packageName: path.basename(packagePath),
      dismissable: true,
    });
  }

  uninstallDirectory(directory) {
    const symlinkPromise = new Promise((resolve) =>
      fs.isSymbolicLink(directory, (isSymLink) => resolve(isSymLink)),
    );
    const dirPromise = new Promise((resolve) =>
      fs.isDirectory(directory, (isDir) => resolve(isDir)),
    );

    return Promise.all([symlinkPromise, dirPromise]).then((values) => {
      const [isSymLink, isDir] = values;
      if (!isSymLink && isDir) {
        return fs.remove(directory, function () {});
      }
    });
  }

  reloadActivePackageStyleSheets() {
    for (const pack of this.getActivePackages()) {
      if (pack.getType() !== "theme" && typeof pack.reloadStylesheets === "function") {
        pack.reloadStylesheets();
      }
    }
  }

  isBundledPackagePath(packagePath) {
    if (this.devMode && !this.resourcePath.startsWith(`${process.resourcesPath}${path.sep}`)) {
      return false;
    }

    if (this.resourcePathWithTrailingSlash == null) {
      this.resourcePathWithTrailingSlash = `${this.resourcePath}${path.sep}`;
    }

    return packagePath != null && packagePath.startsWith(this.resourcePathWithTrailingSlash);
  }

  loadPackageMetadata(packagePathOrAvailablePackage, ignoreErrors = false) {
    let isBundled, packageName, packagePath;
    if (typeof packagePathOrAvailablePackage === "object") {
      const availablePackage = packagePathOrAvailablePackage;
      packageName = availablePackage.name;
      packagePath = availablePackage.path;
      isBundled = availablePackage.isBundled;
    } else {
      packagePath = packagePathOrAvailablePackage;
      packageName = path.basename(packagePath);
      isBundled = this.isBundledPackagePath(packagePath);
    }

    const manifest = this.readPackageManifest(packagePath, isBundled);
    if (manifest.error != null && !ignoreErrors) {
      throw manifest.error;
    }

    const metadata = manifest.metadata;
    if (typeof metadata.name !== "string" || metadata.name.length <= 0) {
      // A manifest that declares no name falls back to the directory it lives
      // in. That fallback is the only thing the directory name still decides.
      metadata.name = packageName;
    }

    if (
      metadata.repository &&
      metadata.repository.type === "git" &&
      typeof metadata.repository.url === "string"
    ) {
      metadata.repository.url = metadata.repository.url.replace(/(^git\+)|(\.git$)/g, "");
    }

    return metadata;
  }

  normalizePackageMetadata(metadata) {
    if (metadata != null) {
      normalizePackageData = normalizePackageData || require("normalize-package-data");
      normalizePackageData(metadata);
    }
  }
};
