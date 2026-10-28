const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");
const canProveBlankPrefix = require("../../src/text-source-blank-prefix");

test("blank-prefix proof follows immutable edits and never mistakes prior code for whitespace", () => {
  const original = new PieceTree("\r\n\t \n# header\ncode");
  assert.equal(canProveBlankPrefix(original, 0), true);
  assert.equal(canProveBlankPrefix(original, 5), true);
  assert.equal(canProveBlankPrefix(original, 6), false);
  const edited = original.replace(0, 0, "x");
  assert.equal(canProveBlankPrefix(edited, 6), false);
  assert.equal(canProveBlankPrefix(original, 5), true);
  const moved = original.replace(0, 0, "\r\n");
  assert.equal(canProveBlankPrefix(moved, 7), true);
  assert.equal(canProveBlankPrefix(moved, 8), false);
});

test("cold work is bounded and repeated leading insertions reuse the verified prefix", (t) => {
  let source = new PieceTree("\n".repeat(1024 * 1024) + "code");
  let prefix = source.length - 4,
    inspected = 0;
  const test = RegExp.prototype.test;
  t.mock.method(RegExp.prototype, "test", function (text) {
    if (this.source === "\\S") inspected += text.length;
    return test.call(this, text);
  });
  assert.equal(canProveBlankPrefix(source, prefix), false);
  assert.ok(inspected <= 32768);
  for (let i = 0; i < 40 && !canProveBlankPrefix(source, prefix); i++) {
    // Each call verifies another bounded portion of the initially cold prefix.
  }
  assert.equal(canProveBlankPrefix(source, prefix), true);
  inspected = 0;
  for (let i = 0; i < 100; i++) {
    source = source.replace(0, 0, "\n");
    prefix++;
    assert.equal(canProveBlankPrefix(source, prefix), true);
  }
  assert.ok(inspected < 32768, `Rescanned ${inspected} units of the old prefix`);
  assert.equal(canProveBlankPrefix(source, prefix + 1), false);
});
