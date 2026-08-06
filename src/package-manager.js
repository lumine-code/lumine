const path = require("path");
let normalizePackageData = null;

const _ = require("@lumine-code/underscore-plus");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const fs = require("@lumine-code/fs-plus");
const CSON = require("@lumine-code/season");

const ServiceHub = require("./service-hub");
const Package = require("./package");
const ThemePackage = require("./theme-package");
const { scanBundledPackageNames } = require("./bundled-packages");
const packageJSON = require("../package.json");

// Extended: Package manager for coordinating the lifecycle of Lumine packages.
//
// An instance of this class is always available as the `atom.packages` global.
//
// Packages can be loaded, activated, and deactivated, and unloaded:
//  * Loading a package reads and parses the package's metadata and resources
//    such as keymaps, menus, stylesheets, etc.
//  * Activating a package registers the loaded resources and calls `activate()`
//    on the package's main module.
//  * Deactivating a package unregisters the package's resources  and calls
//    `deactivate()` on the package's main module.
//  * Unloading a package removes it completely from the package manager.
//
// Packages can be enabled/disabled via the `core.disabledPackages` config
// settings and also by calling `enablePackage()/disablePackage()`.
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
    this.activationHookEmitter = new Emitter();
    this.packageDirPaths = [];
    this.packageManifestCache = new Map();
    this.deferredActivationHooks = [];
    this.triggeredActivationHooks = new Set();
    this.packagesCache = packageJSON._atomPackages != null ? packageJSON._atomPackages : {};
    this.bundledPackageNames = null;
    this.initialPackagesLoaded = false;
    this.initialPackagesActivated = false;
    this.loadedPackages = {};
    this.activePackages = {};
    this.activatingPackages = {};
    this.packageStates = {};
    this.themePackRegistrationsByPackageName = new Map();
    this.serviceHub = new ServiceHub();

    this.packageActivators = [];
    this.registerPackageActivator(this, ["atom", "textmate"]);
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
    await this.deactivatePackages();
    this.packageManifestCache.clear();
    this.loadedPackages = {};
    this.packageStates = {};
    this.themePackRegistrationsByPackageName.clear();
    this.packagesCache = packageJSON._atomPackages != null ? packageJSON._atomPackages : {};
    this.bundledPackageNames = null;
    this.triggeredActivationHooks.clear();
    this.activatePromise = null;
  }

  /*
  Section: Event Subscription
  */

  // Public: Invoke the given callback when all packages have been loaded.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidLoadInitialPackages(callback) {
    return this.emitter.on("did-load-initial-packages", callback);
  }

  // Public: Invoke the given callback when all packages have been activated.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidActivateInitialPackages(callback) {
    return this.emitter.on("did-activate-initial-packages", callback);
  }

  getActivatePromise() {
    if (this.activatePromise) {
      return this.activatePromise;
    } else {
      return Promise.resolve();
    }
  }

  // Public: Invoke the given callback when a package is activated.
  //
  // * `callback` A {Function} to be invoked when a package is activated.
  //   * `package` The {Package} that was activated.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidActivatePackage(callback) {
    return this.emitter.on("did-activate-package", callback);
  }

  // Public: Invoke the given callback when a package is deactivated.
  //
  // * `callback` A {Function} to be invoked when a package is deactivated.
  //   * `package` The {Package} that was deactivated.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidDeactivatePackage(callback) {
    return this.emitter.on("did-deactivate-package", callback);
  }

  // Public: Invoke the given callback when a package is loaded.
  //
  // * `callback` A {Function} to be invoked when a package is loaded.
  //   * `package` The {Package} that was loaded.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidLoadPackage(callback) {
    return this.emitter.on("did-load-package", callback);
  }

  // Public: Invoke the given callback when a package is unloaded.
  //
  // * `callback` A {Function} to be invoked when a package is unloaded.
  //   * `package` The {Package} that was unloaded.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidUnloadPackage(callback) {
    return this.emitter.on("did-unload-package", callback);
  }

  /*
  Section: Package system data
  */

  // Public: Get the paths being used to look for packages.
  //
  // Returns an {Array} of {String} directory paths.
  getPackageDirPaths() {
    return _.clone(this.packageDirPaths);
  }

  /*
  Section: General package data
  */

  // Public: Resolve the given package name to a path on disk.
  //
  // * `name` - The {String} package name.
  //
  // Return a {String} folder path or undefined if it could not be resolved.
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
      nameSource: manifest.name ? "manifest" : "dirname",
      error: manifest.error,
    };
  }

  // Public: Is the package with the given name bundled with Lumine?
  //
  // * `name` - The {String} package name.
  //
  // Returns a {Boolean}.
  isBundledPackage(name) {
    return this.getBundledPackageNames().has(name);
  }

  /*
  Section: Enabling and disabling packages
  */

  // Public: Enable the package with the given name.
  //
  // * `name` - The {String} package name.
  //
  // Returns the {Package} that was enabled or null if it isn't loaded.
  enablePackage(name) {
    const pack = this.loadPackage(name);
    if (pack != null) {
      pack.enable();
    }
    return pack;
  }

  // Public: Disable the package with the given name.
  //
  // * `name` - The {String} package name.
  //
  // Returns the {Package} that was disabled or null if it isn't loaded.
  disablePackage(name) {
    const pack = this.loadPackage(name);
    if (!this.isPackageDisabled(name) && pack != null) {
      pack.disable();
    }
    return pack;
  }

  // Public: Is the package with the given name disabled?
  //
  // * `name` - The {String} package name.
  //
  // Returns a {Boolean}.
  isPackageDisabled(name) {
    return _.include(this.config.get("core.disabledPackages") || [], name);
  }

  /*
  Section: Accessing active packages
  */

  // Public: Get an {Array} of all the active {Package}s.
  getActivePackages() {
    return _.values(this.activePackages);
  }

  // Public: Get the active {Package} with the given name.
  //
  // * `name` - The {String} package name.
  //
  // Returns a {Package} or undefined.
  getActivePackage(name) {
    return this.activePackages[name];
  }

  // Public: Is the {Package} with the given name active?
  //
  // * `name` - The {String} package name.
  //
  // Returns a {Boolean}.
  isPackageActive(name) {
    return this.getActivePackage(name) != null;
  }

  // Public: Returns a {Boolean} indicating whether package activation has occurred.
  hasActivatedInitialPackages() {
    return this.initialPackagesActivated;
  }

  /*
  Section: Accessing loaded packages
  */

  // Public: Get an {Array} of all the loaded {Package}s
  getLoadedPackages() {
    return _.values(this.loadedPackages);
  }

  // Get packages for a certain package type
  //
  // * `types` an {Array} of {String}s like ['atom', 'textmate'].
  getLoadedPackagesForTypes(types) {
    return this.getLoadedPackages().filter((p) => types.includes(p.getType()));
  }

  // Public: Get the loaded {Package} with the given name.
  //
  // * `name` - The {String} package name.
  //
  // Returns a {Package} or undefined.
  getLoadedPackage(name) {
    return this.loadedPackages[name];
  }

  // Public: Is the package with the given name loaded?
  //
  // * `name` - The {String} package name.
  //
  // Returns a {Boolean}.
  isPackageLoaded(name) {
    return this.getLoadedPackage(name) != null;
  }

  // Public: Returns a {Boolean} indicating whether package loading has occurred.
  hasLoadedInitialPackages() {
    return this.initialPackagesLoaded;
  }

  /*
  Section: Accessing available packages
  */

  // Public: Returns an {Array} of {String}s of all the available package paths.
  getAvailablePackagePaths() {
    return this.getAvailablePackages().map((a) => a.path);
  }

  // Public: Returns an {Array} of {String}s of all the available package names.
  getAvailablePackageNames() {
    return this.getAvailablePackages().map((a) => a.name);
  }

  // Public: Returns an {Array} of {String}s of all the available package metadata.
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

  // Public: Returns the available packages that own their name.
  //
  // * `options` (optional) {Object}
  //   * `includeShadowed` When `true`, also returns the copies whose name is
  //     owned by another directory. Those never load; they exist so the UI can
  //     list every directory on disk.
  //
  // Returns an {Array} of package descriptors sorted by name.
  getAvailablePackages(options) {
    const packages = this.scanAvailablePackages();
    const visible =
      options != null && options.includeShadowed ? packages : packages.filter((p) => p.isWinner);
    return visible.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  // Public: Get the available package that owns the given name.
  //
  // Returns a package descriptor or undefined.
  getAvailablePackage(name) {
    return this.scanAvailablePackages().find((pack) => pack.isWinner && pack.name === name);
  }

  // Public: Forget everything read from package manifests.
  //
  // The directory scan itself always runs fresh, so this only has to be called
  // when a manifest changes on disk — after an install, update, or uninstall.
  refreshPackageIndex() {
    this.packageManifestCache.clear();
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

  /*
  Section: Private
  */

  getPackageState(name) {
    return this.packageStates[name];
  }

  setPackageState(name, state) {
    this.packageStates[name] = state;
  }

  // The names of the packages that ship with the editor. In a packaged build
  // the baked _atomPackages metadata is the authority (generated by the same
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
          if (this.getActivePackage(name)) this.deactivatePackage(name);
        });
        packagesToEnable.forEach((name) => this.activatePackage(name));
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

  loadPackages() {
    // Ensure atom exports is already in the require cache so the load time
    // of the first package isn't skewed by being the first to require atom
    require("../exports/atom");

    const disabledPackageNames = new Set(this.config.get("core.disabledPackages"));
    this.config.transact(() => {
      for (const pack of this.getAvailablePackages()) {
        this.loadAvailablePackage(pack, disabledPackageNames);
      }
    });
    this.initialPackagesLoaded = true;
    this.emitter.emit("did-load-initial-packages");
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
  // * `name` - The {String} package name.
  // * `options` (optional) {Object}
  //   * `activate` Whether the new copy should be activated. Defaults to
  //     activating whenever the copy being replaced was active.
  //
  // Returns a {Promise} that resolves with the loaded {Package}, or null when
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

    const wasActive = loadedPackage != null && this.isPackageActive(name);
    if (loadedPackage != null) {
      await this.deactivatePackage(name);
      this.unloadPackage(name);
    }

    if (availablePackage == null) return null;

    const pack = this.loadAvailablePackage(availablePackage);
    if (pack == null) return null;

    const shouldActivate = options.activate != null ? options.activate : wasActive;
    if (shouldActivate && !this.isPackageDisabled(name)) {
      // Deferred-activation packages resolve this promise only once their hook
      // fires, so callers are never made to wait on it.
      this.activatePackage(name).catch((error) => {
        console.warn(`Failed to activate the '${name}' package: ${error.message}`);
      });
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
    this.registerThemePacksFromPackage(pack);
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
      this.emitter.emit("did-load-package", pack);
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

  unloadPackages() {
    _.keys(this.loadedPackages).forEach((name) => this.unloadPackage(name));
  }

  unloadPackage(name) {
    if (this.isPackageActive(name)) {
      throw new Error(`Tried to unload active package '${name}'`);
    }

    const pack = this.getLoadedPackage(name);
    if (pack) {
      this.unregisterThemePacksForPackage(pack.name);
      delete this.loadedPackages[pack.name];
      this.emitter.emit("did-unload-package", pack);
    } else {
      throw new Error(`No loaded package for name '${name}'`);
    }
  }

  // Activate all the packages that should be activated.
  activate() {
    let promises = [];
    for (let [activator, types] of this.packageActivators) {
      const packages = this.getLoadedPackagesForTypes(types);
      promises = promises.concat(activator.activatePackages(packages));
    }
    this.activatePromise = Promise.all(promises).then(() => {
      this.triggerDeferredActivationHooks();
      this.initialPackagesActivated = true;
      this.emitter.emit("did-activate-initial-packages");
      this.activatePromise = null;
    });
    return this.activatePromise;
  }

  registerURIHandlerForPackage(packageName, handler) {
    return this.uriHandlerRegistry.registerHostHandler(packageName, handler);
  }

  // another type of package manager can handle other package types.
  // See ThemeManager
  registerPackageActivator(activator, types) {
    this.packageActivators.push([activator, types]);
  }

  activatePackages(packages) {
    const promises = [];
    this.config.transactAsync(() => {
      for (const pack of packages) {
        const promise = this.activatePackage(pack.name);
        if (!pack.activationShouldBeDeferred()) {
          promises.push(promise);
        }
      }
      return Promise.all(promises);
    });
    this.observeDisabledPackages();
    this.observePackagesWithKeymapsDisabled();
    return promises;
  }

  // Activate a single package by name
  activatePackage(name) {
    let pack = this.getActivePackage(name);
    if (pack) {
      return Promise.resolve(pack);
    }

    // Respect the user's `core.disabledPackages` choice. The batch load path
    // (loadPackages) filters disabled packages out before they can be
    // activated, but a direct activatePackage() call routes through the
    // singular loadPackage(), which does not, so guard it here.
    if (this.isPackageDisabled(name)) {
      return Promise.reject(new Error(`Cannot activate disabled package '${name}'`));
    }

    pack = this.loadPackage(name);
    if (!pack) {
      return Promise.reject(new Error(`Failed to load package '${name}'`));
    }

    this.registerThemePacksFromPackage(pack);
    this.activatingPackages[pack.name] = pack;
    const activationPromise = pack.activate().then(() => {
      if (this.activatingPackages[pack.name] != null) {
        delete this.activatingPackages[pack.name];
        this.activePackages[pack.name] = pack;
        this.emitter.emit("did-activate-package", pack);
      }
      return pack;
    });

    if (this.deferredActivationHooks == null) {
      this.triggeredActivationHooks.forEach((hook) => this.activationHookEmitter.emit(hook));
    }

    return activationPromise;
  }

  triggerDeferredActivationHooks() {
    if (this.deferredActivationHooks == null) {
      return;
    }

    for (const hook of this.deferredActivationHooks) {
      this.activationHookEmitter.emit(hook);
    }

    this.deferredActivationHooks = null;
  }

  triggerActivationHook(hook) {
    if (hook == null || !_.isString(hook) || hook.length <= 0) {
      return new Error("Cannot trigger an empty activation hook");
    }

    this.triggeredActivationHooks.add(hook);
    if (this.deferredActivationHooks != null) {
      this.deferredActivationHooks.push(hook);
    } else {
      this.activationHookEmitter.emit(hook);
    }
  }

  onDidTriggerActivationHook(hook, callback) {
    if (hook == null || !_.isString(hook) || hook.length <= 0) {
      return;
    }
    return this.activationHookEmitter.on(hook, callback);
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

  // Deactivate all packages
  async deactivatePackages() {
    await this.config.transactAsync(() =>
      Promise.all(this.getLoadedPackages().map((pack) => this.deactivatePackage(pack.name, true))),
    );
    this.unobserveDisabledPackages();
    this.unobservePackagesWithKeymapsDisabled();
  }

  // Deactivate the package with the given name
  async deactivatePackage(name, suppressSerialization) {
    const pack = this.getLoadedPackage(name);
    if (pack == null) {
      return;
    }

    if (!suppressSerialization && this.isPackageActive(pack.name)) {
      this.serializePackage(pack);
    }

    this.unregisterThemePacksForPackage(pack.name);
    const deactivationResult = pack.deactivate();
    if (deactivationResult && typeof deactivationResult.then === "function") {
      await deactivationResult;
    }

    delete this.activePackages[pack.name];
    delete this.activatingPackages[pack.name];
    this.emitter.emit("did-deactivate-package", pack);
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
