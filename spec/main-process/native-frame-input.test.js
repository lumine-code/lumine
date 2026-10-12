/* globals assert */
const { EventEmitter } = require("events");
const NativeFrameInput = require("../../src/native-frame-input");

function fixture() {
  const commands = [];
  const debuggerApi = new EventEmitter();
  let attached = false;
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => (attached = true);
  debuggerApi.detach = () => {
    attached = false;
    debuggerApi.emit("detach");
  };
  debuggerApi.sendCommand = async (method, parameters = {}, sessionId) => {
    commands.push({ method, parameters, sessionId });
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: sessionId ? "child" : "main" } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: sessionId ? 2 : 1 };
      case "Runtime.evaluate":
        return { result: { objectId: "native-focused-owner" } };
      case "DOM.describeNode":
        return { node: { nodeName: "IFRAME", frameId: "child" } };
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "child", type: "iframe", url: "same-widget-url" }] };
      case "Target.attachToTarget":
        return { sessionId: "child-session" };
      default:
        return {};
    }
  };
  const main = { frameTreeNodeId: 1, processId: 1 };
  const child = {
    frameTreeNodeId: 2,
    processId: 2,
    parent: main,
    isDestroyed: () => false,
    detached: false,
  };
  const contents = { debugger: debuggerApi, mainFrame: main, isDestroyed: () => false };
  return { commands, debuggerApi, child, contents };
}

describe("native frame input", function () {
  it("finds an opaque target through its native focused owner even when root frame tree omits it", async function () {
    const state = fixture();
    const native = new NativeFrameInput(state.contents);
    try {
      await native.replay(
        state.child,
        { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft" },
        () => true,
      );
      const delivered = state.commands.find((entry) => entry.method === "Input.dispatchKeyEvent");
      assert.strictEqual(delivered.sessionId, "child-session");
      assert.strictEqual(delivered.parameters.windowsVirtualKeyCode, 37);
      assert.isTrue(
        state.commands.some(
          (entry) =>
            entry.method === "Runtime.evaluate" &&
            entry.parameters.expression === "document.activeElement" &&
            entry.parameters.contextId === 1,
        ),
      );
      assert.isTrue(state.commands.some((entry) => entry.method === "Runtime.releaseObject"));
    } finally {
      native.dispose();
    }
  });

  it("rejects a stale owner before delivering any native input", async function () {
    const state = fixture();
    const native = new NativeFrameInput(state.contents);
    try {
      await assert.rejects(
        native.replay(state.child, { type: "keyDown", key: "g", code: "KeyG" }, () => false),
        /ownership changed/,
      );
      assert.isFalse(state.commands.some((entry) => entry.method === "Input.dispatchKeyEvent"));
    } finally {
      native.dispose();
    }
  });

  it("restores a printable key's text and permits trusted spec focus before the frame is focused", async function () {
    const state = fixture();
    const native = new NativeFrameInput(state.contents);
    try {
      await native.dispatchToSelector(
        "#opaque-widget",
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 20, y: 20, button: "left", clickCount: 1 },
        () => true,
      );
      await native.replay(state.child, { type: "keyDown", key: "g", code: "KeyG" }, () => true);
      const delivered = state.commands.find((entry) => entry.method === "Input.dispatchKeyEvent");
      assert.strictEqual(delivered.parameters.text, "g");
      assert.strictEqual(delivered.parameters.windowsVirtualKeyCode, 71);
      assert.strictEqual(delivered.sessionId, "child-session");
    } finally {
      native.dispose();
    }
  });
});
