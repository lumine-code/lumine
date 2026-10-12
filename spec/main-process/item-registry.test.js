const { test } = require("node:test");
const assert = require("node:assert/strict");
const ItemRegistry = require("../../src/item-registry");

function item(key, uri = "test://results") {
  const callbacks = new Set();
  return {
    key,
    getURI: () => uri,
    getSingletonKey() {
      return this.key;
    },
    onDidChangeURI(callback) {
      callbacks.add(callback);
      return { dispose: () => callbacks.delete(callback) };
    },
    publishKey(value) {
      this.key = value;
      for (const callback of callbacks) callback();
    },
    callbacks,
  };
}

test("rejects a duplicate resource without registering it or removing its owner", () => {
  const registry = new ItemRegistry();
  const owner = item("results:one");
  const duplicate = item("results:one", "test://other-uri");
  registry.addItem(owner);
  assert.throws(() => registry.addItem(duplicate), /singleton key/);
  assert.equal(registry.hasItem(duplicate), false);
  registry.removeItem(duplicate);
  assert.equal(registry.getItemForSingletonKey("results:one"), owner);
});

test("allows independent results with the same display URI and different keys", () => {
  const registry = new ItemRegistry();
  const first = item("results:one");
  const second = item("results:two");
  registry.addItem(first);
  registry.addItem(second);
  assert.equal(registry.getItemForSingletonKey("results:one"), first);
  assert.equal(registry.getItemForSingletonKey("results:two"), second);
});

test("keys are scoped to their workspace registry", () => {
  const first = new ItemRegistry();
  const second = new ItemRegistry();
  const a = item("styleguide:main");
  const b = item("styleguide:main");
  first.addItem(a);
  second.addItem(b);
  assert.equal(first.getItemForSingletonKey("styleguide:main"), a);
  assert.equal(second.getItemForSingletonKey("styleguide:main"), b);
});

test("retargeting releases the reusable result slot and reserves its new resource", () => {
  const registry = new ItemRegistry();
  const owner = item("results:current");
  registry.addItem(owner);
  owner.publishKey("results:saved");
  assert.equal(registry.getItemForSingletonKey("results:current"), undefined);
  assert.equal(registry.getItemForSingletonKey("results:saved"), owner);
  registry.addItem(item("results:current"));
  registry.removeItem(owner);
  assert.equal(registry.getItemForSingletonKey("results:saved"), undefined);
  assert.equal(owner.callbacks.size, 0);
});

test("a failed subscription releases every reservation before a later open", () => {
  const registry = new ItemRegistry();
  const broken = item("tool:main");
  broken.onDidChangeURI = () => {
    throw new Error("provider subscription failed");
  };
  assert.throws(() => registry.addItem(broken), /subscription failed/);
  assert.equal(registry.hasItem(broken), false);
  assert.equal(registry.getItemForSingletonKey("tool:main"), undefined);
  registry.addItem(item("tool:main"));
});

test("an invalid key is refused before reserving or subscribing the item", () => {
  const registry = new ItemRegistry();
  const invalid = item("");
  assert.throws(() => registry.addItem(invalid), /non-empty string/);
  assert.equal(registry.hasItem(invalid), false);
  assert.equal(invalid.callbacks.size, 0);
});
