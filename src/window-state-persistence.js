// Core snapshots capture geometry before native teardown. Electron restores
// older identities until their first core snapshot has been captured.
// Driven captures and hidden tests must never inherit or write desktop state.
function isWindowStatePersistenceEnabled(settings, env = process.env) {
  return !(
    settings.isSpec ||
    settings.headless ||
    settings.offscreen ||
    env.LUMINE_DISABLE_WINDOW_STATE_PERSISTENCE === "1"
  );
}

function windowStateOptions(name, { enabled, clear = false, store }, BrowserWindow) {
  if (!enabled) return {};
  if (clear) {
    BrowserWindow.clearPersistedState(name);
    store?.clear(name);
  }
  const bounds = store?.getWindowOptions(name);
  if (bounds) return { name, ...bounds, windowStatePersistence: false };
  return { name, windowStatePersistence: true };
}

module.exports = { isWindowStatePersistenceEnabled, windowStateOptions };
