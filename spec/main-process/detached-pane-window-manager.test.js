/* globals assert */

const { EventEmitter } = require("events");
const { dialog } = require("electron");
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
    this.title = "";
    this.bounds = { x: 0, y: 0, width: 800, height: 600 };
    this.webContents = new EventEmitter();
    this.webContents.destroyed = false;
    this.webContents.setWindowOpenHandler = (handler) => {
      this.webContents.windowOpenHandler = handler;
    };
    this.webContents.setVisualZoomLevelLimits = () => {};
    this.webContents.isDestroyed = () => this.webContents.destroyed;
  }

  show() {
    this.visible = true;
  }

  hide() {
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
    this.bounds = { ...this.bounds, ...bounds };
  }

  setMinimumSize() {}

  setAutoHideMenuBar() {}
}
