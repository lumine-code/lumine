const { ipcRenderer } = require("electron");
const ipcHelpers = require("./ipc-helpers");
const { Emitter, Disposable } = require("@lumine-code/event-kit");
const getWindowLoadSettings = require("./get-window-load-settings");

const WINDOW_EVENT_CHANNEL = "window-event";

module.exports = class ApplicationDelegate {
  constructor() {
    this.pendingSettingsUpdateCount = 0;
    this._ipcMessageEmitter = null;
  }

  ipcMessageEmitter() {
    if (!this._ipcMessageEmitter) {
      this._ipcMessageEmitter = new Emitter();
      ipcRenderer.on("message", (event, message, detail) => {
        this._ipcMessageEmitter.emit(message, detail);
      });
    }
    return this._ipcMessageEmitter;
  }

  getWindowLoadSettings() {
    return getWindowLoadSettings();
  }

  open(params) {
    return ipcRenderer.send("open", params);
  }

  async getTemporaryWindowState() {
    const stateJSON = await this.invokeWindow("getTemporaryState");
    return stateJSON && JSON.parse(stateJSON);
  }

  setTemporaryWindowState(state) {
    return this.invokeWindow("setTemporaryState", JSON.stringify(state));
  }

  onDidEnterFullScreen(callback) {
    return ipcHelpers.on(ipcRenderer, "did-enter-full-screen", callback);
  }

  onDidLeaveFullScreen(callback) {
    return ipcHelpers.on(ipcRenderer, "did-leave-full-screen", callback);
  }

  onDidMaximizeWindow(callback) {
    return ipcHelpers.on(ipcRenderer, "did-maximize-window", callback);
  }

  onDidUnmaximizeWindow(callback) {
    return ipcHelpers.on(ipcRenderer, "did-unmaximize-window", callback);
  }

  onDidFocusWindow(callback) {
    return ipcHelpers.on(ipcRenderer, "did-focus-window", callback);
  }

  onDidBlurWindow(callback) {
    return ipcHelpers.on(ipcRenderer, "did-blur-window", callback);
  }

  didClosePathWithWaitSession(path) {
    return this.invokeWindow("didClosePathWithWaitSession", path);
  }

  setWindowDocumentEdited(edited) {
    return this.invokeWindow("setDocumentEdited", edited);
  }

  setRepresentedFilename(filename) {
    return this.invokeWindow("setRepresentedFilename", filename);
  }

  addRecentDocument(filename) {
    return ipcRenderer.send("add-recent-document", filename);
  }

  setProjectRoots(paths) {
    return this.invokeWindow("setProjectRoots", paths);
  }

  performWebContentsAction(action) {
    return this.invokeWindow(action);
  }

  async setUserSettings(config, configFilePath) {
    this.pendingSettingsUpdateCount++;
    try {
      await ipcHelpers.call("set-user-settings", JSON.stringify(config), configFilePath);
    } finally {
      this.pendingSettingsUpdateCount--;
    }
  }

  onDidChangeUserSettings(callback) {
    return this.ipcMessageEmitter().on("did-change-user-settings", (detail) => {
      if (this.pendingSettingsUpdateCount === 0) callback(detail);
    });
  }

  onDidFailToReadUserSettings(callback) {
    return this.ipcMessageEmitter().on("did-fail-to-read-user-setting", callback);
  }

  confirm(options) {
    return this.invokeWindow("confirm", options);
  }

  showMessageDialog(_params) {}

  showSaveDialog(options = {}) {
    return this.invokeWindow("showSaveDialog", options);
  }

  onDidOpenLocations(callback) {
    return this.ipcMessageEmitter().on("open-locations", callback);
  }

  onApplicationMenuCommand(handler) {
    const outerCallback = (event, ...args) => handler(...args);

    ipcRenderer.on("command", outerCallback);
    return new Disposable(() => ipcRenderer.removeListener("command", outerCallback));
  }

  onContextMenuCommand(handler) {
    const outerCallback = (event, ...args) => handler(...args);

    ipcRenderer.on("context-command", outerCallback);
    return new Disposable(() => ipcRenderer.removeListener("context-command", outerCallback));
  }

  onURIMessage(handler) {
    const outerCallback = (event, ...args) => handler(...args);

    ipcRenderer.on("uri-message", outerCallback);
    return new Disposable(() => ipcRenderer.removeListener("uri-message", outerCallback));
  }

  onDidRequestUnload(callback) {
    // The main process waits on this reply with no timeout, so a handler that
    // throws would leave it waiting forever: no reload, no close, and no second
    // chance to ask. Always answer. Refusing is the safe answer to a failure
    // here, since the alternative discards whatever the handler did not get to
    // save; the window stays usable and the error says why it would not reload.
    const outerCallback = async (_event) => {
      let shouldUnload;
      try {
        shouldUnload = await callback();
      } catch (error) {
        console.error("Failed to prepare the window to unload", error);
        shouldUnload = false;
      }
      ipcRenderer.send("did-prepare-to-unload", shouldUnload);
    };

    ipcRenderer.on("prepare-to-unload", outerCallback);
    return new Disposable(() => ipcRenderer.removeListener("prepare-to-unload", outerCallback));
  }

  onDidChangeHistoryManager(callback) {
    const outerCallback = (event, _message) => callback(event);

    ipcRenderer.on("did-change-history-manager", outerCallback);
    return new Disposable(() =>
      ipcRenderer.removeListener("did-change-history-manager", outerCallback),
    );
  }

  didChangeHistoryManager() {
    return ipcRenderer.send("did-change-history-manager");
  }

  broadcastToOtherWindows(eventName, ...args) {
    if (typeof eventName !== "string") {
      throw new TypeError("Window event name must be a string");
    }
    return ipcRenderer.invoke("lumine:window-broadcast", eventName, ...args);
  }

  onDidReceiveWindowEvent(eventName, callback) {
    const outerCallback = (_event, receivedEventName, ...args) => {
      if (receivedEventName === eventName) callback(...args);
    };

    ipcRenderer.on(WINDOW_EVENT_CHANNEL, outerCallback);
    return new Disposable(() => ipcRenderer.removeListener(WINDOW_EVENT_CHANNEL, outerCallback));
  }

  openExternal(url) {
    return this.openExternalDirect(url);
  }

  emitWillSavePath(path) {
    return ipcHelpers.call("will-save-path", path);
  }

  emitDidSavePath(path) {
    return ipcHelpers.call("did-save-path", path);
  }

  resolveProxy(requestId, url) {
    return ipcRenderer.send("resolve-proxy", requestId, url);
  }

  onDidResolveProxy(callback) {
    const outerCallback = (event, requestId, proxy) => callback(requestId, proxy);

    ipcRenderer.on("did-resolve-proxy", outerCallback);
    return new Disposable(() => ipcRenderer.removeListener("did-resolve-proxy", outerCallback));
  }

  openExternalDirect(url) {
    return this.invokeShellMethod("openExternal", url);
  }

  openPath(filePath) {
    return this.invokeShellMethod("openPath", filePath);
  }

  trashItem(filePath) {
    return this.invokeShellMethod("trashItem", filePath);
  }

  showItemInFolder(filePath) {
    return this.invokeShellMethod("showItemInFolder", filePath);
  }

  invokeShellMethod(channel, ...args) {
    return this.invokeApp(channel, ...args).then(({ outcome, error, result }) => {
      if (outcome === "success") {
        return result;
      } else if (outcome === "failure") {
        return Promise.reject(error);
      }
    });
  }

  invokeWindow(action, ...args) {
    return ipcRenderer.invoke("lumine:window", action, ...args);
  }

  invokeApp(action, ...args) {
    return ipcRenderer.invoke("lumine:app", action, ...args);
  }

  invokeSafeStorage(action, ...args) {
    return ipcRenderer.invoke("lumine:safe-storage", action, ...args);
  }

  showContextMenu(template) {
    return ipcRenderer.invoke("lumine:context-menu", template);
  }
};
