const { Emitter } = require("atom");

module.exports = class List {
  // * `key` the name of the property identifying an item, or a {Function} that
  //   returns an item's identity. Items sharing an identity collapse into one
  //   entry, so a list that can hold several items with the same name — two
  //   directories providing the same package, say — keys on something unique.
  constructor(key) {
    this.key = key;
    this.items = [];
    this.emitter = new Emitter();
  }

  getItems() {
    return this.items;
  }

  filterItems(filterFn) {
    const result = [];
    for (const item of this.items) {
      if (filterFn(item)) {
        result.push(item);
      }
    }
    return result;
  }

  keyForItem(item) {
    return typeof this.key === "function" ? this.key(item) : item[this.key];
  }

  setItems(items) {
    items = items.slice();
    const keyForItem = this.keyForItem.bind(this);
    const setToAdd = difference(items, this.items, keyForItem);
    const setToRemove = difference(this.items, items, keyForItem);

    this.items = items;

    for (const item of setToAdd) {
      this.emitter.emit("did-add-item", item);
    }

    for (const item of setToRemove) {
      this.emitter.emit("did-remove-item", item);
    }
  }

  onDidAddItem(callback) {
    return this.emitter.on("did-add-item", callback);
  }

  onDidRemoveItem(callback) {
    return this.emitter.on("did-remove-item", callback);
  }
};

const difference = (array1, array2, keyForItem) => {
  const keys = new Set();
  for (const item of array2) {
    keys.add(keyForItem(item));
  }

  const diff = [];
  const seen = new Set();
  for (const item of array1) {
    const key = keyForItem(item);
    if (keys.has(key) || seen.has(key)) continue;
    seen.add(key);
    diff.push(item);
  }
  return diff;
};
