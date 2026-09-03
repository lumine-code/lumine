"use strict";

const { Disposable, Emitter } = require("@lumine-code/event-kit");

const ACTION_CONTEXTS = new Set(["item", "dialog"]);
const DISPOSITIONS = new Set(["close", "stay", "push"]);
const DEFAULT_GROUP = Symbol("default-dialog-action-group");

/**
 * Owns the explicit action catalogue and execution policy for a dialog.
 *
 * This class deliberately knows nothing about panels, command registries, or
 * DOM elements. Its collaborators resolve item identities, dispatch commands,
 * ask for confirmation, and apply the requested UI disposition.
 * @private
 */
class DialogActions {
  constructor({ dispatch, confirm, getItemId, resolveItemById, hooks } = {}) {
    if (typeof dispatch !== "function") {
      throw new TypeError("DialogActions requires a dispatch callback.");
    }
    if (confirm != null && typeof confirm !== "function") {
      throw new TypeError("DialogActions confirm must be a function.");
    }
    if (getItemId != null && typeof getItemId !== "function") {
      throw new TypeError("DialogActions getItemId must be a function.");
    }
    if (resolveItemById != null && typeof resolveItemById !== "function") {
      throw new TypeError("DialogActions resolveItemById must be a function.");
    }

    this.dispatch = dispatch;
    this.confirm = confirm ?? null;
    this.getItemId = getItemId ?? defaultItemId;
    this.resolveItemById = resolveItemById ?? null;
    if (hooks != null && (typeof hooks !== "object" || Array.isArray(hooks))) {
      throw new TypeError("DialogActions hooks must be an object.");
    }
    this.hooks = hooks ?? {};
    for (const name of [...DISPOSITIONS, "recordRecent"]) {
      if (this.hooks[name] != null && typeof this.hooks[name] !== "function") {
        throw new TypeError(`DialogActions hook '${name}' must be a function.`);
      }
    }

    this.actionsByCommand = new Map();
    this.nextDeclaration = 0;
    this.pendingRuns = new Map();
    this.emitter = new Emitter();
    this.destroyed = false;
    this.destroyPromise = null;
  }

  /**
   * Replaces the whole catalogue atomically.
   * @param {Array|Object} actions - Action descriptors or a command-keyed map
   * @returns {DialogActions} This catalogue
   */
  set(actions) {
    this.assertAlive();
    const entries = actionEntries(actions);
    const commands = new Set();
    const records = entries.map(([command, descriptor], declaration) => {
      if (commands.has(command)) throw new Error(`Dialog action '${command}' is duplicated.`);
      commands.add(command);
      return this.normalize(command, descriptor, declaration);
    });

    this.actionsByCommand = new Map(records.map((record) => [record.action.command, record]));
    this.nextDeclaration = records.length;
    return this;
  }

  /**
   * Adds one or more actions. Disposing the result removes only these exact
   * registrations, never a later action that reused the same command.
   * @param {String|Array|Object} commandOrActions - Command name or descriptors
   * @param {Object} [descriptor] - Descriptor when the first argument is a command
   * @returns {Disposable} Removes the added actions
   */
  add(commandOrActions, descriptor) {
    this.assertAlive();
    const entries =
      typeof commandOrActions === "string"
        ? actionEntries([[commandOrActions, descriptor]])
        : actionEntries(commandOrActions);
    const commands = new Set();
    const firstDeclaration = this.nextDeclaration;
    const records = entries.map(([command, action], index) => {
      if (commands.has(command) || this.actionsByCommand.has(command)) {
        throw new Error(`Dialog action '${command}' is already registered.`);
      }
      commands.add(command);
      return this.normalize(command, action, firstDeclaration + index);
    });

    for (const record of records) this.actionsByCommand.set(record.action.command, record);
    this.nextDeclaration += records.length;
    return new Disposable(() => {
      for (const record of records) {
        if (this.actionsByCommand.get(record.action.command) === record) {
          this.actionsByCommand.delete(record.action.command);
        }
      }
    });
  }

  /**
   * Returns actions whose `when` predicate applies to a snapshot of the given
   * context. Disabled actions remain present and carry their evaluated reason.
   * @param {Object} context - Current dialog context
   * @returns {Array<Object>} Evaluated action descriptors
   */
  getAvailable(context = {}) {
    if (this.destroyed) return [];
    const snapshot = this.snapshot(context);
    return this.evaluate(snapshot).map(({ view }) => view);
  }

