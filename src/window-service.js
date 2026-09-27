const getWindowLoadSettings = require("./get-window-load-settings");
const StartupTime = require("./startup-time");
const WebContentsViewHandle = require("./web-contents-view-handle");
const WebContentsViewOcclusionManager = require("./web-contents-view-occlusion-manager");

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
    this.webContentsViews = new Map();
    this.focusedWebContentsView = null;
    this.webContentsViewOcclusionManager = new WebContentsViewOcclusionManager();
    this.webContentsViewEventSubscription =
      this.applicationDelegate?.onDidReceiveWebContentsViewEvent?.((event) =>
        this.handleWebContentsViewEvent(event),
      ) ?? null;
    this.destroyed = false;
  }

  /**
   * @public
   * @status public
   *
   * Create an isolated native browser surface owned by the current window.
   *
   * The returned handle never exposes Electron's `WebContentsView` or
   * `webContents`; it accepts only the fixed, serializable operations supported
   * by Lumine's main-process bridge.
   *
   * @param options - Profile and optional user-agent settings.
   * @returns {Promise<WebContentsViewHandle>} a renderer-safe surface handle.
   */
  async createWebContentsView(options = {}) {
    if (this.destroyed) throw new Error("Cannot create a web contents view after window teardown");
    const result = await this.applicationDelegate.invokeWebContentsView("create", options);
    return this.createWebContentsViewHandle(result);
  }

  createWebContentsViewHandle(result) {
    if (!result || (typeof result.id !== "string" && typeof result.id !== "number")) {
      throw new Error("The web contents view bridge returned an invalid handle");
    }

    const existing = this.webContentsViews.get(result.id);
    if (existing) return existing;

    const handle = new WebContentsViewHandle({
      id: result.id,
      state: result.state,
      applicationDelegate: this.applicationDelegate,
      keymapManager: this.lumineEnvironment?.keymaps,
      occlusionManager: this.webContentsViewOcclusionManager,
      onDidDestroy: (destroyedHandle) => {
        if (this.webContentsViews.get(destroyedHandle.id) === destroyedHandle) {
          this.webContentsViews.delete(destroyedHandle.id);
        }
        if (this.focusedWebContentsView === destroyedHandle) {
          this.focusedWebContentsView = null;
        }
      },
    });
    this.webContentsViews.set(handle.id, handle);
    if (result.state?.focused === true) this.focusedWebContentsView = handle;
    return handle;
  }

  handleWebContentsViewEvent(event) {
    if (this.destroyed || !event || typeof event !== "object") return;
    const handle = this.webContentsViews.get(event.id);
    if (!handle) return;

    let detail = event.detail;
    if (event.type === "state" && detail && typeof detail === "object") {
      if (detail.focused === true) this.focusedWebContentsView = handle;
      else if (detail.focused === false && this.focusedWebContentsView === handle) {
        this.focusedWebContentsView = null;
      }
    }
    if (event.type === "popup" && detail && typeof detail === "object") {
      const popupResult =
        detail.surface ??
        (detail.surfaceId != null ? { id: detail.surfaceId, state: detail.state } : null);
      if (popupResult && typeof popupResult === "object" && popupResult.id != null) {
        detail = { ...detail, surface: this.createWebContentsViewHandle(popupResult) };
      }
    }
    handle._acceptEvent({ type: event.type, detail });
  }

  /** @private */
  getFocusedWebContentsViewElement() {
    const element = this.focusedWebContentsView?.anchorElement;
    return element?.isConnected ? element : null;
  }

  /**
   * @public
   * @status extended
   *
   * Mark a DOM overlay which must cover native browser surfaces.
   *
   * @returns {Disposable} which removes the overlay registration.
   */
  registerWebContentsViewOverlay(element) {
    return this.webContentsViewOcclusionManager.registerOverlay(element);
  }

  /**
   * @public
   * @status public
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
   */
  onWillDestroy(callback) {
    return this.lumineEnvironment.emitter.on("will-destroy", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Wait until the current editor window has finished loading.
   *
   * @returns {Promise} resolving to the load time in milliseconds.
   */
  whenLoaded() {
    if (this.lumineEnvironment.loadTime != null) {
      return Promise.resolve(this.lumineEnvironment.loadTime);
    }
    return new Promise((resolve) => this.lumineEnvironment.emitter.once("window-loaded", resolve));
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is in development mode.
   */
  isDevMode() {
    return Boolean(getWindowLoadSettings().devMode);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is in safe mode.
   */
  isSafeMode() {
    return Boolean(getWindowLoadSettings().safeMode);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is running specs.
   */
  isSpecMode() {
    return Boolean(getWindowLoadSettings().isSpec);
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the current window is running headlessly.
   */
  isHeadless() {
    return Boolean(getWindowLoadSettings().headless);
  }

  /**
   * @public
   * @status extended
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
   * @returns {Number|null} The completed window load time in milliseconds, or `null` before loading completes.
   */
  getLoadTime() {
    return this.lumineEnvironment.loadTime;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Object} startup timing markers for the current window.
   */
  getStartupMarkers() {
    return StartupTime.exportData()?.markers || [];
  }

  /**
   * @public
   * @status public
   *
   * @returns {Promise<Object>} A serializable state snapshot with `id`, `position`, `size`, `maximized`, `fullScreen`, and `visible` fields.
   */
  getState() {
    return this.applicationDelegate.invokeWindow("getState");
  }

  /**
   * @public
   * @status public
   *
   * @returns {Promise<Object>} The current content size as `{width, height}`.
   */
  getSize() {
    return this.applicationDelegate.invokeWindow("getSize");
  }

  /**
   * @public
   * @status public
   *
   * Set the content size.
   *
   * @param width - A finite `Number` in pixels.
   * @param height - A finite `Number` in pixels.
   * @returns {Promise} that resolves when the request is applied.
   */
  setSize(width, height) {
    return this.applicationDelegate.invokeWindow("setSize", width, height);
  }

  /**
   * @public
   * @status public
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
   * @param x - A finite `Number` in pixels.
   * @param y - A finite `Number` in pixels.
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
   */
  center() {
    return this.applicationDelegate.invokeWindow("center");
  }

  /**
   * @public
   * @status public
   *
   * Focus the current window.
   *
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the close request is accepted.
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
   * @returns {Promise} that resolves after the reloaded renderer reports ready.
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
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
   */
  unmaximize() {
    return this.applicationDelegate.invokeWindow("unmaximize");
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current window is maximized.
   *
   * @returns {Promise} resolving to a `Boolean`.
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
   * @returns {Promise} resolving to a `Boolean`.
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
   * @returns {Promise} resolving to a `Boolean`.
   */
  isVisible() {
    return this.applicationDelegate.invokeWindow("isVisible");
  }

  /**
   * @public
   * @status public
   *
   * Enter or leave full-screen mode.
   *
   * @param fullScreen - A `Boolean` indicating the desired state.
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
   */
  async toggleFullScreen() {
    return this.setFullScreen(!(await this.isFullScreen()));
  }

  /**
   * @public
   * @status public
   *
   * Ask the user to select one or more folders.
   *
   * @returns {Promise} resolving to an `Array` of paths, or `null` on cancellation.
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
   * @param options - Serializable Electron open-dialog options.
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
   * @param options - Serializable Electron save-dialog options.
   * @returns {Promise} resolving to Electron's serializable save-dialog result.
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
   * @returns {Promise} resolving to the selected button index.
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
   * @param url - The `String` URL to download.
   * @returns {Promise} that resolves when the download is started.
   */
  downloadURL(url) {
    return this.applicationDelegate.invokeWindow("downloadURL", url);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Promise<Object>} The primary display's available work-area size as `{width, height}`.
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
   * @param offsetY - A non-negative integer number of pixels.
   * @returns {Promise} that resolves when the request is applied.
   */
  setSheetOffset(offsetY) {
    return this.applicationDelegate.setSheetOffset(offsetY);
  }

  /**
   * @public
   * @status public
   *
   * Open the current window's developer tools.
   *
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves when the request is applied.
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
   * @returns {Promise} that resolves after evaluation, or immediately when developer tools are closed.
   */
  executeJavaScriptInDevTools(code) {
    return this.applicationDelegate.invokeWindow("executeJavaScriptInDevTools", code);
  }

  /**
   * @public
   * @status public
   *
   * Send a serializable event to every other registered Lumine window.
   *
   * @param eventName - A non-empty `String` event name.
   * @param args - Structured-cloneable values delivered to subscribers.
   * @returns {Promise} that resolves after the event is sent.
   */
  broadcast(eventName, ...args) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      return Promise.reject(new TypeError("Window event name must be a non-empty string"));
    }
    return this.applicationDelegate.broadcastToOtherWindows(eventName, ...args);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to named events broadcast by other Lumine windows.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
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
   */
  onDidBlur(callback) {
    return this.applicationDelegate.onDidBlurWindow(callback);
  }

  /** @private */
  destroy() {
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    this.focusedWebContentsView = null;
    this.webContentsViewEventSubscription?.dispose();
    this.webContentsViewEventSubscription = null;

    const handles = Array.from(this.webContentsViews.values());
    this.webContentsViews.clear();
    this.webContentsViewOcclusionManager.destroy();
    return Promise.allSettled(handles.map((handle) => handle.destroy()));
  }
}

module.exports = WindowService;
