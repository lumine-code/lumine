// Native persistence owns geometry; document snapshots only identify windows.
// Driven captures and hidden tests must never inherit or write desktop state.
function isWindowStatePersistenceEnabled(settings, env = process.env) {
  return !(
    settings.isSpec ||
    settings.headless ||
    settings.offscreen ||
    env.LUMINE_DISABLE_WINDOW_STATE_PERSISTENCE === "1"
  );
}

function windowStateOptions(name, { enabled, clear = false }, BrowserWindow) {
  if (!enabled) return {};
  if (clear) BrowserWindow.clearPersistedState(name);
  return { name, windowStatePersistence: true };
}

module.exports = { isWindowStatePersistenceEnabled, windowStateOptions };
