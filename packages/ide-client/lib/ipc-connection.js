const { EventEmitter } = require("events");

module.exports = class IpcConnection extends EventEmitter {
  constructor(child, { trace = () => {} } = {}) {
    super();
    this.child = child;
    this.trace = trace;
    this.nextId = 1;
    this.pending = new Map();
    this.requests = new Map();
    this.notifications = new Map();
    child.on("message", (message) => this.dispatch(message));
    child.on("error", (error) => this.fail(error));
    child.on("close", () => this.fail(new Error("Language server IPC connection closed")));
  }
  send(message) {
    this.trace("send", message);
    this.child.send(message);
  }
  request(method, params, { signal } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.pending.delete(id)) {
          this.notify("$/cancelRequest", { id });
          reject(new Error("Request cancelled"));
        }
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  onRequest(method, handler) {
    this.requests.set(method, handler);
    return { dispose: () => this.requests.delete(method) };
  }
  onNotification(method, handler) {
    const set = this.notifications.get(method) || new Set();
    set.add(handler);
    this.notifications.set(method, set);
    return { dispose: () => set.delete(handler) };
  }
  async dispatch(message) {
    this.trace("receive", message);
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      return message.error
        ? pending.reject(Object.assign(new Error(message.error.message), message.error))
        : pending.resolve(message.result);
    }
    if (message.id != null) {
      const handler = this.requests.get(message.method);
      try {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: handler ? await handler(message.params) : null,
        });
      } catch (error) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: error.code || -32603, message: error.message },
        });
      }
      return;
    }
    this.notifications.get(message.method)?.forEach((handler) => handler(message.params));
    this.emit("notification", message.method, message.params);
  }
  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("close", error);
  }
  dispose() {
    this.fail(new Error("Language server connection disposed"));
    this.removeAllListeners();
  }
};
