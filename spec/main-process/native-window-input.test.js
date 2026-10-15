/* globals assert */
const { EventEmitter } = require("events");
const attachNativeWindowInput = require("../../src/native-window-input");

function fixture() {
  const window = new EventEmitter();
  const hooks = new Map();
  const unhooked = [];
  let destroyed = false;
  window.isDestroyed = () => destroyed;
  window.hookWindowMessage = (message, callback) => hooks.set(message, callback);
  window.isWindowMessageHooked = (message) => hooks.has(message);
  window.unhookWindowMessage = (message) => {
    assert.isFalse(destroyed);
    unhooked.push(message);
    hooks.delete(message);
  };
  const mouseDown = (message, hitTest = 2) => {
    const wParam = Buffer.alloc(8);
    wParam.writeUInt32LE(hitTest);
    return hooks.get(message)?.(wParam, Buffer.alloc(8));
  };
  const childMouseDown = (message = 0x0201, x = 320, y = 18, childId = 0) => {
    const wParam = Buffer.alloc(8);
    wParam.writeUInt16LE(message);
    wParam.writeUInt16LE(childId, 2);
    const lParam = Buffer.alloc(8);
    lParam.writeInt16LE(x);
    lParam.writeInt16LE(y, 2);
    return hooks.get(0x0210)?.(wParam, lParam);
  };
  const destroy = () => {
    destroyed = true;
    hooks.clear();
    window.emit("closed");
  };
  return { window, hooks, unhooked, mouseDown, childMouseDown, destroy };
}

describe("native window input", function () {
  it("observes each caption button press without consuming native window actions", function () {
    const state = fixture();
    let calls = 0;
    const disposable = attachNativeWindowInput(
      state.window,
      () => {
        calls++;
        return true;
      },
      { platform: "win32" },
    );
    try {
      for (const message of [0x00a1, 0x00a3, 0x00a4, 0x00a6, 0x00a7, 0x00a9]) {
        assert.isUndefined(state.mouseDown(message));
      }
      assert.strictEqual(calls, 6);
    } finally {
      disposable.dispose();
    }
  });

  it("ignores resize borders and other non-caption hit tests", function () {
    const state = fixture();
    let calls = 0;
    const disposable = attachNativeWindowInput(state.window, () => calls++, {
      platform: "win32",
    });
    try {
      for (const hitTest of [0, 1, 10, 12, 20]) state.mouseDown(0x00a1, hitTest);
      assert.strictEqual(calls, 0);
      state.mouseDown(0x00a1);
      assert.strictEqual(calls, 1);
    } finally {
      disposable.dispose();
    }
  });

  it("observes child-window button presses even when caption hooks are bypassed", function () {
    const state = fixture();
    const points = [];
    const disposable = attachNativeWindowInput(state.window, (point) => points.push(point), {
      platform: "win32",
    });
    try {
      for (const message of [0x0201, 0x0204, 0x0207]) {
        assert.isUndefined(state.childMouseDown(message, 320, 18, 0xabcd));
      }
      // Windows normalizes both non-client presses and the second press of a
      // double-click to WM_LBUTTONDOWN in WM_PARENTNOTIFY.
      state.childMouseDown(0x0201, 321, 19);
      assert.deepEqual(points, [
        { x: 320, y: 18 },
        { x: 320, y: 18 },
        { x: 320, y: 18 },
        { x: 321, y: 19 },
      ]);
    } finally {
      disposable.dispose();
    }
  });

  it("retains signed child-window coordinates and ignores unrelated parent notifications", function () {
    const state = fixture();
    const points = [];
    const disposable = attachNativeWindowInput(state.window, (point) => points.push(point), {
      platform: "win32",
    });
    try {
      for (const message of [0x0001, 0x0002, 0x0200, 0x0202, 0x0245]) {
        state.childMouseDown(message);
      }
      assert.lengthOf(points, 0);
      state.childMouseDown(0x0201, -4, -12);
      assert.deepEqual(points, [{ x: -4, y: -12 }]);
    } finally {
      disposable.dispose();
    }
  });

  it("preserves another owner's hook and only removes its own hooks on disposal", function () {
    const state = fixture();
    const otherHook = () => {};
    state.window.hookWindowMessage(0x00a1, otherHook);
    const disposable = attachNativeWindowInput(state.window, () => {}, { platform: "win32" });
    assert.strictEqual(state.hooks.get(0x00a1), otherHook);
    assert.strictEqual(state.window.listenerCount("closed"), 1);
    const retainedCallback = state.hooks.get(0x00a4);
    disposable.dispose();
    disposable.dispose();
    assert.strictEqual(state.hooks.size, 1);
    assert.strictEqual(state.hooks.get(0x00a1), otherHook);
    assert.deepEqual(state.unhooked, [0x00a3, 0x00a4, 0x00a6, 0x00a7, 0x00a9, 0x0210]);
    assert.strictEqual(state.window.listenerCount("closed"), 0);
    assert.isUndefined(retainedCallback(Buffer.alloc(8), Buffer.alloc(8)));
  });

  it("preserves another owner's parent hook and stops retained child callbacks on disposal", function () {
    const state = fixture();
    const otherHook = () => {};
    state.window.hookWindowMessage(0x0210, otherHook);
    const disposable = attachNativeWindowInput(state.window, () => {}, { platform: "win32" });
    assert.strictEqual(state.hooks.get(0x0210), otherHook);
    disposable.dispose();
    assert.strictEqual(state.hooks.get(0x0210), otherHook);

    const otherState = fixture();
    let calls = 0;
    const otherDisposable = attachNativeWindowInput(otherState.window, () => calls++, {
      platform: "win32",
    });
    const retainedCallback = otherState.hooks.get(0x0210);
    otherDisposable.dispose();
    const wParam = Buffer.alloc(8);
    wParam.writeUInt16LE(0x0201);
    retainedCallback(wParam, Buffer.alloc(8));
    assert.strictEqual(calls, 0);
    assert.strictEqual(otherState.hooks.size, 0);
  });

  it("stops notifications and removes its listener when the native window is destroyed", function () {
    const state = fixture();
    let calls = 0;
    const disposable = attachNativeWindowInput(state.window, () => calls++, {
      platform: "win32",
    });
    const retainedCallback = state.hooks.get(0x00a1);
    state.destroy();
    disposable.dispose();
    const wParam = Buffer.alloc(8);
    wParam.writeUInt32LE(2);
    retainedCallback(wParam, Buffer.alloc(8));
    assert.strictEqual(calls, 0);
    assert.lengthOf(state.unhooked, 0);
    assert.strictEqual(state.window.listenerCount("closed"), 0);
  });

  it("leaves Windows hooks untouched on other platforms", function () {
    for (const platform of ["darwin", "linux"]) {
      const state = fixture();
      const disposable = attachNativeWindowInput(state.window, () => {}, { platform });
      assert.strictEqual(state.hooks.size, 0);
      assert.strictEqual(state.window.listenerCount("closed"), 0);
      disposable.dispose();
    }
  });

  it("accepts test windows without native hook APIs and already destroyed windows", function () {
    for (const window of [undefined, new EventEmitter(), { isDestroyed: () => true }]) {
      const disposable = attachNativeWindowInput(window, () => {}, { platform: "win32" });
      disposable.dispose();
      disposable.dispose();
    }
  });
});
