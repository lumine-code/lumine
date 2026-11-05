const WindowService = require("../src/window-service");
const AuxiliaryWindowService = require("../src/auxiliary-window-service");
const { Disposable } = require("@lumine-code/event-kit");
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
        const zoomResults = {
          getZoomFactor: 1.2,
          getZoomState: { factor: 1.2, defaultFactor: 1.1 },
          zoomIn: 1.3,
          zoomOut: 1.2,
          resetZoom: 1.1,
        };
        if (action in zoomResults) return Promise.resolve(zoomResults[action]);
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
      onDidChangeZoomFactor: jasmine.createSpy("onDidChangeZoomFactor"),
      onDidChangeZoomState: jasmine.createSpy("onDidChangeZoomState"),
      setSheetOffset: jasmine.createSpy("setSheetOffset").and.returnValue(Promise.resolve()),
    };
    service = new WindowService(delegate);
  });

  afterEach(() => getWindowLoadSettings.set(bootstrapSettings));

  it("reads its id synchronously from bootstrap state", () => {
    expect(service.getId()).toBe(42);
  });

  it("exposes the unload phase synchronously without requesting native window state", () => {
    const environment = { unloading: false };
    service = new WindowService(delegate, environment);
    expect(service.isUnloading()).toBe(false);
    environment.unloading = true;
    expect(service.isUnloading()).toBe(true);
    environment.unloading = false;
    expect(service.isUnloading()).toBe(false);
    expect(delegate.invokeWindow).not.toHaveBeenCalled();
  });

  it("maps state, action, dialog, menu, download, and DevTools calls to fixed actions", async () => {
    await service.getState();
    expect(await service.getZoomFactor()).toBe(1.2);
    expect(await service.getZoomState()).toEqual({ factor: 1.2, defaultFactor: 1.1 });
    expect(await service.zoomIn()).toBe(1.3);
    expect(await service.zoomOut()).toBe(1.2);
    expect(await service.resetZoom()).toBe(1.1);
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
      ["getZoomFactor"],
      ["getZoomState"],
      ["zoomIn"],
      ["zoomOut"],
      ["resetZoom"],
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
    service.onDidChangeZoomFactor(callback);
    service.onDidChangeZoomState(callback);

    expect(delegate.onDidEnterFullScreen).toHaveBeenCalledWith(callback);
    expect(delegate.onDidLeaveFullScreen).toHaveBeenCalledWith(callback);
    expect(delegate.onDidMaximizeWindow).toHaveBeenCalledWith(callback);
    expect(delegate.onDidUnmaximizeWindow).toHaveBeenCalledWith(callback);
    expect(delegate.onDidFocusWindow).toHaveBeenCalledWith(callback);
    expect(delegate.onDidBlurWindow).toHaveBeenCalledWith(callback);
    expect(delegate.onDidChangeZoomFactor).toHaveBeenCalledWith(callback);
    expect(delegate.onDidChangeZoomState).toHaveBeenCalledWith(callback);
  });
});

