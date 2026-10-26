const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");
const { rangeIsBlank, leadingIndentation, trimmedRange } = require("../../src/text-source-helpers");

test("source helpers clip infinite, reversed and out-of-document ranges without stalled readers", () => {
  const source = new PieceTree(" \t x ");
  assert.equal(rangeIsBlank(source, -Infinity, Infinity), false);
  assert.equal(rangeIsBlank(source, 999, Infinity), true);
  assert.deepEqual(leadingIndentation(source, -10, Infinity, 4), {
    columns: 5,
    length: 3,
    level: 1.25,
  });
  assert.deepEqual(leadingIndentation(source, 999, Infinity, 4), {
    columns: 0,
    length: 0,
    level: 0,
  });
  assert.deepEqual(trimmedRange(source, -Infinity, Infinity), { start: 3, end: 4 });
  assert.deepEqual(trimmedRange(source, 4, 1), { start: 4, end: 4 });
  assert.deepEqual(trimmedRange(source, 999, Infinity), { start: 5, end: 5 });
  assert.deepEqual(trimmedRange(new PieceTree(), -Infinity, Infinity), { start: 0, end: 0 });
});

test("invalid offsets and inconsistent readers fail instead of looping or returning incomplete results", () => {
  const source = new PieceTree(" ");
  for (const operation of [
    rangeIsBlank,
    trimmedRange,
    (s, a, b) => leadingIndentation(s, a, b, 4),
  ]) {
    assert.throws(() => operation(source, NaN, 1), TypeError);
    assert.throws(() => operation(source, 0, NaN), TypeError);
    const broken = { length: 10, reader: () => () => "", slice: () => "" };
    assert.throws(() => operation(broken, 0, 10), /ended before/);
  }
});
