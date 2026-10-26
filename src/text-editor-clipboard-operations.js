// Prepare every range and the complete clipboard payload before any deletion.
// A native clipboard is a string transport; its rejection must never turn a cut
// into lost text, including when multiple selections are involved.
function copySelections(
  editor,
  {
    clipboard = editor.constructor.clipboard,
    cut = false,
    onlySelected = false,
    endOfLine,
    bypassReadOnly = false,
  } = {},
) {
  const memory = editor.constructor.clipboard.createMemoryClipboard(clipboard);
  const plans = [];
  let maintainClipboard = false;
  for (const selection of editor.getSelectionsOrderedByBufferPosition()) {
    const previous = selection.getBufferRange();
    const reversed = selection.isReversed();
    if (onlySelected && previous.isEmpty()) continue;
    let fullLine = false;
    try {
      if (previous.isEmpty()) {
        if (endOfLine === "screen") selection.selectToEndOfLine();
        else if (endOfLine === "buffer") selection.selectToEndOfBufferLine();
        else {
          selection.selectLine();
          fullLine = true;
        }
      }
      plans.push({ selection, range: selection.getBufferRange(), previous, reversed, fullLine });
    } finally {
      selection.setBufferRange(previous, { reversed, autoscroll: false });
    }
  }
  const source = editor.buffer.getTextSnapshot();
  let units = Math.max(0, plans.length - 1);
  for (const { range } of plans) units += source.offsetAt(range.end) - source.offsetAt(range.start);
  if (units > require("node:buffer").constants.MAX_STRING_LENGTH) {
    throw Object.assign(
      new RangeError(
        "The selected text exceeds the clipboard string limit. Copy a smaller range or save the document to a file.",
      ),
      { code: "ERR_CLIPBOARD_TEXT_LIMIT" },
    );
  }
  for (const { selection, range, previous, reversed, fullLine } of plans) {
    try {
      selection.setBufferRange(range, { reversed, autoscroll: false });
      selection.copy(maintainClipboard, fullLine, memory);
      maintainClipboard = true;
    } finally {
      selection.setBufferRange(previous, { reversed, autoscroll: false });
    }
  }
  const isCurrent = editor.captureTextMutationGuard({ bypassReadOnly });
  const finish = () => {
    if (!cut) return;
    if (!isCurrent()) return false;
    return editor.transact(() => {
      for (let i = plans.length - 1; i >= 0; i--) {
        const { selection, range } = plans[i];
        selection.setBufferRange(range, { autoscroll: false });
        selection.delete({ bypassReadOnly });
      }
    });
  };
  const flushed = memory.flush?.();
  return flushed && typeof flushed.then === "function" ? flushed.then(finish) : finish();
}

module.exports = { copySelections };
