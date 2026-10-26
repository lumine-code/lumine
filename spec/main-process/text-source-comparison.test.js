const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");
const TextStore = require("../../src/text-store");

test("shared-tree common spans equal native UTF-16 comparisons across edits and slices", () => {
  let value = "ab😀\r\nc\tx".repeat(5000),
    source = new PieceTree(value),
    seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let i = 0; i < 150; i++) {
    const start = random() % (value.length + 1),
      end = Math.min(value.length, start + (random() % 17));
    const inserted = ["", "x", "\r", "😀", "a".repeat(1030)][random() % 5];
    const changedValue = value.slice(0, start) + inserted + value.slice(end);
    const changed = source.replace(start, end, inserted);
    const limit = Math.min(value.length, changedValue.length);
    let prefix = 0,
      suffix = 0;
    while (prefix < limit && value[prefix] === changedValue[prefix]) prefix++;
    while (
      suffix < limit &&
      value[value.length - suffix - 1] === changedValue[changedValue.length - suffix - 1]
    )
      suffix++;
    assert.equal(source.commonPrefixLength(changed), prefix);
    assert.equal(source.commonSuffixLength(changed), suffix);
    assert.equal(
      source.commonSuffixLength(changed, limit - prefix),
      Math.min(suffix, limit - prefix),
    );
    assert.equal(source.equals(changed), value === changedValue);
    assert(changed.equals(new PieceTree(changedValue)));
    source = changed;
    value = changedValue;
  }
  assert.equal(new PieceTree().commonPrefixLength(source), 0);
  assert.throws(() => source.commonPrefixLength(source, Infinity), RangeError);
});

test("oversized shared prefixes and suffixes require no streamed document scan", () => {
  let source = new PieceTree("x".repeat(32768));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  const changed = source.replace(source.length - 4, source.length - 3, "y");
  const reader = PieceTree.prototype.reader;
  PieceTree.prototype.reader = () => {
    throw new Error("Unexpected linear snapshot scan");
  };
  try {
    assert.equal(source.commonPrefixLength(changed), source.length - 4);
    assert.equal(source.commonSuffixLength(changed), 3);
    assert.equal(source.equals(changed), false);
    const store = new TextStore(source);
    const changes = store.diff(changed).getChanges();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].oldText, "x");
    assert.equal(changes[0].newText, "y");
  } finally {
    PieceTree.prototype.reader = reader;
  }
});
