const crypto = require("node:crypto");
const { screen, dialog } = require("electron");
const attachEmbeddedKeyboardIpc = require("./embedded-keyboard-ipc");
const attachNativeWindowInput = require("./native-window-input");

function assertBounds(bounds) {
  if (!bounds || typeof bounds !== "object") throw new TypeError("Window bounds are required.");
  for (const key of ["x", "y", "width", "height"]) {
    if (bounds[key] !== undefined && !Number.isInteger(bounds[key])) {
      throw new TypeError(`Window ${key} must be an integer.`);
    }
  }
  if (bounds.width !== undefined && bounds.width < 1) throw new RangeError("Invalid width.");
  if (bounds.height !== undefined && bounds.height < 1) throw new RangeError("Invalid height.");
}

// Native presentations are owned by the opening LumineWindow, not registered
// as independent editor sessions. The parent renderer alone can address them.
module.exports = class AuxiliaryWindowBroker {
  constructor(owner, { displayService = screen, attachKeyboard = attachEmbeddedKeyboardIpc } = {}) {
    this.owner = owner;
    this.displayService = displayService;
    this.attachKeyboard = attachKeyboard;
    this.pending = new Map();
    this.windows = new Map();
    this.destroyed = false;
  }

  prepare(options = {}) {
    if (this.destroyed) throw new Error("The workspace window has closed.");
    const persistentId =
      options.persistentId === undefined ? crypto.randomUUID() : options.persistentId;
    if (
      typeof persistentId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(persistentId)
    )
      throw new TypeError("An editor window persistent identity must be a UUID.");
    const existing = [...this.windows.values()].find(
      (entry) => entry.persistentId === persistentId,
    );
    if (
      (existing && existing.id !== options.replacesWindowId) ||
      [...this.pending.values()].some((entry) => entry.persistentId === persistentId)
    )
      throw new Error("This editor window identity is already in use.");
    if (
      options.replacesWindowId !== undefined &&
      (!existing || existing.id !== options.replacesWindowId)
    )
      throw new Error("A replacement must address this workspace's existing editor window.");
    const bounds = { ...(options.bounds ?? {}) };
    assertBounds(bounds);
    // A saved display can disappear between sessions. Keep the complete
    // presentation reachable in the nearest current work area.
    if (bounds.x !== undefined && bounds.y !== undefined) {
      const area = this.displayService.getDisplayMatching({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width ?? 800,
        height: bounds.height ?? 600,
      }).workArea;
      bounds.width = Math.min(bounds.width ?? 800, area.width);
      bounds.height = Math.min(bounds.height ?? 600, area.height);
      bounds.x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width));
      bounds.y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height));
    }
    const token = `lumine-editor-${crypto.randomUUID()}`;
    let resolve;
    const ready = new Promise((complete) => {
      resolve = complete;
    });
    const request = {
      token,
      bounds,
      persistentId,
      ready,
      resolve,
    };
    request.timeout = setTimeout(() => this.cancel(token), 30000);
    request.timeout.unref?.();
    this.pending.set(token, request);
    return token;
  }

  windowOpenHandler({ url, frameName }) {
    const request = this.pending.get(frameName);
    if (this.destroyed || url !== "about:blank" || !request || request.opened)
      return { action: "deny" };
    request.opened = true;
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...request.bounds,
        frame: false,
        show: false,
        ...(this.owner.presentationIcon && { icon: this.owner.presentationIcon }),
        webPreferences: { backgroundThrottling: false },
      },
    };
  }

  didCreateWindow(window, details) {
    const request = this.pending.get(details.frameName);
    if (!request || this.destroyed) {
      window.destroy();
      return;
    }
    // Auxiliary IDs occupy a separate range from ordinary LumineWindow IDs.
    const id = -window.webContents.id;
    const record = { id, window, persistentId: request.persistentId, closeApproved: false };
    this.windows.set(id, record);
    attachNativeWindowInput(window, (position) =>
      this.owner.sendToRenderer("did-mouse-down-in-window", {
        windowId: id,
        ...(position && { position }),
      }),
    );
    this.updateRuntimeThrottling();
    request.record = record;
    record.keyboard = this.attachKeyboard(window.webContents, {
      testing: !!this.owner.isSpec,
      isWindowFocused: () => window.isFocused?.() === true,
      sendCommand: (descriptor) =>
        this.owner.sendToRenderer("auxiliary-window-keyboard-command", { id, descriptor }),
    });
    window.on("blur", record.keyboard.clear);
    window.on("focus", () => {
      this.owner.lumineApplication.windowStack?.touch(this.owner);
      this.owner.lumineApplication.applicationMenu?.focusWindow(this.owner.browserWindow);
    });
    window.webContents.setIgnoreMenuShortcuts?.(true);
    request.resolve(record);
    window.on("close", (event) => {
      if (
        !record.closeApproved &&
        !this.owner.unloading &&
        !this.owner.lumineApplication.quitting
      ) {
        event.preventDefault();
        this.send(id, "close-requested");
      }
    });
    window.on("closed", () => {
      record.keyboard.dispose();
      this.windows.delete(id);
      this.updateRuntimeThrottling();
      this.send(id, "closed");
    });
    for (const eventName of [
      "focus",
      "blur",
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
      "resize",
      "move",
    ]) {
      window.on(eventName, () => this.send(id, eventName));
    }
    // These windows host document views. A navigation must not turn them into
    // another runtime or replace the shared model's presentation document.
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  }

  updateRuntimeThrottling() {
    const browserWindow = this.owner.browserWindow;
    if (!browserWindow || browserWindow.isDestroyed?.()) return;
    const contents = browserWindow.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (this.windows.size) {
      if (this.runtimeBackgroundThrottling !== undefined) return;
      this.runtimeBackgroundThrottling = contents.getBackgroundThrottling();
      // The opener also owns every package's shared runtime. Its timers must
      // keep serving auxiliary windows while the main presentation is hidden.
      contents.setBackgroundThrottling(false);
    } else if (this.runtimeBackgroundThrottling !== undefined) {
      contents.setBackgroundThrottling(this.runtimeBackgroundThrottling);
      this.runtimeBackgroundThrottling = undefined;
    }
  }

  send(id, type) {
    if (!this.destroyed) {
      const record = this.windows.get(id);
      const state = record && !record.window.isDestroyed() ? this.state(record) : undefined;
      this.owner.sendToRenderer("auxiliary-window-event", { id, type, ...(state && { state }) });
    }
  }

  getFocusedRecord() {
    return [...this.windows.values()].find(
      (record) => !record.window.isDestroyed() && record.window.isFocused?.(),
    );
  }

  async resolve(token) {
    const pending = this.pending.get(token);
    if (!pending) throw new Error("Unknown auxiliary window request.");
    const record = await pending.ready;
    clearTimeout(pending.timeout);
    this.pending.delete(token);
    if (!record || this.destroyed || record.window.isDestroyed()) {
      throw new Error("The auxiliary window request was cancelled.");
    }
    return { id: record.id, persistentId: record.persistentId, state: this.state(record) };
  }

  cancel(token) {
    const request = this.pending.get(token);
    if (!request) return;
    this.pending.delete(token);
    clearTimeout(request.timeout);
    request.resolve(null);
    if (request.record && !request.record.window.isDestroyed()) request.record.window.destroy();
  }

  state(record) {
    const [x, y] = record.window.getPosition();
    const [width, height] = record.window.getSize();
    return {
      id: record.id,
      position: { x, y },
      size: { width, height },
      maximized: record.window.isMaximized(),
      fullScreen: record.window.isFullScreen(),
      visible: record.window.isVisible(),
      bounds: record.window.getNormalBounds?.() ?? { x, y, width, height },
    };
  }

  invoke(id, action, ...args) {
    const record = this.windows.get(id);
    if (this.destroyed || !record || record.window.isDestroyed()) {
      throw new Error("This auxiliary window does not belong to the workspace.");
    }
    const window = record.window;
    switch (action) {
      case "updateEmbeddedKeyboard":
        return record.keyboard.update(args[0]);
      case "getState":
        return this.state(record);
      case "focus":
        if (!this.owner.offscreen) window.focus();
        window.webContents.focus();
        return;
      case "show":
        if (!this.owner.headless) window.show();
        return;
      case "hide":
        window.hide();
        return;
      case "minimize":
        if (!this.owner.offscreen) window.minimize();
        return;
      case "maximize":
        if (!this.owner.offscreen) window.maximize();
        return;
      case "unmaximize":
        if (!this.owner.offscreen) window.unmaximize();
        return;
      case "isMaximized":
        return window.isMaximized();
      case "isFullScreen":
        return window.isFullScreen();
      case "isVisible":
        return window.isVisible();
      case "getPosition": {
        const [x, y] = window.getPosition();
        return { x, y };
      }
      case "getSize": {
        const [width, height] = window.getSize();
        return { width, height };
      }
      case "setBounds":
        assertBounds(args[0]);
        window.setBounds(args[0]);
        return;
      case "setFullScreen":
        if (typeof args[0] !== "boolean") throw new TypeError("Fullscreen must be a boolean.");
        if (!this.owner.offscreen) window.setFullScreen(args[0]);
        return;
      case "setTitle":
        if (typeof args[0] !== "string") throw new TypeError("A window title must be a string.");
        window.setTitle(args[0]);
        return;
      case "setRepresentedFilename":
        if (typeof args[0] !== "string")
          throw new TypeError("A represented filename must be a string.");
        window.setRepresentedFilename(args[0]);
        return;
      case "close":
        record.closeApproved = true;
        window.close();
        return;
      case "openDevTools":
        window.webContents.openDevTools({ mode: "detach" });
        return;
      case "toggleDevTools":
        if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
        else window.webContents.openDevTools({ mode: "detach" });
        return;
      case "closeDevTools":
        window.webContents.closeDevTools();
        return;
      case "setSheetOffset":
        if (!Number.isInteger(args[0]) || args[0] < 0) throw new TypeError("Invalid sheet offset.");
        window.setSheetOffset?.(args[0]);
        return;
      case "showSaveDialog":
        return dialog.showSaveDialog(window, {
          title: "Save File",
          defaultPath: this.owner.projectRoots?.[0],
          ...args[0],
        });
      case "confirm": {
        const options = args[0];
        if (
          !options ||
          !Array.isArray(options.buttons) ||
          !options.buttons.every((button) => typeof button === "string")
        )
          throw new TypeError("Confirm options.buttons must be an array of strings.");
        return dialog
          .showMessageBox(window, { type: "info", normalizeAccessKeys: true, ...options })
          .then((result) => result.response);
      }
      case "performWebContentsAction":
        if (!["copy", "paste", "cut", "undo", "redo", "selectAll"].includes(args[0]))
          throw new Error("Unsupported native editing action.");
        window.webContents[args[0]]();
        return;
      default:
        throw new Error(`Unsupported auxiliary window action: ${action}`);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.resolve(null);
    }
    this.pending.clear();
    for (const record of this.windows.values()) {
      if (!record.window.isDestroyed()) record.window.destroy();
    }
    this.windows.clear();
    this.updateRuntimeThrottling();
  }
};
