"use strict";

const TextEditor = require("./text-editor");
const PaneContainer = require("./pane-container");
const { confirmItemsClose } = require("./pane-item-close-batch");
const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");

/**
 * @public
 * @status essential
 *
 * Aggregates the document panes presented by all windows of one workspace.
 */
module.exports = class WorkspaceCenter {
  constructor(params) {
    this.params = { ...params, location: "center" };
    this.emitter = new Emitter();
    this.containers = new Map();
    this.paneContainer = new PaneContainer(this.params);
    this.activePaneContainer = this.paneContainer;
    this.addPaneContainer(this.paneContainer);
  }

  /** @private Register a window's document container without creating a workspace. */
  addPaneContainer(container) {
    if (container.getLocation() !== "center" || container.workspace !== this.params.workspace) {
      throw new TypeError("A center container must belong to this workspace.");
    }
    if (this.containers.has(container)) return;
    const subscriptions = new CompositeDisposable();
    this.containers.set(container, subscriptions);
    subscriptions.add(
      container.onDidActivatePane(() => {
        if (this.activePaneContainer !== container) {
          this.activePaneContainer = container;
          this.didChangeActivePane(container.getActivePane());
          this.didChangeActivePaneItem(container.getActivePaneItem());
        }
        this.params.didActivate(this);
      }),
      container.onDidChangeActivePane((pane) => {
        if (container === this.activePaneContainer) this.didChangeActivePane(pane);
      }),
      container.onDidChangeActivePaneItem((item) => {
        if (container === this.activePaneContainer) this.didChangeActivePaneItem(item);
      }),
      container.onDidStopChangingActivePaneItem((item) => {
        if (container === this.activePaneContainer)
          this.emitter.emit("did-stop-changing-active-pane-item", item);
      }),
      container.onDidAddPane((event) => {
        if (!event.transferred) this.emitter.emit("did-add-pane", event);
      }),
      container.onWillDestroyPane((event) => this.emitter.emit("will-destroy-pane", event)),
      container.onDidDestroyPane((event) => this.emitter.emit("did-destroy-pane", event)),
      container.onDidAddPaneItem((event) => this.emitter.emit("did-add-pane-item", event)),
      container.onDidDestroyPaneItem((event) => {
        this.params.didDestroyPaneItem(event);
        this.emitter.emit("did-destroy-pane-item", event);
      }),
    );
    this.emitter.emit("did-add-pane-container", container);
    for (const pane of container.getPanes()) {
      this.emitter.emit("did-add-pane", { pane });
      pane.getItems().forEach((item, index) => {
        this.emitter.emit("did-add-pane-item", { pane, item, index });
      });
    }
  }

  /** @private Remove a presentation after its panes have been moved or closed. */
  removePaneContainer(container) {
    if (container === this.paneContainer) throw new Error("Cannot remove the main center.");
    const subscriptions = this.containers.get(container);
    if (!subscriptions) return;
    subscriptions.dispose();
    this.containers.delete(container);
    if (this.activePaneContainer === container) {
      this.activePaneContainer = this.paneContainer;
      this.didChangeActivePane(this.getActivePane());
      this.didChangeActivePaneItem(this.getActivePaneItem());
    }
    this.emitter.emit("did-remove-pane-container", container);
  }

  /**
   * @public
   * @status public
   *
   * Get all document containers in this center.
   * @returns {Array<PaneContainer>} The document containers in this workspace center.
   * @category Pane Containers
   */
  getPaneContainers() {
    return [...this.containers.keys()];
  }

  /**
   * @public
   * @status public
   *
   * Observe current and future document containers.
   * @param {Function} callback -
   * @returns {Disposable} Dispose to stop observing added containers.
   * @category Event Subscription
   */
  observePaneContainers(callback) {
    for (const container of this.getPaneContainers()) callback(container);
    return this.emitter.on("did-add-pane-container", callback);
  }

  /** @private */
  didChangeActivePane(pane) {
    this.params.didChangeActivePane(this, pane);
    this.emitter.emit("did-change-active-pane", pane);
  }

  /** @private */
  didChangeActivePaneItem(item) {
    this.params.didChangeActivePaneItem(this, item);
    this.emitter.emit("did-change-active-pane-item", item);
  }

  destroy() {
    for (const [container, subscriptions] of this.containers) {
      container.destroy();
      subscriptions.dispose();
    }
    this.containers.clear();
    this.emitter.dispose();
  }

  serialize() {
    return {
      main: this.paneContainer.serialize(),
      activeWindowId: this.activePaneContainer.getWindow()?.persistentId ?? "main",
      windows: this.getPaneContainers()
        .filter((container) => container !== this.paneContainer)
        .map((container) => {
          const window = container.getWindow();
          return {
            id: window.persistentId,
            ...window.serializeGeometry(),
            container: container.serialize(),
          };
        }),
    };
  }

  deserialize(state, deserializerManager) {
    this.paneContainer.deserialize(state.main ?? state, deserializerManager);
  }

  activate() {
    this.getActivePane().activate();
  }

  getLocation() {
    return "center";
  }

  setDraggingItem() {
    // No-op
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with all current and future text
   * editors in the workspace center.
   *
   * @param {Function} callback - to be called with current and future text editors.
   * @param {TextEditor} callback.editor - An {@link TextEditor} that is present in {@link #getTextEditors} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeTextEditors(callback) {
    for (let textEditor of this.getTextEditors()) {
      callback(textEditor);
    }
    return this.onDidAddTextEditor(({ textEditor }) => callback(textEditor));
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with all current and future panes items
   * in the workspace center.
   *
   * @param {Function} callback - to be called with current and future pane items.
   * @param {*} callback.item - An item that is present in {@link #getPaneItems} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observePaneItems(callback) {
    for (const item of this.getPaneItems()) callback(item);
    return this.onDidAddPaneItem(({ item }) => callback(item));
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when the active pane item changes.
   *
   * Because observers are invoked synchronously, it's important not to perform
   * any expensive operations via this method. Consider
   * {@link #onDidStopChangingActivePaneItem} to delay operations until after changes
   * stop occurring.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param {*} callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActivePaneItem(callback) {
    return this.emitter.on("did-change-active-pane-item", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when the active pane item stops
   * changing.
   *
   * Observers are called asynchronously 100ms after the last active pane item
   * change. Handling changes here rather than in the synchronous
   * {@link #onDidChangeActivePaneItem} prevents unneeded work if the user is quickly
   * changing or closing tabs and ensures critical UI feedback, like changing the
   * highlighted tab, gets priority over work that can be done asynchronously.
   *
   * @param {Function} callback - to be called when the active pane item stops changing.
   * @param {*} callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidStopChangingActivePaneItem(callback) {
    return this.emitter.on("did-stop-changing-active-pane-item", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with the current active pane item and
   * with all future active pane items in the workspace center.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param {*} callback.item - The current active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActivePaneItem(callback) {
    callback(this.getActivePaneItem());
    return this.onDidChangeActivePaneItem(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane is added to the workspace
   * center.
   *
   * @param {Function} callback - to be called when panes are added.
   * @param {Object} callback.event - with the following keys:
   * @param {Pane} callback.event.pane - The added pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddPane(callback) {
    return this.emitter.on("did-add-pane", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback before a pane is destroyed in the
   * workspace center.
   *
   * @param {Function} callback - to be called before panes are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {Pane} callback.event.pane - The pane to be destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillDestroyPane(callback) {
    return this.emitter.on("will-destroy-pane", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane is destroyed in the
   * workspace center.
   *
   * @param {Function} callback - to be called when panes are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {Pane} callback.event.pane - The destroyed pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroyPane(callback) {
    return this.emitter.on("did-destroy-pane", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with all current and future panes in the
   * workspace center.
   *
   * @param {Function} callback - to be called with current and future panes.
   * @param {Pane} callback.pane - A {@link Pane} that is present in {@link #getPanes} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observePanes(callback) {
    for (const pane of this.getPanes()) callback(pane);
    return this.onDidAddPane(({ pane }) => callback(pane));
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when the active pane changes.
   *
   * @param {Function} callback - to be called when the active pane changes.
   * @param {Pane} callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActivePane(callback) {
    return this.emitter.on("did-change-active-pane", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with the current active pane and when
   * the active pane changes.
   *
   * @param {Function} callback - to be called with the current and future active panes.
   * @param {Pane} callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActivePane(callback) {
    callback(this.getActivePane());
    return this.onDidChangeActivePane(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane item is added to the
   * workspace center.
   *
   * @param {Function} callback - to be called when pane items are added.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The added pane item.
   * @param {Pane} callback.event.pane - containing the added item.
   * @param {Number} callback.event.index - indicating the index of the added item in its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddPaneItem(callback) {
    return this.emitter.on("did-add-pane-item", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane item is about to be
   * destroyed, before the user is prompted to save it.
   *
   * @param {Function} callback - to be called before pane items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The item to be destroyed.
   * @param {Pane} callback.event.pane - containing the item to be destroyed.
   * @param {Number} callback.event.index - indicating the index of the item to be destroyed in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   */
  onWillDestroyPaneItem(callback) {
    const subscriptions = new CompositeDisposable();
    subscriptions.add(
      this.observePaneContainers((container) => {
        subscriptions.add(container.onWillDestroyPaneItem(callback));
      }),
    );
    return subscriptions;
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane item is destroyed.
   *
   * @param {Function} callback - to be called when pane items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The destroyed item.
   * @param {Pane} callback.event.pane - containing the destroyed item.
   * @param {Number} callback.event.index - indicating the index of the destroyed item in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   */
  onDidDestroyPaneItem(callback) {
    return this.emitter.on("did-destroy-pane-item", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a text editor is added to the
   * workspace center.
   *
   * @param {Function} callback - to be called when panes are added.
   * @param {Object} callback.event - with the following keys:
   * @param {TextEditor} callback.event.textEditor - that was added.
   * @param {Pane} callback.event.pane - containing the added text editor.
   * @param {Number} callback.event.index - indicating the index of the added text editor in its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddTextEditor(callback) {
    return this.onDidAddPaneItem(({ item, pane, index }) => {
      if (item instanceof TextEditor) {
        callback({ textEditor: item, pane, index });
      }
    });
  }

  /**
   * @category Pane Items
   */

  /**
   * @public
   * @status essential
   *
   * Get all pane items in the workspace center.
   *
   * @returns {Array} of items.
   */
  getPaneItems() {
    return this.getPaneContainers().flatMap((container) => container.getPaneItems());
  }

  /**
   * @public
   * @status essential
   *
   * Get the active {@link Pane}'s active item.
   *
   * @returns {Object} pane item `Object`.
   */
  getActivePaneItem() {
    return this.activePaneContainer.getActivePaneItem();
  }

  /**
   * @public
   * @status essential
   *
   * Get all text editors in the workspace center.
   *
   * @returns {Array} of {@link TextEditor TextEditors}.
   */
  getTextEditors() {
    return this.getPaneItems().filter((item) => item instanceof TextEditor);
  }

  /**
   * @public
   * @status essential
   *
   * Get the active item if it is an {@link TextEditor}.
   *
   * @returns {TextEditor} or `undefined` if the current active item is not an {@link TextEditor}.
   */
  getActiveTextEditor() {
    const activeItem = this.getActivePaneItem();
    if (activeItem instanceof TextEditor) {
      return activeItem;
    }
  }

  // Save all pane items.
  saveAll() {
    return Promise.all(this.getPaneContainers().map((container) => container.saveAll()));
  }

  confirmClose(options) {
    return confirmItemsClose(
      this.params.workspace,
      this.getPanes().flatMap((pane) => pane.getItems().map((item) => ({ pane, item }))),
      options,
    );
  }

  /**
   * @category Panes
   */

  /**
   * @public
   * @status extended
   *
   * Get all panes in the workspace center.
   *
   * @returns {Array} of {@link Pane Panes}.
   */
  getPanes() {
    return this.getPaneContainers().flatMap((container) => container.getPanes());
  }

  /**
   * @public
   * @status extended
   *
   * Get the active {@link Pane}.
   *
   * @returns {Pane}
   */
  getActivePane() {
    return this.activePaneContainer.getActivePane();
  }

  /**
   * @public
   * @status extended
   *
   * Make the next pane active.
   */
  activateNextPane() {
    return this.activePaneContainer.activateNextPane();
  }

  /**
   * @public
   * @status extended
   *
   * Make the previous pane active.
   */
  activatePreviousPane() {
    return this.activePaneContainer.activatePreviousPane();
  }

  paneForURI(uri) {
    for (const container of this.getPaneContainers()) {
      const pane = container.paneForURI(uri);
      if (pane) return pane;
    }
  }

  paneForItem(item) {
    for (const container of this.getPaneContainers()) {
      const pane = container.paneForItem(item);
      if (pane) return pane;
    }
  }

  // Destroy (close) the active pane.
  destroyActivePane() {
    const activePane = this.getActivePane();
    if (activePane != null) {
      activePane.destroy();
    }
  }
};
