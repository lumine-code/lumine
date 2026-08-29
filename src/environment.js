const crypto = require("crypto");
const path = require("path");
const util = require("util");

const _ = require("@lumine-code/underscore-plus");
const { CompositeDisposable, Disposable, Emitter } = require("@lumine-code/event-kit");
const fs = require("@lumine-code/fs-plus");
const { mapSourcePosition } = require("source-map-support");
const WindowEventHandler = require("./window-event-handler");
const StateStore = require("./state-store");
const registerDefaultCommands = require("./register-default-commands");
const { updateProcessEnv } = require("./update-process-env");
const ConfigSchema = require("./config-schema");

const DeserializerManager = require("./deserializer-manager");
const ViewRegistry = require("./view-registry");
const NotificationManager = require("./notification-manager");
const Config = require("./config");
const KeymapManager = require("./keymap-extensions");
const TooltipManager = require("./tooltip-manager");
const CommandRegistry = require("./command-registry");
const URIHandlerRegistry = require("./uri-handler-registry");
const GrammarRegistry = require("./grammar-registry");
const { HistoryManager } = require("./history-manager");
const ReopenProjectMenuManager = require("./reopen-project-menu-manager");
const StyleManager = require("./style-manager");
const PackageManager = require("./package-manager");
const ThemeManager = require("./theme-manager");
const MenuManager = require("./menu-manager");
const ContextMenuManager = require("./context-menu-manager");
const CommandInstaller = require("./command-installer");
const CoreURIHandlers = require("./core-uri-handlers");
const ProtocolHandlerInstaller = require("./protocol-handler-installer");
const Project = require("./project");
const RepositoryRegistry = require("./repository-registry");
const GitRepositoryOperationProvider = require("./git-repository-operation-provider");
const GitAuthBroker = require("./git-auth-broker");
const { promptForGitCredential } = require("./git-credential-dialog");
const SecretStore = require("./secret-store");
const WindowService = require("./window-service");
const ApplicationService = require("./application-service");
const ShellService = require("./shell-service");
const RuntimeService = require("./runtime-service");
const Workspace = require("./workspace");
const WorkspaceDropManager = require("./workspace-drop-manager");
const PaneContainer = require("./pane-container");
const PaneAxis = require("./pane-axis");
const Pane = require("./pane");
const Dock = require("./dock");
const TextEditor = require("./text-editor");
const TextBuffer = require("./text-buffer");
const FileState = require("./file-state");
const TextEditorRegistry = require("./text-editor-registry");
const PasteProviderRegistry = require("./paste-provider-registry");
const StartupTime = require("./startup-time");
const Tools = require("./tools");
const IconRegistry = require("./icon-registry");
const packagejson = require("../package.json");

const { stopAllWatchers } = require("./path-watcher");
const GitHost = require("./git-host");
const stat = util.promisify(fs.stat);

// Only the workspace center follows the project: the docks belong to the
// window, so a terminal or a panel keeps running across a project change.
const PROJECT_STATE_LOCATIONS = ["center"];

// How long any one package may take to deactivate while the window is going
// away. Generous, because a package doing real work on the way out — writing a
// file, asking a language server to leave — should be allowed to finish; the
// bound exists so that one which never finishes cannot hold the window open.
const UNLOAD_DEACTIVATION_TIMEOUT_MS = 2000;

let nextId = 0;

/**
 * @public
 * @status public
 *
 * @class Environment
 * @classdesc Lumine global for dealing with packages, themes, menus, and the window.
 *
 * An instance of this class is always available as the `lumine` global.
 */
class Environment {
  // Wiring the environment owns and nothing outside it may reach. Everything a
  // package is meant to use is a namespace carrying a `@type` annotation below;
  // these four are the machinery behind them, so they are hard-private rather
  // than merely undocumented.
  #commandInstaller;
  #protocolHandlerInstaller;
  #gitAuthBroker;
  #windowEventHandler;

