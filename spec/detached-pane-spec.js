const { Emitter } = require("@lumine-code/event-kit");
const DetachedPane = require("../src/detached-pane");
const PaneContainer = require("../src/pane-container");

describe("DetachedPane", () => {
  class DetachedPaneTestItem {
    static deserialize({ name }) {
      return new DetachedPaneTestItem(name);
    }

    constructor(name) {
      this.name = name;
      this.emitter = new Emitter();
      this.destroyed = false;
    }

    serialize() {
      return { deserializer: "DetachedPaneTestItem", name: this.name };
    }

    onDidDestroy(callback) {
      return this.emitter.on("did-destroy", callback);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emitter.emit("did-destroy");
    }

    isDestroyed() {
      return this.destroyed;
    }
  }

  let container, deserializerDisposable;

  beforeEach(() => {
    deserializerDisposable = lumine.deserializers.add(DetachedPaneTestItem);
    container = new PaneContainer({
      location: "center",
      config: lumine.config,
      applicationDelegate: lumine.applicationDelegate,
      notificationManager: lumine.notifications,
      deserializerManager: lumine.deserializers,
      viewRegistry: lumine.views,
    });
  });

  afterEach(() => deserializerDisposable.dispose());

  it("remains a center pane while staying outside the tiled tree", () => {
    const tiledPane = container.getActivePane();
    const first = new DetachedPaneTestItem("first");
    const second = new DetachedPaneTestItem("second");
    tiledPane.addItems([first, second]);
    const addedItems = [];
    const destroyedItems = [];
    container.onDidAddPaneItem(({ item }) => addedItems.push(item));
    container.onDidDestroyPaneItem(({ item }) => destroyedItems.push(item));

    const detachedPane = container.detachPaneItem(first);

    expect(detachedPane instanceof DetachedPane).toBe(true);
    expect(detachedPane.getContainer()).toBe(container);
    expect(detachedPane.getParent()).toBe(null);
    expect(detachedPane.getItems()).toEqual([first]);
    expect(container.getTiledPanes()).toEqual([tiledPane]);
    expect(container.getDetachedPanes()).toEqual([detachedPane]);
    expect(container.getPanes()).toEqual([tiledPane, detachedPane]);
    expect(container.paneForItem(first)).toBe(detachedPane);
    expect(container.getActivePane()).toBe(detachedPane);
    expect(container.getActiveTiledPane()).toBe(tiledPane);
    expect(addedItems).toEqual([]);
    expect(destroyedItems).toEqual([]);
  });

  it("becomes observable only after it contains its sole item", () => {
    const item = new DetachedPaneTestItem("item");
    container.getRoot().addItem(item);
    const observed = [];
    container.onDidAddPane(({ pane }) => {
      if (pane.isDetached()) observed.push(pane.getItems().slice());
    });

    container.detachPaneItem(item);

    expect(observed).toEqual([[item]]);
  });

  it("never destroys the tiled root when its only item is detached", () => {
    lumine.config.set("core.destroyEmptyPanes", true);
    const root = container.getRoot();
    const item = new DetachedPaneTestItem("item");
    root.addItem(item);

    container.detachPaneItem(item);

    expect(root.isAlive()).toBe(true);
    expect(root.getItems()).toEqual([]);
    expect(container.getRoot()).toBe(root);
    expect(container.getTiledPanes()).toEqual([root]);
  });

  it("terminates pending state before moving an item out of the tab strip", () => {
    const pane = container.getRoot();
    const item = new DetachedPaneTestItem("pending");
    const terminated = jasmine.createSpy("terminated");
    pane.onItemDidTerminatePendingState(terminated);
    pane.addItem(item, { pending: true });

    container.detachPaneItem(item);

    expect(terminated).toHaveBeenCalledOnceWith(item);
    expect(pane.getPendingItem()).toBeNull();
  });

  it("attaches the item at its original index without add or destroy item events", () => {
    const tiledPane = container.getRoot();
    const first = new DetachedPaneTestItem("first");
    const second = new DetachedPaneTestItem("second");
    const third = new DetachedPaneTestItem("third");
    tiledPane.addItems([first, second, third]);
    const detachedPane = container.detachPaneItem(second);
    const addedItems = [];
    const destroyedItems = [];
    container.onDidAddPaneItem(({ item }) => addedItems.push(item));
    container.onDidDestroyPaneItem(({ item }) => destroyedItems.push(item));

    const target = container.attachDetachedPane(detachedPane);

    expect(target).toBe(tiledPane);
    expect(tiledPane.getItems()).toEqual([first, second, third]);
    expect(detachedPane.isDestroyed()).toBe(true);
    expect(container.getDetachedPanes()).toEqual([]);
    expect(container.paneForItem(second)).toBe(tiledPane);
    expect(addedItems).toEqual([]);
    expect(destroyedItems).toEqual([]);
  });

  it("keeps multiple detached panes as distinct one-item center panes", () => {
    const first = new DetachedPaneTestItem("first");
    const second = new DetachedPaneTestItem("second");
    container.getRoot().addItems([first, second]);

    const firstPane = container.detachPaneItem(first);
    const secondPane = container.detachPaneItem(second);

    expect(container.getDetachedPanes()).toEqual([firstPane, secondPane]);
    expect(firstPane.getItems()).toEqual([first]);
    expect(secondPane.getItems()).toEqual([second]);
    expect(container.paneForItem(first)).toBe(firstPane);
    expect(container.paneForItem(second)).toBe(secondPane);
  });

  it("publishes one final active item during detach and attach", () => {
    const item = new DetachedPaneTestItem("item");
    container.getRoot().addItem(item);
    const activeItems = [];
    container.onDidChangeActivePaneItem((activeItem) => activeItems.push(activeItem));

    const detachedPane = container.detachPaneItem(item);
    expect(activeItems).toEqual([item]);

    activeItems.length = 0;
    container.attachDetachedPane(detachedPane);
    expect(activeItems).toEqual([item]);
  });

  it("routes splits into the tiled tree and attaches on a move split", () => {
    const tiledPane = container.getRoot();
    const item = new DetachedPaneTestItem("item");
    tiledPane.addItem(item);
    const detachedPane = container.detachPaneItem(item);

    const newPane = detachedPane.splitRight({ moveActiveItem: true });

    expect(container.getTiledPanes()).toEqual([tiledPane, newPane]);
    expect(newPane.getItems()).toEqual([item]);
    expect(container.getDetachedPanes()).toEqual([]);
    expect(detachedPane.isDestroyed()).toBe(true);
  });

  it("serializes the detached item, return target, surface state, and activity", () => {
    const tiledPane = container.getRoot();
    const item = new DetachedPaneTestItem("item");
    tiledPane.addItem(item);
    container.detachPaneItem(item, {
      surfaceState: { bounds: { x: 10, y: 20, width: 800, height: 600 } },
    });

    const restored = new PaneContainer({
      location: "center",
      config: lumine.config,
      applicationDelegate: lumine.applicationDelegate,
      notificationManager: lumine.notifications,
      deserializerManager: lumine.deserializers,
      viewRegistry: lumine.views,
    });
    restored.deserialize(container.serialize(), lumine.deserializers);

    const [restoredDetachedPane] = restored.getDetachedPanes();
    expect(restoredDetachedPane.getActiveItem().name).toBe("item");
    expect(restoredDetachedPane.getReturnPane()).toBe(restored.getRoot());
    expect(restoredDetachedPane.getSurfaceState()).toEqual({
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    expect(restored.getActivePane()).toBe(restoredDetachedPane);
    expect(restored.getActiveTiledPane()).toBe(restored.getRoot());
  });

  it("destroys an emptied detached pane regardless of core.destroyEmptyPanes", () => {
    lumine.config.set("core.destroyEmptyPanes", false);
    const item = new DetachedPaneTestItem("item");
    container.getRoot().addItem(item);
    const detachedPane = container.detachPaneItem(item);

    item.destroy();

    expect(detachedPane.isDestroyed()).toBe(true);
    expect(container.getDetachedPanes()).toEqual([]);
    expect(container.paneForItem(item)).toBeUndefined();
  });
});
