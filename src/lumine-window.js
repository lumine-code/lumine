const { BrowserWindow, app, dialog, ipcMain, nativeImage, webContents } = require("electron");
const { getAppName } = require("./get-app-details.js");
const path = require("path");
const fs = require("fs");
const url = require("url");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const AuxiliaryWindowBroker = require("./auxiliary-window-broker");
const StartupTime = require("./startup-time");
const attachEmbeddedKeyboardIpc = require("./embedded-keyboard-ipc");
const attachNativeWindowInput = require("./native-window-input");

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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMITTED_CLOSE_TIMEOUT_MS = 8000;
const FORCE_CLOSE_TIMEOUT_MS = 2000;

module.exports = class LumineWindow extends EventEmitter {
  constructor(lumineApplication, fileRecoveryService, settings = {}) {
    StartupTime.addMarker("main-process:lumine-window:start");

    super();

    this.id = nextId++;
    this.windowStateId = UUID_PATTERN.test(settings.windowStateId)
      ? settings.windowStateId
      : crypto.randomUUID();
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
      // Keep the native mouse pointer visible while typing on platforms where
      // Electron exposes the window-level auto-hide control. Windows uses the
      // Chromium feature switch configured in start.js instead.
      disableAutoHideCursor: true,
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
        webviewTag: false,

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
    this.presentationIcon = options.icon;
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
    this.auxiliaryWindowBroker = new AuxiliaryWindowBroker(this);
    this.browserWindow.webContents.setWindowOpenHandler?.((details) =>
      this.auxiliaryWindowBroker.windowOpenHandler(details),
    );
    this.browserWindow.webContents.on("did-create-window", (window, details) =>
      this.auxiliaryWindowBroker.didCreateWindow(window, details),
    );
    if (this.offscreen) {
      this.browserWindow.webContents.setFrameRate(60);
      this.browserWindow.webContents.startPainting();
    }
    this.lumineApplication.registerLumineWindow?.(this);

    this.handleEvents();
    attachNativeWindowInput(this.browserWindow, (position) =>
      this.sendToRenderer("did-mouse-down-in-window", {
        windowId: this.id,
        ...(position && { position }),
      }),
    );
    this.embeddedKeyboardIpc = attachEmbeddedKeyboardIpc(this.browserWindow.webContents, {
      testing: !!this.isSpec,
      isWindowFocused: () => this.browserWindow.isFocused?.() === true,
    });
    this.browserWindow.on("blur", this.embeddedKeyboardIpc.clear);

    this.loadSettings = Object.assign({}, settings);
    this.loadSettings.embeddedPaneKeyboardBroker = true;
    this.loadSettings.windowStateId = this.windowStateId;
    this.loadSettings.appVersion = app.getVersion();
    this.loadSettings.appName = getAppName();
    this.loadSettings.resourcePath = this.resourcePath;
    this.loadSettings.lumineHome = process.env.LUMINE_HOME;
    if (this.loadSettings.devMode == null) this.loadSettings.devMode = false;
    if (this.loadSettings.safeMode == null) this.loadSettings.safeMode = false;
    if (this.loadSettings.clearWindowState == null) this.loadSettings.clearWindowState = false;

    this.addLocationsToOpen(locationsToOpen);

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
      if (this.closeCommitted) {
        if (this.unloadRequest) this.closeAfterPreparation(this.unloadRequest.promise);
        else if (this.unloadApproved) this.close();
        this.resolveLoadedPromise();
        return;
      }
      this.unloadRequest?.finish(this.unloadRequest.committed);
      this.unloadRequest?.dispose();
      this.unloadRequest = null;
      this.unloadApproved = false;
      this.closeCommitted = false;
      this.unloading = false;
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
    this.browserWindow.on("close", (event) => {
      if (this.isSpecWindow()) return;
      if (this.unloadApproved) {
        if (this.unloadRequest) this.unloadRequest.reason = "close";
        this.closeCommitted = true;
        if (this.unloadRequest?.committed) this.hideCommittedClose(this.unloadRequest);
        return;
      }
      event.preventDefault();
      const alreadyClosing = this.isClosing();
      this.unloading = true;
      if (!alreadyClosing)
        void Promise.resolve(this.lumineApplication.saveCurrentWindowOptions(false)).catch(
          (error) => console.error(error),
        );
      const preparation = this.prepareToUnload({ reason: "close" });
      this.closeAfterPreparation(preparation);
    });

    this.browserWindow.on("closed", () => {
      this.auxiliaryWindowBroker.destroy();
      this.embeddedKeyboardIpc?.dispose();
      void this.lumineApplication
        .releaseFileWatchSession(this)
        .catch((error) => console.error(error));
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
      await this.lumineApplication.releaseFileWatchSession(this);
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

    this.browserWindow.webContents.on(
      "did-start-navigation",
      (_event, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) {
          this.auxiliaryWindowBroker.destroy();
          this.auxiliaryWindowBroker = new AuxiliaryWindowBroker(this);
          void this.lumineApplication
            .releaseFileWatchSession(this)
            .catch((error) => console.error(error));
        }
      },
    );

    // Spec window's web view should always have focus
    if (this.isSpec) this.browserWindow.on("blur", () => this.browserWindow.focusOnWebView());
  }

  isClosing() {
    return (
      this.browserWindow.isDestroyed() ||
      this.closeCommitted === true ||
      this.unloadRequest?.reason === "close"
    );
  }

  /** @private Join an existing close without bypassing its pending package cleanup. */
  closeAfterPreparation(preparation) {
    if (this.closeRequestPromise === preparation) return;
    this.closeRequestPromise = preparation;
    void preparation
      .then((approved) => {
        if (approved && !this.browserWindow.isDestroyed()) this.close();
      })
      .catch((error) => console.error("Failed to close the window", error))
      .finally(() => {
        if (this.closeRequestPromise === preparation) this.closeRequestPromise = null;
      });
  }

  prepareToUnload({ reason }) {
    if (this.isSpecWindow()) return Promise.resolve(true);
    if (!["close", "reload", "replace"].includes(reason))
      return Promise.reject(new TypeError("Unknown window unload reason"));
    if (this.unloadRequest) {
      if (reason === "close") {
        this.unloadRequest.reason = "close";
        if (this.unloadRequest.committed) this.hideCommittedClose(this.unloadRequest);
      }
      return this.unloadRequest.promise;
    }

    const request = { id: crypto.randomUUID(), reason, committed: false, completed: false };
    this.unloadRequest = request;
    this.unloadApproved = false;
    let resolve;
    request.promise = new Promise((complete) => (resolve = complete));
    this.lastPrepareToUnloadPromise = request.promise;
    const clearTimers = () => {
      clearTimeout(request.closeTimer);
      clearTimeout(request.destroyTimer);
    };
    const callback = (event, result) => {
      if (
        event.sender === this.browserWindow.webContents &&
        result &&
        typeof result === "object" &&
        result.id === request.id
      )
        finish(request.committed || result.approved === true);
    };
    const closed = () => {
      request.dispose();
      finish(true);
    };
    request.dispose = () => {
      clearTimers();
      ipcMain.removeListener("did-prepare-to-unload", callback);
      this.browserWindow.removeListener("closed", closed);
    };
    const finish = (approved) => {
      if (request.completed) return;
      request.completed = true;
      ipcMain.removeListener("did-prepare-to-unload", callback);
      this.unloadApproved = approved;
      if (!approved) {
        request.dispose();
        this.unloadRequest = null;
        this.unloading = false;
        this.lumineApplication.quitting = false;
      }
      resolve(approved);
    };
    request.finish = finish;
    ipcMain.on("did-prepare-to-unload", callback);
    this.browserWindow.once("closed", closed);
    // A renderer that cannot be reached has no remaining state to save.
    if (!this.sendToRenderer("prepare-to-unload", { id: request.id, reason })) finish(true);
    return request.promise;
  }

  commitUnload(id) {
    const request = this.unloadRequest;
    if (!request || request.id !== id || request.completed)
      throw new Error("The window unload request is no longer active");
    request.committed = true;
    this.unloading = true;
    if (request.reason === "close") this.hideCommittedClose(request);
  }

  hideCommittedClose(request) {
    this.closeCommitted = true;
    if (request.closeTimer || this.browserWindow.isDestroyed()) return;
    // Saving and close confirmation have finished. Allow orderly teardown in
    // the hidden renderer, then fall back to its normal beforeunload cleanup.
    request.closeTimer = setTimeout(() => {
      if (this.browserWindow.isDestroyed()) return;
      console.warn("Window cleanup did not finish after committing its close");
      this.unloadApproved = true;
      request.destroyTimer = setTimeout(() => {
        if (!this.browserWindow.isDestroyed()) this.browserWindow.destroy();
      }, FORCE_CLOSE_TIMEOUT_MS);
      request.destroyTimer.unref?.();
      this.close();
    }, COMMITTED_CLOSE_TIMEOUT_MS);
    request.closeTimer.unref?.();
    for (const hide of [() => this.browserWindow.hide(), () => this.auxiliaryWindowBroker.hide()]) {
      try {
        hide();
      } catch (error) {
        console.error("Failed to hide a committed closing window", error);
      }
    }
  }

  openPath(pathToOpen, initialLine, initialColumn) {
    return this.openLocations([{ pathToOpen, initialLine, initialColumn }]);
  }

  /** @private Wait for a live renderer generation rather than its outgoing unload snapshot. */
  async awaitUsableGeneration() {
    const closed = this.closedPromise.then(() => false);
    for (;;) {
      if (this.isClosing()) return false;
      const request = this.unloadRequest;
      if (request) {
        const preparation = await Promise.race([
          request.promise.then((approved) => ({ approved })),
          closed,
        ]);
        if (!preparation || this.isClosing()) return false;
        if (preparation.approved && request.reason === "replace") return false;
        // The reload continuation installs its new loadedPromise after approval.
        // Yield once even if this waiter was registered before that continuation.
        if (preparation.approved && request.reason === "reload") {
          await Promise.resolve();
          if (!request.reloadStarted) return false;
        }
      }
      const generation = this.loadedPromise;
      if (!(await Promise.race([generation.then(() => true), closed])) || this.isClosing())
        return false;
      if (
        this.loadedPromise !== generation ||
        (this.unloadRequest && this.unloadRequest !== request)
      )
        continue;
      return true;
    }
  }

  async openLocations(locationsToOpen) {
    if (this.isClosing()) return false;
    // A second launch may supply bootstrap intent before the first renderer is
    // ready. An outgoing unload must settle before acquiring any new roots.
    const bootstrapIntent = !this.unloadRequest;
    if (bootstrapIntent) this.addLocationsToOpen(locationsToOpen);
    for (;;) {
      const request = this.unloadRequest;
      const generation = this.loadedPromise;
      if (!(await this.awaitUsableGeneration()) || this.isClosing()) return false;
      if (this.unloadRequest !== request || this.loadedPromise !== generation) continue;
      if (!bootstrapIntent) this.addLocationsToOpen(locationsToOpen);
      return this.sendToRenderer("message", "open-locations", locationsToOpen);
    }
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
    // Another launch can claim this window before its renderer bootstraps.
    // Keep that bootstrap's project and file intent in sync with queued opens.
    this.loadSettings.initialProjectRoots = this.projectRoots;
    this.loadSettings.hasOpenFiles ||= locationsToOpen.some(
      (location) => location.pathToOpen && !location.isDirectory,
    );
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
    const auxiliary = this.auxiliaryWindowBroker.getFocusedRecord();
    if (auxiliary) {
      this.sendToRenderer("auxiliary-window-command", { id: auxiliary.id, command, args });
      return;
    }
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

  async sendURIMessage(uri) {
    for (;;) {
      const request = this.unloadRequest;
      const generation = this.loadedPromise;
      if (!(await this.awaitUsableGeneration()) || this.isClosing()) return false;
      if (this.unloadRequest !== request || this.loadedPromise !== generation) continue;
      return this.sendToRenderer("uri-message", uri);
    }
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
    // Native focus can reveal Electron's offscreen placeholder. Page focus is
    // handled separately by the caller and remains available to specs.
    if (this.offscreen || this.isClosing()) return;
    return this.browserWindow.focus();
  }

  minimize() {
    if (this.offscreen) return;
    return this.browserWindow.minimize();
  }

  maximize() {
    if (this.offscreen || this.isClosing()) return;
    return this.browserWindow.maximize();
  }

  unmaximize() {
    if (this.offscreen) return;
    return this.browserWindow.unmaximize();
  }

  restore() {
    if (this.offscreen || this.isClosing()) return;
    return this.browserWindow.restore();
  }

  setFullScreen(fullScreen) {
    if (this.offscreen) return;
    return this.browserWindow.setFullScreen(fullScreen);
  }

  handlesLumineCommands() {
    return !this.isSpecWindow() && this.isWebViewFocused();
  }

  isFocused() {
    return this.browserWindow.isFocused() || !!this.auxiliaryWindowBroker.getFocusedRecord();
  }

  getFocusedNativeWindow() {
    return this.auxiliaryWindowBroker.getFocusedRecord()?.window ?? this.browserWindow;
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
    const preparation = skipPrepareToUnload ? null : this.prepareToUnload({ reason: "reload" });
    const request = this.unloadRequest;
    const canUnload = skipPrepareToUnload || (await preparation);
    if (!canUnload || this.browserWindow.isDestroyed() || this.isClosing())
      return Promise.race([this.loadedPromise, this.closedPromise]);

    if (request?.reloadStarted) return Promise.race([this.loadedPromise, this.closedPromise]);
    if (request) request.reloadStarted = true;
    this.unloadApproved = true;

    this.loadedPromise = new Promise((resolve) => {
      this.resolveLoadedPromise = resolve;
    });
    // Mark every reload, including main-process requests, before beforeunload
    // can mistake it for a close and hide the focused window from the taskbar.
    this.sendToRenderer("will-reload-window");
    this.browserWindow.reload();
    return Promise.race([this.loadedPromise, this.closedPromise]);
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
    this.lumineApplication.projectStateCoordinator?.commit(this, this.projectRoots);
    if (!this.isSpec) this.lumineApplication.requestSessionStateCleanup?.();
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
