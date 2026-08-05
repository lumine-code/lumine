// The settings most recently opened from the Search panel, newest first.
//
// State lives here rather than on a panel because the Search panel is rebuilt
// whenever the Settings view is closed and reopened, and the list has to outlive
// that. `main.js` round-trips it through the package's `initialize`/`serialize`
// pair so it also survives a window reload.
const MAX_RECENT_SETTINGS = 10;

let paths = [];

module.exports = {
  // Move a key path to the front of the list, dropping any earlier visit to the
  // same setting so a path never appears twice.
  add(keyPath) {
    if (typeof keyPath !== "string" || !keyPath) return;
    paths = [keyPath, ...paths.filter((path) => path !== keyPath)].slice(0, MAX_RECENT_SETTINGS);
  },

  getPaths() {
    return paths.slice();
  },

  clear() {
    paths = [];
  },

  serialize() {
    return paths.slice();
  },

  // Replaces the list — `initialize` runs again after a disable/enable cycle, so
  // appending here would double every entry.
  load(state) {
    const stored = Array.isArray(state) ? state : [];
    const valid = stored.filter((path) => typeof path === "string" && path);
    paths = [...new Set(valid)].slice(0, MAX_RECENT_SETTINGS);
  },
};
