/* globals assert */
const { EventEmitter } = require("events");
const attach = require("../../src/embedded-keyboard-ipc");

function fixtures(id = 1) {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  ipcMain.removeHandler = (name) => handlers.delete(name);
  const contents = new EventEmitter();
  const main = {
    frameTreeNodeId: id,
    processId: 10,
    routingId: id,
    detached: false,
    isDestroyed: () => false,
  };
  const child = {
    frameTreeNodeId: id + 1,
    processId: 20,
    routingId: id + 1,
    detached: false,
    parent: main,
    isDestroyed: () => false,
    url: "https://example.test/widget",
  };
  main.framesInSubtree = [main, child];
  contents.mainFrame = main;
  contents.focusedFrame = child;
  contents.isDestroyed = () => false;
  contents.isFocused = () => true;
  const sent = [];
  contents.send = (...args) => sent.push(args);
  const replayed = [];
  const nativeInput = {
    replay: async (frame, input, guard) => {
      if (guard()) replayed.push({ frame, input });
    },
    dispose() {},
  };
  const errors = [];
  const options = { ipcMain, nativeInput, reportError: (error) => errors.push(error) };
  const sync = (snapshot, senderFrame = main, sender = contents) => {
    const event = { sender, senderFrame };
    ipcMain.emit(attach.STATE_CHANNEL, event, snapshot);
    return event.returnValue;
  };
  return { ipcMain, handlers, contents, main, child, sent, replayed, errors, options, sync };
}

