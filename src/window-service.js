const getWindowLoadSettings = require("./get-window-load-settings");
const StartupTime = require("./startup-time");

/**
 * @public
 * @status public
 *
 * Operations on the Lumine window hosting the current renderer.
 *
 * BrowserWindow objects never cross the process boundary. State is returned as
 * plain objects and every operation which reaches the main process is async.
 */
class WindowService {
  constructor(applicationDelegate, lumineEnvironment) {
    this.applicationDelegate = applicationDelegate;
    this.lumineEnvironment = lumineEnvironment;
  }

  /** @category Window Information */

  /**
   * @public
   * @status public
   *
   * Get the native identity of the current window.
   *
   * @returns {Number} stable numeric id of the current Lumine window.
   */
  getId() {
    return getWindowLoadSettings().windowId;
  }

  /**
   * @public
   * @status extended
   *
   * Subscribe before the current editor window is destroyed.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {Function} callback - Called before this window is destroyed.
   * @category Event Subscription
   */
  onWillDestroy(callback) {
    return this.lumineEnvironment.emitter.on("will-destroy", callback);
  }

  /** @category Startup */

  /**
   * @public
   * @status extended
   *
   * Wait until the current editor window has finished loading.
   *
   * @returns {Promise<Number>} resolving to the load time in milliseconds.
   */
  whenLoaded() {
    if (this.lumineEnvironment.loadTime != null) {
      return Promise.resolve(this.lumineEnvironment.loadTime);
    }
    return new Promise((resolve) => this.lumineEnvironment.emitter.once("window-loaded", resolve));
  }

  /**
   * @public
   * @status extended
   *
   * Set the filename represented by the native window.
   * @param {String} filename - The current path, or an empty string.
   * @returns {Promise<void>} Completes after the native property is set.
   * @category Native Presentation
   */
  setRepresentedFilename(filename) {
    return this.applicationDelegate.setRepresentedFilename(filename);
  }

