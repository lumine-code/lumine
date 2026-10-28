const Point = require("./point");

const MAX_UNITS = 8192;

// Column windows retain coordinates in the full document. They never create
// a fragment parser or treat the unqueried suffix as uncolored coverage.
function paintWindows(buffer, start, end) {
  const source = buffer.getTextSnapshot();
  let index = source.offsetAt(buffer.clipPosition(start));
  const limit = source.offsetAt(buffer.clipPosition(end));
  const windows = [];
  while (index < limit) {
    let next = Math.min(index + MAX_UNITS, limit);
    if (next < limit) {
      const before = source.charCodeAt(next - 1),
        after = source.charCodeAt(next);
      if (
        (before === 13 && after === 10) ||
        (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
      )
        next--;
    }
    windows.push({
      start: Point.fromObject(source.positionAt(index)),
      end: Point.fromObject(source.positionAt(next)),
    });
    index = next;
  }
  return windows;
}

function windowTile(buffer, range) {
  const start = buffer.clipPosition(Point.fromObject(range.start));
  const end = buffer.clipPosition(Point.fromObject(range.end));
  if (start.compare(end) >= 0) return null;
  if (buffer.characterIndexForPosition(end) - buffer.characterIndexForPosition(start) > MAX_UNITS)
    throw new RangeError("Syntax paint window exceeds its source allowance");
  return { start, end, endRow: end.row - (end.column === 0 ? 1 : 0), window: true };
}

function rangeKey(range) {
  return Array.isArray(range)
    ? range.join(":")
    : `${range.start.row},${range.start.column}-${range.end.row},${range.end.column}`;
}

module.exports = { paintWindows, windowTile, rangeKey, MAX_UNITS };
