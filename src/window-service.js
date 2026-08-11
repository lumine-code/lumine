const getWindowLoadSettings = require("./get-window-load-settings");
const StartupTime = require("./startup-time");

/**
 * Operations on the Lumine window hosting the current renderer.
 *
 * BrowserWindow objects never cross the process boundary. State is returned as
 * plain objects and every operation which reaches the main process is async.
 *
 * @public
 * @api-status Public
 */
class WindowService {
  constructor(applicationDelegate, lumineEnvironment) {
    this.applicationDelegate = applicationDelegate;
    this.lumineEnvironment = lumineEnvironment;
  }

  /**
   * @returns {Number} stable numeric id of the current Lumine window.
   * @public
   * @api-status Public
   */
  getId() {
    return getWindowLoadSettings().windowId;
  }

  /**
   * Subscribe before the current editor window is destroyed.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onWillDestroy(callback) {
    return this.lumineEnvironment.emitter.on("will-destroy", callback);
  }

  /**
   * Wait until the current editor window has finished loading.
   *
   * @returns {Promise} resolving to the load time in milliseconds.
   * @public
   * @api-status Extended
   */
  whenLoaded() {
    if (this.lumineEnvironment.loadTime != null) {
      return Promise.resolve(this.lumineEnvironment.loadTime);
    }
    return new Promise((resolve) => this.lumineEnvironment.emitter.once("window-loaded", resolve));
  }

  /**
   * Determine whether the current window is in development mode.
   *
   * @public
   * @api-status Public
   */
  isDevMode() {
    return Boolean(getWindowLoadSettings().devMode);
  }

  /**
   * Determine whether the current window is in safe mode.
   *
   * @public
   * @api-status Public
   */
  isSafeMode() {
    return Boolean(getWindowLoadSettings().safeMode);
  }

  /**
   * Determine whether the current window is running specs.
   *
   * @public
   * @api-status Public
   */
  isSpecMode() {
    return Boolean(getWindowLoadSettings().isSpec);
  }

  /**
   * Determine whether the current window is running headlessly.
   *
   * @public
   * @api-status Extended
   */
  isHeadless() {
    return Boolean(getWindowLoadSettings().headless);
  }

  /**
   * @returns {Array<String>} paths supplied when the current window was opened.
   * @public
   * @api-status Extended
   */
  getInitialPaths() {
    return [...(getWindowLoadSettings().initialPaths || [])];
  }

  /**
   * @returns {Number|null} The completed window load time in milliseconds, or `null` before loading completes.
   * @public
   * @api-status Public
   */
  getLoadTime() {
    return this.lumineEnvironment.loadTime;
  }

  /**
   * @returns {Object} startup timing markers for the current window.
   * @public
   * @api-status Public
   */
  getStartupMarkers() {
    return StartupTime.exportData()?.markers || [];
  }

  /**
   * @returns {Promise<Object>} A serializable state snapshot with `id`, `position`, `size`, `maximized`, `fullScreen`, and `visible` fields.
   * @public
   * @api-status Public
   */
  getState() {
    return this.applicationDelegate.invokeWindow("getState");
  }

  /**
   * @returns {Promise<Object>} The current content size as `{width, height}`.
   * @public
   * @api-status Public
   */
  getSize() {
    return this.applicationDelegate.invokeWindow("getSize");
  }

  /**
   * Set the content size.
   *
   * @param width - A finite `Number` in pixels.
   * @param height - A finite `Number` in pixels.
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  setSize(width, height) {
    return this.applicationDelegate.invokeWindow("setSize", width, height);
  }

  /**
   * @returns {Promise<Object>} The current screen position as `{x, y}`.
   * @public
   * @api-status Public
   */
  getPosition() {
    return this.applicationDelegate.invokeWindow("getPosition");
  }

  /**
   * Set the current screen position.
   *
   * @param x - A finite `Number` in pixels.
   * @param y - A finite `Number` in pixels.
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  setPosition(x, y) {
    return this.applicationDelegate.invokeWindow("setPosition", x, y);
  }

  /**
   * Center the current window on its display.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  center() {
    return this.applicationDelegate.invokeWindow("center");
  }

  /**
   * Focus the current window.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  focus() {
    return this.applicationDelegate.invokeWindow("focus");
  }

  /**
   * Show the current window and restore its focus policy.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  show() {
    return this.applicationDelegate.invokeWindow("show");
  }

  /**
   * Hide the current window.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  hide() {
    return this.applicationDelegate.invokeWindow("hide");
  }

  /**
   * Close the current window.
   *
   * @returns {Promise} that resolves when the close request is accepted.
   * @public
   * @api-status Public
   */
  close() {
    return this.applicationDelegate.invokeWindow("close");
  }

  /**
   * Reload the current window.
   *
   * @returns {Promise} that resolves after the reloaded renderer reports ready.
   * @public
   * @api-status Public
   */
  reload() {
    return this.applicationDelegate.invokeWindow("reload");
  }

  /**
   * Minimize the current window.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  minimize() {
    return this.applicationDelegate.invokeWindow("minimize");
  }

  /**
   * Maximize the current window.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  maximize() {
    return this.applicationDelegate.invokeWindow("maximize");
  }

  /**
   * Restore a maximized window.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  unmaximize() {
    return this.applicationDelegate.invokeWindow("unmaximize");
  }

  /**
   * Determine whether the current window is maximized.
   *
   * @returns {Promise} resolving to a `Boolean`.
   * @public
   * @api-status Public
   */
  isMaximized() {
    return this.applicationDelegate.invokeWindow("isMaximized");
  }