  /** @category Window Modes */

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is in development mode.
   * @returns {Boolean}
   */
  isDevMode() {
    return Boolean(getWindowLoadSettings().devMode);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is in safe mode.
   * @returns {Boolean}
   */
  isSafeMode() {
    return Boolean(getWindowLoadSettings().safeMode);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is running specs.
   * @returns {Boolean}
   */
  isSpecMode() {
    return Boolean(getWindowLoadSettings().isSpec);
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the current window is running headlessly.
   * @returns {Boolean}
   */
  isHeadless() {
    return Boolean(getWindowLoadSettings().headless);
  }

  /** @category Startup */

  /**
   * @public
   * @status extended
   *
   * Get the paths supplied when the current window was opened.
   *
   * @returns {Array<String>} paths supplied when the current window was opened.
   */
  getInitialPaths() {
    return [...(getWindowLoadSettings().initialPaths || [])];
  }

  /**
   * @public
   * @status public
   *
   * Get the time taken to load the current window.
   *
   * @returns {Number|null} The completed window load time in milliseconds, or `null` before loading completes.
   */
  getLoadTime() {
    return this.lumineEnvironment.loadTime;
  }

  /**
   * @public
   * @status public
   *
   * Get startup timing markers for the current window.
   *
   * @returns {Array<Object>} Startup markers with label and elapsed time in milliseconds.
   */
  getStartupMarkers() {
    return StartupTime.exportData()?.markers || [];
  }

  /** @category Window State */

  /**
   * @public
   * @status public
   *
   * Get a snapshot of the current window's native state.
   *
   * @returns {Promise<Object>} A serializable state snapshot with `id`, `position`, `size`, `maximized`, `fullScreen`, and `visible` fields.
   */
  getState() {
    return this.applicationDelegate.invokeWindow("getState");
  }

  /** @category Window Geometry */

  /**
   * @public
   * @status public
   *
   * Get the current native window size.
   *
   * @returns {Promise<Object>} The current native window size as `{width, height}`.
   */
  getSize() {
    return this.applicationDelegate.invokeWindow("getSize");
  }

  /**
   * @public
   * @status public
   *
   * Set the native window size.
   *
   * @param {Number} width - A positive integer size in pixels.
   * @param {Number} height - A positive integer size in pixels.
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  setSize(width, height) {
    return this.applicationDelegate.invokeWindow("setSize", width, height);
  }

  /**
   * @public
   * @status public
   *
   * Get the current screen position.
   *
   * @returns {Promise<Object>} The current screen position as `{x, y}`.
   */
  getPosition() {
    return this.applicationDelegate.invokeWindow("getPosition");
  }

  /**
   * @public
   * @status public
   *
   * Set the current screen position.
   *
   * @param {Number} x - An integer screen coordinate in pixels.
   * @param {Number} y - An integer screen coordinate in pixels.
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  setPosition(x, y) {
    return this.applicationDelegate.invokeWindow("setPosition", x, y);
  }

  /**
   * @public
   * @status public
   *
   * Center the current window on its display.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  center() {
    return this.applicationDelegate.invokeWindow("center");
  }

  /** @category Window Management */

  /**
   * @public
   * @status public
   *
   * Focus the current window.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  focus() {
    return this.applicationDelegate.invokeWindow("focus");
  }

  /**
   * @public
   * @status public
   *
   * Show the current window and restore its focus policy.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  show() {
    return this.applicationDelegate.invokeWindow("show");
  }

  /**
   * @public
   * @status public
   *
   * Hide the current window.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  hide() {
    return this.applicationDelegate.invokeWindow("hide");
  }

  /**
   * @public
   * @status public
   *
   * Close the current window.
   *
   * @returns {Promise<void>} that resolves when the close request is accepted.
   */
  close() {
    return this.applicationDelegate.invokeWindow("close");
  }

  /**
   * @public
   * @status public
   *
   * Reload the current window.
   *
   * @returns {Promise<void>} that resolves after the reloaded renderer reports ready.
   */
  reload() {
    return this.applicationDelegate.invokeWindow("reload");
  }

  /**
   * @public
   * @status public
   *
   * Minimize the current window.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  minimize() {
    return this.applicationDelegate.invokeWindow("minimize");
  }

  /**
   * @public
   * @status public
   *
   * Maximize the current window.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  maximize() {
    return this.applicationDelegate.invokeWindow("maximize");
  }

  /**
   * @public
   * @status public
   *
   * Restore a maximized window.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  unmaximize() {
    return this.applicationDelegate.invokeWindow("unmaximize");
  }

  /** @category Window State */

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is maximized.
   *
   * @returns {Promise<Boolean>} resolving to a `Boolean`.
   */
  isMaximized() {
    return this.applicationDelegate.invokeWindow("isMaximized");
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is full screen.
   *
   * @returns {Promise<Boolean>} resolving to a `Boolean`.
   */
  isFullScreen() {
    return this.applicationDelegate.invokeWindow("isFullScreen");
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is visible.
   *
   * @returns {Promise<Boolean>} resolving to a `Boolean`.
   */
  isVisible() {
    return this.applicationDelegate.invokeWindow("isVisible");
  }

  /** @category Window Management */

  /**
   * @public
   * @status public
   *
   * Enter or leave full-screen mode.
   *
   * @param {Boolean} [fullScreen=false] - A `Boolean` indicating the desired state.
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  setFullScreen(fullScreen = false) {
    return this.applicationDelegate.invokeWindow("setFullScreen", fullScreen);
  }

  /**
   * @public
   * @status public
   *
   * Toggle full-screen mode.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  async toggleFullScreen() {
    return this.setFullScreen(!(await this.isFullScreen()));
  }

  /** @category Dialogs */

  /**
   * @public
   * @status public
   *
   * Ask the user to select one or more folders.
   *
   * @returns {Promise<Array<String>|null>} resolving to an `Array` of paths, or `null` on cancellation.
   */
  pickFolder() {
    return this.applicationDelegate.invokeWindow("pickFolder");
  }

  /**
   * @public
   * @status public
   *
   * Show an open dialog owned by the current window.
   *
   * @param {Object} [options={}] - Serializable Electron open-dialog options.
   * @returns {Promise<Object>} resolving to Electron's serializable open-dialog result.
   */
  showOpenDialog(options = {}) {
    return this.applicationDelegate.invokeWindow("showOpenDialog", options);
  }

  /**
   * @public
   * @status public
   *
   * Show a save dialog owned by the current window.
   *
   * @param {Object} [options={}] - Serializable Electron save-dialog options.
   * @returns {Promise<Object>} resolving to Electron's serializable save-dialog result.
   */
  showSaveDialog(options = {}) {
    return this.applicationDelegate.invokeWindow("showSaveDialog", options);
  }

  /**
   * @public
   * @status essential
   *
   * Show a non-blocking confirmation dialog owned by the current
   * window.
   *
   * @returns {Promise<Number>} resolving to the selected button index.
   * @param {Object} options - Serializable message-box options.
   * @param {Array<String>} options.buttons - Button labels in result-index order.
   */
  confirm(options) {
    return this.applicationDelegate.confirm(options);
  }

  /**
   * @public
   * @status public
   *
   * Start a download in the current window.
   *
   * @param {String} url - The `String` URL to download.
   * @returns {Promise<void>} that resolves when the download is started.
   * @category Downloads
   */
  downloadURL(url) {
    return this.applicationDelegate.invokeWindow("downloadURL", url);
  }

  /**
   * @public
   * @status public
   *
   * Get the primary display's available work-area size.
   *
   * @returns {Promise<Object>} The primary display's available work-area size as `{width, height}`.
   * @category Window Geometry
   */
  getPrimaryDisplayWorkAreaSize() {
    return this.applicationDelegate.invokeWindow("getPrimaryDisplayWorkAreaSize");
  }

  /**
   * @public
   * @status public
   *
   * Move native macOS sheets below HTML window chrome.
   *
   * This is a no-op on other platforms.
   *
   * @param {Number} offsetY - A non-negative integer number of pixels.
   * @returns {Promise<void>} that resolves when the request is applied.
   * @category Native Presentation
   */
  setSheetOffset(offsetY) {
    return this.applicationDelegate.setSheetOffset(offsetY);
  }

  /** @category Developer Tools */

  /**
   * @public
   * @status public
   *
   * Open the current window's developer tools.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  async openDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("openDevTools");
  }

  /**
   * @public
   * @status public
   *
   * Close the current window's developer tools.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  async closeDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("closeDevTools");
  }

  /**
   * @public
   * @status public
   *
   * Toggle the current window's developer tools.
   *
   * @returns {Promise<void>} that resolves when the request is applied.
   */
  async toggleDevTools() {
    await new Promise(process.nextTick);
    return this.applicationDelegate.invokeWindow("toggleDevTools");
  }

  /**
   * @public
   * @status public
   *
   * Evaluate JavaScript in the current window's developer tools.
   *
   * @returns {Promise<void>} Resolves after execution, or immediately if the developer tools are closed.
   * @param {String} code - JavaScript source to run if the developer tools are open.
   */
  executeJavaScriptInDevTools(code) {
    return this.applicationDelegate.invokeWindow("executeJavaScriptInDevTools", code);
  }

  /** @category Window Messaging */

  /**
   * @public
   * @status public
   *
   * Send a serializable event to every other registered Lumine window.
   *
   * @param {String} eventName - A non-empty `String` event name.
   * @param {...*} args - Structured-cloneable values delivered to subscribers.
   * @returns {Promise<void>} that resolves after the event is sent.
   */
  broadcast(eventName, ...args) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      return Promise.reject(new TypeError("Window event name must be a non-empty string"));
    }
    return this.applicationDelegate.broadcastToOtherWindows(eventName, ...args);
  }

  /** @category Event Subscription */

  /**
   * @public
   * @status public
   *
   * Subscribe to named events broadcast by other Lumine windows.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {String} eventName - The broadcast event name.
   * @param {Function} callback - Receives the broadcast arguments from another window.
   */
  onDidReceive(eventName, callback) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      throw new TypeError("Window event name must be a non-empty string");
    }
    return this.applicationDelegate.onDidReceiveWindowEvent(eventName, callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` after entering full-screen mode.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {Function} callback - Called when the documented native window event occurs.
   */
  onDidEnterFullScreen(callback) {
    return this.applicationDelegate.onDidEnterFullScreen(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` after leaving full-screen mode.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {Function} callback - Called when the documented native window event occurs.
   */
  onDidLeaveFullScreen(callback) {
    return this.applicationDelegate.onDidLeaveFullScreen(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` after the window is maximized.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {Function} callback - Called when the documented native window event occurs.
   */
  onDidMaximize(callback) {
    return this.applicationDelegate.onDidMaximizeWindow(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` after a maximized window is restored.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {Function} callback - Called when the documented native window event occurs.
   */
  onDidUnmaximize(callback) {
    return this.applicationDelegate.onDidUnmaximizeWindow(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` when the window gains focus.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {Function} callback - Called when the documented native window event occurs.
   */
  onDidFocus(callback) {
    return this.applicationDelegate.onDidFocusWindow(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` when the window loses focus.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @param {Function} callback - Called when the documented native window event occurs.
   */
  onDidBlur(callback) {
    return this.applicationDelegate.onDidBlurWindow(callback);
  }
}

module.exports = WindowService;
