const { Disposable } = require("@lumine-code/event-kit");

// Private model lifecycle: owners reconcile selection markers before history
// captures the committed marker state. No editor dependency enters TextBuffer.
const owners = new WeakMap();

function register(buffer, callback) {
  let state = owners.get(buffer);
  if (!state) owners.set(buffer, (state = { callbacks: new Set(), revision: null }));
  state.callbacks.add(callback);
  return new Disposable(() => {
    state.callbacks.delete(callback);
    if (!state.callbacks.size) owners.delete(buffer);
  });
}

function run(buffer, collectErrors = false) {
  const state = owners.get(buffer),
    errors = [];
  const revision = buffer.getTextRevision();
  if (!state || state.revision === revision || buffer.isDestroyed()) return errors;
  if (buffer.finalizingTransactionMarkers) throw new Error("Marker finalization cannot reenter");
  buffer.finalizingTransactionMarkers = true;
  try {
    for (const callback of state.callbacks) {
      if (buffer.isDestroyed()) break;
      try {
        callback();
      } catch (error) {
        errors.push(error);
        if (!collectErrors) throw error;
      }
    }
    if (!errors.length) state.revision = revision;
  } finally {
    buffer.finalizingTransactionMarkers = false;
  }
  return errors;
}

module.exports = { register, run };
