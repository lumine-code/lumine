const { Worker } = require("node:worker_threads");
const { EventEmitter } = require("node:events");
const { setTimeout, clearTimeout } = require("node:timers");
const COMPARISON_BUDGET_MS = 250;
const WORKER_WATCHDOG_MS = 1500;
const MAX_SOURCE_LENGTH = 32 * 1024 * 1024;

function abortError() {
  return Object.assign(new Error("The Git line diff was aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function lineDiffBudgetError() {
  return Object.assign(new Error("The line diff exceeded its comparison budget"), {
    code: "ERR_GIT_LINE_DIFF_TOO_LARGE",
  });
}

function createLineDiffWorker() {
  const entry = require.resolve("./git-line-diff-worker");
  if (process.type !== "renderer") return new Worker(entry);

  // The in-process Git host used by the spec renderer has Chromium's worker
  // platform. Bootstrap with Node integration just like the syntax worker.
  const source = `require(${JSON.stringify(entry)}).connect(self);`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Chromium Worker in the renderer.
    const worker = new globalThis.Worker(url);
    const connection = new EventEmitter();
    worker.onmessage = ({ data }) => connection.emit("message", data);
    worker.onerror = (event) => {
      event.preventDefault();
      connection.emit("error", new Error(event.message || "Git line diff worker failed"));
    };
    worker.onmessageerror = () =>
      connection.emit("messageerror", new Error("Unable to decode the Git line diff result"));
    connection.postMessage = (message) => worker.postMessage(message);
    connection.unref = () => {};
    connection.terminate = async () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    return connection;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

// A single lazy worker keeps CPU work off git-host's dispatch loop and bounds
// the number of inputs copied to a worker at once. A watchdog also covers
// tokenization and result assembly, which jsdiff's comparison timer excludes.
module.exports = class GitLineDiffWorker {
  constructor({ createWorker = createLineDiffWorker, watchdogMs = WORKER_WATCHDOG_MS } = {}) {
    this.createWorker = createWorker;
    this.watchdogMs = watchdogMs;
    this.queue = new Set();
    this.active = null;
    this.worker = null;
    this.retiring = false;
    this.closed = false;
  }

  request(oldSource, newSource, { signal, ignoreEolWhitespace } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    if (oldSource.length > MAX_SOURCE_LENGTH || newSource.length > MAX_SOURCE_LENGTH) {
      return Promise.reject(lineDiffBudgetError());
    }

    return new Promise((resolve, reject) => {
      const request = {
        message: {
          oldSource,
          newSource,
          options: { ignoreEolWhitespace, timeout: COMPARISON_BUDGET_MS },
        },
        resolve,
        reject,
        timer: null,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        if (this.active === request) this.retireWorker(this.worker, abortError());
        else if (this.queue.delete(request)) {
          request.cleanup();
          reject(abortError());
        }
      };
      this.queue.add(request);
      signal?.addEventListener("abort", abort, { once: true });
      this.pump();
    });
  }

  startWorker() {
    const worker = this.createWorker();
    worker.on("message", (hunks) => {
      if (this.worker !== worker || !this.active) return;
      this.settleActive(hunks === null ? lineDiffBudgetError() : null, hunks);
      this.pump();
    });
    worker.on("error", (error) => this.retireWorker(worker, error));
    worker.on("messageerror", (error) => this.retireWorker(worker, error));
    worker.on("exit", (code) => {
      this.retireWorker(worker, new Error(`Git line diff worker exited with code ${code}`));
    });
    worker.unref();
    return worker;
  }

  pump() {
    while (!this.closed && !this.retiring && !this.active && this.queue.size > 0) {
      const request = this.queue.values().next().value;
      this.queue.delete(request);
      this.active = request;
      try {
        this.worker ??= this.startWorker();
        request.timer = setTimeout(
          () => this.retireWorker(this.worker, lineDiffBudgetError()),
          this.watchdogMs,
        );
        this.worker.postMessage(request.message);
      } catch (error) {
        this.settleActive(error);
      }
    }
  }

  settleActive(error, hunks) {
    const request = this.active;
    if (!request) return;
    this.active = null;
    clearTimeout(request.timer);
    request.cleanup();
    if (error) request.reject(error);
    else request.resolve(hunks);
  }

  retireWorker(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.retiring = true;
    this.settleActive(error);
    // Wait for the retired thread before starting another CPU job.
    const resume = () => {
      this.retiring = false;
      this.pump();
    };
    void worker.terminate().then(resume, resume);
  }

  dispose() {
    this.closed = true;
    const error = abortError();
    for (const request of this.queue) {
      request.cleanup();
      request.reject(error);
    }
    this.queue.clear();
    if (this.worker) this.retireWorker(this.worker, error);
  }
};
