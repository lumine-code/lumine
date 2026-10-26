const { Worker } = require("node:worker_threads");

module.exports = class SearchWorker {
  constructor(signal) {
    this.signal = signal;
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Detect Chromium's Worker, not Node's experimental global.
    if (process.type === "renderer" && typeof globalThis.Worker === "function") {
      const source = require("node:fs").readFileSync(
        require.resolve("./document-search-worker"),
        "utf8",
      );
      this.url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Chromium Worker in the renderer.
      this.worker = new globalThis.Worker(this.url);
    } else {
      this.worker = new Worker(require.resolve("./document-search-worker"));
      this.worker.unref();
    }
    const onMessage = (message) => {
      if (!this.pending) return;
      const { resolve, reject, timer } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error));
      else resolve(message);
    };
    if (this.url) {
      this.worker.onmessage = ({ data }) => onMessage(data);
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.fail(new Error(event.message));
      };
    } else {
      this.worker.on("message", onMessage);
      this.worker.on("error", (error) => this.fail(error));
    }
    this.abort = () =>
      this.fail(Object.assign(new Error("Search was cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  fail(error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.dispose();
  }

  request(message) {
    if (this.signal?.aborted)
      return Promise.reject(
        Object.assign(new Error("Search was cancelled"), { name: "AbortError" }),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            Object.assign(
              new Error(
                "The regular expression exceeded its execution budget. Simplify the expression or narrow the selection.",
              ),
              { code: "ERR_SEARCH_TIMEOUT" },
            ),
          ),
        1000,
      );
      this.pending = { resolve, reject, timer };
      this.worker.postMessage(message);
    });
  }

  dispose() {
    this.signal?.removeEventListener("abort", this.abort);
    this.worker.terminate();
    if (this.url) URL.revokeObjectURL(this.url);
  }
};
