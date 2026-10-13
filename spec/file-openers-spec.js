const path = require("path");
const { pathToFileURL } = require("url");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const TextEditor = require("../src/text-editor");

describe("File openers", () => {
  const filePath = path.join(__dirname, "fixtures", "sample.js");
  let workspace, pane, registrations, persistence;

  function makeItem(uri, type = "viewer", protocolURI = false) {
    const emitter = new Emitter();
    return {
      uri,
      type,
      element: document.createElement("div"),
      getURI() {
        return protocolURI ? `viewer://${this.uri}` : this.uri;
      },
      getPath() {
        return this.uri;
      },
      getTitle: () => type,
      getDefaultLocation: () => "center",
      getAllowedLocations: () => ["center", "right"],
      onDidChangeURI: (callback) => emitter.on("did-change-uri", callback),
      onDidDestroy: (callback) => emitter.on("did-destroy", callback),
      setURI(uri) {
        this.uri = uri;
        emitter.emit("did-change-uri");
      },
      isDestroyed() {
        return Boolean(this.destroyed);
      },
      destroy() {
        this.destroyed = true;
        emitter.emit("did-destroy");
        emitter.dispose();
      },
    };
  }

  function register(overrides = {}) {
    const descriptor = {
      id: "test-viewer",
      label: "Test Viewer",
      canOpen: (uri) => uri === filePath,
      open: jasmine.createSpy("open viewer").and.callFake((uri) => makeItem(uri)),
      handlesItem: (item) => item.type === "viewer",
      ...overrides,
    };
    const lease = workspace.addFileOpener(descriptor);
    registrations.add(lease);
    return { descriptor, lease };
  }

  beforeEach(() => {
    workspace = lumine.workspace;
    pane = workspace.getCenter().getActivePane();
    persistence = workspace.enablePersistence;
    workspace.enablePersistence = false;
    registrations = new CompositeDisposable();
    lumine.config.set("core.allowPendingPaneItems", true);
  });

  afterEach(() => {
    registrations.dispose();
    workspace.enablePersistence = persistence;
  });

  it("discovers the default and Text Editor without opening either", () => {
    const { descriptor } = register();
    expect(workspace.getAvailableFileOpeners(filePath)).toEqual([
      { id: "test-viewer", label: "Test Viewer", isDefault: true },
      { id: "text-editor", label: "Text Editor", isDefault: false },
    ]);
    expect(descriptor.open).not.toHaveBeenCalled();
    expect(pane.getItems()).toEqual([]);
  });

  it("keeps manual choices available and computes the default from current preferences", async () => {
    let automatic = false;
    register({ isDefaultEligible: () => automatic });
    expect(workspace.getAvailableFileOpeners(filePath)[0].id).toBe("text-editor");
    expect(workspace.getAvailableFileOpeners(filePath)[1].id).toBe("test-viewer");
    const text = await workspace.open(filePath);
    expect(text instanceof TextEditor).toBe(true);
    automatic = true;
    expect(workspace.getAvailableFileOpeners(filePath)[0].id).toBe("test-viewer");
    const viewer = await workspace.open(filePath);
    expect(viewer.type).toBe("viewer");
    expect(viewer).not.toBe(text);
  });

  it("uses the first eligible opener for both discovery and ordinary opening", async () => {
    const first = register({ isDefaultEligible: () => false });
    const second = register({
      id: "second-viewer",
      label: "Second Viewer",
      open: jasmine.createSpy("second viewer").and.callFake((uri) => makeItem(uri, "second")),
      handlesItem: (item) => item.type === "second",
    });
    expect(workspace.getAvailableFileOpeners(filePath)[0].id).toBe("second-viewer");
    const item = await workspace.open(filePath);
    expect(item.type).toBe("second");
    expect(first.descriptor.open).not.toHaveBeenCalled();
    expect(second.descriptor.open).toHaveBeenCalledTimes(1);
  });

  it("explicitly chooses a manual opener instead of an existing text editor", async () => {
    register({ isDefaultEligible: () => false });
    const text = await workspace.open(filePath);
    const viewer = await workspace.open(filePath, { opener: "test-viewer" });
    expect(viewer.type).toBe("viewer");
    expect(pane.getItems()).toEqual([text, viewer]);
    expect(await workspace.open(filePath, { opener: "test-viewer" })).toBe(viewer);
    expect(await workspace.open(filePath, { opener: "text-editor" })).toBe(text);
  });

  it("opens Text Editor alongside a default viewer without changing the default", async () => {
    const { descriptor } = register();
    const viewer = await workspace.open(filePath);
    const text = await workspace.open(filePath, { opener: "text-editor" });
    expect(text instanceof TextEditor).toBe(true);
    expect(pane.getItems()).toEqual([viewer, text]);
    expect(await workspace.open(filePath)).toBe(viewer);
    expect(descriptor.open).toHaveBeenCalledTimes(1);
    expect(workspace.getAvailableFileOpeners(filePath)[0].id).toBe("test-viewer");
  });

  it("finds a restored matching viewer by its file path despite a different URI", async () => {
    const { descriptor } = register();
    const restored = makeItem(filePath, "viewer", true);
    const dock = workspace.getRightDock().getActivePane();
    dock.addItem(restored);
    expect(await workspace.open(filePath, { opener: "test-viewer", searchAllPanes: true })).toBe(
      restored,
    );
    expect(descriptor.open).not.toHaveBeenCalled();
  });

  it("honors searchAllPanes before a picker's captured destination pane", async () => {
    register();
    const viewer = await workspace.open(filePath);
    const destination = pane.splitRight();
    expect(
      await workspace.open(filePath, {
        opener: "test-viewer",
        pane: destination,
        searchAllPanes: true,
      }),
    ).toBe(viewer);
    expect(destination.getItems()).toEqual([]);
    const text = await workspace.open(filePath, {
      opener: "text-editor",
      pane: destination,
      searchAllPanes: true,
    });
    expect(text instanceof TextEditor).toBe(true);
    expect(destination.getItems()).toContain(text);
  });

  it("opens concurrent choices as distinct types for the same file", async () => {
    const { descriptor } = register();
    const [viewer, text] = await Promise.all([
      workspace.open(filePath, { opener: "test-viewer" }),
      workspace.open(filePath, { opener: "text-editor" }),
    ]);
    expect(viewer.type).toBe("viewer");
    expect(text instanceof TextEditor).toBe(true);
    expect(pane.getItems()).toContain(viewer);
    expect(pane.getItems()).toContain(text);
    expect(descriptor.open).toHaveBeenCalledTimes(1);
  });

  it("refuses unavailable and retired explicit choices without falling back", async () => {
    const { lease, descriptor } = register();
    await expectAsync(
      workspace.open(`${filePath}.other`, { opener: "test-viewer" }),
    ).toBeRejected();
    lease.dispose();
    await expectAsync(workspace.open(filePath, { opener: "test-viewer" })).toBeRejected();
    expect(descriptor.open).not.toHaveBeenCalled();
    expect(pane.getItems()).toEqual([]);
    expect(workspace.getAvailableFileOpeners(filePath)).toEqual([
      { id: "text-editor", label: "Text Editor", isDefault: true },
    ]);
  });

  it("opens the fallback text type after a viewer loses availability", async () => {
    let supported = true;
    register({ canOpen: (uri) => supported && uri === filePath });
    const viewer = await workspace.open(filePath);
    supported = false;
    expect(workspace.getAvailableFileOpeners(filePath)[0].id).toBe("text-editor");
    const text = await workspace.open(filePath);
    expect(text instanceof TextEditor).toBe(true);
    expect(pane.getItems()).toEqual([viewer, text]);
  });

  it("normalizes local file URLs for discovery, opening and reuse", async () => {
    const { descriptor } = register();
    const url = `${pathToFileURL(filePath).href}#page=3`;
    expect(workspace.getAvailableFileOpeners(url)).toEqual(
      workspace.getAvailableFileOpeners(filePath),
    );
    const viewer = await workspace.open(url);
    expect(descriptor.open.calls.mostRecent().args[0]).toBe(filePath);
    expect(descriptor.open.calls.mostRecent().args[1].uriFragment).toBe("#page=3");
    expect(await workspace.open(filePath)).toBe(viewer);
    const text = await workspace.open(url, { opener: "text-editor" });
    expect(text instanceof TextEditor).toBe(true);
    expect(text.getPath()).toBe(filePath);
    expect(await workspace.open(filePath, { opener: "text-editor" })).toBe(text);
  });

  it("does not silently fall back when the selected opener cancels", async () => {
    register({ open: () => Promise.resolve(undefined) });
    expect(await workspace.open(filePath)).toBeUndefined();
    expect(pane.getItems()).toEqual([]);
  });

  it("allows side-effect openers to handle a file without creating a pane item", async () => {
    const { descriptor } = register({ open: jasmine.createSpy("external").and.resolveTo("") });
    expect(await workspace.open(filePath)).toBeUndefined();
    expect(descriptor.open).toHaveBeenCalledTimes(1);
    expect(pane.getItems()).toEqual([]);
  });

  it("retains the core pending-item reuse lifecycle for a chosen opener", async () => {
    register({
      canOpen: (uri) => uri.startsWith(filePath),
      canReusePendingItem: (item) => item.type === "viewer",
      reusePendingItem: async (item, uri, _options, { signal }) => {
        expect(signal.aborted).toBe(false);
        item.setURI(uri);
      },
    });
    const first = await workspace.open(filePath, { opener: "test-viewer", pending: true });
    const next = await workspace.open(`${filePath}.next`, { opener: "test-viewer", pending: true });
    expect(next).toBe(first);
    expect(next.getURI()).toBe(`${filePath}.next`);
    expect(pane.getItems()).toEqual([first]);
  });

  it("disposes an unpresented result when its opener retires during loading", async () => {
    let finish, entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const result = new Promise((resolve) => {
      finish = resolve;
    });
    const { lease } = register({
      open: () => {
        entered();
        return result;
      },
    });
    const opening = workspace.open(filePath);
    await started;
    lease.dispose();
    const item = makeItem(filePath);
    finish(item);
    expect(await opening).toBeUndefined();
    expect(item.isDestroyed()).toBe(true);
    expect(pane.getItems()).toEqual([]);
  });

  it("cancels a picker-owned opening and disposes its late viewer", async () => {
    let finish, entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const result = new Promise((resolve) => {
      finish = resolve;
    });
    register({
      open: () => {
        entered();
        return result;
      },
    });
    const controller = new AbortController();
    const opening = workspace.open(filePath, { opener: "test-viewer", signal: controller.signal });
    await started;
    controller.abort();
    const item = makeItem(filePath);
    finish(item);
    expect(await opening).toBeUndefined();
    expect(item.isDestroyed()).toBe(true);
    expect(pane.getItems()).toEqual([]);
  });

  it("rejects duplicate IDs and asynchronous applicability predicates", () => {
    register();
    expect(() => register()).toThrowError(/already registered/);
    register({ id: "async-viewer", canOpen: () => Promise.resolve(true) });
    expect(() => workspace.getAvailableFileOpeners(filePath)).toThrowError(/synchronously/);
  });

  it("does not advertise file openers for internal workspace URIs", () => {
    register();
    expect(workspace.getAvailableFileOpeners("lumine://settings")).toEqual([]);
    expect(workspace.getAvailableFileOpeners(`markdown-preview://${filePath}`)).toEqual([]);
  });
});
