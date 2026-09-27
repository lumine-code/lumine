const WebContentsViewHandle = require("../src/web-contents-view-handle");
const { shortcutPolicyForElement } = WebContentsViewHandle;

describe("WebContentsViewHandle", () => {
  let delegate;
  let occlusionManager;
  let handle;

  beforeEach(() => {
    delegate = {
      invokeWebContentsView: jasmine
        .createSpy("invokeWebContentsView")
        .and.returnValue(Promise.resolve()),
    };
    occlusionManager = {
      addSurface: jasmine.createSpy("addSurface"),
      removeSurface: jasmine.createSpy("removeSurface"),
      surfaceAttached: jasmine.createSpy("surfaceAttached"),
      isOccluded: jasmine.createSpy("isOccluded").and.returnValue(false),
      registerOverlay: jasmine.createSpy("registerOverlay"),
    };
    handle = new WebContentsViewHandle({
      id: "surface-1",
      state: { url: "about:blank", loading: false },
      applicationDelegate: delegate,
      occlusionManager,
    });
  });

  afterEach(async () => {
    if (!handle.destroyed) await handle.destroy();
  });

  it("maps browser operations to the fixed IPC contract", async () => {
    await handle.loadURL("https://example.test", { referrer: "https://source.test" });
    await handle.findInPage("needle", { matchCase: true });
    await handle.inspectElement(12, 34);
    await handle.respondToPermission("request-1", { action: "allow" });
    await handle.setPermissionDecision("https://example.test", "geolocation", true);
    await handle.setUserAgent("Example Browser");
    await handle.cancelDownload("download-1");
    await handle.setDeviceEmulation({ width: 390, height: 844 });
    await handle.goBack();

    expect(delegate.invokeWebContentsView.calls.allArgs()).toEqual([
      [
        "loadURL",
        "surface-1",
        { url: "https://example.test", options: { referrer: "https://source.test" } },
      ],
      ["findInPage", "surface-1", { text: "needle", options: { matchCase: true } }],
      ["inspectElement", "surface-1", { x: 12, y: 34 }],
      [
        "permissionResponse",
        "surface-1",
        { requestId: "request-1", response: { action: "allow" } },
      ],
      [
        "setPermissionDecision",
        "surface-1",
        { origin: "https://example.test", permission: "geolocation", allow: true },
      ],
      ["setUserAgent", "surface-1", "Example Browser"],
      ["cancelDownload", "surface-1", "download-1"],
      ["setDeviceEmulation", "surface-1", { width: 390, height: 844 }],
      ["goBack", "surface-1"],
    ]);
  });

  it("merges state snapshots and publishes typed events", () => {
    const states = [];
    const permissions = [];
    handle.onDidChangeState((state) => states.push(state));
    handle.onDidRequestPermission((request) => permissions.push(request));

    handle._acceptEvent({ type: "state", detail: { loading: true, title: "Example" } });
    handle._acceptEvent({ type: "permission", detail: { requestId: "request-2" } });

    expect(handle.getState()).toEqual({
      url: "about:blank",
      loading: true,
      title: "Example",
    });
    expect(states).toEqual([handle.getState()]);
    expect(permissions).toEqual([{ requestId: "request-2" }]);
  });

  it("dispatches forwarded shortcuts from the attached anchor", () => {
    const element = document.createElement("div");
    jasmine.attachToDOM(element);
    const events = [];
    element.addEventListener("keydown", (event) => {
      events.push(event);
      event.stopPropagation();
    });
    handle.attach(element);
    handle.cancelScheduledLayout();
    expect(element.hasAttribute("data-lumine-web-contents-view")).toBe(true);

    handle._acceptEvent({
      type: "shortcut",
      detail: { key: "l", code: "KeyL", ctrlKey: true },
    });
    element.addEventListener("keyup", (event) => events.push(event));
    handle._acceptEvent({
      type: "shortcut",
      detail: { type: "keyup", key: "Control", code: "ControlLeft" },
    });

    expect(events.length).toBe(2);
    expect(events[0].key).toBe("l");
    expect(events[0].code).toBe("KeyL");
    expect(events[0].ctrlKey).toBe(true);
    expect(events[1].type).toBe("keyup");
    expect(events[1].key).toBe("Control");
    handle.detach();
    expect(element.hasAttribute("data-lumine-web-contents-view")).toBe(false);
  });

  it("builds a host policy without taking page editing or ordinary typing", () => {
    const element = document.createElement("div");
    element.className = "web-browser-native-host";
    const parent = document.createElement("div");
    parent.className = "web-browser";
    parent.appendChild(element);
    const binding = (command, keystrokes, selector = "*") => ({
      command,
      keystrokes,
      selector,
      compare: () => 0,
    });
    const keymapManager = {
      getKeyBindings: jasmine
        .createSpy("getKeyBindings")
        .and.returnValue([
          binding("unset!", "f1", ".web-browser-native-host"),
          binding("command-palette:toggle", "f1", ".web-browser"),
          binding("core:copy", "ctrl-c"),
          binding("core:move-to-top", "ctrl-home"),
          binding("core:move-up", "ctrl-p"),
          binding("browser:find", "ctrl-f"),
          binding("native!", "ctrl-h"),
          binding("workspace:type", "a"),
          binding("workspace:context-menu", "shift-f10"),
          binding("workspace:chord", "ctrl-k p"),
        ]),
    };

    expect(shortcutPolicyForElement(keymapManager, element)).toEqual(["f1", "ctrl-f", "ctrl-k p"]);
    expect(keymapManager.getKeyBindings).toHaveBeenCalled();
  });

  it("clamps layout to the viewport and hides an occluded surface", async () => {
    const element = document.createElement("div");
    spyOn(element, "getBoundingClientRect").and.returnValue({
      left: -10,
      top: 20,
      right: 210,
      bottom: 120,
      width: 220,
      height: 100,
    });
    jasmine.attachToDOM(element);
    handle.attach(element);
    handle.cancelScheduledLayout();

    handle.updateLayout();
    await Promise.resolve();
    expect(delegate.invokeWebContentsView).toHaveBeenCalledWith("layout", "surface-1", {
      bounds: { x: 0, y: 20, width: 210, height: 100 },
      visible: true,
    });

    occlusionManager.isOccluded.and.returnValue(true);
    handle.updateLayout();
    await Promise.resolve();
    expect(delegate.invokeWebContentsView).toHaveBeenCalledWith("layout", "surface-1", {
      bounds: { x: 0, y: 20, width: 210, height: 100 },
      visible: false,
    });
  });

  it("hides a surface when an ancestor makes its pane item inactive", async () => {
    const parent = document.createElement("div");
    const element = document.createElement("div");
    parent.appendChild(element);
    spyOn(element, "getBoundingClientRect").and.returnValue({
      left: 10,
      top: 10,
      right: 110,
      bottom: 110,
      width: 100,
      height: 100,
    });
    jasmine.attachToDOM(parent);
    handle.attach(element);
    handle.cancelScheduledLayout();
    parent.setAttribute("aria-hidden", "true");

    handle.updateLayout();
    await Promise.resolve();

    expect(delegate.invokeWebContentsView).toHaveBeenCalledWith("blur", "surface-1");
    expect(delegate.invokeWebContentsView).toHaveBeenCalledWith("layout", "surface-1", {
      bounds: { x: 10, y: 10, width: 100, height: 100 },
      visible: false,
    });
  });

  it("destroys the native surface exactly once", async () => {
    const didDestroy = jasmine.createSpy("didDestroy");
    handle.onDidDestroy(didDestroy);
    const first = handle.destroy();
    const second = handle.destroy();
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(didDestroy).toHaveBeenCalledTimes(1);
    expect(delegate.invokeWebContentsView.calls.allArgs()).toEqual([
      ["layout", "surface-1", { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }],
      ["destroy", "surface-1"],
    ]);
    expect(occlusionManager.removeSurface).toHaveBeenCalledWith(handle);
    await expectAsync(handle.reload()).toBeRejectedWithError(
      "Cannot use a destroyed web contents view",
    );
  });

  it("cleans up a surface destroyed by main without sending destroy IPC", async () => {
    const element = document.createElement("div");
    jasmine.attachToDOM(element);
    handle.attach(element);
    handle.cancelScheduledLayout();
    delegate.invokeWebContentsView.calls.reset();
    const destroyedEvents = [];
    const didDestroy = jasmine.createSpy("didDestroy");
    handle.onDidReceiveEvent("destroyed", (detail) => destroyedEvents.push(detail));
    handle.onDidDestroy(didDestroy);

    handle._acceptEvent({ type: "destroyed", detail: { reason: "guest-closed" } });
    handle._acceptEvent({ type: "destroyed", detail: { reason: "duplicate" } });
    await handle.destroy();

    expect(handle.destroyed).toBe(true);
    expect(handle.anchorElement).toBeNull();
    expect(destroyedEvents).toEqual([{ reason: "guest-closed" }]);
    expect(didDestroy).toHaveBeenCalledTimes(1);
    expect(occlusionManager.removeSurface).toHaveBeenCalledOnceWith(handle);
    expect(delegate.invokeWebContentsView).not.toHaveBeenCalled();
  });
});
