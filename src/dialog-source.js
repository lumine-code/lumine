"use strict";

const MODES = new Set(["snapshot", "query"]);
const DEFAULT_DEBOUNCE_MS = 100;

function normalizeSource(source) {
  if (source == null) return null;
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Dialog source must be an object or null");
  }
  if (!MODES.has(source.mode)) {
    throw new TypeError("Dialog source mode must be 'snapshot' or 'query'");
  }
  if (typeof source.load !== "function") {
    throw new TypeError("Dialog source load must be a function");
  }

  const debounceMs = source.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError("Dialog source debounceMs must be a non-negative finite number");
  }

  return Object.freeze({
    mode: source.mode,
    debounceMs,
    load: source.load,
  });
}

function optionalCallback(value, name, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "function") {
    throw new TypeError(`DialogSource ${name} must be a function`);
  }
  return value;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

/**
 * Coordinates a dialog's synchronous or asynchronous data source.
 *
 * A snapshot source loads when the dialog opens or is explicitly reloaded. A
 * query source additionally reloads after query changes, debounced by 100ms by
 * default. A load can publish any number of progressive results and may return
 * one final result; `undefined` means there is no final publication.
 *
 * The class deliberately owns no DOM. Generation and AbortController state
 * ensure that a superseded, cancelled, or destroyed load cannot publish into
 * its consumer even when the loader ignores its abort signal.
 * @private
 */
module.exports = class DialogSource {
  constructor({ source = null, getQuery, getParsedQuery, apply, setLoading, setError } = {}) {
    if (typeof apply !== "function") {
      throw new TypeError("DialogSource requires an apply callback");
    }

    this._getQuery = optionalCallback(getQuery, "getQuery", () => "");
    this._getParsedQuery = optionalCallback(getParsedQuery, "getParsedQuery", (query) => query);
    this._apply = apply;
    this._setLoading = optionalCallback(setLoading, "setLoading", () => {});
    this._setError = optionalCallback(setError, "setError", () => {});
    this._source = normalizeSource(source);
    this._generation = 0;
    this._operation = null;
    this._debounceTimer = null;
    this._opened = false;
    this._loading = false;
    this._destroyed = false;
  }

  /**
   * Replaces the source. An open dialog loads the replacement immediately;
   * a closed dialog waits for `open()`.
   * @param {Object|null} source - The replacement source, or null to disable it
   * @returns {Promise} Resolves after an immediate replacement load settles
   */
  setSource(source) {
    this._assertAlive();
    const normalized = normalizeSource(source);
    const shouldReload = this._opened && normalized !== null;
    this._invalidate("source-changed", { keepLoading: shouldReload });
    this._source = normalized;
    return shouldReload ? this._startLoad("source-changed") : Promise.resolve();
  }

  /** Starts an opening load immediately, regardless of the query debounce. */
  open() {
    this._assertAlive();
    this._opened = true;
    return this._startLoad("open");
  }

  /**
   * Schedules a query-mode reload. Snapshot sources and closed dialogs ignore
   * query changes.
   * @returns {Boolean} Whether a reload was scheduled or started
   */
  queryChanged() {
    this._assertAlive();
    if (!this._opened || this._source?.mode !== "query") return false;

    this._invalidate("query-changed", { keepLoading: true });
    this._updateLoading(true);

    if (this._source.debounceMs === 0) {
      void this._startLoad("query-changed");
      return true;
    }

    const scheduledGeneration = this._generation;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (
        this._destroyed ||
        !this._opened ||
        this._source?.mode !== "query" ||
        this._generation !== scheduledGeneration
      ) {
        return;
      }
      void this._startLoad("query-changed");
    }, this._source.debounceMs);
    return true;
  }

  /** Reloads the current source immediately while the dialog is open. */
  reload() {
    this._assertAlive();
    if (!this._opened) return Promise.resolve();
    return this._startLoad("reload");
  }

  /**
   * Stops the active lifecycle, clears a pending debounce, and aborts a load.
   * @param {*} reason - Exposed as `signal.reason` to the loader
   * @returns {Boolean} Whether the source had been open
   */
  cancel(reason = "cancelled") {
    if (this._destroyed) return false;
    const wasOpened = this._opened;
    this._opened = false;
    this._invalidate(reason);
    return wasOpened;
  }

  isLoading() {
    return this._loading;
  }

  /** Cancels all work. Repeated destruction is a no-op. */
  destroy() {
    if (this._destroyed) return;
    this._opened = false;
    this._invalidate("destroyed");
    this._destroyed = true;
    this._source = null;
  }

  _startLoad(reason) {
    if (!this._opened || this._source == null) {
      this._invalidate(reason);
      return Promise.resolve();
    }

    this._invalidate(reason, { keepLoading: true });
    const operation = {
      generation: this._generation,
      controller: new AbortController(),
      source: this._source,
      publications: Promise.resolve(),
    };
    this._operation = operation;
    this._updateLoading(true);
    if (!this._isCurrent(operation)) return Promise.resolve();
    operation.promise = this._performLoad(operation);
    return operation.promise;
  }

  async _performLoad(operation) {
    try {
      const query = this._getQuery();
      const parsedQuery = this._getParsedQuery(query);
      if (!this._isCurrent(operation)) return;
      const publication = await operation.source.load({
        query,
        parsedQuery,
        signal: operation.controller.signal,
        publish: (value) => this._publish(operation, value),
      });
      await operation.publications;
      if (publication !== undefined && this._isCurrent(operation)) {
        await this._apply(publication);
      }
    } catch (error) {
      if (this._isCurrent(operation) && !isAbortError(error)) {
        this._setError(error);
      }
    } finally {
      if (this._isCurrent(operation)) {
        this._operation = null;
        this._updateLoading(false);
      }
    }
  }

  _publish(operation, publication) {
    if (!this._isCurrent(operation)) return Promise.resolve(false);
    operation.publications = operation.publications.then(async () => {
      if (!this._isCurrent(operation)) return false;
      await this._apply(publication);
      return true;
    });
    return operation.publications;
  }

  _isCurrent(operation) {
    return (
      !this._destroyed &&
      this._opened &&
      this._operation === operation &&
      this._generation === operation.generation &&
      !operation.controller.signal.aborted
    );
  }

  _invalidate(reason, { keepLoading = false } = {}) {
    this._generation++;
    if (this._debounceTimer != null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    const operation = this._operation;
    this._operation = null;
    if (operation && !operation.controller.signal.aborted) {
      operation.controller.abort(reason);
    }
    if (!keepLoading) this._updateLoading(false);
  }

  _updateLoading(loading) {
    if (this._loading === loading) return;
    this._loading = loading;
    this._setLoading(loading);
  }

  _assertAlive() {
    if (this._destroyed) throw new Error("DialogSource has been destroyed");
  }
};
