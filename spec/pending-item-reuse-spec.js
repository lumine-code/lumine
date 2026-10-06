const { Emitter } = require("@lumine-code/event-kit");
const Environment = require("../src/environment");
const { flushMicrotasks } = require("./helpers/async-spec-helpers");

describe("Pending pane item reuse", () => {
  let workspace, pane, opener, registration, requests, created, originalPersistence;

  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  function makeItem(uri) {
    const emitter = new Emitter();
    return {
      uri,
      element: document.createElement("div"),
      getURI() {
        return this.uri;
      },
      getTitle() {
        return this.uri;
      },
      getAllowedLocations: () => ["center", "right"],
      onDidChangeURI: (callback) => emitter.on("did-change-uri", callback),
      onDidDestroy: (callback) => emitter.on("did-destroy", callback),
      setURI(uri) {
        this.uri = uri;
        emitter.emit("did-change-uri");
      },
      destroy() {
        this.destroyed = true;
        emitter.emit("did-destroy");
        emitter.dispose();
      },
      isDestroyed() {
        return !!this.destroyed;
      },
    };
  }

  function registerPreviewOpener() {
    registration = workspace.addOpener(opener, {
      canReusePendingItem: (item, uri) => created.includes(item) && uri.startsWith("preview://"),
      reusePendingItem: async (item, uri, options, { signal }) => {
        const gate = deferred();
        requests.push({ item, uri, options, signal, gate });
        await gate.promise;
        if (signal.aborted) return false;
        item.setURI(uri);
      },
    });
  }

  function resetWorkspace() {
    registration.dispose();
    workspace.reset(lumine.packages);
    workspace.initialize({ configDirPath: lumine.getConfigDirPath() });
    workspace.enablePersistence = false;
    pane = workspace.getCenter().getActivePane();
    registerPreviewOpener();
  }

  beforeEach(() => {
    workspace = lumine.workspace;
    originalPersistence = workspace.enablePersistence;
    workspace.enablePersistence = false;
    pane = workspace.getCenter().getActivePane();
    lumine.config.set("core.allowPendingPaneItems", true);
    requests = [];
    created = [];
    opener = jasmine.createSpy("preview opener").and.callFake((uri) => {
      if (!uri.startsWith("preview://")) return;
      const item = makeItem(uri);
      created.push(item);
      return item;
    });
    registerPreviewOpener();
  });

  afterEach(() => {
    registration.dispose();
    workspace.enablePersistence = originalPersistence;
  });

  async function startReuse(uri, options = {}) {
    const opened = workspace.open(uri, { pending: true, ...options });
    // open() may read the persisted location before reaching the opener.
    while (!requests.some((request) => request.uri === uri)) await Promise.resolve();
    return { opened, request: requests.findLast((request) => request.uri === uri) };
  }

  it("retains the preview identity, tab position, open events and closed URI history", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const permanentItem = makeItem("other://permanent");
    pane.addItem(permanentItem, { moved: true });
    pane.activateItem(permanentItem);
    const originalIndex = pane.getItems().indexOf(item);
    const opened = jasmine.createSpy("opened");
    const uriChanged = jasmine.createSpy("uri changed");
    const subscription = workspace.onDidOpen(opened);
    const uriSubscription = workspace.onDidChangePaneItemURI(uriChanged);
    const hook = spyOn(lumine.packages.hooks, "trigger").and.callThrough();

    const next = await startReuse("preview://b");
    next.request.gate.resolve();
    expect(await next.opened).toBe(item);

    expect(opener.calls.count()).toBe(1);
    expect(pane.getItems().indexOf(item)).toBe(originalIndex);
    expect(pane.getPendingItem()).toBe(item);
    expect(pane.getActiveItem()).toBe(item);
    expect(item.isDestroyed()).toBe(false);
    expect(opened).toHaveBeenCalledWith({ uri: "preview://b", pane, item, index: originalIndex });
    expect(uriChanged).toHaveBeenCalledWith({
      item,
      pane,
      oldURI: "preview://a",
      newURI: "preview://b",
    });
    expect(hook).toHaveBeenCalledWith("preview://b:uri-opened");
    expect(workspace.destroyedItemURIs).toContain("preview://a");
    expect(workspace.destroyedItemURIs).not.toContain("preview://b");
    expect(workspace.incoming.size).toBe(0);
    subscription.dispose();
    uriSubscription.dispose();
  });

  it("lets the newest preview win when earlier loads finish later", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const opened = jasmine.createSpy("opened");
    const subscription = workspace.onDidOpen(opened);
    const b = await startReuse("preview://b");
    const c = await startReuse("preview://c");
    expect(b.request.signal.aborted).toBe(true);
    c.request.gate.resolve();
    expect(await c.opened).toBe(item);
    b.request.gate.resolve();
    expect(await b.opened).toBeUndefined();
    expect(item.getURI()).toBe("preview://c");
    expect(opened.calls.count()).toBe(1);
    expect(workspace.destroyedItemURIs).toContain("preview://a");
    expect(workspace.destroyedItemURIs).not.toContain("preview://b");
    subscription.dispose();
  });

  it("preserves replaced URI history when a URI observer immediately opens the next document", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    let chainedOpen;
    const subscription = workspace.onDidChangePaneItemURI(({ newURI }) => {
      if (newURI === "preview://b") {
        chainedOpen = workspace.open("preview://c", { pending: true, pane });
      }
    });
    const next = await startReuse("preview://b");
    next.request.gate.resolve();
    expect(await next.opened).toBeUndefined();
    requests.find((request) => request.uri === "preview://c").gate.resolve();
    expect(await chainedOpen).toBe(item);
    expect(item.getURI()).toBe("preview://c");
    expect(workspace.destroyedItemURIs).toContain("preview://a");
    expect(workspace.destroyedItemURIs).toContain("preview://b");
    expect(workspace.destroyedItemURIs).not.toContain("preview://c");
    subscription.dispose();
  });

  it("settles duplicate URI requests after cancelling the earlier reuse", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const first = await startReuse("preview://b");
    const second = workspace.open("preview://b", { pending: true });
    expect(first.request.signal.aborted).toBe(true);
    first.request.gate.resolve();
    expect(await first.opened).toBeUndefined();
    while (requests.length < 2) await Promise.resolve();
    requests[1].gate.resolve();
    expect(await second).toBe(item);
    expect(item.getURI()).toBe("preview://b");
    expect(workspace.incoming.size).toBe(0);
  });

  it("cancels the swap when the preview is promoted", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const next = await startReuse("preview://b");
    expect(await workspace.open("preview://a")).toBe(item);
    expect(next.request.signal.aborted).toBe(true);
    next.request.gate.resolve();
    expect(await next.opened).toBeUndefined();
    expect(item.getURI()).toBe("preview://a");
    expect(pane.getPendingItem()).toBeNull();
  });

  it("cancels when the pending item is cleared directly", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const next = await startReuse("preview://b");
    pane.clearPendingItem();
    next.request.gate.resolve();
    expect(await next.opened).toBeUndefined();
    expect(item.getURI()).toBe("preview://a");
  });

  it("cancels when the item leaves its pane", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const next = await startReuse("preview://b");
    const destination = pane.splitRight();
    pane.moveItemToPane(item, destination);
    next.request.gate.resolve();
    expect(await next.opened).toBeUndefined();
    expect(destination.getItems()).toContain(item);
    expect(item.getURI()).toBe("preview://a");
  });

  it("cancels when the item is closed", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const next = await startReuse("preview://b");
    await pane.destroyItem(item);
    next.request.gate.resolve();
    expect(await next.opened).toBeUndefined();
    expect(item.isDestroyed()).toBe(true);
    expect(workspace.getPaneItems()).not.toContain(item);
  });

  it("cancels before asynchronous close observers finish", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const next = await startReuse("preview://b");
    const closingGate = deferred();
    const subscription = pane.onWillDestroyItem(() => closingGate.promise);
    const closing = pane.destroyItem(item);
    expect(next.request.signal.aborted).toBe(true);
    next.request.gate.resolve();
    expect(await next.opened).toBeUndefined();
    expect(item.getURI()).toBe("preview://a");
    closingGate.resolve();
    await closing;
    subscription.dispose();
  });

  it("allows reuse to decline and uses the ordinary constructor", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    workspace.openerReuseCapabilities.get(opener).reusePendingItem = async () => false;
    const next = await workspace.open("preview://b", { pending: true });
    expect(next).not.toBe(item);
    expect(next.getURI()).toBe("preview://b");
    expect(item.isDestroyed()).toBe(true);
    expect(opener.calls.count()).toBe(2);
  });

  it("preserves the old document and pending state when replacement fails", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    workspace.openerReuseCapabilities.get(opener).reusePendingItem = async () => {
      throw new Error("invalid document");
    };
    let failure;
    try {
      await workspace.open("preview://b", { pending: true });
    } catch (error) {
      failure = error;
    }
    expect(failure.message).toBe("invalid document");
    expect(pane.getPendingItem()).toBe(item);
    expect(item.getURI()).toBe("preview://a");
    expect(item.isDestroyed()).toBe(false);
    expect(workspace.destroyedItemURIs).not.toContain("preview://a");
    expect(workspace.incoming.size).toBe(0);
  });

  it("settles package-owned cancellation without constructing or opening another item", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const opened = jasmine.createSpy("opened");
    const subscription = workspace.onDidOpen(opened);
    workspace.openerReuseCapabilities.get(opener).reusePendingItem = async (
      _item,
      _uri,
      _options,
      { signal },
    ) => {
      expect(signal.aborted).toBe(false);
      const error = new Error("Explicit navigation superseded the preview");
      error.name = "AbortError";
      throw error;
    };

    expect(await workspace.open("preview://b", { pending: true })).toBeUndefined();
    expect(opener.calls.count()).toBe(1);
    expect(opened).not.toHaveBeenCalled();
    expect(pane.getPendingItem()).toBe(item);
    expect(item.getURI()).toBe("preview://a");
    expect(item.isDestroyed()).toBe(false);
    expect(workspace.destroyedItemURIs).not.toContain("preview://a");
    expect(workspace.incoming.size).toBe(0);
    workspace.openerReuseCapabilities.get(opener).reusePendingItem = async (pendingItem, uri) => {
      pendingItem.setURI(uri);
    };
    expect(await workspace.open("preview://c", { pending: true })).toBe(item);
    expect(item.getURI()).toBe("preview://c");
    expect(opener.calls.count()).toBe(1);
    expect(opened.calls.count()).toBe(1);
    subscription.dispose();
  });

  it("honors earlier openers before offering reuse to a later opener", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const earlierItem = makeItem("preview://b");
    const earlier = (uri) => (uri === "preview://b" ? earlierItem : undefined);
    workspace.openers.unshift(earlier);
    expect(await workspace.open("preview://b", { pending: true })).toBe(earlierItem);
    expect(requests.length).toBe(0);
    expect(item.isDestroyed()).toBe(true);
    workspace.openers.splice(workspace.openers.indexOf(earlier), 1);
  });

  it("activates an existing URI before considering reuse", async () => {
    const existingPane = pane.splitRight();
    const existing = await workspace.open("preview://b", { pane: existingPane });
    const item = await workspace.open("preview://a", { pane, pending: true });
    expect(await workspace.open("preview://b", { pending: true, searchAllPanes: true })).toBe(
      existing,
    );
    expect(requests.length).toBe(0);
    expect(item.getURI()).toBe("preview://a");
  });

  it("does not reuse when splitting, adding in the background, or opening permanently", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const split = await workspace.open("preview://b", { pending: true, pane, split: "right" });
    expect(split).not.toBe(item);
    expect(item.isDestroyed()).toBe(false);
    const background = await workspace.open("preview://c", {
      pending: true,
      pane,
      activateItem: false,
    });
    expect(background).not.toBe(item);
    const permanent = await workspace.open("preview://d", { pane });
    expect(permanent).not.toBe(background);
    expect(requests.length).toBe(0);
  });

  it("does not reuse a modified document", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    item.isModified = () => true;
    expect(await workspace.open("preview://b", { pending: true })).not.toBe(item);
    expect(requests.length).toBe(0);
  });

  for (const state of ["modified", "conflicted", "removed"]) {
    it(`does not reuse a document with ${state} file state`, async () => {
      const item = await workspace.open("preview://a", { pending: true });
      item.getFileState = () => state;
      // This fixture has no save operation; closing it can therefore proceed.
      expect(await workspace.open("preview://b", { pending: true })).not.toBe(item);
      expect(requests.length).toBe(0);
    });
  }

  it("keeps location lookup order from cancelling a newer request or an unrelated pane", async () => {
    const destination = workspace.getRightDock().getActivePane();
    const dockItem = await workspace.open("preview://dock", { pane: destination, pending: true });
    const centerItem = await workspace.open("preview://center", { pane, pending: true });
    workspace.enablePersistence = true;
    const locationGate = deferred();
    spyOn(workspace.itemLocationStore, "load").and.callFake((uri) =>
      uri === "preview://b" ? locationGate.promise : Promise.resolve("right"),
    );
    const b = workspace.open("preview://b", { pending: true });
    const c = await startReuse("preview://c");
    locationGate.resolve("right");
    expect(await b).toBeUndefined();
    expect(c.request.signal.aborted).toBe(false);
    c.request.gate.resolve();
    expect(await c.opened).toBe(dockItem);
    expect(centerItem.getURI()).toBe("preview://center");
    expect(centerItem.isDestroyed()).toBe(false);
    expect(requests.length).toBe(1);
  });

  for (const asynchronous of [false, true]) {
    it(`does not cancel a center preview when an ${asynchronous ? "asynchronous" : "ordinary"} opener defaults to a dock`, async () => {
      const item = await workspace.open("preview://a", { pending: true });
      const next = await startReuse("preview://b");
      const dockItem = makeItem("dock://content");
      dockItem.getDefaultLocation = () => "right";
      const openerGate = deferred();
      const dockOpener = workspace.addOpener((uri) =>
        uri === "dock://content" ? (asynchronous ? openerGate.promise : dockItem) : undefined,
      );
      const dockOpening = workspace.open("dock://content", { pending: true });
      if (asynchronous) {
        expect(next.request.signal.aborted).toBe(false);
        openerGate.resolve(dockItem);
      }
      expect(await dockOpening).toBe(dockItem);
      expect(workspace.paneForItem(dockItem).getContainer().getLocation()).toBe("right");
      expect(next.request.signal.aborted).toBe(false);
      next.request.gate.resolve();
      expect(await next.opened).toBe(item);
      expect(item.getURI()).toBe("preview://b");
      dockOpener.dispose();
    });
  }

  it("cancels preview reuse when the text editor fallback takes its place", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const next = await startReuse("preview://b");
    const textEditor = await workspace.open("sample.js", { pending: true, pane });
    expect(next.request.signal.aborted).toBe(true);
    next.request.gate.resolve();
    expect(await next.opened).toBeUndefined();
    expect(item.isDestroyed()).toBe(true);
    expect(pane.getPendingItem()).toBe(textEditor);
  });

  it("does not destroy a caller-provided item when a newer request supersedes its presentation", async () => {
    const existing = await workspace.open("preview://a", { pane });
    const provided = makeItem("supplied://content");
    const earlier = workspace.open(provided, { pending: true, pane });
    expect(await workspace.open(existing, { pane })).toBe(existing);
    expect(await earlier).toBeUndefined();
    expect(provided.isDestroyed()).toBe(false);
    expect(pane.getItems()).not.toContain(provided);
  });

  it("disposes a limit-refused item once and preserves a throwing destroy without isDestroyed", async () => {
    const uri = "opening://refused-limit";
    const item = makeItem(uri);
    delete item.isDestroyed;
    const cleanupError = Object.freeze(new Error("Refused item cleanup failed"));
    const destroy = spyOn(item, "destroy").and.throwError(cleanupError);
    const custom = workspace.addOpener((requested) => (requested === uri ? item : undefined));
    spyOn(workspace, "textEditorLimitReached").and.returnValue(true);
    spyOn(workspace, "reportTextEditorLimit");
    const opened = jasmine.createSpy("opened");
    const subscription = workspace.onDidOpen(opened);

    const failure = await workspace.open(uri, { pending: false, pane }).catch((error) => error);

    expect(failure).toBe(cleanupError);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(workspace.getPaneItems()).not.toContain(item);
    expect(opened).not.toHaveBeenCalled();
    subscription.dispose();
    custom.dispose();
  });

  it("preserves an open observer's synchronous error when that observer also resets the workspace", async () => {
    const uri = "preview://observer-reset";
    const observerError = Object.freeze(new Error("Open observer failed after reset"));
    const hook = spyOn(lumine.packages.hooks, "trigger").and.callThrough();
    const subscription = workspace.onDidOpen((event) => {
      if (event.uri !== uri) return;
      subscription.dispose();
      resetWorkspace();
      throw observerError;
    });

    const failure = await workspace.open(uri, { pending: false, pane }).catch((error) => error);

    expect(failure).toBe(observerError);
    expect(workspace.getPaneItems()).toEqual([]);
    expect(created[0].isDestroyed()).toBe(true);
    expect(hook.calls.allArgs().map(([name]) => name)).not.toContain(`${uri}:uri-opened`);
  });

  it("preserves a supplied URI provider's synchronous error after it resets the workspace", async () => {
    const provided = makeItem("supplied://uri-provider-reset");
    const providerError = Object.freeze(new Error("URI provider failed after reset"));
    spyOn(provided, "getURI").and.callFake(() => {
      resetWorkspace();
      throw providerError;
    });

    const failure = await workspace
      .open(provided, { pending: false, pane })
      .catch((error) => error);

    expect(failure).toBe(providerError);
    expect(provided.isDestroyed()).toBe(false);
    expect(workspace.getPaneItems()).toEqual([]);
    provided.destroy();
  });

  it("quietly cancels an ordinary opener's deferred rejection after workspace reset", async () => {
    const uri = "opening://late-rejection";
    const entered = deferred();
    const result = deferred();
    const custom = workspace.addOpener((requested) => {
      if (requested !== uri) return;
      entered.resolve();
      return result.promise;
    });
    const opening = workspace.open(uri, { pending: false, pane });
    await entered.promise;
    resetWorkspace();
    const opened = jasmine.createSpy("opened");
    const subscription = workspace.onDidOpen(opened);
    result.reject(Object.freeze(new Error("Obsolete asynchronous opener failed")));

    expect(await opening).toBeUndefined();
    expect(workspace.getPaneItems()).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    expect(workspace.destroyedItemURIs).not.toContain(uri);
    subscription.dispose();
    custom.dispose();
  });

  for (const split of [false, true]) {
    it(`disposes a late ${split ? "split" : "permanent"} opener result after workspace reset without presenting it`, async () => {
      const uri = "opening://late-reset";
      const item = makeItem(uri);
      const destroy = spyOn(item, "destroy").and.callThrough();
      const entered = deferred();
      const result = deferred();
      const custom = workspace.addOpener((requested) => {
        if (requested !== uri) return;
        entered.resolve();
        return result.promise;
      });
      const opening = workspace.open(uri, {
        pane,
        pending: split,
        ...(split ? { split: "right" } : {}),
      });
      await entered.promise;
      resetWorkspace();
      const opened = jasmine.createSpy("opened");
      const subscription = workspace.onDidOpen(opened);
      const hook = spyOn(lumine.packages.hooks, "trigger").and.callThrough();
      const panes = workspace.getCenter().getPanes().slice();
      result.resolve(item);

      expect(await opening).toBeUndefined();
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(workspace.getPaneItems()).not.toContain(item);
      expect(workspace.getCenter().getPanes()).toEqual(panes);
      expect(opened).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      expect(workspace.destroyedItemURIs).not.toContain(uri);
      subscription.dispose();
      custom.dispose();
    });
  }

  it("does not destroy a provided item when reset cancels its deferred presentation", async () => {
    const provided = makeItem("supplied://reset");
    const opening = workspace.open(provided, { pane, pending: false });
    resetWorkspace();

    expect(await opening).toBeUndefined();
    expect(provided.isDestroyed()).toBe(false);
    expect(workspace.getPaneItems()).not.toContain(provided);
    provided.destroy();
  });

  it("preserves a late owned result already adopted by the new generation", async () => {
    const uri = "opening://adopted";
    const item = makeItem(uri);
    const destroy = spyOn(item, "destroy").and.callThrough();
    const entered = deferred();
    const result = deferred();
    const custom = workspace.addOpener((requested) => {
      if (requested !== uri) return;
      entered.resolve();
      return result.promise;
    });
    const previous = workspace.open(uri, { pending: false, pane });
    await entered.promise;
    resetWorkspace();
    expect(await workspace.open(item, { pending: false, pane })).toBe(item);
    result.resolve(item);

    expect(await previous).toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
    expect(workspace.paneForItem(item)).toBe(pane);
    expect(pane.getActiveItem()).toBe(item);
    custom.dispose();
  });

  it("cancels an ordinary opener when its explicit destination pane is destroyed", async () => {
    const destination = pane.splitRight();
    const uri = "opening://closed-pane";
    const item = makeItem(uri);
    const entered = deferred();
    const result = deferred();
    const custom = workspace.addOpener((requested) => {
      if (requested !== uri) return;
      entered.resolve();
      return result.promise;
    });
    const opened = jasmine.createSpy("opened");
    const subscription = workspace.onDidOpen(opened);
    const opening = workspace.open(uri, { pending: false, pane: destination });
    await entered.promise;
    destination.destroy();
    result.resolve(item);

    expect(await opening).toBeUndefined();
    expect(item.isDestroyed()).toBe(true);
    expect(workspace.getPaneItems()).not.toContain(item);
    expect(opened).not.toHaveBeenCalled();
    expect(workspace.destroyedItemURIs).not.toContain(uri);
    subscription.dispose();
    custom.dispose();
  });

  it("does not start an opener after reset while the persisted location lookup is pending", async () => {
    workspace.enablePersistence = true;
    const location = deferred();
    spyOn(workspace.itemLocationStore, "load").and.returnValue(location.promise);
    const opening = workspace.open("preview://located", { pending: true });
    expect(workspace.itemLocationStore.load).toHaveBeenCalled();
    resetWorkspace();
    const opened = jasmine.createSpy("opened");
    const subscription = workspace.onDidOpen(opened);
    location.resolve("right");

    expect(await opening).toBeUndefined();
    expect(opener).not.toHaveBeenCalled();
    expect(workspace.getPaneItems()).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    expect(workspace.destroyedItemURIs).not.toContain("preview://located");
    subscription.dispose();
  });

  it("opens the same URI in a new generation without waiting for or being detached by the old one", async () => {
    const uri = "opening://same-uri";
    const entered = deferred();
    const oldResult = deferred();
    const currentResult = deferred();
    const oldItem = makeItem(uri);
    const currentItem = makeItem(uri);
    const customOpener = jasmine.createSpy("same URI opener").and.callFake((requested) => {
      if (requested !== uri) return;
      entered.resolve();
      return customOpener.calls.count() === 1 ? oldResult.promise : currentResult.promise;
    });
    let custom = workspace.addOpener(customOpener);
    const previous = workspace.open(uri, { pending: false, pane });
    await entered.promise;
    resetWorkspace();
    custom.dispose();
    custom = workspace.addOpener(customOpener);
    const current = workspace.open(uri, { pending: false, pane });
    await flushMicrotasks();
    expect(customOpener.calls.count()).toBe(2);
    oldResult.resolve(oldItem);
    expect(await previous).toBeUndefined();
    expect(oldItem.isDestroyed()).toBe(true);
    const duplicate = workspace.open(uri, { pending: false, pane });
    await flushMicrotasks();
    expect(customOpener.calls.count()).toBe(2);
    currentResult.resolve(currentItem);

    expect(await current).toBe(currentItem);
    expect(await duplicate).toBe(currentItem);
    expect(currentItem.isDestroyed()).toBe(false);
    expect(pane.getItems()).toEqual([currentItem]);
    custom.dispose();
  });

  it("serializes duplicate URI retries after their first opener rejects", async () => {
    const uri = "opening://retry";
    const entered = deferred();
    const failedResult = deferred();
    const retryResult = deferred();
    const failure = new Error("First opener failed");
    const replacement = makeItem(uri);
    const customOpener = jasmine.createSpy("retry opener").and.callFake((requested) => {
      if (requested !== uri) return;
      entered.resolve();
      return customOpener.calls.count() === 1 ? failedResult.promise : retryResult.promise;
    });
    const custom = workspace.addOpener(customOpener);
    const failed = workspace.open(uri, { pending: false, pane }).catch((error) => error);
    await entered.promise;
    const firstWaiter = workspace.open(uri, { pending: false, pane });
    const secondWaiter = workspace.open(uri, { pending: false, pane });
    failedResult.reject(failure);
    expect(await failed).toBe(failure);
    await flushMicrotasks();
    expect(customOpener.calls.count()).toBe(2);
    retryResult.resolve(replacement);

    expect(await firstWaiter).toBe(replacement);
    expect(await secondWaiter).toBe(replacement);
    expect(customOpener.calls.count()).toBe(2);
    expect(pane.getItems()).toEqual([replacement]);
    custom.dispose();
  });

  it("disposes an ordinary opener's late result after its environment is destroyed", async () => {
    const environment = new Environment({ applicationDelegate: lumine.applicationDelegate });
    const localWorkspace = environment.workspace;
    localWorkspace.enablePersistence = false;
    const uri = "opening://destroyed-environment";
    const item = makeItem(uri);
    const entered = deferred();
    const result = deferred();
    const emit = spyOn(localWorkspace.emitter, "emit").and.callThrough();
    const hook = spyOn(environment.packages.hooks, "trigger").and.callThrough();
    localWorkspace.addOpener((requested) => {
      if (requested !== uri) return;
      entered.resolve();
      return result.promise;
    });
    try {
      const opening = localWorkspace.open(uri, { pending: false });
      await entered.promise;
      environment.destroy();
      result.resolve(item);

      expect(await opening).toBeUndefined();
      expect(item.isDestroyed()).toBe(true);
      expect(emit).not.toHaveBeenCalledWith("did-open", jasmine.anything());
      expect(hook).not.toHaveBeenCalled();
      expect(localWorkspace.destroyedItemURIs).not.toContain(uri);
    } finally {
      environment.destroy();
    }
  });

  it("uses the explicit destination and updates persisted URI location", async () => {
    const destination = workspace.getRightDock().getActivePane();
    const item = await workspace.open("preview://a", { pane: destination, pending: true });
    workspace.enablePersistence = true;
    const save = spyOn(workspace.itemLocationStore, "save");
    const next = await startReuse("preview://b", { pane: destination, activatePane: false });
    next.request.gate.resolve();
    expect(await next.opened).toBe(item);
    expect(destination.getItems()).toContain(item);
    expect(save).toHaveBeenCalledWith("preview://b", "right");
  });

  it("publishes item navigation and follows subscriptions across pane moves", async () => {
    const item = await workspace.open("preview://a", { pending: true });
    const uriChanged = jasmine.createSpy("uri changed");
    const subscription = workspace.onDidChangePaneItemURI(uriChanged);
    item.setURI("preview://b");
    expect(uriChanged).toHaveBeenCalledWith({
      item,
      pane,
      oldURI: "preview://a",
      newURI: "preview://b",
    });
    const destination = pane.splitRight();
    pane.moveItemToPane(item, destination);
    item.setURI("preview://c");
    expect(uriChanged.calls.count()).toBe(2);
    expect(uriChanged.calls.mostRecent().args[0]).toEqual({
      item,
      pane: destination,
      oldURI: "preview://b",
      newURI: "preview://c",
    });
    subscription.dispose();
  });
});
