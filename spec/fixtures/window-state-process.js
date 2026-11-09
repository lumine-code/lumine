const assert = require("node:assert/strict");
const { app, BrowserWindow, screen } = require("electron");
const WindowStateStore = require("../../src/window-state-store");
const { windowStateOptions } = require("../../src/window-state-persistence");

const name = "lumine-window-restart-spec";
const stage = process.env.LUMINE_WINDOW_STATE_STAGE;
const bounds = {
  initial: { x: 120, y: 100, width: 720, height: 540 },
  resized: { x: 150, y: 120, width: 760, height: 560 },
  final: { x: 180, y: 140, width: 800, height: 580 },
};
app.setPath("userData", process.env.LUMINE_WINDOW_STATE_PROFILE);
app.on("window-all-closed", () => app.quit());

async function change(window, event, operation, complete) {
  if (complete()) return;
  await new Promise((resolve, reject) => {
    const events = [...new Set([event, "move", "resize"])];
    const cleanup = () => {
      clearTimeout(timeout);
      for (const name of events) window.removeListener(name, changed);
    };
    const changed = () => {
      if (complete()) {
        cleanup();
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Missing native ${event} event`));
    }, 10000);
    for (const name of events) window.on(name, changed);
    operation();
    changed();
  });
}

const matchesBounds = (window, expected) => {
  const actual = window.getNormalBounds();
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
};

app
  .whenReady()
  .then(async () => {
    const store = new WindowStateStore({
      directory: process.env.LUMINE_WINDOW_STATE_DIRECTORY,
      displayService: screen,
    });
    const window = new BrowserWindow({
      ...(stage === "initial" ? bounds.initial : { x: 16, y: 16, width: 400, height: 300 }),
      ...windowStateOptions(name, { enabled: true, store }, BrowserWindow),
      frame: false,
      focusable: false,
      show: false,
    });
    const state = store.track(window, name);
    await window.loadURL("about:blank");
    state.restore();
    window.showInactive();
    if (["unmaximize", "minimize", "final", "fullscreen"].includes(stage)) {
      await change(
        window,
        "maximize",
        () => {},
        () => window.isMaximized(),
      );
    }
    if (["verify-fullscreen", "leave-fullscreen"].includes(stage)) {
      await change(
        window,
        "enter-full-screen",
        () => {},
        () => window.isFullScreen(),
      );
    }
    const start = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    };
    if (stage === "maximize") {
      assert.deepEqual(start, { bounds: bounds.initial, maximized: false });
      await change(
        window,
        "maximize",
        () => window.maximize(),
        () => window.isMaximized(),
      );
    } else if (stage === "unmaximize") {
      assert.deepEqual(start, { bounds: bounds.initial, maximized: true });
      await change(
        window,
        "unmaximize",
        () => window.unmaximize(),
        () => !window.isMaximized(),
      );
    } else if (stage === "resize") {
      assert.deepEqual(start, { bounds: bounds.initial, maximized: false });
      await change(
        window,
        "resize",
        () => window.setBounds(bounds.resized),
        () => matchesBounds(window, bounds.resized),
      );
      assert.deepEqual(window.getNormalBounds(), bounds.resized);
    } else if (stage === "resize-maximize") {
      assert.deepEqual(start, { bounds: bounds.resized, maximized: false });
      await change(
        window,
        "resize",
        () => window.setBounds(bounds.final),
        () => matchesBounds(window, bounds.final),
      );
      await change(
        window,
        "maximize",
        () => window.maximize(),
        () => window.isMaximized(),
      );
    } else if (stage === "minimize") {
      assert.deepEqual(start, { bounds: bounds.final, maximized: true });
      await change(
        window,
        "minimize",
        () => window.minimize(),
        () => window.isMinimized(),
      );
    } else if (stage === "final") {
      assert.deepEqual(start, { bounds: bounds.final, maximized: true });
    } else if (stage === "fullscreen") {
      assert.deepEqual(start, { bounds: bounds.final, maximized: true });
      await change(
        window,
        "enter-full-screen",
        () => window.setFullScreen(true),
        () => window.isFullScreen(),
      );
    } else if (stage === "verify-fullscreen") {
      assert.deepEqual(store.read(name).bounds, bounds.final);
      assert.equal(window.isFullScreen(), true);
    } else if (stage === "leave-fullscreen") {
      await change(
        window,
        "leave-full-screen",
        () => window.setFullScreen(false),
        () => !window.isFullScreen(),
      );
      await change(
        window,
        "unmaximize",
        () => window.unmaximize(),
        () => !window.isMaximized(),
      );
      await change(
        window,
        "resize",
        () => {},
        () => matchesBounds(window, bounds.final),
      );
      assert.deepEqual(window.getNormalBounds(), bounds.final);
    } else if (stage === "verify-normal") {
      assert.deepEqual(start, { bounds: bounds.final, maximized: false });
    }
    // No persistence-settle delay: save and tear down in the same turn as the
    // observed native change, including a resize immediately before maximizing.
    state.freeze();
    assert.equal(Object.hasOwn(store.read(name), "kiosk"), false);
    console.log(`WINDOW_STATE_RESULT ${JSON.stringify({ stage, start, saved: store.read(name) })}`);
    window.close();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