  /** Returns the declared actions in stable catalogue order. */
  getAll() {
    if (this.destroyed) return [];
    return Array.from(this.actionsByCommand.values(), ({ action }) => action);
  }

  has(command) {
    return !this.destroyed && this.actionsByCommand.has(command);
  }

  /**
   * Returns whether at least one action applies. This deliberately skips
   * `enabled` and `disabledReason`, while still validating the primary action.
   * @param {Object} context - Current dialog context
   * @returns {Boolean} Whether any action is available
   */
  hasAvailable(context = {}) {
    if (this.destroyed) return false;
    const snapshot = this.snapshot(context);
    return this.applicableRecords(snapshot).length > 0;
  }

  /**
   * Returns the sole applicable primary action, or null.
   * @param {Object} context - Current dialog context
   * @returns {Object|null} Evaluated primary action
   */
  getPrimary(context = {}) {
    return this.getAvailable(context).find((action) => action.primary) ?? null;
  }

  /**
   * Runs an action. A second invocation of the same command while it is in
   * flight receives the original promise and cannot dispatch it twice.
   * @param {String} command - Registered action command
   * @param {Object} context - Current dialog context
   * @returns {Promise<Object>} Completion record
   */
  run(command, context = {}) {
    if (this.destroyed) {
      return Promise.resolve(Object.freeze({ command, status: "destroyed" }));
    }
    const record = this.actionsByCommand.get(command);
    if (!record) throw new Error(`Unknown dialog action '${command}'.`);

    const pending = this.pendingRuns.get(command);
    if (pending) return pending.promise;

    const state = {
      command,
      record,
      controller: new AbortController(),
      snapshot: this.snapshot(context),
      promise: null,
    };
    // Start in a microtask so the pending record exists before `did-start` can
    // synchronously re-enter the runner with the same command.
    state.promise = Promise.resolve().then(() => this.performRun(state));
    this.pendingRuns.set(command, state);
    state.promise.then(
      () => this.clearPending(state),
      () => this.clearPending(state),
    );
    return state.promise;
  }

  /**
   * Returns whether work is in flight, optionally for one command.
   * @param {String} [command] - Action command
   * @returns {Boolean} Whether a matching run is pending
   */
  isPending(command) {
    if (command == null) return this.pendingRuns.size > 0;
    return this.pendingRuns.has(command);
  }

  onDidStart(callback) {
    return this.emitter.on("did-start", callback);
  }

  onDidFinish(callback) {
    return this.emitter.on("did-finish", callback);
  }

  /**
   * Aborts every pending run and disposes the catalogue after they observe the
   * cancellation. Repeated calls return the same promise.
   * @returns {Promise} Resolves when pending runners have finished
   */
  destroy() {
    if (this.destroyPromise) return this.destroyPromise;

    this.destroyed = true;
    this.actionsByCommand.clear();
    const pending = Array.from(this.pendingRuns.values());
    for (const state of pending) state.controller.abort();

    this.destroyPromise = Promise.allSettled(pending.map((state) => state.promise)).then(() => {
      this.pendingRuns.clear();
      this.emitter.dispose();
    });
    return this.destroyPromise;
  }

  assertAlive() {
    if (this.destroyed) throw new Error("DialogActions has been destroyed.");
  }

  normalize(command, descriptor, declaration) {
    if (!command || typeof command !== "string") {
      throw new TypeError("Dialog action command must be a non-empty string.");
    }
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new TypeError(`Dialog action '${command}' must have a descriptor.`);
    }
    if (descriptor.command != null && descriptor.command !== command) {
      throw new Error(`Dialog action key '${command}' does not match '${descriptor.command}'.`);
    }
    if (!ACTION_CONTEXTS.has(descriptor.context)) {
      throw new Error(`Dialog action '${command}' must declare context 'item' or 'dialog'.`);
    }
    if (!DISPOSITIONS.has(descriptor.disposition)) {
      throw new Error(
        `Dialog action '${command}' must declare disposition 'close', 'stay', or 'push'.`,
      );
    }
    for (const name of ["when", "enabled", "primary", "recordsRecent"]) {
      const value = descriptor[name];
      if (value != null && typeof value !== "boolean" && typeof value !== "function") {
        throw new TypeError(`Dialog action '${command}' ${name} must be a boolean or function.`);
      }
    }
    if (
      descriptor.disabledReason != null &&
      typeof descriptor.disabledReason !== "string" &&
      typeof descriptor.disabledReason !== "function"
    ) {
      throw new TypeError(
        `Dialog action '${command}' disabledReason must be a string or function.`,
      );
    }
    if (descriptor.group != null && typeof descriptor.group !== "string") {
      throw new TypeError(`Dialog action '${command}' group must be a string.`);
    }
    if (descriptor.order != null && !Number.isFinite(descriptor.order)) {
      throw new TypeError(`Dialog action '${command}' order must be a finite number.`);
    }

