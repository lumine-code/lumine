/* globals assert */

const { EventEmitter } = require("events");
const { dialog, Menu, screen } = require("electron");
const DetachedPaneWindowManager = require("../../src/detached-pane-window-manager");

describe("DetachedPaneWindowManager", function () {
  let application, owner, manager;

  beforeEach(function () {
    application = {
      registered: [],
      unregistered: [],
      registerDetachedPaneWindow(lumineWindow, surface) {
        this.registered.push({ lumineWindow, surface });
      },
      unregisterDetachedPaneWindow(surface) {
        this.unregistered.push(surface);
      },
    };
    owner = {
      browserWindow: new StubBrowserWindow(),
      lumineApplication: application,
      sent: [],
      sendToRenderer(...args) {
        this.sent.push(args);
      },
    };
    manager = new DetachedPaneWindowManager(owner);
    manager.install();
  });

  afterEach(function () {
    manager.destroy();
  });

  it("denies every window.open without an explicit transaction reservation", function () {
    assert.deepEqual(
      owner.browserWindow.webContents.windowOpenHandler({
        url: "about:blank",
        frameName: "unreserved",
      }),
      { action: "deny" },
    );
  });

  it("reuses a reservation with the same explicit transaction id", function () {
    const first = manager.reserve({ transactionId: "drag-1" });
    const second = manager.reserve({ transactionId: "drag-1" });
    assert.deepEqual(second, first);
    assert.equal(manager.transactions.size, 1);
  });

  it("creates detached windows with the owning editor window's icon", function () {
    const icon = {};
    owner.getWindowIcon = () => icon;
    const transaction = manager.reserve({ transactionId: "drag-1" });

    const response = owner.browserWindow.webContents.windowOpenHandler({
      url: transaction.url,
      frameName: transaction.frameName,
    });

    assert.strictEqual(response.overrideBrowserWindowOptions.icon, icon);
  });

  it("creates a hidden detached window at its explicit final bounds", function () {
    const workArea = screen.getDisplayNearestPoint({ x: 0, y: 0 }).workArea;
    const width = Math.min(700, workArea.width);
    const height = Math.min(500, workArea.height);
    const x = workArea.x + Math.floor((workArea.width - width) / 2);
    const y = workArea.y + Math.floor((workArea.height - height) / 2);
    const transaction = manager.reserve({
      bounds: { x, y, width, height },
    });

    const response = owner.browserWindow.webContents.windowOpenHandler({
      url: transaction.url,
      frameName: transaction.frameName,
    });

    assert.deepEqual(response.overrideBrowserWindowOptions, {
      show: false,
      x,
      y,
      width,
      height,
    });
  });

  it("centers unpositioned detached bounds over the owning editor window", function () {
    const workArea = screen.getDisplayNearestPoint({ x: 0, y: 0 }).workArea;
    const width = Math.min(400, workArea.width);
    const height = Math.min(300, workArea.height);
    const ownerWidth = Math.min(width + 200, workArea.width);
    const ownerHeight = Math.min(height + 200, workArea.height);
    const ownerX = workArea.x + Math.floor((workArea.width - ownerWidth) / 2);
    const ownerY = workArea.y + Math.floor((workArea.height - ownerHeight) / 2);
    owner.browserWindow.bounds = {
      x: ownerX,
      y: ownerY,
      width: ownerWidth,
      height: ownerHeight,
    };
    const transaction = manager.reserve({ bounds: { width, height } });

    const response = owner.browserWindow.webContents.windowOpenHandler({
      url: transaction.url,
      frameName: transaction.frameName,
    });

    assert.deepEqual(response.overrideBrowserWindowOptions, {
      show: false,
      x: ownerX + Math.round((ownerWidth - width) / 2),
      y: ownerY + Math.round((ownerHeight - height) / 2),
      width,
      height,
    });
  });

  it("uses a larger default size and clamps it to the display work area", function () {
    const workArea = screen.getDisplayNearestPoint({ x: 0, y: 0 }).workArea;
    const width = Math.min(1000, workArea.width);
    const height = Math.min(700, workArea.height);
    owner.browserWindow.bounds = { ...workArea };
    const transaction = manager.reserve();

    const response = owner.browserWindow.webContents.windowOpenHandler({
      url: transaction.url,
      frameName: transaction.frameName,
    });

    assert.deepEqual(response.overrideBrowserWindowOptions, {
      show: false,
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    });
  });

  it("keeps a created window hidden until the transaction is committed", function () {
    const transaction = manager.reserve({ transactionId: "drag-1", bounds: { width: 700 } });
    const response = owner.browserWindow.webContents.windowOpenHandler({
      url: transaction.url,
      frameName: transaction.frameName,
    });
    assert.equal(response.action, "allow");

    const child = new StubBrowserWindow();
    owner.browserWindow.webContents.emit("did-create-window", child, {
      frameName: transaction.frameName,
    });
    assert.lengthOf(application.registered, 1);
    assert.isFalse(child.visible);
    assert.equal(child.hideCallCount, 0);
    assert.equal(child.setBoundsCallCount, 0);

    const ready = manager.perform(transaction.transactionId, "ready");
    assert.equal(ready.state, "ready");
    assert.isFalse(child.visible);

    const open = manager.perform(transaction.transactionId, "commit");
    assert.equal(open.state, "open");
    assert.isTrue(child.visible);
    assert.isTrue(child.focused);
  });

  it("cancels and destroys an uncommitted DnD surface idempotently", function () {
    const transaction = manager.reserve({ transactionId: "drag-1" });
    owner.browserWindow.webContents.windowOpenHandler({
      url: transaction.url,
      frameName: transaction.frameName,
    });
    const child = new StubBrowserWindow();
    owner.browserWindow.webContents.emit("did-create-window", child, {
      frameName: transaction.frameName,
    });

    assert.isTrue(manager.perform(transaction.transactionId, "cancel"));
    assert.isTrue(child.isDestroyed());
    assert.isFalse(manager.transactions.has(transaction.transactionId));
    assert.lengthOf(application.unregistered, 1);
    assert.doesNotThrow(() => manager.destroy());
  });

  it("turns native close into a renderer-confirmed close handshake", function () {
    const transaction = openCommittedWindow(manager, owner);
    const child = manager.transactions.get(transaction.transactionId).surface.browserWindow;

    child.close();
    assert.isFalse(child.isDestroyed());
    assert.deepEqual(owner.sent.at(-1).slice(0, 3), [
      "detached-pane-window-event",
      transaction.surfaceId,
      "close-requested",
    ]);

    manager.perform(transaction.transactionId, "close-cancelled");
    assert.equal(manager.transactions.get(transaction.transactionId).surface.state, "open");
    child.close();
    manager.perform(transaction.transactionId, "close-accepted");
    assert.isTrue(child.isDestroyed());
  });

  it("closes a committed surface programmatically after attaching its pane", function () {
    const transaction = openCommittedWindow(manager, owner);
    const child = manager.transactions.get(transaction.transactionId).surface.browserWindow;
    assert.isFalse(owner.browserWindow.focused);
    assert.isTrue(manager.perform(transaction.transactionId, "attach"));
    assert.isTrue(child.isDestroyed());
    assert.isTrue(owner.browserWindow.focused);
    assert.isFalse(manager.perform(transaction.transactionId, "attach"));
  });

  it("closes every child without a renderer prompt before owner reload", function () {
    const first = openCommittedWindow(manager, owner, "first");
    const second = openCommittedWindow(manager, owner, "second");

    manager.closeAll("owner-reload");

    assert.isFalse(manager.transactions.has(first.transactionId));
    assert.isFalse(manager.transactions.has(second.transactionId));
    assert.equal(manager.surfaces.size, 0);
    assert.lengthOf(application.unregistered, 2);
  });

  it("owns native dialogs with the detached BrowserWindow", async function () {
    const transaction = openCommittedWindow(manager, owner);
    const child = manager.transactions.get(transaction.transactionId).surface.browserWindow;
    const showMessageBox = spyOn(dialog, "showMessageBox").and.returnValue(
      Promise.resolve({ response: 1 }),
    );
    const response = await manager.perform(transaction.transactionId, "confirm", {
      message: "Save this item?",
      buttons: ["Save", "Cancel"],
    });
    assert.equal(response, 1);
    assert.strictEqual(showMessageBox.calls.mostRecent().args[0], child);
  });

  it("opens detached native context menus without returning a main-process object", function () {
    const transaction = openCommittedWindow(manager, owner);
    const child = manager.transactions.get(transaction.transactionId).surface.browserWindow;
    let builtTemplate, popupOptions;
    spyOn(Menu, "buildFromTemplate").and.callFake((template) => {
      builtTemplate = template;
      return {
        popup(options) {
          popupOptions = options;
          options.callback();
        },
      };
    });

    const result = manager.perform(transaction.transactionId, "show-context-menu", "request-1", [
      { label: "Copy", command: "core:copy" },
    ]);

    assert.isUndefined(result);
    assert.strictEqual(popupOptions.window, child);
    assert.strictEqual(typeof popupOptions.callback, "function");
    assert.deepEqual(Object.keys(popupOptions).sort(), ["callback", "window"]);
    assert.deepEqual(owner.sent.at(-1), [
      "surface-context-menu-closed",
      transaction.surfaceId,
      "request-1",
    ]);

    builtTemplate[0].click();
    assert.deepEqual(owner.sent.at(-1), [
      "surface-context-command",
      transaction.surfaceId,
      "request-1",
      "core:copy",
      { contextCommand: true },
    ]);
  });

  it("toggles developer tools on the addressed detached BrowserWindow", function () {
    const first = openCommittedWindow(manager, owner, "first");
    const second = openCommittedWindow(manager, owner, "second");
    const firstChild = manager.transactions.get(first.transactionId).surface.browserWindow;
    const secondChild = manager.transactions.get(second.transactionId).surface.browserWindow;

    manager.perform(first.transactionId, "toggle-dev-tools");

    assert.equal(firstChild.webContents.devToolsToggleCount, 1);
    assert.equal(secondChild.webContents.devToolsToggleCount, 0);
    assert.equal(owner.browserWindow.webContents.devToolsToggleCount, 0);
  });

  it("validates, rounds, and applies partial surface bounds", function () {
    const transaction = openCommittedWindow(manager, owner);
    const child = manager.transactions.get(transaction.transactionId).surface.browserWindow;

    const state = manager.perform(transaction.transactionId, "set-bounds", {
      x: 10.4,
      y: 20.6,
      width: 80,
      height: 700.2,
    });
    assert.deepEqual(child.getBounds(), { x: 10, y: 21, width: 160, height: 700 });
    assert.deepEqual(state.bounds, child.getBounds());

    manager.perform(transaction.transactionId, "set-bounds", { width: 900 });
    assert.deepEqual(child.getBounds(), { x: 10, y: 21, width: 900, height: 700 });
    assert.throws(
      () => manager.perform(transaction.transactionId, "set-bounds", { width: Infinity }),
      /must be finite/,
    );
    assert.throws(
      () => manager.perform(transaction.transactionId, "set-bounds", { opacity: 1 }),
      /Unsupported detached-pane bound/,
    );
    assert.throws(
      () => manager.perform(transaction.transactionId, "set-bounds", {}),
      /at least one coordinate/,
    );
  });
});

