module.exports = class ItemRegistry {
  constructor() {
    this.items = new WeakSet();
    this.singletonItems = new Map();
    this.singletonKeys = new WeakMap();
    this.singletonSubscriptions = new WeakMap();
  }

  getSingletonKey(item) {
    const key = item.getSingletonKey?.();
    if (key == null) return null;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("A pane item's singleton key must be a non-empty string or null.");
    }
    return key;
  }

  getItemForSingletonKey(key) {
    return key == null ? undefined : this.singletonItems.get(key);
  }

  assertItemAvailable(item) {
    if (this.hasItem(item)) {
      throw new Error(`The workspace can only contain one instance of item ${item}`);
    }
    const existing = this.getItemForSingletonKey(this.getSingletonKey(item));
    if (existing && existing !== item) {
      throw new Error("The workspace already contains a view for this singleton key.");
    }
  }

  assertItemsAvailable(items) {
    const seenItems = new Set();
    const seenKeys = new Set();
    for (const item of items) {
      this.assertItemAvailable(item);
      const key = this.getSingletonKey(item);
      if (seenItems.has(item) || (key != null && seenKeys.has(key))) {
        throw new Error("A pane cannot contain duplicate item identities or singleton keys.");
      }
      seenItems.add(item);
      if (key != null) seenKeys.add(key);
    }
  }

  refreshSingletonKey(item) {
    if (!this.hasItem(item)) return;
    const key = this.getSingletonKey(item);
    const existing = this.getItemForSingletonKey(key);
    if (existing && existing !== item) {
      throw new Error("The workspace already contains a view for this singleton key.");
    }
    const previous = this.singletonKeys.get(item);
    if (previous === key) return;
    if (previous != null && this.singletonItems.get(previous) === item) {
      this.singletonItems.delete(previous);
    }
    this.singletonKeys.set(item, key);
    if (key != null) this.singletonItems.set(key, item);
  }

  addItem(item) {
    this.assertItemAvailable(item);
    this.items.add(item);
    try {
      this.refreshSingletonKey(item);
      const subscribe = item.onDidChangeSingletonKey || item.onDidChangeURI;
      if (typeof item.getSingletonKey === "function" && typeof subscribe === "function") {
        this.singletonSubscriptions.set(
          item,
          subscribe.call(item, () => this.refreshSingletonKey(item)),
        );
      }
    } catch (error) {
      this.removeItem(item);
      throw error;
    }
    return this.items.add(item);
  }

  removeItem(item) {
    this.singletonSubscriptions.get(item)?.dispose();
    this.singletonSubscriptions.delete(item);
    const key = this.singletonKeys.get(item);
    if (key != null && this.singletonItems.get(key) === item) this.singletonItems.delete(key);
    this.singletonKeys.delete(item);
    return this.items.delete(item);
  }

  hasItem(item) {
    return this.items.has(item);
  }
};
