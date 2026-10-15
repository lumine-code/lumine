describe("Asynchronous document opening across windows", () => {
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  it("keeps the original document window when focus changes during an opener", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    const originalPane = workspace.getMainWindow().getEditorContainer().getActivePane();
    const extra = await workspace.openEditorWindow({ show: false });
    originalPane.activate();
    let complete;
    let started;
    const openingStarted = new Promise((resolve) => {
      started = resolve;
    });
    const lease = workspace.addOpener((uri) => {
      if (uri !== "scan4://delayed-document") return;
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Delayed document",
      getURI: () => "scan4://delayed-document",
    };
    try {
      const opening = workspace.open("scan4://delayed-document");
      await openingStarted;
      extra.getEditorContainer().getActivePane().activate();
      complete(item);
      await opening;
      expect(workspace.paneForItem(item)).toBe(originalPane);
      expect(extra.getEditorContainer().getPaneItems()).toEqual([]);
    } finally {
      lease.dispose();
    }
  });

  async function deferredOpening(options, during, itemOptions = {}) {
    const workspace = lumine.workspace;
    let complete;
    const lease = workspace.addOpener((uri) => {
      if (uri === "scan4://deferred") return new Promise((resolve) => (complete = resolve));
    });
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Deferred item",
      ...itemOptions,
    };
    try {
      const opening = workspace.open("scan4://deferred", options);
      await conditionPromise(() => Boolean(complete));
      await during();
      complete(item);
      return { item, result: await opening };
    } finally {
      lease.dispose();
    }
  }

  it("keeps a split next to its original pane while an opener is pending", async () => {
    const workspace = lumine.workspace;
    const main = workspace.getMainWindow().getEditorContainer();
    const originalPane = main.getActivePane();
    const extra = await workspace.openEditorWindow({ show: false });
    originalPane.activate();
    const { item } = await deferredOpening({ split: "right" }, () =>
      extra.getEditorContainer().getActivePane().activate(),
    );
    expect(workspace.paneForItem(item).getContainer()).toBe(main);
    expect(main.getPanes()).toHaveSize(2);
    expect(extra.getEditorContainer().getPaneItems()).toEqual([]);
  });

  it("cancels and disposes the late result when its original window closes", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    extra.getEditorContainer().getActivePane().activate();
    const destroy = jasmine.createSpy("dispose late item");
    const { item, result } = await deferredOpening({}, () => workspace.closeEditorWindow(extra), {
      destroy,
    });
    expect(result).toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(workspace.paneForItem(item)).toBeUndefined();
  });

  it("retains the target while waiting for persisted location preferences", async () => {
    const workspace = lumine.workspace;
    const originalPane = workspace.getCenter().getActivePane();
    const extra = await workspace.openEditorWindow({ show: false });
    originalPane.activate();
    let complete;
    const previous = workspace.enablePersistence;
    workspace.enablePersistence = true;
    spyOn(workspace.itemLocationStore, "load").and.callFake(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const item = { element: document.createElement("div"), getTitle: () => "Preferences" };
    const lease = workspace.addOpener((uri) => {
      if (uri === "scan4://preferences") return item;
    });
    try {
      const opening = workspace.open("scan4://preferences");
      await conditionPromise(() => Boolean(complete));
      extra.getEditorContainer().getActivePane().activate();
      complete(undefined);
      await opening;
      expect(workspace.paneForItem(item)).toBe(originalPane);
    } finally {
      workspace.enablePersistence = previous;
      lease.dispose();
    }
  });

  it("honors an opener's dock location after the provisional center pane closes", async () => {
    const workspace = lumine.workspace;
    const originalPane = workspace.getCenter().getActivePane();
    originalPane.splitRight();
    originalPane.activate();
    const { item, result } = await deferredOpening({}, () => originalPane.destroy(), {
      getDefaultLocation: () => "right",
      getAllowedLocations: () => ["right"],
    });
    expect(result).toBe(item);
    expect(workspace.paneForItem(item)).toBe(workspace.getRightDock().getActivePane());
  });
});
