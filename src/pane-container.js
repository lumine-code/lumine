const { find } = require("@lumine-code/underscore-plus");
const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");
const Pane = require("./pane");
const ItemRegistry = require("./item-registry");
const { createPaneContainerElement } = require("./pane-container-element");

const SERIALIZATION_VERSION = 1;
const STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY = 100;
let activeStateTransaction = null;

module.exports = class PaneContainer {
  constructor(params) {
    let applicationDelegate, deserializerManager, notificationManager;
    ({
      config: this.config,
      applicationDelegate,
      notificationManager,
      deserializerManager,
      viewRegistry: this.viewRegistry,
      location: this.location = "center",
    } = params);
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.itemRegistry = new ItemRegistry();
    this.alive = true;
    this.paneActivationOrder = new Set();
    this.activeStateTransaction = null;
    this.stoppedChangingActivePaneItemTimeout = null;

    this.setRoot(
      new Pane({
        container: this,
        config: this.config,
        applicationDelegate,
        notificationManager,
        deserializerManager,
        viewRegistry: this.viewRegistry,
      }),
    );
    this.didActivatePane(this.getRoot());
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
    this.alive = false;
    for (let pane of this.getRoot().getPanes()) {
      pane.destroy();
    }
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
    return {
      deserializer: "PaneContainer",
      version: SERIALIZATION_VERSION,
      root: this.root ? this.root.serialize() : null,
      activePaneId: this.activePane.id,
    };
  }

  deserialize(state, deserializerManager) {
    if (state.version !== SERIALIZATION_VERSION) return;
    this.itemRegistry = new ItemRegistry();
    this.paneActivationOrder.clear();
    this.setRoot(deserializerManager.deserialize(state.root));
    const activePane =
      find(this.getRoot().getPanes(), (pane) => pane.id === state.activePaneId) ||
      this.getPanes()[0];
    if (this.shouldDestroyEmptyPanes()) this.destroyEmptyPanes();
    const restoredActivePane = activePane.isAlive() ? activePane : this.getPanes()[0];
    // A restored layout starts a new activation order without retaining panes
    // from the previous layout or activating views while deserializing.
    this.paneActivationOrder = new Set([restoredActivePane]);
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

  onDidActivatePane(fn) {
    return this.emitter.on("did-activate-pane", fn);
  }

  onWillActivatePane(fn) {
    return this.emitter.on("will-activate-pane", fn);
  }

  observeActivePane(fn) {
    fn(this.getActivePane());
    return this.onDidChangeActivePane(fn);
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
    if (this.alive) {
      return this.getRoot().getPanes();
    } else {
      return [];
    }
  }

  getPaneItems() {
    return this.getRoot().getItems();
  }

  getActivePane() {
    return this.activePane;
  }

  getActivePaneItem() {
    return this.getActivePane().getActiveItem();
  }

  // Commit a composite synchronous operation before notifying workspace
  // observers. Any container touched on this synchronous call stack joins the
  // same group, including a center activated by an empty dock hiding itself.
  transactActiveState(callback) {
    if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
      throw new TypeError("Active pane transactions require a synchronous callback");
    }
    const update = () => {
      const result = callback();
      if (result && typeof result.then === "function") {
        throw new TypeError("Active pane transactions cannot return a Promise");
      }
      return result;
    };
    if (activeStateTransaction) {
      this.enlistInActiveStateTransaction();
      return update();
    }

    const transaction = {
      containers: new Map(),
      activationOwner: null,
    };
    activeStateTransaction = transaction;
    this.enlistInActiveStateTransaction();
    try {
      return update();
    } finally {
      activeStateTransaction = null;
      for (const container of transaction.containers.keys()) {
        container.activeStateTransaction = null;
      }
      // Establish the final workspace container before another container
      // reports its fallback item. Earlier activation requests must not replay
      // afterward and move the workspace back to a pane that lost focus.
      const owner = transaction.activationOwner;
      if (owner) owner.flushActiveStateTransaction(transaction.containers.get(owner), true);
      for (const [container, initialState] of transaction.containers) {
        if (container !== owner) container.flushActiveStateTransaction(initialState, false);
      }
    }
  }

  enlistInActiveStateTransaction() {
    if (!activeStateTransaction) return;
    if (!activeStateTransaction.containers.has(this)) {
      const pane = this.getActivePane();
      activeStateTransaction.containers.set(this, { pane, item: pane?.getActiveItem() });
    }
    this.activeStateTransaction = activeStateTransaction;
  }

  flushActiveStateTransaction(initialState, activated) {
    if (!this.isAlive()) return;
    const paneChanged = this.activePane !== initialState.pane;
    if (paneChanged) this.emitter.emit("did-change-active-pane", this.activePane);
    if (paneChanged || this.getActivePaneItem() !== initialState.item) {
      this.didChangeActiveItemOnPane(this.activePane, this.getActivePaneItem());
    }
    if (activated) this.emitter.emit("did-activate-pane", this.activePane);
  }

  paneForURI(uri) {
    return find(this.getPanes(), (pane) => pane.itemForURI(uri) != null);
  }

  paneForItem(item) {
    return find(this.getPanes(), (pane) => pane.getItems().includes(item));
  }

  saveAll() {
    return Promise.all(this.getPanes().map((pane) => pane.saveItems()));
  }

  async confirmClose(options) {
    for (const pane of this.getPanes()) {
      for (const item of pane.getItems()) {
        // Native dialogs must be answered one at a time, and cancellation
        // makes every later prompt unnecessary.
        if (!(await pane.promptToSaveItem(item, options))) return false;
      }
    }
    return true;
  }

  activateNextPane() {
    const panes = this.getPanes();
    if (panes.length > 1) {
      const currentIndex = panes.indexOf(this.activePane);
      const nextIndex = (currentIndex + 1) % panes.length;
      panes[nextIndex].activate();
      return true;
    } else {
      return false;
    }
  }

  activatePreviousPane() {
    const panes = this.getPanes();
    if (panes.length > 1) {
      const currentIndex = panes.indexOf(this.activePane);
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

  activatePaneAfterDestroy() {
    const panes = this.getPanes();
    // The closing pane is already dead but still in the layout until its
    // did-destroy event. Prefer the last surviving pane the user worked in.
    const lastUsedPane = Array.from(this.paneActivationOrder)
      .reverse()
      .find((pane) => pane.isAlive() && panes.includes(pane));
    if (lastUsedPane) {
      lastUsedPane.activate();
      return true;
    }
    return this.activateNextPane();
  }

  moveActiveItemToPane(destPane) {
    const item = this.activePane.getActiveItem();

    if (!destPane.isItemAllowed(item)) {
      return;
    }

    return this.transactActiveState(() => {
      this.activePane.moveItemToPane(item, destPane);
      destPane.setActiveItem(item);
    });
  }

  copyActiveItemToPane(destPane) {
    const item = this.activePane.copyActiveItem();

    if (item && destPane.isItemAllowed(item)) {
      return this.transactActiveState(() => destPane.activateItem(item));
    }
  }

  destroyEmptyPanes() {
    for (let pane of this.getPanes()) {
      if (pane.items.length === 0) {
        pane.destroy();
      }
    }
  }

  shouldDestroyEmptyPanes() {
    // This preference controls the center layout only. Dock splits should
    // never remain empty, either at runtime or after deserialization.
    return this.location !== "center" || this.config.get("core.destroyEmptyPanes");
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
    this.paneActivationOrder.delete(event.pane);
    this.emitter.emit("did-destroy-pane", event);
  }

  didActivatePane(activePane) {
    this.enlistInActiveStateTransaction();
    if (activePane !== this.activePane) {
      if (!this.getPanes().includes(activePane)) {
        throw new Error("Setting active pane that is not present in pane container");
      }

      this.paneActivationOrder.delete(activePane);
      this.paneActivationOrder.add(activePane);
      this.activePane = activePane;
      if (!this.activeStateTransaction) {
        this.emitter.emit("did-change-active-pane", this.activePane);
        this.didChangeActiveItemOnPane(this.activePane, this.activePane.getActiveItem());
      }
    }
    if (this.activeStateTransaction) {
      this.activeStateTransaction.activationOwner = this;
    }
    // A dock must be visible before the pane's immediate local activation
    // event focuses its view. Workspace activation still waits for commit.
    this.emitter.emit("will-activate-pane", this.activePane);
    if (!this.activeStateTransaction) {
      this.emitter.emit("did-activate-pane", this.activePane);
    }
    return this.activePane;
  }

  // The registry is this container's ledger of which items it holds, and the
  // only thing stopping one item from living in two panes at once. A move
  // emits neither the add nor the destroy event, but it still changes where
  // the item lives, so the ledger is kept up to date either way: a moved-out
  // item left registered makes its own container refuse it ever after.
  registerItem(item) {
    this.itemRegistry.addItem(item);
  }

  unregisterItem(item) {
    this.itemRegistry.removeItem(item);
  }

  didAddPaneItem(item, pane, index) {
    this.registerItem(item);
    this.emitter.emit("did-add-pane-item", { item, pane, index });
  }

  willDestroyPaneItem(event) {
    return this.emitter.emitAsync("will-destroy-pane-item", event);
  }

  didDestroyPaneItem(event) {
    this.unregisterItem(event.item);
    this.emitter.emit("did-destroy-pane-item", event);
  }

  didChangeActiveItemOnPane(pane, activeItem) {
    if (this.isAlive() && pane === this.getActivePane() && !this.activeStateTransaction) {
      this.emitter.emit("did-change-active-pane-item", activeItem);

      this.cancelStoppedChangingActivePaneItemTimeout();
      this.stoppedChangingActivePaneItemTimeout = setTimeout(() => {
        this.stoppedChangingActivePaneItemTimeout = null;
        this.emitter.emit("did-stop-changing-active-pane-item", activeItem);
      }, STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY);
    }
  }

  cancelStoppedChangingActivePaneItemTimeout() {
    if (this.stoppedChangingActivePaneItemTimeout != null) {
      clearTimeout(this.stoppedChangingActivePaneItemTimeout);
    }
  }
};
