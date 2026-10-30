const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  originForOffset,
  physicalExtent,
  MAX_DOM_EXTENT,
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
