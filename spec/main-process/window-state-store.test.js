const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const WindowStateStore = require("../../src/window-state-store");

const INITIAL_BOUNDS = { x: 120, y: 80, width: 900, height: 700 };
const snapshot = (overrides = {}) => ({
  bounds: { ...INITIAL_BOUNDS },
  maximized: false,
  fullScreen: false,
  ...overrides,
});

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-window-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WindowStateStore({
    directory,
    displayService: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    ...options,
  });
  return store;
}

class NativeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.normalBounds = { ...INITIAL_BOUNDS, ...options.bounds };
    this.maximized = false;
    this.fullScreen = false;
    this.kiosk = false;
    this.minimized = false;
    this.destroyed = false;
    this.calls = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  assertLive() {
    assert.equal(this.destroyed, false, "A destroyed native window was queried");
  }

  getNormalBounds() {
    this.assertLive();
    return { ...this.normalBounds };
  }

  isMaximized() {
    this.assertLive();
    return this.maximized;
  }

  isFullScreen() {
    this.assertLive();
    return this.fullScreen;
  }

  isKiosk() {
    this.assertLive();
    return this.kiosk;
  }

  isMinimized() {
    this.assertLive();
    return this.minimized;
  }

  maximize() {
    this.calls.push("maximize");
    this.maximized = true;
    this.emit("resize");
    this.emit("maximize");
  }

  unmaximize() {
    this.calls.push("unmaximize");
    this.maximized = false;
    this.emit("resize");
    this.emit("unmaximize");
  }

  setFullScreen(value) {
    this.calls.push(["setFullScreen", value]);
    this.completeFullScreen(value);
  }

  completeFullScreen(value) {
    this.fullScreen = value;
    this.emit("resize");
    this.emit(value ? "enter-full-screen" : "leave-full-screen");
  }

  setKiosk(value) {
    this.calls.push(["setKiosk", value]);
    this.kiosk = value;
    this.completeFullScreen(value);
  }

  changeBounds(bounds, event = "resize") {
    Object.assign(this.normalBounds, bounds);
    this.emit(event);
  }

  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}

test("records are independent, versioned and addressed by a hash of the exact name", (t) => {
  const store = fixture(t);
  const name = "../../outside-profile";
  assert.equal(store.read(name), null);
  store.write(name, snapshot());
  store.write("other", snapshot({ maximized: true }));

  const expected = `${crypto.createHash("sha256").update(name).digest("hex")}.json`;
  assert.equal(path.basename(store.pathForName(name)), expected);
  assert.equal(path.dirname(store.pathForName(name)), store.directory);
  assert.equal(fs.readdirSync(store.directory).length, 2);
  assert.deepEqual(store.read(name), snapshot());
  assert.equal(store.read("other").maximized, true);
  const record = JSON.parse(fs.readFileSync(store.pathForName(name), "utf8"));
  assert.equal(record.version, 1);
  assert.equal(record.name, name);
  store.clear(name);
  store.clear(name);
  assert.equal(store.read(name), null);
  assert.equal(store.read("other").maximized, true);
});

test("failed atomic replacement preserves the old complete record and removes temporary files", (t) => {
  const store = fixture(t);
  store.write("workspace", snapshot());
  const failure = Object.assign(new Error("Cannot replace state"), { code: "EACCES" });
  t.mock.method(fs, "renameSync", () => {
    throw failure;
  });

  assert.throws(() => store.write("workspace", snapshot({ maximized: true })), failure);
  assert.deepEqual(store.read("workspace"), snapshot());
  assert.deepEqual(fs.readdirSync(store.directory), [
    path.basename(store.pathForName("workspace")),
  ]);
});

