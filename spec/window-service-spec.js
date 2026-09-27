const WindowService = require("../src/window-service");
const getWindowLoadSettings = require("../src/get-window-load-settings");

describe("WindowService", () => {
  const bootstrapSettings = getWindowLoadSettings();
  let delegate;
  let service;
  let webContentsViewEvent;

  beforeEach(() => {
    getWindowLoadSettings.set({ windowId: 42 });
    delegate = {
      invokeWindow: jasmine.createSpy("invokeWindow").and.callFake((action) => {
        if (action === "isFullScreen") return Promise.resolve(false);
        return Promise.resolve();
      }),
      broadcastToOtherWindows: jasmine
        .createSpy("broadcastToOtherWindows")
        .and.returnValue(Promise.resolve()),
      onDidReceiveWindowEvent: jasmine.createSpy("onDidReceiveWindowEvent"),
      onDidEnterFullScreen: jasmine.createSpy("onDidEnterFullScreen"),
      onDidLeaveFullScreen: jasmine.createSpy("onDidLeaveFullScreen"),
      onDidMaximizeWindow: jasmine.createSpy("onDidMaximizeWindow"),
      onDidUnmaximizeWindow: jasmine.createSpy("onDidUnmaximizeWindow"),
      onDidFocusWindow: jasmine.createSpy("onDidFocusWindow"),
      onDidBlurWindow: jasmine.createSpy("onDidBlurWindow"),
      setSheetOffset: jasmine.createSpy("setSheetOffset").and.returnValue(Promise.resolve()),
      invokeWebContentsView: jasmine
        .createSpy("invokeWebContentsView")
        .and.returnValue(Promise.resolve()),
      onDidReceiveWebContentsViewEvent: jasmine
        .createSpy("onDidReceiveWebContentsViewEvent")
        .and.callFake((callback) => {
          webContentsViewEvent = callback;
          return { dispose: jasmine.createSpy("dispose") };
        }),
    };
    service = new WindowService(delegate);
  });

  afterEach(async () => {
    await service.destroy();
    getWindowLoadSettings.set(bootstrapSettings);
  });

  it("reads its id synchronously from bootstrap state", () => {
    expect(service.getId()).toBe(42);
  });

  it("maps state, action, dialog, menu, download, and DevTools calls to fixed actions", async () => {
    await service.getState();
    await service.getSize();
    await service.setSize(800, 600);
    await service.getPosition();
    await service.setPosition(10, 20);
    await service.center();
    await service.focus();
    await service.show();
    await service.hide();
    await service.close();
    await service.reload();
    await service.minimize();
    await service.maximize();
    await service.unmaximize();
    await service.isMaximized();
    await service.isVisible();
    await service.setFullScreen(true);
    await service.toggleFullScreen();
    await service.pickFolder();
    await service.showOpenDialog({ title: "Open" });
    await service.showSaveDialog({ title: "Save" });
    await service.downloadURL("https://example.test/file");
    await service.getPrimaryDisplayWorkAreaSize();
    await service.setSheetOffset(32);
    await service.openDevTools();
    await service.closeDevTools();
    await service.toggleDevTools();
    await service.executeJavaScriptInDevTools("1 + 1");

    expect(delegate.invokeWindow.calls.allArgs()).toEqual([
      ["getState"],
      ["getSize"],
      ["setSize", 800, 600],
      ["getPosition"],
      ["setPosition", 10, 20],
      ["center"],
      ["focus"],
      ["show"],
      ["hide"],
      ["close"],
      ["reload"],
      ["minimize"],
      ["maximize"],
      ["unmaximize"],
      ["isMaximized"],
      ["isVisible"],
      ["setFullScreen", true],
      ["isFullScreen"],
      ["setFullScreen", true],
      ["pickFolder"],
      ["showOpenDialog", { title: "Open" }],
      ["showSaveDialog", { title: "Save" }],
      ["downloadURL", "https://example.test/file"],
      ["getPrimaryDisplayWorkAreaSize"],
      ["openDevTools"],
      ["closeDevTools"],
      ["toggleDevTools"],
      ["executeJavaScriptInDevTools", "1 + 1"],
    ]);
    expect(delegate.setSheetOffset).toHaveBeenCalledWith(32);
  });

  it("validates and forwards cross-window events", async () => {
    const payload = { sourceWindowId: 42, targetWindowId: 7 };
    await service.broadcast("package:item", payload);
    expect(delegate.broadcastToOtherWindows).toHaveBeenCalledWith("package:item", payload);
    await expectAsync(service.broadcast("", payload)).toBeRejectedWithError(TypeError);

    const callback = jasmine.createSpy("callback");
    service.onDidReceive("package:item", callback);
    expect(delegate.onDidReceiveWindowEvent).toHaveBeenCalledWith("package:item", callback);
    expect(() => service.onDidReceive("", callback)).toThrowError(TypeError);
  });

  it("forwards every window-state subscription", () => {
    const callback = jasmine.createSpy("callback");
    service.onDidEnterFullScreen(callback);
    service.onDidLeaveFullScreen(callback);
    service.onDidMaximize(callback);
    service.onDidUnmaximize(callback);
    service.onDidFocus(callback);
    service.onDidBlur(callback);

    expect(delegate.onDidEnterFullScreen).toHaveBeenCalledWith(callback);
    expect(delegate.onDidLeaveFullScreen).toHaveBeenCalledWith(callback);
    expect(delegate.onDidMaximizeWindow).toHaveBeenCalledWith(callback);
    expect(delegate.onDidUnmaximizeWindow).toHaveBeenCalledWith(callback);
    expect(delegate.onDidFocusWindow).toHaveBeenCalledWith(callback);
    expect(delegate.onDidBlurWindow).toHaveBeenCalledWith(callback);
  });

  it("creates renderer-safe web contents view handles and routes their events", async () => {
    delegate.invokeWebContentsView.and.callFake((action, id) => {
      if (action === "create") {
        return Promise.resolve({ id: "surface-1", state: { url: "about:blank" } });
      }
      return Promise.resolve(id);
    });

    const surface = await service.createWebContentsView({
      profile: { id: "web-browser/global", persistent: true },
    });
    const anchor = document.createElement("div");
    jasmine.attachToDOM(anchor);
    surface.attach(anchor);
    surface.cancelScheduledLayout();
    const states = [];
    surface.onDidChangeState((state) => states.push(state));
    webContentsViewEvent({
      id: "surface-1",
      type: "state",
      detail: { url: "https://example.test", title: "Example", focused: true },
    });

    expect(surface.getId()).toBe("surface-1");
    expect(states).toEqual([{ url: "https://example.test", title: "Example", focused: true }]);
    expect(service.getFocusedWebContentsViewElement()).toBe(anchor);
    expect(delegate.invokeWebContentsView.calls.argsFor(0)).toEqual([
      "create",
      { profile: { id: "web-browser/global", persistent: true } },
    ]);
    await surface.destroy();
    expect(delegate.invokeWebContentsView).toHaveBeenCalledWith("destroy", "surface-1");
  });

  it("materializes a popup's pre-created child surface", async () => {
    delegate.invokeWebContentsView.and.returnValue(
      Promise.resolve({ id: "parent", state: { url: "about:blank" } }),
    );
    const parent = await service.createWebContentsView();
    const popups = [];
    parent.onDidRequestPopup((event) => popups.push(event));

    webContentsViewEvent({
      id: "parent",
      type: "popup",
      detail: {
        surface: { id: "child", state: { url: "https://example.test/login" } },
        disposition: "foreground-tab",
      },
    });

    expect(popups[0].surface.getId()).toBe("child");
    expect(popups[0].surface.getState().url).toBe("https://example.test/login");
  });

  it("forgets a surface destroyed by main without issuing duplicate cleanup IPC", async () => {
    delegate.invokeWebContentsView.and.callFake((action) => {
      if (action === "create") {
        return Promise.resolve({
          id: "surface-1",
          state: { url: "about:blank", focused: true },
        });
      }
      return Promise.resolve();
    });
    const surface = await service.createWebContentsView();
    const anchor = document.createElement("div");
    jasmine.attachToDOM(anchor);
    surface.attach(anchor);
    surface.cancelScheduledLayout();
    expect(service.getFocusedWebContentsViewElement()).toBe(anchor);
    delegate.invokeWebContentsView.calls.reset();
    const didDestroy = jasmine.createSpy("didDestroy");
    surface.onDidDestroy(didDestroy);

    webContentsViewEvent({
      id: "surface-1",
      type: "destroyed",
      detail: { reason: "guest-closed" },
    });
    await surface.destroy();

    expect(didDestroy).toHaveBeenCalledTimes(1);
    expect(service.webContentsViews.has("surface-1")).toBe(false);
    expect(service.getFocusedWebContentsViewElement()).toBeNull();
    expect(delegate.invokeWebContentsView).not.toHaveBeenCalled();
  });
});
