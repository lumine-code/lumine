const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const AuxiliaryWindowBroker = require("../../src/auxiliary-window-broker");

function fixture() {
  const events = [];
  const owner = {
    unloading: false,
    lumineApplication: { quitting: false },
    sendToRenderer: (...event) => events.push(event),
  };
  const broker = new AuxiliaryWindowBroker(owner, {
    attachKeyboard: () => ({
      clear() {},
      dispose() {},
      update() {
        return { ok: true };
      },
    }),
    displayService: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
  });
  const window = new EventEmitter();
  window.webContents = Object.assign(new EventEmitter(), {
    id: 17,
    setWindowOpenHandler(handler) {
      this.openHandler = handler;
    },
  });
  window.isDestroyed = () => Boolean(window.destroyed);
  window.destroy = () => {
    window.destroyed = true;
    window.emit("closed");
  };
  window.close = () => {
    window.emit("close", {
      preventDefault() {
        window.vetoed = true;
      },
    });
  };
  window.getPosition = () => [10, 20];
  window.getSize = () => [800, 600];
  window.isMaximized = window.isFullScreen = window.isVisible = () => false;
  return { broker, owner, events, window };
}

test("only prepared workspace presentations can open a native child", () => {
  const { broker } = fixture();
  const token = broker.prepare({ bounds: { width: 800, height: 600 } });
  assert.equal(broker.windowOpenHandler({ url: "about:blank", frameName: token }).action, "allow");
  assert.equal(
    broker.windowOpenHandler({ url: "https://example.com", frameName: token }).action,
    "deny",
  );
  assert.equal(
    broker.windowOpenHandler({ url: "about:blank", frameName: "unregistered" }).action,
    "deny",
  );
  assert.throws(() => broker.prepare({ bounds: { width: -10 } }), /Invalid width/);
  broker.destroy();
});

test("keeps the shared runtime unthrottled until the last auxiliary window closes", () => {
  const { broker, owner, window: first } = fixture();
  const second = fixture().window;
  second.webContents.id = 18;
  const changes = [];
  owner.browserWindow = {
    webContents: {
      isDestroyed: () => false,
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: (value) => changes.push(value),
    },
  };
  broker.didCreateWindow(first, { frameName: broker.prepare() });
  broker.didCreateWindow(second, { frameName: broker.prepare() });
  assert.deepEqual(changes, [false]);
  first.destroy();
  assert.deepEqual(changes, [false]);
  second.destroy();
  assert.deepEqual(changes, [false, true]);
  broker.destroy();
});

test("preserves an already unthrottled runtime when cancelling a native child", () => {
  const { broker, owner, window } = fixture();
  const changes = [];
  owner.browserWindow = {
    webContents: {
      isDestroyed: () => false,
      getBackgroundThrottling: () => false,
      setBackgroundThrottling: (value) => changes.push(value),
    },
  };
  const token = broker.prepare();
  broker.didCreateWindow(window, { frameName: token });
  broker.cancel(token);
  assert.deepEqual(changes, [false, false]);
  broker.destroy();
});

test("does not read a destroyed owner's native webContents during shutdown", () => {
  const { broker, owner } = fixture();
  owner.browserWindow = {
    isDestroyed: () => true,
    get webContents() {
      throw new Error("Destroyed BrowserWindow");
    },
  };
  broker.destroy();
});

test("a native close waits for the owning workspace to close or reattach its panes", async () => {
  const { broker, events, window } = fixture();
  const token = broker.prepare();
  broker.didCreateWindow(window, { frameName: token });
  const descriptor = await broker.resolve(token);
  assert.equal(descriptor.id, -17);
  window.close();
  assert.equal(window.vetoed, true);
  assert.equal(events.at(-1)[1].type, "close-requested");
  assert.deepEqual(events.at(-1)[1].state.bounds, { x: 10, y: 20, width: 800, height: 600 });
  window.vetoed = false;
  broker.invoke(-17, "close");
  assert.equal(window.vetoed, false);
  assert.throws(() => broker.invoke(-18, "getState"), /does not belong/);
  broker.destroy();
});

