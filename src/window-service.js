const getWindowLoadSettings = require("./get-window-load-settings");
const StartupTime = require("./startup-time");

// Public: Operations on the Lumine window hosting the current renderer.
//
// BrowserWindow objects never cross the process boundary. State is returned as
// plain objects and every operation which reaches the main process is async.
class WindowService {
  constructor(applicationDelegate, atomEnvironment) {
    this.applicationDelegate = applicationDelegate;
    this.atomEnvironment = atomEnvironment;
  }

  // Public: Return the stable numeric id of the current Lumine window.
  getId() {
    return getWindowLoadSettings().windowId;
  }

  // Extended: Subscribe before the current editor window is destroyed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onWillDestroy(callback) {
    return this.atomEnvironment.emitter.on("will-destroy", callback);
  }

  // Extended: Wait until the current editor window has finished loading.
  //
  // Returns a {Promise} resolving to the load time in milliseconds.
  whenLoaded() {
    if (this.atomEnvironment.loadTime != null) {
      return Promise.resolve(this.atomEnvironment.loadTime);
    }
    return new Promise((resolve) => this.atomEnvironment.emitter.once("window-loaded", resolve));
  }

  // Public: Determine whether the current window is in development mode.
  isDevMode() {
    return Boolean(getWindowLoadSettings().devMode);
  }

  // Public: Determine whether the current window is in safe mode.
  isSafeMode() {
    return Boolean(getWindowLoadSettings().safeMode);
  }

  // Public: Determine whether the current window is running specs.
  isSpecMode() {
    return Boolean(getWindowLoadSettings().isSpec);
  }

  // Extended: Determine whether the current window is running headlessly.
  isHeadless() {
    return Boolean(getWindowLoadSettings().headless);
  }

  // Extended: Return the paths supplied when the current window was opened.
  getInitialPaths() {
    return [...(getWindowLoadSettings().initialPaths || [])];
  }

  // Public: Return the completed load time for the current window.
  //
  // Returns a {Number} in milliseconds, or `null` before loading completes.
  getLoadTime() {
    return this.atomEnvironment.loadTime;
  }

  // Public: Return startup timing markers for the current window.
  getStartupMarkers() {
    return StartupTime.exportData()?.markers || [];
  }

  // Public: Return a snapshot of the current window state.
  //
  // Returns a {Promise} resolving to a serializable {Object} with `id`,
  // `position`, `size`, `maximized`, `fullScreen`, and `visible` fields.
  getState() {
    return this.applicationDelegate.invokeWindow("getState");
  }

  // Public: Return the current content size.
  //
  // Returns a {Promise} resolving to `{width, height}`.
  getSize() {
    return this.applicationDelegate.invokeWindow("getSize");
  }

  // Public: Set the content size.
  //
  // * `width` A finite {Number} in pixels.
  // * `height` A finite {Number} in pixels.
  //
  // Returns a {Promise} that resolves when the request is applied.
  setSize(width, height) {
    return this.applicationDelegate.invokeWindow("setSize", width, height);
  }

  // Public: Return the current screen position.
  //
  // Returns a {Promise} resolving to `{x, y}`.
  getPosition() {
    return this.applicationDelegate.invokeWindow("getPosition");
  }

  // Public: Set the current screen position.
  //
  // * `x` A finite {Number} in pixels.
  // * `y` A finite {Number} in pixels.
  //
  // Returns a {Promise} that resolves when the request is applied.
  setPosition(x, y) {
    return this.applicationDelegate.invokeWindow("setPosition", x, y);
  }

  // Public: Center the current window on its display.
  //
  // Returns a {Promise} that resolves when the request is applied.
  center() {
    return this.applicationDelegate.invokeWindow("center");
  }

  // Public: Focus the current window.
  //
  // Returns a {Promise} that resolves when the request is applied.
  focus() {
    return this.applicationDelegate.invokeWindow("focus");
  }

  // Public: Show the current window and restore its focus policy.
  //
  // Returns a {Promise} that resolves when the request is applied.
  show() {
    return this.applicationDelegate.invokeWindow("show");
  }

  // Public: Hide the current window.
  //
  // Returns a {Promise} that resolves when the request is applied.
  hide() {
    return this.applicationDelegate.invokeWindow("hide");
  }

  // Public: Close the current window.
  //
  // Returns a {Promise} that resolves when the close request is accepted.
  close() {
    return this.applicationDelegate.invokeWindow("close");
  }

  // Public: Reload the current window.
  //
  // Returns a {Promise} that resolves after the reloaded renderer reports ready.
  reload() {
    return this.applicationDelegate.invokeWindow("reload");
  }

  // Public: Minimize the current window.
  //
  // Returns a {Promise} that resolves when the request is applied.
  minimize() {
    return this.applicationDelegate.invokeWindow("minimize");
  }

  // Public: Maximize the current window.
  //
  // Returns a {Promise} that resolves when the request is applied.
  maximize() {
    return this.applicationDelegate.invokeWindow("maximize");
  }

  // Public: Restore a maximized window.
  //
  // Returns a {Promise} that resolves when the request is applied.
  unmaximize() {
    return this.applicationDelegate.invokeWindow("unmaximize");
  }

  // Public: Determine whether the current window is maximized.
  //
  // Returns a {Promise} resolving to a {Boolean}.
  isMaximized() {
    return this.applicationDelegate.invokeWindow("isMaximized");
  }

  // Public: Determine whether the current window is full screen.
  //
  // Returns a {Promise} resolving to a {Boolean}.
  isFullScreen() {
    return this.applicationDelegate.invokeWindow("isFullScreen");
  }

  // Public: Determine whether the current window is visible.
  //
  // Returns a {Promise} resolving to a {Boolean}.
  isVisible() {
    return this.applicationDelegate.invokeWindow("isVisible");
  }

  // Public: Enter or leave full-screen mode.
  //
  // * `fullScreen` A {Boolean} indicating the desired state.
  //
  // Returns a {Promise} that resolves when the request is applied.
  setFullScreen(fullScreen = false) {
    return this.applicationDelegate.invokeWindow("setFullScreen", fullScreen);
  }

  // Public: Toggle full-screen mode.
  //
  // Returns a {Promise} that resolves when the request is applied.
  async toggleFullScreen() {
    return this.setFullScreen(!(await this.isFullScreen()));
  }

  // Public: Ask the user to select one or more folders.
  //
  // Returns a {Promise} resolving to an {Array} of paths, or `null` on cancellation.
  pickFolder() {
    return this.applicationDelegate.invokeWindow("pickFolder");
  }

  // Public: Show a save dialog owned by the current window.
  //
  // * `options` Serializable Electron save-dialog options.
  //
  // Returns a {Promise} resolving to Electron's serializable save-dialog result.
  showSaveDialog(options = {}) {
    return this.applicationDelegate.invokeWindow("showSaveDialog", options);
  }

  // Essential: Show a non-blocking confirmation dialog owned by the current
  // window.
  //
  // Returns a {Promise} resolving to the selected button index.
  confirm(options) {
    return this.applicationDelegate.confirm(options);
  }

  // Public: Start a download in the current window.
  //
  // * `url` The {String} URL to download.
  //
  // Returns a {Promise} that resolves when the download is started.
  downloadURL(url) {
    return this.applicationDelegate.invokeWindow("downloadURL", url);
  }

  // Public: Return the primary display's available work-area size.
  //
  // Returns a {Promise} resolving to `{width, height}`.
  getPrimaryDisplayWorkAreaSize() {
    return this.applicationDelegate.invokeWindow("getPrimaryDisplayWorkAreaSize");
  }

  // Public: Control whether the menu bar hides automatically.
  //
  // Returns a {Promise} that resolves when the request is applied.
  setAutoHideMenuBar(autoHide) {
    return this.applicationDelegate.invokeWindow("setAutoHideMenuBar", autoHide);
  }

  // Public: Show or hide the menu bar.
  //
  // Returns a {Promise} that resolves when the request is applied.
  setMenuBarVisibility(visible) {
    return this.applicationDelegate.invokeWindow("setMenuBarVisibility", visible);
  }

  // Public: Open the current window's developer tools.
  //
  // Returns a {Promise} that resolves when the request is applied.
  async openDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("openDevTools");
  }

  // Public: Close the current window's developer tools.
  //
  // Returns a {Promise} that resolves when the request is applied.
  async closeDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("closeDevTools");
  }

  // Public: Toggle the current window's developer tools.
  //
  // Returns a {Promise} that resolves when the request is applied.
  async toggleDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("toggleDevTools");
  }

  // Public: Evaluate JavaScript in the current window's developer tools.
  //
  // Returns a {Promise} that resolves after evaluation, or immediately when
  // developer tools are closed.
  executeJavaScriptInDevTools(code) {
    return this.applicationDelegate.invokeWindow("executeJavaScriptInDevTools", code);
  }

  // Public: Send a serializable event to every other registered Lumine window.
  //
  // * `eventName` A non-empty {String} event name.
  // * `args` Structured-cloneable values delivered to subscribers.
  //
  // Returns a {Promise} that resolves after the event is sent.
  broadcast(eventName, ...args) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      return Promise.reject(new TypeError("Window event name must be a non-empty string"));
    }
    return this.applicationDelegate.broadcastToOtherWindows(eventName, ...args);
  }

  // Public: Subscribe to named events broadcast by other Lumine windows.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidReceive(eventName, callback) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      throw new TypeError("Window event name must be a non-empty string");
    }
    return this.applicationDelegate.onDidReceiveWindowEvent(eventName, callback);
  }

  // Public: Invoke `callback` after entering full-screen mode.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidEnterFullScreen(callback) {
    return this.applicationDelegate.onDidEnterFullScreen(callback);
  }

  // Public: Invoke `callback` after leaving full-screen mode.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidLeaveFullScreen(callback) {
    return this.applicationDelegate.onDidLeaveFullScreen(callback);
  }

  // Public: Invoke `callback` after the window is maximized.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidMaximize(callback) {
    return this.applicationDelegate.onDidMaximizeWindow(callback);
  }

  // Public: Invoke `callback` after a maximized window is restored.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidUnmaximize(callback) {
    return this.applicationDelegate.onDidUnmaximizeWindow(callback);
  }

  // Public: Invoke `callback` when the window gains focus.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidFocus(callback) {
    return this.applicationDelegate.onDidFocusWindow(callback);
  }

  // Public: Invoke `callback` when the window loses focus.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidBlur(callback) {
    return this.applicationDelegate.onDidBlurWindow(callback);
  }
}

module.exports = WindowService;