test("unreadable files throw while malformed, foreign and invalid records are ignored", (t) => {
  const store = fixture(t);
  const file = store.pathForName("workspace");
  for (const record of [
    "{",
    JSON.stringify({ version: 2, name: "workspace", ...snapshot() }),
    JSON.stringify({ version: 1, name: "other", ...snapshot() }),
    JSON.stringify({ version: 1, name: "workspace", ...snapshot({ maximized: "yes" }) }),
    JSON.stringify({
      version: 1,
      name: "workspace",
      ...snapshot({ bounds: { ...INITIAL_BOUNDS, width: 0 } }),
    }),
    JSON.stringify({
      version: 1,
      name: "workspace",
      ...snapshot({ bounds: { ...INITIAL_BOUNDS, x: Infinity } }),
    }),
  ]) {
    fs.writeFileSync(file, record);
    assert.equal(store.getWindowOptions("workspace"), null);
  }
  assert.throws(
    () => store.write("workspace", snapshot({ bounds: { ...INITIAL_BOUNDS, y: 0.5 } })),
    TypeError,
  );
  const failure = Object.assign(new Error("Cannot read state"), { code: "EACCES" });
  t.mock.method(fs, "readFileSync", () => {
    throw failure;
  });
  assert.throws(() => store.read("workspace"), failure);
});

test("restored rectangles fit the selected work area, including a negative-position monitor", (t) => {
  const supplied = [];
  const store = fixture(t, {
    displayService: {
      getDisplayMatching(bounds) {
        supplied.push(bounds);
        return { workArea: { x: -1920, y: 40, width: 1920, height: 1000 } };
      },
    },
  });
  store.write("workspace", snapshot({ bounds: { x: 8000, y: -3000, width: 2500, height: 1200 } }));

  assert.deepEqual(store.getWindowOptions("workspace"), {
    x: -1920,
    y: 40,
    width: 1920,
    height: 1000,
  });
  assert.deepEqual(supplied, [{ x: 8000, y: -3000, width: 2500, height: 1200 }]);
  assert.deepEqual(store.read("workspace").bounds, {
    x: 8000,
    y: -3000,
    width: 2500,
    height: 1200,
  });
});

test("closing a clamped restored window commits its adjusted rectangle to disk", (t) => {
  const store = fixture(t);
  store.write("workspace", snapshot({ bounds: { ...INITIAL_BOUNDS, x: 3000, y: 1600 } }));
  const adjusted = { ...INITIAL_BOUNDS, x: 1020, y: 380 };
  assert.deepEqual(store.getWindowOptions("workspace"), adjusted);
  const window = new NativeWindow({ bounds: adjusted });
  const controller = store.track(window, "workspace");
  controller.restore();
  controller.freeze();
  controller.dispose();

  assert.deepEqual(store.read("workspace").bounds, adjusted);
});

test("an unreadable optional snapshot reports errors and permits native restoration and tracking", (t) => {
  const failures = [];
  const store = fixture(t, { onError: (error, name) => failures.push({ error, name }) });
  fs.mkdirSync(store.pathForName("workspace"));
  assert.throws(() => store.read("workspace"));
  assert.equal(store.getWindowOptions("workspace"), null);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  assert.equal(failures.length, 2);

  assert.doesNotThrow(controller.restore);
  assert.doesNotThrow(() => window.maximize());
  assert.doesNotThrow(controller.freeze);
  assert.doesNotThrow(controller.dispose);

  assert.equal(failures.length, 5);
  assert.ok(failures.every((entry) => entry.error.code && entry.name === "workspace"));
  assert.deepEqual(fs.readdirSync(store.directory), [
    path.basename(store.pathForName("workspace")),
  ]);
  assert.equal(window.eventNames().length, 0);
});

test("native migration does not write an initial normal snapshot before the window is shown", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);

  controller.restore();
  assert.equal(store.read("workspace"), null);
  window.maximize();
  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true }));
});

test("move and resize writes coalesce, but close freezes the latest bounds synchronously", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = fixture(t);
  const write = t.mock.method(store, "write");
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);

  window.changeBounds({ x: 200 }, "move");
  window.changeBounds({ y: 150 }, "move");
  window.changeBounds({ width: 1100 });
  assert.equal(write.mock.callCount(), 0);
  t.mock.timers.tick(100);
  assert.equal(write.mock.callCount(), 1);
  window.changeBounds({ height: 750 });
  controller.freeze();

  assert.deepEqual(store.read("workspace").bounds, { x: 200, y: 150, width: 1100, height: 750 });
  assert.equal(write.mock.callCount(), 2);
  t.mock.timers.tick(1000);
  assert.equal(write.mock.callCount(), 2);
});

