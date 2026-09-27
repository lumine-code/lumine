const crypto = require("crypto");
const path = require("path");
const electron = require("electron");

const IPC_CHANNEL = "lumine:web-contents-view";
const EVENT_CHANNEL = "lumine:web-contents-view-event";
const SHORTCUT_CHANNEL = "lumine:web-contents-view-shortcut";
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);
const EDIT_ACTIONS = new Set(["copy", "cut", "paste", "undo", "redo", "selectAll"]);
const CONTEXT_ACTIONS = new Set([
  ...EDIT_ACTIONS,
  "back",
  "forward",
  "reload",
  "reloadIgnoringCache",
  "print",
]);
const SUPPORTED_PERMISSIONS = new Set([
  "bluetooth",
  "clipboard-read",
  "clipboard-sanitized-write",
  "geolocation",
  "hid",
  "media",
  "media:audio",
  "media:video",
  "notifications",
  "sensors",
  "serial",
  "usb",
]);

function assertObject(value, name) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function validateProfile(profile) {
  assertObject(profile, "profile");
  assertString(profile.id, "profile.id");
  if (!PROFILE_ID_PATTERN.test(profile.id)) throw new TypeError("profile.id is invalid");
  if (profile.id.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new TypeError("profile.id contains an invalid path segment");
  }
  if (typeof profile.persistent !== "boolean") {
    throw new TypeError("profile.persistent must be a boolean");
  }
  return { id: profile.id, persistent: profile.persistent };
}

function partitionForProfile(profile, nonce = crypto.randomUUID()) {
  const name = `lumine-web/${profile.id}`;
  return profile.persistent ? `persist:${name}` : `${name}/${nonce}`;
}

function validateURL(value) {
  assertString(value, "url");
  const parsed = new URL(value);
  if (parsed.href === "about:blank") return parsed.href;
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw Object.assign(new Error(`Navigation to ${parsed.protocol} is not allowed`), {
      code: "ERR_UNSUPPORTED_SCHEME",
    });
  }
  return parsed.href;
}

function validateUserAgent(value) {
  if (typeof value !== "string") throw new TypeError("userAgent must be a string");
  if (value.length > 512) throw new RangeError("userAgent is too long");
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new TypeError("userAgent contains control characters");
  }
  return value;
}

function secureWebPreferences(session, preloadPath) {
  return {
    session,
    preload: preloadPath,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: true,
  };
}

function integer(value, fallback = 0) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function sanitizeBounds(bounds, owner) {
  assertObject(bounds, "bounds");
  const contentBounds = owner.browserWindow.getContentBounds?.() || {
    width: Number.MAX_SAFE_INTEGER,
    height: Number.MAX_SAFE_INTEGER,
  };
  const x = Math.max(0, integer(bounds.x));
  const y = Math.max(0, integer(bounds.y));
  const width = Math.max(0, Math.min(integer(bounds.width), Math.max(0, contentBounds.width - x)));
  const height = Math.max(
    0,
    Math.min(integer(bounds.height), Math.max(0, contentBounds.height - y)),
  );
  return { x, y, width, height };
}

function isMainFrameSender(event, owner) {
  if (event.sender !== owner.browserWindow.webContents) return false;
  const frame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (!frame || frame.isDestroyed?.()) return false;
  return sameFrame(frame, mainFrame);
}

function sameFrame(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return left.processId === right.processId && left.routingId === right.routingId;
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "null";
  }
}

function permissionKeys(permission, details = {}) {
  if (permission !== "media") return [permission];
  const mediaTypes = Array.isArray(details.mediaTypes)
    ? details.mediaTypes
    : details.mediaType && details.mediaType !== "unknown"
      ? [details.mediaType]
      : ["audio", "video"];
  const keys = [...new Set(mediaTypes)]
    .filter((type) => type === "audio" || type === "video")
    .map((type) => `media:${type}`);
  return keys.length > 0 ? keys : ["media:audio", "media:video"];
}

function sanitizeDevice(device) {
  return {
    deviceId: device.deviceId || device.portId || "",
    name:
      device.deviceName ||
      device.productName ||
      device.displayName ||
      device.portName ||
      device.name ||
      "",
    vendorId: device.vendorId ?? null,
    productId: device.productId ?? null,
    serialNumber: device.serialNumber || "",
  };
}

class WebContentsViewManager {
  constructor(application, options = {}) {
    this.application = application;
    this.electron = options.electron || electron;
    this.preloadPath = options.preloadPath || path.join(__dirname, "web-contents-view-preload.js");
    this.requestTimeout = options.requestTimeout || 30_000;
    this.downloadRequestTimeout = options.downloadRequestTimeout || 5 * 60_000;
    this.records = new Map();
    this.recordsByWebContentsId = new Map();
    this.sessionStates = new Map();
    this.permissionDecisions = new Map();
    this.destroyed = false;
  }