    return Object.freeze({
      action: Object.freeze({
        ...descriptor,
        command,
        group: descriptor.group ?? null,
        order: descriptor.order ?? 0,
      }),
      declaration,
    });
  }

  snapshot(context) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new TypeError("Dialog action context must be an object.");
    }
    const snapshot = { ...context };
    if (Array.isArray(snapshot.items)) snapshot.items = Object.freeze([...snapshot.items]);
    if (!("itemId" in snapshot) && snapshot.item != null) {
      snapshot.itemId = this.getItemId(snapshot.item, snapshot);
    }
    return Object.freeze(snapshot);
  }

  applicableRecords(context) {
    const applicable = [];
    const primaries = [];
    for (const record of this.actionsByCommand.values()) {
      const action = record.action;
      if (action.context === "item" && context.item == null) continue;
      if (!evaluateBoolean(action.when, true, context, action, "when")) continue;

      const primary = evaluateBoolean(action.primary, false, context, action, "primary");
      const evaluated = { record, primary };
      applicable.push(evaluated);
      if (primary) primaries.push(action.command);
    }
    if (primaries.length > 1) {
      throw new Error(`Multiple primary dialog actions apply: ${primaries.join(", ")}.`);
    }
    return this.sort(applicable);
  }

  evaluate(context) {
    return this.applicableRecords(context).map(({ record, primary }) => {
      const action = record.action;
      const enabled = evaluateBoolean(action.enabled, true, context, action, "enabled");
      let disabledReason = null;
      if (!enabled && action.disabledReason != null) {
        disabledReason = evaluateValue(action.disabledReason, context, action, "disabledReason");
      }
      return {
        record,
        view: Object.freeze({ ...action, primary, enabled, disabledReason }),
      };
    });
  }

  sort(applicable) {
    const groupDeclarations = new Map();
    for (const record of this.actionsByCommand.values()) {
      const group = record.action.group ?? DEFAULT_GROUP;
      if (!groupDeclarations.has(group)) groupDeclarations.set(group, record.declaration);
    }
    return applicable.sort((left, right) => {
      const leftGroup = left.record.action.group ?? DEFAULT_GROUP;
      const rightGroup = right.record.action.group ?? DEFAULT_GROUP;
      return (
        groupDeclarations.get(leftGroup) - groupDeclarations.get(rightGroup) ||
        left.record.action.order - right.record.action.order ||
        left.record.declaration - right.record.declaration
      );
    });
  }

  async performRun(state) {
    const { command, record, controller, snapshot } = state;
    const { signal } = controller;
    this.emitter.emit(
      "did-start",
      Object.freeze({ command, action: record.action, context: snapshot, signal }),
    );

    try {
      let context = await this.revalidate(record.action, snapshot, signal);
      if (!context) return this.finish(state, "unavailable", { reason: "missing-item" });
      let evaluated = this.evaluatedRecord(record, context);
      if (!evaluated) return this.finish(state, "unavailable", { reason: "when", context });
      if (!evaluated.view.enabled) {
        return this.finish(state, "disabled", {
          reason: evaluated.view.disabledReason,
          context,
        });
      }

      if (record.action.confirm) {
        if (!this.confirm) {
          throw new Error(`Dialog action '${command}' requires a confirm callback.`);
        }
        const confirmed = await callWithSignal(
          () =>
            this.confirm({
              action: evaluated.view,
              confirmation: record.action.confirm,
              context,
              signal,
            }),
          signal,
        );
        if (!confirmed) return this.finish(state, "cancelled", { context });

        // Confirmation can stay open while the underlying list changes. Resolve
        // the same identity and its predicates again immediately before dispatch.
        context = await this.revalidate(record.action, snapshot, signal);
        if (!context) return this.finish(state, "unavailable", { reason: "missing-item" });
        evaluated = this.evaluatedRecord(record, context);
        if (!evaluated) return this.finish(state, "unavailable", { reason: "when", context });
        if (!evaluated.view.enabled) {
          return this.finish(state, "disabled", {
            reason: evaluated.view.disabledReason,
            context,
          });
        }
      }

      const value = await callWithSignal(
        () => this.dispatch({ action: evaluated.view, context, signal }),
        signal,
      );
      const payload = {
        action: evaluated.view,
        context,
        disposition: record.action.disposition,
        signal,
        value,
      };

      if (
        evaluateBoolean(
          record.action.recordsRecent,
          false,
          context,
          record.action,
          "recordsRecent",
          value,
        ) &&
        this.hooks.recordRecent
      ) {
        await callWithSignal(() => this.hooks.recordRecent(payload), signal);
      }
      const dispositionHook = this.hooks[record.action.disposition];
      if (dispositionHook) await callWithSignal(() => dispositionHook(payload), signal);

      return this.finish(state, "success", { context, value });
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        return this.finish(state, "aborted", { reason: signal.reason });
      }
      this.finish(state, "error", { error });
      throw error;
    }
  }

  async revalidate(action, snapshot, signal) {
    if (action.context !== "item") return snapshot;
    if (snapshot.item == null) return null;
    if (!this.resolveItemById) return snapshot;
    if (snapshot.itemId == null) return null;

    const item = await callWithSignal(
      () => this.resolveItemById(snapshot.itemId, snapshot, signal),
      signal,
    );
    if (item == null) return null;
    return Object.freeze({ ...snapshot, item, itemId: snapshot.itemId });
  }

  evaluatedRecord(record, context) {
    // An action can be removed or replaced while an async resolver/confirmation
    // is in flight. The stale registration must never dispatch its replacement.
    if (this.actionsByCommand.get(record.action.command) !== record) return null;
    return this.evaluate(context).find((candidate) => candidate.record === record) ?? null;
  }

  finish(state, status, details = {}) {
    const event = Object.freeze({
      command: state.command,
      action: state.record.action,
      context: details.context ?? state.snapshot,
      signal: state.controller.signal,
      status,
      ...(details.reason !== undefined ? { reason: details.reason } : {}),
      ...(details.value !== undefined ? { value: details.value } : {}),
      ...(details.error !== undefined ? { error: details.error } : {}),
    });
    this.emitter.emit("did-finish", event);
    return event;
  }

  clearPending(state) {
    if (this.pendingRuns.get(state.command) === state) this.pendingRuns.delete(state.command);
  }
}

