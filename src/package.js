const path = require("path");
const asyncEach = require("async/each");
const CSON = require("@lumine-code/season");
const fs = require("@lumine-code/fs-plus");
const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");
const dedent = require("dedent");

const CompileCache = require("./compile-cache");
const ModuleCache = require("./module-cache");
const BufferedProcess = require("./buffered-process");
const { requireModule } = require("./module-utils");

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
   * Invoke the given callback when all packages have been activated.
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
    return this.config.removeAtKeyPath("core.disabledPackages", this.name);
  }

  disable() {
    return this.config.pushAtKeyPath("core.disabledPackages", this.name);
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
        ModuleCache.add(this.path, this.metadata);

        this.loadKeymaps();
        this.loadMenus();
        this.loadStylesheets();
        this.registerDeserializerMethods();
        this.activateCoreStartupServices();
        this.registerURIHandler();
        this.configSchemaRegisteredOnLoad = this.registerConfigSchemaFromMetadata();
        this.settingsPromise = this.measureAsync("settingsLoadTime", () => this.loadSettings());
        if (this.shouldRequireMainModuleOnLoad() && this.mainModule == null) {
          this.requireMainModule();
        }
      } catch (error) {
        this.handleError(`Failed to load the ${this.name} package`, error);
      }
    });
    return this;
  }

  unload() {}

  shouldRequireMainModuleOnLoad() {
    return !(
      this.metadata.deserializers ||
      this.metadata.viewProviders ||
      this.metadata.configSchema ||
      this.activationShouldBeDeferred() ||
      localStorage.getItem(this.getCanDeferMainModuleRequireStorageKey()) === "true"
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
    this.deserialized = false;
  }

  initializeIfNeeded() {
    if (this.mainInitialized) return;
    this.measure("initializeTime", () => {
      try {
        // The main module's `initialize()` method is guaranteed to be called
        // before its `activate()`. This gives you a chance to handle the
        // serialized package state before the package's derserializers and view
        // providers are used.
        if (!this.mainModule) this.requireMainModule();
        if (typeof this.mainModule.initialize === "function") {
          this.mainModule.initialize(this.packageManager.getPackageState(this.name) || {});
        }
        this.mainInitialized = true;
      } catch (error) {
        this.handleError(`Failed to initialize the ${this.name} package`, error);
      }
    });
  }

  activate() {
    if (!this.grammarsPromise) {
      this.grammarsPromise = this.measureAsync("grammarLoadTime", () => this.loadGrammars());
    }
    if (!this.activationPromise) {
      this.activationPromise = new Promise((resolve, _reject) => {
        this.resolveActivationPromise = resolve;
        this.measure("activateTime", () => {
          try {
            this.activateResources();
            if (this.activationShouldBeDeferred()) {
              return this.subscribeToDeferredActivation();
            } else {
              return this.activateNow();
            }
          } catch (error) {
            return this.handleError(`Failed to activate the ${this.name} package`, error);
          }
        });
      });
    }

    return Promise.all([this.grammarsPromise, this.settingsPromise, this.activationPromise]);
  }

  activateNow() {
    try {
      if (!this.mainModule) this.requireMainModule();
      // {@link #activate} normally does this first, but a package can be forced
      // active without it — a deserializer that needs its package up before
      // initial activation runs, say. Everything here is flag-guarded, so the
      // ordinary path pays nothing for the second call.
      this.activateResources();
      this.configSchemaRegisteredOnActivate = this.registerConfigSchemaFromMainModule();
      this.registerViewProviders();
      this.activateStylesheets();
      if (this.mainModule && !this.mainActivated) {
        this.initializeIfNeeded();
        if (typeof this.mainModule.activateConfig === "function") {
          this.mainModule.activateConfig();
        }
        if (typeof this.mainModule.activate === "function") {
          this.mainModule.activate(this.packageManager.getPackageState(this.name) || {});
        }
        this.mainActivated = true;
        this.activateServices();
      }
      if (this.activationCommandSubscriptions) this.activationCommandSubscriptions.dispose();
      if (this.activationHookSubscriptions) this.activationHookSubscriptions.dispose();
      if (this.workspaceOpenerSubscriptions) this.workspaceOpenerSubscriptions.dispose();
    } catch (error) {
      this.handleError(`Failed to activate the ${this.name} package`, error);
    }

    if (typeof this.resolveActivationPromise === "function") this.resolveActivationPromise();
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
    if (this.mainModule && !this.configSchemaRegisteredOnLoad) {
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

  // TODO: Remove. Settings view calls this method currently.
  activateConfig() {
    if (this.configSchemaRegisteredOnLoad) return;
    this.requireMainModule();
    this.registerConfigSchemaFromMainModule();
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
      for (let grammar of this.grammars) {
        grammar.activate();
      }
      this.grammarsActivated = true;
    }

    if (!this.settingsActivated) {
      for (let settings of this.settings) {
        settings.activate(this.config);
      }
      this.settingsActivated = true;
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
    if (!this.keymapActivated) return;
    if (this.keymapDisposables) {
      this.keymapDisposables.dispose();
    }
    this.menuManager.update();
    this.keymapActivated = false;
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

  activateServices() {
    let methodName, name, version, versions;
    // Connect a package's dependencies before publishing anything that may use
    // them. Providing is synchronous and can immediately invoke consumers in
    // other packages, so doing it first exposes a half-wired main module.
    for (name in this.metadata.consumedServices) {
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

    for (name in this.metadata.providedServices) {
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
    const handlerConfig = this.getURIHandler();
    const methodName = handlerConfig && handlerConfig.method;
    if (methodName) {
      this.uriHandlerSubscription = this.packageManager.registerURIHandlerForPackage(
        this.name,
        (...args) => this.handleURI(methodName, args),
      );
    }
  }

  unregisterURIHandler() {
    if (this.uriHandlerSubscription) this.uriHandlerSubscription.dispose();
  }

  handleURI(methodName, args) {
    this.activate().then(() => {
      if (this.mainModule[methodName]) this.mainModule[methodName].apply(this.mainModule, args);
    });
    if (!this.mainActivated) this.activateNow();
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
      Object.keys(this.metadata.deserializers).forEach((deserializerName) => {
        const methodName = this.metadata.deserializers[deserializerName];
        this.deserializerManager.add({
          name: deserializerName,
          deserialize: (state, lumineEnvironment) => {
            this.registerViewProviders();
            this.requireMainModule();
            this.initializeIfNeeded();
            if (lumineEnvironment.packages.hasActivatedInitialPackages()) {
              // Only explicitly activate the package if initial packages
              // have finished activating. This is because deserialization
              // generally occurs at Lumine startup, which happens before the
              // workspace element is added to the DOM and is inconsistent with
              // with when initial package activation occurs. Triggering activation
              // immediately may cause problems with packages that expect to
              // always have access to the workspace element.
              // Otherwise, we just set the deserialized flag and package-manager
              // will activate this package as normal during initial package activation.
              this.activateNow();
            }
            this.deserialized = true;
            return this.mainModule[methodName](state, lumineEnvironment);
          },
        });
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
      this.packageManager.serviceHub.provide("project.directory-provider", servicesByVersion);
    }
  }

  registerViewProviders() {
    if (this.metadata.viewProviders && !this.registeredViewProviders) {
      this.requireMainModule();
      this.metadata.viewProviders.forEach((methodName) => {
        this.viewRegistry.addViewProvider((model) => {
          this.initializeIfNeeded();
          return this.mainModule[methodName](model);
        });
      });
      this.registeredViewProviders = true;
    }
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

  loadGrammars() {
    if (this.grammarsLoaded) return Promise.resolve();
    if (this.hasPackageRootEntry("grammars") === false) return Promise.resolve();

    const loadGrammar = (grammarPath, callback) => {
      return this.grammarRegistry.readGrammar(grammarPath, (error, grammar) => {
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
      return new Promise((resolve) => asyncEach(cachedGrammarPaths, loadGrammar, () => resolve()));
    }

    return new Promise((resolve) => {
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

  loadSettings() {
    this.settings = [];
    if (this.hasPackageRootEntry("settings") === false) return Promise.resolve();

    const loadSettingsFile = (settingsPath, callback) => {
      return SettingsFile.load(settingsPath, (error, settingsFile) => {
        if (error) {
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
    this.activationPromise = null;
    this.resolveActivationPromise = null;
    if (this.activationCommandSubscriptions) this.activationCommandSubscriptions.dispose();
    if (this.activationHookSubscriptions) this.activationHookSubscriptions.dispose();
    this.configSchemaRegisteredOnActivate = false;
    this.unregisterURIHandler();
    this.deactivateResources();
    this.deactivateKeymaps();

    if (!this.mainActivated) {
      this.emitter.emit("did-deactivate");
      return;
    }

    if (typeof this.mainModule.deactivate === "function") {
      try {
        const deactivationResult = this.mainModule.deactivate();
        if (deactivationResult && typeof deactivationResult.then === "function") {
          await deactivationResult;
        }
      } catch (error) {
        console.error(`Error deactivating package '${this.name}'`, error.stack);
      }
    }

    if (typeof this.mainModule.deactivateConfig === "function") {
      try {
        await this.mainModule.deactivateConfig();
      } catch (error) {
        console.error(`Error deactivating package '${this.name}'`, error.stack);
      }
    }

    this.mainActivated = false;
    this.mainInitialized = false;
    this.emitter.emit("did-deactivate");
  }

  deactivateResources() {
    for (let grammar of this.grammars) {
      grammar.deactivate();
    }
    for (let settings of this.settings) {
      settings.deactivate(this.config);
    }

    this.deactivateStylesheets();
    if (this.activationDisposables) this.activationDisposables.dispose();
    // Null rather than keep the disposed composite: CompositeDisposable
    // silently ignores adds after disposal, so a re-activated package would
    // register its services and menus into a dead composite and the *next*
    // deactivation could never tear them down — a disabled icon package's
    // provider stayed in the chain forever after one off/on cycle.
    this.activationDisposables = null;
    if (this.keymapDisposables) this.keymapDisposables.dispose();

    this.grammarsActivated = false;
    this.settingsActivated = false;
    this.menusActivated = false;
  }

  deactivateStylesheets() {
    if (this.stylesheetDisposables) this.stylesheetDisposables.dispose();
    this.stylesheetDisposables = null;
    this.stylesheetsActivated = false;
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

        const previousViewProviderCount = this.viewRegistry.getViewProviderCount();
        const previousDeserializerCount = this.deserializerManager.getDeserializerCount();
        this.mainModule = requireModule(mainModulePath);
        if (
          this.viewRegistry.getViewProviderCount() === previousViewProviderCount &&
          this.deserializerManager.getDeserializerCount() === previousDeserializerCount
        ) {
          localStorage.setItem(this.getCanDeferMainModuleRequireStorageKey(), "true");
        } else {
          localStorage.removeItem(this.getCanDeferMainModuleRequireStorageKey());
        }
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

  activationShouldBeDeferred() {
    return (
      !this.deserialized &&
      (this.hasActivationCommands() ||
        this.hasActivationHooks() ||
        this.hasWorkspaceOpeners() ||
        this.hasDeferredURIHandler())
    );
  }

  hasActivationHooks() {
    const hooks = this.getActivationHooks();
    return hooks && hooks.length > 0;
  }

  hasWorkspaceOpeners() {
    const openers = this.getWorkspaceOpeners();
    return openers && openers.length > 0;
  }

  hasActivationCommands() {
    const object = this.getActivationCommands();
    for (let selector in object) {
      const commands = object[selector];
      if (commands.length > 0) return true;
    }
    return false;
  }

  hasDeferredURIHandler() {
    const handler = this.getURIHandler();
    return handler && handler.deferActivation !== false;
  }

  subscribeToDeferredActivation() {
    this.subscribeToActivationCommands();
    this.subscribeToActivationHooks();
    this.subscribeToWorkspaceOpeners();
  }

  subscribeToActivationCommands() {
    this.activationCommandSubscriptions = new CompositeDisposable();
    const object = this.getActivationCommands();
    for (let selector in object) {
      const commands = object[selector];
      for (let command of commands) {
        ((selector, command) => {
          // Add dummy command so it appears in menu.
          // The real command will be registered on package activation
          try {
            this.activationCommandSubscriptions.add(
              this.commandRegistry.add(selector, command, function () {}),
            );
          } catch (error) {
            if (error.code === "EBADSELECTOR") {
              const metadataPath = path.join(this.path, "package.json");
              error.message += ` in ${metadataPath}`;
              error.stack += `\n  at ${metadataPath}:1:1`;
            }
            throw error;
          }

          this.activationCommandSubscriptions.add(
            this.commandRegistry.onWillDispatch((event) => {
              if (event.type !== command) return;
              let currentTarget = event.target;
              while (currentTarget) {
                if (currentTarget.webkitMatchesSelector(selector)) {
                  this.activationCommandSubscriptions.dispose();
                  this.activateNow();
                  break;
                }
                currentTarget = currentTarget.parentElement;
              }
            }),
          );
        })(selector, command);
      }
    }
  }

  getActivationCommands() {
    if (this.activationCommands) return this.activationCommands;

    this.activationCommands = {};

    if (this.metadata.activationCommands) {
      for (let selector in this.metadata.activationCommands) {
        const commands = this.metadata.activationCommands[selector];
        if (!this.activationCommands[selector]) this.activationCommands[selector] = [];
        if (typeof commands === "string") {
          this.activationCommands[selector].push(commands);
        } else if (Array.isArray(commands)) {
          this.activationCommands[selector].push(...commands);
        }
      }
    }

    return this.activationCommands;
  }

  subscribeToActivationHooks() {
    this.activationHookSubscriptions = new CompositeDisposable();
    for (let hook of this.getActivationHooks()) {
      if (typeof hook === "string" && hook.trim().length > 0) {
        this.activationHookSubscriptions.add(
          this.packageManager.onDidTriggerActivationHook(hook, () => this.activateNow()),
        );
      }
    }
  }

  getActivationHooks() {
    if (this.metadata && this.activationHooks) return this.activationHooks;

    if (this.metadata.activationHooks) {
      if (Array.isArray(this.metadata.activationHooks)) {
        this.activationHooks = Array.from(new Set(this.metadata.activationHooks));
      } else if (typeof this.metadata.activationHooks === "string") {
        this.activationHooks = [this.metadata.activationHooks];
      } else {
        this.activationHooks = [];
      }
    } else {
      this.activationHooks = [];
    }

    return this.activationHooks;
  }

  subscribeToWorkspaceOpeners() {
    this.workspaceOpenerSubscriptions = new CompositeDisposable();
    for (let opener of this.getWorkspaceOpeners()) {
      this.workspaceOpenerSubscriptions.add(
        lumine.workspace.addOpener((filePath) => {
          if (filePath === opener) {
            this.activateNow();
            this.workspaceOpenerSubscriptions.dispose();
            return lumine.workspace.createItemForURI(opener);
          }
        }),
      );
    }
  }

  getWorkspaceOpeners() {
    if (this.workspaceOpeners) return this.workspaceOpeners;

    if (this.metadata.workspaceOpeners) {
      if (Array.isArray(this.metadata.workspaceOpeners)) {
        this.workspaceOpeners = Array.from(new Set(this.metadata.workspaceOpeners));
      } else if (typeof this.metadata.workspaceOpeners === "string") {
        this.workspaceOpeners = [this.metadata.workspaceOpeners];
      } else {
        this.workspaceOpeners = [];
      }
    } else {
      this.workspaceOpeners = [];
    }

    return this.workspaceOpeners;
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

  getCanDeferMainModuleRequireStorageKey() {
    return `${this.getStorageKeyPrefix()}:can-defer-main-module-require`;
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
    if (error.filename && error.location && error instanceof SyntaxError) {
      location = `${error.filename}:${error.location.first_line + 1}:${
        error.location.first_column + 1
      }`;
      detail = `${error.message} in ${location}`;
      stack = "SyntaxError: " + error.message + "\n" + "at " + location;
    } else {
      detail = error.message;
      stack = error.stack || error;
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
    for (let selector in this.properties) {
      config.set(null, this.properties[selector], {
        scopeSelector: selector,
        source: this.path,
      });
    }
  }

  deactivate(config) {
    for (let selector in this.properties) {
      config.unset(null, { scopeSelector: selector, source: this.path });
    }
  }
}