  dispatch(event, owner, action, ...args) {
    if (this.destroyed) throw new Error("WebContentsView manager has been destroyed");
    if (!isMainFrameSender(event, owner)) {
      throw new Error("WebContentsView IPC is restricted to the owning main frame");
    }

    if (action === "create") return this.create(owner, args[0]);
    assertString(args[0], "id");
    const record = this.getOwnedRecord(owner, args[0]);
    const rest = args.slice(1);

    switch (action) {
      case "destroy":
        this.destroyRecord(record);
        return null;
      case "layout":
        return this.layout(record, rest[0]);
      case "setVisible":
        return this.setVisible(record, rest[0]);
      case "focus":
        record.contents.focus();
        return null;
      case "blur":
        record.owner.browserWindow.webContents.focus();
        return null;
      case "loadURL":
        return this.loadURL(record, rest[0]);
      case "goBack":
        return this.navigateHistory(record, "goBack");
      case "goForward":
        return this.navigateHistory(record, "goForward");
      case "reload":
        record.contents.reload();
        return null;
      case "reloadIgnoringCache":
        record.contents.reloadIgnoringCache();
        return null;
      case "stop":
        record.contents.stop();
        return null;
      case "findInPage":
        return this.findInPage(record, rest[0]);
      case "stopFindInPage":
        record.contents.stopFindInPage(rest[0] || "clearSelection");
        return null;
      case "setZoomFactor":
        return this.setZoomFactor(record, rest[0]);
      case "setUserAgent":
        record.contents.setUserAgent(validateUserAgent(rest[0]));
        return null;
      case "print":
        return this.print(record, rest[0]);
      case "capturePage":
        return this.capturePage(record, rest[0]);
      case "openDevTools":
        return this.openDevTools(record, rest[0]);
      case "closeDevTools":
        record.contents.closeDevTools();
        return null;
      case "copy":
      case "cut":
      case "paste":
      case "undo":
      case "redo":
      case "selectAll":
        record.contents[action]();
        return null;
      case "replaceMisspelling":
        assertString(rest[0], "word");
        record.contents.replaceMisspelling(rest[0]);
        return null;
      case "addWordToDictionary":
        return this.addWordToDictionary(record, rest[0]);
      case "inspectElement":
        return this.inspectElement(record, rest[0]);
      case "setDeviceEmulation":
        return this.setDeviceEmulation(record, rest[0]);
      case "clearDeviceEmulation":
        return this.clearDeviceEmulation(record);
      case "permissionResponse":
      case "downloadResponse":
      case "authResponse":
      case "deviceResponse":
      case "contextMenuResponse":
      case "popupResponse":
        return this.resolveRequest(record, action, rest[0]);
      case "clearBrowsingData":
        return this.clearBrowsingData(record, rest[0]);
      case "getSessionState":
        return { persistent: record.profile.persistent, profileId: record.profile.id };
      case "setPermissionDecision":
        return this.setPermissionDecision(record, rest[0]);
      case "cancelDownload":
        return this.cancelDownload(record, rest[0]);
      default:
        throw new Error(`Unknown WebContentsView action: ${action}`);
    }
  }

  create(owner, options = {}) {
    assertObject(options, "options");
    const profile = validateProfile(options.profile);
    if (options.userAgent != null) validateUserAgent(options.userAgent);
    const partition = partitionForProfile(profile);
    const session = this.electron.session.fromPartition(partition);
    const record = this.createRecord(owner, profile, session);
    if (options.userAgent) record.contents.setUserAgent(options.userAgent);
    return { id: record.id, state: this.snapshot(record) };
  }

  createRecord(owner, profile, session) {
    const view = new this.electron.WebContentsView({
      webPreferences: secureWebPreferences(session, this.preloadPath),
    });
    const record = {
      id: crypto.randomUUID(),
      owner,
      profile,
      partition: session.getPartition?.() || partitionForProfile(profile),
      session,
      view,
      contents: view.webContents,
      attached: false,
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      favicon: null,
      hoverUrl: "",
      error: null,
      lastUserGestureAt: 0,
      listeners: [],
      pending: new Map(),
      operations: new Set(),
      downloads: new Map(),
      activeBluetoothRequest: null,
      deviceEmulation: null,
      emulationPromise: Promise.resolve(),
      destroyed: false,
    };
    this.records.set(record.id, record);
    this.recordsByWebContentsId.set(record.contents.id, record);
    this.installSessionHandlers(record.session);
    this.installRecordHandlers(record);
    return record;
  }

  getOwnedRecord(owner, id) {
    const record = this.records.get(id);
    if (!record || record.destroyed) throw new Error("Unknown WebContentsView handle");
    if (record.owner !== owner) throw new Error("WebContentsView handle belongs to another window");
    return record;
  }

  ownsFocusedContents(owner) {
    const focused = this.electron.webContents.getFocusedWebContents();
    if (!focused) return false;
    return this.recordsByWebContentsId.get(focused.id)?.owner === owner;
  }

  performFocusedAction(owner, action) {
    if (!EDIT_ACTIONS.has(action)) throw new Error(`Unsupported focused action: ${action}`);
    const focused = this.electron.webContents.getFocusedWebContents();
    const record = focused ? this.recordsByWebContentsId.get(focused.id) : null;
    if (!record || record.owner !== owner || record.destroyed) return false;
    record.contents[action]();
    return true;
  }

