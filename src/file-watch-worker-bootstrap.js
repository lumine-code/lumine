/* eslint n/no-process-exit: off */
// Plain CommonJS running in Electron's Node mode: no renderer globals or DOM.
const { enableCompileCache } = require("module");
enableCompileCache();

const {
  VERSION,
  MAX_QUEUED_EVENTS,
  serializeError,
  mergeChange,
} = require("./file-watch-protocol");
const FileWatchWorker = require("./file-watch-worker");
const { createFileWatchTrace, summarizeFileWatchPayload } = require("./file-watch-trace");
const trace = createFileWatchTrace("bootstrap");
const generation = Number(process.env.LUMINE_FILE_WATCH_GENERATION);
const controls = [];
const events = new Map();
let queuedEvents = 0;
let nextQueueIncident = 0;
let sending = false;
let closing = false;

function sendNext() {
  if (sending || !process.connected) return;
  let message = controls.shift();
  if (!message) {
    for (const [id, entry] of events) {
      if (entry.error) {
        message = { type: "event", id, eventType: "error", payload: entry.error };
        entry.error = null;
      } else if (entry.invalidate) {
        message = { type: "event", id, eventType: "invalidate", payload: entry.invalidate };
        entry.invalidate = null;
      } else {
        message = { type: "event", id, eventType: "changes", payload: [...entry.changes.values()] };
        queuedEvents -= entry.changes.size;
        entry.changes.clear();
      }
      if (!entry.error && !entry.invalidate && !entry.changes.size) events.delete(id);
      break;
    }
  }
  if (!message) return;
  trace?.("ipc-send", {
    generation,
    id: message.id,
    requestId: message.requestId,
    type: message.type,
    eventType: message.eventType,
    path: worker?.subscriptions.get(message.id)?.path,
    payload: summarizeFileWatchPayload(message.payload),
    controls: controls.length,
    queuedEvents,
  });
  sending = true;
  process.send({ version: VERSION, generation, ...message }, (error) => {
    trace?.("ipc-send-complete", {
      generation,
      id: message.id,
      requestId: message.requestId,
      type: message.type,
      eventType: message.eventType,
      error: error?.message,
    });
    sending = false;
    if (error) process.exit(1);
    sendNext();
  });
}

function sendControl(message) {
  controls.push(message);
  sendNext();
}

function sendEvent({ id, type, payload }) {
  trace?.("queue-event", {
    generation,
    id,
    type,
    path: worker?.subscriptions.get(id)?.path,
    payload: summarizeFileWatchPayload(payload),
    sending,
    queuedEvents,
    discardedOnInvalidate: type === "invalidate" ? events.get(id)?.changes.size || 0 : 0,
  });
  let entry = events.get(id);
  if (!entry) events.set(id, (entry = { changes: new Map(), invalidate: null, error: null }));
  if (type === "changes") {
    for (const event of payload) {
      queuedEvents += mergeChange(entry.changes, event);
    }
    if (queuedEvents > MAX_QUEUED_EVENTS) {
      const incident = `ipc:${++nextQueueIncident}`;
      for (const queued of events.values()) {
        queued.changes.clear();
        queued.invalidate = { reason: "worker-queue-overflow", incident };
      }
      queuedEvents = 0;
    }
  } else if (type === "invalidate") {
    queuedEvents -= entry.changes.size;
    entry.changes.clear();
    entry.invalidate = payload;
  } else if (type === "error") {
    entry.error = payload;
  }
  sendNext();
}

let worker;
try {
  worker = new FileWatchWorker({
    engine: require("@lumine-code/watcher").createEngine(),
    sendEvent,
  });
} catch (error) {
  // A missing/incompatible installed addon is a permanent startup failure,
  // not an endless series of process crashes with pending ready promises.
  process.send({ version: VERSION, generation, type: "fatal", error: serializeError(error) }, () =>
    process.exit(1),
  );
}

process.on("message", async (message) => {
  trace?.("ipc-receive", {
    generation,
    id: message?.id,
    requestId: message?.requestId,
    path: message?.path,
    type: message?.type,
  });
  if (!message || message.version !== VERSION || message.generation !== generation) process.exit(1);
  try {
    let payload;
    if (message.type === "subscribe" && !closing) {
      await worker.subscribe(message);
    } else if (message.type === "unsubscribe") {
      await worker.unsubscribe(message.id);
      const entry = events.get(message.id);
      if (entry) queuedEvents -= entry.changes.size;
      events.delete(message.id);
    } else if (message.type === "diagnostics") {
      payload = worker.diagnostics();
    } else if (message.type === "close") {
      closing = true;
      await worker.close();
    } else {
      throw new Error("Unknown file watcher worker request");
    }
    sendControl({ type: "reply", requestId: message.requestId, payload });
  } catch (error) {
    sendControl({
      type: "reply",
      requestId: message.requestId,
      error: serializeError(error, message.path),
    });
  }
});

process.on("disconnect", () => {
  Promise.resolve(worker?.close()).finally(() => process.exit(0));
});
process.on("uncaughtException", (error) => {
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  process.exit(1);
});
process.title = `Lumine file watcher [${process.pid}]`;
if (worker) sendControl({ type: "ready" });