test("saved windows stay reachable when their monitor has disappeared", () => {
  const { broker } = fixture();
  const token = broker.prepare({ bounds: { x: 3000, y: -100, width: 2400, height: 1400 } });
  const result = broker.windowOpenHandler({ url: "about:blank", frameName: token });
  assert.deepEqual(
    Object.fromEntries(
      ["x", "y", "width", "height"].map((key) => [key, result.overrideBrowserWindowOptions[key]]),
    ),
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  assert.equal(broker.windowOpenHandler({ url: "about:blank", frameName: token }).action, "deny");
  broker.destroy();
});

test("cancelling after native creation closes the unclaimed presentation", async () => {
  const { broker, window } = fixture();
  const token = broker.prepare();
  broker.didCreateWindow(window, { frameName: token });
  broker.cancel(token);
  assert.equal(window.destroyed, true);
  assert.equal(broker.windows.size, 0);
  await assert.rejects(broker.resolve(token), /Unknown/);
  broker.destroy();
});

test("cancelling and destroying a workspace release pending clients and native children", async () => {
  const { broker, window } = fixture();
  const cancelled = broker.prepare();
  const pending = broker.resolve(cancelled);
  broker.cancel(cancelled);
  await assert.rejects(pending, /cancelled/);
  const token = broker.prepare();
  broker.didCreateWindow(window, { frameName: token });
  await broker.resolve(token);
  broker.destroy();
  assert.equal(window.destroyed, true);
  assert.equal(broker.windows.size, 0);
  assert.throws(() => broker.prepare(), /closed/);
});

test("developer tools toggle on the addressed presentation", async () => {
  const { broker, window } = fixture();
  let opened = false;
  let openedCount = 0;
  let closedCount = 0;
  window.webContents.isDevToolsOpened = () => opened;
  window.webContents.openDevTools = () => {
    opened = true;
    openedCount++;
  };
  window.webContents.closeDevTools = () => {
    opened = false;
    closedCount++;
  };
  const token = broker.prepare();
  broker.didCreateWindow(window, { frameName: token });
  const descriptor = await broker.resolve(token);
  broker.invoke(descriptor.id, "toggleDevTools");
  assert.equal(opened, true);
  broker.invoke(descriptor.id, "toggleDevTools");
  assert.equal(opened, false);
  assert.equal(openedCount, 1);
  assert.equal(closedCount, 1);
  broker.destroy();
});

for (const offscreen of [false, true]) {
  test(`native presentation requests respect the offscreen owner (${offscreen})`, async () => {
    const { broker, owner, window } = fixture();
    owner.headless = true;
    owner.offscreen = offscreen;
    const nativeCalls = [];
    const pageCalls = [];
    for (const method of ["focus", "show", "minimize", "maximize", "unmaximize", "setFullScreen"]) {
      window[method] = () => nativeCalls.push(method);
    }
    window.webContents.focus = () => pageCalls.push("focus");
    const token = broker.prepare();
    broker.didCreateWindow(window, { frameName: token });
    const descriptor = await broker.resolve(token);

    for (const action of ["focus", "show", "minimize", "maximize", "unmaximize", "setFullScreen"]) {
      broker.invoke(descriptor.id, action, true);
    }
    assert.deepEqual(
      nativeCalls,
      offscreen ? [] : ["focus", "minimize", "maximize", "unmaximize", "setFullScreen"],
    );
    assert.deepEqual(pageCalls, ["focus"]);
    broker.destroy();
  });
}

test("saved presentation identities are valid and cannot alias another host", () => {
  const { broker } = fixture();
  for (const persistentId of ["main", "", null, {}, []])
    assert.throws(() => broker.prepare({ persistentId }), /must be a UUID/);
  const persistentId = "740492e4-e8a1-4dea-965c-fd542a685589";
  const token = broker.prepare({ persistentId });
  assert.throws(() => broker.prepare({ persistentId }), /already in use/);
  broker.cancel(token);
  assert.ok(broker.prepare({ persistentId }));
  broker.destroy();
});

test("restore may prepare a replacement for its own old host before closing it", async () => {
  const { broker, window } = fixture();
  const persistentId = "740492e4-e8a1-4dea-965c-fd542a685589";
  const token = broker.prepare({ persistentId });
  broker.didCreateWindow(window, { frameName: token });
  const descriptor = await broker.resolve(token);
  assert.throws(() => broker.prepare({ persistentId }), /already in use/);
  assert.throws(() => broker.prepare({ persistentId, replacesWindowId: -99 }), /already in use/);
  const replacement = broker.prepare({ persistentId, replacesWindowId: descriptor.id });
  assert.equal(window.destroyed, undefined);
  assert.throws(
    () => broker.prepare({ persistentId, replacesWindowId: descriptor.id }),
    /already in use/,
  );
  broker.cancel(replacement);
  broker.destroy();
});
