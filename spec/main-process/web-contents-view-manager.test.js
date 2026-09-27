/* globals assert */

const { EventEmitter } = require("events");
const path = require("path");
const WebContentsViewManager = require("../../src/web-contents-view-manager");

describe("WebContentsViewManager", function () {
  let fakeElectron, manager, owner, event;

  beforeEach(function () {
    fakeElectron = createFakeElectron();
    manager = new WebContentsViewManager({}, { electron: fakeElectron, requestTimeout: 100 });
    owner = createOwner();
    event = { sender: owner.browserWindow.webContents };
    event.senderFrame = event.sender.mainFrame;
  });

  afterEach(function () {
    manager.destroy();
  });

  it("creates isolated views with fixed secure preferences", function () {
    const first = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
      userAgent: "Lumine Browser",
    });
    const second = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const ephemeral = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/private", persistent: false },
    });

    assert.notStrictEqual(first.id, second.id);
    assert.notStrictEqual(second.id, ephemeral.id);
    assert.strictEqual(fakeElectron.views[0].options.webPreferences.nodeIntegration, false);
    assert.strictEqual(fakeElectron.views[0].options.webPreferences.contextIsolation, true);
    assert.strictEqual(fakeElectron.views[0].options.webPreferences.sandbox, true);
    assert.strictEqual(fakeElectron.views[0].options.webPreferences.webSecurity, true);
    assert.strictEqual(fakeElectron.views[0].options.webPreferences.webviewTag, false);
    assert.strictEqual(fakeElectron.views[0].options.webPreferences.navigateOnDragDrop, false);
    assert.strictEqual(fakeElectron.views[0].options.webPreferences.safeDialogs, true);
    assert.isUndefined(fakeElectron.views[0].options.webPreferences.preload);
    assert.strictEqual(fakeElectron.views[0].webContents.userAgent, "Lumine Browser");
    assert.strictEqual(
      fakeElectron.views[0].webContents.session,
      fakeElectron.views[1].webContents.session,
    );
    assert.notStrictEqual(
      fakeElectron.views[1].webContents.session,
      fakeElectron.views[2].webContents.session,
    );
  });

  it("validates the caller, profile, handle owner, and navigation scheme", async function () {
    assert.throws(
      () =>
        manager.dispatch({ sender: event.sender, senderFrame: {} }, owner, "create", {
          profile: { id: "web-browser/global", persistent: true },
        }),
      /main frame/,
    );
    assert.throws(
      () =>
        manager.dispatch(event, owner, "create", {
          profile: { id: "../escape", persistent: true },
        }),
      /invalid/,
    );
    assert.throws(
      () =>
        manager.dispatch(event, owner, "create", {
          profile: { id: "web-browser/global", persistent: true },
          userAgent: "Browser\r\nInjected: value",
        }),
      /control characters/,
    );

    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const otherOwner = createOwner();
    const otherEvent = {
      sender: otherOwner.browserWindow.webContents,
      senderFrame: otherOwner.browserWindow.webContents.mainFrame,
    };
    assert.throws(() => manager.dispatch(otherEvent, otherOwner, "focus", id), /another window/);
    let unsafeNavigationError;
    try {
      await manager.dispatch(event, owner, "loadURL", id, { url: "javascript:alert(1)" });
    } catch (error) {
      unsafeNavigationError = error;
    }
    assert.match(unsafeNavigationError?.message, /not allowed/);
    await manager.dispatch(event, owner, "loadURL", id, { url: "https://example.test/" });
    assert.strictEqual(fakeElectron.views[0].webContents.url, "https://example.test/");
  });

  it("sanitizes device metrics and applies touch emulation without exposing CDP", async function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;

    await manager.dispatch(event, owner, "setDeviceEmulation", id, {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      scale: 0.75,
      mobile: true,
      touch: true,
      unsafeExtra: "ignored",
    });

    assert.lengthOf(contents.deviceEmulationCalls, 2);
    assert.strictEqual(contents.deviceEmulationCalls[0].screenPosition, "desktop");
    assert.deepEqual(contents.deviceEmulationCalls[1], {
      screenPosition: "mobile",
      screenSize: { width: 393, height: 852 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 3,
      viewSize: { width: 393, height: 852 },
      scale: 0.75,
    });
    assert.deepEqual(
      contents.debugger.commands.map(({ method }) => method),
      [
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setEmulatedMedia",
        "Emulation.setEmitTouchEventsForMouse",
      ],
    );
    assert.strictEqual(contents.debugger.attachCalls, 1);
    assert.strictEqual(contents.debugger.detachCalls, 1);

    contents.emit("did-navigate");
    await manager.records.get(id).emulationPromise;
    assert.lengthOf(contents.deviceEmulationCalls, 3);

    await manager.dispatch(event, owner, "clearDeviceEmulation", id);
    assert.strictEqual(contents.deviceEmulationDisabled, true);
    assert.strictEqual(contents.debugger.commands.at(-1).params.enabled, false);
  });

  it("always opens detached DevTools with sanitized options", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;

    manager.dispatch(event, owner, "openDevTools", id, {
      mode: "bottom",
      activate: false,
      title: "Inspector",
      unsafe: true,
    });

    assert.deepEqual(contents.devToolsOptions, {
      mode: "detach",
      activate: false,
      title: "Inspector",
    });
  });

  it("attaches, clamps, hides, and destroys a native child view idempotently", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    manager.dispatch(event, owner, "layout", id, {
      bounds: { x: -3, y: 10, width: 900, height: 700 },
      visible: true,
    });

    const view = fakeElectron.views[0];
    assert.deepEqual(view.bounds, { x: 0, y: 10, width: 800, height: 590 });
    assert.deepEqual(owner.browserWindow.contentView.children, [view]);
    assert.isTrue(view.visible);

    manager.dispatch(event, owner, "setVisible", id, false);
    assert.isFalse(view.visible);
    manager.dispatch(event, owner, "destroy", id);
    manager.destroyOwner(owner);
    assert.deepEqual(owner.browserWindow.contentView.children, []);
    assert.isTrue(view.webContents.destroyed);
    assert.throws(() => manager.dispatch(event, owner, "focus", id), /Unknown/);
  });

  it("emits destruction and cleans an externally destroyed native view once", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/private", persistent: false },
    });
    manager.dispatch(event, owner, "layout", id, {
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      visible: true,
    });
    const view = fakeElectron.views[0];
    const contentsId = view.webContents.id;
    view.webContents.destroyed = true;

    view.webContents.emit("destroyed");
    view.webContents.emit("destroyed");

    assert.lengthOf(
      owner.sent.filter(([, payload]) => payload.type === "destroyed"),
      1,
    );
    assert.isFalse(manager.records.has(id));
    assert.isFalse(manager.recordsByWebContentsId.has(contentsId));
    assert.deepEqual(owner.browserWindow.contentView.children, []);
    assert.strictEqual(view.webContents.closeCalls, 0);
    assert.strictEqual(manager.sessionStates.size, 0);
  });

  it("settles a pending print callback during teardown", async function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    let nativeCallback;
    contents.print = (_options, callback) => {
      nativeCallback = callback;
    };

    const resultPromise = manager.dispatch(event, owner, "print", id, {});
    manager.dispatch(event, owner, "destroy", id);
    const result = await resultPromise;
    nativeCallback(true, "");

    assert.deepEqual(result, {
      success: false,
      failureReason: "Web contents view was destroyed",
    });
  });

  it("releases handlers for an unused ephemeral session", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/private", persistent: false },
    });
    const session = fakeElectron.views[0].webContents.session;
    assert.strictEqual(manager.sessionStates.size, 1);

    manager.dispatch(event, owner, "destroy", id);

    assert.strictEqual(manager.sessionStates.size, 0);
    assert.isNull(session.permissionCheckHandler);
    assert.isNull(session.permissionRequestHandler);
    assert.isNull(session.devicePermissionHandler);
  });

  it("relays permission requests and remembers explicit decisions", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    let granted = null;
    contents.session.permissionRequestHandler(
      contents,
      "geolocation",
      (value) => {
        granted = value;
      },
      { requestingUrl: "https://example.test/map" },
    );

    const payload = owner.sent.at(-1)[1];
    assert.strictEqual(owner.sent.at(-1)[0], WebContentsViewManager.EVENT_CHANNEL);
    assert.strictEqual(payload.type, "permission");
    assert.strictEqual(payload.detail.origin, "https://example.test");
    assert.isNull(granted);

    assert.isTrue(
      manager.dispatch(event, owner, "permissionResponse", id, {
        requestId: payload.detail.requestId,
        response: { allow: true, remember: true },
      }),
    );
    assert.isTrue(granted);
    assert.isTrue(
      contents.session.permissionCheckHandler(contents, "geolocation", "https://example.test", {}),
    );

    manager.dispatch(event, owner, "setPermissionDecision", id, {
      origin: "https://example.test/path",
      permission: "geolocation",
      allow: false,
    });
    assert.isFalse(
      contents.session.permissionCheckHandler(contents, "geolocation", "https://example.test", {}),
    );
    assert.strictEqual(manager.permissionDecisions.size, 1);

    manager.dispatch(event, owner, "setPermissionDecision", id, {
      origin: "https://example.test",
      permission: "geolocation",
      allow: null,
    });
    assert.strictEqual(manager.permissionDecisions.size, 0);

    const eventCount = owner.sent.length;
    let unsupportedGranted = null;
    contents.session.permissionRequestHandler(
      contents,
      "unknown",
      (value) => {
        unsupportedGranted = value;
      },
      { requestingUrl: "https://example.test/" },
    );
    assert.isFalse(unsupportedGranted);
    assert.strictEqual(owner.sent.length, eventCount);
  });

  it("keeps persistent microphone and camera decisions separate", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    let microphone = null;
    contents.session.permissionRequestHandler(
      contents,
      "media",
      (value) => {
        microphone = value;
      },
      {
        requestingUrl: "https://example.test/call",
        securityOrigin: "https://example.test",
        mediaTypes: ["audio"],
      },
    );
    const microphoneRequest = owner.sent.at(-1)[1];
    assert.deepEqual(microphoneRequest.detail.permissionKeys, ["media:audio"]);
    manager.dispatch(event, owner, "permissionResponse", id, {
      requestId: microphoneRequest.detail.requestId,
      response: { allow: true, remember: true },
    });

    assert.isTrue(microphone);
    assert.isTrue(
      contents.session.permissionCheckHandler(contents, "media", "https://example.test", {
        mediaType: "audio",
      }),
    );
    assert.isFalse(
      contents.session.permissionCheckHandler(contents, "media", "https://example.test", {
        mediaType: "video",
      }),
    );

    let camera = null;
    contents.session.permissionRequestHandler(
      contents,
      "media",
      (value) => {
        camera = value;
      },
      {
        requestingUrl: "https://example.test/call",
        securityOrigin: "https://example.test",
        mediaTypes: ["video"],
      },
    );
    const cameraRequest = owner.sent.at(-1)[1];
    assert.deepEqual(cameraRequest.detail.permissionKeys, ["media:video"]);
    assert.isNull(camera);
    manager.dispatch(event, owner, "permissionResponse", id, {
      requestId: cameraRequest.detail.requestId,
      response: { allow: false, remember: true },
    });
    assert.isFalse(camera);
  });

  it("accepts only a device identifier that was offered to the package", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    let selected = "not-called";
    const nativeEvent = { preventDefault() {} };
    contents.session.emit(
      "select-hid-device",
      nativeEvent,
      {
        frame: contents.mainFrame,
        deviceList: [{ deviceId: "offered", name: "Offered" }],
      },
      (deviceId) => {
        selected = deviceId ?? null;
      },
    );
    const request = owner.sent.at(-1)[1];

    manager.dispatch(event, owner, "deviceResponse", id, {
      requestId: request.detail.requestId,
      response: { deviceId: "forged" },
    });

    assert.isNull(selected);
    assert.isFalse(
      [...manager.permissionDecisions.keys()].some((key) => key.endsWith("device:hid:forged")),
    );
  });

  it("keeps device pickers live and attributes subframe requests to their origin", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    const frame = {
      top: contents.mainFrame,
      url: "https://frame.example/devices",
      processId: contents.mainFrame.processId,
      routingId: contents.mainFrame.routingId + 1,
    };
    let selected = null;
    contents.session.emit(
      "select-hid-device",
      { preventDefault() {} },
      { frame, deviceList: [] },
      (deviceId) => {
        selected = deviceId;
      },
    );
    const request = owner.sent.at(-1)[1];
    assert.strictEqual(request.detail.origin, "https://frame.example");
    assert.deepEqual(request.detail.devices, []);

    contents.session.emit(
      "hid-device-added",
      {},
      {
        frame,
        device: { deviceId: "new-device", name: "New Device" },
      },
    );
    const update = owner.sent.at(-1)[1];
    assert.strictEqual(update.type, "device-updated");
    assert.strictEqual(update.detail.requestId, request.detail.requestId);
    assert.strictEqual(update.detail.devices[0].deviceId, "new-device");

    manager.dispatch(event, owner, "deviceResponse", id, {
      requestId: request.detail.requestId,
      response: { deviceId: "new-device" },
    });
    assert.strictEqual(selected, "new-device");
    assert.isTrue(
      contents.session.devicePermissionHandler({
        origin: "https://frame.example",
        deviceType: "hid",
        device: { deviceId: "new-device" },
      }),
    );
    contents.session.emit(
      "hid-device-revoked",
      {},
      {
        origin: "https://frame.example",
        device: { deviceId: "new-device", name: "New Device" },
      },
    );
    assert.strictEqual(owner.sent.at(-1)[1].type, "device-revoked");
    assert.isFalse(
      contents.session.devicePermissionHandler({
        origin: "https://frame.example",
        deviceType: "hid",
        device: { deviceId: "new-device" },
      }),
    );
    assert.strictEqual(contents.session.listenerCount("hid-device-added"), 0);
    assert.strictEqual(contents.session.listenerCount("hid-device-removed"), 0);
  });

  it("coalesces repeated Bluetooth scans into one live request", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    let firstSelection = null;
    let latestSelection = null;
    contents.emit(
      "select-bluetooth-device",
      { preventDefault() {} },
      [{ deviceId: "first", deviceName: "First" }],
      (deviceId) => {
        firstSelection = deviceId;
      },
    );
    const request = owner.sent.at(-1)[1];
    contents.emit(
      "select-bluetooth-device",
      { preventDefault() {} },
      [{ deviceId: "latest", deviceName: "Latest" }],
      (deviceId) => {
        latestSelection = deviceId;
      },
    );
    const update = owner.sent.at(-1)[1];

    assert.strictEqual(request.type, "device");
    assert.strictEqual(update.type, "device-updated");
    assert.strictEqual(update.detail.requestId, request.detail.requestId);
    manager.dispatch(event, owner, "deviceResponse", id, {
      requestId: request.detail.requestId,
      response: { deviceId: "latest" },
    });
    assert.isNull(firstSelection);
    assert.strictEqual(latestSelection, "latest");
    assert.isNull(manager.records.get(id).activeBluetoothRequest);
  });

  it("routes native edit actions only to the focused owned surface", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    let copies = 0;
    contents.copy = () => copies++;

    assert.isFalse(manager.performFocusedAction(owner, "copy"));
    manager.dispatch(event, owner, "focus", id);
    assert.isTrue(manager.performFocusedAction(owner, "copy"));
    assert.strictEqual(copies, 1);
    assert.isFalse(manager.performFocusedAction(createOwner(), "copy"));

    const input = { type: "keyDown", keyCode: "F1" };
    assert.isTrue(manager.sendInputEventForTest(owner, input));
    assert.deepEqual(contents.inputEvents, [input]);
    assert.isFalse(manager.sendInputEventForTest(createOwner(), input));
    manager.dispatch(event, owner, "blur", id);
    assert.strictEqual(owner.browserWindow.webContents.focusCalls, 1);
    assert.isFalse(manager.performFocusedAction(owner, "copy"));
    assert.isFalse(manager.sendInputEventForTest(owner, input));
  });

  it("holds downloads until an absolute destination is approved", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    const item = createDownloadItem();
    contents.session.emit("will-download", {}, item, contents, contents.mainFrame);

    assert.isTrue(item.paused);
    const started = owner.sent.at(-1)[1];
    assert.strictEqual(started.type, "download-started");
    assert.strictEqual(started.detail.filename, "report.txt");

    const destination = path.join(process.cwd(), "report.txt");
    assert.isTrue(
      manager.dispatch(event, owner, "downloadResponse", id, {
        requestId: started.detail.requestId,
        response: { path: destination },
      }),
    );
    assert.strictEqual(item.savePath, destination);
    assert.isTrue(item.resumed);

    item.emit("updated", {}, "progressing");
    item.emit("done", {}, "completed");
    const types = owner.sent.map((entry) => entry[1].type);
    assert.include(types, "download-updated");
    assert.include(types, "download-finished");

    const cancelled = createDownloadItem();
    contents.session.emit("will-download", {}, cancelled, contents, contents.mainFrame);
    const next = owner.sent.at(-1)[1];
    manager.dispatch(event, owner, "downloadResponse", id, {
      requestId: next.detail.requestId,
      response: { path: path.join(process.cwd(), "cancelled.txt") },
    });
    assert.isTrue(manager.dispatch(event, owner, "cancelDownload", id, next.detail.requestId));
    assert.isTrue(cancelled.cancelled);
  });

  it("cancels malformed or failed download approvals without throwing", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    const malformed = createDownloadItem();
    contents.session.emit("will-download", {}, malformed, contents, contents.mainFrame);
    const malformedRequest = owner.sent.at(-1)[1];

    assert.doesNotThrow(() =>
      manager.dispatch(event, owner, "downloadResponse", id, {
        requestId: malformedRequest.detail.requestId,
        response: { path: { unsafe: true } },
      }),
    );
    assert.isTrue(malformed.cancelled);

    const failed = createDownloadItem();
    failed.setSavePath = () => {
      throw new Error("destination rejected");
    };
    contents.session.emit("will-download", {}, failed, contents, contents.mainFrame);
    const failedRequest = owner.sent.at(-1)[1];

    assert.doesNotThrow(() =>
      manager.dispatch(event, owner, "downloadResponse", id, {
        requestId: failedRequest.detail.requestId,
        response: { path: path.join(process.cwd(), "failed.txt") },
      }),
    );
    assert.isTrue(failed.cancelled);
    assert.isFalse(manager.records.get(id).downloads.has(failedRequest.detail.requestId));
  });

  it("blocks unsafe navigation and redirects in every frame", function () {
    manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    const unsafeMain = {
      url: "javascript:alert(1)",
      isMainFrame: true,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    const unsafeSubframe = {
      url: "javascript:alert(1)",
      isMainFrame: false,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    const safeMain = {
      url: "https://example.test/next",
      isMainFrame: true,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    const unsafeFrameNavigation = {
      url: "data:text/html,unsafe",
      isMainFrame: false,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };

    contents.emit("will-frame-navigate", unsafeFrameNavigation);
    contents.emit("will-redirect", unsafeMain);
    contents.emit("will-redirect", unsafeSubframe);
    contents.emit("will-redirect", safeMain);

    assert.isTrue(unsafeMain.prevented);
    assert.isTrue(unsafeSubframe.prevented);
    assert.isTrue(unsafeFrameNavigation.prevented);
    assert.isFalse(safeMain.prevented);
    const externalEvents = owner.sent
      .map(([, payload]) => payload)
      .filter((payload) => payload.type === "external-protocol");
    assert.lengthOf(externalEvents, 3);
    assert.deepEqual(
      externalEvents.map((event) => event.detail.isMainFrame),
      [false, true, false],
    );
  });

  it("clears every in-memory grant for a partition without forwarding permissions", async function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const record = manager.records.get(id);
    const otherPartition = "persist:lumine-web/web-browser/workspace-other";
    manager.permissionDecisions.set(`${record.partition}\0https://example.test\0geolocation`, true);
    manager.permissionDecisions.set(
      `${record.partition}\0https://example.test\0device:usb:device-1`,
      true,
    );
    manager.permissionDecisions.set(`${otherPartition}\0https://example.test\0geolocation`, true);

    await manager.dispatch(event, owner, "clearBrowsingData", id, {
      permissions: true,
      dataTypes: ["cookies"],
    });

    assert.deepEqual(record.session.clearDataOptions, { dataTypes: ["cookies"] });
    assert.isFalse(
      [...manager.permissionDecisions.keys()].some((key) =>
        key.startsWith(`${record.partition}\0`),
      ),
    );
    assert.isTrue(
      manager.permissionDecisions.has(`${otherPartition}\0https://example.test\0geolocation`),
    );

    record.session.clearDataOptions = null;
    manager.permissionDecisions.set(`${record.partition}\0https://example.test\0usb`, true);
    await manager.dispatch(event, owner, "clearBrowsingData", id, { permissions: true });
    assert.isNull(record.session.clearDataOptions);
  });

  it("creates an owned popup surface only after a recent user gesture", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    contents.setUserAgent("Parent Browser");
    const details = {
      url: "https://example.test/popup",
      disposition: "foreground-tab",
      frameName: "child",
    };
    assert.strictEqual(contents.windowOpenHandler(details).action, "deny");

    contents.emit("before-mouse-event", {}, { type: "mouseDown" });
    const response = contents.windowOpenHandler(details);
    assert.strictEqual(response.action, "allow");
    assert.strictEqual(contents.windowOpenHandler(details).action, "deny");
    const childContents = response.createWindow({
      webPreferences: { nodeIntegration: true, allowRunningInsecureContent: true },
    });
    assert.notStrictEqual(childContents.id, contents.id);
    assert.strictEqual(childContents.userAgent, "Parent Browser");
    assert.strictEqual(fakeElectron.views[1].options.webPreferences.nodeIntegration, false);
    assert.isFalse("allowRunningInsecureContent" in fakeElectron.views[1].options.webPreferences);

    const popup = owner.sent.map((entry) => entry[1]).find((payload) => payload.type === "popup");
    assert.strictEqual(popup.id, id);
    assert.strictEqual(
      popup.detail.surface.id,
      manager.recordsByWebContentsId.get(childContents.id).id,
    );
    assert.strictEqual(popup.detail.url, details.url);
    assert.isTrue(
      manager.dispatch(event, owner, "popupResponse", id, {
        requestId: popup.detail.requestId,
        response: { accept: true },
      }),
    );
  });

  it("intercepts only shortcuts declared by the attached renderer policy", function () {
    const { id } = manager.dispatch(event, owner, "create", {
      profile: { id: "web-browser/global", persistent: true },
    });
    const contents = fakeElectron.views[0].webContents;
    manager.dispatch(event, owner, "setShortcutPolicy", id, [
      "f1",
      "ctrl-shift-p",
      "ctrl-tab ^ctrl",
    ]);
    const prevented = [];
    const emitInput = (input) => {
      contents.emit(
        "before-input-event",
        { preventDefault: () => prevented.push(input.key) },
        input,
      );
    };

    emitInput({ type: "keyDown", key: "F1", code: "F1" });
    emitInput({ type: "keyDown", key: "a", code: "KeyA" });
    emitInput({ type: "keyDown", key: "c", code: "KeyC", control: true });
    emitInput({ type: "keyDown", key: "P", code: "KeyP", control: true, shift: true });
    emitInput({ type: "keyDown", key: "З", code: "KeyP", control: true, shift: true });
    emitInput({ type: "keyDown", key: "Tab", code: "Tab", control: true });
    emitInput({ type: "keyUp", key: "Control", code: "ControlLeft" });
    emitInput({ type: "keyDown", key: "AltGraph", code: "AltRight", control: true, alt: true });

    assert.deepEqual(prevented, ["F1", "P", "З", "Tab", "Control"]);
    const shortcuts = owner.sent
      .map((entry) => entry[1])
      .filter((entry) => entry.type === "shortcut");
    assert.deepEqual(
      shortcuts.map((entry) => entry.detail.type),
      ["keydown", "keydown", "keydown", "keydown", "keyup"],
    );
  });
});

