// Costs are separate from grammar choice. Millions of short rows stress layout
// even when their byte size is small; service copies instead scale with text.
const LARGE_DOCUMENT_UNITS = 32 * 1024 * 1024;
const LARGE_DOCUMENT_ROWS = 300000;

function shouldUseLargeDocumentView(buffer, alreadyActive = false) {
  const length = buffer.getLength?.() ?? buffer.length;
  const lineCount = buffer.getLineCount?.() ?? buffer.lineCount;
  const scale = alreadyActive ? 0.5 : 1;
  return length >= LARGE_DOCUMENT_UNITS * scale || lineCount >= LARGE_DOCUMENT_ROWS * scale;
}

module.exports = {
  LARGE_DOCUMENT_UNITS,
  LARGE_DOCUMENT_ROWS,
  shouldUseLargeDocumentView,
};