function openCommittedWindow(manager, owner, transactionId = "command-1") {
  const transaction = manager.reserve({ transactionId });
  owner.browserWindow.webContents.windowOpenHandler({
    url: transaction.url,
    frameName: transaction.frameName,
  });
  const child = new StubBrowserWindow();
  owner.browserWindow.webContents.emit("did-create-window", child, {
    frameName: transaction.frameName,
  });
  manager.perform(transaction.transactionId, "ready");
  manager.perform(transaction.transactionId, "commit");
  return transaction;
}

class StubBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.visible = false;
    this.focused = false;
    this.hideCallCount = 0;
    this.setBoundsCallCount = 0;
    this.title = "";
    this.bounds = { x: 0, y: 0, width: 800, height: 600 };
    this.webContents = new EventEmitter();
    this.webContents.destroyed = false;
    this.webContents.setWindowOpenHandler = (handler) => {
      this.webContents.windowOpenHandler = handler;
    };
    this.webContents.setVisualZoomLevelLimits = () => {};
    this.webContents.isDestroyed = () => this.webContents.destroyed;
    this.webContents.devToolsToggleCount = 0;
    this.webContents.toggleDevTools = () => this.webContents.devToolsToggleCount++;
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.hideCallCount++;
    this.visible = false;
  }

  focus() {
    this.focused = true;
    this.emit("focus");
  }

  close() {
    let prevented = false;
    this.emit("close", {
      preventDefault() {
        prevented = true;
      },
    });
    if (!prevented) this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }

  isDestroyed() {
    return this.destroyed;
  }

  isFocused() {
    return this.focused;
  }

  isVisible() {
    return this.visible;
  }

  isMaximized() {
    return false;
  }

  isFullScreen() {
    return false;
  }

  getBounds() {
    return { ...this.bounds };
  }

  setTitle(title) {
    this.title = title;
  }

  setBounds(bounds) {
    this.setBoundsCallCount++;
    this.bounds = { ...this.bounds, ...bounds };
  }

  setMinimumSize() {}

  setAutoHideMenuBar() {}
}
