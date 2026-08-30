const { Disposable } = require("@lumine-code/event-kit");
const SurfaceWindowService = require("../src/surface-window-service");

describe("SurfaceWindowService", () => {
  let delegate, events, operations;

  beforeEach(() => {
    events = null;
    operations = [];
    delegate = {
      reserveDetachedPaneWindow: jasmine.createSpy("reserve").and.resolveTo({
        transactionId: "drag-1",
        surfaceId: "surface-1",
        frameName: "surface-frame",
        url: "file:///lumine/static/detached-pane.html",
        state: "reserved",
      }),
      performDetachedPaneWindowTransaction: jasmine
        .createSpy("perform")
        .and.callFake(async (transactionId, operation, ...args) => {
          operations.push([transactionId, operation, ...args]);
          return { state: operation === "ready" ? "ready" : "open" };
        }),
      onDidReceiveDetachedPaneWindowEvent(callback) {
        events = callback;
        return new Disposable();
      },
    };
  });

  it("keeps the native window hidden behind an explicit ready/commit transaction", async () => {
    const service = await SurfaceWindowService.reserve(delegate, { transactionId: "drag-1" });
    const child = { closed: false };
    const opener = { open: jasmine.createSpy("open").and.returnValue(child) };
    expect(service.open(opener)).toBe(child);
    expect(opener.open).toHaveBeenCalledWith(
      "file:///lumine/static/detached-pane.html",
      "surface-frame",
      "frame=false,nodeIntegration=no,contextIsolation=no,webviewTag=no",
    );

    await service.ready();
    await service.commit();
    expect(operations).toEqual([
      ["drag-1", "ready"],
      ["drag-1", "commit"],
    ]);
  });

  it("demultiplexes lifecycle events by surface id", async () => {
    const service = await SurfaceWindowService.reserve(delegate);
    const closed = jasmine.createSpy("closed");
    service.onDidClose(closed);
    events("another-surface", "closed", { unexpected: true });
    expect(closed).not.toHaveBeenCalled();
    events("surface-1", "closed", { unexpected: false });
    expect(closed).toHaveBeenCalledWith({ unexpected: false });
  });

  it("exposes an idempotent programmatic attach operation", async () => {
    const service = await SurfaceWindowService.reserve(delegate);
    await service.attach();
    expect(operations).toEqual([["drag-1", "attach"]]);
    expect(service.state).toBe("closed");
  });

  it("routes surface chrome operations through its own native transaction", async () => {
    const service = await SurfaceWindowService.reserve(delegate);

    await service.focus();
    await service.minimize();
    await service.maximize();
    await service.unmaximize();
    await service.setBounds({ x: 10, y: 20, width: 900, height: 700 });
    await service.toggleDevTools();
    await service.requestClose();

    expect(operations).toEqual([
      ["drag-1", "focus"],
      ["drag-1", "minimize"],
      ["drag-1", "maximize"],
      ["drag-1", "unmaximize"],
      ["drag-1", "set-bounds", { x: 10, y: 20, width: 900, height: 700 }],
      ["drag-1", "toggle-dev-tools"],
      ["drag-1", "request-close"],
    ]);
  });
});