test("immediate maximize and unmaximize persist their new mode and exact normal rectangle", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const first = store.track(window, "workspace");
  window.changeBounds({ width: 1110, height: 760 });
  window.maximize();
  first.freeze();
  first.dispose();
  assert.deepEqual(
    store.read("workspace"),
    snapshot({ bounds: { ...INITIAL_BOUNDS, width: 1110, height: 760 }, maximized: true }),
  );

  const reopened = new NativeWindow({ bounds: store.getWindowOptions("workspace") });
  const second = store.track(reopened, "workspace");
  t.after(second.dispose);
  second.restore();
  second.restore();
  assert.deepEqual(reopened.calls, ["maximize"]);
  reopened.unmaximize();
  second.freeze();
  assert.equal(store.read("workspace").maximized, false);
  assert.deepEqual(store.read("workspace").bounds, { ...INITIAL_BOUNDS, width: 1110, height: 760 });
});

test("a frozen snapshot survives hidden teardown events and disposal of a destroyed window", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  window.maximize();
  controller.freeze();
  window.maximized = false;
  window.changeBounds({ width: 0, height: 0 });
  window.emit("unmaximize");
  controller.freeze();
  window.destroy();
  controller.dispose();

  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true }));
  assert.equal(window.eventNames().length, 0);
});

test("minimizing a maximized window retains the last non-minimized display mode", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);
  window.maximize();
  window.minimized = true;
  window.maximized = false;
  window.emit("minimize");
  window.emit("unmaximize");
  controller.freeze();

  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true }));
});

test("minimized native bounds cannot replace the last non-minimized normal rectangle", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  window.maximize();
  window.minimized = true;
  window.maximized = false;
  window.normalBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const readBounds = t.mock.method(window, "getNormalBounds");
  window.emit("resize");
  controller.freeze();
  controller.dispose();

  assert.equal(readBounds.mock.callCount(), 0);
  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true }));
});

test("stable maximized resizes cannot replace cached normal bounds with the work area", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  window.maximize();
  window.normalBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const readBounds = t.mock.method(window, "getNormalBounds");
  window.emit("resize");
  controller.freeze();
  controller.dispose();

  assert.equal(readBounds.mock.callCount(), 0);
  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true }));
});

test("entering maximization still captures a newly changed normal rectangle", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  window.normalBounds = { ...INITIAL_BOUNDS, width: 1110, height: 760 };
  window.maximize();
  controller.freeze();
  controller.dispose();

  assert.deepEqual(
    store.read("workspace"),
    snapshot({ bounds: { ...INITIAL_BOUNDS, width: 1110, height: 760 }, maximized: true }),
  );
});

test("fullscreen native bounds cannot replace the cached normal rectangle", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  window.maximize();
  window.normalBounds = { x: -1, y: -8, width: 1922, height: 1091 };
  const readBounds = t.mock.method(window, "getNormalBounds");
  window.completeFullScreen(true);
  controller.freeze();
  controller.dispose();

  assert.equal(readBounds.mock.callCount(), 0);
  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true, fullScreen: true }));
});

test("saved maximized intent survives startup resize events and an unfinished asynchronous restore", (t) => {
  const store = fixture(t);
  store.write("workspace", snapshot({ maximized: true }));
  const window = new NativeWindow();
  window.maximize = () => window.calls.push("maximize");
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);
  window.changeBounds({ width: 500 });
  controller.restore();
  controller.restore();
  window.emit("resize");
  controller.freeze();

  assert.deepEqual(window.calls, ["maximize"]);
  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true }));
});

test("fullscreen restoration preserves intent until its native transition completes", (t) => {
  const store = fixture(t);
  store.write("workspace", snapshot({ maximized: true, fullScreen: true }));
  const window = new NativeWindow();
  window.setFullScreen = (value) => window.calls.push(["setFullScreen", value]);
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);
  controller.restore();
  window.emit("resize");
  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true, fullScreen: true }));
  window.completeFullScreen(true);
  window.maximized = false;
  window.emit("resize");
  controller.freeze();

  assert.deepEqual(window.calls, ["maximize", ["setFullScreen", true]]);
  assert.deepEqual(store.read("workspace"), snapshot({ maximized: true, fullScreen: true }));
});