  handleShortcut(event, detail) {
    const record = this.recordsByWebContentsId.get(event.sender.id);
    if (!record || record.destroyed || !sameFrame(event.senderFrame, event.sender.mainFrame))
      return;
    if (!detail || typeof detail !== "object") return;
    const safeDetail = {
      type: detail.type === "keyup" ? "keyup" : "keydown",
      key: String(detail.key || "").slice(0, 64),
      code: String(detail.code || "").slice(0, 64),
      altKey: Boolean(detail.altKey),
      ctrlKey: Boolean(detail.ctrlKey),
      metaKey: Boolean(detail.metaKey),
      shiftKey: Boolean(detail.shiftKey),
      repeat: Boolean(detail.repeat),
    };
    this.emit(record, "shortcut", safeDetail);
  }

  layout(record, options = {}) {
    assertObject(options, "layout");
    const bounds = sanitizeBounds(options.bounds, record.owner);
    record.bounds = bounds;
    if (!record.attached) {
      record.owner.browserWindow.contentView.addChildView(record.view);
      record.attached = true;
    }
    record.view.setBounds(bounds);
    const visible = options.visible !== false && bounds.width > 0 && bounds.height > 0;
    this.setVisible(record, visible);
    return this.snapshot(record);
  }

  setVisible(record, visible) {
    if (typeof visible !== "boolean") throw new TypeError("visible must be a boolean");
    record.visible = visible && record.bounds.width > 0 && record.bounds.height > 0;
    record.view.setVisible(record.visible);
    this.emitState(record);
    return record.visible;
  }

  async loadURL(record, payload) {
    const options = typeof payload === "string" ? { url: payload } : payload;
    assertObject(options, "navigation");
    const target = validateURL(options.url);
    record.error = null;
    const loadOptions = {};
    const referrer = options.options?.httpReferrer || options.options?.referrer;
    if (typeof referrer === "string") {
      loadOptions.httpReferrer = referrer;
    }
    await record.contents.loadURL(target, loadOptions);
    return this.snapshot(record);
  }

  navigateHistory(record, action) {
    const history = record.contents.navigationHistory;
    if (typeof history?.[action] === "function") history[action]();
    else record.contents[action]();
    return null;
  }

  findInPage(record, payload) {
    assertObject(payload, "find");
    assertString(payload.text, "text");
    return record.contents.findInPage(payload.text, payload.options || {});
  }

