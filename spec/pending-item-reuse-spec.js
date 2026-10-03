const { Emitter } = require("@lumine-code/event-kit");

describe("Pending pane item reuse", () => {
  let workspace, pane, opener, registration, requests, created, originalPersistence;

  const deferred = () => {
    let resolve;
    const promise = new Promise((callback) => (resolve = callback));
    return { promise, resolve };
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
    expect(workspace.pendingItemOpenRequests.size).toBe(0);
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