test("closing before asynchronous fullscreen restore finishes keeps its saved intent", (t) => {
  const store = fixture(t);
  store.write("workspace", snapshot({ fullScreen: true }));
  const window = new NativeWindow();
  window.setFullScreen = () => {};
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);
  controller.restore();
  window.changeBounds({ width: 600 });
  controller.freeze();

  assert.deepEqual(store.read("workspace"), snapshot({ fullScreen: true }));
});

test("ordinary fullscreen ignores native kiosk aliases and unknown kiosk metadata", (t) => {
  const store = fixture(t);
  fs.writeFileSync(
    store.pathForName("workspace"),
    JSON.stringify({
      version: 1,
      name: "workspace",
      ...snapshot({ fullScreen: true }),
      kiosk: "ignored",
    }),
  );
  const window = new NativeWindow();
  const readKiosk = t.mock.method(window, "isKiosk", () => {
    throw new Error("Kiosk aliases cannot distinguish ordinary fullscreen");
  });
  const setKiosk = t.mock.method(window, "setKiosk", () => {
    throw new Error("Restoring ordinary fullscreen must not request kiosk mode");
  });
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);
  controller.restore();
  controller.freeze();

  assert.deepEqual(window.calls, [["setFullScreen", true]]);
  assert.equal(readKiosk.mock.callCount(), 0);
  assert.equal(setKiosk.mock.callCount(), 0);
  assert.deepEqual(store.read("workspace"), snapshot({ fullScreen: true }));
  store.write("workspace", store.read("workspace"));
  assert.equal(
    Object.hasOwn(JSON.parse(fs.readFileSync(store.pathForName("workspace"), "utf8")), "kiosk"),
    false,
  );
});

test("a vetoed close does not freeze subsequent bounds or display-mode changes", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  t.after(controller.dispose);
  window.emit("close", { defaultPrevented: true });
  window.changeBounds({ x: 250 });
  window.maximize();
  controller.freeze();

  assert.deepEqual(
    store.read("workspace"),
    snapshot({ bounds: { ...INITIAL_BOUNDS, x: 250 }, maximized: true }),
  );
});

test("closed flushes cached bounds without querying the destroyed native object", (t) => {
  const store = fixture(t);
  const window = new NativeWindow();
  store.track(window, "workspace");
  window.changeBounds({ x: 300, width: 1000 });
  window.destroy();

  assert.deepEqual(store.read("workspace").bounds, { ...INITIAL_BOUNDS, x: 300, width: 1000 });
  assert.equal(window.eventNames().length, 0);
});

test("a replacement generation cannot be overwritten by an older pending timer or close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = fixture(t);
  const first = new NativeWindow();
  const retired = store.track(first, "workspace");
  first.changeBounds({ x: 200 });
  const second = new NativeWindow({ bounds: { x: 200 } });
  const current = store.track(second, "workspace");
  t.after(current.dispose);
  current.restore();
  second.changeBounds({ x: 400 });
  current.freeze();
  first.changeBounds({ x: 800 });
  retired.freeze();
  first.destroy();
  t.mock.timers.tick(1000);

  assert.equal(store.read("workspace").bounds.x, 400);
});

test("clear retires pending writers so a reset cannot resurrect an old record", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = fixture(t);
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  window.changeBounds({ x: 300 });
  store.clear("workspace");
  window.maximize();
  controller.freeze();
  controller.dispose();
  t.mock.timers.tick(1000);

  assert.equal(store.read("workspace"), null);
  assert.equal(window.eventNames().length, 0);
});

test("automatic write failures are reported while explicit operations still throw", (t) => {
  const failures = [];
  const store = fixture(t, { onError: (error, name) => failures.push({ error, name }) });
  const window = new NativeWindow();
  const controller = store.track(window, "workspace");
  const failure = Object.assign(new Error("State disk is unavailable"), { code: "ENOSPC" });
  t.mock.method(store, "write", () => {
    throw failure;
  });

  assert.doesNotThrow(() => window.maximize());
  assert.doesNotThrow(controller.freeze);
  assert.throws(() => store.write("workspace", snapshot()), failure);
  controller.dispose();
  assert.equal(failures.length, 3);
  assert.ok(failures.every((entry) => entry.error === failure && entry.name === "workspace"));
});
