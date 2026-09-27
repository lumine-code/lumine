const { Emitter } = require("@lumine-code/event-kit");

const STATE_EVENT_TYPES = new Set(["state", "state-changed", "did-change-state"]);

function copyState(state = {}) {
  const copy = { ...state };
  if (state.error && typeof state.error === "object") copy.error = { ...state.error };
  return copy;
}

function freezeState(state) {
  const copy = copyState(state);
  if (copy.error && typeof copy.error === "object") Object.freeze(copy.error);
  return Object.freeze(copy);
}

function clampBounds(element) {
  const document = element.ownerDocument;
  const view = document?.defaultView;
  const viewportWidth = view?.innerWidth ?? document?.documentElement?.clientWidth ?? 0;
  const viewportHeight = view?.innerHeight ?? document?.documentElement?.clientHeight ?? 0;
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(viewportWidth, rect.right);
  let bottom = Math.min(viewportHeight, rect.bottom);

  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = view?.getComputedStyle?.(ancestor);
    if (!style) continue;
    const clipsX = /(auto|clip|hidden|scroll)/.test(style.overflowX);
    const clipsY = /(auto|clip|hidden|scroll)/.test(style.overflowY);
    if (!clipsX && !clipsY) continue;

    const ancestorRect = ancestor.getBoundingClientRect();
    if (clipsX) {
      left = Math.max(left, ancestorRect.left);
      right = Math.min(right, ancestorRect.right);
    }
    if (clipsY) {
      top = Math.max(top, ancestorRect.top);
      bottom = Math.min(bottom, ancestorRect.bottom);
    }
  }

  left = Math.floor(left);
  top = Math.floor(top);
  right = Math.ceil(right);
  bottom = Math.ceil(bottom);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    left,
    top,
    right,
    bottom,
  };
}

function isElementVisible(element, intersectionVisible) {
  if (!element?.isConnected || !intersectionVisible) return false;
  if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;

  const view = element.ownerDocument?.defaultView;
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute?.("aria-hidden") === "true") return false;
    const style = view?.getComputedStyle?.(current);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") {
      return false;
    }
  }
  return true;
}

