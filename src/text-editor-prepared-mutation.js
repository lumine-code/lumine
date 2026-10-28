const { mergeRanges } = require("./text-editor-auto-indent");

// Run the synchronous editing algorithm on a private editor. Record indentation
// requests in moving coordinates; resolve them only after every cursor has edited.
module.exports = function stageMutation(editor, callback, records, mode) {
  const requests = [];
  const request = (row, options = {}, edited = false) => {
    requests.push({
      marker: editor.markBufferPosition([row, 0], { invalidate: "never" }),
      options: {
        preserveLeadingWhitespace: options.preserveLeadingWhitespace,
        skipBlankLines: options.skipBlankLines,
        isReindenting: options.isReindenting,
      },
      edited,
    });
  };
  editor.autoIndentBufferRow = (row, options) => request(row, options);
  editor.autoDecreaseIndentForBufferRow = (row, options) => request(row, options, true);
  editor.autoIndentBufferRows = (start, end, options) => {
    for (let row = start; row <= end; row++) request(row, options);
  };
  editor.autoIndentBufferRowsAtRows = (rows, options) => {
    for (const row of rows) request(row, options);
  };
  editor.scheduleIndentAdjustment = () => {};
  editor.onDidInsertText(({ text, range }) => {
    records.push({ marker: editor.markBufferRange(range, { invalidate: "never" }), text });
  });
  const result = callback(editor);
  if (result?.then) throw new TypeError("Prepared editing callbacks must be synchronous");
  const resultMarker =
    result instanceof require("./range")
      ? editor.markBufferRange(result, { invalidate: "never" })
      : null;
  const rowOptions = new Map();
  for (const { marker, options, edited } of requests) {
    const row = marker.getHeadBufferPosition().row;
    if (edited && mode.mayIndentEditedRow?.(editor.getBuffer().getTextSnapshot(), row) === false)
      continue;
    const previous = rowOptions.get(row);
    if (!previous || !edited) rowOptions.set(row, { ...options, edited });
  }
  return {
    ranges: mergeRanges([...rowOptions.keys()].map((row) => [row, row])),
    rowOptions,
    get result() {
      return resultMarker ? resultMarker.getBufferRange() : result;
    },
  };
};
