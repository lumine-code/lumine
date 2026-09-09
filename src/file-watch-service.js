const ChildProcess = require("child_process");
const FileWatchClient = require("./file-watch-client");
const { absolutePath } = require("./file-watch-paths");
const {
  VERSION,
  MAX_QUEUED_EVENTS,
  MAX_PENDING_REQUESTS,
  deferred,
  abortError,
  serializeError,
  deserializeError,
  mergeChange,
} = require("./file-watch-protocol");

const RETRY_DELAYS = [250, 1000, 5000, 30000];

/** Application-owned supervisor. The native library is loaded only by its child. */
class FileWatchService {
  constructor({ spawnWorker, retryDelays = RETRY_DELAYS, stableDelay = 60000 } = {}) {
    this.spawnWorker = spawnWorker || ((options) => this.forkWorker(options));
    this.retryDelays = retryDelays;
    this.stableDelay = stableDelay;
    this.owners = new Map();
    this.subscriptions = new Map();
    this.pending = new Map();
    this.nextId = 0;
    this.nextRequestId = 0;
    this.generation = 0;
    this.recoveryGeneration = 0;
    this.incidents = new Map();
    this.retryAttempt = 0;
    this.closed = false;
  }

  forkWorker({ generation }) {
    return ChildProcess.fork(require.resolve("./file-watch-worker-bootstrap"), [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        LUMINE_FILE_WATCH_GENERATION: String(generation),
      },
      execArgv: [],
      silent: true,
      windowsHide: true,
    });
  }

  createClient(owner) {
    const listeners = new Set();
    return new FileWatchClient({
      request: (request) =>
        this.dispatch(owner, request, (event) => {
          for (const listener of listeners) listener(event);
        }),
      onEvent(callback) {
        listeners.add(callback);
        return { dispose: () => listeners.delete(callback) };
      },
    });
  }

  dispatch(owner, request, sendEvent) {
    try {
      if (request.type === "close") return this.closeOwner(owner);
      if (request.type === "diagnostics") return Promise.resolve(this.diagnostics(owner));
      if (request.type === "ack") {
        const state = this.owners.get(owner);
        if (state?.inFlight === request.sequence) {
          state.inFlight = null;
          this.flushOwner(state);
        }
        return Promise.resolve();
      }
      if (request.type === "unsubscribe") {
        return this.unsubscribe(this.owners.get(owner)?.subscriptions.get(request.id));
      }
      if (request.type !== "subscribe") throw new Error("Unknown file watch request");
      if (this.closed) throw new Error("The file watch service is closed");
      if (request.kind !== "file" && request.kind !== "directory") {
        throw new TypeError("Unknown file watch target kind");
      }
      if (typeof request.recursive !== "boolean") {
        throw new TypeError("recursive must be boolean");
      }
      if (!Number.isSafeInteger(request.id) || request.id <= 0) {
        throw new TypeError("Invalid file watch subscription id");
      }
      let state = this.owners.get(owner);
      if (!state) {
        state = {
          owner,
          sendEvent,
          subscriptions: new Map(),
          queue: new Map(),
          queuedEvents: 0,
          sequence: 0,
          inFlight: null,
          closing: false,
        };
        this.owners.set(owner, state);
      }
      if (state.closing) throw new Error("The file watch session is closing");
      if (state.subscriptions.has(request.id)) throw new Error("Duplicate subscription id");
      if (this.subscriptions.size >= MAX_PENDING_REQUESTS) {
        throw Object.assign(new Error("Too many file watch subscriptions"), {
          code: "ERR_FILE_WATCH_CAPACITY",
        });
      }
      const record = {
        id: ++this.nextId,
        localId: request.id,
        state,
        kind: request.kind,
        path: absolutePath(request.path),
        recursive: request.kind === "directory" && request.recursive,
        ready: deferred(),
        closed: deferred(),
        active: false,
        everReady: false,
        cancelled: false,
      };
      state.subscriptions.set(record.localId, record);
      this.subscriptions.set(record.id, record);
      this.ensureWorker();
      if (this.workerReady) this.arm(record);
      return record.ready.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  ensureWorker() {
    if (this.closed || this.worker || this.retryTimer || !this.subscriptions.size) return;
    const generation = ++this.generation;
    this.workerReady = false;
    let worker;
    try {
      worker = this.spawnWorker({ generation });
    } catch (error) {
      this.workerExited(null, generation, error);
      return;
    }
    this.worker = worker;
    this.workerExit = deferred();
    this.startupTimer = setTimeout(() => {
      worker.lastWatchError = Object.assign(new Error("File watcher startup timed out"), {
        code: "ERR_FILE_WATCH_STARTUP_TIMEOUT",
      });
      worker.kill();
    }, 30000);
    this.startupTimer.unref?.();
    worker.on("message", (message) => this.handleMessage(worker, generation, message));
    worker.on("error", (error) => {
      worker.lastWatchError = error;
      worker.kill();
    });
    const exited = (code, signal) => {
      this.workerExited(
        worker,
        generation,
        worker.lastWatchError ||
          Object.assign(new Error(`File watcher worker exited (${signal || code})`), {
            code: "ERR_FILE_WATCH_WORKER_EXIT",
          }),
      );
    };
    worker.once("exit", exited);
    // Failed spawn emits close without exit; successful workers can emit both.
    worker.once("close", exited);
    worker.stdout?.resume();
    worker.stderr?.on("data", (data) => console.error(data.toString().trimEnd()));
  }

  handleMessage(worker, generation, message) {
    if (worker !== this.worker || generation !== this.generation) return;
    if (!message || message.version !== VERSION || message.generation !== generation) {
      worker.lastWatchError = Object.assign(new Error("File watcher protocol mismatch"), {
        code: "ERR_FILE_WATCH_PROTOCOL",
      });
      worker.kill();
      return;
    }
    if (message.type === "ready") {
      if (this.workerReady) return;
      clearTimeout(this.startupTimer);
      this.workerReady = true;
      this.stableTimer = setTimeout(() => {
        this.retryAttempt = 0;
      }, this.stableDelay);
      this.stableTimer.unref?.();
      for (const record of this.subscriptions.values()) this.arm(record);
    } else if (message.type === "fatal") {
      worker.lastWatchError = deserializeError(message.error);
      for (const record of this.subscriptions.values()) {
        if (!record.everReady) {
          record.ready.reject(worker.lastWatchError);
          this.remove(record);
        }
      }
      worker.kill();
    } else if (message.type === "reply") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.error) pending.reject(deserializeError(message.error));
      else pending.resolve(message.payload);
    } else if (message.type === "event") {
      const record = this.subscriptions.get(message.id);
      if (!record || record.cancelled) return;
      let payload = message.payload;
      if (message.eventType === "invalidate") {
        const incidentKey = `${generation}:${payload.incident || `event-${++this.nextRequestId}`}`;
        let recovery = this.incidents.get(incidentKey);
        if (!recovery) {
          recovery = ++this.recoveryGeneration;
          this.incidents.set(incidentKey, recovery);
          if (this.incidents.size > 512) this.incidents.delete(this.incidents.keys().next().value);
        }
        payload = { path: record.path, reason: payload.reason, generation: recovery };
      }
      this.enqueue(record, message.eventType, payload);
    }
  }

  requestWorker(type, payload = {}) {
    if (!this.worker || !this.workerReady) {
      return Promise.reject(
        Object.assign(new Error("File watcher worker unavailable"), { transient: true }),
      );
    }
    const requestId = ++this.nextRequestId;
    const pending = deferred();
    this.pending.set(requestId, pending);
    try {
      this.worker.send(
        { version: VERSION, generation: this.generation, type, requestId, ...payload },
        (error) => {
          if (error && this.pending.has(requestId)) {
            this.worker?.kill();
          }
        },
      );
    } catch (error) {
      this.worker.lastWatchError = error;
      this.worker.kill();
    }
    return pending.promise;
  }

  arm(record) {
    if (record.cancelled || record.armGeneration === this.generation) return;
    const generation = this.generation;
    record.armGeneration = generation;
    this.requestWorker("subscribe", {
      id: record.id,
      kind: record.kind,
      path: record.path,
      recursive: record.recursive,
    }).then(
      () => {
        if (record.cancelled || generation !== this.generation || !this.workerReady) return;
        record.active = true;
        if (record.everReady) {
          this.enqueue(record, "invalidate", {
            path: record.path,
            reason: "worker-restarted",
            generation: record.recoveryGeneration,
          });
        }
        record.everReady = true;
        record.ready.resolve();
        this.flushOwner(record.state);
      },
      (error) => {
        if (record.cancelled || error.transient || generation !== this.generation) return;
        if (record.everReady) {
          this.enqueue(record, "error", serializeError(error, record.path));
          record.rearmTimer = setTimeout(() => {
            record.armGeneration = null;
            if (this.workerReady) this.arm(record);
          }, this.retryDelays.at(-1));
          record.rearmTimer.unref?.();
          return;
        }
        record.ready.reject(error);
        this.enqueue(record, "error", serializeError(error, record.path));
        this.remove(record);
      },
    );
  }

  unsubscribe(record) {
    if (!record) return Promise.resolve();
    if (record.cancelled) return record.closed.promise;
    record.cancelled = true;
    clearTimeout(record.rearmTimer);
    record.active = false;
    record.ready.reject(abortError(record.path));
    this.dropQueued(record);
    if (this.workerReady && record.armGeneration === this.generation) {
      this.requestWorker("unsubscribe", { id: record.id }).then(
        () => this.remove(record),
        (error) => {
          // Only a confirmed worker exit is treated as a successful release.
          if (error.transient) this.remove(record);
          else if (this.worker) {
            // A failed native release leaves ownership uncertain. Replacing
            // the worker confirms release and invalidates its other owners.
            this.worker.lastWatchError = error;
            this.worker.kill();
          }
        },
      );
    } else {
      this.remove(record);
    }
    return record.closed.promise;
  }

  remove(record) {
    this.dropQueued(record);
    record.state.subscriptions.delete(record.localId);
    this.subscriptions.delete(record.id);
    record.closed.resolve();
    if (this.subscriptions.size === 0) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  workerExited(worker, generation, error) {
    if (generation !== this.generation || (worker && worker !== this.worker)) return;
    this.worker = null;
    this.workerReady = false;
    clearTimeout(this.stableTimer);
    clearTimeout(this.startupTimer);
    this.workerExit?.resolve();
    error = Object.assign(error, { transient: true });
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const recoveryGeneration = ++this.recoveryGeneration;
    for (const record of this.subscriptions.values()) {
      clearTimeout(record.rearmTimer);
      record.recoveryGeneration = recoveryGeneration;
      record.active = false;
      this.dropQueued(record);
      if (record.cancelled) this.remove(record);
      else if (record.everReady) {
        this.enqueue(record, "error", serializeError(error, record.path));
      }
    }
    if (this.closed || this.subscriptions.size === 0) return;
    const delay = this.retryDelays[Math.min(this.retryAttempt++, this.retryDelays.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensureWorker();
    }, delay);
    this.retryTimer.unref?.();
  }

  enqueue(record, type, payload) {
    const state = record.state;
    if (record.cancelled || state.closing) return;
    let entry = state.queue.get(record.id);
    if (!entry) {
      entry = { record, changes: new Map(), invalidate: null, error: null };
      state.queue.set(record.id, entry);
    }
    if (type === "changes") {
      for (const event of payload) {
        state.queuedEvents += mergeChange(entry.changes, event);
      }
      if (state.queuedEvents > MAX_QUEUED_EVENTS) {
        const generation = ++this.recoveryGeneration;
        for (const queued of state.queue.values()) {
          queued.changes.clear();
          queued.invalidate = {
            path: queued.record.path,
            reason: "client-queue-overflow",
            generation,
          };
        }
        state.queuedEvents = 0;
      }
    } else if (type === "invalidate") {
      state.queuedEvents -= entry.changes.size;
      entry.changes.clear();
      entry.invalidate = payload;
    } else if (type === "error") {
      entry.error = payload;
    }
    this.flushOwner(state);
  }

  dropQueued(record) {
    const entry = record.state.queue.get(record.id);
    if (entry) record.state.queuedEvents -= entry.changes.size;
    record.state.queue.delete(record.id);
  }

  flushOwner(state) {
    if (state.inFlight !== null || state.closing) return;
    for (const [id, entry] of state.queue) {
      const { record } = entry;
      // Errors remain deliverable during an outage. Ordinary events and
      // invalidation wait until this subscription is actually rearmed.
      const type = entry.error
        ? "error"
        : record.active
          ? entry.invalidate
            ? "invalidate"
            : entry.changes.size
              ? "changes"
              : null
          : null;
      if (!type) continue;
      let payload;
      if (type === "changes") {
        payload = [...entry.changes.values()];
        state.queuedEvents -= entry.changes.size;
        entry.changes.clear();
      } else {
        payload = entry[type];
        entry[type] = null;
      }
      if (!entry.error && !entry.invalidate && !entry.changes.size) state.queue.delete(id);
      const sequence = ++state.sequence;
      state.inFlight = sequence;
      try {
        state.sendEvent({ id: record.localId, type, payload, sequence });
      } catch {
        this.closeOwner(state.owner);
      }
      return;
    }
  }

  closeOwner(owner) {
    const state = this.owners.get(owner);
    if (!state) return Promise.resolve();
    if (state.closed) return state.closed;
    state.closing = true;
    state.queue.clear();
    state.queuedEvents = 0;
    state.closed = Promise.all(
      [...state.subscriptions.values()].map((record) => this.unsubscribe(record)),
    ).then(() => {
      this.owners.delete(owner);
    });
    return state.closed;
  }

  diagnostics(owner) {
    const records =
      owner === undefined
        ? [...this.subscriptions.values()]
        : [...(this.owners.get(owner)?.subscriptions.values() || [])];
    return {
      generation: this.generation,
      workerRunning: Boolean(this.workerReady),
      subscriptions: records.map(({ localId, path, kind, recursive, active, cancelled }) => ({
        id: localId,
        path,
        kind,
        recursive,
        active,
        closing: cancelled,
      })),
      pendingRequests: this.pending.size,
    };
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearTimeout(this.stableTimer);
    this.closing = (async () => {
      const worker = this.worker;
      const exited = this.workerExit?.promise;
      // A wedged native close must not prevent application shutdown forever.
      const timeout = setTimeout(() => worker?.kill(), 5000);
      timeout.unref?.();
      try {
        await Promise.all([...this.owners.keys()].map((owner) => this.closeOwner(owner)));
        if (worker && this.worker === worker) {
          if (this.workerReady) {
            await this.requestWorker("close").catch(() => {});
          }
          worker.kill();
          await exited;
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    return this.closing;
  }
}

module.exports = FileWatchService;
