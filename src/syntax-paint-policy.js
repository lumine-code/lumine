const { PAINT_TILE_ROWS } = require("./syntax-worker-protocol");
const { DEFAULTS } = require("./tree-sitter-query-budget");

// Keep ordinary rows together. A pathological single row remains a single
// presentation unit, while the query separately caps its source window.
function paintTile(buffer, first, last, maxUnits = DEFAULTS.maxWindowLength) {
  first = Math.max(0, first);
  last = Math.min(last, buffer.getLastRow());
  if (first > last) return null;
  const source = buffer.getTextSnapshot();
  const start = buffer.clipPosition([first, 0]);
  const startIndex = buffer.characterIndexForPosition(start);
  let endRow = Math.min(first + PAINT_TILE_ROWS - 1, last);
  const requestedEnd = buffer.clipPosition([endRow + 1, 0]);
  if (buffer.characterIndexForPosition(requestedEnd) - startIndex > maxUnits) {
    const boundary = source.positionAt(Math.min(source.length, startIndex + maxUnits));
    endRow = Math.max(first, boundary.row - 1);
  }
  return { start, end: buffer.clipPosition([endRow + 1, 0]), endRow };
}

module.exports = { paintTile };
