const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { Disposable } = require("@lumine-code/event-kit");
const StateStore = require("./state-store");
const { getProjectStateKey } = require("./project-state-keys");

const GLOBAL_SCOPE = "global";
const DELETE = Symbol("delete");
const VALUE_CHANGE = Object.freeze({ scopeChanged: false });
const SCOPE_CHANGE = Object.freeze({ scopeChanged: true });

/** Package-owned JSON values, shared by profile or project rather than workspace snapshots. */
module.exports = class PackageStorage {
  constructor({ onDidCommit } = {}) {
    this.onDidCommit = onDidCommit;
    this.sourceId = crypto.randomUUID();
    this.windowStateId = this.sourceId;
    this.projectScopeId = projectScopeId([], this.windowStateId);
    this.projectScopeGeneration = 0;
    this.records = new Map();
    this.packages = new Map();
    this.operationPromise = Promise.resolve();
    this.ready = Promise.resolve();
    this.readable = true;
    this.closed = false;
    this.closing = false;
  }

  initialize({
    configDirPath,
    projectPaths = [],
    windowStateId = this.windowStateId,
    enabled = true,
  }) {
    this.assertOpen();
    const nextProjectScopeId = projectScopeId(projectPaths, windowStateId);
    this.windowStateId = windowStateId;
    if (!enabled && !this.stateStore) {
      this.rebindProject(nextProjectScopeId);
      this.ready = Promise.resolve();
      return this.ready;
    }
    this.readable = false;
    this.ready = this.enqueue(async () => {
      this.stateStore?.close();
      this.stateStore = null;
      if (enabled) {
        const store = new StateStore("package-storage", 1);
        store.initialize({ configDirPath });
        await store.connect();
        if (!store.isConnected()) throw new Error("Package storage is unavailable");
        this.stateStore = store;
      }
      const global = await this.readRecord(GLOBAL_SCOPE);
      const project = await this.readRecord(nextProjectScopeId);
      this.records.set(GLOBAL_SCOPE, global);
      this.records.set(nextProjectScopeId, project);
      this.projectScopeId = nextProjectScopeId;
      this.readable = true;
    });
    return this.ready;
  }

  forPackage(name) {
    this.assertOpen();
    if (typeof name !== "string" || !name) throw new TypeError("A package name is required");
    let storage = this.packages.get(name);
    if (!storage) {
      storage = {
        globalState: new StorageScope(this, name, false),
        workspaceState: new StorageScope(this, name, true),
      };
      this.packages.set(name, storage);
    }
    return storage;
  }

  switchProject(paths) {
    this.assertOpen();
    this.assertReadable();
    const scopeId = projectScopeId(paths, this.windowStateId);
    if (scopeId !== this.projectScopeId) {
      const record = this.stateStore
        ? normalizeRecord(this.stateStore.loadSync(scopeId))
        : this.record(scopeId);
      this.applyRecord(scopeId, record, { force: true });
      this.rebindProject(scopeId);
    }
    return this.flush();
  }

  /** Receive a post-commit notification from another renderer. */
  reloadScope({ scopeId, revision, sourceId } = {}) {
    if (this.closing || this.closed || sourceId === this.sourceId) return Promise.resolve();
    return this.enqueue(async () => {
      this.assertReadable();
      const scopes =
        scopeId === "*"
          ? [GLOBAL_SCOPE, this.projectScopeId]
          : [GLOBAL_SCOPE, this.projectScopeId].filter((scope) => scope === scopeId);
      for (const scope of scopes) {
        if (scopeId !== "*" && revision <= this.record(scope).revision) continue;
        this.applyRecord(scope, await this.readRecord(scope), { force: scopeId === "*" });
      }
    });
  }

  flush() {
    return this.operationPromise;
  }

  /** Reset fixture memory and subscriptions without deleting a persistent profile. */
  reset() {
    this.assertOpen();
    return this.enqueue(async () => {
      this.disposeScopes();
      if (!this.stateStore) this.records.clear();
      else {
        this.records.clear();
        this.records.set(GLOBAL_SCOPE, await this.readRecord(GLOBAL_SCOPE));
        this.records.set(this.projectScopeId, await this.readRecord(this.projectScopeId));
      }
    });
  }

  /** Explicitly delete this subsystem's values; unrelated session tables are untouched. */
  clear() {
    this.assertOpen();
    return this.enqueue(async () => {
      this.assertReadable();
      await this.stateStore?.clear();
      const before = this.records;
      this.records = new Map();
      this.notifyScope(GLOBAL_SCOPE, before.get(GLOBAL_SCOPE), emptyRecord());
      this.notifyScope(this.projectScopeId, before.get(this.projectScopeId), emptyRecord());
      this.broadcast({ scopeId: "*" });
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.operationPromise.then(() => {
      this.stateStore?.close();
      this.stateStore = null;
      this.disposeScopes();
      this.records.clear();
      this.closed = true;
    });
    return this.closePromise;
  }

  dispose() {
    return this.close();
  }

  enqueue(operation) {
    const result = this.operationPromise.then(operation);
    this.operationPromise = result.catch(() => {});
    return result;
  }

  assertOpen() {
    if (this.closed || this.closing) throw new Error("Package storage is closed");
  }

  assertReadable() {
    if (!this.readable) throw new Error("Package storage has not finished loading");
    if (this.closed) throw new Error("Package storage is closed");
  }

  record(scopeId) {
    return this.records.get(scopeId) ?? emptyRecord();
  }

  async readRecord(scopeId) {
    return this.stateStore
      ? normalizeRecord(await this.stateStore.load(scopeId))
      : this.record(scopeId);
  }

  get(scopeId, packageName, key, defaultValue) {
    this.assertReadable();
    const values = own(this.record(scopeId).packages, packageName);
    return copyOptional(values && Object.hasOwn(values, key) ? values[key] : defaultValue);
  }

  keys(scopeId, packageName) {
    this.assertReadable();
    return Object.keys(own(this.record(scopeId).packages, packageName) ?? {});
  }

  write(scopeId, packageName, key, updater) {
    this.assertOpen();
    this.assertReadable();
    return this.enqueue(async () => {
      let changed = false;
      const update = (stored) => {
        const record = normalizeRecord(stored);
        const values = own(record.packages, packageName) ?? {};
        const oldValue = own(values, key);
        const next = updater(copyOptional(oldValue));
        if (typeof next?.then === "function") {
          Promise.resolve(next).catch(() => {});
          throw new TypeError("A package storage updater must be synchronous");
        }
        const newValue = next === DELETE ? undefined : copyJson(next);
        if (isDeepStrictEqual(oldValue, newValue)) return record;
        const nextValues = { ...values };
        if (next === DELETE) delete nextValues[key];
        else Object.defineProperty(nextValues, key, { value: newValue, enumerable: true });
        changed = true;
        return {
          version: 1,
          revision: record.revision + 1,
          packages: { ...record.packages, [packageName]: nextValues },
        };
      };
      const record = this.stateStore
        ? await this.stateStore.update(scopeId, update)
        : update(this.record(scopeId));
      this.applyRecord(scopeId, record, { force: true });
      if (changed) this.broadcast({ scopeId, revision: record.revision });
      return this.get(scopeId, packageName, key);
    });
  }

  applyRecord(scopeId, record, { force = false } = {}) {
    const previous = this.record(scopeId);
    if (!force && record.revision < previous.revision) return;
    this.records.set(scopeId, record);
    this.notifyScope(scopeId, previous, record);
  }

  rebindProject(scopeId) {
    if (scopeId === this.projectScopeId) return;
    const previous = this.record(this.projectScopeId);
    this.projectScopeId = scopeId;
    const generation = ++this.projectScopeGeneration;
    for (const storage of [...this.packages.values()]) {
      if (this.projectScopeGeneration !== generation) break;
      storage.workspaceState.notify(previous, this.record(scopeId), true);
    }
  }

  notifyScope(scopeId, previous = emptyRecord(), record) {
    for (const storage of [...this.packages.values()]) {
      if (scopeId === GLOBAL_SCOPE) storage.globalState.notify(previous, record);
      if (scopeId === this.projectScopeId) storage.workspaceState.notify(previous, record);
    }
  }

  broadcast(change) {
    try {
      const result = this.onDidCommit?.({ ...change, sourceId: this.sourceId });
      result?.catch?.((error) => console.error("Unable to broadcast package storage", error));
    } catch (error) {
      console.error("Unable to broadcast package storage", error);
    }
  }

  disposeScopes() {
    for (const storage of this.packages.values()) {
      storage.globalState.dispose();
      storage.workspaceState.dispose();
    }
    this.packages.clear();
  }
};

/**
 * @public
 * @status extended
 *
 * Package-owned JSON values in one persistent scope. Package lifecycle hooks
 * receive these handles as `context.globalState` and `context.workspaceState`.
 * Global values are shared by every window and project in the profile. Workspace
 * values follow the set of project roots; an empty workspace uses the persistent
 * window identity. Existing workspace handles and observers follow scope changes.
 * Values are detached JSON data. Writes become visible after their durable
 * transaction commits, before the returned promise resolves.
 */
class StorageScope {
  constructor(manager, packageName, project) {
    this.manager = manager;
    this.packageName = packageName;
    this.project = project;
    this.listeners = new Map();
    this.disposed = false;
  }

  scopeId() {
    if (this.disposed) throw new Error("Package storage scope is disposed");
    this.manager.assertOpen();
    return this.project ? this.manager.projectScopeId : GLOBAL_SCOPE;
  }

  /**
   * @public
   * @status extended
   *
   * Return a detached cached value, or the default when this key is absent.
   * @param {String} key - Package-owned key.
   * @param {*} [defaultValue] - JSON value returned for an absent key.
   * @returns {*} A detached JSON value, or `undefined` when absent without a default.
   */
  get(key, defaultValue) {
    assertKey(key);
    return this.manager.get(this.scopeId(), this.packageName, key, defaultValue);
  }

  /**
   * @public
   * @status extended
   *
   * List this package's keys in the selected scope.
   * @returns {Array<String>} Stored keys, excluding removed values.
   */
  keys() {
    return this.manager.keys(this.scopeId(), this.packageName);
  }

  /**
   * @public
   * @status extended
   *
   * Persist a JSON value, or remove the key when the value is `undefined`.
   * The input is detached when this method is called.
   * @param {String} key - Package-owned key.
   * @param {*} value - JSON value to persist, or `undefined` to remove the key.
   * @returns {Promise<void>} Resolves after the transaction commits.
   */
  update(key, value) {
    return this.write(key, () => {
      const detached = value === undefined ? DELETE : copyJson(value);
      return () => detached;
    }).then(() => {});
  }

  /**
   * @public
   * @status extended
   *
   * Atomically update the latest persisted value, including writes from other
   * windows. The pure updater runs synchronously inside a short transaction and
   * receives a detached value, or `undefined` for an absent key. It must return
   * JSON data, or `undefined` to remove the key, and must not perform I/O or
   * modify other storage keys. This is a Lumine extension to the memento API.
   * @param {String} key - Package-owned key.
   * @param {Function} updater - Synchronous function returning the replacement value.
   * @returns {Promise<*>} Resolves to the committed, detached value.
   */
  mutate(key, updater) {
    return this.write(key, () => {
      if (typeof updater !== "function") throw new TypeError("An updater function is required");
      return (current) => {
        const next = updater(current);
        return next === undefined ? DELETE : next;
      };
    });
  }

  write(key, prepareUpdater) {
    try {
      assertKey(key);
      const scopeId = this.scopeId();
      const updater = prepareUpdater();
      return this.manager.write(scopeId, this.packageName, key, updater);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * @public
   * @status extended
   *
   * Call immediately with the cached value, then after committed changes. An
   * absent key supplies `undefined`. A workspace observer also runs when its
   * handle follows different project roots, even when the value is unchanged.
   * @param {String} key - Package-owned key.
   * @param {Function} callback - Receives a detached current value and readonly `{scopeChanged}` metadata. The flag is true only when an existing workspace handle follows different project roots.
   * @returns {Disposable} Stops observing when disposed.
   */
  observe(key, callback) {
    const subscription = this.subscribe(key, callback, true);
    try {
      callback(this.get(key), VALUE_CHANGE);
    } catch (error) {
      subscription.dispose();
      throw error;
    }
    return subscription;
  }

  /**
   * @public
   * @status extended
   *
   * Observe value changes without an immediate callback. Workspace scope changes
   * emit only when the old and new values differ.
   * @param {String} key - Package-owned key.
   * @param {Function} callback - Receives `{oldValue, newValue}` with detached values and readonly `{scopeChanged}` metadata.
   * @returns {Disposable} Stops observing when disposed.
   */
  onDidChange(key, callback) {
    return this.subscribe(key, callback, false);
  }

  subscribe(key, callback, observe) {
    assertKey(key);
    this.scopeId();
    if (typeof callback !== "function") throw new TypeError("A callback function is required");
    const listener = { callback, observe };
    let listeners = this.listeners.get(key);
    if (!listeners) this.listeners.set(key, (listeners = new Set()));
    listeners.add(listener);
    return new Disposable(() => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(key) === listeners) this.listeners.delete(key);
    });
  }

  notify(previous, record, rebound = false) {
    const generation = this.manager.projectScopeGeneration;
    const oldValues = own(previous.packages, this.packageName) ?? {};
    const newValues = own(record.packages, this.packageName) ?? {};
    for (const [key, listeners] of [...this.listeners]) {
      const oldValue = own(oldValues, key);
      const newValue = own(newValues, key);
      const changed = !isDeepStrictEqual(oldValue, newValue);
      for (const listener of [...listeners]) {
        if (this.project && this.manager.projectScopeGeneration !== generation) return;
        if (!changed && !(rebound && listener.observe)) continue;
        try {
          listener.callback(
            listener.observe
              ? copyOptional(newValue)
              : { oldValue: copyOptional(oldValue), newValue: copyOptional(newValue) },
            rebound ? SCOPE_CHANGE : VALUE_CHANGE,
          );
        } catch (error) {
          console.error("Package storage observer failed", error);
        }
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}

function projectScopeId(paths, windowStateId) {
  if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string" || !value))
    throw new TypeError("Project paths must be an array of non-empty strings");
  const projectKey = getProjectStateKey([...new Set(paths)]);
  if (projectKey) return `project:${projectKey}`;
  if (typeof windowStateId !== "string" || !windowStateId)
    throw new TypeError("A window state id is required for an empty project's storage");
  return `window:${windowStateId}`;
}

function emptyRecord() {
  return { version: 1, revision: 0, packages: {} };
}

function normalizeRecord(record) {
  if (record == null) return emptyRecord();
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !isRecord(record.packages) ||
    Object.values(record.packages).some((values) => !isRecord(values))
  )
    throw new Error("Unsupported or malformed package storage record");
  return copyJson(record);
}

function own(value, key) {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}

function assertKey(key) {
  if (typeof key !== "string") throw new TypeError("A package storage key must be a string");
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function copyOptional(value) {
  return value === undefined ? undefined : copyJson(value);
}

function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (
    (!isRecord(value) && !Array.isArray(value)) ||
    ancestors.has(value) ||
    Object.getOwnPropertySymbols(value).length ||
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new TypeError("Package storage values must contain only JSON data");
  ancestors.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = Array.from(value, (item) => copyJson(item, ancestors));
  } else {
    copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copyJson(item, ancestors)]),
    );
  }
  ancestors.delete(value);
  return copy;
}