  setZoomFactor(record, factor) {
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) {
      throw new RangeError("zoom factor must be between 0.25 and 5");
    }
    record.contents.setZoomFactor(factor);
    this.emitState(record);
    return factor;
  }

  print(record, options = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (success, failureReason) => {
        if (settled) return;
        settled = true;
        record.operations.delete(cancel);
        resolve({ success, failureReason: failureReason || null });
      };
      const cancel = () => finish(false, "Web contents view was destroyed");
      record.operations.add(cancel);
      try {
        record.contents.print(options || {}, finish);
      } catch (error) {
        finish(false, error.message);
      }
    });
  }

  async capturePage(record, rect) {
    const image = await record.contents.capturePage(rect || undefined);
    return image.toDataURL();
  }

  addWordToDictionary(record, word) {
    assertString(word, "word");
    if (!record.profile.persistent) return false;
    return record.session.addWordToSpellCheckerDictionary(word);
  }

  setPermissionDecision(record, payload) {
    assertObject(payload, "permission decision");
    assertString(payload.origin, "origin");
    assertString(payload.permission, "permission");
    const isDevicePermission =
      /^device:(?:hid|serial|usb):/.test(payload.permission) &&
      payload.permission.length <= 512 &&
      !payload.permission.includes("\0");
    if (!SUPPORTED_PERMISSIONS.has(payload.permission) && !isDevicePermission) {
      throw new TypeError("permission is not supported");
    }
    if (payload.allow !== null && typeof payload.allow !== "boolean") {
      throw new TypeError("allow must be a boolean or null");
    }
    const origin = safeOrigin(payload.origin);
    if (origin === "null" && payload.origin !== "null") throw new TypeError("origin is invalid");
    const keys =
      payload.permission === "media" ? ["media:audio", "media:video"] : [payload.permission];
    for (const permission of keys) {
      const key = `${record.partition}\0${origin}\0${permission}`;
      if (payload.allow === null) this.permissionDecisions.delete(key);
      else this.permissionDecisions.set(key, payload.allow);
    }
    return null;
  }

  cancelDownload(record, requestId) {
    assertString(requestId, "requestId");
    const item = record.downloads.get(requestId);
    if (!item) return false;
    record.downloads.delete(requestId);
    item.cancel();
    return true;
  }

  inspectElement(record, point) {
    assertObject(point, "point");
    record.contents.openDevTools({ mode: "detach" });
    record.contents.inspectElement(integer(point.x), integer(point.y));
    return null;
  }

  openDevTools(record, options = {}) {
    assertObject(options, "options");
    const safeOptions = { mode: "detach" };
    if (typeof options.activate === "boolean") safeOptions.activate = options.activate;
    if (typeof options.title === "string") safeOptions.title = options.title.slice(0, 200);
    record.contents.openDevTools(safeOptions);
    return null;
  }

  deviceEmulationParameters(options) {
    assertObject(options, "options");
    const sourceScreenSize = options.screenSize || {};
    const sourceViewSize = options.viewSize || {};
    const width = Math.max(
      1,
      integer(options.width ?? sourceViewSize.width ?? sourceScreenSize.width, 1),
    );
    const height = Math.max(
      1,
      integer(options.height ?? sourceViewSize.height ?? sourceScreenSize.height, 1),
    );
    const scale = Number.isFinite(options.scale) ? Math.max(0.01, Math.min(10, options.scale)) : 1;
    const deviceScaleFactor = Number.isFinite(options.deviceScaleFactor)
      ? Math.max(0, Math.min(10, options.deviceScaleFactor))
      : 1;
    const mobile = options.mobile === true || options.screenPosition === "mobile";
    return {
      screenPosition: mobile ? "mobile" : "desktop",
      screenSize: { width, height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor,
      viewSize: { width, height },
      scale,
    };
  }

  setDeviceEmulation(record, options) {
    const parameters = this.deviceEmulationParameters(options);
    const firstMobileApplication =
      parameters.screenPosition === "mobile" && !record.deviceEmulation;
    record.deviceEmulation = { parameters, touch: options.touch === true };
    if (firstMobileApplication) {
      record.contents.enableDeviceEmulation({ ...parameters, screenPosition: "desktop" });
    }
    record.contents.enableDeviceEmulation(parameters);
    return this.queueTouchEmulation(record, record.deviceEmulation.touch);
  }

  clearDeviceEmulation(record) {
    record.deviceEmulation = null;
    record.contents.disableDeviceEmulation();
    return this.queueTouchEmulation(record, false);
  }

  reapplyDeviceEmulation(record) {
    if (!record.deviceEmulation || record.destroyed) return Promise.resolve();
    const { parameters, touch } = record.deviceEmulation;
    record.contents.enableDeviceEmulation(parameters);
    return this.queueTouchEmulation(record, touch);
  }

  queueTouchEmulation(record, enabled) {
    record.emulationPromise = record.emulationPromise
      .catch(() => {})
      .then(() => this.applyTouchEmulation(record, enabled));
    return record.emulationPromise;
  }

  async applyTouchEmulation(record, enabled) {
    if (record.destroyed || record.contents.isDestroyed?.()) return;
    const client = record.contents.debugger;
    if (!client?.attach || !client?.sendCommand) return;
    let attachedHere = false;
    try {
      if (!client.isAttached?.()) {
        client.attach("1.3");
        attachedHere = true;
      }
      await client.sendCommand("Emulation.setTouchEmulationEnabled", {
        enabled,
        maxTouchPoints: enabled ? 5 : 1,
      });
      await client.sendCommand("Emulation.setEmulatedMedia", {
        features: enabled ? [{ name: "pointer", value: "coarse" }] : [],
      });
      await client.sendCommand("Emulation.setEmitTouchEventsForMouse", {
        enabled,
        configuration: "mobile",
      });
    } catch (error) {
      console.warn("Unable to apply touch emulation", error);
    } finally {
      if (attachedHere && client.isAttached?.()) {
        try {
          client.detach();
        } catch (error) {
          console.warn("Unable to detach touch emulation debugger", error);
        }
      }
    }
  }

  async clearBrowsingData(record, options = {}) {
    assertObject(options, "options");
    const { permissions, ...sessionOptions } = options;
    if (permissions === true) this.clearPermissionDecisions(record.partition);
    if (Object.keys(sessionOptions).length === 0) return null;
    if (typeof record.session.clearData === "function") {
      await record.session.clearData(sessionOptions);
      return null;
    }
    if (sessionOptions.cache) await record.session.clearCache();
    await record.session.clearStorageData(sessionOptions.storageData || {});
    return null;
  }

  installRecordHandlers(record) {
    const on = (event, listener) => {
      record.contents.on(event, listener);
      record.listeners.push([event, listener]);
    };
    const emitState = () => this.emitState(record);
    on("destroyed", () => {
      if (record.destroyed) return;
      try {
        this.emit(record, "destroyed", { reason: "guest-closed" });
      } finally {
        this.destroyRecord(record, { contentsAlreadyDestroyed: true });
      }
    });
    on("did-start-loading", () => {
      record.error = null;
      emitState();
    });
    for (const event of [
      "did-stop-loading",
      "did-navigate-in-page",
      "page-title-updated",
      "focus",
      "blur",
    ]) {
      on(event, emitState);
    }
    on("did-navigate", () => {
      void this.reapplyDeviceEmulation(record);
      emitState();
    });
    on("page-favicon-updated", (_event, favicons) => {
      record.favicon = Array.isArray(favicons) ? favicons[0] || null : null;
      emitState();
    });
    on("update-target-url", (_event, targetURL) => {
      record.hoverUrl = targetURL || "";
      emitState();
    });
    on("found-in-page", (_event, result) => this.emit(record, "find-result", result));
    on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      record.error = { code, description, url: validatedURL };
      emitState();
    });
    on("render-process-gone", (_event, details) => {
      record.error = { code: "RENDER_PROCESS_GONE", description: details.reason };
      this.emit(record, "crashed", { reason: details.reason, exitCode: details.exitCode });
      emitState();
    });
    const validateNavigation = (event, legacyTargetURL, isMainFrame = event.isMainFrame) => {
      const targetURL = typeof event.url === "string" ? event.url : legacyTargetURL;
      try {
        validateURL(targetURL);
      } catch {
        event.preventDefault();
        this.emit(record, "external-protocol", {
          url: targetURL,
          isMainFrame: isMainFrame !== false,
        });
      }
    };
    on("will-frame-navigate", validateNavigation);
    on("will-redirect", (event, targetURL, _isInPlace, legacyIsMainFrame) => {
      const isMainFrame =
        typeof event.isMainFrame === "boolean" ? event.isMainFrame : legacyIsMainFrame;
      validateNavigation(event, targetURL, isMainFrame);
    });
    on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && !input.isAutoRepeat) record.lastUserGestureAt = Date.now();
    });
    on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown") record.lastUserGestureAt = Date.now();
    });
    on("context-menu", (event, params) => {
      event.preventDefault();
      this.createRequest(
        record,
        "context-menu",
        this.contextMenuDetail(params),
        (response) => this.applyContextAction(record, response),
        () => {},
        "contextMenuResponse",
      );
    });
    on("login", (event, responseDetails, authInfo, callback) => {
      event.preventDefault();
      this.createRequest(
        record,
        "authentication",
        {
          url: responseDetails.url,
          isProxy: Boolean(authInfo.isProxy),
          scheme: authInfo.scheme,
          host: authInfo.host,
          port: authInfo.port,
          realm: authInfo.realm,
        },
        (response) => {
          if (response?.username != null && response?.password != null) {
            callback(String(response.username), String(response.password));
          } else callback();
        },
        () => callback(),
        "authResponse",
      );
    });
    record.contents.setWindowOpenHandler((details) => this.handleWindowOpen(record, details));
    for (const event of ["select-bluetooth-device"]) {
      on(event, (nativeEvent, devices, callback) => {
        nativeEvent.preventDefault();
        if (record.activeBluetoothRequest) {
          record.activeBluetoothRequest.update(devices);
          record.activeBluetoothRequest.setCallback(callback);
          return;
        }
        record.activeBluetoothRequest = this.createDeviceRequest(
          record,
          "bluetooth",
          devices,
          callback,
          "",
          safeOrigin(record.contents.getURL()),
          {
            onCleanup: () => {
              record.activeBluetoothRequest = null;
            },
          },
        );
      });
    }
  }

  handleWindowOpen(record, details) {
    let target;
    try {
      target = validateURL(details.url);
    } catch {
      this.emit(record, "external-protocol", { url: details.url });
      return { action: "deny" };
    }
    const userGesture = Date.now() - record.lastUserGestureAt <= 1_500;
    if (!userGesture) {
      this.emit(record, "popup-blocked", { url: target, disposition: details.disposition });
      return { action: "deny" };
    }
    record.lastUserGestureAt = 0;
    return {
      action: "allow",
      createWindow: () => {
        const child = this.createRecord(record.owner, record.profile, record.session);
        const parentUserAgent = record.contents.getUserAgent?.();
        if (typeof parentUserAgent === "string" && parentUserAgent.length > 0) {
          child.contents.setUserAgent(parentUserAgent);
        }
        this.createRequest(
          record,
          "popup",
          {
            surface: { id: child.id, state: this.snapshot(child) },
            url: target,
            disposition: details.disposition,
            frameName: details.frameName,
          },
          (response) => {
            const decision = response?.action || response?.decision;
            if (response === false || response?.accept === false || decision === "block") {
              this.destroyRecord(child);
            }
          },
          () => this.destroyRecord(child),
          "popupResponse",
        );
        return child.contents;
      },
    };
  }

  installSessionHandlers(session) {
    const partition = session.getPartition?.() || String(session);
    if (this.sessionStates.has(partition)) return;
    const state = { session, listeners: [] };
    this.sessionStates.set(partition, state);
    session.setPermissionCheckHandler((contents, permission, origin, details = {}) => {
      if (!contents || !this.recordsByWebContentsId.has(contents.id)) return false;
      const requestOrigin = safeOrigin(details.securityOrigin || origin);
      return permissionKeys(permission, details).every(
        (key) => this.permissionDecisions.get(`${partition}\0${requestOrigin}\0${key}`) === true,
      );
    });
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const record = this.recordsByWebContentsId.get(contents.id);
      if (!record) return callback(false);
      if (!SUPPORTED_PERMISSIONS.has(permission)) return callback(false);
      const origin = safeOrigin(
        details.securityOrigin || details.requestingUrl || contents.getURL(),
      );
      const keys = permissionKeys(permission, details);
      const decisions = keys.map((key) =>
        this.permissionDecisions.get(`${partition}\0${origin}\0${key}`),
      );
      if (decisions.some((decision) => decision === false)) return callback(false);
      if (decisions.every((decision) => decision === true)) return callback(true);
      const undecidedKeys = keys.filter((_key, index) => decisions[index] === undefined);
      this.createRequest(
        record,
        "permission",
        {
          permission,
          permissionKeys: undecidedKeys,
          origin,
          details: this.permissionDetail(details),
        },
        (response) => {
          const decision = response?.action || response?.decision;
          const allow =
            response === true ||
            response?.allow === true ||
            decision === "allow" ||
            decision === "allow-once" ||
            decision === "always-allow";
          const remember = response?.remember === true || decision === "always-allow";
          if (remember) {
            for (const key of undecidedKeys) {
              this.permissionDecisions.set(`${partition}\0${origin}\0${key}`, allow);
            }
          }
          callback(allow);
        },
        () => callback(false),
        "permissionResponse",
      );
    });
    session.setDevicePermissionHandler((details) => {
      const origin = safeOrigin(details.origin);
      if (origin === "null") return false;
      const key = `${partition}\0${origin}\0device:${details.deviceType}:${
        details.device.deviceId || details.device.portId || ""
      }`;
      return this.permissionDecisions.get(key) === true;
    });
    this.onSession(state, "will-download", (_event, item, contents) => {
      const cancel = () => {
        try {
          item.cancel();
        } catch {
          // A malformed or already-completed download must still fail closed.
        }
      };
      const record = this.recordsByWebContentsId.get(contents?.id);
      if (!record) return cancel();
      item.pause();
      const detail = {
        url: item.getURL(),
        filename: path.basename(item.getFilename()),
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
      };
      this.createRequest(
        record,
        "download-started",
        detail,
        (response, requestId) => {
          const destination = response?.path;
          if (typeof destination !== "string" || !path.isAbsolute(destination)) {
            return cancel();
          }
          const onUpdated = (_updateEvent, stateName) => {
            this.emit(record, "download-updated", {
              requestId,
              state: stateName,
              receivedBytes: item.getReceivedBytes(),
              totalBytes: item.getTotalBytes(),
            });
          };
          const onDone = (_doneEvent, stateName) => {
            record.downloads.delete(requestId);
            this.emit(record, "download-finished", {
              requestId,
              state: stateName,
              path: item.getSavePath(),
            });
          };
          try {
            item.setSavePath(destination);
            item.on("updated", onUpdated);
            item.once("done", onDone);
            record.downloads.set(requestId, item);
            item.resume();
          } catch {
            record.downloads.delete(requestId);
            try {
              item.removeListener?.("updated", onUpdated);
              item.removeListener?.("done", onDone);
            } catch {
              // Listener cleanup failure must not bypass download cancellation.
            }
            cancel();
          }
        },
        cancel,
        "downloadResponse",
        this.downloadRequestTimeout,
      );
    });
    this.onSession(state, "select-hid-device", (event, details, callback) => {
      event.preventDefault();
      const record = this.recordForFrame(details.frame);
      if (!record) return callback();
      this.createDeviceRequest(
        record,
        "hid",
        details.deviceList,
        callback,
        null,
        safeOrigin(details.frame?.url || record.contents.getURL()),
        { frame: details.frame },
      );
    });
    this.onSession(state, "select-usb-device", (event, details, callback) => {
      event.preventDefault();
      const record = this.recordForFrame(details.frame);
      if (!record) return callback();
      this.createDeviceRequest(
        record,
        "usb",
        details.deviceList,
        callback,
        undefined,
        safeOrigin(details.frame?.url || record.contents.getURL()),
        { contents: record.contents },
      );
    });
    this.onSession(state, "select-serial-port", (event, ports, contents, callback) => {
      event.preventDefault();
      const record = this.recordsByWebContentsId.get(contents?.id);
      if (!record) return callback("");
      this.createDeviceRequest(
        record,
        "serial",
        ports,
        callback,
        "",
        safeOrigin(record.contents.getURL()),
        { contents: record.contents },
      );
    });
    for (const [eventName, deviceType, property] of [
      ["hid-device-revoked", "hid", "device"],
      ["serial-port-revoked", "serial", "port"],
      ["usb-device-revoked", "usb", "device"],
    ]) {
      this.onSession(state, eventName, (_event, details = {}) => {
        const device = sanitizeDevice(details[property] || {});
        if (!device.deviceId) return;
        const origin = safeOrigin(details.origin);
        const permission = `device:${deviceType}:${device.deviceId}`;
        const suffix = `\0${permission}`;
        for (const key of [...this.permissionDecisions.keys()]) {
          if (!key.startsWith(`${partition}\0`) || !key.endsWith(suffix)) continue;
          if (origin !== "null" && key !== `${partition}\0${origin}\0${permission}`) continue;
          this.permissionDecisions.delete(key);
        }
        for (const record of this.records.values()) {
          if (record.partition !== partition) continue;
          this.emit(record, "device-revoked", {
            origin,
            deviceType,
            deviceId: device.deviceId,
            permission,
          });
        }
      });
    }
  }

  onSession(state, event, listener) {
    state.session.on(event, listener);
    state.listeners.push([event, listener]);
  }

  releaseSessionIfUnused(record) {
    if (record.profile.persistent) return;
    if ([...this.records.values()].some((candidate) => candidate.partition === record.partition)) {
      return;
    }
    const state = this.sessionStates.get(record.partition);
    if (!state) return;
    state.session.setPermissionCheckHandler(null);
    state.session.setPermissionRequestHandler(null);
    state.session.setDevicePermissionHandler(null);
    for (const [event, listener] of state.listeners) state.session.removeListener(event, listener);
    this.sessionStates.delete(record.partition);
    this.clearPermissionDecisions(record.partition);
  }

  clearPermissionDecisions(partition) {
    const prefix = `${partition}\0`;
    for (const key of this.permissionDecisions.keys()) {
      if (key.startsWith(prefix)) this.permissionDecisions.delete(key);
    }
  }

  recordForFrame(frame) {
    if (!frame) return null;
    const top = frame.top || frame;
    for (const record of this.records.values()) {
      const candidate = record.contents.mainFrame;
      if (
        candidate === top ||
        (candidate?.processId === top.processId && candidate?.routingId === top.routingId)
      ) {
        return record;
      }
    }
    return null;
  }

  createDeviceRequest(
    record,
    deviceType,
    devices,
    callback,
    cancelValue,
    origin = safeOrigin(record.contents.getURL()),
    context = {},
  ) {
    let currentCallback = callback;
    const devicesById = new Map();
    const replaceDevices = (nextDevices) => {
      devicesById.clear();
      for (const device of Array.from(nextDevices || [], sanitizeDevice)) {
        if (device.deviceId) devicesById.set(device.deviceId, device);
      }
    };
    replaceDevices(devices);
    let requestId;
    const update = (nextDevices) => {
      replaceDevices(nextDevices);
      if (requestId) {
        this.emit(record, "device-updated", {
          requestId,
          deviceType,
          devices: [...devicesById.values()],
        });
      }
    };
    requestId = this.createRequest(
      record,
      "device",
      { deviceType, origin, devices: [...devicesById.values()] },
      (response) => {
        const requestedId =
          (typeof response === "string" ? response : response?.deviceId) || cancelValue;
        const deviceId = devicesById.has(requestedId) ? requestedId : cancelValue;
        if (deviceId && origin !== "null") {
          this.permissionDecisions.set(
            `${record.partition}\0${origin}\0device:${deviceType}:${deviceId}`,
            true,
          );
        }
        currentCallback(deviceId);
      },
      () => currentCallback(cancelValue),
      "deviceResponse",
    );
    const listeners = [];
    const listen = (event, listener) => {
      record.session.on(event, listener);
      listeners.push([event, listener]);
    };
    const emitCurrent = () =>
      this.emit(record, "device-updated", {
        requestId,
        deviceType,
        devices: [...devicesById.values()],
      });
    const add = (device) => {
      const safe = sanitizeDevice(device || {});
      if (!safe.deviceId) return;
      devicesById.set(safe.deviceId, safe);
      emitCurrent();
    };
    const remove = (device) => {
      const safe = sanitizeDevice(device || {});
      if (safe.deviceId && devicesById.delete(safe.deviceId)) emitCurrent();
    };
    if (deviceType === "hid" && context.frame) {
      listen("hid-device-added", (_event, details) => {
        if (sameFrame(details?.frame, context.frame)) add(details.device);
      });
      listen("hid-device-removed", (_event, details) => {
        if (sameFrame(details?.frame, context.frame)) remove(details.device);
      });
    } else if (deviceType === "usb" && context.contents) {
      listen("usb-device-added", (_event, device, contents) => {
        if (contents?.id === context.contents.id) add(device);
      });
      listen("usb-device-removed", (_event, device, contents) => {
        if (contents?.id === context.contents.id) remove(device);
      });
    } else if (deviceType === "serial" && context.contents) {
      listen("serial-port-added", (_event, device, contents) => {
        if (contents?.id === context.contents.id) add(device);
      });
      listen("serial-port-removed", (_event, device, contents) => {
        if (contents?.id === context.contents.id) remove(device);
      });
    }
    const pending = record.pending.get(requestId);
    let cleaned = false;
    pending.cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const [event, listener] of listeners) record.session.removeListener(event, listener);
      context.onCleanup?.();
    };
    return {
      requestId,
      update,
      setCallback(nextCallback) {
        currentCallback = nextCallback;
      },
    };
  }

  createRequest(
    record,
    type,
    detail,
    accept,
    reject,
    responseAction,
    timeoutMs = this.requestTimeout,
  ) {
    const requestId = crypto.randomUUID();
    const pending = {
      responseAction,
      accept,
      reject,
      timer: setTimeout(() => {
        record.pending.delete(requestId);
        pending.cleanup?.();
        try {
          reject();
        } catch {
          // A request target may disappear before its timeout fires.
        } finally {
          this.emit(record, "request-expired", { requestId, type });
        }
      }, timeoutMs),
    };
    pending.timer.unref?.();
    record.pending.set(requestId, pending);
    this.emit(record, type, { requestId, ...detail });
    return requestId;
  }

  resolveRequest(record, responseAction, payload) {
    assertObject(payload, "response");
    assertString(payload.requestId, "requestId");
    const pending = record.pending.get(payload.requestId);
    if (!pending || pending.responseAction !== responseAction) return false;
    record.pending.delete(payload.requestId);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    try {
      pending.accept(payload.response, payload.requestId);
      return true;
    } catch {
      try {
        pending.reject();
      } catch {
        // A destroyed frame may reject both the primary and fallback callbacks.
      }
      return false;
    }
  }

  contextMenuDetail(params) {
    return {
      x: params.x,
      y: params.y,
      linkURL: params.linkURL || "",
      srcURL: params.srcURL || "",
      pageURL: params.pageURL || "",
      frameURL: params.frameURL || "",
      selectionText: params.selectionText || "",
      misspelledWord: params.misspelledWord || "",
      dictionarySuggestions: params.dictionarySuggestions || [],
      mediaType: params.mediaType,
      isEditable: Boolean(params.isEditable),
      editFlags: { ...params.editFlags },
    };
  }

  permissionDetail(details) {
    return {
      requestingUrl: details.requestingUrl || "",
      isMainFrame: Boolean(details.isMainFrame),
      mediaTypes: Array.isArray(details.mediaTypes) ? details.mediaTypes : [],
    };
  }

  applyContextAction(record, response) {
    if (!response || typeof response.action !== "string") return;
    const action = response.action;
    if (CONTEXT_ACTIONS.has(action)) {
      if (EDIT_ACTIONS.has(action)) record.contents[action]();
      else if (action === "back" || action === "forward") {
        this.navigateHistory(record, action === "back" ? "goBack" : "goForward");
      } else if (action === "print") void this.print(record);
      else record.contents[action]();
      return;
    }
    if (action === "inspect") this.inspectElement(record, response);
    if (action === "replaceMisspelling" && typeof response.word === "string") {
      record.contents.replaceMisspelling(response.word);
    }
    if (
      action === "addWordToDictionary" &&
      record.profile.persistent &&
      typeof response.word === "string"
    ) {
      record.session.addWordToSpellCheckerDictionary(response.word);
    }
  }

  snapshot(record) {
    const contents = record.contents;
    const history = contents.navigationHistory;
    return {
      url: contents.getURL?.() || "",
      title: contents.getTitle?.() || "",
      favicon: record.favicon,
      loading: Boolean(contents.isLoading?.()),
      canGoBack: Boolean(history?.canGoBack?.() ?? contents.canGoBack?.()),
      canGoForward: Boolean(history?.canGoForward?.() ?? contents.canGoForward?.()),
      zoomFactor: contents.getZoomFactor?.() || 1,
      focused: this.electron.webContents.getFocusedWebContents?.()?.id === contents.id,
      visible: record.visible,
      hoverUrl: record.hoverUrl,
      error: record.error,
    };
  }

  emitState(record) {
    if (!record.destroyed) this.emit(record, "state", this.snapshot(record));
  }

  emit(record, type, detail) {
    if (record.destroyed) return false;
    return record.owner.sendToRenderer(EVENT_CHANNEL, { id: record.id, type, detail });
  }

  destroyOwner(owner) {
    for (const record of [...this.records.values()]) {
      if (record.owner === owner) this.destroyRecord(record);
    }
  }

  destroyRecord(record, { contentsAlreadyDestroyed = false } = {}) {
    if (!record || record.destroyed) return;
    record.destroyed = true;
    record.visible = false;
    try {
      record.view.setVisible(false);
    } catch {
      // Native views may already have been torn down with their owner window.
    }
    if (record.attached && !record.owner.browserWindow.isDestroyed()) {
      try {
        record.owner.browserWindow.contentView.removeChildView(record.view);
      } catch {
        // Removing an already-detached native view is harmless during teardown.
      }
    }
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      try {
        pending.reject();
      } catch {
        // One failed request callback must not prevent the remaining cleanup.
      }
    }
    record.pending.clear();
    for (const cancel of record.operations) cancel();
    record.operations.clear();
    for (const item of record.downloads.values()) {
      try {
        item.cancel();
      } catch {
        // A platform download may already have completed between the event and teardown.
      }
    }
    record.downloads.clear();
    if (!contentsAlreadyDestroyed && !record.contents.isDestroyed?.()) {
      try {
        record.contents.setWindowOpenHandler?.(() => ({ action: "deny" }));
      } catch {
        // The guest may have exited between the liveness check and this call.
      }
    }
    if (!contentsAlreadyDestroyed && !record.contents.isDestroyed?.()) {
      try {
        record.contents.close({ waitForBeforeUnload: false });
      } catch {
        // The renderer may have exited between the liveness check and close().
      }
    }
    for (const [event, listener] of record.listeners) {
      try {
        record.contents.removeListener(event, listener);
      } catch {
        // A destroyed native WebContents may already have discarded its event emitter.
      }
    }
    record.listeners.length = 0;
    this.records.delete(record.id);
    this.recordsByWebContentsId.delete(record.contents.id);
    this.releaseSessionIfUnused(record);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const record of [...this.records.values()]) this.destroyRecord(record);
    for (const state of this.sessionStates.values()) {
      state.session.setPermissionCheckHandler(null);
      state.session.setPermissionRequestHandler(null);
      state.session.setDevicePermissionHandler(null);
      for (const [event, listener] of state.listeners)
        state.session.removeListener(event, listener);
    }
    this.sessionStates.clear();
    this.permissionDecisions.clear();
  }
}

module.exports = WebContentsViewManager;
Object.assign(module.exports, {
  IPC_CHANNEL,
  EVENT_CHANNEL,
  SHORTCUT_CHANNEL,
  partitionForProfile,
  secureWebPreferences,
  validateProfile,
  validateURL,
});
