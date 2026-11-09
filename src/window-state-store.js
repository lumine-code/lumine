const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WRITE_INTERVAL_MS = 100;
const MAX_COORDINATE = 0x7fffffff;

function validBounds(bounds) {
  return (
    bounds != null &&
    ["x", "y", "width", "height"].every(
      (key) => Number.isInteger(bounds[key]) && Math.abs(bounds[key]) <= MAX_COORDINATE,
    ) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function normalizeState(state) {
  if (
    !validBounds(state?.bounds) ||
    typeof state.maximized !== "boolean" ||
    typeof state.fullScreen !== "boolean"
  )
    return null;
  const { x, y, width, height } = state.bounds;
  return {
    bounds: { x, y, width, height },
    maximized: state.maximized,
    fullScreen: state.fullScreen,
  };
}

// Geometry belongs to the native window identity, independently of documents.
// Each identity has its own atomic file, so one closing window cannot overwrite
// another window's state or leave a partially written profile-wide document.
module.exports = class WindowStateStore {
  #controllers = new Map();

  constructor({ directory, displayService, onError } = {}) {
    if (typeof directory !== "string" || !directory)
      throw new TypeError("A window state directory is required");
    this.directory = directory;
    this.displayService = displayService;
    this.onError =
      onError ??
      ((error, name) => console.error(`Unable to persist window state for ${name}`, error));
  }

  pathForName(name) {
    if (typeof name !== "string" || !name)
      throw new TypeError("A window state identity is required");
    const digest = crypto.createHash("sha256").update(name).digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }

  read(name) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(this.pathForName(name), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    if (record?.version !== 1 || record.name !== name) return null;
    return normalizeState(record);
  }

  write(name, state) {
    const normalized = normalizeState(state);
    if (!normalized) throw new TypeError("Invalid window state");
    const destination = this.pathForName(name);
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, name, ...normalized }), {
        encoding: "utf8",
        flag: "wx",
      });
      fs.renameSync(temporary, destination);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The original write/rename error is the useful failure to report.
      }
      throw error;
    }
  }

  clear(name) {
    this.#controllers.get(name)?.discard();
    try {
      fs.unlinkSync(this.pathForName(name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  clampBounds(bounds) {
    const area = this.displayService?.getDisplayMatching?.(bounds)?.workArea;
    if (!validBounds(area)) return { ...bounds };
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    return {
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
      width,
      height,
    };
  }

  getWindowOptions(name) {
    const state = this.#readForRestore(name);
    return state && this.clampBounds(state.bounds);
  }

  #readForRestore(name) {
    try {
      return this.read(name);
    } catch (error) {
      this.onError(error, name);
      return null;
    }
  }

  track(window, name) {
    this.pathForName(name);
    // A replacement generation must not be overwritten by its retired window's
    // delayed writes or eventual `closed` event.
    this.#controllers.get(name)?.controller.dispose();
    const saved = this.#readForRestore(name);
    if (saved) saved.bounds = this.clampBounds(saved.bounds);
    let entry;
    entry = createController(this, window, name, saved, () => {
      if (this.#controllers.get(name) === entry) this.#controllers.delete(name);
    });
    this.#controllers.set(name, entry);
    return entry.controller;
  }
};

function createController(store, window, name, saved, onDispose) {
  let state = saved;
  let lastWritten = saved && JSON.stringify(saved);
  let timer;
  let frozen = false;
  let disposed = false;
  let restoreCalled = false;
  let pendingRestore = Boolean(saved);
  let applyingRestore = false;
  const listeners = [];
  const isDestroyed = () => window.isDestroyed?.() === true;
  const report = (error) => store.onError(error, name);
  const cancelWrite = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const mode = (method) => window[method]?.() === true;

  const restoredModeMatches = () => {
    if (saved.fullScreen) return mode("isFullScreen");
    return !mode("isFullScreen") && mode("isMaximized") === saved.maximized;
  };

  const capture = () => {
    if (frozen || disposed || isDestroyed()) return;
    // Some native backends replace their restored rectangle while minimizing a
    // maximized window. Keep the entire last visible state until it is restored.
    if (mode("isMinimized")) return;
    if (pendingRestore) {
      if (!restoreCalled || applyingRestore || !restoredModeMatches()) return;
      pendingRestore = false;
    }
    // Fullscreen transitions can expose a frame-adjusted or maximized native
    // restored rectangle. The last normal rectangle remains authoritative.
    const fullScreen = mode("isFullScreen");
    let bounds =
      fullScreen && state ? state.bounds : (window.getNormalBounds?.() ?? window.getBounds?.());
    if (!bounds && window.getPosition && window.getSize) {
      const [x, y] = window.getPosition();
      const [width, height] = window.getSize();
      bounds = { x, y, width, height };
    }
    if (!validBounds(bounds)) bounds = state?.bounds;
    if (!bounds) return;
    state = {
      bounds: { ...bounds },
      // Fullscreen can temporarily clear the native maximized flag. Retain the
      // backing window's mode so leaving fullscreen restores the same surface.
      maximized: fullScreen ? (state?.maximized ?? mode("isMaximized")) : mode("isMaximized"),
      fullScreen,
    };
  };

  const flush = () => {
    cancelWrite();
    if (!state) return;
    const serialized = JSON.stringify(state);
    if (serialized === lastWritten) return;
    try {
      store.write(name, state);
      lastWritten = serialized;
    } catch (error) {
      report(error);
    }
  };

  const changed = (immediate) => {
    if (frozen || disposed) return;
    try {
      capture();
      if (pendingRestore) return;
      if (immediate) flush();
      else if (!timer) {
        timer = setTimeout(flush, WRITE_INTERVAL_MS);
        timer.unref?.();
      }
    } catch (error) {
      report(error);
    }
  };

  const stop = (save) => {
    if (disposed) return;
    if (save) flush();
    disposed = true;
    cancelWrite();
    for (const [event, listener] of listeners) window.removeListener(event, listener);
    onDispose();
  };

  const controller = {
    restore() {
      if (restoreCalled || frozen || disposed || isDestroyed()) return;
      restoreCalled = true;
      if (!saved) return;
      applyingRestore = true;
      try {
        if (saved.maximized && !mode("isMaximized")) window.maximize?.();
        if (saved.fullScreen !== mode("isFullScreen")) window.setFullScreen?.(saved.fullScreen);
        if (!saved.maximized && !saved.fullScreen && mode("isMaximized")) window.unmaximize?.();
      } catch (error) {
        pendingRestore = false;
        report(error);
      } finally {
        applyingRestore = false;
      }
      capture();
    },
    freeze() {
      if (frozen || disposed) return;
      try {
        capture();
      } catch (error) {
        report(error);
      }
      frozen = true;
      flush();
    },
    dispose() {
      // Closed HWNDs have invalid bounds. The event cache or pre-hide freeze
      // is authoritative here, including on the forced-destroy path.
      stop(true);
    },
  };

  const listen = (event, listener) => {
    window.on(event, listener);
    listeners.push([event, listener]);
  };
  for (const event of ["move", "resize"]) listen(event, () => changed(false));
  for (const event of [
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
    "restore",
  ])
    listen(event, () => changed(true));
  listen("closed", controller.dispose);
  // Native restoration may still be deferred until Show(). Capture memory now,
  // but never replace native fallback state merely by constructing a window.
  try {
    capture();
  } catch (error) {
    report(error);
  }
  return { controller, discard: () => stop(false) };
}