function serializableBounds(bounds) {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function normalizeShortcutType(type) {
  if (type === "keyUp" || type === "keyup") return "keyup";
  return "keydown";
}

function dispatchShortcut(element, detail = {}) {
  if (!element?.isConnected) return false;
  const view = element.ownerDocument?.defaultView;
  const KeyboardEvent = view?.KeyboardEvent;
  if (!KeyboardEvent) return false;

  const modifiers = new Set(detail.modifiers ?? []);
  const event = new KeyboardEvent(normalizeShortcutType(detail.type), {
    key: detail.key ?? "",
    code: detail.code ?? "",
    location: detail.location ?? 0,
    repeat: Boolean(detail.isAutoRepeat ?? detail.repeat),
    ctrlKey: Boolean(detail.ctrlKey ?? modifiers.has("control")),
    shiftKey: Boolean(detail.shiftKey ?? modifiers.has("shift")),
    altKey: Boolean(detail.altKey ?? modifiers.has("alt")),
    metaKey: Boolean(detail.metaKey ?? modifiers.has("meta")),
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * @public
 * @status public
 *
 * A renderer-safe handle to one native WebContentsView owned by the current
 * Lumine window. It exposes only serializable operations and events.
 */
module.exports = class WebContentsViewHandle {
  constructor({ id, state, applicationDelegate, occlusionManager, onDidDestroy }) {
    this.id = id;
    this.state = freezeState(state);
    this.applicationDelegate = applicationDelegate;
    this.occlusionManager = occlusionManager;
    this.onDidDestroyCallback = onDidDestroy;
    this.emitter = new Emitter();
    this.anchorElement = null;
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.anchorMutationObserver = null;
    this.domSubscriptions = [];
    this.intersectionVisible = true;
    this.requestedVisible = true;
    this.layoutFrame = null;
    this.lastLayout = null;
    this.destroyed = false;
    this.destroyPromise = null;
    this.occlusionManager?.addSurface(this);
  }

  getId() {
    return this.id;
  }

  getState() {
    return copyState(this.state);
  }

  onDidChangeState(callback) {
    return this.emitter.on("did-change-state", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` once this surface has been destroyed, whether destruction
   * was requested by the renderer or initiated by the native web contents.
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  onDidReceiveEvent(type, callback) {
    if (typeof type !== "string" || type.length === 0) {
      throw new TypeError("Web contents view event type must be a non-empty string");
    }
    return this.emitter.on(`event:${type}`, callback);
  }

  onDidRequestPopup(callback) {
    return this.onDidReceiveEvent("popup", callback);
  }

  onDidRequestExternalProtocol(callback) {
    return this.onDidReceiveEvent("external-protocol", callback);
  }

  onDidRequestContextMenu(callback) {
    return this.onDidReceiveEvent("context-menu", callback);
  }

  onDidRequestPermission(callback) {
    return this.onDidReceiveEvent("permission", callback);
  }

  onDidRequestDevice(callback) {
    return this.onDidReceiveEvent("device", callback);
  }

  onDidUpdateDevice(callback) {
    return this.onDidReceiveEvent("device-updated", callback);
  }

  onDidRequestAuthentication(callback) {
    return this.onDidReceiveEvent("authentication", callback);
  }

  onDidStartDownload(callback) {
    return this.onDidReceiveEvent("download-started", callback);
  }

  onDidUpdateDownload(callback) {
    return this.onDidReceiveEvent("download-updated", callback);
  }

  onDidFinishDownload(callback) {
    return this.onDidReceiveEvent("download-finished", callback);
  }

  onDidFindInPage(callback) {
    return this.onDidReceiveEvent("find-result", callback);
  }

  onDidCrash(callback) {
    return this.onDidReceiveEvent("crashed", callback);
  }

  onDidReceiveShortcut(callback) {
    return this.onDidReceiveEvent("shortcut", callback);
  }

  _acceptEvent({ type, detail }) {
    if (typeof type !== "string" || this.destroyed) return;

    if (type === "destroyed") {
      this.destroyFromMain(detail);
      return;
    }

    if (STATE_EVENT_TYPES.has(type)) {
      this.state = freezeState({ ...this.state, ...(detail ?? {}) });
      this.emitter.emit("did-change-state", this.getState());
    }
    if (type === "shortcut") dispatchShortcut(this.anchorElement, detail);
    this.emitter.emit(`event:${type}`, detail);
  }

  attach(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
      throw new TypeError("WebContentsViewHandle#attach requires a DOM element");
    }
    if (this.destroyed) throw new Error("Cannot attach a destroyed web contents view");
    if (element === this.anchorElement) {
      this.scheduleLayout();
      return this;
    }

    this.detach();
    this.anchorElement = element;
    this.intersectionVisible = true;
    const document = element.ownerDocument;
    const view = document?.defaultView;

    if (view?.ResizeObserver) {
      this.resizeObserver = new view.ResizeObserver(() => this.scheduleLayout());
      this.resizeObserver.observe(element);
    }
    if (view?.IntersectionObserver) {
      this.intersectionObserver = new view.IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        this.intersectionVisible = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0);
        this.scheduleLayout();
      });
      this.intersectionObserver.observe(element);
    }
    if (view?.MutationObserver) {
      this.anchorMutationObserver = new view.MutationObserver(() => this.scheduleLayout());
      this.anchorMutationObserver.observe(element, {
        attributes: true,
        attributeFilter: ["class", "hidden", "style", "aria-hidden"],
      });
    }

    this.addDOMListener(view, "resize", () => this.scheduleLayout());
    this.addDOMListener(view, "scroll", () => this.scheduleLayout(), true);
    this.addDOMListener(document, "visibilitychange", () => this.scheduleLayout());
    this.occlusionManager?.surfaceAttached(this, element);
    this.scheduleLayout();
    return this;
  }

  addDOMListener(target, type, callback, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, callback, options);
    this.domSubscriptions.push(() => target.removeEventListener(type, callback, options));
  }

  detach() {
    this.releaseAttachment(true);
    return this;
  }

  releaseAttachment(sendHiddenLayout) {
    this.cancelScheduledLayout();
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.anchorMutationObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.anchorMutationObserver = null;
    for (const dispose of this.domSubscriptions.splice(0)) dispose();
    this.anchorElement = null;
    this.intersectionVisible = false;
    if (sendHiddenLayout) {
      this.sendLayout({
        bounds: this.lastLayout?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        visible: false,
      });
    }
  }

  setVisible(visible) {
    this.requestedVisible = Boolean(visible);
    this.scheduleLayout();
  }

  registerOverlay(element) {
    return this.occlusionManager.registerOverlay(element);
  }

  scheduleLayout() {
    if (this.destroyed || this.layoutFrame != null) return;
    const view = this.anchorElement?.ownerDocument?.defaultView;
    const schedule = view?.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0));
    this.layoutFrame = schedule(() => {
      this.layoutFrame = null;
      this.updateLayout();
    });
  }

  cancelScheduledLayout() {
    if (this.layoutFrame == null) return;
    const view = this.anchorElement?.ownerDocument?.defaultView;
    if (view?.cancelAnimationFrame) view.cancelAnimationFrame(this.layoutFrame);
    else clearTimeout(this.layoutFrame);
    this.layoutFrame = null;
  }

  updateLayout() {
    if (this.destroyed) return;
    const element = this.anchorElement;
    if (!element) return;

    const bounds = clampBounds(element);
    const documentVisible = element.ownerDocument?.visibilityState !== "hidden";
    let visible =
      this.requestedVisible &&
      documentVisible &&
      isElementVisible(element, this.intersectionVisible) &&
      bounds.width > 0 &&
      bounds.height > 0;
    if (visible && this.occlusionManager?.isOccluded(element, bounds)) visible = false;

    this.sendLayout({ bounds: serializableBounds(bounds), visible });
  }

  sendLayout(layout) {
    if (this.destroyed) return;
    const key = JSON.stringify(layout);
    if (key === this.lastLayoutKey) return;
    this.lastLayoutKey = key;
    this.lastLayout = layout;
    void this.applicationDelegate
      .invokeWebContentsView("layout", this.id, layout)
      .catch((error) => {
        if (!this.destroyed) console.error("Failed to lay out a web contents view", error);
      });
  }

  invoke(action, payload) {
    if (this.destroyed) {
      return Promise.reject(new Error("Cannot use a destroyed web contents view"));
    }
    if (arguments.length === 1) {
      return this.applicationDelegate.invokeWebContentsView(action, this.id);
    }
    return this.applicationDelegate.invokeWebContentsView(action, this.id, payload);
  }

  loadURL(url, options = {}) {
    return this.invoke("loadURL", { url, options });
  }

  goBack() {
    return this.invoke("goBack");
  }

  goForward() {
    return this.invoke("goForward");
  }

  reload() {
    return this.invoke("reload");
  }

  reloadIgnoringCache() {
    return this.invoke("reloadIgnoringCache");
  }

  stop() {
    return this.invoke("stop");
  }

  focus() {
    return this.invoke("focus");
  }

  blur() {
    return this.invoke("blur");
  }

  findInPage(text, options = {}) {
    return this.invoke("findInPage", { text, options });
  }

  stopFindInPage(action = "clearSelection") {
    return this.invoke("stopFindInPage", action);
  }

  setZoomFactor(factor) {
    return this.invoke("setZoomFactor", factor);
  }

  setUserAgent(userAgent) {
    return this.invoke("setUserAgent", userAgent);
  }

  print(options = {}) {
    return this.invoke("print", options);
  }

  capturePage(rect) {
    return this.invoke("capturePage", rect);
  }

  openDevTools(options = {}) {
    return this.invoke("openDevTools", options);
  }

  closeDevTools() {
    return this.invoke("closeDevTools");
  }

  inspectElement(x, y) {
    return this.invoke("inspectElement", { x, y });
  }

  copy() {
    return this.invoke("copy");
  }

  cut() {
    return this.invoke("cut");
  }

  paste() {
    return this.invoke("paste");
  }

  undo() {
    return this.invoke("undo");
  }

  redo() {
    return this.invoke("redo");
  }

  selectAll() {
    return this.invoke("selectAll");
  }

  replaceMisspelling(word) {
    return this.invoke("replaceMisspelling", word);
  }

  addWordToDictionary(word) {
    return this.invoke("addWordToDictionary", word);
  }

  setDeviceEmulation(options) {
    return this.invoke("setDeviceEmulation", options);
  }

  clearDeviceEmulation() {
    return this.invoke("clearDeviceEmulation");
  }

  clearBrowsingData(options) {
    return this.invoke("clearBrowsingData", options);
  }

  getSessionState() {
    return this.invoke("getSessionState");
  }

  setPermissionDecision(origin, permission, allow) {
    return this.invoke("setPermissionDecision", { origin, permission, allow });
  }

  cancelDownload(requestId) {
    return this.invoke("cancelDownload", requestId);
  }

  respondToPopup(requestId, response) {
    return this.invoke("popupResponse", { requestId, response });
  }

  respondToPermission(requestId, response) {
    return this.invoke("permissionResponse", { requestId, response });
  }

  respondToDevice(requestId, response) {
    return this.invoke("deviceResponse", { requestId, response });
  }

  respondToAuthentication(requestId, response) {
    return this.invoke("authResponse", { requestId, response });
  }

  respondToDownload(requestId, response) {
    return this.invoke("downloadResponse", { requestId, response });
  }

  respondToContextMenu(requestId, response) {
    return this.invoke("contextMenuResponse", { requestId, response });
  }

  destroyFromMain(detail) {
    if (this.destroyed) return;

    this.releaseAttachment(false);
    this.destroyed = true;
    this.destroyPromise = Promise.resolve();
    this.occlusionManager?.removeSurface(this);
    this.onDidDestroyCallback?.(this);
    try {
      this.emitter.emit("event:destroyed", detail);
    } finally {
      try {
        this.emitter.emit("did-destroy", detail);
      } finally {
        this.emitter.dispose();
      }
    }
  }

  destroy() {
    if (this.destroyPromise) return this.destroyPromise;

    this.detach();
    this.destroyed = true;
    this.occlusionManager?.removeSurface(this);
    this.onDidDestroyCallback?.(this);
    this.destroyPromise = this.applicationDelegate
      .invokeWebContentsView("destroy", this.id)
      .finally(() => this.emitter.dispose());
    this.emitter.emit("did-destroy", { reason: "renderer-request" });
    return this.destroyPromise;
  }
};
