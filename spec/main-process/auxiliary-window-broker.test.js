const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const AuxiliaryWindowBroker = require("../../src/auxiliary-window-broker");

function fixture(dialogService) {
  const events = [];
  const owner = {
    unloading: false,
    lumineApplication: { quitting: false },
    sendToRenderer: (...event) => events.push(event),
  };
  const broker = new AuxiliaryWindowBroker(owner, {
    dialogService,
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
    isDestroyed: () => Boolean(window.destroyed),
    setBackgroundThrottling(value) {
      this.backgroundThrottling = value;
    },
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
  const result = broker.windowOpenHandler({ url: "about:blank", frameName: token });
  assert.equal(result.action, "allow");
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.sandbox, false);
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

test("hiding committed-close presentations preserves their models and native windows for cleanup", () => {
  const { broker, owner, window } = fixture();
  let hidden = 0;
  const runtimeThrottling = [];
  owner.browserWindow = {
    webContents: {
      isDestroyed: () => false,
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: (value) => runtimeThrottling.push(value),
    },
  };
  window.hide = () => hidden++;
  broker.didCreateWindow(window, { frameName: broker.prepare() });
  broker.hide();
  assert.equal(hidden, 1);
  assert.equal(window.webContents.backgroundThrottling, true);
  assert.deepEqual(runtimeThrottling, [false, true]);
  assert.equal(window.isDestroyed(), false);
  assert.equal(broker.windows.size, 1);
  window.destroy();
  broker.hide();
  assert.equal(hidden, 1);
  assert.deepEqual(runtimeThrottling, [false, true]);
  broker.destroy();
});

test("a stale renderer and a failed child hide do not prevent concealing the remaining presentations", (context) => {
  const { broker, owner, window: first } = fixture();
  const second = fixture().window;
  second.webContents.id = 18;
  broker.didCreateWindow(first, { frameName: broker.prepare() });
  broker.didCreateWindow(second, { frameName: broker.prepare() });
  let hidden = 0;
  let staleRendererCalls = 0;
  first.webContents.isDestroyed = () => true;
  first.webContents.setBackgroundThrottling = () => staleRendererCalls++;
  first.hide = () => {
    throw new Error("Native child disappeared");
  };
  second.hide = () => hidden++;
  owner.browserWindow = {
    isDestroyed: () => false,
    get webContents() {
      throw new Error("Owner renderer disappeared");
    },
  };
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  try {
    assert.doesNotThrow(() => broker.hide());
    assert.equal(staleRendererCalls, 0);
    assert.equal(hidden, 1);
    assert.equal(second.webContents.backgroundThrottling, true);
    assert.equal(broker.windows.size, 2);
    assert.equal(errors.length, 2);
  } finally {
    owner.browserWindow = null;
    broker.destroy();
  }
});

test("a committed hide cancels pending creations and rejects their late native windows", async () => {
  const { broker, window } = fixture();
  const token = broker.prepare();
  const resolving = broker.resolve(token);
  const refused = assert.rejects(resolving, /cancelled/);
  broker.hide();
  assert.throws(() => broker.prepare(), /closing/);
  assert.equal(broker.windowOpenHandler({ url: "about:blank", frameName: token }).action, "deny");
  broker.didCreateWindow(window, { frameName: token });
  await refused;
  assert.equal(window.isDestroyed(), true);
  assert.equal(broker.windows.size, 0);
  assert.equal(broker.pending.size, 0);
  broker.destroy();
});

test("late reveal actions cannot show an existing child after its committed hide", async () => {
  const { broker, window } = fixture();
  const revealed = [];
  window.hide = () => {
    window.visible = false;
  };
  window.isVisible = () => Boolean(window.visible);
  for (const action of ["show", "focus", "maximize", "unmaximize", "minimize", "setFullScreen"])
    window[action] = () => {
      revealed.push(action);
      window.visible = true;
    };
  window.webContents.focus = () => {
    revealed.push("page focus");
  };
  window.webContents.openDevTools = () => {
    revealed.push("devtools");
  };
  window.webContents.isDevToolsOpened = () => false;
  let closedDevTools = 0;
  window.webContents.closeDevTools = () => closedDevTools++;
  const token = broker.prepare();
  broker.didCreateWindow(window, { frameName: token });
  const { id } = await broker.resolve(token);
  window.visible = true;
  broker.hide();
  for (const action of [
    "show",
    "focus",
    "maximize",
    "unmaximize",
    "minimize",
    "setFullScreen",
    "openDevTools",
    "toggleDevTools",
  ])
    broker.invoke(id, action, true);
  assert.equal(window.isVisible(), false);
  assert.deepEqual(revealed, []);
  assert.equal(broker.windows.size, 1);
  assert.equal(broker.invoke(id, "getState").visible, false);
  broker.invoke(id, "closeDevTools");
  assert.equal(closedDevTools, 1);
  broker.invoke(id, "close");
  assert.equal(window.vetoed, undefined);
  broker.destroy();
});

test("a committed hide aborts new native dialogs before they can reveal the closing workspace", async () => {
  const dialogs = [];
  const { broker, window } = fixture({
    showOpenDialog: () => dialogs.push("open"),
    showSaveDialog: () => dialogs.push("save"),
    showMessageBox: () => dialogs.push("confirm"),
  });
  window.hide = () => {};
  const token = broker.prepare();
  broker.didCreateWindow(window, { frameName: token });
  const { id } = await broker.resolve(token);
  broker.hide();
  for (const action of ["showOpenDialog", "showSaveDialog", "confirm"])
    assert.throws(() => broker.invoke(id, action, { buttons: ["OK"] }), { code: "ABORT_ERR" });
  assert.deepEqual(dialogs, []);
  assert.equal(broker.windows.size, 1);
  broker.destroy();
});

test("open dialogs are owned by the addressed auxiliary presentation", async () => {
  const requests = [];
  const result = { canceled: false, filePaths: ["chosen.grv"] };
  const { broker, window } = fixture({
    showOpenDialog: (...args) => {
      requests.push(args);
      return Promise.resolve(result);
    },
  });
  const other = fixture();
  try {
    broker.didCreateWindow(window, { frameName: broker.prepare() });
    const options = { title: "Open", properties: ["openFile"] };
    assert.equal(await broker.invoke(-17, "showOpenDialog", options), result);
    assert.deepEqual(requests, [[window, options]]);
    assert.throws(() => other.broker.invoke(-17, "showOpenDialog", options), /does not belong/);
    window.destroy();
    assert.throws(() => broker.invoke(-17, "showOpenDialog", options), /does not belong/);
    assert.equal(requests.length, 1);
  } finally {
    broker.destroy();
    other.broker.destroy();
  }
});

test("invalid auxiliary open-dialog options never reach the native dialog", () => {
  let requests = 0;
  const { broker, window } = fixture({ showOpenDialog: () => requests++ });
  try {
    broker.didCreateWindow(window, { frameName: broker.prepare() });
    for (const options of [undefined, null, [], "open", true, 42]) {
      assert.throws(
        () => broker.invoke(-17, "showOpenDialog", options),
        /Open dialog options must be an object/,
      );
    }
    assert.equal(requests, 0);
  } finally {
    broker.destroy();
  }
});

test(
  "native caption presses address only their auxiliary presentation",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const { broker, events, window } = fixture();
    const hooks = new Map();
    window.hookWindowMessage = (message, callback) => hooks.set(message, callback);
    window.isWindowMessageHooked = (message) => hooks.has(message);
    window.unhookWindowMessage = (message) => hooks.delete(message);
    const token = broker.prepare();
    broker.didCreateWindow(window, { frameName: token });
    const { id } = await broker.resolve(token);
    const caption = Buffer.alloc(8);
    caption.writeUInt32LE(2);
    const callback = hooks.get(0x00a1);
    try {
      assert.equal(callback(caption, Buffer.alloc(8)), undefined);
      assert.deepEqual(events.at(-1), ["did-mouse-down-in-window", { windowId: id }]);
      const mouseDown = Buffer.alloc(8);
      mouseDown.writeUInt32LE(0x0201);
      const point = Buffer.alloc(8);
      point.writeInt16LE(640, 0);
      point.writeInt16LE(24, 2);
      assert.equal(hooks.get(0x0210)(mouseDown, point), undefined);
      assert.deepEqual(events.at(-1), [
        "did-mouse-down-in-window",
        { windowId: id, position: { x: 640, y: 24 } },
      ]);
      window.destroy();
      const count = events.length;
      callback(caption, Buffer.alloc(8));
      assert.equal(events.length, count);
    } finally {
      broker.destroy();
    }
  },
);

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

test("a native identity cannot be reused until its previous host is destroyed", async () => {
  const { broker, window } = fixture();
  const persistentId = "740492e4-e8a1-4dea-965c-fd542a685589";
  const token = broker.prepare({ persistentId });
  broker.didCreateWindow(window, { frameName: token });
  await broker.resolve(token);
  assert.throws(() => broker.prepare({ persistentId }), /already in use/);
  assert.throws(() => broker.prepare({ persistentId, replacesWindowId: -99 }), /already in use/);
  assert.equal(window.destroyed, undefined);
  window.destroy();
  const replacement = broker.prepare({ persistentId });
  broker.cancel(replacement);
  broker.destroy();
});

test("auxiliary native state is scoped to its workspace and logical presentation", () => {
  const { broker, owner } = fixture();
  owner.windowStateId = "11111111-1111-4111-8111-111111111111";
  owner.persistWindowState = true;
  const persistentId = "740492e4-e8a1-4dea-965c-fd542a685589";
  const token = broker.prepare({ persistentId });
  const { overrideBrowserWindowOptions: options } = broker.windowOpenHandler({
    url: "about:blank",
    frameName: token,
  });
  assert.equal(options.name, `lumine-presentation-${owner.windowStateId}-${persistentId}`);
  assert.equal(options.windowStatePersistence, true);
  broker.destroy();
});

test("a close resolves after native destruction has released the presentation name", async () => {
  const { broker, window } = fixture();
  const persistentId = "740492e4-e8a1-4dea-965c-fd542a685589";
  const token = broker.prepare({ persistentId });
  broker.didCreateWindow(window, { frameName: token });
  const { id } = await broker.resolve(token);
  let settled = false;
  const closing = broker.invoke(id, "close").then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  window.destroy();
  assert.equal(settled, false);
  await closing;
  assert.ok(broker.prepare({ persistentId }));
  broker.destroy();
});
