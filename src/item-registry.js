module.exports = class ItemRegistry {
  constructor() {
    this.owners = new WeakMap();
  }

  addItem(item, pane) {
    if (this.hasItem(item)) {
      throw new Error(`The workspace can only contain one instance of item ${item}`);
    }
    this.owners.set(item, pane);
    return item;
  }

  removeItem(item, pane) {
    if (pane != null && this.owners.get(item) !== pane) return false;
    return this.owners.delete(item);
  }

  moveItem(item, sourcePane, destinationPane) {
    if (this.owners.get(item) !== sourcePane) {
      throw new Error("Cannot move an item from a pane that does not own it");
    }
    this.owners.set(item, destinationPane);
    return item;
  }

  hasItem(item) {
    return this.owners.has(item);
  }

  paneForItem(item) {
    return this.owners.get(item);
  }
};
