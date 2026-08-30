"use strict";

const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const TextEditor = require("./text-editor");
const PaneContainer = require("./pane-container");

const STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY = 100;

/**
 * @public
 * @status essential
 *
 * Represents the workspace center across all native window surfaces.
 */
module.exports = class WorkspaceCenter {
  constructor(params) {
    params.location = "center";
    this.paneContainer = new PaneContainer(params);
    this.didActivate = params.didActivate;
    this.notifyDidChangeActivePane = params.didChangeActivePane;
    this.notifyDidChangeActivePaneItem = params.didChangeActivePaneItem;
    this.resolveActivePane = params.resolveActivePane;
    this.emitter = new Emitter();
    this.stoppedChangingActivePaneItemTimeout = null;
    this.lastPublishedActivePane = this.paneContainer.getActivePane();
    this.lastPublishedActivePaneItem = this.lastPublishedActivePane?.getActiveItem();
    this.subscriptions = new CompositeDisposable(
      this.emitter,
      this.paneContainer.onDidActivatePane(() => this.didActivate(this)),
      this.paneContainer.onDidChangeActivePane(() => this.publishActiveContext()),
      this.paneContainer.onDidChangeActiveTiledPane(() => this.publishActiveContext()),
      this.paneContainer.onDidChangeActivePaneItem(() => this.publishActiveContext()),
      this.paneContainer.onDidChangePaneActiveItem(() => this.publishActiveContext()),
      this.paneContainer.onDidDestroyPaneItem((item) => params.didDestroyPaneItem(item)),
    );
  }

  destroy() {
    this.cancelStoppedChangingActivePaneItemTimeout();
    this.paneContainer.destroy();
    this.subscriptions.dispose();
  }

  /** @private */
  didChangeActiveWindowSurface() {
    this.publishActiveContext();
  }

  /** @private */
  publishActiveContext() {
    const pane = this.getActivePane();
    const item = pane?.getActiveItem();
    const paneChanged = pane !== this.lastPublishedActivePane;
    const itemChanged = paneChanged || item !== this.lastPublishedActivePaneItem;
    if (!paneChanged && !itemChanged) return;

    this.lastPublishedActivePane = pane;
    this.lastPublishedActivePaneItem = item;
    if (paneChanged) {
      this.notifyDidChangeActivePane(this, pane);
      this.emitter.emit("did-change-active-pane", pane);
    }
    if (itemChanged) {
      this.notifyDidChangeActivePaneItem(this, item);
      this.emitActivePaneItemChanged(item);
    }
  }

  /** @private */
  emitActivePaneItemChanged(item) {
    this.emitter.emit("did-change-active-pane-item", item);
    this.cancelStoppedChangingActivePaneItemTimeout();
    this.stoppedChangingActivePaneItemTimeout = setTimeout(() => {
      this.stoppedChangingActivePaneItemTimeout = null;
      this.emitter.emit("did-stop-changing-active-pane-item", item);
    }, STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY);
  }

  /** @private */
  cancelStoppedChangingActivePaneItemTimeout() {
    if (this.stoppedChangingActivePaneItemTimeout != null) {
      clearTimeout(this.stoppedChangingActivePaneItemTimeout);
      this.stoppedChangingActivePaneItemTimeout = null;
    }
  }

  serialize() {
    return this.paneContainer.serialize();
  }

  deserialize(state, deserializerManager) {
    this.paneContainer.deserialize(state, deserializerManager);
  }

  activate() {
    this.getActiveTiledPane().activate();
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
   * @param callback.editor - An {@link TextEditor} that is present in {@link #getTextEditors} at the time of subscription or that is added at some later time.
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
   * @param callback.item - An item that is present in {@link #getPaneItems} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observePaneItems(callback) {
    return this.paneContainer.observePaneItems(callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when the focused native surface's active center
   * pane item changes.
   *
   * Because observers are invoked synchronously, it's important not to perform
   * any expensive operations via this method. Consider
   * {@link #onDidStopChangingActivePaneItem} to delay operations until after changes
   * stop occurring.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActivePaneItem(callback) {
    return this.emitter.on("did-change-active-pane-item", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when the focused native surface's active center
   * pane item stops changing.
   *
   * Observers are called asynchronously 100ms after the last active pane item
   * change. Handling changes here rather than in the synchronous
   * {@link #onDidChangeActivePaneItem} prevents unneeded work if the user is quickly
   * changing or closing tabs and ensures critical UI feedback, like changing the
   * highlighted tab, gets priority over work that can be done asynchronously.
   *
   * @param {Function} callback - to be called when the active pane item stops changing.
   * @param callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidStopChangingActivePaneItem(callback) {
    return this.emitter.on("did-stop-changing-active-pane-item", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with the focused native surface's current active
   * center pane item and with all future active center pane items.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param callback.item - The current active pane item.
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
   * @param callback.event.pane - The added pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddPane(callback) {
    return this.paneContainer.onDidAddPane(callback);
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
   * @param callback.event.pane - The pane to be destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillDestroyPane(callback) {
    return this.paneContainer.onWillDestroyPane(callback);
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
   * @param callback.event.pane - The destroyed pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroyPane(callback) {
    return this.paneContainer.onDidDestroyPane(callback);
  }

  onDidDetachPane(callback) {
    return this.paneContainer.onDidDetachPane(callback);
  }

  onDidAttachPane(callback) {
    return this.paneContainer.onDidAttachPane(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with all current and future panes in the
   * workspace center.
   *
   * @param {Function} callback - to be called with current and future panes.
   * @param callback.pane - A {@link Pane} that is present in {@link #getPanes} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observePanes(callback) {
    return this.paneContainer.observePanes(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when the focused native surface's active center
   * pane changes.
   *
   * @param {Function} callback - to be called when the active pane changes.
   * @param callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActivePane(callback) {
    return this.emitter.on("did-change-active-pane", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with the focused native surface's current active
   * center pane and when it changes.
   *
   * @param {Function} callback - to be called with the current and future active panes.
   * @param callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
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
   * @param callback.event.item - The added pane item.
   * @param {Pane} callback.event.pane - containing the added item.
   * @param {Number} callback.event.index - indicating the index of the added item in its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddPaneItem(callback) {
    return this.paneContainer.onDidAddPaneItem(callback);
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
   * @param callback.event.item - The item to be destroyed.
   * @param {Pane} callback.event.pane - containing the item to be destroyed.
   * @param {Number} callback.event.index - indicating the index of the item to be destroyed in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   */
  onWillDestroyPaneItem(callback) {
    return this.paneContainer.onWillDestroyPaneItem(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane item is destroyed.
   *
   * @param {Function} callback - to be called when pane items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The destroyed item.
   * @param {Pane} callback.event.pane - containing the destroyed item.
   * @param {Number} callback.event.index - indicating the index of the destroyed item in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   */
  onDidDestroyPaneItem(callback) {
    return this.paneContainer.onDidDestroyPaneItem(callback);
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
    return this.paneContainer.getPaneItems();
  }

  /**
   * @public
   * @status essential
   *
   * Get the focused native surface's active center pane item.
   *
   * @returns {Object} pane item `Object`.
   */
  getActivePaneItem() {
    return this.getActivePane()?.getActiveItem();
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
    return this.paneContainer.saveAll();
  }

  confirmClose(options) {
    return this.paneContainer.confirmClose(options);
  }

  /**
   * @category Panes
   */

  /**
   * @public
   * @status extended
   *
   * Get all tiled and detached panes in the workspace center.
   *
   * @returns {Array} of {@link Pane Panes}.
   */
  getPanes() {
    return this.paneContainer.getPanes();
  }

  /**
   * @public
   * @status extended
   *
   * Get the panes participating in the primary window's tiled layout.
   *
   * @returns {Array} of tiled {@link Pane Panes}.
   */
  getTiledPanes() {
    return this.paneContainer.getTiledPanes();
  }

  /**
   * @public
   * @status extended
   *
   * Get the one-item panes presented in detached native windows.
   *
   * @returns {Array} of detached panes.
   */
  getDetachedPanes() {
    return this.paneContainer.getDetachedPanes();
  }

  /**
   * @public
   * @status extended
   *
   * Get the focused native surface's active center {@link Pane}.
   *
   * @returns {Pane}
   */
  getActivePane() {
    return this.resolveActivePane?.() || this.paneContainer.getActivePane();
  }

  /**
   * @public
   * @status extended
   *
   * Get the last active pane in the primary tiled surface.
   *
   * @returns {Pane}
   */
  getActiveTiledPane() {
    return this.paneContainer.getActiveTiledPane();
  }

  /** @private */
  resolveInsertionPane(pane) {
    return this.paneContainer.resolveInsertionPane(pane);
  }

  /** @private */
  detachPaneItem(item, options) {
    return this.paneContainer.detachPaneItem(item, options);
  }

  /** @private */
  attachDetachedPane(pane, options) {
    return this.paneContainer.attachDetachedPane(pane, options);
  }

  /**
   * @public
   * @status extended
   *
   * Make the next pane active.
   */
  activateNextPane() {
    return this.paneContainer.activateNextPane();
  }

  /**
   * @public
   * @status extended
   *
   * Make the previous pane active.
   */
  activatePreviousPane() {
    return this.paneContainer.activatePreviousPane();
  }

  paneForURI(uri) {
    return this.paneContainer.paneForURI(uri);
  }

  paneForItem(item) {
    return this.paneContainer.paneForItem(item);
  }

  // Destroy (close) the active pane.
  destroyActivePane() {
    const activePane = this.getActivePane();
    if (activePane != null) {
      activePane.destroy();
    }
  }
};
