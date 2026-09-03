const { BrowserWindow, app, dialog, ipcMain, nativeImage, webContents } = require("electron");
const { getAppName } = require("./get-app-details.js");
const path = require("path");
const fs = require("fs");
const url = require("url");
const { EventEmitter } = require("events");
const StartupTime = require("./startup-time");

// Packaged builds ship the icon under resourcesPath; a source checkout falls
// back to the repo's own copy. Parameterized by filename rather than a single
// constant so a window can pick the icon for its own run mode.
function resolveIconPath(fileName) {
  const packagedPath = path.resolve(process.resourcesPath, fileName);
  if (fs.existsSync(packagedPath)) return packagedPath;
  return path.resolve(__dirname, "..", "resources", "app-icons", fileName);
}

// Safe mode wins over dev mode the same way title-bar's launch-mode badge
// resolves it: it is the more restrictive state, and a window can be both
// (npm start --safe) but should read as safe, not dev.
function iconFileNameForMode(safeMode, devMode) {
  if (safeMode) return "lumine-safe.png";
  if (devMode) return "lumine-dev.png";
  return "lumine.png";
}

let includeShellLoadTime = true;
let nextId = 0;

module.exports = class LumineWindow extends EventEmitter {
  constructor(lumineApplication, fileRecoveryService, settings = {}) {
    StartupTime.addMarker("main-process:lumine-window:start");

    super();

    this.id = nextId++;
    this.lumineApplication = lumineApplication;
    this.fileRecoveryService = fileRecoveryService;
    this.isSpec = settings.isSpec;
    this.headless = settings.headless;
    this.offscreen = settings.offscreen;
    this.safeMode = settings.safeMode;
    this.devMode = settings.devMode;
    this.resourcePath = settings.resourcePath;

    const locationsToOpen = settings.locationsToOpen || [];

    this.loadedPromise = new Promise((resolve) => {
      this.resolveLoadedPromise = resolve;
    });
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosedPromise = resolve;
    });

    const options = {
      frame: false,
      show: false,
      title: getAppName(),
      tabbingIdentifier: "lumine",
      webPreferences: {
        // Prevent specs from throttling when the window is in the background:
        // this should result in faster CI builds, and an improvement in the
        // local development experience when running specs through the UI (which
        // now won't pause when e.g. minimizing the window).
        backgroundThrottling: !this.isSpec,
        // Chromium throttles a normally hidden window's animation frames even
        // when background throttling is disabled. Electron's offscreen
        // compositor supplies its own frame source, allowing local command-line
        // specs to render without putting a native window on the desktop.
        offscreen: this.offscreen,
        // Disable the `auxclick` feature so that `click` events are triggered in
        // response to a middle-click.
        // (Ref: https://github.com/atom/atom/pull/12696#issuecomment-290496960)
        disableBlinkFeatures: "Auxclick,ObservableAPI",
        nodeIntegration: true,
        contextIsolation: false,
        webviewTag: true,

        // node support in threads
        nodeIntegrationInWorker: true,
      },
      simpleFullscreen: this.getSimpleFullscreen(),
    };

    // A packaged Windows build's .exe already has an icon baked in at build
    // time (electron-builder), but that icon cannot know the runtime mode --
    // a packaged Lumine.exe launched with --dev still needs the colored icon
    // set here, the same as an unpackaged source checkout does. So this runs
    // unconditionally on win32, not just when process.defaultApp is true.
    const iconPath = resolveIconPath(iconFileNameForMode(this.safeMode, this.devMode));
    if (process.platform === "linux" || process.platform === "win32") {
      options.icon = nativeImage.createFromPath(iconPath);
    }
    // The dock icon is one per app, not per window, so with several windows
    // open in different modes the most recently created one wins — the same
    // "last one drawn" rule the taskbar/dock already applies to everything
    // else about window state.
    if (process.platform === "darwin") app.dock.setIcon(iconPath);
    // Enabling window transparency creates several downstream issues relating
    // to management of window size and maximixed state.
    //
    // Hence this option was removed from the config schema because it's a
    // footgun, but we've left it in for those users who really know what
    // they're doing.
    if (this.lumineApplication.config.get("core.allowWindowTransparency")) {
      options.transparent = true;
    }

    const BrowserWindowConstructor = settings.browserWindowConstructor || BrowserWindow;
    this.browserWindow = new BrowserWindowConstructor(options);
    if (this.offscreen) {
      this.browserWindow.webContents.setFrameRate(60);
      this.browserWindow.webContents.startPainting();
    }
    this.lumineApplication.registerLumineWindow?.(this);

    this.handleEvents();

    this.loadSettings = Object.assign({}, settings);
    this.loadSettings.appVersion = app.getVersion();
    this.loadSettings.appName = getAppName();
    this.loadSettings.resourcePath = this.resourcePath;
    this.loadSettings.lumineHome = process.env.LUMINE_HOME;
    if (this.loadSettings.devMode == null) this.loadSettings.devMode = false;
    if (this.loadSettings.safeMode == null) this.loadSettings.safeMode = false;
    if (this.loadSettings.clearWindowState == null) this.loadSettings.clearWindowState = false;

    this.addLocationsToOpen(locationsToOpen);

    this.loadSettings.hasOpenFiles = locationsToOpen.some(
      (location) => location.pathToOpen && !location.isDirectory,
    );
    this.loadSettings.initialProjectRoots = this.projectRoots;

    StartupTime.addMarker("main-process:lumine-window:end");

    // Only send to the first non-spec window created
    if (includeShellLoadTime && !this.isSpec) {
      includeShellLoadTime = false;
      if (!this.loadSettings.shellLoadTime) {
        this.loadSettings.shellLoadTime = Date.now() - global.shellStartTime;
      }
    }

    if (!this.loadSettings.env) this.env = this.loadSettings.env;

    this.browserWindow.on("window:loaded", () => {
      this.disableZoom();
      this.emit("window:loaded");
      this.resolveLoadedPromise();
    });

    this.browserWindow.on("window:locations-opened", () => {
      this.emit("window:locations-opened");
    });

    this.browserWindow.on("enter-full-screen", () => {
      this.sendToRenderer("did-enter-full-screen");
    });

    this.browserWindow.on("leave-full-screen", () => {
      this.sendToRenderer("did-leave-full-screen");
    });

    this.browserWindow.on("maximize", () => {
      this.sendToRenderer("did-maximize-window");
    });

    this.browserWindow.on("unmaximize", () => {
      this.sendToRenderer("did-unmaximize-window");
    });

    this.browserWindow.on("focus", () => {
      this.sendToRenderer("did-focus-window");
    });

    this.browserWindow.on("blur", () => {
      this.sendToRenderer("did-blur-window");
    });

    this.browserWindow.loadURL(
      url.format({
        protocol: "file",
        pathname: `${this.resourcePath}/static/index.html`,
        slashes: true,
      }),
    );

    if (this.isSpec) this.browserWindow.focusOnWebView();

    const hasPathToOpen = !(locationsToOpen.length === 1 && locationsToOpen[0].pathToOpen == null);
    if (hasPathToOpen && !this.isSpecWindow()) this.openLocations(locationsToOpen);
  }

  hasProjectPaths() {
    return this.projectRoots.length > 0;
  }

  consumeStartupMarkers() {
    const timingData = StartupTime.exportData();
    StartupTime.deleteData();
    return timingData;
  }

  getLoadSettingsForRenderer() {
    return Object.assign(
      {
        configFilePath: this.lumineApplication.configFile.path,
        userSettings: !this.isSpec ? this.lumineApplication.configFile.get() : null,
      },
      this.loadSettings,
    );
  }

  containsLocations(locations) {
    return locations.every((location) => this.containsLocation(location));
  }

  containsLocation(location) {
    if (!location.pathToOpen) return false;

    return this.projectRoots.some((projectPath) => {
      if (location.pathToOpen === projectPath) return true;
      if (location.pathToOpen.startsWith(path.join(projectPath, path.sep))) {
        if (!location.exists) return true;
        if (!location.isDirectory) return true;
      }
      return false;
    });
  }

  handleEvents() {
    this.browserWindow.on("close", async (event) => {
      if (
        (!this.lumineApplication.quitting || this.lumineApplication.quittingForUpdate) &&
        !this.unloading
      ) {
        event.preventDefault();
        this.unloading = true;
        this.lumineApplication.saveCurrentWindowOptions(false);
        if (await this.prepareToUnload()) this.close();
      }
    });

    this.browserWindow.on("closed", () => {
      this.fileRecoveryService.didCloseWindow(this);
      this.lumineApplication.removeWindow(this);
      this.resolveClosedPromise();
    });

    this.browserWindow.on("unresponsive", async () => {
      if (this.isSpec) return;
      const result = await dialog.showMessageBox(this.browserWindow, {
        type: "warning",
        buttons: ["Force Close", "Keep Waiting"],
        cancelId: 1, // Canceling should be the least destructive action
        message: "Editor is not responding",
        detail:
          "The editor is not responding. Would you like to force close it or just keep waiting?",
      });
      if (result.response === 0) this.browserWindow.destroy();
    });

    this.browserWindow.webContents.on("render-process-gone", async (event, details) => {
      const { reason, exitCode } = details;
      // Always leave a trace: the dialog below is deliberately not shown for
      // every departure, and a renderer that goes away without one is
      // otherwise silent.
      console.log(`Renderer process gone (reason: ${reason}, exitCode: ${exitCode})`);

      // Not every departure is a crash. Electron reports a renderer that
      // exited with status zero as `clean-exit` and one taken down by the OS
      // or by us as `killed`, and both arrive here during ordinary teardown —
      // quitting, reloading, closing a window. Prompting for those turns a
      // normal restart into a crash report.
      if (reason === "clean-exit" || reason === "killed") return;

      // A window already on its way out has nothing left to recover or
      // reload, and a modal at that point can only get in the way of the
      // quit it is interrupting.
      if (this.unloading || this.lumineApplication.quitting) return;

      if (this.headless) {
        this.lumineApplication.exit(100);
        return;
      }

      await this.fileRecoveryService.didCrashWindow(this);

      const result = await dialog.showMessageBox(this.browserWindow, {
        type: "warning",
        buttons: ["Close Window", "Reload", "Keep It Open"],
        cancelId: 2, // Canceling should be the least destructive action
        message: "The editor has crashed",
        detail:
          `Reason: ${reason} (exit code ${exitCode}).\n\n` +
          "Please report this issue to https://github.com/lumine-code/lumine",
      });

      switch (result.response) {
        case 0:
          this.browserWindow.destroy();
          break;
        case 1:
          this.browserWindow.reload();
          break;
      }
    });

    this.browserWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== this.browserWindow.webContents.getURL()) event.preventDefault();
    });

    // Spec window's web view should always have focus
    if (this.isSpec) this.browserWindow.on("blur", () => this.browserWindow.focusOnWebView());
  }

  async prepareToUnload() {
    if (this.isSpecWindow()) return true;

    this.lastPrepareToUnloadPromise = new Promise((resolve) => {
      const callback = (event, result) => {
        if (BrowserWindow.fromWebContents(event.sender) === this.browserWindow) {
          ipcMain.removeListener("did-prepare-to-unload", callback);
          if (!result) {
            this.unloading = false;
            this.lumineApplication.quitting = false;
          }
          resolve(result);
        }
      };
      ipcMain.on("did-prepare-to-unload", callback);
      // A dropped message never earns a reply, so waiting on one would hang this
      // handshake for good and leak the listener with it. A renderer that cannot
      // be reached has nothing left to save and no veto to cast, so treat the
      // unload as agreed to rather than waiting on an answer that never comes.
      if (!this.sendToRenderer("prepare-to-unload")) {
        ipcMain.removeListener("did-prepare-to-unload", callback);
        resolve(true);
      }
    });

    return this.lastPrepareToUnloadPromise;
  }

  openPath(pathToOpen, initialLine, initialColumn) {
    return this.openLocations([{ pathToOpen, initialLine, initialColumn }]);
  }

  async openLocations(locationsToOpen) {
    this.addLocationsToOpen(locationsToOpen);
    await this.loadedPromise;
    this.sendMessage("open-locations", locationsToOpen);
  }

  didChangeUserSettings(settings) {
    this.sendMessage("did-change-user-settings", settings);
  }

  didFailToReadUserSettings(message) {
    this.sendMessage("did-fail-to-read-user-settings", message);
  }

  addLocationsToOpen(locationsToOpen) {
    const roots = new Set(this.projectRoots || []);
    for (const { pathToOpen, isDirectory } of locationsToOpen) {
      if (isDirectory) {
        roots.add(pathToOpen);
      }
    }

    this.projectRoots = Array.from(roots);
    this.projectRoots.sort();
  }

  replaceEnvironment(env) {
    const {
      NODE_ENV,
      NODE_PATH,
      LUMINE_HOME,
      LUMINE_CHANNEL,
      LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT,
    } = env;

    this.sendToRenderer("environment", {
      NODE_ENV,
      NODE_PATH,
      LUMINE_HOME,
      LUMINE_CHANNEL,
      LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT,
    });
  }

  // Window events such as `blur` and `focus` can arrive during close or
  // reload, after the renderer's main frame has already been disposed.
  // Sending IPC at that point has no renderer left to act on it, so drop the
  // message instead of letting Electron log a disposed-frame error.
  //
  // The window and its `webContents` both outlive that disposal, so neither
  // `isDestroyed()` catches it: only `isDestroyed()` on the frame does, and it
  // is the one accessor that stays safe once the frame is disposed, so it has
  // to come before any other frame property.
  //
  // `frame.detached` is deliberately NOT part of that liveness check. After a
  // renderer crash and reload (a Windows resume from hibernation kills
  // renderers this way), the main-frame wrapper of the replacement page can
  // report `detached: true` forever while the page is alive and interactive.
  // Dropping on that flag silently voids every main→renderer message for the
  // window for the rest of the session — `open-locations` and with it the
  // whole File menu, drag-and-drop, and the Open dialog.
  //
  // Returns true when the message was sent, so a caller that waits for a
  // reply can tell a dropped message apart from one still in flight.
  sendToRenderer(channel, ...args) {
    if (this.browserWindow.isDestroyed()) return false;
    const contents = this.browserWindow.webContents;
    if (contents.isDestroyed()) return false;
    const frame = contents.mainFrame;
    if (!frame || frame.isDestroyed()) return false;
    contents.send(channel, ...args);
    return true;
  }

  sendMessage(message, detail) {
    this.sendToRenderer("message", message, detail);
  }

  sendCommand(command, ...args) {
    if (this.isSpecWindow()) {
      if (!this.lumineApplication.sendCommandToFirstResponder(command)) {
        switch (command) {
          case "window:reload":
            return this.reload();
          case "window:toggle-dev-tools":
            return this.toggleDevTools();
          case "window:close":
            return this.close();
        }
      }
    } else if (this.isWebViewFocused()) {
      this.sendCommandToBrowserWindow(command, ...args);
    } else if (!this.lumineApplication.sendCommandToFirstResponder(command)) {
      this.sendCommandToBrowserWindow(command, ...args);
    }
  }

  sendURIMessage(uri) {
    this.sendToRenderer("uri-message", uri);
  }

  sendCommandToBrowserWindow(command, ...args) {
    this.sendToRenderer("command", command, ...args);
  }

  getDimensions() {
    const [x, y] = Array.from(this.browserWindow.getPosition());
    const [width, height] = Array.from(this.browserWindow.getSize());
    return { x, y, width, height };
  }

  getSimpleFullscreen() {
    return this.lumineApplication.config.get("core.simpleFullScreenWindows");
  }

  close() {
    return this.browserWindow.close();
  }

  focus() {
    return this.browserWindow.focus();
  }

  minimize() {
    return this.browserWindow.minimize();
  }

  maximize() {
    return this.browserWindow.maximize();
  }

  unmaximize() {
    return this.browserWindow.unmaximize();
  }

  restore() {
    return this.browserWindow.restore();
  }

  setFullScreen(fullScreen) {
    return this.browserWindow.setFullScreen(fullScreen);
  }

  handlesLumineCommands() {
    return !this.isSpecWindow() && this.isWebViewFocused();
  }

  isFocused() {
    return this.browserWindow.isFocused();
  }

  isMaximized() {
    return this.browserWindow.isMaximized();
  }

  isMinimized() {
    return this.browserWindow.isMinimized();
  }

  isWebViewFocused() {
    const focusedWebContents = webContents.getFocusedWebContents();
    if (focusedWebContents == null) return false;

    return (
      focusedWebContents === this.browserWindow.webContents ||
      focusedWebContents.hostWebContents === this.browserWindow.webContents ||
      BrowserWindow.fromWebContents(focusedWebContents) === this.browserWindow
    );
  }

  isSpecWindow() {
    return this.isSpec;
  }

  // `loadedPromise` is the latch every `openLocations` waits on, and only a
  // `window:loaded` event from a freshly loaded renderer can settle it. So a
  // pending one must never be installed before the reload is certain: an unload
  // the renderer refuses leaves it unsettled with nothing left to resolve it,
  // and from then on every main-process path that opens a path in this window
  // awaits forever. That is silent — `application:open-your-keymap` and the
  // rest of `openPathOnEvent` simply stop doing anything while the renderer
  // itself keeps working normally. Commit to the reload first, latch second.
  async reload({ skipPrepareToUnload = false } = {}) {
    const canUnload = skipPrepareToUnload || (await this.prepareToUnload());
    if (!canUnload || this.browserWindow.isDestroyed()) return this.loadedPromise;

    this.loadedPromise = new Promise((resolve) => {
      this.resolveLoadedPromise = resolve;
    });
    this.browserWindow.reload();
    return this.loadedPromise;
  }

  showSaveDialog(options) {
    options = Object.assign(
      {
        title: "Save File",
        defaultPath: this.projectRoots[0],
      },
      options,
    );

    return dialog.showSaveDialog(this.browserWindow, options);
  }

  toggleDevTools() {
    return this.browserWindow.webContents.toggleDevTools();
  }

  openDevTools() {
    return this.browserWindow.webContents.openDevTools();
  }

  closeDevTools() {
    return this.browserWindow.webContents.closeDevTools();
  }

  setDocumentEdited(documentEdited) {
    return this.browserWindow.setDocumentEdited(documentEdited);
  }

  setRepresentedFilename(representedFilename) {
    return this.browserWindow.setRepresentedFilename(representedFilename);
  }

  setProjectRoots(projectRootPaths) {
    this.projectRoots = projectRootPaths;
    this.projectRoots.sort();
    this.loadSettings.initialProjectRoots = this.projectRoots;
    return this.lumineApplication.saveCurrentWindowOptions();
  }

  didClosePathWithWaitSession(path) {
    this.lumineApplication.windowDidClosePathWithWaitSession(this, path);
  }

  copy() {
    return this.browserWindow.copy();
  }

  disableZoom() {
    return this.browserWindow.webContents.setVisualZoomLevelLimits(1, 1);
  }

  getLoadedPromise() {
    return this.loadedPromise;
  }
};