function createOwner() {
  const hostContents = new EventEmitter();
  hostContents.id = Math.floor(Math.random() * 1_000_000) + 10_000;
  hostContents.mainFrame = { processId: 1, routingId: hostContents.id, isDestroyed: () => false };
  hostContents.focusCalls = 0;
  hostContents.focus = () => hostContents.focusCalls++;
  const contentView = {
    children: [],
    addChildView(view) {
      this.children.push(view);
    },
    removeChildView(view) {
      this.children = this.children.filter((candidate) => candidate !== view);
    },
  };
  return {
    sent: [],
    browserWindow: {
      webContents: hostContents,
      contentView,
      getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      isDestroyed: () => false,
    },
    sendToRenderer(...args) {
      this.sent.push(args);
      return true;
    },
  };
}

function createFakeElectron() {
  const sessions = new Map();
  const views = [];
  let nextContentsId = 1;
  let focusedContents = null;

  class FakeSession extends EventEmitter {
    constructor(partition) {
      super();
      this.partition = partition;
    }
    getPartition() {
      return this.partition;
    }
    setPermissionCheckHandler(handler) {
      this.permissionCheckHandler = handler;
    }
    setPermissionRequestHandler(handler) {
      this.permissionRequestHandler = handler;
    }
    setDevicePermissionHandler(handler) {
      this.devicePermissionHandler = handler;
    }
    addWordToSpellCheckerDictionary() {
      return true;
    }
    clearData(options) {
      this.clearDataOptions = options;
      return Promise.resolve();
    }
  }

  class FakeContents extends EventEmitter {
    constructor(session) {
      super();
      this.id = nextContentsId++;
      this.session = session;
      this.mainFrame = { processId: 2, routingId: this.id, isDestroyed: () => false };
      this.url = "";
      this.title = "";
      this.zoomFactor = 1;
      this.loading = false;
      this.destroyed = false;
      this.closeCalls = 0;
      this.inputEvents = [];
      this.deviceEmulationCalls = [];
      this.debugger = {
        attached: false,
        attachCalls: 0,
        detachCalls: 0,
        commands: [],
        isAttached: () => this.debugger.attached,
        attach: () => {
          this.debugger.attached = true;
          this.debugger.attachCalls++;
        },
        detach: () => {
          this.debugger.attached = false;
          this.debugger.detachCalls++;
        },
        sendCommand: (method, params) => {
          this.debugger.commands.push({ method, params });
          return Promise.resolve({});
        },
      };
      this.navigationHistory = {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => {},
        goForward: () => {},
      };
    }
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    }
    setUserAgent(value) {
      this.userAgent = value;
    }
    getUserAgent() {
      return this.userAgent || "";
    }
    getURL() {
      return this.url;
    }
    getTitle() {
      return this.title;
    }
    isLoading() {
      return this.loading;
    }
    getZoomFactor() {
      return this.zoomFactor;
    }
    setZoomFactor(value) {
      this.zoomFactor = value;
    }
    loadURL(value) {
      this.url = value;
      return Promise.resolve();
    }
    focus() {
      focusedContents = this;
    }
    sendInputEvent(input) {
      this.inputEvents.push(input);
    }
    close() {
      this.closeCalls = (this.closeCalls || 0) + 1;
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    reload() {}
    reloadIgnoringCache() {}
    stop() {}
    findInPage() {
      return 1;
    }
    stopFindInPage() {}
    print(_options, callback) {
      callback(true, "");
    }
    capturePage() {
      return Promise.resolve({ toDataURL: () => "data:image/png;base64,AA==" });
    }
    openDevTools(options) {
      this.devToolsOptions = options;
    }
    closeDevTools() {}
    copy() {}
    cut() {}
    paste() {}
    undo() {}
    redo() {}
    selectAll() {}
    replaceMisspelling() {}
    inspectElement() {}
    enableDeviceEmulation(parameters) {
      this.deviceEmulationCalls.push(parameters);
    }
    disableDeviceEmulation() {
      this.deviceEmulationDisabled = true;
    }
  }

  class FakeView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeContents(options.webPreferences.session);
      this.visible = false;
      this.bounds = null;
      views.push(this);
    }
    setBounds(bounds) {
      this.bounds = bounds;
    }
    setVisible(value) {
      this.visible = value;
    }
  }

  return {
    views,
    WebContentsView: FakeView,
    session: {
      fromPartition(partition) {
        if (!sessions.has(partition)) sessions.set(partition, new FakeSession(partition));
        return sessions.get(partition);
      },
    },
    webContents: {
      getFocusedWebContents() {
        return focusedContents;
      },
    },
  };
}

function createDownloadItem() {
  const item = new EventEmitter();
  item.getURL = () => "https://example.test/report.txt";
  item.getFilename = () => "../report.txt";
  item.getMimeType = () => "text/plain";
  item.getTotalBytes = () => 100;
  item.getReceivedBytes = () => 50;
  item.getSavePath = () => item.savePath;
  item.pause = () => {
    item.paused = true;
  };
  item.resume = () => {
    item.resumed = true;
  };
  item.cancel = () => {
    item.cancelled = true;
  };
  item.setSavePath = (value) => {
    item.savePath = value;
  };
  return item;
}
