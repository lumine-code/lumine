const { Emitter } = require("@lumine-code/event-kit");

function abortError(message = "Syntax request was cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

// One connection per editor window. Responses are explicitly revisioned by
// the service; this layer owns request cancellation and stream backpressure.
class SyntaxWorkerClient {
  constructor({ workerFactory, source } = {}) {
    this.emitter = new Emitter();
    this.pending = new Map();
    this.nextRequest = 0;
    this.closed = false;
    if (workerFactory) {
      this.worker = workerFactory();
    } else {
      const bootstrap = require.resolve("./syntax-worker-bootstrap");
      const body = source ?? `require(${JSON.stringify(bootstrap)}).connect(self);`;
      this.url = URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
      try {
        this.worker = new globalThis.Worker(this.url);
      } catch (error) {
        URL.revokeObjectURL(this.url);
        throw error;
      }
    }
    this.worker.onmessage = ({ data }) => {
      void this.receive(data).catch((error) => this.close(error));
    };
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.close(new Error(event.message || "Syntax worker failed"));
    };
    this.worker.onmessageerror = () =>
      this.close(new Error("Unable to decode a syntax worker message"));
  }

  onDidReceiveEvent(callback) {
    return this.emitter.on("event", callback);
  }

  onDidClose(callback) {
    return this.emitter.on("close", callback);
  }

  async receive(message) {
    if (this.closed) return;
    if (message.type === "event") {
      this.emitter.emit("event", message);
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) {
      // A cancelled stream must not retain a worker-side acknowledgement wait.
      if (message.type === "chunk") this.send({ type: "cancel", id: message.id });
      return;
    }
    if (message.type === "chunk") {
      try {
        if (message.sequence !== request.sequence++) throw new Error("Invalid syntax stream order");
        if (!request.onChunk) throw new Error("Syntax stream has no consumer");
        const value = await request.onChunk(message.value);
        if (this.pending.get(message.id) === request)
          this.send({ type: "ack", id: message.id, sequence: message.sequence, value });
      } catch (error) {
        this.pending.delete(message.id);
        request.cleanup();
        request.reject(error);
        this.send({ type: "cancel", id: message.id });
      }
      return;
    }
    this.pending.delete(message.id);
    request.cleanup();
    if (message.type === "error") {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      if (message.error.stack) error.stack = message.error.stack;
      request.reject(error);
    } else if (message.type === "result") request.resolve(message.value);
    else request.reject(new Error("Invalid syntax worker response"));
  }

  send(message, transfer = []) {
    if (!this.closed) this.worker.postMessage(message, transfer);
  }

  request(operation, data, { signal, onChunk, transfer = [] } = {}) {
    if (this.closed) return Promise.reject(new Error("Syntax worker is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    return new Promise((resolve, reject) => {
      const id = ++this.nextRequest;
      const abort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.send({ type: "cancel", id });
        reject(signal.reason ?? abortError());
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, cleanup, onChunk, sequence: 0 });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker.postMessage({ type: "request", id, operation, data }, transfer);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  close(error = abortError("Syntax worker was closed")) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    if (this.url) URL.revokeObjectURL(this.url);
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
    try {
      this.emitter.emit("close", error);
    } finally {
      this.emitter.dispose();
    }
  }
}

module.exports = SyntaxWorkerClient;
module.exports.abortError = abortError;
