// Document offsets remain logical doubles. Only bounded coordinates reach CSS
// because Blink's layout units cannot represent huge documents.
const MAX_DOM_EXTENT = 1000000;
const ORIGIN_STEP = MAX_DOM_EXTENT / 2;

function originForOffset(offset) {
  return Math.floor(Math.max(0, offset) / ORIGIN_STEP) * ORIGIN_STEP;
}

function physicalExtent(logicalExtent, origin = 0, viewportExtent = 0) {
  return Math.max(viewportExtent, Math.min(MAX_DOM_EXTENT, logicalExtent - origin));
}

module.exports = {
  MAX_DOM_EXTENT,
  originForOffset,
  physicalExtent,
};
