// Prepared input updates live marker indexes synchronously, then publishes
// their notifications against the completed text and selection state. Only
// markers actually notifying observers enter this queue.
const scopes = new WeakMap();

function begin(buffer) {
  if (scopes.has(buffer)) throw new Error("Marker event publication cannot be nested");
  const state = { queue: [], changes: new Map(), cursor: 0 };
  scopes.set(buffer, state);
  let disposed = false;
  return {
    flush(errors) {
      if (disposed) return;
      while (state.cursor < state.queue.length) {
        const callback = state.queue[state.cursor++];
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      }
      state.queue.length = 0;
      state.cursor = 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scopes.delete(buffer);
      state.queue.length = 0;
      state.changes.clear();
    },
  };
}

function defer(buffer, callback) {
  const state = scopes.get(buffer);
  if (!state) return false;
  state.queue.push(callback);
  return true;
}

function change(buffer, target, metadata, callback) {
  const state = scopes.get(buffer);
  if (!state) return false;
  const previous = state.changes.get(target);
  if (previous) {
    previous.textChanged ||= metadata.textChanged;
    previous.propertiesChanged ||= metadata.propertiesChanged;
    if (previous.origin !== metadata.origin) previous.origin = "mixed";
  } else {
    const entry = { ...metadata };
    state.changes.set(target, entry);
    state.queue.push(() => {
      state.changes.delete(target);
      if (!target.isDestroyed()) callback(entry);
    });
  }
  return true;
}

module.exports = { begin, defer, change };
