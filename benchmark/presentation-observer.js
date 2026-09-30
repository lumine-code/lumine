// The marker is changed only after the editor's real DOM update acknowledges
// the armed input. A captured frame must contain that revision, not merely
// arrive after sendInputEvent (an unrelated cursor blink can do that).
function revisionInFrame(image, dirtyRect, marker, scaleFactor) {
  // Electron's subscription crops in physical pixels and returns a 1x bitmap.
  const pointX = Math.floor(marker.x * scaleFactor) - dirtyRect.x;
  const pointY = Math.floor(marker.y * scaleFactor) - dirtyRect.y;
  const { width, height } = image.getSize();
  if (pointX < 0 || pointY < 0 || pointX >= width || pointY >= height) return null;
  const pixels = image.toBitmap();
  const offset = (pointY * width + pointX) * 4;
  // NativeImage bitmap pixels are BGRA on the supported little-endian hosts.
  if (pixels[offset] !== 197 || pixels[offset + 3] !== 255) return null;
  return pixels[offset + 2] * 256 + pixels[offset + 1];
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: values.length ? Math.min(...values) : null,
    maxMs: values.length ? Math.max(...values) : null,
  };
}

module.exports = { revisionInFrame, percentile, summarize };