  #getLoadSettings() {
    return this.applicationDelegate.getWindowLoadSettings();
  }

  constructor(params = {}) {
    this.id = params.id != null ? params.id : nextId++;

    /**
     * @public
     * @status public
     *
     * The {@link FileState} enum namespace.
     *
     * @type {FileState}
     */
    this.FileState = FileState;

    /**
     * @public
     * @status public
     *
     * @type {Clipboard}
     */
    this.clipboard = params.clipboard;
    this.updateProcessEnv = params.updateProcessEnv || updateProcessEnv;
    this.enablePersistence = params.enablePersistence;
    this.applicationDelegate = params.applicationDelegate;
    /**
     * @public
     * @status public
     *
     * @type {WindowService}
     */
    this.window = new WindowService(this.applicationDelegate, this);
    /**
     * @public
     * @status public
     *
     * @type {ApplicationService}
     */
    this.application = new ApplicationService(this.applicationDelegate);
    /**
     * @public
     * @status public
     *
     * @type {ShellService}
     */
    this.shell = new ShellService(this.applicationDelegate);
    /**
     * @public
     * @status public
     *
     * @type {RuntimeService}
     */
    this.runtime = new RuntimeService(this);

    this.nextProxyRequestId = 0;
    this.unloading = false;
    this.loadTime = null;
    /** @private Reachable only because specs fake `will-destroy` through it;
     * packages subscribe with `window.onWillDestroy()` and never touch this. */
    this.emitter = new Emitter();
    /** @private */
    this.disposables = new CompositeDisposable();
    this.pathsWithWaitSessions = new Set();

    /**
     * @public
     * @status public
     *
     * @type {DeserializerManager}
     */
    this.deserializers = new DeserializerManager(this);

    /**
     * @public
     * @status public
     *
     * How long each deserialized top-level object took to restore, in
     * milliseconds, keyed by name (`project`, `workspace`). The `timecop`
     * package reads this to report window load cost, and resets it to `{}`.
     * @type {Object<string, number>}
     */
    this.deserializeTimings = {};

    /**
     * @public
     * @status public
     *
     * @type {ViewRegistry}
     */
    this.views = new ViewRegistry(this);

    /**
     * @public
     * @status public
     *
     * @type {NotificationManager}
     */
    this.notifications = new NotificationManager();

    /**
     * @public
     * @status public
     *
     * @type {Config}
     */
    this.config = new Config({
      saveCallback: (settings) => {
        if (this.enablePersistence) {
          this.applicationDelegate.setUserSettings(settings, this.config.getUserConfigPath());
        }
      },
    });
    this.config.setSchema(null, {
      type: "object",
      properties: _.clone(ConfigSchema),
    });

    /** @private Window-state persistence. `TextEditor` consults it before
     * prompting to save, and specs stub it; not a package-facing namespace. */
    this.stateStore = new StateStore("Environments", 1);

    /**
     * @public
     * @status public
     *
     * @type {KeymapManager}
     */
    this.keymaps = new KeymapManager({
      notificationManager: this.notifications,
    });

    /**
     * @public
     * @status public
     *
     * @type {TooltipManager}
     */
    this.tooltips = new TooltipManager({
      keymapManager: this.keymaps,
      viewRegistry: this.views,
    });

    /**
     * @public
     * @status public
     *
     * @type {CommandRegistry}
     */
    this.commands = new CommandRegistry();

    /**
     * @public
     * @status public
     *
     * @type {URIHandlerRegistry}
     */
    this.uriHandlers = new URIHandlerRegistry();

    /**
     * @public
     * @status public
     *
     * @type {GrammarRegistry}
     */
    this.grammars = new GrammarRegistry({ config: this.config });

    /**
     * @public
     * @status public
     *
     * @type {StyleManager}
     */
    this.styles = new StyleManager();

    /**
     * @public
     * @status public
     *
     * @type {PackageManager}
     */
    this.packages = new PackageManager({
      config: this.config,
      styleManager: this.styles,
      commandRegistry: this.commands,
      keymapManager: this.keymaps,
      notificationManager: this.notifications,
      grammarRegistry: this.grammars,
      deserializerManager: this.deserializers,
      viewRegistry: this.views,
      uriHandlerRegistry: this.uriHandlers,
    });

    /**
     * @public
     * @status public
     *
     * @type {ThemeManager}
     */
    this.themes = new ThemeManager({
      packageManager: this.packages,
      config: this.config,
      styleManager: this.styles,
      notificationManager: this.notifications,
      viewRegistry: this.views,
      applicationDelegate: this.applicationDelegate,
    });

    /**
     * @public
     * @status public
     *
     * @type {MenuManager}
     */
    this.menu = new MenuManager({
      keymapManager: this.keymaps,
      packageManager: this.packages,
    });

    /**
     * @public
     * @status public
     *
     * @type {ContextMenuManager}
     */
    this.contextMenu = new ContextMenuManager({
      keymapManager: this.keymaps,
      applicationDelegate: this.applicationDelegate,
    });

    this.packages.setMenuManager(this.menu);
    this.packages.setContextMenuManager(this.contextMenu);
    this.packages.setThemeManager(this.themes);

    // The single source of every icon the editor renders. Built before the
    // project and the workspace so a package activating early can register a
    // provider before anything asks for an icon. It deliberately takes no
    // repository dependency — a caller that knows a directory is a repository
    // root says so on the target.
    /**
     * @public
     * @status public
     *
     * @type {IconRegistry}
     */
    this.icons = new IconRegistry({
      config: this.config,
      themeManager: this.themes,
      grammarRegistry: this.grammars,
      packageManager: this.packages,
    });

    /**
     * @public
     * @status public
     *
     * @type {RepositoryRegistry}
     */
    this.repositories = new RepositoryRegistry({
      config: this.config,
      notificationManager: this.notifications,
      packageManager: this.packages,
    });
    // Interactive credential/passphrase prompting for git operations that run in
    // the git-host worker, so the user's system git credential helpers stay the
    // source of truth and this only supplies the GUI fallback.
    this.#gitAuthBroker = new GitAuthBroker({ promptForInput: promptForGitCredential });
    this.repositories.addOperationProvider(
      new GitRepositoryOperationProvider({ authBroker: this.#gitAuthBroker }),
      { fallback: true },
    );
    // A forge-agnostic, OS-encrypted secret store (VS Code SecretStorage-style)
    // for tokens and other sensitive strings packages must persist. Exposed as
    // `lumine.secrets`.
    /**
     * @public
     * @status public
     *
     * @type {SecretStore}
     */
    this.secrets = new SecretStore({
      applicationDelegate: this.applicationDelegate,
      storagePath: path.join(this.getConfigDirPath(), "secret-store.json"),
      notify: (message) => this.notifications.addWarning(message, { dismissable: true }),
    });
    /**
     * @public
     * @status public
     *
     * @type {Project}
     */
    this.project = new Project({
      notificationManager: this.notifications,
      packageManager: this.packages,
      grammarRegistry: this.grammars,
      config: this.config,
      applicationDelegate: this.applicationDelegate,
      repositoryRegistry: this.repositories,
      // `Project::setState` is the public face of this; the mechanics live
      // here because only the environment can reach the window state store and
      // the workspace.
      restoreState: (projectPaths) => this.restoreProjectState(projectPaths),
    });
    this.icons.attachProject(this.project);
    this.#commandInstaller = new CommandInstaller(this.applicationDelegate);
    this.#protocolHandlerInstaller = new ProtocolHandlerInstaller();

    /**
     * @public
     * @status public
     *
     * @type {TextEditorRegistry}
     */
    this.textEditors = new TextEditorRegistry({
      config: this.config,
      grammarRegistry: this.grammars,
      assert: this.assert.bind(this),
      packageManager: this.packages,
    });
    /**
     * @public
     * @status public
     *
     * @type {PasteProviderRegistry}
     */
    this.pasteProviders = new PasteProviderRegistry();
    TextEditor.setPasteProviderRegistry(this.pasteProviders);

    /**
     * @public
     * @status public
     *
     * @type {Workspace}
     */
    this.workspace = new Workspace({
      config: this.config,
      project: this.project,
      packageManager: this.packages,
      grammarRegistry: this.grammars,
      deserializerManager: this.deserializers,
      notificationManager: this.notifications,
      applicationDelegate: this.applicationDelegate,
      viewRegistry: this.views,
      assert: this.assert.bind(this),
      textEditorRegistry: this.textEditors,
      styleManager: this.styles,
      enablePersistence: this.enablePersistence,
    });

    /**
     * @public
     * @status extended
     *
     * Shared protocol and routing for drops on workspace panes and package
     * surfaces such as tab bars.
     * @type {WorkspaceDropManager}
     */
    this.workspaceDrops = new WorkspaceDropManager({
      workspace: this.workspace,
      applicationDelegate: this.applicationDelegate,
      windowService: this.window,
    });
    this.workspace.workspaceDropManager = this.workspaceDrops;

    this.themes.workspace = this.workspace;
    this.repositories.attachWorkspace(this.workspace);

    if (this.keymaps.canLoadBundledKeymapsFromMemory()) {
      this.keymaps.loadBundledKeymaps();
    }

    this.registerDefaultCommands();
    this.registerDefaultOpeners();
    this.registerDefaultDeserializers();

    this.#windowEventHandler = new WindowEventHandler({
      lumineEnvironment: this,
      applicationDelegate: this.applicationDelegate,
    });

    /**
     * @public
     * @status public
     *
     * @type {HistoryManager}
     */
    this.history = new HistoryManager({
      project: this.project,
      commands: this.commands,
      stateStore: this.stateStore,
    });

    this.branding = {
      id: packagejson.branding.id,
      name: packagejson.branding.name,
      urlWeb: packagejson.branding.urlWeb,
      urlGH: packagejson.branding.urlGH,
      urlForum: packagejson.branding.urlForum,
      urlCoreRepo: packagejson.repository.url,
    };

    /**
     * @public
     * @status public
     *
     * Editor utilities a package can reuse instead of vendoring its own:
     * `markdown`, `fuzzyMatcher`, and `removeDiacritics`.
     * @type {Object}
     */
    this.tools = Tools;

    // Keep instances of HistoryManager in sync
    this.disposables.add(
      this.history.onDidChangeProjects((event) => {
        if (!event.reloaded) this.applicationDelegate.didChangeHistoryManager();
      }),
    );
  }

  initialize(params = {}) {
    // This will force TextEditorElement to register the custom element, so that
    // using `document.createElement('lumine-text-editor')` works if it's called
    // before opening a buffer.
    require("./text-editor-element");

    this.isDestroying = false;

    this.domWindow = params.window;
    this.document = params.document;
    this.blobStore = params.blobStore;
    this.configDirPath = params.configDirPath;

    const { configFilePath, devMode, safeMode, resourcePath, userSettings, projectSpecification } =
      this.#getLoadSettings();

    this.stateStore.initialize({
      configDirPath: this.getConfigDirPath(),
    });

    this.config.initialize({
      mainSource:
        this.enablePersistence && (configFilePath || path.join(this.configDirPath, "config.json")),
    });
    this.config.resetUserSettings(userSettings);

    if (projectSpecification != null && projectSpecification.config != null) {
      this.project.replace(projectSpecification);
    }

    this.menu.initialize({ resourcePath });
    this.contextMenu.initialize({ resourcePath, devMode });

    this.keymaps.configDirPath = this.configDirPath;
    this.keymaps.resourcePath = resourcePath;
    this.keymaps.devMode = devMode;
    if (!this.keymaps.canLoadBundledKeymapsFromMemory()) {
      this.keymaps.loadBundledKeymaps();
    }

    this.commands.attach(this.domWindow);

    this.styles.initialize({ configDirPath: this.configDirPath });
    this.packages.initialize({
      devMode,
      configDirPath: this.configDirPath,
      resourcePath,
      safeMode,
    });
    this.themes.initialize({
      configDirPath: this.configDirPath,
      resourcePath,
      safeMode,
      devMode,
    });

    this.#commandInstaller.initialize(this.application.getVersion());
    this.uriHandlers.registerHostHandler("core", CoreURIHandlers.create(this));

    this.#protocolHandlerInstaller.initialize(this.config, this.notifications, devMode);

    this.themes.loadBaseStylesheets();
    this.initialStyleElements = this.styles.getSnapshot();
    if (params.onlyLoadBaseStyleSheets) this.themes.initialLoadComplete = true;
    this.setBodyPlatformClass();

    this.stylesElement = this.styles.buildStylesElement();
    this.document.head.appendChild(this.stylesElement);

    this.keymaps.subscribeToFileReadFailure();

    this.installUncaughtErrorHandler();
    this.attachSaveStateListeners();
    this.#windowEventHandler.initialize(this.domWindow, this.document);

    this.workspace.initialize({ configDirPath: this.getConfigDirPath() });
    this.workspaceDrops.initialize();

    const didChangeStyles = this.didChangeStyles.bind(this);
    this.disposables.add(this.styles.onDidAddStyleElement(didChangeStyles));
    this.disposables.add(this.styles.onDidUpdateStyleElement(didChangeStyles));
    this.disposables.add(this.styles.onDidRemoveStyleElement(didChangeStyles));

    this.observeAutoHideMenuBar();

    this.disposables.add(
      this.applicationDelegate.onDidChangeHistoryManager(() => this.history.loadState()),
    );
  }

  // Remove what an interrupted package install left in the packages directory.
  // Failures are the normal case for a file another process still holds, and
  // the next launch tries again, so nothing here is reported.
  sweepInterruptedInstalls() {
    const packagesPath = this.packages.userPackagesPath;
    if (!packagesPath) return;
    const PackageInstallationService = require("./package-installation-service");
    PackageInstallationService.sweep(packagesPath).catch(() => {});
  }

  attachSaveStateListeners() {
    const saveState = _.debounce(() => {
      this.domWindow.requestIdleCallback(() => {
        if (!this.unloading) this.saveState({ isUnloading: false });
      });
    }, this.saveStateDebounceInterval);
    this.document.addEventListener("mousedown", saveState, { capture: true });
    this.document.addEventListener("keydown", saveState, { capture: true });
    this.disposables.add(
      new Disposable(() => {
        this.document.removeEventListener("mousedown", saveState, {
          capture: true,
        });
        this.document.removeEventListener("keydown", saveState, {
          capture: true,
        });
      }),
    );
  }

  registerDefaultDeserializers() {
    this.deserializers.add(Workspace);
    this.deserializers.add(PaneContainer);
    this.deserializers.add(PaneAxis);
    this.deserializers.add(Pane);
    this.deserializers.add(Dock);
    this.deserializers.add(Project);
    this.deserializers.add(TextEditor);
    this.deserializers.add(TextBuffer);
  }

  registerDefaultCommands() {
    registerDefaultCommands({
      commandRegistry: this.commands,
      config: this.config,
      commandInstaller: this.#commandInstaller,
      notificationManager: this.notifications,
      project: this.project,
      repositories: this.repositories,
      clipboard: this.clipboard,
    });
  }

  registerDefaultOpeners() {
    this.workspace.addOpener((uri) => {
      switch (uri) {
        case "lumine://.lumine/stylesheet":
          return this.workspace.openTextFile(this.styles.getUserStyleSheetPath());
        case "lumine://.lumine/keymap":
          return this.workspace.openTextFile(this.keymaps.getUserKeymapPath());
        case "lumine://.lumine/config":
          return this.workspace.openTextFile(this.config.getUserConfigPath());
        case "lumine://.lumine/init-script":
          return this.workspace.openTextFile(this.getUserInitScriptPath());
      }
    });
  }

  registerDefaultTargetForKeymaps() {
    this.keymaps.defaultTarget = this.workspace.getElement();
  }

  observeAutoHideMenuBar() {
    this.disposables.add(
      this.config.onDidChange("core.autoHideMenuBar", ({ newValue }) => {
        if (newValue === undefined) {
          newValue = true;
        }
        this.#setAutoHideMenuBar(newValue);
      }),
    );
    if (this.config.get("core.autoHideMenuBar")) this.#setAutoHideMenuBar(true);

    // The git-host worker reads git.* settings from its fork environment,
    // so restart it when they change; the next Git command lazily re-forks with
    // the new values.
    this.disposables.add(
      this.config.onDidChange("git.trustAllRepositories", () => GitHost.reset()),
      this.config.onDidChange("git.path", () => GitHost.reset()),
    );
  }

  async reset() {
    this.deserializers.clear();
    this.registerDefaultDeserializers();

    this.config.clear();
    this.config.setSchema(null, {
      type: "object",
      properties: _.clone(ConfigSchema),
    });

    // Clear all three registries before rebuilding them. KeymapManager::clear
    // replaces its emitter, so the menu managers' startup subscriptions no
    // longer receive `did-load-bundled-keymaps`; reload their platform items
    // explicitly after the key bindings they derive accelerators from.
    this.keymaps.clear();
    this.menu.clear();
    this.contextMenu.clear();
    this.keymaps.loadBundledKeymaps();
    this.menu.loadPlatformItems();
    this.contextMenu.loadPlatformItems();

    this.commands.clear();
    this.registerDefaultCommands();

    this.styles.restoreSnapshot(this.initialStyleElements);

    this.clipboard.reset();

    this.notifications.clear();

    await this.packages.reset();
    this.workspace.reset(this.packages);
    this.registerDefaultOpeners();
    this.project.reset(this.packages);
    this.workspace.initialize({ configDirPath: this.getConfigDirPath() });
    // The reset recreated the pane containers, so the registry's active-item
    // subscription must be rebuilt against the new center.
    this.repositories.attachWorkspace(this.workspace);
    this.repositories.consumeServices(this.packages);
    this.icons.clear();
    this.icons.attachProject(this.project);
    this.grammars.clear();
    this.textEditors.clear();
    this.pasteProviders.clear();
    this.views.clear();
    this.pathsWithWaitSessions.clear();
  }

  destroy() {
    if (!this.project) return;

    // Set this flag and then don't reset it after `destroy` is done, since we
    // need other disposing objects to be able to check it. We won't need to
    // reset it because another environment will be created.
    this.isDestroying = true;
    this.emitter.emit("will-destroy");

    this.menu.destroy();
    this.disposables.dispose();
    if (this.workspaceDrops) this.workspaceDrops.destroy();
    this.workspaceDrops = null;
    if (this.workspace) this.workspace.destroy();
    this.workspace = null;
    this.themes.workspace = null;
    if (this.project) this.project.destroy();
    this.project = null;
    if (this.repositories) this.repositories.destroy();
    this.repositories = null;
    if (this.icons) this.icons.destroy();
    this.icons = null;
    this.commands.clear();
    if (this.stylesElement) this.stylesElement.remove();
    this.uriHandlers.destroy();

    this.uninstallWindowEventHandler();
  }

  // TODO: Make this part of the public API. We should make onDidThrowError
  // match the interface by only yielding an exception object to the handler
  // and deprecating the old behavior.
  onDidFailAssertion(callback) {
    return this.emitter.on("did-fail-assertion", callback);
  }

  // Record how long the window took to load and notify anything waiting on it.
  // Called once by the window entry point, after the window is set up.
  setWindowLoadTime(loadTime) {
    this.loadTime = loadTime;
    this.emitter.emit("window-loaded", loadTime);
  }

  // Restore the window to its previous dimensions and show it.
  //
  // Restores the full screen and maximized state after the window has resized to
  // prevent resize glitches.
  async displayWindow() {
    await this.restoreWindowDimensions();
    const steps = [this.restoreWindowBackground(), this.window.show(), this.window.focus()];
    if (this.windowDimensions && this.windowDimensions.fullScreen) {
      steps.push(this.window.setFullScreen(true));
    }
    if (this.windowDimensions && this.windowDimensions.maximized && process.platform !== "darwin") {
      steps.push(this.window.maximize());
    }
    await Promise.all(steps);
  }

  // Get the dimensions of this window.
  //
  // Returns an `Object` with the following keys:
  //   * `x`      The window's x-position `Number`.
  //   * `y`      The window's y-position `Number`.
  //   * `width`  The window's width `Number`.
  //   * `height` The window's height `Number`.
  async getWindowDimensions() {
    const state = await this.window.getState();
    return {
      x: state.position.x,
      y: state.position.y,
      width: state.size.width,
      height: state.size.height,
      maximized: state.maximized,
      fullScreen: state.fullScreen,
    };
  }

  // Set the dimensions of the window.
  //
  // The window will be centered if either the x or y coordinate is not set
  // in the dimensions parameter. If x or y are omitted the window will be
  // centered. If height or width are omitted only the position will be changed.
  //
  // * `dimensions` An `Object` with the following keys:
  //   * `x` The new x coordinate.
  //   * `y` The new y coordinate.
  //   * `width` The new width.
  //   * `height` The new height.
  setWindowDimensions({ x, y, width, height }) {
    const steps = [];
    if (width != null && height != null) {
      steps.push(this.window.setSize(width, height));
    }
    if (x != null && y != null) {
      steps.push(this.window.setPosition(x, y));
    } else {
      steps.push(this.window.center());
    }
    return Promise.all(steps);
  }

  // Returns true if the dimensions are useable, false if they should be ignored.
  // Work around for https://github.com/atom/atom-shell/issues/473
  isValidDimensions({ x, y, width, height } = {}) {
    return width > 0 && height > 0 && x + width > 0 && y + height > 0;
  }

  async storeWindowDimensions() {
    this.windowDimensions = await this.getWindowDimensions();
    if (this.isValidDimensions(this.windowDimensions)) {
      localStorage.setItem("defaultWindowDimensions", JSON.stringify(this.windowDimensions));
    }
  }

  async getDefaultWindowDimensions() {
    const { windowDimensions } = this.#getLoadSettings();
    if (windowDimensions) return windowDimensions;

    let dimensions;
    try {
      dimensions = JSON.parse(localStorage.getItem("defaultWindowDimensions"));
    } catch (error) {
      console.warn("Error parsing default window dimensions", error);
      localStorage.removeItem("defaultWindowDimensions");
    }

    if (dimensions && this.isValidDimensions(dimensions)) {
      return dimensions;
    } else {
      const { width, height } = await this.window.getPrimaryDisplayWorkAreaSize();
      return { x: 0, y: 0, width: Math.min(1024, width), height };
    }
  }

  async restoreWindowDimensions() {
    if (!this.windowDimensions || !this.isValidDimensions(this.windowDimensions)) {
      this.windowDimensions = await this.getDefaultWindowDimensions();
    }
    await this.setWindowDimensions(this.windowDimensions);
    return this.windowDimensions;
  }

  restoreWindowBackground() {
    const backgroundColor = window.localStorage.getItem("lumine:window-background-color");
    if (backgroundColor) {
      this.backgroundStylesheet = document.createElement("style");
      this.backgroundStylesheet.type = "text/css";
      this.backgroundStylesheet.innerText = `html, body { background: ${backgroundColor} !important; }`;
      document.head.appendChild(this.backgroundStylesheet);
    }
  }

  storeWindowBackground() {
    if (this.window.isSpecMode()) return;

    const backgroundColor = this.domWindow.getComputedStyle(this.workspace.getElement())[
      "background-color"
    ];
    this.domWindow.localStorage.setItem("lumine:window-background-color", backgroundColor);
  }

  // Call this method when establishing a real application window.
  async startEditorWindow() {
    StartupTime.addMarker("window:environment:start-editor-window:start");

    if (this.#getLoadSettings().clearWindowState) {
      await this.stateStore.clear();
    }

    this.unloading = false;

    const updateProcessEnvPromise = this.updateProcessEnvAndTriggerHooks();

    const loadStatePromise = this.loadState().then(async (state) => {
      this.windowDimensions = state && state.windowDimensions;
      if (!this.window.isHeadless()) {
        StartupTime.addMarker("window:environment:start-editor-window:display-window");
        await this.displayWindow();
      }
      this.#commandInstaller.installLumineCommand(false, (error) => {
        if (error) console.warn(error.message);
      });

      this.disposables.add(
        this.applicationDelegate.onDidChangeUserSettings((settings) =>
          this.config.resetUserSettings(settings),
        ),
      );
      this.disposables.add(
        this.applicationDelegate.onDidFailToReadUserSettings((message) =>
          this.notifications.addError(message),
        ),
      );

      this.disposables.add(
        this.applicationDelegate.onDidOpenLocations(this.openLocations.bind(this)),
      );
      this.disposables.add(
        this.applicationDelegate.onApplicationMenuCommand(
          this.dispatchApplicationMenuCommand.bind(this),
        ),
      );
      this.disposables.add(
        this.applicationDelegate.onContextMenuCommand(this.dispatchContextMenuCommand.bind(this)),
      );
      this.disposables.add(
        this.applicationDelegate.onURIMessage(this.dispatchURIMessage.bind(this)),
      );
      this.disposables.add(
        this.applicationDelegate.onDidRequestUnload(this.prepareToUnloadEditorWindow.bind(this)),
      );

      this.registerDefaultTargetForKeymaps();

      // An install interrupted by a crash or a quit leaves its staging and
      // backup directories behind, and a backup holding a native module can
      // only be deleted before anything loads it.
      this.sweepInterruptedInstalls();

      StartupTime.addMarker("window:environment:start-editor-window:load-packages");
      this.packages.loadPackages();
      StartupTime.addMarker("window:environment:start-editor-window:load-packages:end");

      const startTime = Date.now();
      StartupTime.addMarker("window:environment:start-editor-window:deserialize-state");
      await this.deserialize(state);
      this.deserializeTimings.lumine = Date.now() - startTime;

      if (this.config.get("core.titleBar") === "hidden") {
        this.document.body.classList.add("hidden-title-bar");
      }

      this.document.body.appendChild(this.workspace.getElement());
      if (this.backgroundStylesheet) this.backgroundStylesheet.remove();

      let previousProjectPaths = this.project.getPaths();
      this.disposables.add(
        this.project.onDidChangePaths((newPaths) => {
          for (let path of previousProjectPaths) {
            if (this.pathsWithWaitSessions.has(path) && !newPaths.includes(path)) {
              this.applicationDelegate.didClosePathWithWaitSession(path);
            }
          }
          previousProjectPaths = newPaths;
          this.applicationDelegate.setProjectRoots(newPaths);
        }),
      );
      this.disposables.add(
        this.workspace.onDidDestroyPaneItem(({ item }) => {
          const path = item.getPath && item.getPath();
          if (this.pathsWithWaitSessions.has(path)) {
            this.applicationDelegate.didClosePathWithWaitSession(path);
          }
        }),
      );

      StartupTime.addMarker("window:environment:start-editor-window:activate-packages");
      await this.packages.activate();
      StartupTime.addMarker("window:environment:start-editor-window:activate-packages:end");
      this.keymaps.loadUserKeymap();
      if (!this.window.isSafeMode()) this.requireUserInitScript();

      this.menu.update();

      StartupTime.addMarker("window:environment:start-editor-window:open-editor");
      await this.openInitialEmptyEditorIfNecessary();
    });

    const loadHistoryPromise = this.history.loadState().then(() => {
      this.reopenProjectMenuManager = new ReopenProjectMenuManager({
        menu: this.menu,
        commands: this.commands,
        history: this.history,
        config: this.config,
        open: (paths) =>
          this.application.openWindow({
            pathsToOpen: paths,
            safeMode: this.window.isSafeMode(),
            devMode: this.window.isDevMode(),
          }),
      });
      this.reopenProjectMenuManager.update();
    });

    const output = await Promise.all([
      loadStatePromise,
      loadHistoryPromise,
      updateProcessEnvPromise,
    ]);

    StartupTime.addMarker("window:environment:start-editor-window:end");

    return output;
  }

  serialize(options) {
    return {
      version: this.constructor.version,
      project: this.project.serialize(options),
      workspace: this.workspace.serialize(),
      packageStates: this.packages.serialize(),
      grammars: this.grammars.serialize(),
      uriHistory: this.uriHandlers.serialize(),
      fullScreen: Boolean(this.windowDimensions?.fullScreen),
      windowDimensions: this.windowDimensions,
    };
  }

  async prepareToUnloadEditorWindow() {
    try {
      await this.saveState({ isUnloading: true });
    } catch (error) {
      console.error(error);
    }

    const closing =
      !this.workspace ||
      (await this.workspace.confirmClose({
        windowCloseRequested: true,
        projectHasPaths: this.project.getPaths().length > 0,
      }));

    if (closing) {
      this.unloading = true;
      // Every orderly unload deactivates, reload included. Skipping it there
      // used to be how a package that would not finish deactivating was kept
      // from hanging the reload; `timeout` is that guarantee now, and it holds
      // for every package rather than for the one that misbehaved. The cost is
      // the slowest single deactivation, since they run concurrently.
      //
      // What this buys is a teardown that happens while the environment is
      // still whole: deactivation finishes, the reply crosses to the main
      // process, and only then does the window navigate. Anything a package
      // deferred to a later frame on its way out therefore runs before
      // `destroy()` takes the workspace away.
      await this.packages.deactivatePackages({ timeout: UNLOAD_DEACTIVATION_TIMEOUT_MS });
      // Watchers are not package-owned, and stopping them only from the later
      // DOM unload hook is too late for a caller that must release a project or
      // configuration directory before the renderer disappears. In
      // particular, Windows keeps the directory undeletable until the watcher
      // worker confirms its handles are closed.
      await stopAllWatchers();
      this.stateStore.close();
      this.workspace.closeStateStore();
    }
    return closing;
  }

  unloadEditorWindow() {
    // By the time this runs the window is going away for certain, including on
    // paths that never reached `prepareToUnloadEditorWindow`. Workers and
    // background tasks read this flag to stop starting — and stop settling —
    // work that nothing is left to observe.
    this.unloading = true;
    stopAllWatchers();
    this.stateStore.close();
    this.workspace.closeStateStore();
    GitHost.reset();
    if (this.#gitAuthBroker) this.#gitAuthBroker.terminate();
    if (this.secrets) this.secrets.dispose();
    if (!this.project) return;

    this.storeWindowBackground();
    this.saveBlobStoreSync();
  }

  saveBlobStoreSync() {
    if (this.enablePersistence) {
      this.blobStore.save();
    }
  }

  openInitialEmptyEditorIfNecessary() {
    if (!this.config.get("core.openEmptyEditorOnStart")) return;
    const { hasOpenFiles } = this.#getLoadSettings();
    if (!hasOpenFiles && this.workspace.getPaneItems().length === 0) {
      return this.workspace.open(null, { pending: true });
    }
  }

  installUncaughtErrorHandler() {
    this.previousWindowErrorHandler = this.domWindow.onerror;
    this.domWindow.onerror = (message, url, line, column, originalError) => {
      if (isBenignResizeObserverNotification(message)) return;

      const mapping = mapSourcePosition({ source: url, line, column });
      line = mapping.line;
      column = mapping.column;

      this.reportUncaughtError({
        message,
        url,
        line,
        column,
        // Chromium hands over no error object at all for one it could not
        // marshal — thrown across an origin, or an `ErrorEvent` dispatched
        // without one — and every handler downstream reads this without
        // asking. A value that merely is not an Error is left alone: whatever
        // was thrown still describes the fault better than anything made up
        // here would.
        originalError: originalError ?? untraceableError(message),
      });
    };

    // A promise nobody handled is as much a fault as a thrown one, and on its
    // own it reaches no one: no notification, and no dev tools unless the
    // window already had them open. Where it came from has to be read back out
    // of the stack, since a rejection carries no position of its own.
    this.previousWindowRejectionHandler = this.domWindow.onunhandledrejection;
    this.domWindow.onunhandledrejection = ({ reason }) => {
      const originalError = asError(reason);
      const origin = firstStackFrame(originalError.stack);
      const { source, line, column } = origin
        ? mapSourcePosition(origin)
        : { source: undefined, line: undefined, column: undefined };

      this.reportUncaughtError({
        message: `Uncaught (in promise) ${originalError}`,
        url: source,
        line,
        column,
        originalError,
      });
    };
  }

  reportUncaughtError(eventObject) {
    let openDevTools = true;
    eventObject.preventDefault = () => {
      openDevTools = false;
    };

    this.emitter.emit("will-throw-error", eventObject);

    if (openDevTools) {
      // Swallowed deliberately: an unhandled rejection here would come straight
      // back through this same reporter, and open the dev tools forever.
      this.window
        .openDevTools()
        .then(() => this.window.executeJavaScriptInDevTools('DevToolsAPI.showPanel("console")'))
        .catch(() => {});
    }

    const { message, url, line, column, originalError } = eventObject;
    this.emitter.emit("did-throw-error", {
      message,
      url,
      line,
      column,
      originalError,
    });
  }

  uninstallUncaughtErrorHandler() {
    this.domWindow.onerror = this.previousWindowErrorHandler;
    this.domWindow.onunhandledrejection = this.previousWindowRejectionHandler;
  }

  installWindowEventHandler() {
    this.#windowEventHandler = new WindowEventHandler({
      lumineEnvironment: this,
      applicationDelegate: this.applicationDelegate,
    });
    this.#windowEventHandler.initialize(this.domWindow, this.document);
  }

  uninstallWindowEventHandler() {
    if (this.#windowEventHandler) {
      this.#windowEventHandler.unsubscribe();
    }
    this.#windowEventHandler = null;
  }

  didChangeStyles(styleElement) {
    TextEditor.didUpdateStyles();
    if (styleElement.textContent.indexOf("scrollbar") >= 0) {
      TextEditor.didUpdateScrollbarStyles();
    }
  }

  async updateProcessEnvAndTriggerHooks() {
    await this.updateProcessEnv(this.#getLoadSettings().env);
    this.shellEnvironmentLoaded = true;
    this.emitter.emit("loaded-shell-environment");
    this.packages.triggerActivationHook("core:loaded-shell-environment");
  }

  /**
   * @category Private
   */

  assert(condition, message, callbackOrMetadata) {
    if (condition) return true;

    const error = new Error(`Assertion failed: ${message}`);
    Error.captureStackTrace(error, this.assert);

    if (callbackOrMetadata) {
      if (typeof callbackOrMetadata === "function") {
        callbackOrMetadata(error);
      } else {
        error.metadata = callbackOrMetadata;
      }
    }

    this.emitter.emit("did-fail-assertion", error);
    // A broken invariant is a hard error while developing and under test, and
    // telemetry in a build a user is running. That distinction is about who is
    // at the keyboard, not about what the version string says — keying it on
    // the release channel meant a dev build silently swallowed assertions the
    // moment master stopped carrying a prerelease suffix.
    if (this.window.isDevMode() || this.window.isSpecMode()) throw error;

    return false;
  }

  loadThemes() {
    return this.themes.load();
  }

  setDocumentEdited(edited) {
    if (typeof this.applicationDelegate.setWindowDocumentEdited === "function") {
      this.applicationDelegate.setWindowDocumentEdited(edited);
    }
  }

  setRepresentedFilename(filename) {
    if (typeof this.applicationDelegate.setWindowRepresentedFilename === "function") {
      this.applicationDelegate.setWindowRepresentedFilename(filename);
    }
  }

  async addProjectFolder() {
    const selectedPaths = await this.window.pickFolder();
    return this.addToProject(selectedPaths || []);
  }

  async addToProject(projectPaths) {
    const state = await this.loadState(this.getStateKey(projectPaths));
    if (state && this.project.getPaths().length === 0) {
      this.attemptRestoreProjectStateForPaths(state, projectPaths);
    } else {
      this.project.addPaths(projectPaths);
    }
  }

  async attemptRestoreProjectStateForPaths(state, projectPaths, filesToOpen = []) {
    const center = this.workspace.getCenter();
    const windowIsUnused = () => {
      for (let container of this.workspace.getPaneContainers()) {
        for (let item of container.getPaneItems()) {
          if (item instanceof TextEditor) {
            if (item.getPath() || item.getFileState() !== FileState.UNMODIFIED) return false;
          } else {
            if (container === center) return false;
          }
        }
      }
      return true;
    };

    if (windowIsUnused()) {
      await this.restoreStateIntoThisEnvironment(state);
      return Promise.all(filesToOpen.map((file) => this.workspace.open(file)));
    } else {
      const nouns = projectPaths.length === 1 ? "folder" : "folders";
      const response = await this.window.confirm({
        message: "Previous automatically-saved project state detected",
        detail:
          `There is previously saved state for the selected ${nouns}. ` +
          `Would you like to add the ${nouns} to this window, permanently discarding the saved state, ` +
          `or open the ${nouns} in a new window, restoring the saved state?`,
        buttons: ["&Open in new window and recover state", "&Add to this window and discard state"],
      });

      if (response === 0) {
        this.application.openWindow({
          pathsToOpen: projectPaths.concat(filesToOpen),
          newWindow: true,
          devMode: this.window.isDevMode(),
          safeMode: this.window.isSafeMode(),
        });
        return null;
      }
      if (response === 1) {
        this.project.addPaths(projectPaths);
        return Promise.all(filesToOpen.map((file) => this.workspace.open(file)));
      }
    }
  }

  async restoreStateIntoThisEnvironment(state, options) {
    state.fullScreen = await this.window.isFullScreen();
    // The current panes are destroyed by Workspace::deserialize, which carries
    // persistent items over to the restored layout without flicker.
    return this.deserialize(state, options);
  }

  /**
   * Implements {@link Project#setState}, which is where this is
   * documented. It lives here because the project can reach neither the window
   * state store nor the workspace.
   *
   * @returns {Promise} that resolves to whether the window changed.
   * @private
   */
  async restoreProjectState(projectPaths) {
    // Resolve the same way ::openLocations does before hashing: the state key
    // is a hash of the path strings, so an unresolved path would miss its own
    // saved session.
    const folders = projectPaths.map((projectPath) =>
      this.project.getDirectoryForProjectPath(projectPath).getPath(),
    );
    if (folders.length === 0) return false;

    const currentPaths = this.project.getPaths();
    if (this.getStateKey(folders) === this.getStateKey(currentPaths)) return false;

    // Flush the outgoing session before anything is torn down. `isUnloading`
    // carries marker layers and undo history with it, so coming back lands on
    // the window as it is now.
    await this.saveState({ isUnloading: true });

    // The same question ::prepareToUnloadEditorWindow asks, and for the same
    // reason: with a project and a working state store, only a file that
    // conflicts with what is on disk still prompts, because everything else
    // was just persisted.
    const closing = await this.workspace.confirmClose({
      windowCloseRequested: true,
      projectHasPaths: currentPaths.length > 0,
    });
    if (!closing) return false;

    const state = await this.loadState(this.getStateKey(folders));
    const locations = PROJECT_STATE_LOCATIONS;

    await this.workspace.clear({ locations });
    this.project.destroyUnretainedBuffers();
    // Settings from a project file are resolved when a window launches, so
    // they cannot be resolved again here. Clearing them is the honest
    // direction: better none than the outgoing project's.
    this.config.clearProjectSettings();

    if (state) {
      await this.restoreStateIntoThisEnvironment(state, { locations });
    } else {
      this.project.setPaths(folders, { mustExist: true, exact: true });
      if (this.config.get("core.openEmptyEditorOnStart")) {
        await this.workspace.open(null, { pending: true });
      }
    }

    return true;
  }

  async saveState(options, storageKey) {
    if (this.enablePersistence && this.project) {
      const state = this.serialize(options);
      if (!storageKey) storageKey = this.getStateKey(this.project && this.project.getPaths());
      if (storageKey) {
        await this.stateStore.save(storageKey, state);
      } else {
        await this.applicationDelegate.setTemporaryWindowState(state);
      }
    }
  }

  loadState(stateKey) {
    if (this.enablePersistence) {
      if (!stateKey) stateKey = this.getStateKey(this.#getLoadSettings().initialProjectRoots);
      if (stateKey) {
        return this.stateStore.load(stateKey);
      } else {
        return this.applicationDelegate.getTemporaryWindowState();
      }
    } else {
      return Promise.resolve(null);
    }
  }

  // * `options` An optional `Object` passed on to {@link Workspace#deserialize},
  //   which reads `locations` from it.
  async deserialize(state, options) {
    if (!state) return Promise.resolve();

    await this.window.setFullScreen(Boolean(state.fullScreen));
    this.#setAutoHideMenuBar(this.config.get("core.autoHideMenuBar"));

    const missingProjectPaths = [];

    this.packages.packageStates = state.packageStates || {};
    this.uriHandlers.deserialize(state.uriHistory);

    let startTime = Date.now();
    if (state.project) {
      try {
        await this.project.deserialize(state.project, this.deserializers);
      } catch (error) {
        // We handle the missingProjectPaths case in openLocations().
        if (!error.missingProjectPaths) {
          this.notifications.addError("Unable to deserialize project", {
            description: error.message,
            stack: error.stack,
          });
        }
      }
    }

    this.deserializeTimings.project = Date.now() - startTime;

    if (state.grammars) this.grammars.deserialize(state.grammars);

    startTime = Date.now();
    if (state.workspace) this.workspace.deserialize(state.workspace, this.deserializers, options);
    this.deserializeTimings.workspace = Date.now() - startTime;

    if (missingProjectPaths.length > 0) {
      const count = missingProjectPaths.length === 1 ? "" : missingProjectPaths.length + " ";
      const noun = missingProjectPaths.length === 1 ? "folder" : "folders";
      const toBe = missingProjectPaths.length === 1 ? "is" : "are";
      const escaped = missingProjectPaths.map((projectPath) => `\`${projectPath}\``);
      let group;
      switch (escaped.length) {
        case 1:
          group = escaped[0];
          break;
        case 2:
          group = `${escaped[0]} and ${escaped[1]}`;
          break;
        default:
          group = escaped.slice(0, -1).join(", ") + `, and ${escaped[escaped.length - 1]}`;
      }

      this.notifications.addError(`Unable to open ${count}project ${noun}`, {
        description: `Project ${noun} ${group} ${toBe} no longer on disk.`,
      });
    }
  }

  getStateKey(paths) {
    if (paths && paths.length > 0) {
      const sha1 = crypto.createHash("sha1").update(paths.slice().sort().join("\n")).digest("hex");
      return `editor-${sha1}`;
    } else {
      return null;
    }
  }

  getConfigDirPath() {
    if (!this.configDirPath) this.configDirPath = process.env.LUMINE_HOME;
    return this.configDirPath;
  }

  getUserInitScriptPath() {
    const initScriptPath = fs.resolve(this.getConfigDirPath(), "init", ["js"]);
    return initScriptPath || path.join(this.getConfigDirPath(), "init.js");
  }

  requireUserInitScript() {
    const userInitScriptPath = this.getUserInitScriptPath();
    if (userInitScriptPath) {
      try {
        if (fs.isFileSync(userInitScriptPath)) require(userInitScriptPath);
      } catch (error) {
        this.notifications.addError(`Failed to load \`${userInitScriptPath}\``, {
          detail: error.message,
          dismissable: true,
        });
      }
    }
  }

  setBodyPlatformClass() {
    this.document.body.classList.add(`platform-${process.platform}`);
  }

  #setAutoHideMenuBar(autoHide) {
    autoHide = Boolean(autoHide);
    return Promise.all([
      this.window.setAutoHideMenuBar(autoHide),
      this.window.setMenuBarVisibility(!autoHide),
    ]);
  }

  dispatchApplicationMenuCommand(command, arg) {
    let { activeElement } = this.document;
    // Use the workspace element if body has focus
    if (activeElement === this.document.body) {
      activeElement = this.workspace.getElement();
    }
    this.commands.dispatch(activeElement, command, arg);
  }

  dispatchContextMenuCommand(command, ...args) {
    this.commands.dispatch(this.contextMenu.activeElement, command, args);
  }

  dispatchURIMessage(uri) {
    if (this.packages.hasLoadedInitialPackages()) {
      this.uriHandlers.handleURI(uri);
    } else {
      let subscription = this.packages.onDidLoadInitialPackages(() => {
        subscription.dispose();
        this.uriHandlers.handleURI(uri);
      });
    }
  }

  // Caps how many files one bulk open — a drop of many files, or a command
  // line naming them — will add, at `core.maxTextEditors`. The files past the
  // cap are never opened, rather than opened and closed again, which would cost
  // strictly more than opening them and stopping.
  //
  // The cap counts the whole workspace rather than the pane the files land in.
  // Splitting the same editors across panes was measured to leave the costs
  // that actually hurt almost untouched — with 200 editors open, opening one
  // more file took 535ms in a single pane against 485ms across four, and the
  // heap 242MB against 228MB — because buffers, repository subscriptions and
  // long titles all belong to the workspace. Only the tab bar's own work is
  // per pane.
  //
  // Two things are never capped. A single file, because a deliberate open must
  // land. And a file the command line is waiting on: `--wait` resolves when the
  // item is destroyed, so a file that never opens would leave the caller
  // waiting forever.
  limitFileLocationsToOpen(fileLocations) {
    const maxTextEditors = this.config?.get("core.maxTextEditors") ?? 0;
    if (!maxTextEditors || fileLocations.length <= 1 || !this.workspace) return fileLocations;

    const waited = fileLocations.filter((location) => location.hasWaitSession);
    const cappable = fileLocations.filter((location) => !location.hasWaitSession);

    const alreadyOpen = this.workspace.getTextEditors().length;
    const room = Math.max(0, maxTextEditors - alreadyOpen - waited.length);
    if (cappable.length <= room) return fileLocations;

    const opening = waited.concat(cappable.slice(0, room));
    const skippedLocations = cappable.slice(room);
    const skipped = skippedLocations.length;
    const files = skipped === 1 ? "file" : "files";
    this.notifications.addWarning(
      opening.length > 0
        ? `Opened ${opening.length} of ${fileLocations.length} files`
        : `Opened none of ${fileLocations.length} files`,
      {
        description:
          `${skipped} ${files} ${skipped === 1 ? "was" : "were"} left unopened: the limit of ` +
          `${maxTextEditors} open editors set by \`core.maxTextEditors\` was reached. Raise that ` +
          `setting, or set it to 0 for no limit.`,
        dismissable: true,
        buttons: [
          {
            text: skipped === 1 ? "Open it anyway" : `Open the other ${skipped} anyway`,
            onDidClick: () => this.openFileLocations(skippedLocations, { bypassLimit: true }),
          },
        ],
      },
    );
    return opening;
  }

  // Opens each location, activating only the last: activating every one costs a
  // full fan-out per file, and a pane keeps every view it has ever shown
  // mounted, so a bulk open would otherwise leave the window carrying an editor
  // component for each.
  openFileLocations(fileLocations, { bypassLimit = false } = {}) {
    const lastIndex = fileLocations.length - 1;
    return Promise.all(
      fileLocations.map(({ pathToOpen, initialLine, initialColumn }, index) => {
        const activate = index === lastIndex;
        return (
          this.workspace &&
          this.workspace.open(pathToOpen, {
            initialLine,
            initialColumn,
            activateItem: activate,
            activatePane: activate,
            bypassTextEditorLimit: bypassLimit,
          })
        );
      }),
    );
  }

  async openLocations(locations) {
    const needsProjectPaths = this.project && this.project.getPaths().length === 0;
    const foldersToAddToProject = new Set();
    const fileLocationsToOpen = [];
    const missingFolders = [];

    // Asynchronously fetch stat information about each requested path to open.
    const locationStats = await Promise.all(
      locations.map(async (location) => {
        const stats = location.pathToOpen
          ? await stat(location.pathToOpen).catch(() => null)
          : null;
        return { location, stats };
      }),
    );

    for (const { location, stats } of locationStats) {
      const { pathToOpen } = location;
      if (!pathToOpen) {
        // Untitled buffer
        fileLocationsToOpen.push(location);
        continue;
      }

      if (stats !== null) {
        // Path exists
        if (stats.isDirectory()) {
          // Directory: add as a project folder
          foldersToAddToProject.add(this.project.getDirectoryForProjectPath(pathToOpen).getPath());
        } else if (stats.isFile()) {
          if (location.isDirectory) {
            // File: no longer a directory
            missingFolders.push(location);
          } else {
            // File: add as a file location
            fileLocationsToOpen.push(location);
          }
        }
      } else {
        // Path does not exist
        // Attempt to interpret as a URI from a non-default directory provider
        const directory = this.project.getProvidedDirectoryForProjectPath(pathToOpen);
        if (directory) {
          // Found: add as a project folder
          foldersToAddToProject.add(directory.getPath());
        } else if (location.isDirectory) {
          // Not found and must be a directory: add to missing list and use to derive state key
          missingFolders.push(location);
        } else {
          // Not found: open as a new file
          fileLocationsToOpen.push(location);
        }
      }

      if (location.hasWaitSession) this.pathsWithWaitSessions.add(pathToOpen);
    }

    let restoredState = false;
    if (foldersToAddToProject.size > 0 || missingFolders.length > 0) {
      // Include missing folders in the state key so that sessions restored with no-longer-present project root folders
      // don't lose data.
      const foldersForStateKey = Array.from(foldersToAddToProject).concat(
        missingFolders.map((location) => location.pathToOpen),
      );
      const state = await this.loadState(this.getStateKey(Array.from(foldersForStateKey)));

      // only restore state if this is the first path added to the project
      if (state && needsProjectPaths) {
        const files = fileLocationsToOpen.map((location) => location.pathToOpen);
        await this.attemptRestoreProjectStateForPaths(
          state,
          Array.from(foldersToAddToProject),
          files,
        );
        restoredState = true;
      } else {
        this.project.addPaths(foldersToAddToProject);
      }
    }

    if (!restoredState) {
      // These have already been decided against the limit, so opening them must
      // not be refused a second time by the check inside `Workspace.open`.
      await this.openFileLocations(this.limitFileLocationsToOpen(fileLocationsToOpen), {
        bypassLimit: true,
      });
    }

    if (missingFolders.length > 0) {
      let message = "Unable to open project folder";
      if (missingFolders.length > 1) {
        message += "s";
      }

      let description = "The ";
      if (missingFolders.length === 1) {
        description += "directory `";
        description += missingFolders[0].pathToOpen;
        description += "` does not exist.";
      } else if (missingFolders.length === 2) {
        description += `directories \`${missingFolders[0].pathToOpen}\` `;
        description += `and \`${missingFolders[1].pathToOpen}\` do not exist.`;
      } else {
        description += "directories ";
        description += missingFolders
          .slice(0, -1)
          .map((location) => location.pathToOpen)
          .map((pathToOpen) => "`" + pathToOpen + "`, ")
          .join("");
        description +=
          "and `" + missingFolders[missingFolders.length - 1].pathToOpen + "` do not exist.";
      }

      let notification;

      let removeMissingPaths = async () => {
        this.applicationDelegate.setProjectRoots(this.project.getPaths());

        if (notification) {
          notification.dismiss();
        }
      };

      let skipRemove = () => {
        if (notification) {
          notification.dismiss();
        }
      };

      notification = this.notifications.addWarning(message, {
        description,
        dismissable: true,
        buttons: [
          { text: "Remove all", onDidClick: removeMissingPaths },
          { text: "Skip for now", onDidClick: skipRemove },
        ],
      });
    }

    void this.applicationDelegate.invokeWindow("locationsOpened");
  }

  resolveProxy(url) {
    return new Promise((resolve, _reject) => {
      const requestId = this.nextProxyRequestId++;
      const disposable = this.applicationDelegate.onDidResolveProxy((id, proxy) => {
        if (id === requestId) {
          disposable.dispose();
          resolve(proxy);
        }
      });

      return this.applicationDelegate.resolveProxy(requestId, url);
    });
  }
}

