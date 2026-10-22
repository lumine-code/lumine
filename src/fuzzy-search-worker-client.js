"use strict";

const fs = require("node:fs");
const path = require("node:path");
let source;

function workerSource() {
  if (source) return source;
  const directory = path.dirname(require.resolve("@lumine-code/fuzzy-search"));
  const definitions = [
    "main.js",
    "text.js",
    "command-t.js",
    "fuzzaldrin.js",
    "unicode-data.json",
    "diacritics-data.json",
  ].map((name) => {
    const contents = fs.readFileSync(path.join(directory, name), "utf8");
    return name.endsWith(".json")
      ? `${JSON.stringify("./" + name)}:${contents}`
      : `${JSON.stringify("./" + name.slice(0, -3))}:function(require,module,exports){\n${contents}\n}`;
  });
  source = `
    const definitions={${definitions.join(",")}}, cache=Object.create(null);
    function require(name) {
      if(cache[name]) return cache[name].exports;
      const definition=definitions[name];
      if(!definition) throw new Error("Unknown matcher module: "+name);
      if(typeof definition!=="function") return definition;
      const module=cache[name]={exports:{}};
      definition(require,module,module.exports);
      return module.exports;
    }
    ${fs.readFileSync(path.join(__dirname, "fuzzy-search-worker.js"), "utf8")}
  `;
  return source;
}

/** A per-list worker with transferred score/order buffers and abortable RPC. */
module.exports = class FuzzySearchWorkerClient {
  constructor(options) {
    this.closed = false;
    this.pending = new Map();
    this.nextId = 0;
    this.url = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
    try {
      // Chromium Worker, without Node integration.
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Renderer Web Worker, not Node's experimental global.
      this.worker = new globalThis.Worker(this.url);
    } catch (error) {
      URL.revokeObjectURL(this.url);
      throw error;
    }
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      pending.cleanup();
      if (data.error) {
        const error = new Error(data.error.message);
        error.name = data.error.name;
        pending.reject(error);
      } else pending.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.close(new Error(event.message || "Fuzzy search worker failed"));
    };
    this.ready = this.request("init", options);
    void this.ready.catch(() => {});
  }

  request(type, data = {}, { signal, transfer = [] } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error("Fuzzy search worker is closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
        this.worker.postMessage({ type: "cancel", id });
        reject(signal.reason);
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker.postMessage({ ...data, type, id }, transfer);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  close(reason = new Error("Fuzzy search worker is closed")) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    URL.revokeObjectURL(this.url);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(reason);
    }
    this.pending.clear();
  }
};
