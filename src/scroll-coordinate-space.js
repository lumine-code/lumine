// Document offsets remain logical doubles. Only bounded coordinates reach CSS
// or a native scrollbar; Blink's layout units cannot represent huge documents.
const MAX_DOM_EXTENT = 1000000;
const MAX_SCROLLBAR_EXTENT = 16000000;
const ORIGIN_STEP = MAX_DOM_EXTENT / 2;

function originForOffset(offset) {
  return Math.floor(Math.max(0, offset) / ORIGIN_STEP) * ORIGIN_STEP;
}

function physicalExtent(logicalExtent, origin = 0, viewportExtent = 0) {
  return Math.max(viewportExtent, Math.min(MAX_DOM_EXTENT, logicalExtent - origin));
}

function scrollbarPosition(position, sourceExtent, targetExtent, viewportExtent) {
  const sourceRange = Math.max(0, sourceExtent - viewportExtent);
  const targetRange = Math.max(0, targetExtent - viewportExtent);
  if (sourceRange === 0 || targetRange === 0) return 0;
  const bounded = Math.max(0, Math.min(sourceRange, position));
  if (sourceRange === targetRange) return bounded;
  if (bounded === sourceRange) return targetRange;
  return (bounded / sourceRange) * targetRange;
}

function scrollbarExtent(logicalExtent) {
  return Math.min(MAX_SCROLLBAR_EXTENT, Math.max(0, logicalExtent || 0));
}

module.exports = {
  MAX_DOM_EXTENT,
  MAX_SCROLLBAR_EXTENT,
  originForOffset,
  physicalExtent,
  scrollbarExtent,
  scrollbarPosition,
};
