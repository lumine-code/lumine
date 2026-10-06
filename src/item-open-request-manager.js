const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");

const subscriptionFailures = new WeakMap();

function throwFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, message, { cause: failures[0] });
  }
}

function createSubscriptions() {
  const subscriptions = new CompositeDisposable();
  subscriptionFailures.set(subscriptions, []);
  return subscriptions;
}

function addSubscription(subscriptions, subscription) {
  // Registration can return after reset disposed this group. Composite.add
  // would ignore the returned observer, leaving it attached to the old pane.
  if (subscriptions.disposed) {
    subscription.dispose();
    return;
  }
  subscriptions.add(
    new Disposable(() => {
      try {
        subscription.dispose();
      } catch (error) {
        subscriptionFailures.get(subscriptions).push(error);
      }
    }),
  );
}

function disposeSubscriptions(subscriptions) {
  subscriptions.dispose();
  throwFailures(
    subscriptionFailures.get(subscriptions).splice(0),
    "Unable to remove open request observers",
  );
}

function paneIsAlive(pane) {
  return !!pane && !pane.isDestroyed?.() && pane.isAlive?.() !== false;
}

// Owns every asynchronous open until its presentation finishes. Preview
// supersession is narrower: preparing a possible pane does not claim it.
module.exports = class ItemOpenRequestManager {
  #inFlight = new Set();
  #previews = new Map();
  #paneSequences = new WeakMap();
  #states = new WeakMap();
  #sequence = 0;
  #generation = 0;
  #destroyed = false;
  #isAvailable;

  constructor({ isAvailable = () => true } = {}) {
    this.#isAvailable = isAvailable;
  }

  begin({ uri, pane } = {}) {
    const request = {
      uri,
      pane,
      sequence: ++this.#sequence,
      controller: new AbortController(),
      track: false,
      active: false,
      subscriptions: createSubscriptions(),
    };
    const state = {
      generation: this.#generation,
      inFlight: this.#inFlight,
      previews: this.#previews,
      anchorPane: pane,
      anchorSubscription: null,
      lifetimePane: null,
      lifetimeSubscription: null,
      previewPane: null,
      revision: 0,
      finished: false,
    };
    this.#states.set(request, state);
    if (this.#destroyed || !this.#isAvailable()) {
      request.controller.abort();
      return request;
    }
    this.#inFlight.add(request);
    if (pane) {
      if (!paneIsAlive(pane)) {
        request.controller.abort();
      } else {
        const subscription = pane.onWillDestroy(() => request.controller.abort());
        if (this.isCurrent(request)) state.anchorSubscription = subscription;
        else subscription.dispose();
      }
    }
    return request;
  }

  isCurrent(request) {
    const state = this.#states.get(request);
    return !!(
      state &&
      !state.finished &&
      this.#inFlight.has(request) &&
      !this.isCancelled(request)
    );
  }

  isCancelled(request) {
    const state = this.#states.get(request);
    return !!(
      !state ||
      this.#destroyed ||
      !this.#isAvailable() ||
      state.generation !== this.#generation ||
      request.controller.signal.aborted
    );
  }

  prepare(request, pane, track) {
    if (!this.isCurrent(request)) return;
    request.pane = pane;
    request.track = !!track;
  }

  activate(request, pane = request?.pane) {
    if (!this.isCurrent(request) || (request.active && request.pane === pane)) return;
    const state = this.#states.get(request);
    const revision = ++state.revision;
    if (!paneIsAlive(pane) || (this.#paneSequences.get(pane) || 0) > request.sequence) {
      request.controller.abort();
      this.stopTracking(request);
      return;
    }

    this.#paneSequences.set(pane, request.sequence);
    const previous = this.#previews.get(pane);
    this.stopTracking(request);
    if (!this.#ownsActivation(request, pane, revision)) return;

    if (previous && previous !== request) {
      previous.controller.abort();
      this.stopTracking(previous);
      if (!this.#ownsActivation(request, pane, revision)) return;
    }

    if (!this.#bindLifetime(request, pane, revision, true)) return;

    request.active = true;
    request.pane = pane;
    if (!request.track) return;

    const subscriptions = createSubscriptions();
    request.subscriptions = subscriptions;
    state.previewPane = pane;
    const observers = [
      () => pane.onItemDidTerminatePendingState(() => request.controller.abort()),
      () =>
        pane.onItemDidBecomePendingState((item) => {
          if (request.item && item !== request.item) request.controller.abort();
        }),
      () =>
        pane.onWillDestroyItem(({ item }) => {
          if (item === request.item) request.controller.abort();
        }),
      () =>
        pane.onWillRemoveItem(({ item }) => {
          if (item === request.item) request.controller.abort();
        }),
    ];
    for (const observe of observers) {
      addSubscription(subscriptions, observe());
      if (!this.#ownsActivation(request, pane, revision)) {
        if (state.revision === revision) this.stopTracking(request);
        else disposeSubscriptions(subscriptions);
        return;
      }
    }
    this.#previews.set(pane, request);
  }

  // A split owns its chosen pane's lifetime without claiming the anchor's
  // preview slot or superseding another request routed through that pane.
  bindPane(request, pane) {
    if (!this.isCurrent(request)) return;
    const state = this.#states.get(request);
    const revision = ++state.revision;
    if (!this.#bindLifetime(request, pane, revision, false)) return;
    request.pane = pane;
    request.active = true;
  }

  #bindLifetime(request, pane, revision, claimSequence) {
    const state = this.#states.get(request);
    if (!this.#ownsPane(request, pane, revision, claimSequence)) return false;
    if (state.lifetimePane !== pane) {
      const oldSubscription = state.lifetimeSubscription;
      state.lifetimeSubscription = null;
      state.lifetimePane = null;
      oldSubscription?.dispose();
      if (!this.#ownsPane(request, pane, revision, claimSequence)) return false;
      if (pane !== state.anchorPane) {
        const subscription = pane.onWillDestroy(() => request.controller.abort());
        if (!this.#ownsPane(request, pane, revision, claimSequence)) {
          subscription.dispose();
          return false;
        }
        state.lifetimeSubscription = subscription;
      }
      state.lifetimePane = pane;
    }
    return true;
  }

  #ownsActivation(request, pane, revision) {
    return this.#ownsPane(request, pane, revision, true);
  }

  #ownsPane(request, pane, revision, claimSequence) {
    const state = this.#states.get(request);
    if (state.revision !== revision) return false;
    if (!this.isCurrent(request)) return false;
    if (
      !paneIsAlive(pane) ||
      (claimSequence && this.#paneSequences.get(pane) !== request.sequence)
    ) {
      request.controller.abort();
      this.stopTracking(request);
      return false;
    }
    return true;
  }

  getForPane(pane) {
    return this.#previews.get(pane);
  }

  stopTracking(request) {
    const state = this.#states.get(request);
    if (!state) return;
    const pane = state.previewPane;
    state.previewPane = null;
    if (state.previews.get(pane) === request) state.previews.delete(pane);
    const subscriptions = request.subscriptions;
    request.subscriptions = createSubscriptions();
    disposeSubscriptions(subscriptions);
  }

  finish(request) {
    const state = this.#states.get(request);
    if (!state || state.finished) return;
    state.finished = true;
    state.inFlight.delete(request);
    request.active = false;
    const anchorSubscription = state.anchorSubscription;
    const lifetimeSubscription = state.lifetimeSubscription;
    state.anchorSubscription = null;
    state.lifetimeSubscription = null;
    state.lifetimePane = null;
    const failures = [];
    for (const dispose of [
      () => this.stopTracking(request),
      () => anchorSubscription?.dispose(),
      () => lifetimeSubscription?.dispose(),
    ]) {
      try {
        dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    throwFailures(failures, "Unable to finish an open request");
  }

  reset() {
    const requests = [...this.#inFlight];
    this.#generation++;
    this.#inFlight = new Set();
    this.#previews = new Map();
    this.#paneSequences = new WeakMap();
    const failures = [];
    for (const request of requests) {
      try {
        request.controller.abort();
      } catch (error) {
        failures.push(error);
      }
      try {
        this.finish(request);
      } catch (error) {
        failures.push(error);
      }
    }
    throwFailures(failures, "Unable to cancel all open requests");
  }

  destroy() {
    this.#destroyed = true;
    this.reset();
  }
};
