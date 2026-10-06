const path = require("path");
const asyncEach = require("async/each");
const CSON = require("@lumine-code/season");
const fs = require("@lumine-code/fs-plus");
const { Disposable, Emitter, CompositeDisposable } = require("@lumine-code/event-kit");
const dedent = require("dedent");

const CompileCache = require("./compile-cache");
const ModuleCache = require("./module-cache");
const BufferedProcess = require("./buffered-process");
const { requireModule } = require("./module-utils");
const {
  appendLifecycleError,
  awaitLifecycleCleanup,
  captureLifecycleError,
  combineLifecycleErrors,
  isLifecycleErrorReported,
  markLifecycleErrorReported,
  throwLifecycleErrors,
} = require("./package-lifecycle-errors");
// Lists a directory, carrying each entry's type with it. The native-module walk
// below asks "what is in here, and which of those are directories" for every
// module in every package's dependency tree, and answers it here in one syscall
// per directory rather than a stat per entry — the overwhelming majority of
// which used to be spent on `build/Release` and nested `node_modules` paths that
// do not exist. A missing or unreadable directory lists as empty.
function readdirEntries(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * @public
 * @status extended
 *
 * Loads and activates a package's main module and resources such as
 * stylesheets, keymaps, grammar, editor properties, and menus.
 */
module.exports = class Package {
  /**
   * @category Construction
   */

  constructor(params) {
    this.config = params.config;
    this.packageManager = params.packageManager;
    this.styleManager = params.styleManager;
    this.commandRegistry = params.commandRegistry;
    this.keymapManager = params.keymapManager;
    this.notificationManager = params.notificationManager;
    this.grammarRegistry = params.grammarRegistry;
    this.themeManager = params.themeManager;
    this.menuManager = params.menuManager;
    this.contextMenuManager = params.contextMenuManager;
    this.deserializerManager = params.deserializerManager;
    this.viewRegistry = params.viewRegistry;
    this.emitter = new Emitter();

    this.mainModule = null;
    this.path = params.path;
    this.packageRootEntries = params.packageRootEntries;
    this.metadata = params.metadata || this.packageManager.loadPackageMetadata(this.path);
    this.bundledPackage =
      params.bundledPackage != null
        ? params.bundledPackage
        : this.packageManager.isBundledPackagePath(this.path);
    this.name = (this.metadata && this.metadata.name) || params.name || path.basename(this.path);
    this.reset();
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when this package has been deactivated.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDeactivate(callback) {
    return this.emitter.on("did-deactivate", callback);
  }

  /**
   * @category Instance Methods
   */

  enable() {
    const disabledPackages = this.config.get("core.disabledPackages") || [];
    return this.config.set(
      "core.disabledPackages",
      disabledPackages.filter((name) => name !== this.name),
    );
  }

  disable() {
    const disabledPackages = this.config.get("core.disabledPackages") || [];
    if (disabledPackages.includes(this.name)) return false;
    return this.config.set("core.disabledPackages", [...disabledPackages, this.name]);
  }

  isTheme() {
    return this.metadata && this.metadata.theme;
  }

  measure(key, fn) {
    const startTime = window.performance.now();
    const value = fn();
    this[key] = Math.round(window.performance.now() - startTime);
    return value;
  }

  measureAsync(key, fn) {
    const startTime = window.performance.now();
    try {
      return Promise.resolve(fn()).then(
        (value) => {
          this[key] = Math.round(window.performance.now() - startTime);
          return value;
        },
        (error) => {
          this[key] = Math.round(window.performance.now() - startTime);
          throw error;
        },
      );
    } catch (error) {
      this[key] = Math.round(window.performance.now() - startTime);
      throw error;
    }
  }

  getType() {
    return "lumine";
  }

  getStyleSheetPriority() {
    return 0;
  }

  load() {
    this.measure("loadTime", () => {
      try {
        this.loadScopeActive = true;
        this.validateActivationMetadata();
        ModuleCache.add(this.path, this.metadata);
        this.moduleCacheRegistered = true;

        this.loadKeymaps();
        this.loadMenus();
        this.loadStylesheets();
        this.registerDeserializerMethods();
        this.registerViewProviders();
        this.activateCoreStartupServices();
        this.configSchemaRegisteredOnLoad = this.registerConfigSchemaFromMetadata();
        const settingsLoad = {
          generation: ++this.settingsLoadGeneration,
          cancelled: false,
        };
        this.settingsLoad = settingsLoad;
        this.settingsPromise = this.measureAsync("settingsLoadTime", () =>
          this.loadSettings(settingsLoad),
        ).finally(() => {
          if (this.settingsLoad === settingsLoad) this.settingsLoad = null;
        });
        if (this.shouldRequireMainModuleOnLoad() && this.mainModule == null) {
          this.requireMainModule();
          this.configSchemaRegisteredOnActivate ||= this.registerConfigSchemaFromMainModule();
        }
      } catch (error) {
        this.loadScopeActive = false;
        this.loadError = error;
        markLifecycleErrorReported(error);
        this.handleError(`Failed to load the ${this.name} package`, error);
      }
    });
    return this;
  }

  validateActivationMetadata() {
    if (
      this.metadata.requiresRestartOnUpdate != null &&
      typeof this.metadata.requiresRestartOnUpdate !== "boolean"
    ) {
      this.throwManifestError("requiresRestartOnUpdate must be a boolean");
    }
    if (
      this.metadata.providedServices != null &&
      (typeof this.metadata.providedServices !== "object" ||
        Array.isArray(this.metadata.providedServices))
    ) {
      this.throwManifestError("providedServices must be an object");
    }
    for (const [name, descriptor] of Object.entries(this.metadata.providedServices || {})) {
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        this.throwManifestError(`providedServices[${JSON.stringify(name)}] must be an object`);
      }
    }

    if (
      this.metadata.consumedServices != null &&
      (typeof this.metadata.consumedServices !== "object" ||
        Array.isArray(this.metadata.consumedServices))
    ) {
      this.throwManifestError("consumedServices must be an object");
    }
    for (const [name, descriptor] of Object.entries(this.metadata.consumedServices || {})) {
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        this.throwManifestError(`consumedServices[${JSON.stringify(name)}] must be an object`);
      }
    }

    const uriHandler = this.metadata.uriHandler;
    if (uriHandler != null) {
      if (!uriHandler || typeof uriHandler !== "object" || Array.isArray(uriHandler)) {
        this.throwManifestError("uriHandler must be an object");
      }
      if (typeof uriHandler.method !== "string" || uriHandler.method.length === 0) {
        this.throwManifestError("uriHandler.method must be a non-empty string");
      }
    }
  }

  throwManifestError(message) {
    const metadataPath = path.join(this.path, "package.json");
    const error = new TypeError(`${message} in ${metadataPath}`);
    error.stack += `\n  at ${metadataPath}:1:1`;
    throw error;
  }

  unload({ preserveModuleCache = false } = {}) {
    this.loadScopeActive = false;
    const deserializers = this.deserializerDisposables;
    const views = this.viewProviderDisposables;
    const startupServices = this.coreStartupServiceDisposables;
    const hasSchema = this.configSchemaRegisteredOnLoad || this.configSchemaRegisteredOnActivate;
    const hasModuleCache = this.moduleCacheRegistered;
    this.deserializerDisposables = null;
    this.viewProviderDisposables = null;
    this.coreStartupServiceDisposables = null;
    this.registeredViewProviders = false;
    this.configSchemaRegisteredOnLoad = false;
    this.configSchemaRegisteredOnActivate = false;
    this.moduleCacheRegistered = false;
    const failures = [];
    const cleanup = [
      () => this.disposeActivationEntryPoints(),
      () => this.deactivateResources(),
      () => this.disposeInitializationScope(),
      () => this.deactivateKeymaps(),
      () => deserializers?.dispose(),
      () => views?.dispose(),
      () => startupServices?.dispose(),
      () => {
        if (hasSchema) this.config.unsetSchema(this.name);
      },
      () => {
        if (hasModuleCache) ModuleCache.remove(this.path);
      },
      () => {
        if (hasModuleCache && !preserveModuleCache) this.clearRequireCache();
      },
    ];
    for (const dispose of cleanup) {
      captureLifecycleError(failures, dispose);
    }
    throwLifecycleErrors(failures, `Package '${this.name}' failed to unload cleanly`);
  }

  clearRequireCache() {
    if (typeof this.path !== "string" || this.path.length === 0) return;
    const roots = new Set([path.resolve(this.path)]);
    try {
      roots.add(fs.realpathSync(this.path));
    } catch {
      // An uninstall can remove the directory before final teardown. The
      // configured package path still identifies cache entries in that case.
    }
    for (const modulePath of Object.keys(require.cache)) {
      if (
        [...roots].some(
          (root) => modulePath === root || modulePath.startsWith(`${root}${path.sep}`),
        )
      ) {
        delete require.cache[modulePath];
      }
    }
  }

  shouldRequireMainModuleOnLoad() {
    // Main modules are required by PackageManager's explicit initialize phase
    // after every package has been loaded. The sole exception is the core
    // directory-provider service, which Project needs while package metadata is
    // still being wired during load.
    return Boolean(
      this.metadata.providedServices?.["project.directory-provider"] &&
      this.metadata.providedServices["project.directory-provider"].versions,
    );
  }

  reset() {
    this.stylesheets = [];
    this.keymaps = [];
    this.menus = [];
    this.grammars = [];
    this.settings = [];
    this.mainInitialized = false;
    this.mainActivated = false;
    this.mainActivationStarted = false;
    this.settingsLoadGeneration = 0;
    this.settingsLoad = null;
    this.settingsPromise = null;
    this.resourceLoadPromise = null;
    this.initializationDisposables = null;
    this.hooks = null;
    this.lifecycleState = "loaded";
  }

  prepareToUnload() {
    this.loadScopeActive = false;
    if (this.settingsLoad) this.settingsLoad.cancelled = true;
    return Promise.allSettled([
      this.settingsPromise,
      this.grammarsPromise,
      this.resourceLoadPromise,
    ]).then(() => {});
  }

  initializeIfNeeded(context = {}) {
    if (this.mainInitialized) return;
    const initializationDisposables = new CompositeDisposable();
    this.initializationDisposables = initializationDisposables;
    const hooks = {
      on: (...args) => {
        if (this.initializationDisposables !== initializationDisposables) return new Disposable();
        const disposable = this.packageManager.hooks.on(...args);
        if (this.initializationDisposables === initializationDisposables) {
          initializationDisposables.add(disposable);
        } else {
          disposable.dispose();
        }
        return disposable;
      },
      when: (...args) => this.packageManager.hooks.when(...args),
      hasOccurred: (...args) => this.packageManager.hooks.hasOccurred(...args),
      value: (...args) => this.packageManager.hooks.value(...args),
    };
    this.hooks = hooks;
    try {
      this.measure("initializeTime", () => {
        // The main module's `initialize()` method is guaranteed to be called
        // before its `activate()`. Initialization failure is activation failure;
        // it must propagate to PackageManager instead of publishing a half-ready
        // package after handleError merely displayed a notification.
        if (!this.mainModule) this.requireMainModule();
        this.configSchemaRegisteredOnActivate ||= this.registerConfigSchemaFromMainModule();
        if (this.mainModule && typeof this.mainModule.initialize === "function") {
          const result = this.mainModule.initialize(
            this.packageManager.getPackageState(this.name) || {},
            {
              package: this,
              packageManager: this.packageManager,
              hooks,
              services: this.packageManager.serviceHub,
              subscriptions: initializationDisposables,
              ...context,
            },
          );
          if (result && typeof result.then === "function") {
            result.catch(() => {});
            throw new TypeError(
              `The ${this.name} package initialize() hook must be synchronous; ` +
                "move asynchronous work behind an ensure method",
            );
          }
        }
        this.mainInitialized = true;
      });
    } catch (error) {
      const failures = [];
      appendLifecycleError(failures, error);
      if (this.initializationDisposables === initializationDisposables) {
        this.initializationDisposables = null;
        this.hooks = null;
      }
      captureLifecycleError(failures, () => initializationDisposables.dispose());
      throwLifecycleErrors(failures, `Package '${this.name}' initialization and cleanup failed`);
    }
  }

  initializeForExternalUse(context) {
    const initializationContext =
      context && typeof context === "object" ? context : { reason: context };
    const reason = initializationContext.reason || "external use";
    try {
      return this.initializeIfNeeded(initializationContext);
    } catch (error) {
      markLifecycleErrorReported(error);
      try {
        this.handleError(`Failed to initialize the ${this.name} package for ${reason}`, error);
      } catch (reportError) {
        if (!Object.is(reportError, error)) {
          const failures = [];
          appendLifecycleError(failures, error);
          appendLifecycleError(failures, reportError);
          const failure = combineLifecycleErrors(
            failures,
            `Package '${this.name}' initialization reporting failed`,
          );
          markLifecycleErrorReported(failure);
          throw failure;
        }
      }
      throw error;
    }
  }

  /**
   * Invoke the package main module's synchronous activation contract. Main
   * modules receive their serialized state first and `{signal, cause}` second.
   * Activation is the lightweight public bootstrap: commands, openers,
   * services and resource registrations must be ready before this method
   * returns. Expensive work belongs behind a package-owned `ensure` method.
   *
   * Grammar and settings discovery may continue in the background; they are
   * package resources, not activation gates.
   *
   * @private
   */
  activateMain({ signal, cause } = {}) {
    if (this.loadError) throw this.loadError;
    if (!this.grammarsPromise) {
      this.grammarsPromise = this.measureAsync("grammarLoadTime", () => this.loadGrammars());
    }
    // Grammar and settings discovery runs concurrently with activation, but it
    // is not package activation itself. Keep it outside this measurement so a
    // grammar-only package does not report its parser load time as activation
    // time. Do not put the synchronous prologue in an async callback: doing so
    // would defer the measurement's completion to a microtask, allowing every
    // later package in the initial batch to be charged to this package. Only
    // an actual Promise returned by main.activate() may extend the measurement.
    const activationStartTime = window.performance.now();
    try {
      this.activateResources();
      this.registerURIHandler();
      if (!this.mainModule) this.requireMainModule();
      this.configSchemaRegisteredOnActivate ||= this.registerConfigSchemaFromMainModule();
      this.registerViewProviders();
      this.activateStylesheets();

      if (this.mainModule && !this.mainActivated) {
        this.initializeIfNeeded();
        this.mainActivationStarted = true;
        if (typeof this.mainModule.activateConfig === "function") {
          this.mainModule.activateConfig();
        }

        let activationResult;
        if (typeof this.mainModule.activate === "function") {
          activationResult = this.mainModule.activate(
            this.packageManager.getPackageState(this.name) || {},
            {
              signal,
              cause,
              hooks: this.hooks,
              services: this.packageManager.serviceHub,
              subscriptions: this.initializationDisposables,
            },
          );
        }

        if (activationResult && typeof activationResult.then === "function") {
          // The package hook is a synchronous bootstrap contract. Attach a
          // rejection handler before throwing so a rejected async hook cannot
          // become an unhandled renderer rejection after the synchronous error
          // has already rolled the package back. Do this before wiring
          // consumed services: an async hook must not publish a half-bootstrap.
          activationResult.catch?.(() => {});
          throw new TypeError(
            `The ${this.name} package activate() hook must be synchronous; ` +
              "move asynchronous work behind an ensure method",
          );
        }
        // Services are connected as part of the synchronous bootstrap. A
        // provider publishes only its lightweight facade; expensive service
        // methods remain lazy and may return promises themselves.
        this.activateConsumedServices();
        this.mainActivated = true;
        this.activateProvidedServices();
      }
    } catch (error) {
      this.activateTime = Math.round(window.performance.now() - activationStartTime);
      throw error;
    }
    this.activateTime = Math.round(window.performance.now() - activationStartTime);

    const resourceLoads = [this.grammarsPromise, this.settingsPromise].filter(Boolean);
    if (resourceLoads.length > 0) {
      this.resourceLoadPromise = Promise.all(resourceLoads).catch((error) => {
        const failures = [];
        appendLifecycleError(failures, error);
        if (!isLifecycleErrorReported(error)) {
          markLifecycleErrorReported(error);
          try {
            this.handleError(`Failed to finish loading the ${this.name} package resources`, error);
          } catch (reportError) {
            // Spec-mode handleError rethrows the very failure it reports.
            if (!Object.is(reportError, error)) appendLifecycleError(failures, reportError);
          }
        }
        const failure = combineLifecycleErrors(
          failures,
          `Package '${this.name}' resource reporting failed`,
        );
        markLifecycleErrorReported(failure);
        throw failure;
      });
      this.resourceLoadPromise.catch(() => {});
    }
    return this;
  }

  registerConfigSchemaFromMetadata() {
    const configSchema = this.metadata.configSchema;
    if (configSchema) {
      this.config.setSchema(this.name, {
        type: "object",
        properties: configSchema,
      });
      return true;
    } else {
      return false;
    }
  }

  registerConfigSchemaFromMainModule() {
    if (
      this.mainModule &&
      !this.configSchemaRegisteredOnLoad &&
      !this.configSchemaRegisteredOnActivate
    ) {
      if (typeof this.mainModule.config === "object") {
        this.config.setSchema(this.name, {
          type: "object",
          properties: this.mainModule.config,
        });
        return true;
      }
    }
    return false;
  }

  activateStylesheets() {
    if (this.stylesheetsActivated) return;

    this.stylesheetDisposables = new CompositeDisposable();

    const priority = this.getStyleSheetPriority();
    for (let [sourcePath, source] of this.stylesheets) {
      const match = path.basename(sourcePath).match(/[^.]*\.([^.]*)\./);

      let context;
      if (match) {
        context = match[1];
      } else if (this.metadata.theme === "syntax") {
        context = "lumine-text-editor";
      }

      this.stylesheetDisposables.add(
        this.styleManager.addStyleSheet(source, {
          sourcePath,
          priority,
          context,
        }),
      );
    }

    this.stylesheetsActivated = true;
  }

  activateResources() {
    if (!this.activationDisposables) this.activationDisposables = new CompositeDisposable();

    const packagesWithKeymapsDisabled = this.config.get("core.packagesWithKeymapsDisabled");
    if (packagesWithKeymapsDisabled && packagesWithKeymapsDisabled.includes(this.name)) {
      this.deactivateKeymaps();
    } else if (!this.keymapActivated) {
      this.activateKeymaps();
    }

    if (!this.menusActivated) {
      this.activateMenus();
    }

    if (!this.grammarsActivated) {
      // Own the whole attempt before callbacks can fail midway through it.
      this.grammarsActivated = true;
      for (let grammar of this.grammars) {
        grammar.activate();
      }
    }

    if (!this.settingsActivated) {
      this.settingsActivated = true;
      for (let settings of this.settings) {
        settings.activate(this.config);
      }
    }
  }

  activateKeymaps() {
    if (this.keymapActivated) return;

    this.keymapDisposables = new CompositeDisposable();

    const validateSelectors = !this.bundledPackage;
    for (let [keymapPath, map] of this.keymaps) {
      this.keymapDisposables.add(this.keymapManager.add(keymapPath, map, 0, validateSelectors));
    }
    this.menuManager.update();

    this.keymapActivated = true;
  }

  deactivateKeymaps() {
    const keymaps = this.keymapDisposables;
    const wasActivated = this.keymapActivated;
    this.keymapDisposables = null;
    this.keymapActivated = false;
    const failures = [];
    captureLifecycleError(failures, () => keymaps?.dispose());
    if (wasActivated) captureLifecycleError(failures, () => this.menuManager.update());
    throwLifecycleErrors(failures, `Package '${this.name}' keymaps failed to deactivate`);
  }

  hasKeymaps() {
    for (let [, map] of this.keymaps) {
      if (map.length > 0) return true;
    }
    return false;
  }

  activateMenus() {
    const validateSelectors = !this.bundledPackage;
    for (const [menuPath, map] of this.menus) {
      if (map["context-menu"]) {
        try {
          const itemsBySelector = map["context-menu"];
          this.activationDisposables.add(
            this.contextMenuManager.add(itemsBySelector, validateSelectors),
          );
        } catch (error) {
          if (error.code === "EBADSELECTOR") {
            error.message += ` in ${menuPath}`;
            error.stack += `\n  at ${menuPath}:1:1`;
          }
          throw error;
        }
      }
    }

    for (const [, map] of this.menus) {
      if (map.menu) this.activationDisposables.add(this.menuManager.add(map.menu));
    }

    this.menusActivated = true;
  }

  activateConsumedServices() {
    let methodName, name, version, versions;
    // Connect a package's dependencies before publishing anything that may use
    // them. Providing is synchronous and can immediately invoke consumers in
    // other packages, so doing it first exposes a half-wired main module.
    for (name in this.metadata.consumedServices || {}) {
      ({ versions } = this.metadata.consumedServices[name]);
      for (version in versions) {
        methodName = versions[version];
        if (typeof this.mainModule[methodName] === "function") {
          this.activationDisposables.add(
            this.packageManager.serviceHub.consume(
              name,
              version,
              this.mainModule[methodName].bind(this.mainModule),
            ),
          );
        } else {
          console.warn(
            `Package ${this.name} declares it consumes ${name}@${version} but it doesn't expose a function in ${methodName}`,
          );
        }
      }
    }
  }

  activateProvidedServices() {
    let methodName, name, version, versions;
    for (name in this.metadata.providedServices || {}) {
      ({ versions } = this.metadata.providedServices[name]);
      const servicesByVersion = {};
      for (version in versions) {
        methodName = versions[version];
        if (typeof this.mainModule[methodName] === "function") {
          servicesByVersion[version] = this.mainModule[methodName]();
        } else {
          console.warn(
            `Package ${this.name} declares it provides ${name}@${version} but it doesn't expose a function in ${methodName}`,
          );
        }
      }
      this.activationDisposables.add(
        this.packageManager.serviceHub.provide(name, servicesByVersion),
      );
    }
  }

  registerURIHandler() {
    if (this.uriHandlerSubscription) return;
    const handlerConfig = this.getURIHandler();
    const methodName = handlerConfig && handlerConfig.method;
    if (methodName) {
      this.uriHandlerSubscription = this.packageManager.registerURIHandlerForPackage(
        this.name,
        (...args) =>
          typeof this.mainModule?.[methodName] === "function"
            ? this.mainModule[methodName](...args)
            : undefined,
      );
    }
  }

  unregisterURIHandler() {
    const subscription = this.uriHandlerSubscription;
    this.uriHandlerSubscription = null;
    subscription?.dispose();
  }

  loadKeymaps() {
    if (this.bundledPackage && this.packageManager.packagesCache[this.name]) {
      this.keymaps = [];
      for (const keymapPath in this.packageManager.packagesCache[this.name].keymaps) {
        const keymapObject = this.packageManager.packagesCache[this.name].keymaps[keymapPath];
        this.keymaps.push([`core:${keymapPath}`, keymapObject]);
      }
    } else {
      this.keymaps = this.getKeymapPaths().map((keymapPath) => [
        keymapPath,
        CSON.readFileSync(keymapPath, { allowDuplicateKeys: false }) || {},
      ]);
    }
  }

  loadMenus() {
    if (this.bundledPackage && this.packageManager.packagesCache[this.name]) {
      this.menus = [];
      for (const menuPath in this.packageManager.packagesCache[this.name].menus) {
        const menuObject = this.packageManager.packagesCache[this.name].menus[menuPath];
        this.menus.push([`core:${menuPath}`, menuObject]);
      }
    } else {
      this.menus = this.getMenuPaths().map((menuPath) => [
        menuPath,
        CSON.readFileSync(menuPath) || {},
      ]);
    }
  }

  getKeymapPaths() {
    const keymapsDirPath = path.join(this.path, "keymaps");
    if (this.metadata.keymaps) {
      return this.metadata.keymaps.map((name) =>
        fs.resolve(keymapsDirPath, name, ["json", "jsonc", ""]),
      );
    } else if (this.hasPackageRootEntry("keymaps") !== false) {
      return fs.listSync(keymapsDirPath, ["json", "jsonc"]);
    }
    return [];
  }

  getMenuPaths() {
    const menusDirPath = path.join(this.path, "menus");
    if (this.metadata.menus) {
      return this.metadata.menus.map((name) =>
        fs.resolve(menusDirPath, name, ["json", "jsonc", ""]),
      );
    } else if (this.hasPackageRootEntry("menus") !== false) {
      return fs.listSync(menusDirPath, ["json", "jsonc"]);
    }
    return [];
  }

  loadStylesheets() {
    this.stylesheets = this.getStylesheetPaths().map((stylesheetPath) => [
      stylesheetPath,
      this.themeManager.loadStylesheet(stylesheetPath, true),
    ]);
  }

  registerDeserializerMethods() {
    if (this.metadata.deserializers) {
      if (!this.deserializerDisposables) this.deserializerDisposables = new CompositeDisposable();
      Object.keys(this.metadata.deserializers).forEach((deserializerName) => {
        const methodName = this.metadata.deserializers[deserializerName];
        this.deserializerDisposables.add(
          this.deserializerManager.add({
            name: deserializerName,
            deserialize: (state, lumineEnvironment) => {
              if (!this.canUseLoadScopeProxy()) return;
              this.registerViewProviders();
              this.requireMainModule();
              this.configSchemaRegisteredOnActivate ||= this.registerConfigSchemaFromMainModule();
              this.initializeForExternalUse("deserialization");
              // Workspace state is restored before the initial package batch is
              // activated.  Deserialization must be able to construct a
              // lightweight item during that phase without running the
              // package's live `activate()` hook against a half-built DOM.
              // The normal initial activation will pick the package up later;
              // an explicit activation is only needed for deserialization that
              // happens after the initial batch has completed.
              if (this.packageManager.hasActivatedInitialPackages()) {
                this.packageManager
                  .activatePackageInstance(this, null, { type: "deserializer", methodName })
                  .catch((error) => {
                    if (error?.code !== "PACKAGE_ACTIVATION_CANCELLED") {
                      console.error(`Failed to activate '${this.name}' for deserialization`, error);
                    }
                  });
              }
              return this.mainModule[methodName](state, lumineEnvironment);
            },
          }),
        );
      });
    }
  }

  activateCoreStartupServices() {
    const directoryProviderService =
      this.metadata.providedServices &&
      this.metadata.providedServices["project.directory-provider"];
    if (directoryProviderService) {
      this.requireMainModule();
      const servicesByVersion = {};
      for (let version in directoryProviderService.versions) {
        const methodName = directoryProviderService.versions[version];
        if (typeof this.mainModule[methodName] === "function") {
          servicesByVersion[version] = this.mainModule[methodName]();
        }
      }
      if (!this.coreStartupServiceDisposables) {
        this.coreStartupServiceDisposables = new CompositeDisposable();
      }
      this.coreStartupServiceDisposables.add(
        this.packageManager.serviceHub.provide("project.directory-provider", servicesByVersion),
      );
    }
  }

  registerViewProviders() {
    if (this.metadata.viewProviders && !this.registeredViewProviders) {
      this.viewProviderDisposables = new CompositeDisposable();
      this.metadata.viewProviders.forEach((methodName) => {
        this.viewProviderDisposables.add(
          this.viewRegistry.addViewProvider((model) => {
            if (!this.canUseLoadScopeProxy()) return;
            this.requireMainModule();
            this.configSchemaRegisteredOnActivate ||= this.registerConfigSchemaFromMainModule();
            this.initializeForExternalUse("a view provider");
            // A view provider is also used while workspace state is restored,
            // before the initial package batch has run.  Keep that path a
            // facade-only load; the regular initial activation owns the live
            // package transition.  Once startup is complete, a provider call
            // is an explicit use and may activate its owner immediately.
            if (this.packageManager.hasActivatedInitialPackages()) {
              this.packageManager
                .activatePackageInstance(this, null, { type: "view-provider", methodName })
                .catch((error) => {
                  if (error?.code !== "PACKAGE_ACTIVATION_CANCELLED") {
                    console.error(`Failed to activate '${this.name}' for a view provider`, error);
                  }
                });
            }
            return this.mainModule[methodName](model);
          }),
        );
      });
      this.registeredViewProviders = true;
    }
  }

  canUseLoadScopeProxy() {
    const lifecycleState = this.packageManager.getPackageLifecycleState(this.name);
    const currentPackage = this.packageManager.getLoadedPackage(this.name);
    return (
      this.loadScopeActive &&
      (currentPackage == null || currentPackage === this) &&
      !this.packageManager.isPackageDisabled(this.name) &&
      lifecycleState !== "deactivating" &&
      lifecycleState !== "unloaded"
    );
  }

  getStylesheetsPath() {
    return path.join(this.path, "styles");
  }

  getStylesheetPaths() {
    if (
      this.bundledPackage &&
      this.packageManager.packagesCache[this.name] &&
      this.packageManager.packagesCache[this.name].styleSheetPaths
    ) {
      const { styleSheetPaths } = this.packageManager.packagesCache[this.name];
      return styleSheetPaths.map((styleSheetPath) => path.join(this.path, styleSheetPath));
    } else {
      let indexStylesheet;
      const stylesheetDirPath = this.getStylesheetsPath();
      if (this.metadata.mainStyleSheet) {
        return [fs.resolve(this.path, this.metadata.mainStyleSheet)];
      } else if (this.metadata.styleSheets) {
        return this.metadata.styleSheets.map((name) =>
          fs.resolve(stylesheetDirPath, name, ["css", ""]),
        );
      } else if (
        this.hasPackageRootEntry("index.css") !== false &&
        (indexStylesheet = fs.resolve(this.path, "index", ["css"]))
      ) {
        return [indexStylesheet];
      } else if (this.hasPackageRootEntry("styles") !== false) {
        return fs.listSync(stylesheetDirPath, ["css"]);
      }
      return [];
    }
  }

  loadGrammarsSync() {
    if (this.grammarsLoaded) return;

    const grammarPaths = fs.listSync(path.join(this.path, "grammars"), ["json", "jsonc"]);

    for (const grammarPath of grammarPaths) {
      try {
        // An asynchronous load may have published some grammars already. Keep
        // their identities and the injection points registered by services.
        const loadedGrammar = this.grammars.find(
          (grammar) => grammar.grammarFilePath === grammarPath,
        );
        if (loadedGrammar) {
          if (!this.grammarsActivated) loadedGrammar.activate();
          continue;
        }
        const grammar = this.grammarRegistry.readGrammarSync(grammarPath);
        grammar.packageName = this.name;
        grammar.bundledPackage = this.bundledPackage;
        this.grammars.push(grammar);
        grammar.activate();
      } catch (error) {
        console.warn(`Failed to load grammar: ${grammarPath}`, error.stack || error);
      }
    }

    this.grammarsLoaded = true;
    this.grammarsActivated = true;
  }

  async loadGrammars() {
    if (this.grammarsLoaded) return;
    if (this.hasPackageRootEntry("grammars") === false) {
      this.grammarsLoaded = true;
      return;
    }

    const loadGrammar = (grammarPath, callback) => {
      if (this.grammarsLoaded) return callback();
      return this.grammarRegistry.readGrammar(grammarPath, (error, grammar) => {
        // Synchronous workspace restore can finish while this read is pending.
        // A late result must not replace its grammar and discard injections.
        if (
          this.grammarsLoaded ||
          this.grammars.some((loadedGrammar) => loadedGrammar.grammarFilePath === grammarPath)
        ) {
          return callback();
        }
        if (error) {
          const detail = `${error.message} in ${grammarPath}`;
          const stack = `${error.stack}\n  at ${grammarPath}:1:1`;
          this.notificationManager.addFatalError(`Failed to load a ${this.name} package grammar`, {
            stack,
            detail,
            packageName: this.name,
            dismissable: true,
          });
        } else {
          grammar.packageName = this.name;
          grammar.bundledPackage = this.bundledPackage;
          this.grammars.push(grammar);
          if (this.grammarsActivated) grammar.activate();
        }
        return callback();
      });
    };

    const cachedGrammarPaths = this.getCachedResourcePaths("grammarPaths");
    if (cachedGrammarPaths) {
      await new Promise((resolve) => asyncEach(cachedGrammarPaths, loadGrammar, () => resolve()));
    } else {
      await new Promise((resolve) => {
        const grammarsDirPath = path.join(this.path, "grammars");
        fs.exists(grammarsDirPath, (grammarsDirExists) => {
          if (!grammarsDirExists) return resolve();
          fs.list(grammarsDirPath, ["json", "jsonc"], (error, grammarPaths) => {
            if (error || !grammarPaths) return resolve();
            asyncEach(grammarPaths, loadGrammar, () => resolve());
          });
        });
      });
    }
    this.grammarsLoaded = true;
  }

  loadSettings(settingsLoad = this.settingsLoad) {
    this.settings = [];
    if (this.hasPackageRootEntry("settings") === false) return Promise.resolve();

    const isCurrentLoad = () =>
      settingsLoad == null ||
      (this.loadScopeActive && this.settingsLoad === settingsLoad && !settingsLoad.cancelled);

    const loadSettingsFile = (settingsPath, callback) => {
      return SettingsFile.load(settingsPath, (error, settingsFile) => {
        if (!isCurrentLoad()) {
          return callback();
        } else if (error) {
          const detail = `${error.message} in ${settingsPath}`;
          const stack = `${error.stack}\n  at ${settingsPath}:1:1`;
          this.notificationManager.addFatalError(
            `Failed to load the ${this.name} package settings`,
            { stack, detail, packageName: this.name, dismissable: true },
          );
        } else {
          this.settings.push(settingsFile);
          if (this.settingsActivated) settingsFile.activate(this.config);
        }
        return callback();
      });
    };

    const cachedSettingsPaths = this.getCachedResourcePaths("settingsPaths");
    if (cachedSettingsPaths) {
      return new Promise((resolve) =>
        asyncEach(cachedSettingsPaths, loadSettingsFile, () => resolve()),
      );
    }

    return new Promise((resolve) => {
      const settingsDirPath = path.join(this.path, "settings");
      fs.exists(settingsDirPath, (settingsDirExists) => {
        if (!settingsDirExists) return resolve();
        fs.list(settingsDirPath, ["json", "jsonc"], (error, settingsPaths) => {
          if (error || !settingsPaths) return resolve();
          asyncEach(settingsPaths, loadSettingsFile, () => resolve());
        });
      });
    });
  }

  getCachedResourcePaths(key) {
    const cachedPackage = this.bundledPackage && this.packageManager.packagesCache[this.name];
    const cachedPaths = cachedPackage && cachedPackage[key];
    return Array.isArray(cachedPaths)
      ? cachedPaths.map((resourcePath) => path.join(this.path, resourcePath))
      : null;
  }

  hasPackageRootEntry(name) {
    return this.packageRootEntries instanceof Set ? this.packageRootEntries.has(name) : null;
  }

  serialize() {
    if (this.mainActivated) {
      if (typeof this.mainModule.serialize === "function") {
        try {
          return this.mainModule.serialize();
        } catch (error) {
          console.error(`Error serializing package '${this.name}'`, error.stack);
        }
      }
    }
  }

  async deactivate() {
    const mainModule = this.mainModule;
    const wasInitialized = this.mainInitialized;
    const activationStarted = this.mainActivationStarted;
    const failures = [];
    captureLifecycleError(failures, () => this.disposeActivationEntryPoints());
    captureLifecycleError(failures, () => this.deactivateResources());
    captureLifecycleError(failures, () => this.deactivateKeymaps());
    if ((activationStarted || wasInitialized) && typeof mainModule?.deactivate === "function") {
      await awaitLifecycleCleanup(failures, () => mainModule.deactivate());
    }
    if (activationStarted && typeof mainModule?.deactivateConfig === "function") {
      await awaitLifecycleCleanup(failures, () => mainModule.deactivateConfig());
    }
    captureLifecycleError(failures, () => this.disposeInitializationScope());
    captureLifecycleError(failures, () => this.finishDeactivation());
    captureLifecycleError(failures, () => this.emitter.emit("did-deactivate"));
    throwLifecycleErrors(failures, `Package '${this.name}' failed to deactivate cleanly`);
  }

  finishDeactivation() {
    this.mainActivated = false;
    this.mainActivationStarted = false;
    this.mainInitialized = false;
  }

  disposeInitializationScope() {
    const subscriptions = this.initializationDisposables;
    this.initializationDisposables = null;
    this.hooks = null;
    subscriptions?.dispose();
  }

  disposeActivationEntryPoints() {
    this.unregisterURIHandler();
  }

  deactivateResources() {
    const subscriptions = this.activationDisposables;
    const grammarsActivated = this.grammarsActivated;
    const settingsActivated = this.settingsActivated;
    this.activationDisposables = null;
    this.grammarsActivated = false;
    this.settingsActivated = false;
    this.menusActivated = false;
    const failures = [];
    if (grammarsActivated) {
      for (const grammar of this.grammars.slice()) {
        captureLifecycleError(failures, () => grammar.deactivate());
      }
    }
    if (settingsActivated) {
      for (const settings of this.settings.slice()) {
        captureLifecycleError(failures, () => settings.deactivate(this.config));
      }
    }
    captureLifecycleError(failures, () => this.deactivateStylesheets());
    captureLifecycleError(failures, () => subscriptions?.dispose());
    throwLifecycleErrors(failures, `Package '${this.name}' resources failed to deactivate`);
  }

  deactivateStylesheets() {
    const stylesheets = this.stylesheetDisposables;
    this.stylesheetDisposables = null;
    this.stylesheetsActivated = false;
    stylesheets?.dispose();
  }

  reloadStylesheets() {
    try {
      this.loadStylesheets();
    } catch (error) {
      this.handleError(`Failed to reload the ${this.name} package stylesheets`, error);
    }

    if (this.stylesheetDisposables) this.stylesheetDisposables.dispose();
    this.stylesheetDisposables = new CompositeDisposable();
    this.stylesheetsActivated = false;
    this.activateStylesheets();
  }

  requireMainModule() {
    if (this.bundledPackage && this.packageManager.packagesCache[this.name]) {
      if (this.packageManager.packagesCache[this.name].main) {
        this.mainModule = requireModule(this.packageManager.packagesCache[this.name].main);
        return this.mainModule;
      }
    } else if (this.mainModuleRequired) {
      return this.mainModule;
    } else if (!this.isCompatible()) {
      const nativeModuleNames = this.incompatibleModules.map((m) => m.name).join(", ");
      console.warn(dedent`
        Failed to require the main module of '${
          this.name
        }' because it requires one or more incompatible native modules (${nativeModuleNames}).
        Run \`lumine -p rebuild\` in the package directory and restart Lumine to resolve.\
      `);
    } else {
      const mainModulePath = this.getMainModulePath();
      if (fs.isFileSync(mainModulePath)) {
        this.mainModuleRequired = true;

        this.mainModule = requireModule(mainModulePath);
        return this.mainModule;
      }
    }
  }

  getMainModulePath() {
    if (this.resolvedMainModulePath) return this.mainModulePath;
    this.resolvedMainModulePath = true;

    if (this.bundledPackage && this.packageManager.packagesCache[this.name]) {
      if (this.packageManager.packagesCache[this.name].main) {
        this.mainModulePath = path.resolve(
          this.packageManager.resourcePath,
          "static",
          this.packageManager.packagesCache[this.name].main,
        );
      } else {
        this.mainModulePath = null;
      }
    } else {
      const mainModulePath = this.metadata.main
        ? path.join(this.path, this.metadata.main)
        : path.join(this.path, "index");
      this.mainModulePath = fs.resolveExtension(mainModulePath, [
        "",
        ...CompileCache.supportedExtensions,
      ]);
    }
    return this.mainModulePath;
  }

  getURIHandler() {
    return this.metadata && this.metadata.uriHandler;
  }

  // Does the given module path contain native code?
  isNativeModule(modulePath) {
    try {
      return this.getModulePathNodeFiles(modulePath).length > 0;
    } catch {
      return false;
    }
  }

  // get the list of `.node` files for the given module path
  getModulePathNodeFiles(modulePath) {
    const releasePath = path.join(modulePath, "build", "Release");
    return readdirEntries(releasePath)
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".node"))
      .map((entry) => path.join(releasePath, entry.name));
  }

  // Get a Map of all the native modules => the `.node` files that this package depends on.
  //
  // First try to get this information from
  // @metadata._lumineModuleCache.extensions. If @metadata._lumineModuleCache doesn't
  // exist, recurse through all dependencies.
  getNativeModuleDependencyPathsMap() {
    const nativeModulePaths = new Map();

    if (this.metadata._lumineModuleCache) {
      const nodeFilePaths = [];
      const relativeNativeModuleBindingPaths =
        (this.metadata._lumineModuleCache.extensions &&
          this.metadata._lumineModuleCache.extensions[".node"]) ||
        [];
      for (let relativeNativeModuleBindingPath of relativeNativeModuleBindingPaths) {
        const nodeFilePath = path.join(
          this.path,
          relativeNativeModuleBindingPath,
          "..",
          "..",
          "..",
        );
        nodeFilePaths.push(nodeFilePath);
      }
      nativeModulePaths.set(this.path, nodeFilePaths);
      return nativeModulePaths;
    }

    const visitModule = (modulePath) => {
      const modulePathNodeFiles = this.getModulePathNodeFiles(modulePath);
      // An empty list means the module ships no native code. Recording it anyway
      // would name every module in the tree a native dependency.
      if (modulePathNodeFiles.length > 0) {
        nativeModulePaths.set(modulePath, modulePathNodeFiles);
      }
      traversePath(path.join(modulePath, "node_modules"));
    };

    const traversePath = (nodeModulesPath) => {
      for (const entry of readdirEntries(nodeModulesPath)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        // `.bin` and npm's own bookkeeping are never modules.
        if (entry.name.startsWith(".")) continue;
        const entryPath = path.join(nodeModulesPath, entry.name);
        // A scope directory holds modules rather than being one, so its native
        // code sits a level deeper than an unscoped module's.
        if (entry.name.startsWith("@")) {
          for (const scoped of readdirEntries(entryPath)) {
            if (scoped.isDirectory() || scoped.isSymbolicLink()) {
              visitModule(path.join(entryPath, scoped.name));
            }
          }
        } else {
          visitModule(entryPath);
        }
      }
    };

    traversePath(path.join(this.path, "node_modules"));

    return nativeModulePaths;
  }

  // Get an array of all the native modules that this package depends on.
  // See `getNativeModuleDependencyPathsMap` for more information
  getNativeModuleDependencyPaths() {
    return [...this.getNativeModuleDependencyPathsMap().keys()];
  }

  /**
   * @category Native Module Compatibility
   */

  /**
   * @public
   * @status extended
   *
   * Are all native modules depended on by this package correctly
   * compiled against the current version of Lumine?
   *
   * Incompatible packages cannot be activated.
   *
   * @returns {Boolean}, true if compatible, false if incompatible.
   */
  isCompatible() {
    if (this.compatible == null) {
      if (this.getMainModulePath()) {
        this.incompatibleModules = this.getIncompatibleNativeModules();
        this.compatible = this.incompatibleModules.length === 0;
      } else {
        this.compatible = true;
      }
    }
    return this.compatible;
  }

  /**
   * @public
   * @status extended
   *
   * Rebuild native modules in this package's dependencies for the
   * current version of Lumine.
   *
   * @returns {Promise} that resolves with an object containing `code`, `stdout`, and `stderr` properties based on the results of running `lumine -p rebuild` on the package.
   */
  rebuild() {
    return new Promise((resolve) =>
      this.runRebuildProcess((result) => {
        global.localStorage.removeItem(this.getIncompatibleNativeModulesStorageKey());
        if (result.code === 0) {
          global.localStorage.removeItem(this.getBuildFailureOutputStorageKey());
        } else {
          this.compatible = false;
          global.localStorage.setItem(this.getBuildFailureOutputStorageKey(), result.stderr);
        }
        resolve(result);
      }),
    );
  }

  /**
   * @public
   * @status extended
   *
   * If a previous rebuild failed, get the contents of stderr.
   *
   * @returns {String} or null if no previous build failure occurred.
   */
  getBuildFailureOutput() {
    return global.localStorage.getItem(this.getBuildFailureOutputStorageKey());
  }

  runRebuildProcess(done) {
    let stderr = "";
    let stdout = "";
    return new BufferedProcess({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["rebuild"],
      options: { cwd: this.path },
      stderr(output) {
        stderr += output;
      },
      stdout(output) {
        stdout += output;
      },
      exit(code) {
        done({ code, stdout, stderr });
      },
    });
  }

  // Memo keys carry the install path as well as the name and version: two
  // copies of a name can differ in code while sharing both, and one copy's memo
  // must never decide anything for the other.
  getStorageKeyPrefix() {
    return `installed-packages:${this.name}:${this.metadata.version}:${this.path}`;
  }

  getBuildFailureOutputStorageKey() {
    return `${this.getStorageKeyPrefix()}:build-error`;
  }

  // A `.node` file is compatible with an ABI rather than with a Lumine version,
  // so the ABI belongs in the key: an upgrade that changes it must not reuse the
  // previous answer, and one that does not may keep it.
  getIncompatibleNativeModulesStorageKey() {
    return `${this.getStorageKeyPrefix()}:incompatible-native-modules:${process.versions.modules}`;
  }

  // What the memo below describes is the package's installed dependency tree, so
  // the directory a reinstall rewrites is what says whether it still holds.
  // Returns null for a package with no dependencies at all, which is itself a
  // usable memo state rather than a miss.
  getNativeModuleTreeSignature() {
    try {
      return fs.statSync(path.join(this.path, "node_modules")).mtimeMs;
    } catch {
      return null;
    }
  }

  // Get the incompatible native modules that this package depends on.
  // This recurses through all dependencies and requires all `.node` files.
  //
  // Walking a package's whole dependency tree costs more than activating most
  // packages does, and every window pays it for every package, so the answer is
  // memoized in local storage against the ABI it was computed for and the state
  // of the tree it describes. `rebuild()` discards the memo, since that is the
  // one operation that changes the answer without touching either.
  getIncompatibleNativeModules() {
    const storageKey = this.getIncompatibleNativeModulesStorageKey();
    const signature = this.getNativeModuleTreeSignature();
    try {
      const memo = JSON.parse(global.localStorage.getItem(storageKey));
      if (memo && memo.signature === signature && Array.isArray(memo.incompatibleNativeModules)) {
        return memo.incompatibleNativeModules;
      }
    } catch {
      /* a corrupt memo is a miss, not a failure */
    }

    const incompatibleNativeModules = [];
    const nativeModulePaths = this.getNativeModuleDependencyPathsMap();
    for (const [nativeModulePath, nodeFilesPaths] of nativeModulePaths) {
      try {
        // require each .node file
        for (const nodeFilePath of nodeFilesPaths) {
          require(nodeFilePath);
        }
      } catch (error) {
        let version;
        try {
          ({ version } = require(`${nativeModulePath}/package.json`));
        } catch {
          /* ignore */
        }
        incompatibleNativeModules.push({
          path: nativeModulePath,
          name: path.basename(nativeModulePath),
          version,
          error: error.message,
        });
      }
    }

    global.localStorage.setItem(
      storageKey,
      JSON.stringify({ signature, incompatibleNativeModules }),
    );

    return incompatibleNativeModules;
  }

  handleError(message, error) {
    if (lumine.window.isSpecMode()) throw error;

    let detail, location, stack;
    if (error?.filename && error?.location && error instanceof SyntaxError) {
      location = `${error.filename}:${error.location.first_line + 1}:${
        error.location.first_column + 1
      }`;
      detail = `${error.message} in ${location}`;
      stack = "SyntaxError: " + error.message + "\n" + "at " + location;
    } else {
      detail = error?.message ?? String(error);
      stack = error?.stack || error;
    }

    this.notificationManager.addFatalError(message, {
      stack,
      detail,
      packageName: this.name,
      dismissable: true,
    });
  }
};

class SettingsFile {
  static load(path, callback) {
    CSON.readFile(path, (error, properties = {}) => {
      if (error) {
        callback(error);
      } else {
        callback(null, new SettingsFile(path, properties));
      }
    });
  }

  constructor(path, properties) {
    this.path = path;
    this.properties = properties;
  }

  activate(config) {
    config.resetScopedSettings(this.properties, { source: this.path });
  }

  deactivate(config) {
    config.resetScopedSettings({}, { source: this.path });
  }
}
