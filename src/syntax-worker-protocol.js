// Paint packets have a separate allowance from semantic result streams. The
// bounds amortize message round trips while keeping renderer decoding short.
exports.PAINT_TILE_ROWS = 128;
exports.PAINT_PACKET_EVENTS = 4096;
exports.PREVIEW_DOCUMENT_UNITS = 16 * 1024;

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

// Interactive input has one bounded request/reply. Large edits retain the
// streamed preparation contract rather than silently expanding this budget.
exports.canPrepareInputIndentation = (changes, ranges) => {
  if (
    !exports.canInlineIndentation(ranges) ||
    !ranges.length ||
    !Array.isArray(changes) ||
    changes.length > 128
  )
    return false;
  let units = 0;
  for (const change of changes) {
    const source = change.newTextSource ?? change.inserted ?? change.newText ?? change.text;
    if (source == null || !Number.isSafeInteger(source.length) || source.length < 0) return false;
    units += source.length;
    if (units > 65536) return false;
  }
  return true;
};
