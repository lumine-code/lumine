const NBSP_CHARACTER = "\u00a0";
const ZERO_WIDTH_NBSP_CHARACTER = "\ufeff";

function textDecorationsEqual(oldDecorations, newDecorations) {
  if (!oldDecorations && newDecorations) return false;
  if (oldDecorations && !newDecorations) return false;
  if (oldDecorations && newDecorations) {
    if (oldDecorations.length !== newDecorations.length) return false;
    for (let j = 0; j < oldDecorations.length; j++) {
      if (oldDecorations[j].column !== newDecorations[j].column) return false;
      if (oldDecorations[j].className !== newDecorations[j].className) return false;
      if (!objectsEqual(oldDecorations[j].style, newDecorations[j].style)) return false;
    }
  }
  return true;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0, length = a.length; i < length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function objectsEqual(a, b) {
  if (!a && b) return false;
  if (a && !b) return false;
  if (a && b) {
    for (const key in a) {
      if (a[key] !== b[key]) return false;
    }
    for (const key in b) {
      if (a[key] !== b[key]) return false;
    }
  }
  return true;
}

function roundToPhysicalPixelBoundary(virtualPixelPosition) {
  const virtualPixelsPerPhysicalPixel = 1 / window.devicePixelRatio;
  return (
    Math.round(virtualPixelPosition / virtualPixelsPerPhysicalPixel) * virtualPixelsPerPhysicalPixel
  );
}

function ceilToPhysicalPixelBoundary(virtualPixelPosition) {
  const virtualPixelsPerPhysicalPixel = 1 / window.devicePixelRatio;
  return (
    Math.ceil(virtualPixelPosition / virtualPixelsPerPhysicalPixel) * virtualPixelsPerPhysicalPixel
  );
}

function floorToPhysicalPixelBoundary(virtualPixelPosition) {
  const virtualPixelsPerPhysicalPixel = 1 / window.devicePixelRatio;
  return (
    Math.floor(virtualPixelPosition / virtualPixelsPerPhysicalPixel) * virtualPixelsPerPhysicalPixel
  );
}

module.exports = {
  NBSP_CHARACTER,
  ZERO_WIDTH_NBSP_CHARACTER,
  textDecorationsEqual,
  arraysEqual,
  roundToPhysicalPixelBoundary,
  ceilToPhysicalPixelBoundary,
  floorToPhysicalPixelBoundary,
};