describe("AuxiliaryWindowService", () => {
  let delegate, service, emit;

  beforeEach(() => {
    delegate = {
      onAuxiliaryWindowEvent: (callback) => {
        emit = callback;
        return new Disposable();
      },
      invokeAuxiliaryWindow: jasmine.createSpy("invokeAuxiliaryWindow"),
    };
    service = new AuxiliaryWindowService(delegate, { id: -17, state: {} });
  });

  afterEach(() => service.destroy());

  it("observes only its own applied zoom changes and supports disposal", () => {
    const callback = jasmine.createSpy("zoom changed");
    const subscription = service.onDidChangeZoomFactor(callback);
    emit({ id: -18, type: "did-change-zoom-factor", zoomFactor: 1.5 });
    emit({ id: -17, type: "did-change-zoom-factor", zoomFactor: 1.25 });
    expect(callback).toHaveBeenCalledOnceWith(1.25);
    subscription.dispose();
    emit({ id: -17, type: "did-change-zoom-factor", zoomFactor: 2 });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("ignores queued zoom changes after its presentation closes", () => {
    const callback = jasmine.createSpy("zoom changed");
    service.onDidChangeZoomFactor(callback);
    service.onDidChangeZoomState(callback);
    emit({ id: -17, type: "closed" });
    emit({ id: -17, type: "did-change-zoom-factor", zoomFactor: 1.25 });
    emit({ id: -17, type: "did-change-zoom-state", zoomState: { factor: 1.25, defaultFactor: 1 } });
    expect(callback).not.toHaveBeenCalled();
  });

  it("observes applied zoom state only for its own presentation and supports disposal", () => {
    const callback = jasmine.createSpy("zoom state changed");
    const subscription = service.onDidChangeZoomState(callback);
    emit({ id: -18, type: "did-change-zoom-state", zoomState: { factor: 1.5, defaultFactor: 1 } });
    emit({ id: -17, type: "did-change-zoom-state", zoomState: { factor: 1.25, defaultFactor: 1 } });
    expect(callback).toHaveBeenCalledOnceWith({ factor: 1.25, defaultFactor: 1 });
    subscription.dispose();
    emit({
      id: -17,
      type: "did-change-zoom-state",
      zoomState: { factor: 1.25, defaultFactor: 1.25 },
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("returns zoom results from its own native presentation", async () => {
    delegate.invokeAuxiliaryWindow.and.returnValues(
      Promise.resolve(1.2),
      Promise.resolve({ factor: 1.2, defaultFactor: 1.1 }),
      Promise.resolve(1.3),
      Promise.resolve(1.2),
      Promise.resolve(1.1),
    );
    expect(await service.getZoomFactor()).toBe(1.2);
    expect(await service.getZoomState()).toEqual({ factor: 1.2, defaultFactor: 1.1 });
    expect(await service.zoomIn()).toBe(1.3);
    expect(await service.zoomOut()).toBe(1.2);
    expect(await service.resetZoom()).toBe(1.1);
    expect(delegate.invokeAuxiliaryWindow.calls.allArgs()).toEqual([
      ["invoke", -17, "getZoomFactor"],
      ["invoke", -17, "getZoomState"],
      ["invoke", -17, "zoomIn"],
      ["invoke", -17, "zoomOut"],
      ["invoke", -17, "resetZoom"],
    ]);
  });

  it("ignores zoom mutations and rejects zoom reads after its own presentation closes", async () => {
    delegate.invokeAuxiliaryWindow.and.resolveTo(0.5);
    emit({ id: -18, type: "closed" });
    expect(await service.zoomIn()).toBe(0.5);
    expect(delegate.invokeAuxiliaryWindow).toHaveBeenCalledOnceWith("invoke", -17, "zoomIn");

    delegate.invokeAuxiliaryWindow.calls.reset();
    emit({ id: -17, type: "closed" });
    await expectAsync(service.zoomIn()).toBeResolved();
    await expectAsync(service.zoomOut()).toBeResolved();
    await expectAsync(service.resetZoom()).toBeResolved();
    await expectAsync(service.getZoomFactor()).toBeRejectedWith(
      jasmine.objectContaining({ code: "CLOSED_WINDOW" }),
    );
    await expectAsync(service.getZoomState()).toBeRejectedWith(
      jasmine.objectContaining({ code: "CLOSED_WINDOW" }),
    );
    expect(delegate.invokeAuxiliaryWindow).not.toHaveBeenCalled();
  });

  it("forwards selection and cancellation through its own native identity", async () => {
    const options = { title: "Open Notebook", properties: ["openFile"] };
    const selected = { canceled: false, filePaths: ["chosen.ipynb"] };
    const canceled = { canceled: true, filePaths: [] };
    delegate.invokeAuxiliaryWindow.and.returnValues(
      Promise.resolve(selected),
      Promise.resolve(canceled),
    );
    expect(await service.showOpenDialog(options)).toBe(selected);
    expect(await service.showOpenDialog()).toBe(canceled);
    expect(delegate.invokeAuxiliaryWindow.calls.allArgs()).toEqual([
      ["invoke", -17, "showOpenDialog", options],
      ["invoke", -17, "showOpenDialog", {}],
    ]);
  });

  it("rejects an open dialog after its presentation closes without sending native work", async () => {
    emit({ id: -18, type: "closed" });
    delegate.invokeAuxiliaryWindow.and.resolveTo({ canceled: true, filePaths: [] });
    await service.showOpenDialog();
    delegate.invokeAuxiliaryWindow.calls.reset();
    emit({ id: -17, type: "closed" });
    await expectAsync(service.showOpenDialog()).toBeRejectedWith(
      jasmine.objectContaining({ code: "CLOSED_WINDOW" }),
    );
    expect(delegate.invokeAuxiliaryWindow).not.toHaveBeenCalled();
  });
});
