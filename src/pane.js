const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const PaneAxis = require("./pane-axis");
const TextEditor = require("./text-editor");
const { createPaneElement } = require("./pane-element");

let nextInstanceId = 1;

// Thrown when a user cancels a save operation.
class SaveCancelledError extends Error {
  name = "SaveCancelledError";
}

// Thrown when a user cancels a save operation because of a buffer conflict.
class SaveConflictedError extends Error {
  name = "SaveConflictedError";
}

/**
 * A container for presenting content in the center of the workspace.
 * Panes can contain multiple items, one of which is *active* at a given time.
 * The view corresponding to the active item is displayed in the interface. In
 * the default configuration, tabs are also displayed for each item.
 *
 * Each pane may also contain one *pending* item. When a pending item is added
 * to a pane, it will replace the currently pending item, if any, instead of
 * simply being added. In the default configuration, the text in the tab for
 * pending items is shown in italics.
 *
 * @public
 * @api-status Extended
 */
module.exports = class Pane {
  inspect() {
    return `Pane ${this.id}`;
  }

  static deserialize(state, { deserializers, applicationDelegate, config, notifications, views }) {
    const { activeItemIndex } = state;
    const activeItemURI = state.activeItemURI || state.activeItemUri;

    const items = [];
    for (const itemState of state.items) {
      const item = deserializers.deserialize(itemState);
      if (item) items.push(item);
    }
    state.items = items;

    state.activeItem = items[activeItemIndex];
    if (!state.activeItem && activeItemURI) {
      state.activeItem = state.items.find(
        (item) => typeof item.getURI === "function" && item.getURI() === activeItemURI,
      );
    }

    return new Pane(
      Object.assign(
        {
          deserializerManager: deserializers,
          notificationManager: notifications,
          viewRegistry: views,
          config,
          applicationDelegate,
        },
        state,
      ),
    );
  }

  constructor(params = {}) {
    this.setPendingItem = this.setPendingItem.bind(this);
    this.getPendingItem = this.getPendingItem.bind(this);
    this.clearPendingItem = this.clearPendingItem.bind(this);
    this.togglePendingItem = this.togglePendingItem.bind(this);
    this.onItemDidTerminatePendingState = this.onItemDidTerminatePendingState.bind(this);
    this.onItemDidBecomePendingState = this.onItemDidBecomePendingState.bind(this);
    this.saveItem = this.saveItem.bind(this);
    this.saveItemAs = this.saveItemAs.bind(this);

    this.id = params.id;
    if (this.id != null) {
      nextInstanceId = Math.max(nextInstanceId, this.id + 1);
    } else {
      this.id = nextInstanceId++;
    }

    this.activeItem = params.activeItem;
    this.focused = params.focused != null ? params.focused : false;
    this.applicationDelegate = params.applicationDelegate;
    this.notificationManager = params.notificationManager;
    this.config = params.config;
    this.deserializerManager = params.deserializerManager;
    this.viewRegistry = params.viewRegistry;

    this.emitter = new Emitter();
    this.alive = true;
    this.subscriptionsPerItem = new WeakMap();
    this.pendingItemSubscription = null;
    this.items = [];
    this.itemStack = [];
    this.container = null;

    this.addItems((params.items || []).filter((item) => item));
    if (!this.getActiveItem()) this.setActiveItem(this.items[0]);
    this.addItemsToStack(params.itemStackIndices || []);
    this.setFlexScale(params.flexScale || 1);
  }

  getElement() {
    if (!this.element) {
      this.element = createPaneElement().initialize(this, {
        views: this.viewRegistry,
        applicationDelegate: this.applicationDelegate,
      });
    }
    return this.element;
  }

  serialize() {
    const itemsToBeSerialized = this.items.filter(
      (item) => item && typeof item.serialize === "function",
    );

    const itemStackIndices = [];
    for (const item of this.itemStack) {
      if (typeof item.serialize === "function") {
        itemStackIndices.push(itemsToBeSerialized.indexOf(item));
      }
    }

    const activeItemIndex = itemsToBeSerialized.indexOf(this.activeItem);

    return {
      deserializer: "Pane",
      id: this.id,
      items: itemsToBeSerialized.map((item) => item.serialize()),
      itemStackIndices,
      activeItemIndex,
      focused: this.focused,
      flexScale: this.flexScale,
    };
  }

  getParent() {
    return this.parent;
  }

  setParent(parent) {
    this.parent = parent;
  }

  getContainer() {
    return this.container;
  }

  setContainer(container) {
    if (container && container !== this.container) {
      this.container = container;
      container.didAddPane({ pane: this });
    }
  }

  /**
   * Determine whether the given item is allowed to exist in this pane.
   *
   * @param item - the Item
   * @returns {Boolean}
   * @private
   */
  isItemAllowed(item) {
    if (typeof item.getAllowedLocations !== "function") {
      return true;
    } else {
      return item.getAllowedLocations().includes(this.getContainer().getLocation());
    }
  }

  setFlexScale(flexScale) {
    this.flexScale = flexScale;
    this.emitter.emit("did-change-flex-scale", this.flexScale);
    return this.flexScale;
  }

  getFlexScale() {
    return this.flexScale;
  }

  increaseSize() {
    if (this.getContainer().getPanes().length > 1) {
      this.setFlexScale(this.getFlexScale() * 1.1);
    }
  }

  decreaseSize() {
    if (this.getContainer().getPanes().length > 1) {
      this.setFlexScale(this.getFlexScale() / 1.1);
    }
  }

  /**
   * @category Event Subscription
   */

  /**
   * Invoke the given callback when the pane resizes.
   *
   * The callback will be invoked when pane's `flexScale` property changes.
   * Use `getFlexScale` to get the current value.
   *
   * @param {Function} callback - to be called when the pane is resized.
   * @param {Number} callback.flexScale - representing the pane's `flex-grow`; ability for a flex item to grow if necessary.
   * @returns {Disposable} on which '.dispose()' can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidChangeFlexScale(callback) {
    return this.emitter.on("did-change-flex-scale", callback);
  }

  /**
   * Invoke the given callback with the current and future values of
   * `getFlexScale`.
   *
   * @param {Function} callback - to be called with the current and future values of the `getFlexScale` property.
   * @param {Number} callback.flexScale - representing the panes `flex-grow`; ability for a flex item to grow if necessary.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  observeFlexScale(callback) {
    callback(this.flexScale);
    return this.onDidChangeFlexScale(callback);
  }

  /**
   * Invoke the given callback when the pane is activated.
   *
   * The given callback will be invoked whenever {@link #activate} is called on the
   * pane, even if it is already active at the time.
   *
   * @param {Function} callback - to be called when the pane is activated.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidActivate(callback) {
    return this.emitter.on("did-activate", callback);
  }

  /**
   * Invoke the given callback before the pane is destroyed.
   *
   * @param {Function} callback - to be called before the pane is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onWillDestroy(callback) {
    return this.emitter.on("will-destroy", callback);
  }

  /**
   * Invoke the given callback when the pane is destroyed.
   *
   * @param {Function} callback - to be called when the pane is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * Invoke the given callback when the value of the {@link #isActive}
   * property changes.
   *
   * @param {Function} callback - to be called when the value of the {@link #isActive} property changes.
   * @param {Boolean} callback.active - indicating whether the pane is active.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidChangeActive(callback) {
    return this.container.onDidChangeActivePane((activePane) => {
      const isActive = this === activePane;
      callback(isActive);
    });
  }

  /**
   * Invoke the given callback with the current and future values of the
   * {@link #isActive} property.
   *
   * @param {Function} callback - to be called with the current and future values of the {@link #isActive} property.
   * @param {Boolean} callback.active - indicating whether the pane is active.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  observeActive(callback) {
    callback(this.isActive());
    return this.onDidChangeActive(callback);
  }

  /**
   * Invoke the given callback when an item is added to the pane.
   *
   * @param {Function} callback - to be called when items are added.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The added pane item.
   * @param {Number} callback.event.index - indicating where the item is located.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidAddItem(callback) {
    return this.emitter.on("did-add-item", callback);
  }

  /**
   * Invoke the given callback when an item is removed from the pane.
   *
   * @param {Function} callback - to be called when items are removed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The removed pane item.
   * @param {Number} callback.event.index - indicating where the item was located.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidRemoveItem(callback) {
    return this.emitter.on("did-remove-item", callback);
  }

  /**
   * Invoke the given callback before an item is removed from the pane.
   *
   * @param {Function} callback - to be called before items are removed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The pane item to be removed.
   * @param {Number} callback.event.index - indicating where the item is located.
   * @public
   * @api-status Public
   */
  onWillRemoveItem(callback) {
    return this.emitter.on("will-remove-item", callback);
  }

  /**
   * Invoke the given callback when an item is moved within the pane.
   *
   * @param {Function} callback - to be called when items are moved.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The removed pane item.
   * @param {Number} callback.event.oldIndex - indicating where the item was located.
   * @param {Number} callback.event.newIndex - indicating where the item is now located.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidMoveItem(callback) {
    return this.emitter.on("did-move-item", callback);
  }

  /**
   * Invoke the given callback with all current and future items.
   *
   * @param {Function} callback - to be called with current and future items.
   * @param callback.item - An item that is present in {@link #getItems} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  observeItems(callback) {
    for (let item of this.getItems()) {
      callback(item);
    }
    return this.onDidAddItem(({ item }) => callback(item));
  }

  /**
   * Invoke the given callback when the value of {@link #getActiveItem}
   * changes.
   *
   * @param {Function} callback - to be called when the active item changes.
   * @param callback.activeItem - The current active item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidChangeActiveItem(callback) {
    return this.emitter.on("did-change-active-item", callback);
  }

  /**
   * Invoke the given callback with the current and future values of
   * {@link #getActiveItem}.
   *
   * @param {Function} callback - to be called with the current and future active items.
   * @param callback.activeItem - The current active item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  observeActiveItem(callback) {
    callback(this.getActiveItem());
    return this.onDidChangeActiveItem(callback);
  }

  /**
   * Invoke the given callback before items are destroyed.
   *
   * @param {Function} callback - to be called before items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.item - The item that will be destroyed.
   * @param callback.event.index - The location of the item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onWillDestroyItem(callback) {
    return this.emitter.on("will-destroy-item", callback);
  }

  // Called by the view layer to indicate that the pane has gained focus.
  focus() {
    return this.activate();
  }

  // Called by the view layer to indicate that the pane has lost focus.
  blur() {
    this.focused = false;
    return true; // if this is called from an event handler, don't cancel it
  }

  isFocused() {
    return this.focused;
  }

  getPanes() {
    return [this];
  }

  unsubscribeFromItem(item) {
    const subscription = this.subscriptionsPerItem.get(item);
    if (subscription) {
      subscription.dispose();
      this.subscriptionsPerItem.delete(item);
    }
  }

  /**
   * @category Items
   */

  /**
   * Get the items in this pane.
   *
   * @returns {Array} of items.
   * @public
   * @api-status Public
   */
  getItems() {
    return this.items.slice();
  }

  /**
   * Get the active pane item in this pane.
   *
   * @returns {*} pane item.
   * @public
   * @api-status Public
   */
  getActiveItem() {
    return this.activeItem;
  }

  setActiveItem(activeItem, options) {
    const modifyStack = options && options.modifyStack;
    if (activeItem !== this.activeItem) {
      if (modifyStack !== false) this.addItemToStack(activeItem);
      this.activeItem = activeItem;
      this.emitter.emit("did-change-active-item", this.activeItem);
      if (this.container) this.container.didChangeActiveItemOnPane(this, this.activeItem);
    }
    return this.activeItem;
  }

  // Build the itemStack after deserializing
  addItemsToStack(itemStackIndices) {
    if (this.items.length > 0) {
      if (itemStackIndices.length !== this.items.length || itemStackIndices.includes(-1)) {
        itemStackIndices = this.items.map((item, i) => i);
      }

      for (let itemIndex of itemStackIndices) {
        this.addItemToStack(this.items[itemIndex]);
      }
    }
  }

  // Add item (or move item) to the end of the itemStack
  addItemToStack(newItem) {
    if (newItem == null) {
      return;
    }
    const index = this.itemStack.indexOf(newItem);
    if (index !== -1) this.itemStack.splice(index, 1);
    return this.itemStack.push(newItem);
  }

  // Return an {@link TextEditor} if the pane item is an {@link TextEditor}, or null otherwise.
  getActiveEditor() {
    if (this.activeItem instanceof TextEditor) return this.activeItem;
  }

  /**
   * @param {Number} index
   * @returns {*} The item at the index, or `null` when no item exists there.
   * @public
   * @api-status Public
   */
  itemAtIndex(index) {
    return this.items[index];
  }

  /**
   * Makes the next item in the itemStack active.
   *
   * @public
   * @api-status Public
   */
  activateNextRecentlyUsedItem() {
    if (this.items.length > 1) {
      if (this.itemStackIndex == null) this.itemStackIndex = this.itemStack.length - 1;
      if (this.itemStackIndex === 0) this.itemStackIndex = this.itemStack.length;
      this.itemStackIndex--;
      const nextRecentlyUsedItem = this.itemStack[this.itemStackIndex];
      this.setActiveItem(nextRecentlyUsedItem, { modifyStack: false });
    }
  }

  /**
   * Makes the previous item in the itemStack active.
   *
   * @public
   * @api-status Public
   */
  activatePreviousRecentlyUsedItem() {
    if (this.items.length > 1) {
      if (this.itemStackIndex + 1 === this.itemStack.length || this.itemStackIndex == null) {
        this.itemStackIndex = -1;
      }
      this.itemStackIndex++;
      const previousRecentlyUsedItem = this.itemStack[this.itemStackIndex];
      this.setActiveItem(previousRecentlyUsedItem, { modifyStack: false });
    }
  }

  /**
   * Moves the active item to the end of the item stack once a modifier
   * key (typically <kbd>Ctrl</kbd>) is lifted.
   *
   * @public
   * @api-status Public
   */
  moveActiveItemToTopOfStack() {
    delete this.itemStackIndex;
    this.addItemToStack(this.activeItem);
  }

  /**
   * Makes the next item active.
   *
   * @public
   * @api-status Public
   */
  activateNextItem() {
    const index = this.getActiveItemIndex();
    if (index < this.items.length - 1) {
      this.activateItemAtIndex(index + 1);
    } else {
      this.activateItemAtIndex(0);
    }
  }

  /**
   * Makes the previous item active.
   *
   * @public
   * @api-status Public
   */
  activatePreviousItem() {
    const index = this.getActiveItemIndex();
    if (index > 0) {
      this.activateItemAtIndex(index - 1);
    } else {
      this.activateItemAtIndex(this.items.length - 1);
    }
  }

  activateLastItem() {
    this.activateItemAtIndex(this.items.length - 1);
  }

  /**
   * Move the active tab to the right.
   *
   * @public
   * @api-status Public
   */
  moveItemRight() {
    const index = this.getActiveItemIndex();
    const rightItemIndex = index + 1;
    if (rightItemIndex <= this.items.length - 1)
      this.moveItem(this.getActiveItem(), rightItemIndex);
  }

  /**
   * Move the active tab to the left
   *
   * @public
   * @api-status Public
   */
  moveItemLeft() {
    const index = this.getActiveItemIndex();
    const leftItemIndex = index - 1;
    if (leftItemIndex >= 0) return this.moveItem(this.getActiveItem(), leftItemIndex);
  }

  /**
   * Get the index of the active item.
   *
   * @returns {Number}
   * @public
   * @api-status Public
   */
  getActiveItemIndex() {
    return this.items.indexOf(this.activeItem);
  }

  /**
   * Activate the item at the given index.
   *
   * @param {Number} index
   * @public
   * @api-status Public
   */
  activateItemAtIndex(index) {
    const item = this.itemAtIndex(index) || this.getActiveItem();
    return this.setActiveItem(item);
  }

  /**
   * Make the given item *active*, causing it to be displayed by
   * the pane's view.
   *
   * @param item - The item to activate
   * @param {Object} [options]
   * @param {Boolean} [options.pending] - indicating that the item should be added in a pending state if it does not yet exist in the pane. Existing pending items in a pane are replaced with new pending items when they are opened.
   * @public
   * @api-status Public
   */
  activateItem(item, options = {}) {
    if (item) {
      const index =
        this.getPendingItem() === this.activeItem
          ? this.getActiveItemIndex()
          : this.getActiveItemIndex() + 1;
      this.addItem(item, Object.assign({}, options, { index }));
      this.setActiveItem(item);
    }
  }

  /**
   * Add the given item to the pane.
   *
   * @param item - The item to add. It can be a model with an associated view or a view.
   * @param {Object} [options]
   * @param {Number} [options.index] - indicating the index at which to add the item. If omitted, the item is added after the current active item.
   * @param {Boolean} [options.pending] - indicating that the item should be added in a pending state. Existing pending items in a pane are replaced with new pending items when they are opened.
   * @returns {*} added item.
   * @public
   * @api-status Public
   */
  addItem(item, options = {}) {
    const index = options.index != null ? options.index : this.getActiveItemIndex() + 1;
    const moved = options.moved != null ? options.moved : false;
    const pending = options.pending != null ? options.pending : false;

    if (!item || typeof item !== "object") {
      throw new Error(`Pane items must be objects. Attempted to add item ${item}.`);
    }

    if (typeof item.isDestroyed === "function" && item.isDestroyed()) {
      throw new Error(
        `Adding a pane item with URI '${
          typeof item.getURI === "function" && item.getURI()
        }' that has already been destroyed`,
      );
    }

    if (this.items.includes(item)) return;

    const itemSubscriptions = new CompositeDisposable();
    this.subscriptionsPerItem.set(item, itemSubscriptions);
    if (typeof item.onDidDestroy === "function") {
      itemSubscriptions.add(item.onDidDestroy(() => this.removeItem(item, false)));
    }
    if (typeof item.onDidTerminatePendingState === "function") {
      itemSubscriptions.add(
        item.onDidTerminatePendingState(() => {
          if (this.getPendingItem() === item) this.clearPendingItem();
        }),
      );
    }

    this.items.splice(index, 0, item);
    const lastPendingItem = this.getPendingItem();
    const replacingPendingItem = lastPendingItem != null && !moved;
    if (replacingPendingItem) this.pendingItem = null;
    if (pending) this.setPendingItem(item);

    this.emitter.emit("did-add-item", { item, index, moved });
    if (!moved) {
      if (this.container) this.container.didAddPaneItem(item, this, index);
    }

    if (replacingPendingItem) this.destroyItem(lastPendingItem);
    if (!this.getActiveItem()) this.setActiveItem(item);
    return item;
  }

  setPendingItem(item) {
    if (this.pendingItem !== item) {
      const mostRecentPendingItem = this.pendingItem;
      if (this.pendingItemSubscription) {
        this.pendingItemSubscription.dispose();
        this.pendingItemSubscription = null;
      }
      this.pendingItem = item;
      if (mostRecentPendingItem) {
        this.emitter.emit("item-did-terminate-pending-state", mostRecentPendingItem);
      }
      if (item) {
        this.emitter.emit("item-did-become-pending-state", item);
      }
    }
  }

  getPendingItem() {
    return this.pendingItem || null;
  }

  clearPendingItem() {
    this.setPendingItem(null);
  }

  /**
   * Toggle the pending state of the active item.
   *
   * Clears the pending item if the active item is already pending, otherwise
   * marks the active item as pending. When marking an item pending, its
   * `onDidChange` is watched so that editing it clears the pending state, the
   * same way natively-previewed items behave. This is required because
   * `terminatePendingState` is one-shot: once an item has terminated it never
   * emits again, so a re-pended item could not otherwise clear itself.
   *
   * @public
   * @api-status Public
   */
  togglePendingItem() {
    const item = this.getActiveItem();
    if (!item) return;
    if (this.getPendingItem() === item) {
      this.clearPendingItem();
    } else {
      this.setPendingItem(item);
      if (typeof item.onDidChange === "function") {
        this.pendingItemSubscription = item.onDidChange(() => this.clearPendingItem());
      }
    }
  }

  onItemDidTerminatePendingState(callback) {
    return this.emitter.on("item-did-terminate-pending-state", callback);
  }

  onItemDidBecomePendingState(callback) {
    return this.emitter.on("item-did-become-pending-state", callback);
  }

  /**
   * Add the given items to the pane.
   *
   * @param items - An `Array` of items to add. Items can be views or models with associated views. Any objects that are already present in the pane's current items will not be added again.
   * @param {Number} [index] - index at which to add the items. If omitted, the item is #   added after the current active item.
   * @returns {Array} of added items.
   * @public
   * @api-status Public
   */
  addItems(items, index = this.getActiveItemIndex() + 1) {
    items = items.filter((item) => !this.items.includes(item));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      this.addItem(item, { index: index + i });
    }
    return items;
  }

  removeItem(item, moved) {
    const index = this.items.indexOf(item);
    if (index === -1) return;
    if (this.getPendingItem() === item) this.pendingItem = null;
    this.removeItemFromStack(item);
    this.emitter.emit("will-remove-item", {
      item,
      index,
      destroyed: !moved,
      moved,
    });
    this.unsubscribeFromItem(item);

    if (item === this.activeItem) {
      if (this.items.length === 1) {
        this.setActiveItem(undefined);
      } else if (index === 0) {
        this.activateNextItem();
      } else {
        this.activatePreviousItem();
      }
    }
    this.items.splice(index, 1);
    this.emitter.emit("did-remove-item", {
      item,
      index,
      destroyed: !moved,
      moved,
    });
    if (!moved && this.container) this.container.didDestroyPaneItem({ item, index, pane: this });
    if (this.items.length === 0 && this.config.get("core.destroyEmptyPanes")) this.destroy();
  }

  // Remove the given item from the itemStack.
  //
  // * `item` The item to remove.
  // * `index` `Number` indicating the index to which to remove the item from the itemStack.
  removeItemFromStack(item) {
    const index = this.itemStack.indexOf(item);
    if (index !== -1) this.itemStack.splice(index, 1);
  }

  /**
   * Move the given item to the given index.
   *
   * @param item - The item to move.
   * @param {Number} newIndex - indicating the index to which to move the item.
   * @public
   * @api-status Public
   */
  moveItem(item, newIndex) {
    const oldIndex = this.items.indexOf(item);
    this.items.splice(oldIndex, 1);
    this.items.splice(newIndex, 0, item);
    this.emitter.emit("did-move-item", { item, oldIndex, newIndex });
  }

  /**
   * Move the given item to the given index on another pane.
   *
   * @param item - The item to move.
   * @param {Pane} pane - to which to move the item.
   * @param {Number} index - indicating the index to which to move the item in the given pane.
   * @public
   * @api-status Public
   */
  moveItemToPane(item, pane, index) {
    this.removeItem(item, true);
    return pane.addItem(item, { index, moved: true });
  }

  /**
   * Destroy the active item and activate the next item.
   *
   * @returns {Promise} that resolves when the item is destroyed.
   * @public
   * @api-status Public
   */
  destroyActiveItem() {
    return this.destroyItem(this.activeItem);
  }

  /**
   * Destroy the given item.
   *
   * If the item is active, the next item will be activated. If the item is the
   * last item, the pane will be destroyed if the `core.destroyEmptyPanes` config
   * setting is `true`.
   *
   * This action can be prevented by onWillDestroyPaneItem callbacks in which
   * case nothing happens.
   *
   * @param item - Item to destroy
   * @param {Boolean} [force] - Destroy the item without prompting to save it, even if the item's `isPermanentDockItem` method returns true.
   * @returns {Promise} that resolves with a `Boolean` indicating whether or not the item was destroyed.
   * @public
   * @api-status Public
   */
  async destroyItem(item, force) {
    const index = this.items.indexOf(item);
    if (index === -1) return false;

    if (
      !force &&
      typeof item.isPermanentDockItem === "function" &&
      item.isPermanentDockItem() &&
      (!this.container || this.container.getLocation() !== "center")
    ) {
      return false;
    }

    // In the case where there are no `onWillDestroyPaneItem` listeners, preserve the old behavior
    // where `Pane.destroyItem` and callers such as `Pane.close` take effect synchronously.
    if (this.emitter.listenerCountForEventName("will-destroy-item") > 0) {
      await this.emitter.emitAsync("will-destroy-item", { item, index });
    }
    if (
      this.container &&
      this.container.emitter.listenerCountForEventName("will-destroy-pane-item") > 0
    ) {
      let preventClosing = false;
      await this.container.willDestroyPaneItem({
        item,
        index,
        pane: this,
        prevent: () => {
          preventClosing = true;
        },
      });
      if (preventClosing) return false;
    }

    if (!force && typeof item.shouldPromptToSave === "function" && item.shouldPromptToSave()) {
      if (!(await this.promptToSaveItem(item))) return false;
    }
    this.removeItem(item, false);
    if (typeof item.destroy === "function") item.destroy();
    return true;
  }

  /**
   * Destroy all items.
   *
   * @public
   * @api-status Public
   */
  destroyItems() {
    return Promise.all(this.getItems().map((item) => this.destroyItem(item)));
  }

  /**
   * Destroy all items except for the active item.
   *
   * @public
   * @api-status Public
   */
  destroyInactiveItems() {
    return Promise.all(
      this.getItems()
        .filter((item) => item !== this.activeItem)
        .map((item) => this.destroyItem(item)),
    );
  }

  // Prompt the user about an item's conflicted state during an attempt to
  // save. The user must decide whether to cancel the attempted save… or force
  // it and overwrite what's on disk.
  //
  // Resolves with boolean `true` when a save can proceed… or rejects with an
  // error when the save is aborted.
  async promptOnSaveConflictedFile(item) {
    // Don't prompt if the user hasn't opted into it.
    if (!lumine.config.get("core.promptOnSaveConflictedFile")) return true;

    // Ensure the item implements an `isInConflict` method, and that it
    // returns `true`.
    if (!item.isInConflict?.()) {
      return true;
    }
    // Figure out how to describe the buffer in the dialog.
    const uri = item.getURI?.() ?? item.getUri?.() ?? null;
    const title = (typeof item.getTitle === "function" && item.getTitle()) || uri;

    const response = await this.applicationDelegate.confirm({
      message: `'${title}' has changed on disk. Do you want to overwrite this file with your changes?`,
      detail: "The contents of the buffer may be stale.",

      // TODO: Individual pane items may have additional strategies to
      // contribute (e.g., conflict resolution view). Implement a way for
      // them to contribute buttons to this dialog — and to handle them in
      // the callback below.
      buttons: ["Overwrite", "Cancel"],
    });
    if (response === 0) return true;
    throw new SaveConflictedError("Save cancelled due to conflict");
  }

  promptToSaveItem(item, options = {}) {
    return new Promise((resolve, reject) => {
      if (typeof item.shouldPromptToSave !== "function" || !item.shouldPromptToSave(options)) {
        return resolve(true);
      }

      let uri;
      if (typeof item.getURI === "function") {
        uri = item.getURI();
      } else if (typeof item.getUri === "function") {
        uri = item.getUri();
      } else {
        return resolve(true);
      }

      const title = (typeof item.getTitle === "function" && item.getTitle()) || uri;

      const saveDialog = (saveButtonText, saveFn, message) => {
        this.applicationDelegate
          .confirm({
            message,
            detail: "Your changes will be lost if you close this item without saving.",
            buttons: [saveButtonText, "Cancel", "&Don't Save"],
          })
          .then((response) => {
            switch (response) {
              case 0:
                return saveFn(item, (error) => {
                  if (error instanceof SaveCancelledError) {
                    resolve(false);
                  } else if (error) {
                    saveDialog(
                      "Save as",
                      this.saveItemAs,
                      `'${title}' could not be saved.\nError: ${this.getMessageForErrorCode(
                        error.code,
                      )}`,
                    );
                  } else {
                    resolve(true);
                  }
                });
              case 1:
                return resolve(false);
              case 2:
                return resolve(true);
            }
          })
          .catch(reject);
      };

      // A buffer whose file was deleted on disk (while it still had unsaved
      // changes) gets a clearer, more accurate message than the generic
      // "has changes" prompt.
      const deleted = typeof item.isDeleted === "function" && item.isDeleted();
      const message = deleted
        ? `'${title}' was deleted on disk. Do you still want to save this file?`
        : `'${title}' has changes, do you want to save them?`;

      saveDialog("Save", this.saveItem, message);
    });
  }

  /**
   * Save the active item.
   *
   * @public
   * @api-status Public
   */
  saveActiveItem(nextAction) {
    return this.saveItem(this.getActiveItem(), nextAction);
  }

  /**
   * Prompt the user for a location and save the active item with the
   * path they select.
   *
   * @param {Function} [nextAction] - which will be called after the item is successfully saved.
   * @returns {Promise} that resolves when the save is complete
   * @public
   * @api-status Public
   */
  saveActiveItemAs(nextAction) {
    return this.saveItemAs(this.getActiveItem(), nextAction);
  }

  /**
   * Save the given item.
   *
   * @param item - The item to save.
   * @param {Function} [nextAction] - which will be called with no argument after the item is successfully saved, or with the error if it failed. The return value will be that of `nextAction` or `undefined` if it was not provided.
   * @returns {Promise} that resolves when the save is complete, or rejects if the save could not be completed.
   * @public
   * @api-status Public
   */
  saveItem(item, nextAction) {
    if (!item) return Promise.resolve();

    let itemURI;
    if (typeof item.getURI === "function") {
      itemURI = item.getURI();
    } else if (typeof item.getUri === "function") {
      itemURI = item.getUri();
    }

    if (itemURI != null) {
      if (typeof item.save === "function") {
        // If `isInConflict` is implemented, we call it first to figure out if
        // it's safe to attempt to save.
        let conflicted = item.isInConflict?.();

        // If the item is conflicted, we'll show a dialog in order to decide
        // how to proceed. The user may choose to overwrite (force the save) or
        // cancel.
        let preface = () => promisify(() => item.save());
        if (conflicted && lumine.config.get("core.promptOnSaveConflictedFile")) {
          preface = () => {
            return this.promptOnSaveConflictedFile(item).then(() => item.save());
          };
        }

        return preface()
          .then(() => {
            if (nextAction) nextAction();
          })
          .catch((error) => {
            if (nextAction) {
              nextAction(error);
            } else {
              this.handleSaveError(error, item);
            }
            // Re-propagate cancellation errors so callers know the save was
            // aborted. Other errors are already handled by
            // handleSaveError/nextAction above.
            if (error instanceof SaveCancelledError || error instanceof SaveConflictedError) {
              return Promise.reject(error);
            }
          });
      } else if (nextAction) {
        // Don't check if this item is in conflict; if it can't be saved,
        // there's no hazard.
        nextAction();
        return Promise.resolve();
      }
    } else {
      // The file has not been committed to disk, so there's no conflict
      // hazard.
      return this.saveItemAs(item, nextAction);
    }
  }

  /**
   * Prompt the user for a location and save the active item with the
   * path they select.
   *
   * @param item - The item to save.
   * @param {Function} [nextAction] - which will be called with no argument after the item is successfully saved, or with the error if it failed. The return value will be that of `nextAction` or `undefined` if it was not provided.
   * @public
   * @api-status Public
   */
  async saveItemAs(item, nextAction) {
    if (!item) return;
    if (typeof item.saveAs !== "function") return;

    const saveOptions =
      typeof item.getSaveDialogOptions === "function" ? item.getSaveDialogOptions() : {};

    const itemPath = item.getPath();
    if (itemPath && !saveOptions.defaultPath) saveOptions.defaultPath = itemPath;

    const { filePath: newItemPath } = await this.applicationDelegate.showSaveDialog(saveOptions);
    if (!newItemPath) {
      return nextAction ? nextAction(new SaveCancelledError("Save Cancelled")) : undefined;
    }

    try {
      await promisify(() => item.saveAs(newItemPath));
      return nextAction ? nextAction() : undefined;
    } catch (error) {
      if (nextAction) return nextAction(error);
      this.handleSaveError(error, item);
    }
  }

  /**
   * Save all modified items in this pane.
   *
   * @returns {Promise} that resolves when all items have been saved.
   * @public
   * @api-status Public
   */
  async saveItems() {
    const promises = [];
    for (let item of this.getItems()) {
      if (typeof item.isModified === "function" && item.isModified()) {
        promises.push(this.saveItem(item));
      }
    }
    return await Promise.all(promises);
  }

  /**
   * @param {String} uri - containing a URI.
   * @returns {*|undefined} first item that matches the given URI or undefined if none exists.
   * @public
   * @api-status Public
   */
  itemForURI(uri) {
    return this.items.find((item) => {
      if (typeof item.getURI === "function") {
        return item.getURI() === uri;
      } else if (typeof item.getUri === "function") {
        return item.getUri() === uri;
      }
    });
  }

  /**
   * Activate the first item that matches the given URI.
   *
   * @param {String} uri - containing a URI.
   * @returns {Boolean} indicating whether an item matching the URI was found.
   * @public
   * @api-status Public
   */
  activateItemForURI(uri) {
    const item = this.itemForURI(uri);
    if (item) {
      this.activateItem(item);
      return true;
    } else {
      return false;
    }
  }

  copyActiveItem() {
    if (this.activeItem && typeof this.activeItem.copy === "function") {
      return this.activeItem.copy();
    }
  }

  /**
   * @category Lifecycle
   */

  /**
   * Determine whether the pane is active.
   *
   * @returns {Boolean}
   * @public
   * @api-status Public
   */
  isActive() {
    return this.container && this.container.getActivePane() === this;
  }

  /**
   * Makes this pane the *active* pane, causing it to gain focus.
   *
   * @public
   * @api-status Public
   */
  activate() {
    if (this.isDestroyed()) throw new Error("Pane has been destroyed");
    this.focused = true;

    if (this.container) this.container.didActivatePane(this);
    this.emitter.emit("did-activate");
  }

  /**
   * Close the pane and destroy all its items.
   *
   * If this is the last pane, all the items will be destroyed but the pane
   * itself will not be destroyed.
   *
   * @public
   * @api-status Public
   */
  destroy() {
    if (this.container && this.container.isAlive() && this.container.getPanes().length === 1) {
      return this.destroyItems();
    }

    this.emitter.emit("will-destroy");
    this.alive = false;
    if (this.pendingItemSubscription) {
      this.pendingItemSubscription.dispose();
      this.pendingItemSubscription = null;
    }
    if (this.container) {
      this.container.willDestroyPane({ pane: this });
      if (this.isActive()) this.container.activateNextPane();
    }
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
    for (let item of this.items.slice()) {
      if (typeof item.destroy === "function") item.destroy();
    }
    if (this.container) this.container.didDestroyPane({ pane: this });
  }

  isAlive() {
    return this.alive;
  }

  /**
   * Determine whether this pane has been destroyed.
   *
   * @returns {Boolean}
   * @public
   * @api-status Public
   */
  isDestroyed() {
    return !this.isAlive();
  }

  /**
   * @category Splitting
   */

  /**
   * Create a new pane to the left of this pane.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.copyActiveItem] - true will copy the active item into the new split pane
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   * @public
   * @api-status Public
   */
  splitLeft(params) {
    return this.split("horizontal", "before", params);
  }

  /**
   * Create a new pane to the right of this pane.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.copyActiveItem] - true will copy the active item into the new split pane
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   * @public
   * @api-status Public
   */
  splitRight(params) {
    return this.split("horizontal", "after", params);
  }

  /**
   * Creates a new pane above the receiver.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.copyActiveItem] - true will copy the active item into the new split pane
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   * @public
   * @api-status Public
   */
  splitUp(params) {
    return this.split("vertical", "before", params);
  }

  /**
   * Creates a new pane below the receiver.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.copyActiveItem] - true will copy the active item into the new split pane
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   * @public
   * @api-status Public
   */
  splitDown(params) {
    return this.split("vertical", "after", params);
  }

  split(orientation, side, params) {
    if (params && params.copyActiveItem) {
      if (!params.items) params.items = [];
      params.items.push(this.copyActiveItem());
    }

    if (this.parent.orientation !== orientation) {
      this.parent.replaceChild(
        this,
        new PaneAxis(
          {
            container: this.container,
            orientation,
            children: [this],
            flexScale: this.flexScale,
          },
          this.viewRegistry,
        ),
      );
      this.setFlexScale(1);
    }

    const newPane = new Pane(
      Object.assign(
        {
          applicationDelegate: this.applicationDelegate,
          notificationManager: this.notificationManager,
          deserializerManager: this.deserializerManager,
          config: this.config,
          viewRegistry: this.viewRegistry,
        },
        params,
      ),
    );

    switch (side) {
      case "before":
        this.parent.insertChildBefore(this, newPane);
        break;
      case "after":
        this.parent.insertChildAfter(this, newPane);
        break;
    }

    if (params && params.moveActiveItem && this.activeItem)
      this.moveItemToPane(this.activeItem, newPane);

    if (!params || params.activate !== false) {
      newPane.activate();
    }
    return newPane;
  }

  // If the parent is a horizontal axis, returns its first child if it is a pane;
  // otherwise returns this pane.
  findLeftmostSibling() {
    if (this.parent.orientation === "horizontal") {
      const [leftmostSibling] = this.parent.children;
      if (leftmostSibling instanceof PaneAxis) {
        return this;
      } else {
        return leftmostSibling;
      }
    } else {
      return this;
    }
  }

  findRightmostSibling() {
    if (this.parent.orientation === "horizontal") {
      const rightmostSibling = this.parent.children[this.parent.children.length - 1];
      if (rightmostSibling instanceof PaneAxis) {
        return this;
      } else {
        return rightmostSibling;
      }
    } else {
      return this;
    }
  }

  // If the parent is a horizontal axis, returns its last child if it is a pane;
  // otherwise returns a new pane created by splitting this pane rightward.
  findOrCreateRightmostSibling(params) {
    const rightmostSibling = this.findRightmostSibling();
    if (rightmostSibling === this) {
      return this.splitRight(params);
    } else {
      return rightmostSibling;
    }
  }

  // If the parent is a vertical axis, returns its first child if it is a pane;
  // otherwise returns this pane.
  findTopmostSibling() {
    if (this.parent.orientation === "vertical") {
      const [topmostSibling] = this.parent.children;
      if (topmostSibling instanceof PaneAxis) {
        return this;
      } else {
        return topmostSibling;
      }
    } else {
      return this;
    }
  }

  findBottommostSibling() {
    if (this.parent.orientation === "vertical") {
      const bottommostSibling = this.parent.children[this.parent.children.length - 1];
      if (bottommostSibling instanceof PaneAxis) {
        return this;
      } else {
        return bottommostSibling;
      }
    } else {
      return this;
    }
  }

  // If the parent is a vertical axis, returns its last child if it is a pane;
  // otherwise returns a new pane created by splitting this pane bottomward.
  findOrCreateBottommostSibling(params) {
    const bottommostSibling = this.findBottommostSibling();
    if (bottommostSibling === this) {
      return this.splitDown(params);
    } else {
      return bottommostSibling;
    }
  }

  /**
   * Close the pane unless the user cancels the action via a dialog.
   *
   * @returns {Promise} that resolves once the pane is either closed, or the closing has been cancelled.
   * @private
   */
  close() {
    return Promise.all(this.getItems().map((item) => this.promptToSaveItem(item))).then(
      (results) => {
        if (!results.includes(false)) return this.destroy();
      },
    );
  }

  handleSaveError(error, item) {
    const itemPath = error.path || (typeof item.getPath === "function" && item.getPath());
    const addWarningWithPath = (message, options) => {
      if (itemPath) message = `${message} '${itemPath}'`;
      this.notificationManager.addWarning(message, options);
    };

    const customMessage = this.getMessageForErrorCode(error.code);
    if (customMessage != null) {
      addWarningWithPath(`Unable to save file: ${customMessage}`);
    } else if (
      error.code === "EISDIR" ||
      (error.message && error.message.endsWith("is a directory"))
    ) {
      return this.notificationManager.addWarning(`Unable to save file: ${error.message}`);
    } else if (["EPERM", "EBUSY", "UNKNOWN", "EEXIST", "ELOOP", "EAGAIN"].includes(error.code)) {
      addWarningWithPath("Unable to save file", { detail: error.message });
    } else {
      const errorMatch = /ENOTDIR, not a directory '([^']+)'/.exec(error.message);
      if (errorMatch) {
        const fileName = errorMatch[1];
        this.notificationManager.addWarning(
          `Unable to save file: A directory in the path '${fileName}' could not be written to`,
        );
      } else {
        throw error;
      }
    }
  }

  getMessageForErrorCode(errorCode) {
    switch (errorCode) {
      case "EACCES":
        return "Permission denied";
      case "ECONNRESET":
        return "Connection reset";
      case "EINTR":
        return "Interrupted system call";
      case "EIO":
        return "I/O error writing file";
      case "ENOSPC":
        return "No space left on device";
      case "ENOTSUP":
        return "Operation not supported on socket";
      case "ENXIO":
        return "No such device or address";
      case "EROFS":
        return "Read-only file system";
      case "ESPIPE":
        return "Invalid seek";
      case "ETIMEDOUT":
        return "Connection timed out";
    }
  }
};

function promisify(callback) {
  try {
    return Promise.resolve(callback());
  } catch (error) {
    return Promise.reject(error);
  }
}
