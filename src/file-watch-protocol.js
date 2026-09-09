// Shared by the main process, renderers and the DOM-free watcher worker.
const VERSION = 1;
const MAX_QUEUED_EVENTS = 4096;
const MAX_PENDING_REQUESTS = 4096;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Closing an unused handle must not cause an unhandled rejection. Attaching
  // this observer does not change the rejection seen by callers awaiting ready.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function abortError(path) {
  return Object.assign(new Error(`File observation cancelled: ${path}`), {
    name: "AbortError",
    code: "ABORT_ERR",
    path,
  });
}

function serializeError(error, path) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || "ERR_FILE_WATCH",
    path: error?.path || path,
    backend: error?.backend,
    stack: error?.stack,
  };
}

function deserializeError(error) {
  return Object.assign(new Error(error?.message || "File observation failed"), error);
}

// Preserve membership transitions while batching. Keeping only the last
// action turns a create followed by a write into an update of a path that
// indexes have never seen. Return the change in queue size for bounded queues.
function mergeChange(events, event) {
  const previous = events.get(event.path);
  if (!previous) {
    events.set(event.path, event);
    return 1;
  }
  if (previous.action === "created" && event.action === "deleted") {
    events.delete(event.path);
    return -1;
  }
  let action = event.action;
  if (previous.action === "created") action = "created";
  else if (previous.action === "deleted") {
    action = event.action === "created" ? "updated" : "deleted";
  } else if (event.action === "created") action = "updated";
  events.set(event.path, { ...event, action });
  return 0;
}

module.exports = {
  VERSION,
  MAX_QUEUED_EVENTS,
  MAX_PENDING_REQUESTS,
  deferred,
  abortError,
  serializeError,
  deserializeError,
  mergeChange,
};
