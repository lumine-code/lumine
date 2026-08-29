const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");
const { dialog, screen } = require("electron");

const RESERVATION_TTL = 30_000;
const MINIMUM_SIZE = 160;

function finiteInteger(value, fallback) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function normalizeOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Detached-pane window options must be an object");
  }
  const bounds = options.bounds || {};
  const normalized = {
    title: typeof options.title === "string" && options.title ? options.title : "Lumine",
    width: Math.max(MINIMUM_SIZE, finiteInteger(bounds.width, 800)),
    height: Math.max(MINIMUM_SIZE, finiteInteger(bounds.height, 600)),
    show: options.show !== false,
  };
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    normalized.x = Math.round(bounds.x);
    normalized.y = Math.round(bounds.y);
  }
  return normalized;
}

function normalizeBounds(bounds, currentBounds = {}) {
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new TypeError("Detached-pane bounds must be an object");
  }

  const allowed = new Set(["x", "y", "width", "height"]);
  for (const key of Object.keys(bounds)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported detached-pane bound '${key}'`);
  }

  const normalized = Object.assign({}, currentBounds);
  let changed = false;
  for (const key of allowed) {
    if (!Object.hasOwn(bounds, key)) continue;
    if (!Number.isFinite(bounds[key])) {
      throw new TypeError(`Detached-pane bound '${key}' must be finite`);
    }
    normalized[key] = Math.round(bounds[key]);
    changed = true;
  }
  if (!changed) throw new TypeError("Detached-pane bounds must name at least one coordinate");
  if (Object.hasOwn(bounds, "width")) normalized.width = Math.max(MINIMUM_SIZE, normalized.width);
  if (Object.hasOwn(bounds, "height")) {
    normalized.height = Math.max(MINIMUM_SIZE, normalized.height);
  }
  return normalized;
}

function visibleBounds({ width, height, x, y }, ownerBounds = {}) {
  const anchor = {
    x: x ?? ownerBounds.x ?? 0,
    y: y ?? ownerBounds.y ?? 0,
  };
  const workArea = screen.getDisplayNearestPoint(anchor).workArea;
  width = Math.min(width, workArea.width);
  height = Math.min(height, workArea.height);
  return {
    x: Math.max(workArea.x, Math.min(anchor.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(anchor.y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

module.exports = class DetachedPaneWindowManager {
  constructor(ownerWindow, { reservationTTL = RESERVATION_TTL } = {}) {
    this.ownerWindow = ownerWindow;
    this.browserWindow = ownerWindow.browserWindow;
    this.webContents = this.browserWindow.webContents;
    this.application = ownerWindow.lumineApplication;
    this.detachedDocumentURL = pathToFileURL(
      path.join(
        ownerWindow.resourcePath || path.resolve(__dirname, ".."),
        "static",
        "detached-pane.html",
      ),
    ).href;
    this.reservationTTL = reservationTTL;
    this.transactions = new Map();
    this.transactionsByFrameName = new Map();
    this.surfaces = new Map();
    this.destroyed = false;
    this.handleWindowOpen = this.handleWindowOpen.bind(this);
    this.didCreateWindow = this.didCreateWindow.bind(this);
  }

  install() {
    const contents = this.webContents;
    if (typeof contents.setWindowOpenHandler !== "function") {
      throw new Error("Detached pane windows require webContents.setWindowOpenHandler()");
    }
    contents.setWindowOpenHandler(this.handleWindowOpen);
    contents.on("did-create-window", this.didCreateWindow);
  }

  reserve(options = {}) {
    this.assertAlive();
    const requestedTransactionId = options.transactionId;
    if (requestedTransactionId != null) {
      if (typeof requestedTransactionId !== "string" || requestedTransactionId.length === 0) {
        throw new TypeError("transactionId must be a non-empty string");
      }
      const existing = this.transactions.get(requestedTransactionId);
      if (existing) return this.publicTransaction(existing);
    }

    const transactionId = requestedTransactionId || crypto.randomUUID();
    const surfaceId = crypto.randomUUID();
    const frameName = `lumine-detached-pane-${crypto.randomUUID()}`;
    const transaction = {
      transactionId,
      surfaceId,
      frameName,
      url: this.detachedDocumentURL,
      options: normalizeOptions(options),
      state: "reserved",
      surface: null,
      timeout: null,
    };
    transaction.timeout = setTimeout(() => this.expire(transaction), this.reservationTTL);
    transaction.timeout.unref?.();
    this.transactions.set(transactionId, transaction);
    this.transactionsByFrameName.set(frameName, transaction);
    return this.publicTransaction(transaction);
  }

  publicTransaction(transaction) {
    return {
      transactionId: transaction.transactionId,
      surfaceId: transaction.surfaceId,
      frameName: transaction.frameName,
      url: transaction.url,
      state: transaction.state,
    };
  }

  handleWindowOpen({ url, frameName }) {
    const transaction = this.transactionsByFrameName.get(frameName);
    if (
      this.destroyed ||
      url !== transaction?.url ||
      !transaction ||
      transaction.state !== "reserved"
    ) {
      return { action: "deny" };
    }

    transaction.state = "accepted";
    return {
      action: "allow",
      outlivesOpener: false,
    };
  }

  didCreateWindow(browserWindow, details) {
    const transaction = this.transactionsByFrameName.get(details.frameName);
    if (!transaction || transaction.state !== "accepted") {
      browserWindow.destroy();
      return;
    }

    clearTimeout(transaction.timeout);
    transaction.timeout = null;
    transaction.state = "created";
    const surface = {
      id: transaction.surfaceId,
      transactionId: transaction.transactionId,
      browserWindow,
      state: "created",
      closing: false,
    };
    transaction.surface = surface;
    this.surfaces.set(surface.id, surface);
    const { title } = transaction.options;
    browserWindow.hide();
    browserWindow.setTitle(title);
    browserWindow.setMinimumSize?.(MINIMUM_SIZE, MINIMUM_SIZE);
    browserWindow.setBounds?.(
      visibleBounds(transaction.options, this.browserWindow.getBounds?.() || {}),
    );
    browserWindow.setAutoHideMenuBar?.(true);
    this.application.registerDetachedPaneWindow?.(this.ownerWindow, surface);
    this.bindSurface(surface);
    this.emit(surface, "created", this.stateFor(surface));
  }

  bindSurface(surface) {
    const { browserWindow } = surface;
    browserWindow.on("close", (event) => {
      if (surface.closing) return;
      event.preventDefault();
      if (surface.state === "close-requested") return;
      surface.state = "close-requested";
      this.emit(surface, "close-requested");
    });
    browserWindow.on("closed", () => this.surfaceClosed(surface));
    browserWindow.on("focus", () => {
      this.application.didFocusDetachedPaneWindow?.(this.ownerWindow, surface);
      this.emit(surface, "focus");
    });
    browserWindow.on("blur", () => this.emit(surface, "blur"));
    for (const eventName of [
      "move",
      "resize",
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
    ]) {
      browserWindow.on(eventName, () =>
        this.emit(surface, "state-changed", this.stateFor(surface)),
      );
    }
    const transaction = this.transactions.get(surface.transactionId);
    browserWindow.webContents.on("will-navigate", (event, targetURL) => {
      if (targetURL !== transaction?.url) event.preventDefault();
    });
    browserWindow.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    browserWindow.webContents.setVisualZoomLevelLimits?.(1, 1);
  }

  perform(transactionId, action, ...args) {
    this.assertAlive();
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      if (action === "cancel" || action === "attach") return false;
      throw new Error("Unknown detached-pane window transaction");
    }

    if (action === "cancel") return this.cancel(transaction);
    const surface = transaction.surface;
    if (!surface || surface.browserWindow.isDestroyed()) {
      throw new Error("The detached-pane window has not been created");
    }
    const window = surface.browserWindow;

    switch (action) {
      case "ready":
        if (surface.state !== "created") throw new Error("Detached-pane window is not being built");
        surface.state = transaction.state = "ready";
        return this.stateFor(surface);
      case "commit":
        if (surface.state !== "ready") throw new Error("Detached-pane window is not ready");
        surface.state = transaction.state = "open";
        if (transaction.options.show) {
          window.show();
          window.focus();
        }
        return this.stateFor(surface);
      case "attach":
        if (surface.state === "closing" && surface.closeReason === "attached") return false;
        if (surface.state !== "ready" && surface.state !== "open") {
          throw new Error("Only a ready or open detached-pane window can be attached");
        }
        if (!this.destroySurface(surface, "attached")) return false;
        // Destroying the focused child usually activates its owner, but that is
        // window-manager policy rather than an Electron guarantee (and does
        // not happen under Xvfb). Attaching means returning to the primary
        // workspace, so make that focus transfer explicit.
        if (!this.browserWindow.isDestroyed()) this.browserWindow.focus();
        return true;
      case "close-accepted":
        if (surface.state !== "close-requested") {
          throw new Error("The detached-pane window did not request closure");
        }
        return this.destroySurface(surface, "accepted");
      case "close-cancelled":
        if (surface.state !== "close-requested") return false;
        surface.state = transaction.state = "open";
        return true;
      case "request-close":
        window.close();
        return;
      case "focus":
        window.show();
        window.focus();
        return;
      case "show":
        window.show();
        return;
      case "get-state":
        return this.stateFor(surface);
      case "set-bounds":
        window.setBounds(normalizeBounds(args[0], window.getBounds?.() || {}));
        return this.stateFor(surface);
      case "set-title":
        if (typeof args[0] !== "string") throw new TypeError("Window title must be a string");
        window.setTitle(args[0]);
        return;
      case "set-document-edited":
        window.setDocumentEdited?.(Boolean(args[0]));
        return;
      case "set-represented-filename":
        if (typeof args[0] !== "string") {
          throw new TypeError("Represented filename must be a string");
        }
        window.setRepresentedFilename?.(args[0]);
        return;
      case "confirm": {
        const options = args[0];
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new TypeError("Confirmation options must be an object");
        }
        return dialog
          .showMessageBox(
            window,
            Object.assign({ type: "info", normalizeAccessKeys: true }, options),
          )
          .then((result) => result.response);
      }
      case "show-save-dialog": {
        const options = args[0];
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new TypeError("Save dialog options must be an object");
        }
        return dialog.showSaveDialog(window, options);
      }
      case "web-contents-action": {
        const webContentsAction = args[0];
        if (!["copy", "paste", "undo", "redo", "selectAll", "cut"].includes(webContentsAction)) {
          throw new Error(`Unsupported web-contents action: ${webContentsAction}`);
        }
        window.webContents[webContentsAction]();
        return;
      }
      case "show-context-menu": {
        const [requestId, template] = args;
        if (typeof requestId !== "string" || !Array.isArray(template)) {
          throw new TypeError("A context-menu request id and template are required");
        }
        const ContextMenu = require("./context-menu");
        return new ContextMenu(template, this.ownerWindow, {
          browserWindow: window,
          sendCommand: (command, detail) =>
            this.ownerWindow.sendToRenderer(
              "surface-context-command",
              surface.id,
              requestId,
              command,
              detail,
            ),
          onClose: () =>
            this.ownerWindow.sendToRenderer("surface-context-menu-closed", surface.id, requestId),
        });
      }
      case "minimize":
      case "maximize":
      case "unmaximize":
        window[action]();
        return;
      case "set-full-screen":
        window.setFullScreen(Boolean(args[0]));
        return;
      default:
        throw new Error(`Unsupported detached-pane window action: ${action}`);
    }
  }

  cancel(transaction) {
    if (transaction.state === "open" || transaction.state === "close-requested") {
      throw new Error("A committed detached-pane window transaction cannot be cancelled");
    }
    if (transaction.surface) this.destroySurface(transaction.surface, "cancelled");
    else this.deleteTransaction(transaction);
    return true;
  }

  expire(transaction) {
    if (this.transactions.get(transaction.transactionId) !== transaction) return;
    if (["reserved", "accepted"].includes(transaction.state) && !transaction.surface) {
      this.deleteTransaction(transaction);
    }
  }

  stateFor(surface) {
    const window = surface.browserWindow;
    const bounds = window.getBounds?.() || {};
    return {
      id: surface.id,
      transactionId: surface.transactionId,
      state: surface.state,
      bounds,
      maximized: Boolean(window.isMaximized?.()),
      fullScreen: Boolean(window.isFullScreen?.()),
      visible: Boolean(window.isVisible?.()),
    };
  }

  emit(surface, eventName, detail) {
    this.ownerWindow.sendToRenderer("detached-pane-window-event", surface.id, eventName, detail);
  }

  destroySurface(surface, reason) {
    if (surface.closing) return false;
    surface.closing = true;
    surface.state = "closing";
    const transaction = this.transactions.get(surface.transactionId);
    if (transaction) transaction.state = "closing";
    surface.closeReason = reason;
    if (surface.browserWindow.isDestroyed()) this.surfaceClosed(surface);
    else surface.browserWindow.destroy();
    return true;
  }

  surfaceClosed(surface) {
    if (this.surfaces.get(surface.id) !== surface) return;
    const unexpected = !surface.closing;
    this.surfaces.delete(surface.id);
    this.application.unregisterDetachedPaneWindow?.(surface);
    const transaction = this.transactions.get(surface.transactionId);
    if (transaction) this.deleteTransaction(transaction);
    this.emit(surface, "closed", { reason: surface.closeReason || "unexpected", unexpected });
  }

  deleteTransaction(transaction) {
    if (transaction.timeout) clearTimeout(transaction.timeout);
    this.transactions.delete(transaction.transactionId);
    this.transactionsByFrameName.delete(transaction.frameName);
  }

  hasFocusedWindow() {
    for (const surface of this.surfaces.values()) {
      if (!surface.browserWindow.isDestroyed() && surface.browserWindow.isFocused()) return true;
    }
    return false;
  }

  closeAll(reason = "owner-reload") {
    for (const surface of Array.from(this.surfaces.values())) {
      this.destroySurface(surface, reason);
    }
    for (const transaction of Array.from(this.transactions.values())) {
      if (!transaction.surface) this.deleteTransaction(transaction);
    }
  }

  surfaceForBrowserWindow(browserWindow) {
    for (const surface of this.surfaces.values()) {
      if (surface.browserWindow === browserWindow) return surface;
    }
    return null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const contents = this.webContents;
    contents.removeListener("did-create-window", this.didCreateWindow);
    if (!contents.isDestroyed?.()) {
      contents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    }
    this.closeAll("owner-closed");
  }

  assertAlive() {
    if (this.destroyed) throw new Error("Detached-pane window manager has been destroyed");
  }
};

module.exports.normalizeOptions = normalizeOptions;
module.exports.normalizeBounds = normalizeBounds;
module.exports.visibleBounds = visibleBounds;
