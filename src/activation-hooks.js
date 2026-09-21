const { Disposable } = require("@lumine-code/event-kit");

class ActivationHooksResetError extends Error {
  constructor() {
    super("Activation hooks were cleared");
    this.name = "ActivationHooksResetError";
  }
}

/**
 * Sticky, one-shot hooks describing events in the current editor window.
 *
 * Hooks are deliberately independent of package lifecycle. Core emits them;
 * packages subscribe to them to start a lazy feature. A hook remains observed
 * for one environment generation, so a subscriber registered after emission
 * receives a replay on a microtask.
 */
module.exports = class ActivationHooks {
  constructor() {
    this.listeners = new Map();
    this.hooks = new Map();
  }

  on(name, callback, { replay = true, signal } = {}) {
    this.validate(name, callback);
    if (typeof callback !== "function") {
      throw new TypeError("Activation hook callback must be a function");
    }
    let listeners = this.listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(name, listeners);
    }
    const registration = { callback, active: true };
    listeners.add(registration);

    const hook = this.hooks.get(name);
    if (replay && hook?.triggered) {
      queueMicrotask(() => {
        if (!registration.active) return;
        this.invokeReplay(name, registration, hook.detail);
      });
    }

    const subscription = new Disposable(() => {
      registration.active = false;
      listeners.delete(registration);
      if (listeners.size === 0) this.listeners.delete(name);
    });
    if (signal) {
      if (signal.aborted) subscription.dispose();
      else signal.addEventListener("abort", () => subscription.dispose(), { once: true });
    }
    return subscription;
  }

  trigger(name, detail) {
    this.validate(name);
    let hook = this.hooks.get(name);
    if (hook?.triggered) return hook.readinessPromise;

    if (!hook) {
      let resolveWhen;
      let rejectWhen;
      let resolveReadiness;
      let rejectReadiness;
      const whenPromise = new Promise((resolvePromise, rejectPromise) => {
        resolveWhen = resolvePromise;
        rejectWhen = rejectPromise;
      });
      const readinessPromise = new Promise((resolvePromise, rejectPromise) => {
        resolveReadiness = resolvePromise;
        rejectReadiness = rejectPromise;
      });
      whenPromise.catch(() => {});
      readinessPromise.catch(() => {});
      hook = {
        detail,
        whenPromise,
        readinessPromise,
        resolveWhen,
        rejectWhen,
        resolveReadiness,
        rejectReadiness,
        triggered: false,
        settled: false,
      };
      this.hooks.set(name, hook);
    } else {
      hook.detail = detail;
    }
    if (!hook.readinessPromise) {
      let resolveReadiness;
      let rejectReadiness;
      hook.readinessPromise = new Promise((resolvePromise, rejectPromise) => {
        resolveReadiness = resolvePromise;
        rejectReadiness = rejectPromise;
      });
      hook.resolveReadiness = resolveReadiness;
      hook.rejectReadiness = rejectReadiness;
      hook.readinessPromise.catch(() => {});
    }
    hook.triggered = true;
    hook.resolveWhen(detail);

    const listeners = [...(this.listeners.get(name) || [])];
    const readiness = Promise.all(
      listeners.map((registration) =>
        registration.active ? this.invoke(registration.callback, detail) : Promise.resolve(),
      ),
    );
    readiness.then(
      () => {
        if (hook.settled) return;
        hook.settled = true;
        hook.resolveReadiness();
      },
      (error) => {
        if (hook.settled) return;
        hook.settled = true;
        hook.rejectReadiness(error);
      },
    );
    return hook.readinessPromise;
  }

  when(name) {
    this.validate(name);
    const hook = this.hooks.get(name);
    if (hook) return hook.whenPromise;

    let resolveWhen;
    let rejectWhen;
    const whenPromise = new Promise((resolvePromise, rejectPromise) => {
      resolveWhen = resolvePromise;
      rejectWhen = rejectPromise;
    });
    whenPromise.catch(() => {});
    this.hooks.set(name, {
      detail: undefined,
      whenPromise,
      readinessPromise: null,
      resolveWhen,
      rejectWhen,
      resolveReadiness: null,
      rejectReadiness: null,
      triggered: false,
      settled: false,
    });
    return whenPromise;
  }

  hasOccurred(name) {
    this.validate(name);
    return this.hooks.get(name)?.triggered === true;
  }

  value(name) {
    this.validate(name);
    const hook = this.hooks.get(name);
    return hook?.triggered ? hook.detail : undefined;
  }

  clear() {
    const error = new ActivationHooksResetError();
    for (const listeners of this.listeners.values()) {
      for (const registration of listeners) registration.active = false;
    }
    for (const hook of this.hooks.values()) {
      if (!hook.settled) {
        hook.settled = true;
        hook.rejectWhen(error);
        hook.rejectReadiness?.(error);
      }
    }
    this.listeners.clear();
    this.hooks.clear();
  }

  dispose() {
    this.clear();
  }

  validate(name, callback) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError("Activation hook name must be a non-empty string");
    }
    if (callback != null && typeof callback !== "function") {
      throw new TypeError("Activation hook callback must be a function");
    }
  }

  invoke(callback, detail) {
    try {
      return Promise.resolve(callback(detail));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  invokeReplay(name, registration, detail) {
    this.invoke(registration.callback, detail).catch((error) => {
      console.error(`Activation hook '${name}' replay failed`, error);
    });
  }
};
