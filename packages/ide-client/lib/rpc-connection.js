const {
  CancellationTokenSource,
  createMessageConnection,
  IPCMessageReader,
  IPCMessageWriter,
  SocketMessageReader,
  SocketMessageWriter,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} = require("vscode-jsonrpc/node");

const abortReason = (signal) => signal.reason || new Error("Request cancelled");

// The JSON-RPC layer for one language server. Framing, request correlation and
// cancellation come from vscode-jsonrpc, the implementation the protocol is
// written against; what is left here is the shape the rest of the client
// speaks — AbortSignal rather than CancellationToken, and notifications that
// report a failure instead of raising it.
module.exports = class RpcConnection {
  // Each transport hands vscode-jsonrpc the streams it should own. It listens
  // for `error` on both, so a server that exits with a frame still queued on
  // its stdin surfaces as a connection error rather than an uncaught EPIPE.
  static stdio(child, options) {
    return new RpcConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
      options,
    );
  }
  static ipc(child, options) {
    return new RpcConnection(new IPCMessageReader(child), new IPCMessageWriter(child), options);
  }
  static socket(socket, options) {
    return new RpcConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
      options,
    );
  }

  constructor(reader, writer, { logger } = {}) {
    this.logger = logger;
    this.disposed = false;
    this.connection = createMessageConnection(reader, writer, logger);
  }

  listen() {
    this.connection.listen();
  }
  onError(fn) {
    return this.connection.onError(([error]) => fn(error));
  }
  onClose(fn) {
    return this.connection.onClose(fn);
  }
  onRequest(method, handler) {
    return this.connection.onRequest(method, handler);
  }
  onNotification(method, handler) {
    return this.connection.onNotification(method, handler);
  }
  // Fires for the notifications the client registered no handler of its own
  // for — everything a server sends that this client does not itself act on.
  onOtherNotification(handler) {
    return this.connection.onNotification(handler);
  }
  // Traffic logging, in the wording the protocol's own tooling uses.
  setTrace(value) {
    const tracer = {
      log: (message, data) => this.logger?.log(data ? `${message}\n${data}` : message),
    };
    this.connection.trace(Trace.fromString(value), tracer).catch(() => {});
  }

  request(method, params, { signal } = {}) {
    if (!signal) return this.send(method, params);
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const source = new CancellationTokenSource();
    let abandon;
    const abandoned = new Promise((resolve, reject) => (abandon = reject));
    // `$/cancelRequest` is advisory: a server answers a cancelled request when
    // it gets round to it, and some never answer at all. The caller stopped
    // waiting the moment it aborted, so settle here rather than sit it out.
    const onAbort = () => {
      source.cancel();
      abandon(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Promise.race([this.send(method, params, source.token), abandoned]).finally(() => {
      signal.removeEventListener("abort", onAbort);
      source.dispose();
    });
  }

  // Fire-and-forget: a server that has gone away cannot be told anything, and
  // the caller has nothing to do about it — the writer reports failures on its
  // own through `onError`. The promise resolves once the frame is on the wire,
  // so `exit` can be flushed before the process is taken down.
  notify(method, params) {
    try {
      const sent =
        params == null
          ? this.connection.sendNotification(method)
          : this.connection.sendNotification(method, params);
      return sent.catch((error) => this.undelivered(method, error));
    } catch (error) {
      this.undelivered(method, error);
      return Promise.resolve();
    }
  }

  send(method, params, token) {
    try {
      // Passing an explicit `undefined` is not the same as passing nothing:
      // vscode-jsonrpc counts the arguments it is handed, and a trailing
      // undefined turns a named parameter object into a positional array.
      const args = [method];
      if (params != null) args.push(params);
      if (token) args.push(token);
      return this.connection.sendRequest(...args);
    } catch (error) {
      // A closed or disposed connection throws rather than rejects.
      return Promise.reject(error);
    }
  }

  undelivered(method, error) {
    this.logger?.log(`Could not deliver ${method}: ${error.message}`);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.dispose();
  }
};
