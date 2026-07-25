const { EventEmitter } = require("events");

class ResponseError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "ResponseError";
    this.code = code;
    this.data = data;
  }
}

module.exports = class JsonRpcConnection extends EventEmitter {
  constructor(reader, writer, { trace = () => {} } = {}) {
    super();
    this.reader = reader;
    this.writer = writer;
    this.trace = trace;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
    this.disposed = false;
    this.onData = (chunk) => this.accept(chunk);
    this.onError = (error) => this.failAll(error);
    reader.on("data", this.onData);
    reader.on("error", this.onError);
    reader.on("close", () => this.failAll(new Error("Language server connection closed")));
  }

  accept(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const header = this.buffer.subarray(0, boundary).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.emit("error", new Error("LSP message is missing Content-Length"));
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const bodyStart = boundary + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        const message = JSON.parse(body);
        this.trace("receive", message);
        this.dispatch(message);
      } catch (error) {
        this.emit("error", error);
      }
    }
  }

  dispatch(message) {
    if (message.id != null && message.method == null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new ResponseError(message.error.code, message.error.message, message.error.data),
        );
      } else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id != null) return this.handleRequest(message);
    if (message.method) {
      this.notificationHandlers.get(message.method)?.forEach((handler) => handler(message.params));
      this.emit("notification", message.method, message.params);
    }
  }

  async handleRequest(message) {
    const handler = this.requestHandlers.get(message.method);
    if (!handler)
      return this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    try {
      this.send({ jsonrpc: "2.0", id: message.id, result: await handler(message.params) });
    } catch (error) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: error.code || -32603, message: error.message, data: error.data },
      });
    }
  }

  send(message) {
    if (this.disposed) throw new Error("Language server connection is disposed");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.trace("send", message);
    this.writer.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.writer.write(body);
  }

  request(method, params, { signal } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(signal.reason || new Error("Request cancelled"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
    return { dispose: () => this.requestHandlers.delete(method) };
  }
  onNotification(method, handler) {
    const handlers = this.notificationHandlers.get(method) || new Set();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return { dispose: () => handlers.delete(handler) };
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("close", error);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.reader.off("data", this.onData);
    this.reader.off("error", this.onError);
    this.failAll(new Error("Language server connection disposed"));
    this.removeAllListeners();
  }
};
