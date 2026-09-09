const { absolutePath } = require("./file-watch-paths");
const { deferred, abortError, deserializeError } = require("./file-watch-protocol");

/**
 * @public
 * @status public
 *
 * A disposable observation of a fixed filesystem path. External renames do
 * not change its path. Register callbacks immediately, then await ready.
 */
class FileWatchHandle {
  #listeners = new Map();
  #client;
  #id;
  #path;
  #ready = deferred();
  #closed = deferred();
  #disposed = false;

  constructor(client, id, targetPath) {
    this.#client = client;
    this.#id = id;
    this.#path = targetPath;
  }

  /**
   * @public
   * @status public
   *
   * Get the fixed absolute path requested by the subscriber.
   *
   * @returns {String} The absolute path in the subscriber's spelling.
   */
  get path() {
    return this.#path;
  }

  /**
   * @public
   * @status public
   *
   * Wait for the underlying observation to be armed.
   *
   * @returns {Promise<void>} Resolves when observation is armed; rejects on failure or cancellation.
   */
  get ready() {
    return this.#ready.promise;
  }

  /**
   * @public
   * @status public
   *
   * Wait for disposal to release ownership and native resources.
   *
   * @returns {Promise<void>} Resolves after this handle's ownership and resources are released.
   */
  get closed() {
    return this.#closed.promise;
  }

  /** @private */
  get isDisposed() {
    return this.#disposed;
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to batches of created, updated and deleted paths.
   *
   * @param {Function} callback - Called with an array of {action, path} changes.
   * @returns {Disposable} Removes the callback when disposed.
   */
  onDidChange(callback) {
    return this.#on("changes", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to restored observation after changes may have been lost.
   *
   * @param {Function} callback - Called with {path, reason, generation} after recovery.
   * @returns {Disposable} Removes the callback when disposed.
   */
  onDidInvalidate(callback) {
    return this.#on("invalidate", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to structured observation errors.
   *
   * @param {Function} callback - Called with an Error retaining code, path and backend.
   * @returns {Disposable} Removes the callback when disposed.
   */
  onDidError(callback) {
    return this.#on("error", callback);
  }

  #on(type, callback) {
    if (typeof callback !== "function") throw new TypeError("Expected a callback");
    if (this.#disposed) return { dispose() {} };
    let listeners = this.#listeners.get(type);
    if (!listeners) this.#listeners.set(type, (listeners = new Set()));
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  }

  /** @private */
  deliver(type, payload) {
    if (this.#disposed) return;
    if (type === "error") payload = deserializeError(payload);
    for (const callback of this.#listeners.get(type) || []) {
      if (this.#disposed) break;
      try {
        callback(payload);
      } catch (error) {
        this.#client.reportError(error);
      }
    }
  }

  /** @private */
  armed() {
    if (!this.#disposed) this.#ready.resolve();
  }

  /** @private */
  failed(error) {
    if (this.#disposed) return;
    this.#ready.reject(deserializeError(error));
    try {
      this.deliver("error", error);
    } finally {
      this.#disposed = true;
      this.#listeners.clear();
      this.#client.forget(this.#id);
      this.#closed.resolve();
    }
  }

  /**
   * @public
   * @status public
   *
   * Suppress further callbacks immediately and release this observation.
   * Await closed to confirm release. Cancelling before ready rejects ready
   * with an AbortError. Repeated disposal has no effect.
   * @returns {void}
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#ready.reject(abortError(this.path));
    this.#client.unsubscribe(this.#id).then(this.#closed.resolve, this.#closed.reject);
  }
}

/** A session-scoped client. Neither this module nor its handles load the addon. */
class FileWatchClient {
  constructor({ request, onEvent, reportError = (error) => console.error(error) }) {
    this.request = request;
    this.reportError = reportError;
    this.handles = new Map();
    this.nextId = 0;
    this.disposed = false;
    this.subscription = onEvent((event) => {
      try {
        this.handles.get(event.id)?.deliver(event.type, event.payload);
      } finally {
        if (event.sequence !== undefined) {
          Promise.resolve()
            .then(() => this.request({ type: "ack", sequence: event.sequence }))
            .catch(() => {});
        }
      }
    });
  }

  watchFile(filePath) {
    return this.subscribe("file", filePath, false);
  }

  watchDirectory(directoryPath, { recursive = false } = {}) {
    if (typeof recursive !== "boolean") throw new TypeError("recursive must be boolean");
    return this.subscribe("directory", directoryPath, recursive);
  }

  subscribe(kind, targetPath, recursive) {
    if (this.disposed) throw new Error("The file watch client is closed");
    const id = ++this.nextId;
    const handle = new FileWatchHandle(this, id, absolutePath(targetPath));
    this.handles.set(id, handle);
    // Issue subscribe synchronously so a subsequent dispose cannot overtake it.
    let request;
    try {
      request = this.request({ type: "subscribe", id, kind, path: handle.path, recursive });
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      () => handle.armed(),
      (error) => handle.failed(error),
    );
    return handle;
  }

  unsubscribe(id) {
    // Keep the handle until its unsubscribe acknowledgement, so close() also
    // waits for handles whose owner already called dispose().
    return Promise.resolve()
      .then(() => this.request({ type: "unsubscribe", id }))
      .finally(() => this.forget(id));
  }

  forget(id) {
    this.handles.delete(id);
  }

  diagnostics() {
    return this.request({ type: "diagnostics" });
  }

  get isClosed() {
    return this.disposed;
  }

  disposeAll() {
    const handles = [...this.handles.values()];
    for (const handle of handles) handle.dispose();
    return Promise.all(handles.map((handle) => handle.closed)).then(() => {});
  }

  settlePendingTeardown() {
    return Promise.all(
      [...this.handles.values()]
        .filter((handle) => handle.isDisposed)
        .map((handle) => handle.closed),
    ).then(() => {});
  }

  close() {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.closing = this.disposeAll()
      .then(() => this.request({ type: "close" }))
      .finally(() => {
        this.subscription.dispose();
      });
    return this.closing;
  }
}

module.exports = FileWatchClient;
module.exports.FileWatchHandle = FileWatchHandle;
