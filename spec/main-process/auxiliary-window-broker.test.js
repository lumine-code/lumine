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
