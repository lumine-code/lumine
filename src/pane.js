const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const PaneAxis = require("./pane-axis");
const TextEditor = require("./text-editor");
const { createPaneElement } = require("./pane-element");
const { isItemAllowedInLocation } = require("./pane-item-locations");
const {
  SaveCancelledError,
  SaveConflictedError,
  isSaveCancellationError,
} = require("./save-errors");
const {
  PaneItemOperationError,
  assertCenterItemContract,
  assertItemLocation,
} = require("./pane-item-contract");

let nextInstanceId = 1;

/**
 * @public
 * @status extended
 *
 * A container for presenting content in the center of the workspace.
 * Panes can contain multiple items, one of which is *active* at a given time.
 * The view corresponding to the active item is displayed in the interface. In
 * the default configuration, tabs are also displayed for each item.
 *
 * Each pane may also contain one *pending* item. When a pending item is added
 * to a pane, it will replace the currently pending item, if any, instead of
 * simply being added. In the default configuration, the text in the tab for
 * pending items is shown in italics.
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
    this.emptyPaneHoldCount = 0;
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

  setContainer(container, { transferred = false } = {}) {
    if (container && container !== this.container) {
      if (transferred) {
        const previous = this.container;
        if (!previous || previous.workspace !== container.workspace) {
          throw new Error("A pane transfer must stay within its owning workspace.");
        }
        for (const item of this.items) assertItemLocation(item, container.getLocation());
        for (const item of this.items) {
          if (!previous.itemRegistry.hasItem(item) || container.itemRegistry.hasItem(item)) {
            throw new Error("A pane transfer requires exclusive item ownership.");
          }
        }
        for (const item of this.items) {
          previous.itemRegistry.removeItem(item);
          container.itemRegistry.addItem(item);
        }
        previous.paneActivationOrder.delete(this);
        this.container = container;
        container.didAddPane({ pane: this, transferred: true });
        this.emitter.emit("did-change-container", {
          oldContainer: previous,
          newContainer: container,
        });
        return;
      }
      container.itemRegistry.assertItemsAvailable(this.items);
      container.globalItemRegistry?.assertItemsAvailable(this.items);
      for (const item of this.items) {
        assertItemLocation(item, container.getLocation());
        container.assertItemAvailable(item, this);
      }
      const previous = this.container;
      this.container = container;
      container.didAddPane({ pane: this });
      this.emitter.emit("did-change-container", {
        oldContainer: previous,
        newContainer: container,
      });
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
    return isItemAllowedInLocation(item, this.getContainer()?.getLocation() || "center");
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
   * @public
   * @status public
   *
   * Invoke the given callback when the pane resizes.
   *
   * The callback will be invoked when pane's `flexScale` property changes.
   * Use `getFlexScale` to get the current value.
   *
   * @param {Function} callback - to be called when the pane is resized.
   * @param {Number} callback.flexScale - representing the pane's `flex-grow`; ability for a flex item to grow if necessary.
   * @returns {Disposable} on which '.dispose()' can be called to unsubscribe.
   */
  onDidChangeFlexScale(callback) {
    return this.emitter.on("did-change-flex-scale", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback with the current and future values of
   * `getFlexScale`.
   *
   * @param {Function} callback - to be called with the current and future values of the `getFlexScale` property.
   * @param {Number} callback.flexScale - representing the panes `flex-grow`; ability for a flex item to grow if necessary.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeFlexScale(callback) {
    callback(this.flexScale);
    return this.onDidChangeFlexScale(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the pane is activated.
   *
   * The given callback will be invoked whenever {@link #activate} is called on the
   * pane, even if it is already active at the time.
   *
   * @param {Function} callback - to be called when the pane is activated.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidActivate(callback) {
    return this.emitter.on("did-activate", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback before the pane is destroyed.
   *
   * @param {Function} callback - to be called before the pane is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillDestroy(callback) {
    return this.emitter.on("will-destroy", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the pane is destroyed.
   *
   * @param {Function} callback - to be called when the pane is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the value of the {@link #isActive}
   * property changes.
   *
   * @param {Function} callback - to be called when the value of the {@link #isActive} property changes.
   * @param {Boolean} callback.active - indicating whether the pane is active.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActive(callback) {
    let subscription;
    const subscriptions = new CompositeDisposable();
    const bind = () => {
      if (subscription) {
        subscriptions.remove(subscription);
        subscription.dispose();
      }
      subscription = this.container.onDidChangeActivePane((activePane) =>
        callback(this === activePane),
      );
      subscriptions.add(subscription);
    };
    bind();
    subscriptions.add(this.emitter.on("did-change-container", bind));
    return subscriptions;
  }

  /**
   * @public
   * @status public
   *
   * Observe a change of presentation window while retaining this pane.
   * @param {Function} callback - Receives sourceWindow and targetWindow.
   * @returns {Disposable} Removes the observation.
   */
  onDidChangeWindow(callback) {
    return this.emitter.on("did-change-window", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback with the current and future values of the
   * {@link #isActive} property.
   *
   * @param {Function} callback - to be called with the current and future values of the {@link #isActive} property.
   * @param {Boolean} callback.active - indicating whether the pane is active.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActive(callback) {
    callback(this.isActive());
    return this.onDidChangeActive(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when an item is added to the pane.
   *
   * @param {Function} callback - to be called when items are added.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The added pane item.
   * @param {Number} callback.event.index - indicating where the item is located.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddItem(callback) {
    return this.emitter.on("did-add-item", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when an item is removed from the pane.
   *
   * @param {Function} callback - to be called when items are removed.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The removed pane item.
   * @param {Number} callback.event.index - indicating where the item was located.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidRemoveItem(callback) {
    return this.emitter.on("did-remove-item", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback before an item is removed from the pane.
   *
   * @param {Function} callback - to be called before items are removed.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The pane item to be removed.
   * @param {Number} callback.event.index - indicating where the item is located.
   */
  onWillRemoveItem(callback) {
    return this.emitter.on("will-remove-item", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when an item is moved within the pane.
   *
   * @param {Function} callback - to be called when items are moved.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The removed pane item.
   * @param {Number} callback.event.oldIndex - indicating where the item was located.
   * @param {Number} callback.event.newIndex - indicating where the item is now located.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidMoveItem(callback) {
    return this.emitter.on("did-move-item", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback with all current and future items.
   *
   * @param {Function} callback - to be called with current and future items.
   * @param {*} callback.item - An item that is present in {@link #getItems} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeItems(callback) {
    for (let item of this.getItems()) {
      callback(item);
    }
    return this.onDidAddItem(({ item }) => callback(item));
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the value of {@link #getActiveItem}
   * changes.
   *
   * @param {Function} callback - to be called when the active item changes.
   * @param {*} callback.activeItem - The current active item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActiveItem(callback) {
    return this.emitter.on("did-change-active-item", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback with the current and future values of
   * {@link #getActiveItem}.
   *
   * @param {Function} callback - to be called with the current and future active items.
   * @param {*} callback.activeItem - The current active item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActiveItem(callback) {
    callback(this.getActiveItem());
    return this.onDidChangeActiveItem(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback before items are destroyed.
   *
   * @param {Function} callback - to be called before items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The item that will be destroyed.
   * @param {Number} callback.event.index - The location of the item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
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
   * @public
   * @status public
   *
   * Get the items in this pane.
   *
   * @returns {Array} of items.
   */
  getItems() {
    return this.items.slice();
  }

  /**
   * @public
   * @status public
   *
   * Get the active pane item in this pane.
   *
   * @returns {*} pane item.
   */
  getActiveItem() {
    return this.activeItem;
  }

  setActiveItem(activeItem, options) {
    const modifyStack = options && options.modifyStack;
    if (activeItem !== this.activeItem) {
      this.container?.enlistInActiveStateTransaction();
      if (modifyStack !== false) this.addItemToStack(activeItem);
      this.activeItem = activeItem;
      this.emitter.emit("did-change-active-item", this.activeItem);
      if (this.container) this.container.didChangeActiveItemOnPane(this, this.activeItem);
    }
    return this.activeItem;
  }

  /**
   * @public
   * @status extended
   *
   * Apply a synchronous group of pane changes and notify workspace observers
   * once with the final active pane and item. Changes and pane-local view
   * events remain synchronous. Nested transactions and other containers touched
   * by the callback share the outer operation. Only its final activation request
   * is published, before the other containers report their final items.
   *
   * @param {Function} callback - synchronous work to perform; async callbacks and Promise return values are rejected. A thrown error still commits notifications for changes already made and clears the transaction.
   * @returns {*} the callback's return value.
   * @category Activation
   */
  transactActiveState(callback) {
    if (this.container) return this.container.transactActiveState(callback);
    if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
      throw new TypeError("Active pane transactions require a synchronous callback");
    }
    const result = callback();
    if (result && typeof result.then === "function") {
      throw new TypeError("Active pane transactions cannot return a Promise");
    }
    return result;
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
   * @public
   * @status public
   *
   * Get the item at a zero-based tab index.
   *
   * @param {Number} index
   * @returns {*} The item at the index, or `undefined` when no item exists there.
   */
  itemAtIndex(index) {
    return this.items[index];
  }

  /**
   * @public
   * @status public
   *
   * Makes the next item in the itemStack active.
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
   * @public
   * @status public
   *
   * Makes the previous item in the itemStack active.
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
   * @public
   * @status public
   *
   * Moves the active item to the end of the item stack once a modifier
   * key (typically <kbd>Ctrl</kbd>) is lifted.
   */
  moveActiveItemToTopOfStack() {
    delete this.itemStackIndex;
    this.addItemToStack(this.activeItem);
  }

  /**
   * @public
   * @status public
   *
   * Makes the next item active.
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
   * @public
   * @status public
   *
   * Makes the previous item active.
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
   * @public
   * @status public
   *
   * Move the active tab to the right.
   */
  moveItemRight() {
    const index = this.getActiveItemIndex();
    const rightItemIndex = index + 1;
    if (rightItemIndex <= this.items.length - 1)
      this.moveItem(this.getActiveItem(), rightItemIndex);
  }

  /**
   * @public
   * @status public
   *
   * Move the active tab to the left
   */
  moveItemLeft() {
    const index = this.getActiveItemIndex();
    const leftItemIndex = index - 1;
    if (leftItemIndex >= 0) return this.moveItem(this.getActiveItem(), leftItemIndex);
  }

  /**
   * @public
   * @status public
   *
   * Get the index of the active item.
   *
   * @returns {Number}
   */
  getActiveItemIndex() {
    return this.items.indexOf(this.activeItem);
  }

  /**
   * @public
   * @status public
   *
   * Activate the item at the given index.
   *
   * @param {Number} index
   */
  activateItemAtIndex(index) {
    const item = this.itemAtIndex(index) || this.getActiveItem();
    return this.setActiveItem(item);
  }

  /**
   * @public
   * @status public
   *
   * Make the given item *active*, causing it to be displayed by
   * the pane's view.
   *
   * @param {*} item - The item to activate
   * @param {Object} [options]
   * @param {Boolean} [options.pending] - indicating that the item should be added in a pending state if it does not yet exist in the pane. Existing pending items in a pane are replaced with new pending items when they are opened.
   * @param {Boolean} [options.activatePane] - `true` also activates and focuses this pane after selecting the item, notifying workspace observers of the final selection once.
   */
  activateItem(item, options = {}) {
    return this.transactActiveState(() => {
      if (item) {
        const index =
          this.getPendingItem() === this.activeItem
            ? this.getActiveItemIndex()
            : this.getActiveItemIndex() + 1;
        this.addItem(item, Object.assign({}, options, { index }));
        this.setActiveItem(item);
        if (options.activatePane === true) this.activate();
      }
    });
  }

  /**
   * @public
   * @status public
   *
   * Add the given item to the pane.
   * Non-mini text editors with no explicit `autoHeight` setting adopt the
   * pane's height so their content can scroll. Explicit sizing and editors
   * embedded within another item are preserved.
   *
   * @param {*} item - The item to add. It can be a model with an associated view or a view.
   * @param {Object} [options]
   * @param {Number} [options.index] - indicating the index at which to add the item. If omitted, the item is added after the current active item.
   * @param {Boolean} [options.pending] - indicating that the item should be added in a pending state. Existing pending items in a pane are replaced with new pending items when they are opened.
   * @param {Boolean} [options.transferred] - Mark a newly staged cross-window item, preserving its requested placement instead of treating it as a regular open.
   * @returns {*} added item.
   */
  addItem(item, options = {}) {
    this.container?.assertMutable?.();
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
    if (this.container) {
      assertItemLocation(item, this.container.getLocation());
      this.container.assertItemAvailable(item, this);
    } else {
      // Constructors stage items before their destination container exists.
      // setContainer validates the actual location before registering them.
      assertCenterItemContract(item, isItemAllowedInLocation(item, "center") ? "center" : "dock");
    }

    // Detached editors grow with their content by default. Direct pane
    // documents instead use the viewport unless their owner chose a size.
    if (item instanceof TextEditor && !item.isMini() && item.autoHeight == null) {
      item.update({ autoHeight: false });
    }

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

    try {
      this.container?.registerItem(item);
    } catch (error) {
      this.unsubscribeFromItem(item);
      throw error;
    }

    this.items.splice(index, 0, item);
    const lastPendingItem = this.getPendingItem();
    const replacingPendingItem = lastPendingItem != null && !moved && !options.copied;
    if (replacingPendingItem) this.pendingItem = null;
    if (pending) this.setPendingItem(item);

    this.emitter.emit("did-add-item", {
      item,
      index,
      moved,
      ...(options.transferred ? { transferred: true } : {}),
    });
    this.assertAddedItem(item);
    if (this.container) {
      // A moved item is not *added* as far as the workspace is concerned, but
      // it does now live in this container, so the registry follows it.
      if (!moved) {
        this.container.didAddPaneItem(item, this, index, options);
      }
    }
    this.assertAddedItem(item);

    if (replacingPendingItem) this.destroyItem(lastPendingItem);
    if (!this.getActiveItem()) this.setActiveItem(item);
    return item;
  }

  assertAddedItem(item) {
    const destroyed = item.isDestroyed?.() || item.destroyed === true;
    if (destroyed && this.items.includes(item)) {
      this.removeItem(item, false, { preservePane: true });
    }
    if (this.isDestroyed() || !this.items.includes(item) || destroyed) {
      throw new PaneItemOperationError(
        "ITEM_UNAVAILABLE",
        "The pane item was removed while being added.",
      );
    }
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
   * @public
   * @status public
   *
   * Toggle the pending state of the active item.
   *
   * Clears the pending item if the active item is already pending, otherwise
   * marks the active item as pending. When marking an item pending, its
   * buffer edits are watched for text editors so that editing them clears the
   * pending state, the same way natively-previewed items behave. Other items
   * use `onDidChange`. This is required because
   * `terminatePendingState` is one-shot: once an item has terminated it never
   * emits again, so a re-pended item could not otherwise clear itself.
   */
  togglePendingItem() {
    const item = this.getActiveItem();
    if (!item) return;
    if (this.getPendingItem() === item) {
      this.clearPendingItem();
    } else {
      this.setPendingItem(item);
      if (item instanceof TextEditor) {
        this.pendingItemSubscription = item.getBuffer().onDidChange(({ origin }) => {
          if (origin === "edit") this.clearPendingItem();
        });
      } else if (typeof item.onDidChange === "function") {
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
   * @public
   * @status public
   *
   * Add the given items to the pane.
   *
   * @param {Array<*>} items - An `Array` of items to add. Items can be views or models with associated views. Any objects that are already present in the pane's current items will not be added again.
   * @param {Number} [index] - index at which to add the items. If omitted, the item is #   added after the current active item.
   * @returns {Array<*>} of added items.
   */
  addItems(items, index = this.getActiveItemIndex() + 1) {
    items = items.filter((item) => !this.items.includes(item));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      this.addItem(item, { index: index + i });
    }
    return items;
  }

  removeItem(item, moved, { preservePane = false, retainView = false } = {}) {
    this.container?.assertMutable?.();
    return this.transactActiveState(() => {
      const index = this.items.indexOf(item);
      if (index === -1) return;
      this.emitter.emit("will-remove-item", {
        item,
        index,
        destroyed: !moved,
        moved,
      });
      if (this.getPendingItem() === item) {
        this.pendingItem = null;
        this.pendingItemSubscription?.dispose();
        this.pendingItemSubscription = null;
      }
      this.removeItemFromStack(item);
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
      const removal = { item, index, destroyed: !moved, moved };
      if (retainView) Object.defineProperty(removal, "retainView", { value: true });
      try {
        this.emitter.emit("did-remove-item", removal);
      } finally {
        if (this.container) {
          // As in `addItem`: a move destroys nothing, but the item has left this
          // container and the registry has to say so.
          if (moved) {
            this.container.unregisterItem(item);
          } else {
            this.container.didDestroyPaneItem({ item, index, pane: this });
          }
        }
        const shouldDestroyEmptyPanes = this.container
          ? this.container.shouldDestroyEmptyPanes()
          : this.config.get("core.destroyEmptyPanes");
        if (
          this.items.length === 0 &&
          shouldDestroyEmptyPanes &&
          !preservePane &&
          this.emptyPaneHoldCount === 0
        )
          this.destroy();
      }
    });
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
   * @public
   * @status public
   *
   * Move the given item to the given index.
   *
   * @param {*} item - The item to move.
   * @param {Number} newIndex - indicating the index to which to move the item.
   */
  moveItem(item, newIndex) {
    this.container?.assertMutable?.();
    const oldIndex = this.items.indexOf(item);
    this.items.splice(oldIndex, 1);
    this.items.splice(newIndex, 0, item);
    this.emitter.emit("did-move-item", { item, oldIndex, newIndex });
  }

  /**
   * @public
   * @status public
   *
   * Move the given item to the given index on another pane.
   *
   * @param {*} item - The item to move.
   * @param {Pane} pane - to which to move the item.
   * @param {Number} [index] - indicating the index to which to move the item in the given pane.
   * @param {Object} [options={}] - Source-pane lifetime options.
   * @param {Boolean} [options.preserveSourcePane=false] - Keep an emptied source pane alive after the move.
   */
  moveItemToPane(item, pane, index, { preserveSourcePane = false } = {}) {
    this.container?.assertMutable?.();
    pane.getContainer()?.assertMutable?.();
    const document =
      this.element?.ownerDocument ??
      this.container?.getWindow()?.getDocument() ??
      globalThis.document;
    if (!this.items.includes(item) || pane === this) return;
    assertItemLocation(item, pane.getContainer()?.getLocation() || "center");
    const sourceView = this.element?.views.getView(item);
    const state = {
      index: this.items.indexOf(item),
      activeItem: this.activeItem,
      pendingItem: this.getPendingItem(),
      watchedPending: !!this.pendingItemSubscription,
      stack: [...this.itemStack],
      focusedElement: this.element?.contains(document.activeElement)
        ? document.activeElement
        : null,
    };
    const owner = () =>
      this.container?.workspace?.paneForItem(item) ||
      (this.items.includes(item) ? this : pane.getItems().includes(item) ? pane : null);
    let accepted = false;
    const previousMovingItem = this.movingItem;
    this.movingItem = item;
    this.emptyPaneHoldCount++;
    return this.transactActiveState(() =>
      pane.transactActiveState(() => {
        try {
          // The source stays connected until removal observers have run and
          // the destination has been revalidated. A rejected move can return
          // the exact view without detaching an iframe or destroying a pane.
          this.removeItem(item, true, { preservePane: true, retainView: true });
          if (
            pane.isDestroyed() ||
            this.items.includes(item) ||
            owner() ||
            item.isDestroyed?.() ||
            item.destroyed === true
          ) {
            throw new PaneItemOperationError(
              "PANE_UNAVAILABLE",
              "The pane item or its destination changed during the move.",
            );
          }
          if (sourceView?.isConnected) {
            const destinationElement = pane.getElement();
            if (
              destinationElement.isConnected &&
              sourceView.ownerDocument === destinationElement.ownerDocument
            ) {
              const display =
                this.element.inlineDisplayStyles.get(sourceView) ||
                (sourceView.style.display === "none" ? "" : sourceView.style.display);
              destinationElement.inlineDisplayStyles.set(sourceView, display);
              destinationElement.itemViews.moveBefore(sourceView, null);
            }
          }
          const result = pane.addItem(item, { index, moved: true });
          accepted = true;
          this.container?.didTransferPaneItem();
          return result;
        } catch (error) {
          if (
            !this.isDestroyed() &&
            !item.isDestroyed?.() &&
            item.destroyed !== true &&
            (!owner() || owner() === this)
          ) {
            if (!this.items.includes(item)) this.addItem(item, { index: state.index, moved: true });
            if (state.pendingItem === item) {
              this.setPendingItem(item);
              if (state.watchedPending) {
                if (item instanceof TextEditor)
                  this.pendingItemSubscription = item.getBuffer().onDidChange(({ origin }) => {
                    if (origin === "edit") this.clearPendingItem();
                  });
                else if (typeof item.onDidChange === "function")
                  this.pendingItemSubscription = item.onDidChange(() => this.clearPendingItem());
              }
            }
            this.itemStack = [
              ...state.stack.filter((entry) => this.items.includes(entry)),
              ...this.itemStack.filter((entry) => !state.stack.includes(entry)),
            ];
            this.setActiveItem(this.items.includes(state.activeItem) ? state.activeItem : item);
            if (
              state.focusedElement?.isConnected &&
              (document.activeElement === document.body ||
                this.element?.contains(document.activeElement))
            )
              state.focusedElement.focus();
          }
          throw error;
        } finally {
          this.movingItem = previousMovingItem;
          this.emptyPaneHoldCount--;
          const shouldDestroy = this.container
            ? this.container.shouldDestroyEmptyPanes()
            : this.config.get("core.destroyEmptyPanes");
          if (
            accepted &&
            !preserveSourcePane &&
            this.items.length === 0 &&
            shouldDestroy &&
            this.emptyPaneHoldCount === 0
          )
            this.destroy();
        }
      }),
    );
  }

  /**
   * @public
   * @status public
   *
   * Destroy the active item and activate the next item.
   *
   * @returns {Promise<Boolean>} that resolves when the item is destroyed.
   */
  destroyActiveItem() {
    return this.destroyItem(this.activeItem);
  }

  /**
   * @public
   * @status public
   *
   * Destroy the given item.
   *
   * If the item is active, the next item will be activated. If the item is the
   * last item, a pane in the workspace center will be destroyed if the
   * `core.destroyEmptyPanes` config setting is `true`. A pane in a dock will
   * always be destroyed when it becomes empty.
   *
   * This action can be prevented by onWillDestroyPaneItem callbacks in which
   * case nothing happens.
   *
   * @param {*} item - Item to destroy
   * @param {Boolean} [force] - Destroy the item without prompting to save it, even if the item's `isPermanentDockItem` method returns true.
   * @param {Object} [options] - Final mutation guards for an asynchronous close.
   * @param {Function} [options.canDestroy] - Return false to cancel after listeners and save prompts have completed.
   * @returns {Promise<Boolean>} that resolves with a `Boolean` indicating whether or not the item was destroyed.
   */
  async destroyItem(item, force, { canDestroy } = {}) {
    const preparing = this.prepareToDestroyItem(item, force, { canDestroy });
    const prepared = preparing?.then ? await preparing : preparing;
    return prepared ? prepared.destroy() : false;
  }

  /** @private Run close listeners without removing the item, then expose a synchronous commit. */
  prepareToDestroyItem(item, force, { canDestroy } = {}) {
    const index = this.items.indexOf(item);
    if (index === -1) return null;

    if (
      !force &&
      typeof item.isPermanentDockItem === "function" &&
      item.isPermanentDockItem() &&
      (!this.container || this.container.getLocation() !== "center")
    ) {
      return null;
    }

    const ready = () =>
      !this.isDestroyed() &&
      this.items.includes(item) &&
      !(typeof item.isDestroyed === "function" && item.isDestroyed()) &&
      (!canDestroy || canDestroy());
    const prepared = {
      canDestroy: ready,
      destroy: () => {
        if (!ready()) return false;
        this.removeItem(item, false);
        if (typeof item.destroy === "function") item.destroy();
        return true;
      },
    };
    const hasItemListeners = this.emitter.listenerCountForEventName("will-destroy-item") > 0;
    const hasContainerListeners =
      this.container?.emitter.listenerCountForEventName("will-destroy-pane-item") > 0;
    const prompts = !force && this.shouldPromptToSaveItem(item);
    // Ordinary closes without listeners must still take effect synchronously.
    if (!hasItemListeners && !hasContainerListeners && !prompts) return prepared;
    return (async () => {
      if (hasItemListeners) await this.emitter.emitAsync("will-destroy-item", { item, index });
      if (this.container?.emitter.listenerCountForEventName("will-destroy-pane-item") > 0) {
        let prevented = false;
        await this.container.willDestroyPaneItem({
          item,
          index,
          pane: this,
          prevent: () => (prevented = true),
        });
        if (prevented) return null;
      }
      if (!force && this.shouldPromptToSaveItem(item)) {
        if (!(await this.promptToSaveItem(item))) return null;
      }
      return prepared;
    })();
  }

  /**
   * @public
   * @status public
   *
   * Destroy all items.
   */
  destroyItems() {
    return Promise.all(this.getItems().map((item) => this.destroyItem(item)));
  }

  /**
   * @public
   * @status public
   *
   * Destroy all items except for the active item.
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

    if (item.getFileState?.() !== "conflicted") {
      return true;
    }
    // Figure out how to describe the buffer in the dialog.
    const uri = item.getURI?.() ?? item.getUri?.() ?? null;
    const title = (typeof item.getTitle === "function" && item.getTitle()) || uri;

    const response = await (this.container?.getWindow() ?? this.applicationDelegate).confirm({
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
    const window = this.container?.getWindow() ?? this.applicationDelegate;
    return new Promise((resolve, reject) => {
      if (!this.shouldPromptToSaveItem(item, options)) {
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
        window
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

      // A pane item whose backing file was removed gets a clearer, more
      // accurate message than the generic "has changes" prompt.
      const removed = item.getFileState?.() === "removed";
      const message = removed
        ? `'${title}' was deleted on disk. Do you still want to save this file?`
        : `'${title}' has changes, do you want to save them?`;

      saveDialog("Save", this.saveItem, message);
    });
  }

  shouldPromptToSaveItem(item, options = {}) {
    if (typeof item.shouldPromptToSave === "function") {
      return item.shouldPromptToSave(options);
    }

    const saveable = typeof item.save === "function" || typeof item.saveAs === "function";
    if (!saveable || typeof item.getFileState !== "function") return false;

    return (
      lumine.config.get("core.promptOnCloseDirtyBuffer") && item.getFileState() !== "unmodified"
    );
  }

  /**
   * @public
   * @status public
   *
   * Save the active item.
   * @param {Function} [nextAction] - Receives a save error on failure, or no argument after success.
   * @returns {Promise<*>|undefined}
   * @category Saving Items
   */
  saveActiveItem(nextAction) {
    return this.saveItem(this.getActiveItem(), nextAction);
  }

  /**
   * @public
   * @status public
   *
   * Prompt the user for a location and save the active item with the
   * path they select.
   *
   * @param {Function} [nextAction] - which will be called after the item is successfully saved.
   * @returns {Promise<*>} that resolves when the save is complete
   * @category Saving Items
   */
  saveActiveItemAs(nextAction) {
    return this.saveItemAs(this.getActiveItem(), nextAction);
  }

  /**
   * @public
   * @status public
   *
   * Save the given item.
   *
   * @param {*} item - The item to save.
   * @param {Function} [nextAction] - which will be called with no argument after the item is successfully saved, or with the error if it failed. The callback return value is used only when saving through saveItemAs.
   * @returns {Promise<*>|undefined} Settles after the save attempt; an unsaveable item can return undefined. Save-as results follow saveItemAs. Save cancellation may reject, while other write errors are reported to nextAction or notifications.
   * @category Saving Items
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
        const conflicted = item.getFileState?.() === "conflicted";

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
            // Cancellation is an API result, not a write failure worth a
            // notification. Keep rejecting so explicit callers can observe
            // it; native command handlers consume it at their boundary.
            if (isSaveCancellationError(error)) {
              if (nextAction) nextAction(error);
              throw error;
            }
            if (nextAction) {
              nextAction(error);
            } else {
              this.handleSaveError(error, item);
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
   * @public
   * @status public
   *
   * Prompt the user for a location and save the given item with the
   * path they select.
   *
   * @param {*} item - The item to save.
   * @param {Function} [nextAction] - which will be called with no argument after the item is successfully saved, or with the error if it failed. The return value will be that of `nextAction` or `undefined` if it was not provided.
   * @returns {Promise<*>} Resolves with the optional callback result. Cancellation reports a SaveCancelledError to the callback, or resolves to undefined when no callback is supplied.
   * @category Saving Items
   */
  async saveItemAs(item, nextAction) {
    if (!item) return;
    if (typeof item.saveAs !== "function") return;

    const saveOptions =
      typeof item.getSaveDialogOptions === "function" ? item.getSaveDialogOptions() : {};

    const itemPath = item.getPath();
    if (itemPath && !saveOptions.defaultPath) saveOptions.defaultPath = itemPath;

    const window = this.container?.getWindow() ?? this.applicationDelegate;
    const { filePath: newItemPath } = await window.showSaveDialog(saveOptions);
    if (!newItemPath) {
      return nextAction ? nextAction(new SaveCancelledError("Save Cancelled")) : undefined;
    }

    try {
      await promisify(() => item.saveAs(newItemPath));
      return nextAction ? nextAction() : undefined;
    } catch (error) {
      if (nextAction) return nextAction(error);
      if (isSaveCancellationError(error)) return;
      this.handleSaveError(error, item);
    }
  }

  /**
   * @public
   * @status public
   *
   * Save all saveable items whose file state is not unmodified.
   *
   * @returns {Promise<Array<*>>} that resolves when all items have been saved.
   * @category Saving Items
   */
  async saveItems() {
    const promises = [];
    for (let item of this.getItems()) {
      if (
        typeof item.getFileState === "function" &&
        item.getFileState() !== "unmodified" &&
        (typeof item.save === "function" || typeof item.saveAs === "function")
      ) {
        promises.push(this.saveItem(item));
      }
    }
    return await Promise.all(promises);
  }

  /**
   * @public
   * @status public
   *
   * Find the first pane item with the given URI.
   *
   * @param {String} uri - containing a URI.
   * @returns {*|undefined} first item that matches the given URI or undefined if none exists.
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
   * @public
   * @status public
   *
   * Activate the first item that matches the given URI.
   *
   * @param {String} uri - containing a URI.
   * @returns {Boolean} indicating whether an item matching the URI was found.
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

  /**
   * @category Lifecycle
   */

  /**
   * @public
   * @status public
   *
   * Determine whether the pane is active.
   *
   * @returns {Boolean}
   * @category Activation
   */
  isActive() {
    return this.container && this.container.getActivePane() === this;
  }

  /**
   * @public
   * @status public
   *
   * Makes this pane the *active* pane, causing it to gain focus.
   * @category Activation
   */
  activate() {
    if (this.isDestroyed()) throw new Error("Pane has been destroyed");
    // `focused` is otherwise cleared only by a DOM blur, and no blur fires
    // while the window is not the focused one -- so a pane activated in the
    // background keeps claiming focus for good, and `PaneElement`'s
    // `connectedCallback` hands focus back to it the next time its element is
    // reparented. Closing a pane reparents whatever the collapsing axis left
    // behind, so a stale claim there lands focus in a pane that is not the
    // active one. At most one pane in a container holds focus.
    const previous = this.container && this.container.getActivePane();
    if (previous && previous !== this) previous.blur();
    this.focused = true;

    if (this.container) this.container.didActivatePane(this);
    this.emitter.emit("did-activate");
  }

  /**
   * @public
   * @status public
   *
   * Close the pane and destroy all its items.
   *
   * Closing the active pane activates the most recently used remaining pane.
   *
   * If this is the last pane, all the items will be destroyed but the pane
   * itself will not be destroyed.
   */
  destroy() {
    this.container?.assertMutable?.();
    if (this.container && this.container.isAlive() && this.container.getPanes().length === 1) {
      return this.destroyItems();
    }
    return this.transactActiveState(() => {
      this.emitter.emit("will-destroy");
      this.alive = false;
      if (this.pendingItemSubscription) {
        this.pendingItemSubscription.dispose();
        this.pendingItemSubscription = null;
      }
      if (this.container) {
        this.container.willDestroyPane({ pane: this });
        if (this.isActive()) this.container.activatePaneAfterDestroy();
      }
      this.emitter.emit("did-destroy");
      this.emitter.dispose();
      for (let item of this.items.slice()) {
        if (typeof item.destroy === "function") item.destroy();
        if (this.items.includes(item)) this.removeItem(item, false, { preservePane: true });
      }
      if (this.container) this.container.didDestroyPane({ pane: this });
    });
  }

  isAlive() {
    return this.alive;
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this pane has been destroyed.
   *
   * @returns {Boolean}
   */
  isDestroyed() {
    return !this.isAlive();
  }

  /**
   * @category Splitting
   */

  /**
   * @public
   * @status public
   *
   * Create a new pane to the left of this pane.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   */
  splitLeft(params) {
    return this.split("horizontal", "before", params);
  }

  /**
   * @public
   * @status public
   *
   * Create a new pane to the right of this pane.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   */
  splitRight(params) {
    return this.split("horizontal", "after", params);
  }

  /**
   * @public
   * @status public
   *
   * Creates a new pane above the receiver.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   */
  splitUp(params) {
    return this.split("vertical", "before", params);
  }

  /**
   * @public
   * @status public
   *
   * Creates a new pane below the receiver.
   *
   * @param {Object} [params] - with the following keys:
   * @param {Array} [params.items] - of items to add to the new pane.
   * @param {Boolean} [params.activate] - `false` will leave the currently active pane active instead of activating the new pane. Defaults to `true`.
   * @returns {Pane} new {@link Pane}.
   */
  splitDown(params) {
    return this.split("vertical", "after", params);
  }

  split(orientation, side, params) {
    this.container?.assertMutable?.();
    const incomingItems = (params?.items || []).filter(Boolean);
    this.container.itemRegistry.assertItemsAvailable(incomingItems);
    this.container.globalItemRegistry?.assertItemsAvailable(incomingItems);
    for (const item of params?.items || []) {
      if (!item) continue;
      assertItemLocation(item, this.container.getLocation());
      this.container.assertItemAvailable(item, null);
    }
    return this.transactActiveState(() => {
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

      if (!params || params.activate !== false) {
        newPane.activate();
      }
      return newPane;
    });
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

  // If the parent is a horizontal axis, returns its first child if it is a pane;
  // otherwise returns a new pane created by splitting this pane leftward.
  findOrCreateLeftmostSibling(params) {
    const leftmostSibling = this.findLeftmostSibling();
    if (leftmostSibling === this) {
      return this.splitLeft(params);
    } else {
      return leftmostSibling;
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

  // If the parent is a vertical axis, returns its first child if it is a pane;
  // otherwise returns a new pane created by splitting this pane upward.
  findOrCreateTopmostSibling(params) {
    const topmostSibling = this.findTopmostSibling();
    if (topmostSibling === this) {
      return this.splitUp(params);
    } else {
      return topmostSibling;
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

module.exports.SaveCancelledError = SaveCancelledError;
module.exports.SaveConflictedError = SaveConflictedError;
module.exports.isSaveCancellationError = isSaveCancellationError;

function promisify(callback) {
  try {
    return Promise.resolve(callback());
  } catch (error) {
    return Promise.reject(error);
  }
}
