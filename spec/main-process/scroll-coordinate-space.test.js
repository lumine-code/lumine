const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  originForOffset,
  physicalExtent,
  scrollbarExtent,
  scrollbarPosition,
  MAX_DOM_EXTENT,
  MAX_SCROLLBAR_EXTENT,
} = require("../../src/scroll-coordinate-space");

test("large document coordinates stay local across origin boundaries", () => {
  for (const top of [0, 499999.5, 500000, 33554432, 263140355.25, 1e12]) {
    const origin = originForOffset(top);
    assert.ok(top - origin >= 0 && top - origin < MAX_DOM_EXTENT / 2);
    const extent = physicalExtent(top + 900, origin);
    assert.ok(extent <= MAX_DOM_EXTENT);
    assert.ok(top - origin + 900 <= extent);
  }
});

test("scrollbar mapping preserves both ends and fractional logical positions", () => {
  for (const length of [100, 1000000, 11000000, 537602502, 1e12]) {
    const viewport = Math.min(600, length);
    const physical = scrollbarExtent(length);
    assert.ok(physical <= MAX_SCROLLBAR_EXTENT);
    const logicalRange = length - viewport;
    for (const fraction of [0, 0.000001, 0.25, 0.50003, 0.999999, 1]) {
      const logical = logicalRange * fraction;
      const native = scrollbarPosition(logical, length, physical, viewport);
      const restored = scrollbarPosition(native, physical, length, viewport);
      assert.ok(Math.abs(restored - logical) <= Math.max(1e-8, length * Number.EPSILON));
    }
    assert.equal(scrollbarPosition(logicalRange, length, physical, viewport), physical - viewport);
  }
});

test("empty, undersized and out-of-range scroll positions are bounded", () => {
  assert.equal(scrollbarPosition(20, 10, 10, 100), 0);
  assert.equal(scrollbarPosition(-1, 1000, 1000, 100), 0);
  assert.equal(scrollbarPosition(Infinity, 1000, 1000, 100), 900);
});
