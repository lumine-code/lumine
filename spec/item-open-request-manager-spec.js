const { Disposable, Emitter } = require("@lumine-code/event-kit");
const ItemOpenRequestManager = require("../src/item-open-request-manager");

describe("ItemOpenRequestManager", () => {
  function makePane() {
    const emitter = new Emitter();
    let destroyed = false;
    return {
      isDestroyed: () => destroyed,
      onWillDestroy: (callback) => emitter.on("will-destroy", callback),
      onItemDidTerminatePendingState: (callback) => emitter.on("terminate-pending", callback),
      onItemDidBecomePendingState: (callback) => emitter.on("become-pending", callback),
      onWillDestroyItem: (callback) => emitter.on("destroy-item", callback),
      onWillRemoveItem: (callback) => emitter.on("remove-item", callback),
      terminatePendingState: () => emitter.emit("terminate-pending"),
      destroy() {
        emitter.emit("will-destroy");
        destroyed = true;
        emitter.dispose();
      },
    };
  }

  function activatePreview(manager, pane, uri) {
    const request = manager.begin({ uri });
    manager.prepare(request, pane, true);
    manager.activate(request);
    return request;
  }

  it("does not supersede a preview until the new request claims its actual destination", () => {
    const manager = new ItemOpenRequestManager();
    const center = makePane();
    const dock = makePane();
    const existing = activatePreview(manager, center, "preview://center");
    const candidate = manager.begin({ uri: "preview://dock" });
    manager.prepare(candidate, center, true);

    expect(existing.controller.signal.aborted).toBe(false);
    expect(manager.getForPane(center)).toBe(existing);
    manager.prepare(candidate, dock, true);
    manager.activate(candidate);

    expect(manager.getForPane(center)).toBe(existing);
    expect(manager.getForPane(dock)).toBe(candidate);
    expect(manager.isCurrent(existing)).toBe(true);
  });

  it("does not bind a provisional pane's lifetime before the destination is known", () => {
    const manager = new ItemOpenRequestManager();
    const provisional = makePane();
    const actual = makePane();
    const request = manager.begin({ uri: "preview://routed" });
    manager.prepare(request, provisional, true);
    provisional.destroy();

    expect(manager.isCurrent(request)).toBe(true);
    manager.prepare(request, actual, true);
    manager.activate(request);
    expect(manager.getForPane(actual)).toBe(request);
    actual.destroy();
    expect(request.controller.signal.aborted).toBe(true);
    expect(manager.isCurrent(request)).toBe(false);
  });

  it("cancels an explicit anchor before activation, including permanent requests", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const request = manager.begin({ uri: "permanent://anchored", pane });
    pane.destroy();

    expect(request.controller.signal.aborted).toBe(true);
    expect(manager.isCurrent(request)).toBe(false);
  });

  it("rejects a delayed destination claim after a newer preview has claimed that pane", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const delayed = manager.begin({ uri: "preview://delayed" });
    manager.prepare(delayed, pane, true);
    const current = activatePreview(manager, pane, "preview://current");
    manager.activate(delayed);

    expect(delayed.controller.signal.aborted).toBe(true);
    expect(manager.getForPane(pane)).toBe(current);
    manager.finish(delayed);
    expect(manager.isCurrent(current)).toBe(true);
    expect(manager.getForPane(pane)).toBe(current);
  });

  it("keeps ownership after preview tracking stops and aborts every unfinished request on reset", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const presenting = activatePreview(manager, pane, "preview://presenting");
    manager.stopTracking(presenting);
    pane.terminatePendingState();
    expect(presenting.controller.signal.aborted).toBe(false);
    expect(manager.isCurrent(presenting)).toBe(true);
    expect(manager.getForPane(pane)).toBeUndefined();
    const permanent = manager.begin({ uri: "permanent://loading" });
    manager.prepare(permanent, pane, false);
    manager.activate(permanent);
    const unrouted = manager.begin({ uri: "split://loading" });
    manager.reset();

    for (const request of [presenting, permanent, unrouted]) {
      expect(request.controller.signal.aborted).toBe(true);
      expect(manager.isCurrent(request)).toBe(false);
    }
    const current = activatePreview(manager, pane, "preview://new-generation");
    manager.finish(presenting);
    expect(manager.getForPane(pane)).toBe(current);
    expect(manager.isCurrent(current)).toBe(true);
  });

  it("preserves a newer activation started by the superseded request's abort observer", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const first = activatePreview(manager, pane, "preview://first");
    let newest;
    first.controller.signal.addEventListener("abort", () => {
      newest = activatePreview(manager, pane, "preview://newest");
    });
    const superseded = activatePreview(manager, pane, "preview://middle");

    expect(first.controller.signal.aborted).toBe(true);
    expect(superseded.controller.signal.aborted).toBe(true);
    expect(manager.getForPane(pane)).toBe(newest);
    expect(manager.isCurrent(newest)).toBe(true);
    manager.finish(first);
    manager.finish(superseded);
    expect(manager.getForPane(pane)).toBe(newest);
  });

  it("does not clean up a new generation created while reset aborts the old one", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const previous = activatePreview(manager, pane, "preview://previous");
    let current;
    previous.controller.signal.addEventListener("abort", () => {
      current = activatePreview(manager, pane, "preview://current");
    });
    manager.reset();

    expect(manager.isCurrent(previous)).toBe(false);
    expect(manager.isCurrent(current)).toBe(true);
    expect(manager.getForPane(pane)).toBe(current);
    manager.finish(previous);
    expect(manager.getForPane(pane)).toBe(current);
  });

  it("keeps destroy terminal even when abort observers or reset request a new generation", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const previous = activatePreview(manager, pane, "preview://previous");
    let reentrant;
    previous.controller.signal.addEventListener("abort", () => {
      reentrant = manager.begin({ uri: "preview://reentrant", pane });
    });
    manager.destroy();
    manager.reset();
    const future = manager.begin({ uri: "preview://future", pane });

    for (const request of [previous, reentrant, future]) {
      expect(request.controller.signal.aborted).toBe(true);
      expect(manager.isCurrent(request)).toBe(false);
    }
    expect(manager.getForPane(pane)).toBeUndefined();
  });

  it("aborts every old ticket even when an abort observer finishes another and cleanup throws", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const cleanupError = new Error("Preview cleanup failed");
    const cleanup = jasmine.createSpy("preview cleanup").and.throwError(cleanupError);
    pane.onItemDidTerminatePendingState = () => new Disposable(cleanup);
    const first = activatePreview(manager, pane, "preview://first");
    const second = manager.begin({ uri: "permanent://second" });
    first.controller.signal.addEventListener("abort", () => manager.finish(second));
    let failure;
    try {
      manager.reset();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(cleanupError);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
    expect(manager.isCurrent(first)).toBe(false);
    expect(manager.isCurrent(second)).toBe(false);
    expect(manager.isCurrent(manager.begin({ uri: "preview://fresh" }))).toBe(true);
  });

  it("finishes preview, anchor, and destination subscriptions despite multiple cleanup failures", () => {
    const manager = new ItemOpenRequestManager();
    const anchor = makePane();
    const destination = makePane();
    const previewError = new Error("Preview cleanup failed");
    const anchorError = new Error("Anchor cleanup failed");
    const destinationError = new Error("Destination cleanup failed");
    const previewCleanup = jasmine.createSpy("preview cleanup").and.throwError(previewError);
    const anchorCleanup = jasmine.createSpy("anchor cleanup").and.throwError(anchorError);
    const destinationCleanup = jasmine
      .createSpy("destination cleanup")
      .and.throwError(destinationError);
    anchor.onWillDestroy = () => new Disposable(anchorCleanup);
    destination.onWillDestroy = () => new Disposable(destinationCleanup);
    destination.onItemDidTerminatePendingState = () => new Disposable(previewCleanup);
    const request = manager.begin({ uri: "preview://owned", pane: anchor });
    manager.prepare(request, destination, true);
    manager.activate(request);
    let failure;
    try {
      manager.finish(request);
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof AggregateError).toBe(true);
    expect(failure.errors).toEqual([previewError, anchorError, destinationError]);
    expect(previewCleanup).toHaveBeenCalledTimes(1);
    expect(anchorCleanup).toHaveBeenCalledTimes(1);
    expect(destinationCleanup).toHaveBeenCalledTimes(1);
    expect(manager.isCurrent(request)).toBe(false);
    expect(manager.getForPane(destination)).toBeUndefined();
    manager.finish(request);
    expect(destinationCleanup).toHaveBeenCalledTimes(1);
  });

  it("disposes an observer returned after its registration re-enters reset", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const cleanup = jasmine.createSpy("late observer cleanup");
    pane.onItemDidTerminatePendingState = () => {
      manager.reset();
      return new Disposable(cleanup);
    };
    const request = manager.begin({ uri: "preview://cancelled-during-registration" });
    manager.prepare(request, pane, true);
    manager.activate(request);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(request.controller.signal.aborted).toBe(true);
    expect(manager.isCurrent(request)).toBe(false);
    expect(manager.getForPane(pane)).toBeUndefined();
    manager.finish(request);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves a newer preview started while the previous request registers its observers", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const subscribe = pane.onItemDidTerminatePendingState;
    const cleanup = jasmine.createSpy("superseded observer cleanup");
    let firstRegistration = true;
    let current;
    pane.onItemDidTerminatePendingState = (callback) => {
      const subscription = subscribe(callback);
      if (!firstRegistration) return subscription;
      firstRegistration = false;
      current = activatePreview(manager, pane, "preview://current");
      return new Disposable(() => {
        cleanup();
        subscription.dispose();
      });
    };
    const previous = activatePreview(manager, pane, "preview://previous");

    expect(previous.controller.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(manager.getForPane(pane)).toBe(current);
    expect(manager.isCurrent(current)).toBe(true);
  });

  it("binds a split anchor's lifetime without superseding a preview or claiming its sequence", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const preview = activatePreview(manager, pane, "preview://existing");
    const split = manager.begin({ uri: "split://loading" });
    manager.bindPane(split, pane);

    expect(preview.controller.signal.aborted).toBe(false);
    expect(manager.getForPane(pane)).toBe(preview);
    expect(manager.isCurrent(split)).toBe(true);
    pane.destroy();
    expect(split.controller.signal.aborted).toBe(true);
  });

  it("distinguishes normal completion from cancellation after a later reset", () => {
    const manager = new ItemOpenRequestManager();
    const pane = makePane();
    const request = activatePreview(manager, pane, "preview://finished");
    manager.finish(request);

    expect(manager.isCurrent(request)).toBe(false);
    expect(manager.isCancelled(request)).toBe(false);
    manager.reset();
    expect(manager.isCancelled(request)).toBe(true);
  });

  it("returns an aborted request while opening is unavailable and permits a later fresh request", () => {
    let available = false;
    const manager = new ItemOpenRequestManager({ isAvailable: () => available });
    const pane = makePane();
    const blocked = manager.begin({ uri: "preview://blocked", pane });
    expect(blocked.controller.signal.aborted).toBe(true);
    expect(manager.isCurrent(blocked)).toBe(false);
    available = true;
    const current = activatePreview(manager, pane, "preview://current");
    expect(manager.isCurrent(current)).toBe(true);
    expect(manager.isCurrent(blocked)).toBe(false);
  });
});
