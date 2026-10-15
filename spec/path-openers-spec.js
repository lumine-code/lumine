const path = require("path");
const { pathToFileURL } = require("url");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const TextEditor = require("../src/text-editor");

describe("Path openers", () => {
  const filePath = path.join(__dirname, "fixtures", "sample.js");
  const destinations = ["current", "new-window", "detached-window"];
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
    const lease = workspace.addPathOpener(descriptor);
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

  describe("preparing path opener descriptors", () => {
    it("discovers descriptors on the first query after local URI and kind normalization", () => {
      let descriptor;
      const prepare = jasmine.createSpy("prepare openers").and.callFake(({ uri, options }) => {
        expect(uri).toBe(filePath);
        expect(options).toEqual(
          jasmine.objectContaining({ pathKind: "file", uriFragment: "#page=2" }),
        );
        descriptor ??= register().descriptor;
      });
      registrations.add(workspace.onWillResolvePathOpeners(prepare));
      expect(prepare).not.toHaveBeenCalled();
      const uri = `${pathToFileURL(filePath).href}#page=2`;
      expect(workspace.getAvailablePathOpeners(uri)[0].id).toBe("test-viewer");
      expect(workspace.getAvailablePathOpeners(uri)[0].id).toBe("test-viewer");
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(descriptor.open).not.toHaveBeenCalled();
    });

    it("prepares an explicit opener ID before its first opening", async () => {
      let descriptor;
      registrations.add(
        workspace.onWillResolvePathOpeners(({ uri, options }) => {
          expect(uri).toBe(filePath);
          expect(options.opener).toBe("late-viewer");
          descriptor ??= register({ id: "late-viewer" }).descriptor;
        }),
      );
      const item = await workspace.open(`${pathToFileURL(filePath).href}#part`, {
        opener: "late-viewer",
      });
      expect(item.type).toBe("viewer");
      expect(descriptor.open).toHaveBeenCalledTimes(1);
      const [openedURI, openedOptions] = descriptor.open.calls.mostRecent().args;
      expect(openedURI).toBe(filePath);
      expect(openedOptions.opener).toBe("late-viewer");
      expect(openedOptions.uriFragment).toBe("#part");
    });

    it("retains destination restrictions for descriptors discovered during explicit lookup", () => {
      let descriptor;
      registrations.add(
        workspace.onWillResolvePathOpeners(({ options }) => {
          expect(options.destination).toBe("detached-window");
          expect(options.pathKind).toBe("file");
          descriptor ??= register({ id: "local-action", destinations: ["current"] }).descriptor;
        }),
      );
      expect(() =>
        workspace.resolvePathOpener(pathToFileURL(filePath).href, {
          opener: "local-action",
          destination: "detached-window",
        }),
      ).toThrowError(/does not support.*detached-window/);
      expect(descriptor.open).not.toHaveBeenCalled();
    });

    it("provides directory kind before discovering a directory-specific opener", () => {
      const directory = path.dirname(filePath);
      registrations.add(
        workspace.onWillResolvePathOpeners(({ uri, options }) => {
          expect(uri).toBe(directory);
          expect(options.pathKind).toBe("directory");
          register({ id: "late-directory", pathKinds: ["directory"], canOpen: () => true });
        }),
      );
      expect(workspace.getAvailablePathOpeners(directory)[0].id).toBe("late-directory");
    });

    it("removes callbacks independently of the descriptors they registered", () => {
      let descriptor;
      const prepare = jasmine.createSpy("prepare").and.callFake(() => {
        descriptor ??= register().descriptor;
      });
      const discovery = workspace.onWillResolvePathOpeners(prepare);
      registrations.add(discovery);
      workspace.getAvailablePathOpeners(filePath);
      discovery.dispose();
      expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("test-viewer");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(descriptor.open).not.toHaveBeenCalled();
    });

    it("retires discovery subscriptions on reset without letting old disposers retire new ones", () => {
      const prepare = jasmine.createSpy("prepare");
      const previous = workspace.onWillResolvePathOpeners(prepare);
      registrations.add(previous);
      workspace.reset(lumine.packages);
      workspace.getAvailablePathOpeners(filePath);
      expect(prepare).not.toHaveBeenCalled();
      registrations.add(workspace.onWillResolvePathOpeners(prepare));
      previous.dispose();
      workspace.getAvailablePathOpeners(filePath);
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("skips a running callback during reentrant resolution and can retire a pending callback", () => {
      const skipped = jasmine.createSpy("retired listener");
      let second;
      const first = jasmine.createSpy("reentrant prepare").and.callFake(() => {
        second.dispose();
        expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("text-editor");
        expect(workspace.resolvePathOpener(filePath).id).toBe("text-editor");
      });
      registrations.add(workspace.onWillResolvePathOpeners(first));
      second = workspace.onWillResolvePathOpeners(skipped);
      registrations.add(second);
      workspace.getAvailablePathOpeners(filePath);
      expect(first).toHaveBeenCalledTimes(1);
      expect(skipped).not.toHaveBeenCalled();
    });

    it("releases its reentrancy guard after a discovery error so the next query can retry", () => {
      const failure = new Error("discovery failed");
      let calls = 0;
      registrations.add(
        workspace.onWillResolvePathOpeners(() => {
          if (++calls === 1) throw failure;
          register();
        }),
      );
      expect(() => workspace.getAvailablePathOpeners(filePath)).toThrow(failure);
      expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("test-viewer");
      expect(calls).toBe(2);
    });

    it("rejects Promise-returning callbacks and allows disposal after rejection", () => {
      expect(() => workspace.onWillResolvePathOpeners(null)).toThrowError(/function/);
      const discovery = workspace.onWillResolvePathOpeners(() => Promise.resolve());
      registrations.add(discovery);
      expect(() => workspace.getAvailablePathOpeners(filePath)).toThrowError(/synchronously/);
      discovery.dispose();
      expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("text-editor");
    });

    it("does not discover for internal or remote URIs or an invalid path kind", () => {
      const prepare = jasmine.createSpy("prepare local paths");
      registrations.add(workspace.onWillResolvePathOpeners(prepare));
      for (const uri of [
        "lumine://settings",
        `markdown-preview://${filePath}`,
        "https://example.test/file.js",
        "ssh://example.test/file.js",
      ]) {
        expect(workspace.getAvailablePathOpeners(uri)).toEqual([]);
        expect(workspace.resolvePathOpener(uri)).toBeNull();
        expect(() => workspace.resolvePathOpener(uri, { opener: "missing" })).toThrowError(
          /not available/,
        );
      }
      expect(() =>
        workspace.getAvailablePathOpeners(filePath, { pathKind: "unknown" }),
      ).toThrowError(/path kind/);
      expect(prepare).not.toHaveBeenCalled();
    });
  });

  it("discovers the default and Text Editor without opening either", () => {
    const { descriptor } = register();
    expect(workspace.getAvailablePathOpeners(filePath)).toEqual([
      { id: "test-viewer", label: "Test Viewer", isDefault: true, destinations },
      { id: "text-editor", label: "Text Editor", isDefault: false, destinations },
    ]);
    expect(descriptor.open).not.toHaveBeenCalled();
    expect(pane.getItems()).toEqual([]);
  });

  it("keeps manual choices available and computes the default from current preferences", async () => {
    let automatic = false;
    register({ isDefaultEligible: () => automatic });
    expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("text-editor");
    expect(workspace.getAvailablePathOpeners(filePath)[1].id).toBe("test-viewer");
    const text = await workspace.open(filePath);
    expect(text instanceof TextEditor).toBe(true);
    automatic = true;
    expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("test-viewer");
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
    expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("second-viewer");
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
    expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("test-viewer");
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
    expect(workspace.getAvailablePathOpeners(filePath)).toEqual([
      { id: "text-editor", label: "Text Editor", isDefault: true, destinations },
    ]);
  });

  it("opens the fallback text type after a viewer loses availability", async () => {
    let supported = true;
    register({ canOpen: (uri) => supported && uri === filePath });
    const viewer = await workspace.open(filePath);
    supported = false;
    expect(workspace.getAvailablePathOpeners(filePath)[0].id).toBe("text-editor");
    const text = await workspace.open(filePath);
    expect(text instanceof TextEditor).toBe(true);
    expect(pane.getItems()).toEqual([viewer, text]);
  });

  it("normalizes local file URLs for discovery, opening and reuse", async () => {
    const { descriptor } = register();
    const url = `${pathToFileURL(filePath).href}#page=3`;
    expect(workspace.getAvailablePathOpeners(url)).toEqual(
      workspace.getAvailablePathOpeners(filePath),
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
    const { descriptor } = register({
      destinations: ["current"],
      open: jasmine.createSpy("external").and.resolveTo(""),
    });
    expect(await workspace.open(filePath)).toBeUndefined();
    expect(descriptor.open).toHaveBeenCalledTimes(1);
    expect(pane.getItems()).toEqual([]);
  });

  it("lists directory openers with Project Folder and never offers Text Editor", async () => {
    const directory = path.dirname(filePath);
    const filePredicate = jasmine.createSpy("file applicability").and.returnValue(true);
    register({ canOpen: filePredicate });
    const external = register({
      id: "external",
      label: "Open Externally",
      pathKinds: ["file", "directory"],
      destinations: ["current"],
      canOpen: () => true,
      isDefaultEligible: (_uri, options) => options.pathKind !== "directory",
      open: jasmine.createSpy("external").and.returnValue(""),
    });
    expect(workspace.getAvailablePathOpeners(directory)).toEqual([
      {
        id: "project-folder",
        label: "Project Folder",
        isDefault: true,
        destinations: ["current", "new-window"],
      },
      { id: "external", label: "Open Externally", isDefault: false, destinations: ["current"] },
    ]);
    expect(filePredicate).not.toHaveBeenCalled();
    const setState = spyOn(lumine.project, "setState").and.resolveTo(true);
    expect(await workspace.open(directory)).toBeUndefined();
    expect(setState).toHaveBeenCalledOnceWith([directory]);
    expect(external.descriptor.open).not.toHaveBeenCalled();
    expect(pane.getItems()).toEqual([]);
    await expectAsync(workspace.open(directory, { opener: "text-editor" })).toBeRejected();
    await expectAsync(
      workspace.open(directory, { opener: "project-folder", destination: "detached-window" }),
    ).toBeRejected();
  });

  it("resolves the selected viewer before requesting a new independent window", async () => {
    register({ isDefaultEligible: () => false });
    const projectRoots = [__dirname, path.dirname(filePath)];
    spyOn(lumine.project, "getPaths").and.returnValue(projectRoots);
    const openWindow = spyOn(lumine.applicationDelegate, "open");
    const { devMode, safeMode } = lumine.applicationDelegate.getWindowLoadSettings();
    await workspace.openPathInNewWindow(filePath, { opener: "test-viewer" });
    expect(openWindow).toHaveBeenCalledOnceWith({
      pathsToOpen: [...projectRoots, filePath],
      opener: "test-viewer",
      openerPath: filePath,
      newWindow: true,
      reuseEmptyWindow: false,
      devMode,
      safeMode,
    });
    expect(pane.getItems()).toEqual([]);
  });

  it("requests the default project opener for a folder in an independent window", async () => {
    const directory = path.dirname(filePath);
    const openWindow = spyOn(lumine.applicationDelegate, "open");
    const setState = spyOn(lumine.project, "setState");
    const { devMode, safeMode } = lumine.applicationDelegate.getWindowLoadSettings();
    await workspace.openPathInNewWindow(directory);
    expect(openWindow).toHaveBeenCalledOnceWith({
      pathsToOpen: [directory],
      opener: "project-folder",
      openerPath: directory,
      newWindow: true,
      reuseEmptyWindow: false,
      devMode,
      safeMode,
    });
    expect(setState).not.toHaveBeenCalled();
    expect(pane.getItems()).toEqual([]);
  });

  it("carries a target file's cursor position into an independent window", async () => {
    const openWindow = spyOn(lumine.applicationDelegate, "open");
    await workspace.openPathInNewWindow(filePath, {
      opener: "text-editor",
      initialLine: 12,
      initialColumn: 3,
      uriFragment: "#nameddest=GROUP",
    });

    expect(openWindow.calls.mostRecent().args[0]).toEqual(
      jasmine.objectContaining({
        openerPath: filePath,
        initialLine: 12,
        initialColumn: 3,
        uriFragment: "#nameddest=GROUP",
      }),
    );
  });

  it("does not request a window for an already cancelled opening", async () => {
    const { descriptor } = register();
    const openWindow = spyOn(lumine.applicationDelegate, "open");
    const controller = new AbortController();
    controller.abort();
    expect(
      await workspace.openPathInNewWindow(filePath, {
        opener: "test-viewer",
        signal: controller.signal,
      }),
    ).toBeUndefined();
    expect(openWindow).not.toHaveBeenCalled();
    expect(descriptor.open).not.toHaveBeenCalled();
  });

  it("keeps side-effect actions as defaults while refusing window destinations", async () => {
    const { descriptor } = register({
      destinations: ["current"],
      open: jasmine.createSpy("external").and.returnValue(""),
    });
    const openWindow = spyOn(lumine.applicationDelegate, "open");
    expect(workspace.getAvailablePathOpeners(filePath)[0]).toEqual({
      id: "test-viewer",
      label: "Test Viewer",
      isDefault: true,
      destinations: ["current"],
    });
    await expectAsync(workspace.openPathInNewWindow(filePath)).toBeRejectedWithError(
      /does not support.*new-window/,
    );
    await expectAsync(
      workspace.open(filePath, { opener: "test-viewer", destination: "detached-window" }),
    ).toBeRejectedWithError(/does not support.*detached-window/);
    expect(openWindow).not.toHaveBeenCalled();
    expect(descriptor.open).not.toHaveBeenCalled();
    expect(pane.getItems()).toEqual([]);
    expect(await workspace.open(filePath)).toBeUndefined();
    expect(descriptor.open).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed kinds and destination declarations", () => {
    expect(() => register({ pathKinds: ["folder"] })).toThrowError(/pathKinds/);
    expect(() => register({ destinations: [] })).toThrowError(/destinations/);
    expect(() => register({ destinations: ["new-window"] })).toThrowError(/current/);
    expect(() => register({ id: "project-folder" })).toThrowError(/already registered/);
    expect(() => workspace.getAvailablePathOpeners(filePath, { pathKind: "unknown" })).toThrowError(
      /path kind/,
    );
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
    expect(() => workspace.getAvailablePathOpeners(filePath)).toThrowError(/synchronously/);
  });

  it("does not advertise path openers for internal workspace URIs", () => {
    register();
    expect(workspace.getAvailablePathOpeners("lumine://settings")).toEqual([]);
    expect(workspace.getAvailablePathOpeners(`markdown-preview://${filePath}`)).toEqual([]);
  });
});
