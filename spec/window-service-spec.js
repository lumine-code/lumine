const WindowService = require("../src/window-service");
const getWindowLoadSettings = require("../src/get-window-load-settings");

describe("WindowService", () => {
  const bootstrapSettings = getWindowLoadSettings();
  let delegate;
  let service;

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
    };
    service = new WindowService(delegate);
  });

  afterEach(() => getWindowLoadSettings.set(bootstrapSettings));

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
});
