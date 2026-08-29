const crypto = require("crypto");
const { Disposable } = require("@lumine-code/event-kit");

function snapshot(surface) {
  if (!surface) return null;
  return Object.freeze({
    id: surface.id,
    kind: surface.kind,
    window: surface.window,
    document: surface.document,
    element: surface.element,
  });
}

function abortError() {
  const error = new Error("Window surface transition was aborted");
  error.name = "AbortError";
  return error;
}

class WindowSurfaceTransition {
  constructor(coordinator, { item, from, to, reason }) {
    this.coordinator = coordinator;
    this.controller = new AbortController();
    this.participants = [];
    this.state = "created";
    this.context = Object.freeze({
      id: crypto.randomUUID(),
      reason,
      item,
      from: snapshot(from),
      to: snapshot(to),
      signal: this.controller.signal,
    });
  }

  async begin() {
    if (this.state !== "created") throw new Error("Window surface transition already began");
    this.state = "preparing";
    const callbacks = [];
    if (typeof this.context.item?.beginWindowSurfaceTransition === "function") {
      callbacks.push((context) => this.context.item.beginWindowSurfaceTransition(context));
    }
    callbacks.push(...this.coordinator.observers);
    try {
      for (const callback of callbacks) {
        this.throwIfAborted();
        const participant = await callback(this.context);
        if (participant != null) {
          if (typeof participant !== "object") {
            throw new TypeError("A window surface transition participant must be an object");
          }
          this.participants.push(participant);
        }
        this.throwIfAborted();
      }
      this.state = "prepared";
      return this;
    } catch (error) {
      await this.rollback(error);
      throw error;
    }
  }

  async commit() {
    if (this.state !== "prepared") throw new Error("Window surface transition is not prepared");
    this.state = "committing";
    for (const participant of this.participants) {
      this.throwIfAborted();
      await participant.commit?.(this.context);
      this.throwIfAborted();
    }
    this.state = "participants-committed";
  }

  complete() {
    if (this.state !== "participants-committed") {
      throw new Error("Window surface transition participants have not committed");
    }
    this.state = "committed";
    this.finish();
  }

  async rollback(error) {
    if (this.state === "rolled-back") return;
    if (this.state === "committed") {
      throw new Error("A committed window surface transition cannot be rolled back");
    }
    this.state = "rolling-back";
    const rollbackContext = Object.freeze({ ...this.context, error });
    const failures = [];
    for (let index = this.participants.length - 1; index >= 0; index--) {
      try {
        await this.participants[index].rollback?.(rollbackContext);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    this.state = "rolled-back";
    this.finish();
    if (failures.length > 0) {
      const aggregate = new AggregateError(failures, "Window surface transition rollback failed");
      aggregate.cause = error;
      throw aggregate;
    }
  }

  abort() {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  abandon() {
    this.abort();
    this.state = "abandoned";
    this.finish();
  }

  throwIfAborted() {
    if (this.controller.signal.aborted) throw abortError();
  }

  finish() {
    this.coordinator.active.delete(this);
  }
}

module.exports = class WindowSurfaceTransitionCoordinator {
  constructor() {
    this.observers = [];
    this.active = new Set();
    this.destroyed = false;
  }

  addObserver(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("A window surface transition observer must be a function");
    }
    this.observers.push(callback);
    return new Disposable(() => {
      const index = this.observers.indexOf(callback);
      if (index >= 0) this.observers.splice(index, 1);
    });
  }

  async begin(options) {
    if (this.destroyed) throw new Error("Window surface transition coordinator is destroyed");
    if (!options?.item || !options.from || !options.to || typeof options.reason !== "string") {
      throw new TypeError("A window surface transition requires item, from, to, and reason");
    }
    const transition = new WindowSurfaceTransition(this, options);
    this.active.add(transition);
    return transition.begin();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortActive();
    this.observers = [];
  }

  abortActive() {
    for (const transition of this.active) transition.abort();
  }
};

module.exports.WindowSurfaceTransition = WindowSurfaceTransition;
