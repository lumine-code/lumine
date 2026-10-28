// Paint packets have a separate allowance from semantic result streams. The
// bounds amortize message round trips while keeping renderer decoding short.
exports.PAINT_TILE_ROWS = 128;
exports.PAINT_PACKET_EVENTS = 4096;

// A bounded prepared-indent reply can travel with its result, avoiding the
// streamed packet/acknowledgement round trip for an ordinary keystroke.
exports.INLINE_INDENT_ROWS = 128;
exports.canInlineIndentation = (ranges) => {
  if (!Array.isArray(ranges) || ranges.length > exports.INLINE_INDENT_ROWS) return false;
  let count = 0,
    previousEnd = -1;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return false;
    const [start, end] = range;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= previousEnd ||
      end < start
    )
      return false;
    count += end - start + 1;
    if (count > exports.INLINE_INDENT_ROWS) return false;
    previousEnd = end;
  }
  return true;
};
