const Environment = require("../src/environment");
const { copyableElement } = require("./helpers/pane-item-fixtures");

describe("default dock items", () => {
  let environment, workspace, items, nextId;

  beforeEach(() => {
    jasmine.useRealClock();
    environment = new Environment({ applicationDelegate: lumine.applicationDelegate });
    environment.configDirPath = lumine.getConfigDirPath();
    workspace = environment.workspace;
    workspace.initialize({ configDirPath: environment.configDirPath });
    items = new Map();
    nextId = 1;
    environment.deserializers.add({
      name: "DefaultDockItemSpec",
      deserialize: (state) => buildItem(state),
    });
  });

  afterEach(() => {
    workspace.endInitialDockRestore();
    environment.destroy();
    for (const item of items.values()) {
      if (!item.isDestroyed()) item.destroy();
    }
  });

  function buildItem({
    uri = `lumine://default-dock-item-spec/${nextId++}`,
    title = "Default dock item",
    visibility = "project-or-empty",
    location = "left",
  } = {}) {
    let destroyed = false;
    const item = {
      canCopy: () => false,
      element: document.createElement("div"),
      getURI: () => uri,
      getTitle: () => title,
      getDefaultLocation: () => location,
      getAllowedLocations: () => ["left", "right", "bottom"],
      getDefaultVisibility: () => visibility,
      isDestroyed: () => destroyed,
      destroy: jasmine.createSpy(`${title} destroy`).and.callFake(() => (destroyed = true)),
      serialize: () => ({
        deserializer: "DefaultDockItemSpec",
        uri,
        title,
        visibility,
        location,
      }),
    };
    items.set(uri, item);
    return item;
  }

  function registerItem(item = buildItem()) {
    const getItem = jasmine.createSpy("get default dock item").and.returnValue(item);
    const registration = workspace.addDefaultDockItem(getItem);
    return { item, getItem, registration };
  }

  async function openDefaults(context = {}) {
    await workspace.openDefaultDockItems({
      hasProject: false,
      hasOpenFiles: false,
      hasPaneItemTransfer: false,
      ...context,
    });
    workspace.endInitialDockRestore();
  }

  function restoreInitialState(state) {
    workspace.beginInitialDockRestore(state);
    workspace.deserialize(structuredClone(state), environment.deserializers, {
      locations: Object.keys(state.paneContainers),
    });
  }

  it("registers the item factory without constructing or opening its view", async () => {
    const getItem = jasmine.createSpy("construct default item").and.callFake(() => buildItem());
    workspace.addDefaultDockItem(getItem);

    expect(getItem).not.toHaveBeenCalled();
    expect(workspace.getPaneItems()).toEqual([]);

    await openDefaults();

    expect(getItem).toHaveBeenCalledTimes(1);
    expect(workspace.getLeftDock().getPaneItems()).toEqual([getItem.calls.first().returnValue]);
    expect(workspace.getLeftDock().isVisible()).toBe(true);
  });

  for (const hasOpenFiles of [false, true]) {
    it(`shows project-or-empty for a new project ${hasOpenFiles ? "with an initial file" : "without initial files"}`, async () => {
      const { item } = registerItem();

      await openDefaults({ hasProject: true, hasOpenFiles });

      expect(workspace.getLeftDock().getActivePaneItem()).toBe(item);
      expect(workspace.getLeftDock().isVisible()).toBe(true);
    });
  }

  it("shows project-or-empty for an empty start", async () => {
    const { item } = registerItem();

    await openDefaults();

    expect(workspace.getLeftDock().getActivePaneItem()).toBe(item);
    expect(workspace.getLeftDock().isVisible()).toBe(true);
  });

  for (const context of [{ hasOpenFiles: true }, { hasPaneItemTransfer: true }]) {
    it(`does not treat a pending ${context.hasOpenFiles ? "file" : "pane item transfer"} as an empty start`, async () => {
      const { item } = registerItem();

      await openDefaults(context);

      expect(workspace.paneForItem(item)).toBeUndefined();
      expect(workspace.getLeftDock().isVisible()).toBe(false);
    });
  }

  it("keeps an empty launch's default visible when a package opens a welcome item", async () => {
    const center = workspace.getCenter().getActivePane();
    const document = copyableElement();
    center.addItem(document);
    const { item } = registerItem();

    await openDefaults();

    expect(center.getItems()).toEqual([document]);
    expect(workspace.getLeftDock().getActivePaneItem()).toBe(item);
    expect(workspace.getLeftDock().isVisible()).toBe(true);
  });

  for (const visibility of ["missing", undefined, false, "manual"]) {
    it(`keeps ${String(visibility)} visibility on demand`, async () => {
      const item = buildItem();
      if (visibility === "missing") delete item.getDefaultVisibility;
      else item.getDefaultVisibility = () => visibility;
      registerItem(item);

      await openDefaults({ hasProject: true });

      expect(workspace.paneForItem(item)).toBeUndefined();
      expect(workspace.getLeftDock().isVisible()).toBe(false);
      await workspace.open(item);
      expect(workspace.getLeftDock().getActivePaneItem()).toBe(item);
      expect(workspace.getLeftDock().isVisible()).toBe(true);
    });
  }

  it("shows visible defaults when opening standalone files", async () => {
    const { item } = registerItem(buildItem({ visibility: "visible", location: "right" }));

    await openDefaults({ hasOpenFiles: true });

    expect(workspace.getRightDock().getActivePaneItem()).toBe(item);
    expect(workspace.getRightDock().isVisible()).toBe(true);
    expect(workspace.getLeftDock().isVisible()).toBe(false);
  });

  it("preserves center focus while showing a default dock", async () => {
    jasmine.attachToDOM(workspace.getElement());
    const center = workspace.getCenter().getActivePane();
    center.activate();
    center.getElement().focus();
    const focusedElement = document.activeElement;
    expect(focusedElement).toBe(center.getElement());
    registerItem();

    await openDefaults({ hasProject: true, hasOpenFiles: true });

    expect(workspace.getLeftDock().isVisible()).toBe(true);
    expect(workspace.getActivePane()).toBe(center);
    expect(document.activeElement).toBe(focusedElement);
  });

  it("respects a saved layout in which the default item was closed", async () => {
    const state = workspace.serialize();
    const { item, getItem } = registerItem();
    restoreInitialState(state);

    await openDefaults({ hasProject: true });

    expect(getItem).not.toHaveBeenCalled();
    expect(workspace.paneForItem(item)).toBeUndefined();
    expect(workspace.getLeftDock().getPaneItems()).toEqual([]);
    expect(workspace.getLeftDock().isVisible()).toBe(false);
  });

  it("respects a saved empty dock even when other dock state is absent", async () => {
    const state = { paneContainers: { left: workspace.getLeftDock().serialize() } };
    const { item } = registerItem(buildItem({ visibility: "visible" }));
    restoreInitialState(state);

    await openDefaults({ hasProject: true });

    expect(workspace.paneForItem(item)).toBeUndefined();
    expect(workspace.getLeftDock().getPaneItems()).toEqual([]);
    expect(workspace.getLeftDock().isVisible()).toBe(false);
  });

  for (const visible of [false, true]) {
    it(`preserves a saved ${visible ? "visible" : "hidden"} item, its side, tab order and another active item`, async () => {
      const dock = workspace.getRightDock();
      const pane = dock.getActivePane();
      const first = buildItem({ title: "First" });
      const candidate = buildItem({ title: "Project tree" });
      const active = buildItem({ title: "Active item" });
      pane.addItems([first, candidate, active]);
      pane.activateItem(active);
      dock.setState({ visible, size: 231 });
      const state = { paneContainers: { right: dock.serialize() } };
      restoreInitialState(state);
      const restoredCandidate = items.get(candidate.getURI());
      registerItem(restoredCandidate);
      const expectedOrder = dock.getPaneItems().slice();
      const expectedActive = dock.getActivePaneItem();

      await openDefaults({ hasProject: true });

      expect(dock.getPaneItems()).toEqual(expectedOrder);
      expect(dock.getPaneItems().map((item) => item.getTitle())).toEqual([
        "First",
        "Project tree",
        "Active item",
      ]);
      expect(dock.getActivePaneItem()).toBe(expectedActive);
      expect(dock.getActivePaneItem().getTitle()).toBe("Active item");
      expect(dock.isVisible()).toBe(visible);
      expect(dock.state.size).toBe(231);
      expect(workspace.paneContainerForItem(restoredCandidate)).toBe(dock);
      expect(workspace.getLeftDock().getPaneItems()).toEqual([]);
    });
  }

  it("leaves an explicitly opened dock and its active item alone", async () => {
    const candidate = buildItem();
    const explicit = buildItem({ title: "Explicitly opened" });
    registerItem(candidate);
    await workspace.open(explicit);
    const dock = workspace.getLeftDock();
    dock.hide();

    await openDefaults({ hasProject: true });

    expect(dock.getPaneItems()).toEqual([explicit]);
    expect(dock.getActivePaneItem()).toBe(explicit);
    expect(dock.isVisible()).toBe(false);
    expect(workspace.paneForItem(candidate)).toBeUndefined();
  });

  it("evaluates the startup context once and ignores later registrations", async () => {
    const first = registerItem();
    await openDefaults({ hasOpenFiles: true });
    const late = registerItem();

    await openDefaults({ hasProject: true });

    expect(first.getItem).toHaveBeenCalledTimes(1);
    expect(late.getItem).not.toHaveBeenCalled();
    expect(workspace.getPaneItems()).toEqual([]);
    expect(workspace.getLeftDock().isVisible()).toBe(false);
  });

  it("does not reopen a default dock after the user hides it", async () => {
    const { item, getItem } = registerItem();
    await openDefaults({ hasProject: true });
    workspace.getLeftDock().hide();

    await openDefaults({ hasProject: true });

    expect(getItem).toHaveBeenCalledTimes(1);
    expect(workspace.getLeftDock().getActivePaneItem()).toBe(item);
    expect(workspace.getLeftDock().isVisible()).toBe(false);
  });

  it("does not evaluate a disposed registration", async () => {
    const { registration, getItem, item } = registerItem();
    registration.dispose();

    await openDefaults({ hasProject: true });

    expect(getItem).not.toHaveBeenCalled();
    expect(workspace.paneForItem(item)).toBeUndefined();
    expect(workspace.getLeftDock().isVisible()).toBe(false);
  });

  it("cancels a pending default opening when its registration is disposed", async () => {
    const { registration, item } = registerItem();
    const open = workspace.open.bind(workspace);
    let release, entered, signal;
    const gate = new Promise((resolve) => (release = resolve));
    const started = new Promise((resolve) => (entered = resolve));
    spyOn(workspace, "open").and.callFake(async (openingItem, options) => {
      signal = options.signal;
      entered();
      await gate;
      return open(openingItem, options);
    });
    const opening = openDefaults({ hasProject: true });
    try {
      await started;
      registration.dispose();
      expect(signal.aborted).toBe(true);
    } finally {
      release();
      await opening;
    }

    expect(workspace.paneForItem(item)).toBeUndefined();
    expect(workspace.getLeftDock().isVisible()).toBe(false);
  });

  for (const visible of [false, true]) {
    it(`preserves an explicit item opened into a ${visible ? "visible" : "subsequently hidden"} dock while a default is pending`, async () => {
      const { item } = registerItem();
      const explicit = buildItem({ title: "Explicitly opened while starting" });
      const dock = workspace.getLeftDock();
      const open = workspace.open.bind(workspace);
      let release, entered, signal;
      const gate = new Promise((resolve) => (release = resolve));
      const started = new Promise((resolve) => (entered = resolve));
      spyOn(workspace, "open").and.callFake(async (openingItem, options) => {
        if (openingItem === item) {
          signal = options.signal;
          entered();
          await gate;
        }
        return open(openingItem, options);
      });
      const opening = openDefaults({ hasProject: true });
      try {
        await started;
        await workspace.open(explicit);
        if (!visible) dock.hide();
        expect(signal.aborted).toBe(true);
      } finally {
        release();
        await opening;
      }

      expect(dock.getPaneItems()).toEqual([explicit]);
      expect(dock.getActivePaneItem()).toBe(explicit);
      expect(dock.isVisible()).toBe(visible);
      expect(workspace.paneForItem(item)).toBeUndefined();
    });
  }

  it("honors an explicit dock visibility change while its default opening is pending", async () => {
    const { item } = registerItem();
    const dock = workspace.getLeftDock();
    const open = workspace.open.bind(workspace);
    let release, entered, signal;
    const gate = new Promise((resolve) => (release = resolve));
    const started = new Promise((resolve) => (entered = resolve));
    spyOn(workspace, "open").and.callFake(async (openingItem, options) => {
      signal = options.signal;
      entered();
      await gate;
      return open(openingItem, options);
    });
    const opening = openDefaults({ hasProject: true });
    try {
      await started;
      dock.show();
      dock.hide();
      expect(signal.aborted).toBe(true);
    } finally {
      release();
      await opening;
    }

    expect(workspace.paneForItem(item)).toBeUndefined();
    expect(dock.isVisible()).toBe(false);
  });

  for (const transition of ["reset", "destroy"]) {
    it(`cancels a pending default opening when the workspace ${transition}s`, async () => {
      const { item } = registerItem();
      const open = workspace.open.bind(workspace);
      let release, entered, signal;
      const gate = new Promise((resolve) => (release = resolve));
      const started = new Promise((resolve) => (entered = resolve));
      spyOn(workspace, "open").and.callFake(async (openingItem, options) => {
        signal = options.signal;
        entered();
        await gate;
        return open(openingItem, options);
      });
      const opening = openDefaults({ hasProject: true });
      try {
        await started;
        if (transition === "reset") workspace.reset(environment.packages);
        else workspace.destroy();
        expect(signal.aborted).toBe(true);
      } finally {
        release();
        await opening;
      }

      expect(workspace.isAlive()).toBe(transition === "reset");
      if (transition === "reset") {
        expect(workspace.paneForItem(item)).toBeUndefined();
        expect(workspace.getLeftDock().getPaneItems()).toEqual([]);
        expect(workspace.getLeftDock().isVisible()).toBe(false);
      }
    });
  }

  for (const failureSource of ["factory", "visibility hook", "invalid visibility"]) {
    it(`reports a failing ${failureSource} and continues with the next default item`, async () => {
      const report = spyOn(environment.notifications, "addError");
      const failure = new Error(`${failureSource} failed`);
      if (failureSource === "factory") {
        workspace.addDefaultDockItem(() => {
          throw failure;
        });
      } else {
        const broken = buildItem({ title: "Broken default" });
        broken.getDefaultVisibility = () => {
          if (failureSource === "visibility hook") throw failure;
          return "sometimes";
        };
        registerItem(broken);
      }
      const { item } = registerItem();

      await openDefaults({ hasProject: true });

      expect(report).toHaveBeenCalledTimes(1);
      expect(report.calls.first().args[0]).toBe("Unable to open default dock item");
      expect(report.calls.first().args[1].description).toContain(
        failureSource === "invalid visibility" ? "sometimes" : failure.message,
      );
      expect(workspace.getLeftDock().getPaneItems()).toEqual([item]);
      expect(workspace.getLeftDock().isVisible()).toBe(true);
    });
  }
});
