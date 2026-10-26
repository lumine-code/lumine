const assert = require("node:assert/strict");
const { test } = require("node:test");
const RowSequence = require("../../src/row-sequence");
const ScreenLineCache = require("../../src/screen-line-cache");

test("row sequence matches array edits and keeps persistent copies independent", () => {
  let seed = 0x51eed;
  const random = (maximum) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
  const sequence = new RowSequence();
  const expected = [];
  for (let iteration = 0; iteration < 3000; iteration++) {
    const start = random(expected.length + 1);
    const removed = random(Math.min(80, expected.length - start) + 1);
    const inserted = Array.from({ length: random(90) }, () => random(1000));
    const copy = sequence.copy();
    const before = expected.slice();
    sequence.spliceRows(start, removed, inserted);
    expected.splice(start, removed, ...inserted);
    assert.deepEqual(copy.slice(), before);
    assert.deepEqual(sequence.slice(), expected);
    const maximum = Math.max(0, ...expected);
    assert.equal(sequence.maximum, maximum);
    assert.equal(sequence.maximumIndex, maximum > 0 ? expected.indexOf(maximum) : 0);
    assertBalanced(sequence.root);
  }
});

test("empty rows remain implicit across distant reads, edits, and copies", () => {
  const sequence = new RowSequence(12_530_436);
  sequence.set(12_530_435, 71);
  sequence.set(1, 12);
  const copy = sequence.copy();
  for (let index = 0; index < 1000; index++) sequence.spliceRows(0, 0, [0]);
  assert.equal(sequence.length, 12_531_436);
  assert.equal(sequence.maximumIndex, 12_531_435);
  assert.equal(sequence.get(1001), 12);
  assert.equal(sequence.storedCount, 1002);
  assert.equal(copy.maximumIndex, 12_530_435);
  assert.equal(copy.storedCount, 2);
  sequence.spliceRows(1000, 12_530_435, 1);
  assert.equal(sequence.get(1001), 71);
  assertBalanced(sequence.root);
});

test("screen line cache bounds presentation memory and shifts retained row keys", () => {
  const cache = new ScreenLineCache(3);
  cache.length = 12_530_436;
  for (const row of [0, 5, 10, 12_530_435]) cache.set(row, { row });
  assert.equal(cache.get(0), undefined);
  assert.equal(cache.entries.size, 3);
  cache.spliceRows(5, 1, 3);
  assert.equal(cache.get(5), undefined);
  assert.deepEqual(cache.get(12), { row: 10 });
  assert.deepEqual(cache.at(-1), { row: 12_530_435 });
  cache.length = 0;
  assert.equal(cache.entries.size, 0);
});

function assertBalanced(node) {
  if (!node?.left) return;
  assert.ok(Math.abs(node.left.height - node.right.height) <= 1);
  assert.equal(node.count, node.left.count + node.right.count);
  assert.equal(node.height, Math.max(node.left.height, node.right.height) + 1);
  assertBalanced(node.left);
  assertBalanced(node.right);
}
