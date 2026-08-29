const { find } = require("@lumine-code/underscore-plus");
const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");
const Pane = require("./pane");
const DetachedPane = require("./detached-pane");
const ItemRegistry = require("./item-registry");
const { createPaneContainerElement } = require("./pane-container-element");

const SERIALIZATION_VERSION = 2;
const STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY = 100;

module.exports = class PaneContainer {
  constructor(params) {
    ({
      config: this.config,
      applicationDelegate: this.applicationDelegate,
      notificationManager: this.notificationManager,
      deserializerManager: this.deserializerManager,
      viewRegistry: this.viewRegistry,
      location: this.location,
    } = params);
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.itemRegistry = new ItemRegistry();
    this.detachedPanes = [];
    this.detachedPaneSubscriptions = new WeakMap();
    this.alive = true;
    this.stoppedChangingActivePaneItemTimeout = null;
    this.mutationDepth = 0;
    this.mutationStartActivePane = null;
    this.mutationStartActiveItem = null;
    this.mutationActivated = false;

    this.setRoot(
      new Pane({
        container: this,
        config: this.config,
        applicationDelegate: this.applicationDelegate,
        notificationManager: this.notificationManager,
        deserializerManager: this.deserializerManager,
        viewRegistry: this.viewRegistry,
      }),
    );
  }

  getLocation() {
    return this.location;
  }

  getElement() {
    return this.element != null
      ? this.element
      : (this.element = createPaneContainerElement().initialize(this, {
          views: this.viewRegistry,
        }));
  }

  destroy() {
    const panes = this.getPanes().slice();
    this.alive = false;
    for (let pane of panes) {
      pane.destroy();
    }
    this.detachedPanes = [];
    this.cancelStoppedChangingActivePaneItemTimeout();
    this.subscriptions.dispose();
    this.emitter.dispose();
  }

  isAlive() {
    return this.alive;
  }

  isDestroyed() {
    return !this.isAlive();
  }

  serialize(_params) {
    const detachedPanes = this.detachedPanes
      .map((pane) => pane.serialize())
      .filter((state) => state != null);
    return {
      deserializer: "PaneContainer",
      version: SERIALIZATION_VERSION,
      root: this.root ? this.root.serialize() : null,
      detachedPanes,
      activePaneId: this.activePane && this.activePane.id,
      activeTiledPaneId: this.activeTiledPane && this.activeTiledPane.id,
    };
  }

  deserialize(state, deserializerManager, options = {}) {
    if (state.version !== SERIALIZATION_VERSION) return;
    this.itemRegistry = new ItemRegistry();
    this.detachedPanes = [];
    this.detachedPaneSubscriptions = new WeakMap();
    this.setRoot(deserializerManager.deserialize(state.root));
    for (const paneState of state.detachedPanes || []) {
      const pane = deserializerManager.deserialize(paneState);
      if (pane && pane.getItems().length === 1) this.addDetachedPane(pane);
    }
    const destroyEmptyPanes =
      options.destroyEmptyPanes == null
        ? this.config.get("core.destroyEmptyPanes")
        : options.destroyEmptyPanes;
    if (destroyEmptyPanes) this.destroyEmptyPanes();

    const tiledPanes = this.getTiledPanes();
    const panes = this.getPanes();
    let restoredActiveTiledPane =
      find(tiledPanes, (pane) => pane.id === state.activeTiledPaneId) || tiledPanes[0];
    const serializedActivePane = find(panes, (pane) => pane.id === state.activePaneId);
    const restoredActivePane = serializedActivePane || panes[0];
    if (!serializedActivePane && !restoredActivePane.isDetached()) {
      restoredActiveTiledPane = restoredActivePane;
    }

    if (restoredActiveTiledPane !== this.activeTiledPane) {
      this.activeTiledPane = restoredActiveTiledPane;
      this.emitter.emit("did-change-active-tiled-pane", this.activeTiledPane);
    }
    if (restoredActivePane !== this.activePane) {
      // Views can subscribe while setRoot() installs the restored panes. Tell
      // them which pane won without emitting did-activate and stealing focus.
      this.activePane = restoredActivePane;
      this.emitter.emit("did-change-active-pane", this.activePane);
      this.didChangeActiveItemOnPane(this.activePane, this.activePane.getActiveItem());
    }
  }

  onDidChangeRoot(fn) {
    return this.emitter.on("did-change-root", fn);
  }

  observeRoot(fn) {
    fn(this.getRoot());
    return this.onDidChangeRoot(fn);
  }

  onDidAddPane(fn) {
    return this.emitter.on("did-add-pane", fn);
  }

  observePanes(fn) {
    for (let pane of this.getPanes()) {
      fn(pane);
    }
    return this.onDidAddPane(({ pane }) => fn(pane));
  }

  onDidDestroyPane(fn) {
    return this.emitter.on("did-destroy-pane", fn);
  }

  onWillDestroyPane(fn) {
    return this.emitter.on("will-destroy-pane", fn);
  }

  onDidChangeActivePane(fn) {
    return this.emitter.on("did-change-active-pane", fn);
  }

  onDidChangeActiveTiledPane(fn) {
    return this.emitter.on("did-change-active-tiled-pane", fn);
  }

  onDidActivatePane(fn) {
    return this.emitter.on("did-activate-pane", fn);
  }

  observeActivePane(fn) {
    fn(this.getActivePane());
    return this.onDidChangeActivePane(fn);
  }

  onDidDetachPane(fn) {
    return this.emitter.on("did-detach-pane", fn);
  }

  onDidAttachPane(fn) {
    return this.emitter.on("did-attach-pane", fn);
  }

  onDidAddPaneItem(fn) {
    return this.emitter.on("did-add-pane-item", fn);
  }

  observePaneItems(fn) {
    for (let item of this.getPaneItems()) {
      fn(item);
    }
    return this.onDidAddPaneItem(({ item }) => fn(item));
  }

  onDidChangeActivePaneItem(fn) {
    return this.emitter.on("did-change-active-pane-item", fn);
  }

  onDidStopChangingActivePaneItem(fn) {
    return this.emitter.on("did-stop-changing-active-pane-item", fn);
  }

  observeActivePaneItem(fn) {
    fn(this.getActivePaneItem());
    return this.onDidChangeActivePaneItem(fn);
  }

  onWillDestroyPaneItem(fn) {
    return this.emitter.on("will-destroy-pane-item", fn);
  }

  onDidDestroyPaneItem(fn) {
    return this.emitter.on("did-destroy-pane-item", fn);
  }

  getRoot() {
    return this.root;
  }

  setRoot(root) {
    this.root = root;
    this.root.setParent(this);
    this.root.setContainer(this);
    this.emitter.emit("did-change-root", this.root);
    if (this.getActivePane() == null && this.root instanceof Pane) {
      this.didActivatePane(this.root);
    }
  }

  replaceChild(oldChild, newChild) {
    if (oldChild !== this.root) {
      throw new Error("Replacing non-existent child");
    }
    this.setRoot(newChild);
  }

  getPanes() {
    if (!this.alive) return [];
    return this.getTiledPanes().concat(this.getDetachedPanes());
  }

  getTiledPanes() {
    if (!this.alive || !this.getRoot()) return [];
    return this.getRoot().getPanes();
  }

  getDetachedPanes() {
    if (!this.alive) return [];
    return this.detachedPanes.slice();
  }

  getPaneItems() {
    return this.getPanes().flatMap((pane) => pane.getItems());
  }

  getActivePane() {
    return this.activePane;
  }

  getActiveTiledPane() {
    return this.activeTiledPane;
  }

  getActivePaneItem() {
    return this.getActivePane().getActiveItem();
  }

  paneForURI(uri) {
    return find(this.getPanes(), (pane) => pane.itemForURI(uri) != null);
  }

  paneForItem(item) {
    return this.itemRegistry.paneForItem(item);
  }

  resolveReturnPane(detachedPane) {
    const tiledPanes = this.getTiledPanes();
    return (
      find(tiledPanes, (pane) => pane.id === detachedPane.getReturnPaneId()) ||
      (tiledPanes.includes(this.activeTiledPane) && this.activeTiledPane) ||
      tiledPanes[0]
    );
  }

  resolveInsertionPane(pane) {
    pane = pane || this.getActivePane();
    return pane && pane.isDetached() ? this.resolveReturnPane(pane) : pane;
  }

  saveAll() {
    return Promise.all(this.getPanes().map((pane) => pane.saveItems()));
  }

  async confirmClose(options) {
    for (const pane of this.getPanes()) {
      for (const item of pane.getItems()) {
        // Native dialogs are owned by a concrete surface. Ask in model order
        // rather than opening several surface-owned dialogs at once, and stop
        // as soon as one item cancels the close.
        if (!(await pane.promptToSaveItem(item, options))) return false;
      }
    }
    return true;
  }

  activateNextPane() {
    if (this.activePane && this.activePane.isDetached()) return false;
    const panes = this.getTiledPanes();
    if (panes.length > 1) {
      const currentIndex = panes.indexOf(this.activeTiledPane);
      const nextIndex = (currentIndex + 1) % panes.length;
      panes[nextIndex].activate();
      return true;
    } else {
      return false;
    }
  }

  activatePreviousPane() {
    if (this.activePane && this.activePane.isDetached()) return false;
    const panes = this.getTiledPanes();
    if (panes.length > 1) {
      const currentIndex = panes.indexOf(this.activeTiledPane);
      let previousIndex = currentIndex - 1;
      if (previousIndex < 0) {
        previousIndex = panes.length - 1;
      }
      panes[previousIndex].activate();
      return true;
    } else {
      return false;
    }
  }

  moveActiveItemToPane(destPane) {
    const item = this.activePane.getActiveItem();

    if (!destPane.isItemAllowed(item) || !destPane.canAcceptItem(item)) {
      return;
    }

    this.activePane.moveItemToPane(item, destPane);
    destPane.setActiveItem(item);
  }

  copyActiveItemToPane(destPane) {
    const item = this.activePane.copyActiveItem();

    if (item && destPane.isItemAllowed(item) && destPane.canAcceptItem(item)) {
      destPane.activateItem(item);
    }
  }

  destroyEmptyPanes() {
    for (let pane of this.getTiledPanes()) {
      if (pane.items.length === 0) {
        this.didEmptyPane(pane, { force: true });
      }
    }
    for (const pane of this.getDetachedPanes()) {
      if (pane.items.length === 0) pane.destroy();
    }
  }

  addDetachedPane(pane, { notify = true } = {}) {
    if (this.location !== "center") {
      throw new Error("Detached panes can only belong to the workspace center");
    }
    if (!(pane instanceof DetachedPane)) {
      throw new Error("Only DetachedPane instances can be registered as detached panes");
    }
    if (this.detachedPanes.includes(pane)) return pane;

    pane.setParent(null);
    this.detachedPanes.push(pane);
    const subscription = pane.onDidDestroy(() => {
      const index = this.detachedPanes.indexOf(pane);
      if (index !== -1) this.detachedPanes.splice(index, 1);
      this.detachedPaneSubscriptions.delete(pane);
    });
    this.detachedPaneSubscriptions.set(pane, subscription);
    pane.setContainer(this, { notify });
    return pane;
  }

  detachPaneItem(item, options = {}) {
    if (this.location !== "center") {
      throw new Error("Only workspace-center items can be detached");
    }
    const sourcePane = this.paneForItem(item);
    if (!sourcePane) throw new Error("Cannot detach an item that is not in this pane container");
    if (sourcePane.isDetached()) return sourcePane;

    const sourceIndex = sourcePane.getItems().indexOf(item);
    return this.withPaneMutation(() => {
      const detachedPane = new DetachedPane({
        config: this.config,
        applicationDelegate: this.applicationDelegate,
        notificationManager: this.notificationManager,
        deserializerManager: this.deserializerManager,
        viewRegistry: this.viewRegistry,
        returnPaneId: sourcePane.id,
        returnItemIndex: sourceIndex,
        surfaceState: options.surfaceState,
      });
      // A detached pane is public only once its sole item is already in it.
      // Register the model silently, transfer ownership atomically, then
      // announce the complete pane. Observers can therefore rely on the
      // one-item invariant even from their first callback.
      this.addDetachedPane(detachedPane, { notify: false });
      if (sourcePane.getPendingItem() === item) sourcePane.clearPendingItem();
      this.moveItem(item, sourcePane, detachedPane, 0);
      this.emitter.emit("did-add-pane", { pane: detachedPane });
      detachedPane.activate();
      this.emitter.emit("did-detach-pane", {
        pane: detachedPane,
        item,
        sourcePane,
        sourceIndex,
      });
      return detachedPane;
    });
  }

  attachDetachedPane(detachedPane, options = {}) {
    if (!this.detachedPanes.includes(detachedPane)) {
      throw new Error("Cannot attach a pane that is not detached from this container");
    }
    const item = detachedPane.getActiveItem();
    if (!item) throw new Error("A detached pane must contain one item");

    let targetPane = options.pane || this.resolveReturnPane(detachedPane);
    if (!this.getTiledPanes().includes(targetPane)) {
      throw new Error("A detached pane can only be attached to a tiled pane");
    }
    const index =
      options.index != null
        ? options.index
        : Math.min(detachedPane.getReturnItemIndex(), targetPane.getItems().length);

    return this.withPaneMutation(() => {
      this.moveItem(item, detachedPane, targetPane, index, { cleanupSource: false });
      targetPane.setActiveItem(item);
      targetPane.activate();
      this.emitter.emit("did-attach-pane", {
        pane: detachedPane,
        item,
        targetPane,
        index,
      });
      detachedPane.destroy();
      return targetPane;
    });
  }

  moveItem(item, sourcePane, destinationPane, index, options = {}) {
    if (sourcePane.getContainer() !== this || destinationPane.getContainer() !== this) {
      throw new Error("PaneContainer can only transfer items between its own panes");
    }
    if (!sourcePane.getItems().includes(item)) {
      throw new Error("Cannot move an item from a pane that does not contain it");
    }
    if (!destinationPane.isItemAllowed(item) || !destinationPane.canAcceptItem(item)) {
      return;
    }

    sourcePane.removeItem(item, true, {
      preserveRegistration: true,
      deferEmptyCleanup: true,
    });
    this.itemRegistry.moveItem(item, sourcePane, destinationPane);
    destinationPane.addItem(item, {
      index,
      moved: true,
      preserveRegistration: true,
    });
    if (options.cleanupSource !== false && sourcePane.getItems().length === 0) {
      this.didEmptyPane(sourcePane);
    }
    return item;
  }

  didEmptyPane(pane, { force = false } = {}) {
    if (!this.isAlive() || pane.isDestroyed()) return;
    if (pane.isDetached()) {
      pane.destroy();
    } else if (pane !== this.getRoot() && (force || this.config.get("core.destroyEmptyPanes"))) {
      pane.destroy();
    }
  }

  activatePaneAfterDestroy(pane) {
    if (!this.isAlive()) return;
    if (pane.isDetached()) {
      if (this.activePane === pane) this.resolveReturnPane(pane)?.activate();
      return;
    }

    if (this.activeTiledPane !== pane) return;
    const panes = this.getTiledPanes();
    const index = panes.indexOf(pane);
    const replacement = panes.length > 1 ? panes[(index + 1) % panes.length] : null;
    if (!replacement) return;
    if (this.activePane === pane) {
      replacement.activate();
    } else {
      this.setActiveTiledPane(replacement);
    }
  }

  withPaneMutation(callback) {
    if (this.mutationDepth++ === 0) {
      this.mutationStartActivePane = this.activePane;
      this.mutationStartActiveItem = this.activePane && this.activePane.getActiveItem();
      this.mutationActiveItemChanged = false;
      this.mutationActivated = false;
    }
    try {
      return callback();
    } finally {
      if (--this.mutationDepth === 0) this.flushPaneMutation();
    }
  }

  flushPaneMutation() {
    const paneChanged = this.activePane !== this.mutationStartActivePane;
    const activeItem = this.activePane && this.activePane.getActiveItem();
    if (paneChanged) this.emitter.emit("did-change-active-pane", this.activePane);
    if (
      paneChanged ||
      activeItem !== this.mutationStartActiveItem ||
      this.mutationActiveItemChanged
    ) {
      this.emitActivePaneItemChanged(activeItem);
    }
    if (this.mutationActivated) this.emitter.emit("did-activate-pane", this.activePane);
    this.mutationStartActivePane = null;
    this.mutationStartActiveItem = null;
  }

  didAddPane(event) {
    this.emitter.emit("did-add-pane", event);
    const items = event.pane.getItems();
    for (let i = 0, length = items.length; i < length; i++) {
      const item = items[i];
      this.didAddPaneItem(item, event.pane, i);
    }
  }

  willDestroyPane(event) {
    this.emitter.emit("will-destroy-pane", event);
  }

  didDestroyPane(event) {
    this.emitter.emit("did-destroy-pane", event);
  }

  didActivatePane(activePane) {
    if (activePane !== this.activePane) {
      if (!this.getPanes().includes(activePane)) {
        throw new Error("Setting active pane that is not present in pane container");
      }

      this.activePane = activePane;
      if (!activePane.isDetached()) this.setActiveTiledPane(activePane);
      if (this.mutationDepth === 0) {
        this.emitter.emit("did-change-active-pane", this.activePane);
        this.didChangeActiveItemOnPane(this.activePane, this.activePane.getActiveItem());
      }
    } else if (!activePane.isDetached() && this.getTiledPanes().includes(activePane)) {
      // Reparenting a split temporarily removes its still-active pane from the
      // root tree. Chromium may focus that pane during the detach/attach DOM
      // cycle; keep the existing tiled selection until the model is back in
      // the tree rather than treating this transient focus as invalid state.
      this.setActiveTiledPane(activePane);
    }
    if (this.mutationDepth > 0) {
      this.mutationActivated = true;
    } else {
      this.emitter.emit("did-activate-pane", this.activePane);
    }
    return this.activePane;
  }

  setActiveTiledPane(pane) {
    if (pane && !this.getTiledPanes().includes(pane)) {
      throw new Error("Setting active tiled pane that is not present in pane container");
    }
    if (pane !== this.activeTiledPane) {
      this.activeTiledPane = pane;
      this.emitter.emit("did-change-active-tiled-pane", pane);
    }
    return pane;
  }

  // The registry is this container's ledger of which items it holds, and the
  // only thing stopping one item from living in two panes at once. A move
  // emits neither the add nor the destroy event, but it still changes where
  // the item lives, so the ledger is kept up to date either way: a moved-out
  // item left registered makes its own container refuse it ever after.
  registerItem(item, pane) {
    this.itemRegistry.addItem(item, pane);
  }

  unregisterItem(item, pane) {
    this.itemRegistry.removeItem(item, pane);
  }

  didAddPaneItem(item, pane, index) {
    this.registerItem(item, pane);
    this.emitter.emit("did-add-pane-item", { item, pane, index });
  }

  willDestroyPaneItem(event) {
    return this.emitter.emitAsync("will-destroy-pane-item", event);
  }

  didDestroyPaneItem(event) {
    this.unregisterItem(event.item, event.pane);
    this.emitter.emit("did-destroy-pane-item", event);
  }

  didChangeActiveItemOnPane(pane, activeItem) {
    if (this.isAlive() && pane === this.getActivePane()) {
      if (this.mutationDepth > 0) {
        this.mutationActiveItemChanged = true;
      } else {
        this.emitActivePaneItemChanged(activeItem);
      }
    }
  }

  emitActivePaneItemChanged(activeItem) {
    this.emitter.emit("did-change-active-pane-item", activeItem);

    this.cancelStoppedChangingActivePaneItemTimeout();
    this.stoppedChangingActivePaneItemTimeout = setTimeout(() => {
      this.stoppedChangingActivePaneItemTimeout = null;
      this.emitter.emit("did-stop-changing-active-pane-item", activeItem);
    }, STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY);
  }

  cancelStoppedChangingActivePaneItemTimeout() {
    if (this.stoppedChangingActivePaneItemTimeout != null) {
      clearTimeout(this.stoppedChangingActivePaneItemTimeout);
    }
  }
};