// A promise can be rejected with anything at all, but everything downstream of
// an uncaught error — the notifications package first — expects an Error.
function asError(reason) {
  if (reason instanceof Error) return reason;
  return untraceableError(`Promise rejected with ${util.inspect(reason)}`);
}

// The two notifications a browser raises when a ResizeObserver still had
// observations to deliver at the end of a delivery cycle.
const RESIZE_OBSERVER_NOTIFICATIONS = [
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
];

// Whether a window error is the browser saying a ResizeObserver ran out of
// delivery passes this frame. It is informational, not a fault: the browser
// breaks the cycle itself and delivers what is left on the next frame, and
// nothing was lost. It carries no error object, no source position and no
// console output, so reporting it opens the dev tools on an empty console with
// nothing to act on — which is what any editor holding block decorations did
// on every resize, since the component observes each decoration's element.
function isBenignResizeObserverNotification(message) {
  return RESIZE_OBSERVER_NOTIFICATIONS.some((notification) =>
    String(message ?? "").includes(notification),
  );
}

// An Error standing in for one there is nothing more to say about. It carries
// no stack: a synthesized one would describe this reporter rather than
// whatever went wrong, and a handler that decides by stack would read that as
// a fault in core.
function untraceableError(message) {
  const error = new Error(message);
  error.stack = undefined;
  return error;
}

const STACK_FRAME = /^\s*at (?:.*\()?(.+?):(\d+):(\d+)\)?$/;

// Where a stack says the error came from, in the shape `window.onerror` would
// have reported it. Returns undefined when the stack says nothing usable.
function firstStackFrame(stack) {
  for (const frame of String(stack || "").split("\n")) {
    const match = STACK_FRAME.exec(frame);
    if (match) return { source: match[1], line: Number(match[2]), column: Number(match[3]) };
  }
}

Environment.version = 1;
Environment.prototype.saveStateDebounceInterval = 1000;
module.exports = Environment;
