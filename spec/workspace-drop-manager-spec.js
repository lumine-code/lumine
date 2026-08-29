const path = require("path");
const { Disposable } = require("@lumine-code/event-kit");
const { MIME_PREFIX } = require("../src/workspace-drop-manager");
const WorkspaceDropManager = require("../src/workspace-drop-manager");

class TestDataTransfer {
  constructor() {
    this.data = new Map();
    this.files = [];
    this.items = [];
    this.dropEffect = "none";
    this.effectAllowed = "all";
    this.mode = "readwrite";
  }

  get types() {
    return [...this.data.keys()];
  }

  setData(type, value) {
    if (this.mode === "readwrite") this.data.set(type, value);
  }

  getData(type) {
    return this.mode === "protected" ? "" : this.data.get(type) || "";
  }

  clearData(type) {
    if (this.mode !== "readwrite") return;
    if (type == null) this.data.clear();
    else this.data.delete(type);
  }
}

function dragEvent(type, target, dataTransfer, { x = 50, y = 50, relatedTarget = null } = {}) {
  const event = new CustomEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: x },
    clientY: { value: y },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return event;
}

describe("WorkspaceDropManager", () => {
  let manager, pane, paneElement, itemViews, disposables;

  beforeEach(() => {
    manager = lumine.workspaceDrops;
    pane = lumine.workspace.getCenter().getActivePane();
    paneElement = pane.getElement();
    disposables = [];
    jasmine.attachToDOM(lumine.workspace.getElement());
    itemViews = paneElement.querySelector(":scope > .item-views");
    spyOn(itemViews, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      width: 120,
      height: 90,
    });
  });

  afterEach(() => {
    for (const disposable of disposables) disposable.dispose();
    manager.clearActiveClaim();
  });

  it("writes one versioned offer that remains inspectable in protected mode", () => {
    const dataTransfer = new TestDataTransfer();
    dataTransfer.setData("text/plain", "/tmp/example.txt");
    const { token } = manager.createSession({ exact: "item" });

    const descriptor = manager.write(dataTransfer, {
      kind: "pane-item",
      token,
      effect: "move",
      allowedLocations: ["center"],
      source: { windowId: 42, paneId: 7, onlyItem: true },
      items: [{ uri: "/tmp/example.txt" }],
    });
    dataTransfer.mode = "protected";

    const customTypes = dataTransfer.types.filter((type) => type.startsWith(MIME_PREFIX));
    expect(customTypes.length).toBe(1);
    expect(manager.inspect(dataTransfer)).toEqual(
      jasmine.objectContaining({
        kind: "pane-item",
        effect: "move",
        token,
        allowedLocations: ["center"],
        source: jasmine.objectContaining({ windowId: 42, paneId: 7, onlyItem: true }),
      }),
    );
    expect(manager.read(dataTransfer)).toBeNull();
    expect(dataTransfer.getData("text/plain")).toBe("");

    dataTransfer.mode = "readonly";
    expect(manager.read(dataTransfer)).toEqual(descriptor);
    expect(dataTransfer.getData("text/plain")).toBe("/tmp/example.txt");
    void manager.rollback(token, "spec-cleanup");
  });

  it("ignores a malformed encoded offer instead of throwing during dragover", () => {
    const dataTransfer = new TestDataTransfer();
    dataTransfer.setData(`${MIME_PREFIX};v=1;k=%E0%A4%A`, "{}");
    dataTransfer.mode = "protected";

    expect(() => manager.inspect(dataTransfer)).not.toThrow();
    expect(manager.inspect(dataTransfer)).toBeNull();
  });

  it("returns the source callback result to a committing window", async () => {
    const listeners = new Map();
    const services = new Map();
    const serviceFor = (id) => {
      const service = {
        getId: () => id,
        onDidReceive(eventName, callback) {
          listeners.set(`${id}:${eventName}`, callback);
          return new Disposable(() => listeners.delete(`${id}:${eventName}`));
        },
        async broadcast(eventName, message) {
          for (const [otherId] of services) {
            if (otherId === id) continue;
            await listeners.get(`${otherId}:${eventName}`)?.(message);
          }
        },
      };
      services.set(id, service);
      return service;
    };
    const workspace = { element: null };
    const source = new WorkspaceDropManager({
      workspace,
      applicationDelegate: {},
      windowService: serviceFor(1),
    });
    const target = new WorkspaceDropManager({
      workspace,
      applicationDelegate: {},
      windowService: serviceFor(2),
    });
    source.initialize();
    target.initialize();
    const commit = jasmine.createSpy("commit").and.returnValue(false);
    const { token } = source.createSession({ exact: "item" }, { commit });

    expect(await target.commit(token, { sourceWindowId: 1 })).toBe(false);
    expect(commit).toHaveBeenCalledWith({ sourceWindowId: 1 }, { exact: "item" });
    expect(source.getSession(token)).toBeUndefined();

    source.destroy();
    target.destroy();
  });

  it("commits a session against the exact object captured by its closure", async () => {
    const item = { id: "exact-item" };
    let committedItem;
    const { token } = manager.createSession(item, {
      commit: (_result, sessionItem) => (committedItem = sessionItem),
    });

    expect(manager.getSession(token)).toBe(item);
    expect(await manager.commit(token, { targetWindowId: 2 })).toBe(true);
    expect(committedItem).toBe(item);
    expect(manager.getSession(token)).toBeUndefined();
    expect(await manager.commit(token)).toBe(false);
  });

  it("continues destroying when a session rollback throws synchronously", () => {
    const isolatedManager = new WorkspaceDropManager({
      workspace: { element: null },
      applicationDelegate: {},
      windowService: {},
    });
    isolatedManager.createSession("item", {
      rollback: () => {
        throw new Error("synchronous rollback failure");
      },
    });

    expect(() => isolatedManager.destroy()).not.toThrow();
  });

  it("routes the complete event sequence and creates a split only during perform", async () => {
    pane.addItem(document.createElement("div"));
    const dataTransfer = new TestDataTransfer();
    manager.write(dataTransfer, {
      kind: "spec-item",
      effect: "move",
      allowedLocations: ["center"],
      source: { windowId: 999, paneId: 999 },
      items: [{ id: 1 }],
    });
    dataTransfer.mode = "protected";

    let perform;
    const performed = new Promise((resolve) => (perform = resolve));
    let createdPane;
    disposables.push(
      manager.addProvider(
        {
          propose: ({ offer }) => offer.kind === "spec-item" && { effect: "move" },
          prepareDrop: ({ descriptor }) => descriptor,
          perform: (context) => {
            createdPane = context.resolvePane();
            perform(context);
          },
        },
        { priority: 100 },
      ),
    );

    const enter = dragEvent("dragenter", itemViews, dataTransfer, { x: 110, y: 45 });
    const over = dragEvent("dragover", itemViews, dataTransfer, { x: 110, y: 45 });
    expect(enter.defaultPrevented).toBe(true);
    expect(over.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("move");
    expect(manager.overlay.classList.contains("visible")).toBe(true);
    expect(pane.getContainer().getPanes().length).toBe(1);

    const ambiguousLeave = dragEvent("dragleave", itemViews, dataTransfer);
    expect(ambiguousLeave.dataTransfer.dropEffect).toBe("move");
    dragEvent("dragenter", itemViews, dataTransfer, { x: 110, y: 45 });

    dataTransfer.mode = "readonly";
    const drop = dragEvent("drop", itemViews, dataTransfer, { x: 110, y: 45 });
    const context = await performed;
    expect(drop.defaultPrevented).toBe(true);
    expect(context.candidateSplit).toBe("right");
    expect(createdPane).not.toBe(pane);
    expect(pane.getContainer().getPanes().length).toBe(2);
  });

  it("treats a registered target as a boundary when its providers reject the drag", () => {
    const target = document.createElement("div");
    paneElement.appendChild(target);
    disposables.push(manager.addTarget(target, { surface: "tab-bar" }, { priority: 100 }));
    const dataTransfer = new TestDataTransfer();
    manager.write(dataTransfer, {
      kind: "unsupported",
      allowedLocations: ["center"],
      items: [],
    });
    dataTransfer.mode = "protected";

    const event = dragEvent("dragover", target, dataTransfer);

    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
    expect(manager.overlay.classList.contains("visible")).toBe(false);
  });

  it("classifies native files asynchronously, opens files in a split and folders here", async () => {
    pane.addItem(document.createElement("div"));
    const filePath = path.join(__dirname, "fixtures", "sample.js");
    const directoryPath = path.join(__dirname, "fixtures");
    const dataTransfer = new TestDataTransfer();
    dataTransfer.files = [{ path: filePath }, { path: directoryPath }];
    dataTransfer.items = [
      { kind: "file", getAsEntry: () => ({ isFile: true }) },
      { kind: "file", getAsEntry: () => ({ isDirectory: true }) },
    ];
    let openedDirectories;
    const directoriesOpened = new Promise((resolve) => (openedDirectories = resolve));
    spyOn(lumine.workspace, "open").and.callFake(async (_filePath, { pane: targetPane }) => {
      const item = document.createElement("div");
      targetPane.addItem(item);
      return item;
    });
    spyOn(lumine.applicationDelegate, "open").and.callFake((options) => {
      openedDirectories(options);
      return Promise.resolve();
    });

    dragEvent("dragover", itemViews, dataTransfer, { x: 110, y: 45 });
    expect(manager.overlay.style.left).toBe("60px");
    expect(pane.getContainer().getPanes().length).toBe(1);
    dragEvent("drop", itemViews, dataTransfer, { x: 110, y: 45 });
    const directoryOptions = await directoriesOpened;

    expect(directoryOptions).toEqual({ pathsToOpen: [directoryPath], here: true });
    const [openedPath, openOptions] = lumine.workspace.open.calls.mostRecent().args;
    expect(openedPath).toBe(filePath);
    expect(openOptions.activateItem).toBe(false);
    expect(openOptions.activatePane).toBe(false);
    expect(pane.getContainer().getPanes().length).toBe(2);
  });

  it("opens a native folder in the current window without proposing a split", async () => {
    pane.addItem(document.createElement("div"));
    const directoryPath = path.join(__dirname, "fixtures");
    const dataTransfer = new TestDataTransfer();
    dataTransfer.files = [{ path: directoryPath }];
    dataTransfer.items = [{ kind: "file", getAsEntry: () => ({ isDirectory: true }) }];
    let openedDirectories;
    const directoriesOpened = new Promise((resolve) => (openedDirectories = resolve));
    spyOn(lumine.applicationDelegate, "open").and.callFake((options) => {
      openedDirectories(options);
      return Promise.resolve();
    });

    dragEvent("dragover", itemViews, dataTransfer, { x: 110, y: 45 });
    expect(manager.overlay.style.left).toBe("0px");
    expect(manager.overlay.style.width).toBe("120px");
    dragEvent("drop", itemViews, dataTransfer, { x: 110, y: 45 });
    expect(await directoriesOpened).toEqual({ pathsToOpen: [directoryPath], here: true });

    expect(pane.getContainer().getPanes().length).toBe(1);
  });

  it("opens only file entries from a mixed tree-view descriptor", async () => {
    pane.addItem(document.createElement("div"));
    const filePath = path.join(__dirname, "fixtures", "sample.js");
    const directoryPath = path.join(__dirname, "fixtures");
    const dataTransfer = new TestDataTransfer();
    manager.write(dataTransfer, {
      kind: "tree-entries",
      effect: "copyMove",
      allowedLocations: ["center"],
      items: [
        { type: "file", path: filePath },
        { type: "directory", path: directoryPath },
      ],
    });
    dataTransfer.mode = "protected";
    spyOn(lumine.workspace, "open").and.callFake(async (_filePath, { pane: targetPane }) => {
      const item = document.createElement("div");
      targetPane.addItem(item);
      return item;
    });
    spyOn(lumine.applicationDelegate, "open");

    dragEvent("dragover", itemViews, dataTransfer, { x: 110, y: 45 });
    dataTransfer.mode = "readonly";
    dragEvent("drop", itemViews, dataTransfer, { x: 110, y: 45 });
    await conditionPromise(() => lumine.workspace.open.calls.count() === 1);

    expect(lumine.workspace.open.calls.argsFor(0)[0]).toBe(filePath);
    expect(lumine.applicationDelegate.open).not.toHaveBeenCalled();
  });

  it("rolls back a split when none of its dropped files can be opened", async () => {
    pane.addItem(document.createElement("div"));
    const filePath = path.join(__dirname, "fixtures", "sample.js");
    const dataTransfer = new TestDataTransfer();
    dataTransfer.files = [{ path: filePath }];
    dataTransfer.items = [{ kind: "file", getAsEntry: () => ({ isFile: true }) }];
    spyOn(lumine.workspace, "open").and.resolveTo(null);
    spyOn(console, "error");

    dragEvent("dragover", itemViews, dataTransfer, { x: 110, y: 45 });
    dragEvent("drop", itemViews, dataTransfer, { x: 110, y: 45 });
    await conditionPromise(() => lumine.workspace.open.calls.count() === 1);
    await conditionPromise(() => pane.getContainer().getPanes().length === 1);

    expect(pane.getContainer().getPanes().length).toBe(1);
  });

  it("clears the active target even when session rollback fails", async () => {
    const dataTransfer = new TestDataTransfer();
    manager.write(dataTransfer, {
      kind: "rollback-failure",
      token: "remote-token",
      source: { windowId: lumine.window.getId() + 1 },
      items: [],
    });
    dataTransfer.mode = "protected";
    disposables.push(
      manager.addProvider(
        {
          propose: ({ offer }) => offer.kind === "rollback-failure" && { effect: "move" },
          prepareDrop: () => {
            throw new Error("drop failed");
          },
        },
        { priority: 100 },
      ),
    );
    spyOn(manager, "rollback").and.rejectWith(new Error("rollback failed"));
    spyOn(console, "error");

    dragEvent("dragover", itemViews, dataTransfer);
    dataTransfer.mode = "readonly";
    dragEvent("drop", itemViews, dataTransfer);
    await conditionPromise(() => manager.activeClaim == null);

    expect(manager.overlay.classList.contains("visible")).toBe(false);
    expect(
      console.error.calls.allArgs().some(([error]) => error.message === "rollback failed"),
    ).toBe(true);
  });

  it("rebinds its capture lifecycle when the workspace element is reset", async () => {
    const previousElement = manager.element;

    await lumine.reset();

    const nextElement = lumine.workspace.getElement();
    jasmine.attachToDOM(nextElement);
    expect(manager.element).toBe(nextElement);
    expect(manager.element).not.toBe(previousElement);
    const nextPane = lumine.workspace.getCenter().getActivePane();
    const nextItemViews = nextPane.getElement().querySelector(":scope > .item-views");
    const dataTransfer = new TestDataTransfer();
    manager.write(dataTransfer, { kind: "after-reset", items: [] });
    dataTransfer.mode = "protected";
    disposables.push(
      manager.addProvider(
        { propose: ({ offer }) => offer.kind === "after-reset" && { effect: "copy" } },
        { priority: 100 },
      ),
    );

    const event = dragEvent("dragover", nextItemViews, dataTransfer);

    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("copy");
  });
});