  /**
   * Determine whether the current window is full screen.
   *
   * @returns {Promise} resolving to a `Boolean`.
   * @public
   * @api-status Public
   */
  isFullScreen() {
    return this.applicationDelegate.invokeWindow("isFullScreen");
  }

  /**
   * Determine whether the current window is visible.
   *
   * @returns {Promise} resolving to a `Boolean`.
   * @public
   * @api-status Public
   */
  isVisible() {
    return this.applicationDelegate.invokeWindow("isVisible");
  }

  /**
   * Enter or leave full-screen mode.
   *
   * @param fullScreen - A `Boolean` indicating the desired state.
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  setFullScreen(fullScreen = false) {
    return this.applicationDelegate.invokeWindow("setFullScreen", fullScreen);
  }

  /**
   * Toggle full-screen mode.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  async toggleFullScreen() {
    return this.setFullScreen(!(await this.isFullScreen()));
  }

  /**
   * Ask the user to select one or more folders.
   *
   * @returns {Promise} resolving to an `Array` of paths, or `null` on cancellation.
   * @public
   * @api-status Public
   */
  pickFolder() {
    return this.applicationDelegate.invokeWindow("pickFolder");
  }

  /**
   * Show a save dialog owned by the current window.
   *
   * @param options - Serializable Electron save-dialog options.
   * @returns {Promise} resolving to Electron's serializable save-dialog result.
   * @public
   * @api-status Public
   */
  showSaveDialog(options = {}) {
    return this.applicationDelegate.invokeWindow("showSaveDialog", options);
  }

  /**
   * Show a non-blocking confirmation dialog owned by the current
   * window.
   *
   * @returns {Promise} resolving to the selected button index.
   * @public
   * @api-status Essential
   */
  confirm(options) {
    return this.applicationDelegate.confirm(options);
  }

  /**
   * Start a download in the current window.
   *
   * @param url - The `String` URL to download.
   * @returns {Promise} that resolves when the download is started.
   * @public
   * @api-status Public
   */
  downloadURL(url) {
    return this.applicationDelegate.invokeWindow("downloadURL", url);
  }

  /**
   * @returns {Promise<Object>} The primary display's available work-area size as `{width, height}`.
   * @public
   * @api-status Public
   */
  getPrimaryDisplayWorkAreaSize() {
    return this.applicationDelegate.invokeWindow("getPrimaryDisplayWorkAreaSize");
  }

  /**
   * Control whether the menu bar hides automatically.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  setAutoHideMenuBar(autoHide) {
    return this.applicationDelegate.invokeWindow("setAutoHideMenuBar", autoHide);
  }

  /**
   * Show or hide the menu bar.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  setMenuBarVisibility(visible) {
    return this.applicationDelegate.invokeWindow("setMenuBarVisibility", visible);
  }

  /**
   * Open the current window's developer tools.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  async openDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("openDevTools");
  }

  /**
   * Close the current window's developer tools.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  async closeDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("closeDevTools");
  }

  /**
   * Toggle the current window's developer tools.
   *
   * @returns {Promise} that resolves when the request is applied.
   * @public
   * @api-status Public
   */
  async toggleDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("toggleDevTools");
  }

  /**
   * Evaluate JavaScript in the current window's developer tools.
   *
   * @returns {Promise} that resolves after evaluation, or immediately when developer tools are closed.
   * @public
   * @api-status Public
   */
  executeJavaScriptInDevTools(code) {
    return this.applicationDelegate.invokeWindow("executeJavaScriptInDevTools", code);
  }

  /**
   * Send a serializable event to every other registered Lumine window.
   *
   * @param eventName - A non-empty `String` event name.
   * @param args - Structured-cloneable values delivered to subscribers.
   * @returns {Promise} that resolves after the event is sent.
   * @public
   * @api-status Public
   */
  broadcast(eventName, ...args) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      return Promise.reject(new TypeError("Window event name must be a non-empty string"));
    }
    return this.applicationDelegate.broadcastToOtherWindows(eventName, ...args);
  }

  /**
   * Subscribe to named events broadcast by other Lumine windows.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidReceive(eventName, callback) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      throw new TypeError("Window event name must be a non-empty string");
    }
    return this.applicationDelegate.onDidReceiveWindowEvent(eventName, callback);
  }

  /**
   * Invoke `callback` after entering full-screen mode.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidEnterFullScreen(callback) {
    return this.applicationDelegate.onDidEnterFullScreen(callback);
  }

  /**
   * Invoke `callback` after leaving full-screen mode.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidLeaveFullScreen(callback) {
    return this.applicationDelegate.onDidLeaveFullScreen(callback);
  }

  /**
   * Invoke `callback` after the window is maximized.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidMaximize(callback) {
    return this.applicationDelegate.onDidMaximizeWindow(callback);
  }

  /**
   * Invoke `callback` after a maximized window is restored.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidUnmaximize(callback) {
    return this.applicationDelegate.onDidUnmaximizeWindow(callback);
  }

  /**
   * Invoke `callback` when the window gains focus.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidFocus(callback) {
    return this.applicationDelegate.onDidFocusWindow(callback);
  }

  /**
   * Invoke `callback` when the window loses focus.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidBlur(callback) {
    return this.applicationDelegate.onDidBlurWindow(callback);
  }
}

module.exports = WindowService;
