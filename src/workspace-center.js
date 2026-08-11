"use strict";

const TextEditor = require("./text-editor");
const PaneContainer = require("./pane-container");

/**
 * Represents the workspace at the center of the entire window.
 *
 * @public
 * @api-status Essential
 */
module.exports = class WorkspaceCenter {
  constructor(params) {
    params.location = "center";
    this.paneContainer = new PaneContainer(params);
    this.didActivate = params.didActivate;
    this.paneContainer.onDidActivatePane(() => this.didActivate(this));
    this.paneContainer.onDidChangeActivePane((pane) => {
      params.didChangeActivePane(this, pane);
    });
    this.paneContainer.onDidChangeActivePaneItem((item) => {
      params.didChangeActivePaneItem(this, item);
    });
    this.paneContainer.onDidDestroyPaneItem((item) => params.didDestroyPaneItem(item));
  }

  destroy() {
    this.paneContainer.destroy();
  }

  serialize() {
    return this.paneContainer.serialize();
  }

  deserialize(state, deserializerManager) {
    this.paneContainer.deserialize(state, deserializerManager);
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
   * Invoke the given callback with all current and future text
   * editors in the workspace center.
   *
   * @param {Function} callback - to be called with current and future text editors.
   * @param callback.editor - An {@link TextEditor} that is present in {@link #getTextEditors} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  observeTextEditors(callback) {
    for (let textEditor of this.getTextEditors()) {
      callback(textEditor);
    }
    return this.onDidAddTextEditor(({ textEditor }) => callback(textEditor));
  }

  /**
   * Invoke the given callback with all current and future panes items
   * in the workspace center.
   *
   * @param {Function} callback - to be called with current and future pane items.
   * @param callback.item - An item that is present in {@link #getPaneItems} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  observePaneItems(callback) {
    return this.paneContainer.observePaneItems(callback);
  }

  /**
   * Invoke the given callback when the active pane item changes.
   *
   * Because observers are invoked synchronously, it's important not to perform
   * any expensive operations via this method. Consider
   * {@link #onDidStopChangingActivePaneItem} to delay operations until after changes
   * stop occurring.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  onDidChangeActivePaneItem(callback) {
    return this.paneContainer.onDidChangeActivePaneItem(callback);
  }

  /**
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
   * @param callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  onDidStopChangingActivePaneItem(callback) {
    return this.paneContainer.onDidStopChangingActivePaneItem(callback);
  }

  /**
   * Invoke the given callback with the current active pane item and
   * with all future active pane items in the workspace center.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param callback.item - The current active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  observeActivePaneItem(callback) {
    return this.paneContainer.observeActivePaneItem(callback);
  }

  /**
   * Invoke the given callback when a pane is added to the workspace
   * center.
   *
   * @param {Function} callback - to be called when panes are added.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.pane - The added pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onDidAddPane(callback) {
    return this.paneContainer.onDidAddPane(callback);
  }

  /**
   * Invoke the given callback before a pane is destroyed in the
   * workspace center.
   *
   * @param {Function} callback - to be called before panes are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.pane - The pane to be destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onWillDestroyPane(callback) {
    return this.paneContainer.onWillDestroyPane(callback);
  }

  /**
   * Invoke the given callback when a pane is destroyed in the
   * workspace center.
   *
   * @param {Function} callback - to be called when panes are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.pane - The destroyed pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onDidDestroyPane(callback) {
    return this.paneContainer.onDidDestroyPane(callback);
  }

  /**
   * Invoke the given callback with all current and future panes in the
   * workspace center.
   *
   * @param {Function} callback - to be called with current and future panes.
   * @param callback.pane - A {@link Pane} that is present in {@link #getPanes} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  observePanes(callback) {
    return this.paneContainer.observePanes(callback);
  }

  /**
   * Invoke the given callback when the active pane changes.
   *
   * @param {Function} callback - to be called when the active pane changes.
   * @param callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onDidChangeActivePane(callback) {
    return this.paneContainer.onDidChangeActivePane(callback);
  }

  /**
   * Invoke the given callback with the current active pane and when
   * the active pane changes.
   *
   * @param {Function} callback - to be called with the current and future active panes.
   * @param callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  observeActivePane(callback) {
    return this.paneContainer.observeActivePane(callback);
  }

  /**
   * Invoke the given callback when a pane item is added to the
   * workspace center.
   *
   * @param {Function} callback - to be called when pane items are added.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The added pane item.
   * @param {Pane} callback.event.pane - containing the added item.
   * @param {Number} callback.event.index - indicating the index of the added item in its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onDidAddPaneItem(callback) {
    return this.paneContainer.onDidAddPaneItem(callback);
  }

  /**
   * Invoke the given callback when a pane item is about to be
   * destroyed, before the user is prompted to save it.
   *
   * @param {Function} callback - to be called before pane items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The item to be destroyed.
   * @param {Pane} callback.event.pane - containing the item to be destroyed.
   * @param {Number} callback.event.index - indicating the index of the item to be destroyed in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onWillDestroyPaneItem(callback) {
    return this.paneContainer.onWillDestroyPaneItem(callback);
  }

  /**
   * Invoke the given callback when a pane item is destroyed.
   *
   * @param {Function} callback - to be called when pane items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The destroyed item.
   * @param {Pane} callback.event.pane - containing the destroyed item.
   * @param {Number} callback.event.index - indicating the index of the destroyed item in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onDidDestroyPaneItem(callback) {
    return this.paneContainer.onDidDestroyPaneItem(callback);
  }

  /**
   * Invoke the given callback when a text editor is added to the
   * workspace center.
   *
   * @param {Function} callback - to be called when panes are added.
   * @param {Object} callback.event - with the following keys:
   * @param {TextEditor} callback.event.textEditor - that was added.
   * @param {Pane} callback.event.pane - containing the added text editor.
   * @param {Number} callback.event.index - indicating the index of the added text editor in its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
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
   * Get all pane items in the workspace center.
   *
   * @returns {Array} of items.
   * @public
   * @api-status Essential
   */
  getPaneItems() {
    return this.paneContainer.getPaneItems();
  }

  /**
   * Get the active {@link Pane}'s active item.
   *
   * @returns {Object} pane item `Object`.
   * @public
   * @api-status Essential
   */
  getActivePaneItem() {
    return this.paneContainer.getActivePaneItem();
  }

  /**
   * Get all text editors in the workspace center.
   *
   * @returns {Array} of {@link TextEditor TextEditors}.
   * @public
   * @api-status Essential
   */
  getTextEditors() {
    return this.getPaneItems().filter((item) => item instanceof TextEditor);
  }

  /**
   * Get the active item if it is an {@link TextEditor}.
   *
   * @returns {TextEditor} or `undefined` if the current active item is not an {@link TextEditor}.
   * @public
   * @api-status Essential
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
   * Get all panes in the workspace center.
   *
   * @returns {Array} of {@link Pane Panes}.
   * @public
   * @api-status Extended
   */
  getPanes() {
    return this.paneContainer.getPanes();
  }

  /**
   * Get the active {@link Pane}.
   *
   * @returns {Pane}
   * @public
   * @api-status Extended
   */
  getActivePane() {
    return this.paneContainer.getActivePane();
  }

  /**
   * Make the next pane active.
   *
   * @public
   * @api-status Extended
   */
  activateNextPane() {
    return this.paneContainer.activateNextPane();
  }

  /**
   * Make the previous pane active.
   *
   * @public
   * @api-status Extended
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
