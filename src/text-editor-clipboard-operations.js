const Range = require("./range");
const { leadingIndentation } = require("./text-source-helpers");

// Planning is read-only: expanding a live selection merely to copy it emits
// observable selection events and can destroy another cursor on the same row.
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
  const buffer = editor.getBuffer();
  const isCurrent = editor.captureTextMutationGuard({ bypassReadOnly: !cut || bypassReadOnly });
  const revision = buffer.getTextRevision();
  const source = buffer.getTextSnapshot();
  const plans = [];
  for (const selection of editor.getSelections()) {
    let range = selection.getBufferRange(),
      fullLine = false;
    if (onlySelected && range.isEmpty()) continue;
    if (range.isEmpty()) {
      if (endOfLine === "screen")
        range = new Range(
          range.start,
          editor.bufferPositionForScreenPosition([selection.cursor.getScreenRow(), Infinity]),
        );
      else if (endOfLine === "buffer")
        range = new Range(range.start, buffer.clipPosition([range.start.row, Infinity]));
      else {
        range = editor.bufferRangeForBufferRow(range.start.row, { includeNewline: true });
        fullLine = true;
      }
    }
    if (!range.isEmpty())
      plans.push({
        selection,
        range,
        start: source.offsetAt(range.start),
        end: source.offsetAt(range.end),
        fullLine,
      });
  }
  if (!plans.length) return;
  const groups = [];
  for (const plan of plans.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = groups.at(-1);
    if (previous && (plan.start < previous.end || (cut && plan.start === previous.end))) {
      previous.end = Math.max(previous.end, plan.end);
      previous.range = previous.range.union(plan.range);
      previous.fullLine &&= plan.fullLine;
    } else groups.push({ ...plan });
  }
  let units = groups.length - 1;
  for (const { start, end } of groups) units += end - start;
  if (units > require("node:buffer").constants.MAX_STRING_LENGTH)
    throw Object.assign(
      new RangeError(
        "The selected text exceeds the clipboard string limit. Copy a smaller range or save the document to a file.",
      ),
      { code: "ERR_CLIPBOARD_TEXT_LIMIT" },
    );
  const entries = groups.map(({ range, start, end, fullLine }) => ({
    text: source.slice(start, end),
    indentBasis: leadingIndentation(
      source,
      source.lineStart(range.start.row),
      start,
      editor.getTabLength(),
    ).level,
    fullLine,
  }));
  const metadata = { indentBasis: entries[0].indentBasis, fullLine: entries[0].fullLine };
  if (entries.length > 1) metadata.selections = entries;
  const memory = editor.constructor.clipboard.createMemoryClipboard(clipboard);
  if (!isCurrent()) return false;
  memory.write(entries.map((entry) => entry.text).join("\n"), metadata);
  const finish = () => {
    if (!cut) return;
    if (!isCurrent()) return false;
    return editor.transact(() =>
      editor.mergeIntersectingSelections(() => {
        buffer.setTextInIndependentRanges(
          groups.map(({ range }) => ({ range, text: "" })),
          { expectedRevision: revision },
        );
        const after = buffer.getTextSnapshot();
        let removed = 0,
          groupIndex = 0;
        for (const plan of plans.slice().sort((a, b) => a.start - b.start)) {
          while (groupIndex < groups.length && plan.start >= groups[groupIndex].end) {
            removed += groups[groupIndex].end - groups[groupIndex].start;
            groupIndex++;
          }
          const group = groups[groupIndex];
          const offset = group ? Math.min(plan.start, group.start) - removed : plan.start - removed;
          const point = after.positionAt(offset);
          plan.selection.setBufferRange([point, point], { autoscroll: false });
        }
      }),
    );
  };
  const flushed = memory.flush?.();
  return flushed && typeof flushed.then === "function" ? flushed.then(finish) : finish();
}

module.exports = { copySelections };
