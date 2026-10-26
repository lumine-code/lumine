const { fork } = require("node:child_process");

// The renderer hashes immutable nodes in bounded slices; blocking filesystem
// transactions run here, with one acknowledged batch in flight at a time.
module.exports = class TextSnapshotWriter {
  constructor(databasePath) {
    this.sequence = 0;
    this.requests = new Map();
    this.child = fork(require.resolve("./text-snapshot-writer-bootstrap"), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" },
      execArgv: [],
      serialization: "advanced",
      silent: true,
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child.on("message", (message) => {
      const request = this.requests.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.requests.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve();
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.fail(new Error(`Text snapshot writer exited (${signal || code})`));
      this.resolveExit();
    });
    this.child.stdout?.resume();
    this.child.stderr?.resume();
    this.ready = this.request({ type: "open", databasePath });
  }

  fail(error) {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.requests.clear();
  }

  request(message) {
    if (this.closed) return Promise.reject(new Error("Text snapshot writer is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("Text snapshot writer exceeded its time limit"));
        this.abort();
      }, 60000);
      timer.unref?.();
      this.requests.set(id, { resolve, reject, timer });
      this.child.send({ ...message, id }, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async write(rows) {
    await this.ready;
    await this.request({ type: "write", rows });
  }

  async close() {
    await this.ready;
    await this.request({ type: "close" });
    await this.exited;
  }

  abort() {
    this.child.kill();
  }
};
