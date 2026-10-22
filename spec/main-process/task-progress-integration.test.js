const assert = require("node:assert/strict");
const { once } = require("node:events");
const crypto = require("node:crypto");
const { BrowserWindow } = require("electron");
const TaskProgressManager = require("../../src/task-progress-manager");
const AuxiliaryWindowBroker = require("../../src/auxiliary-window-broker");

describe("Native task progress lifecycle", () => {
  let owner, manager, badges, mainProgress, generation;

  beforeEach(async () => {
    badges = [];
    manager = new TaskProgressManager({ setBadgeCount: (count) => badges.push(count) });
    const browserWindow = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    mainProgress = spyOn(browserWindow, "setProgressBar").and.callThrough();
    owner = {
      browserWindow,
      windowStateId: crypto.randomUUID(),
      persistWindowState: false,
      lumineApplication: { taskProgress: manager, quitting: false },
      sendToRenderer() {},
    };
    owner.auxiliaryWindowBroker = new AuxiliaryWindowBroker(owner, {
      attachKeyboard: () => ({ clear() {}, dispose() {} }),
    });
    browserWindow.webContents.setWindowOpenHandler((details) =>
      owner.auxiliaryWindowBroker.windowOpenHandler(details),
    );
    await browserWindow.loadURL("data:text/html,<html><body>Task progress test</body></html>");
    generation = manager.beginGeneration(owner);
  });

  afterEach(() => {
    owner.auxiliaryWindowBroker.destroy();
    manager.dispose();
    if (!owner.browserWindow.isDestroyed()) owner.browserWindow.destroy();
  });

  it("applies existing activity to a real detached window and releases it when closed", async () => {
    manager.update(owner, "build", { count: 2 }, generation);
    assert.equal(mainProgress.calls.mostRecent().args[0], 2);
    const broker = owner.auxiliaryWindowBroker;
    const token = broker.prepare({ bounds: { width: 400, height: 300 } });
    let auxiliary, progress;
    owner.browserWindow.webContents.once("did-create-window", (window, details) => {
      auxiliary = window;
      progress = spyOn(window, "setProgressBar").and.callThrough();
      broker.didCreateWindow(window, details);
    });
    await owner.browserWindow.webContents.executeJavaScript(
      `window.open("about:blank", ${JSON.stringify(token)}) !== null`,
    );
    await broker.resolve(token);
    assert.equal(progress.calls.mostRecent().args[0], 2);
    assert.deepEqual(badges, [2]);
    assert.equal(manager.windows.has(auxiliary), true);

    auxiliary.destroy();
    assert.equal(manager.windows.has(auxiliary), false);
    assert.deepEqual(badges, [2]);
    manager.remove(owner, "build", generation);
    assert.equal(mainProgress.calls.mostRecent().args[0], -1);
    assert.deepEqual(badges, [2, 0]);
  });

  it("clears a renderer generation on reload and when its native window is destroyed", async () => {
    const contents = owner.browserWindow.webContents;
    manager.update(owner, "scan", { count: 1, progress: 0.5 }, generation);
    const loaded = once(contents, "did-finish-load");
    contents.reload();
    await loaded;
    assert.equal(mainProgress.calls.mostRecent().args[0], -1);
    assert.equal(manager.owners.size, 0);
    assert.deepEqual(badges, [1, 0]);
    assert.throws(
      () => manager.update(owner, "late", { count: 1 }, generation),
      /generation has ended/,
    );

    generation = manager.beginGeneration(owner);
    manager.update(owner, "scan", { count: 3 }, generation);
    const destroyed = once(contents, "destroyed");
    owner.browserWindow.destroy();
    await destroyed;
    assert.equal(manager.owners.size, 0);
    assert.equal(manager.windows.size, 0);
    assert.deepEqual(badges, [1, 0, 3, 0]);
  });
});
