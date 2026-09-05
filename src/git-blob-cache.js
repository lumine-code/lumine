const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 256;

function blobSize(blob) {
  const content = blob?.content;
  if (Buffer.isBuffer(content)) return content.length;
  if (typeof content === "string") return Buffer.byteLength(content);
  return 0;
}

function abortError() {
  const error = new Error("The Git blob request was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

// Byte-bounded LRU for immutable blobs. Values larger than the entire budget
// are returned to the caller but never retained. Concurrent misses share one
// loader Promise; failures are never cached.
module.exports = class GitBlobCache {
  constructor({ maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.bytes = 0;
    this.entries = new Map();
    this.inflight = new Map();
    this.generation = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const size = blobSize(value);
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.size;
    }
    if (size > this.maxBytes || this.maxEntries === 0) return value;

    this.entries.set(key, { value, size });
    this.bytes += size;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.bytes -= oldest.size;
    }
    return value;
  }

  getOrLoad(key, load, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    let flight = this.inflight.get(key);
    if (flight && !flight.accepting) flight = null;
    if (!flight) {
      const controller = new AbortController();
      const generation = this.generation;
      flight = { accepting: true, controller, waiters: 0, promise: null };
      flight.promise = Promise.resolve()
        .then(() => load({ signal: controller.signal }))
        .then((value) => (generation === this.generation ? this.set(key, value) : value))
        .finally(() => {
          if (this.inflight.get(key) === flight) this.inflight.delete(key);
        });
      this.inflight.set(key, flight);
    }

    flight.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        flight.waiters--;
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        if (flight.waiters === 0) {
          flight.accepting = false;
          flight.controller.abort();
        }
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  clear() {
    this.generation++;
    this.entries.clear();
    for (const flight of this.inflight.values()) {
      flight.accepting = false;
      flight.controller.abort();
    }
    this.inflight.clear();
    this.bytes = 0;
  }
};