function defaultItemId(item) {
  if (item !== null && typeof item === "object") return item.id;
  return item;
}

function actionEntries(actions) {
  if (actions == null) return [];
  if (Array.isArray(actions)) {
    return actions.map((entry) => {
      if (Array.isArray(entry)) return entry;
      return [entry?.command, entry];
    });
  }
  if (typeof actions === "object") {
    if (Object.prototype.hasOwnProperty.call(actions, "command")) {
      return [[actions.command, actions]];
    }
    return Object.entries(actions);
  }
  throw new TypeError("Dialog actions must be an array or command-keyed object.");
}

function evaluateBoolean(value, fallback, context, action, name, result) {
  const evaluated = value == null ? fallback : evaluateValue(value, context, action, name, result);
  if (evaluated && typeof evaluated.then === "function") {
    throw new TypeError(`Dialog action '${action.command}' ${name} must be synchronous.`);
  }
  return Boolean(evaluated);
}

function evaluateValue(value, context, action, name, result) {
  const evaluated = typeof value === "function" ? value(context, action, result) : value;
  if (evaluated && typeof evaluated.then === "function") {
    throw new TypeError(`Dialog action '${action.command}' ${name} must be synchronous.`);
  }
  return evaluated;
}

function abortError(reason) {
  const error = new Error("Dialog action was aborted.");
  error.name = "AbortError";
  error.reason = reason;
  return error;
}

function waitFor(value, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  const operation = Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function callWithSignal(callback, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  let value;
  try {
    value = callback();
  } catch (error) {
    return Promise.reject(error);
  }
  return waitFor(value, signal);
}

module.exports = DialogActions;
