const assert = require("node:assert/strict");
const { app, BrowserWindow, screen } = require("electron");
const WindowStateStore = require("../../src/window-state-store");
const { windowStateOptions } = require("../../src/window-state-persistence");

const name = "lumine-window-restart-spec";
const stage = process.env.LUMINE_WINDOW_STATE_STAGE;
app.setPath("userData", process.env.LUMINE_WINDOW_STATE_PROFILE);
app.on("window-all-closed", () => app.quit());

async function change(window, event, operation, complete) {
  if (complete()) return;
  await new Promise((resolve, reject) => {
    const events = [...new Set([event, "move", "resize"])];
    let observed = event === "resize";
    const cleanup = () => {
      clearTimeout(timeout);
      for (const [name, listener] of listeners) window.removeListener(name, listener);
    };
    const changed = () => {
      if (observed && complete()) {
        cleanup();
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Missing native ${event} event`));
    }, 10000);
    const listeners = events.map((name) => [
      name,
      () => {
        if (name === event) observed = true;
        changed();
      },
    ]);
    for (const [name, listener] of listeners) window.on(name, listener);
    operation();
    if (event === "resize") changed();
  });
}

function modeEvent(window, event) {
  return change(
    window,
    event,
    () => {},
    () => (event === "maximize" ? window.isMaximized() : window.isFullScreen()),
  );
}

const matchesBounds = (window, expected) => {
  const actual = window.getNormalBounds();
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
};

app
  .whenReady()
  .then(async () => {
    const area = screen.getPrimaryDisplay().workArea;
    const rectangle = (inset, size) => ({
      x: area.x + Math.floor(area.width * inset),
      y: area.y + Math.floor(area.height * inset),
      width: Math.floor(area.width * size),
      height: Math.floor(area.height * size),
    });
    // Reuse the initial display's exact targets across every process and mode.
    const bounds = process.env.LUMINE_WINDOW_STATE_TARGET_BOUNDS
      ? JSON.parse(process.env.LUMINE_WINDOW_STATE_TARGET_BOUNDS)
      : {
          initial: rectangle(0.08, 0.5),
          resized: rectangle(0.1, 0.55),
          final: rectangle(0.12, 0.6),
        };
    const store = new WindowStateStore({
      directory: process.env.LUMINE_WINDOW_STATE_DIRECTORY,
      displayService: screen,
    });
    const window = new BrowserWindow({
      ...(stage === "initial" ? bounds.initial : { x: 16, y: 16, width: 400, height: 300 }),
      ...windowStateOptions(name, { enabled: true, store }, BrowserWindow),
      frame: false,
      // Non-focusable Linux windows bypass the window manager and cannot maximize.
      focusable: process.platform !== "win32",
      show: false,
    });
    const state = store.track(window, name);
    await window.loadURL("about:blank");
    const snapshot = store.read(name);
    const restored = snapshot?.fullScreen
      ? modeEvent(window, "enter-full-screen")
      : snapshot?.maximized
        ? modeEvent(window, "maximize")
        : Promise.resolve();
    state.restore();
    window.showInactive();
    await restored;
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
    console.log(
      `WINDOW_STATE_RESULT ${JSON.stringify({
        stage,
        start,
        targets: bounds,
        area,
        actual: {
          maximized: window.isMaximized(),
          fullScreen: window.isFullScreen(),
          minimized: window.isMinimized(),
          bounds: window.getNormalBounds(),
        },
        saved: store.read(name),
      })}`,
    );
    window.close();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