const snapshot = (hostId = "view", revision = 1) => ({
  hostId,
  revision,
  enabled: true,
  partialMatchTimeout: 1000,
  bindings: [{ command: "pane:move-active-item-up", keystrokes: "alt-z up", depth: 0, rank: 0 }],
});
const key = (key, code, alt = false) => ({ type: "keyDown", key, code, alt });
const input = (state, descriptor) => {
  let prevented = false;
  state.contents.emit(
    "before-input-event",
    { preventDefault: () => (prevented = true) },
    descriptor,
  );
  return prevented;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("embedded pane keyboard IPC", function () {
  let disposables;
  beforeEach(function () {
    disposables = [];
  });
  afterEach(function () {
    for (const disposable of disposables) disposable.dispose();
  });
  function mount(state, extra = {}) {
    const disposable = attach(state.contents, { ...state.options, ...extra });
    disposables.push(disposable);
    return disposable;
  }

  it("rejects subframe state publication and native input requests", async function () {
    const state = fixtures();
    mount(state, { testing: true });
    assert.isFalse(state.sync(snapshot(), state.child).ok);
    assert.isFalse(input(state, key("z", "KeyZ", true)));
    const handler = state.handlers.get("lumine:embedded-keyboard-test-input");
    const result = await handler(
      { sender: state.contents, senderFrame: state.child },
      { selector: "iframe", method: "Input.insertText", parameters: { text: "x" } },
    );
    assert.isFalse(result.ok);
    assert.lengthOf(state.sent, 0);
    assert.lengthOf(state.replayed, 0);
  });

  it("handles a scoped chord once and keeps ordinary input native", function () {
    const state = fixtures();
    mount(state);
    assert.isTrue(state.sync(snapshot()).ok);
    assert.isFalse(input(state, key("a", "KeyA")));
    assert.isTrue(input(state, key("z", "KeyZ", true)));
    assert.isTrue(input(state, key("ArrowUp", "ArrowUp")));
    assert.lengthOf(state.sent, 1);
    assert.strictEqual(state.sent[0][0], attach.COMMAND_CHANNEL);
    assert.strictEqual(state.sent[0][1].command, "pane:move-active-item-up");
  });

  it("restores a failed printable prefix before its suffix into the original frame", async function () {
    const state = fixtures();
    mount(state);
    const data = snapshot();
    data.bindings[0].keystrokes = "g up";
    state.sync(data);
    assert.isTrue(input(state, key("g", "KeyG")));
    assert.isTrue(input(state, key("x", "KeyX")));
    await settle();
    assert.deepEqual(
      state.replayed.map((entry) => entry.input.key),
      ["g", "x"],
    );
    assert.isTrue(state.replayed.every((entry) => entry.frame === state.child));
    assert.lengthOf(state.sent, 0);
    assert.lengthOf(state.errors, 0);
  });

  it("releases B from an unresponsive A replay and ignores A's later rejection", async function () {
    const state = fixtures();
    let rejectA;
    state.nativeInput = state.options.nativeInput = {
      replay: async (frame, descriptor, guard) => {
        if (frame === state.child) {
          await new Promise((_resolve, reject) => (rejectA = reject));
        } else if (guard()) state.replayed.push({ frame, input: descriptor });
      },
      dispose() {},
    };
    mount(state);
    const a = snapshot("A");
    a.bindings[0].keystrokes = "g up";
    state.sync(a);
    input(state, key("g", "KeyG"));
    input(state, key("x", "KeyX"));
    const b = { ...state.child, frameTreeNodeId: 3, routingId: 3 };
    state.contents.focusedFrame = b;
    state.main.framesInSubtree.push(b);
    const dataB = snapshot("B");
    dataB.bindings[0].keystrokes = "g up";
    state.sync(dataB);
    assert.isFalse(input(state, key("b", "KeyB")));
    assert.isTrue(input(state, key("g", "KeyG")));
    assert.isTrue(input(state, key("x", "KeyX")));
    await settle();
    assert.deepEqual(
      state.replayed.map((entry) => entry.input.key),
      ["g", "x"],
    );
    assert.isTrue(state.replayed.every((entry) => entry.frame === b));
    rejectA(new Error("A was removed while preparing replay"));
    await settle();
    state.sync(snapshot("B", 2));
    assert.isTrue(input(state, key("z", "KeyZ", true)));
    assert.isTrue(input(state, key("ArrowUp", "ArrowUp")));
    assert.strictEqual(state.sent[0][1].hostId, "B");
    assert.lengthOf(state.errors, 0);
  });

  it("retires a child document's chord on navigation without changing its frame id", function () {
    const state = fixtures();
    mount(state);
    state.sync(snapshot());
    input(state, key("z", "KeyZ", true));
    state.contents.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
      frame: state.child,
    });
    assert.isFalse(input(state, key("ArrowUp", "ArrowUp")));
    assert.lengthOf(state.sent, 0);
    assert.isTrue(input(state, key("z", "KeyZ", true)));
    assert.isTrue(input(state, key("ArrowUp", "ArrowUp")));
    assert.lengthOf(state.sent, 1);
  });

  it("does not replay into an unfocused window or interfere with composition", async function () {
    const state = fixtures();
    let focused = true;
    const disposable = mount(state, { isWindowFocused: () => focused });
    state.sync(snapshot());
    input(state, key("z", "KeyZ", true));
    focused = false;
    disposable.clear();
    assert.isFalse(input(state, key("ArrowUp", "ArrowUp")));
    focused = true;
    state.sync(snapshot());
    input(state, key("z", "KeyZ", true));
    assert.isFalse(input(state, { ...key("a", "KeyA"), isComposing: true }));
    await settle();
    assert.lengthOf(state.replayed, 0);
    assert.lengthOf(state.sent, 0);
  });

  it("exposes native frame diagnostics only to top-level spec renderers", function () {
    const normal = fixtures();
    mount(normal);
    assert.isFalse(normal.sync({ type: "focused-frame-info" }).ok);
    const spec = fixtures(10);
    mount(spec, { testing: true });
    const info = spec.sync({ type: "focused-frame-info" });
    assert.isTrue(info.ok);
    assert.isFalse(info.isMainFrame);
    assert.strictEqual(info.focusedFrameId, spec.child.frameTreeNodeId);
    assert.isFalse(spec.sync({ type: "focused-frame-info" }, spec.child).ok);
  });

  it("shares one state listener across windows and removes it after final disposal", function () {
    const a = fixtures();
    const b = fixtures(20);
    b.options.ipcMain = a.ipcMain;
    const first = mount(a);
    const second = mount(b);
    assert.strictEqual(a.ipcMain.listenerCount(attach.STATE_CHANNEL), 1);
    first.dispose();
    assert.strictEqual(a.ipcMain.listenerCount(attach.STATE_CHANNEL), 1);
    second.dispose();
    assert.strictEqual(a.ipcMain.listenerCount(attach.STATE_CHANNEL), 0);
    assert.strictEqual(a.contents.listenerCount("before-input-event"), 0);
    assert.strictEqual(b.contents.listenerCount("before-input-event"), 0);
  });
});
