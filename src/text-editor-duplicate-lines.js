const { PieceTree } = require("./text-model");
const Range = require("./range");
const pause = () => new Promise((resolve) => setImmediate(resolve));

function needsNormalization(source, ending) {
  const endings = source.getLineEndings();
  return ending && (source.hasLoneCarriageReturn || [...endings].some((value) => value !== ending));
}

// Keep source-coordinate selections exact when normalization turns lone CRs
// into new rows, or changes CRLF widths. Only the requested anchors are kept.
async function normalize(source, ending, offsets, check) {
  if (!needsNormalization(source, ending)) return { source, offsets };
  const anchors = offsets
    .map((offset, index) => ({ offset, index }))
    .sort((a, b) => a.offset - b.offset);
  const mapped = new Array(offsets.length);
  let result = new PieceTree(),
    pending = "",
    offset = 0,
    delta = 0,
    next = 0,
    deadline = performance.now() + 4;
  const append = (part) => {
    for (const match of part.matchAll(/\r\n|\n|\r/g)) {
      const start = offset + match.index,
        end = start + match[0].length;
      while (next < anchors.length && anchors[next].offset <= start) {
        const anchor = anchors[next++];
        mapped[anchor.index] = anchor.offset + delta;
      }
      while (next < anchors.length && anchors[next].offset < end) {
        const anchor = anchors[next++];
        mapped[anchor.index] = start + delta + ending.length;
      }
      delta += ending.length - match[0].length;
    }
    const text = part.replace(/\r\n|\n|\r/g, ending);
    result = result.replace(
      result.length,
      result.length,
      text === part ? source.subtext(offset, offset + part.length) : text,
    );
    offset += part.length;
    while (next < anchors.length && anchors[next].offset <= offset) {
      const anchor = anchors[next++];
      mapped[anchor.index] = anchor.offset + delta;
    }
  };
  for (const chunk of source.chunks()) {
    check();
    const joined = pending + chunk;
    pending = joined.endsWith("\r") ? "\r" : "";
    append(pending ? joined.slice(0, -1) : joined);
    if (performance.now() >= deadline) {
      await pause();
      check();
      deadline = performance.now() + 4;
    }
  }
  if (pending) append(pending);
  check();
  return { source: result, offsets: mapped };
}

// The normal shared-root path stays synchronous. Only a genuinely large EOL
// conversion needs cooperative preparation before the atomic insertion.
function duplicateWithNormalization(editor, options) {
  const buffer = editor.getBuffer();
  if (buffer.getLength() <= 1024 * 1024) return null;
  const snapshot = buffer.getTextSnapshot();
  const endings = snapshot.getLineEndings(),
    preferredEnding = buffer.getPreferredLineEnding();
  if (
    !snapshot.hasLoneCarriageReturn &&
    (endings.size === 0 ||
      (endings.size === 1 && (!preferredEnding || endings.has(preferredEnding))))
  )
    return null;
  const selections = editor.getSelectionsOrderedByBufferPosition();
  const plans = [];
  const bounds = (selection) => {
    if (!selection.isEmpty()) return selection.getBufferRowRange();
    const { start } = selection.getScreenRange();
    const range = editor.bufferRangeForScreenRange([
      [start.row, 0],
      [start.row + 1, 0],
    ]);
    return [
      range.start.row,
      range.end.row > range.start.row && range.end.column === 0 ? range.end.row - 1 : range.end.row,
    ];
  };
  for (let index = selections.length - 1; index >= 0; index--) {
    const last = index;
    let [startRow, endRow] = bounds(selections[index]);
    endRow++;
    while (index > 0 && bounds(selections[index - 1])[1] === startRow)
      startRow = bounds(selections[--index])[0];
    const range = buffer.clipRange([
      [startRow, 0],
      [endRow, 0],
    ]);
    const startOffset = snapshot.offsetAt(range.start);
    const original = buffer.getTextSnapshotInRange(range);
    const position = buffer.clipPosition([endRow, 0]);
    const ending =
      buffer.getPreferredLineEnding() ||
      buffer.lineEndingForRow(position.row) ||
      buffer.lineEndingForRow(position.row - 1);
    const prefix = endRow > buffer.getLastRow() ? ending || "\n" : "";
    const selected = selections.slice(index, last + 1).map((selection) => ({
      selection,
      range: selection.getBufferRange(),
      reversed: selection.isReversed(),
    }));
    const folds = editor.displayLayer.foldsIntersectingBufferRange(range).map((fold) => {
      const folded = editor.displayLayer.bufferRangeForFold(fold);
      return new Range(
        folded.start.compare(range.start) < 0 ? range.start : folded.start,
        folded.end.compare(range.end) > 0 ? range.end : folded.end,
      );
    });
    const offsets = [];
    for (const item of [...selected, ...folds.map((range) => ({ range }))])
      offsets.push(
        snapshot.offsetAt(buffer.clipPosition(item.range.start)) - startOffset,
        snapshot.offsetAt(buffer.clipPosition(item.range.end)) - startOffset,
      );
    plans.push({
      range,
      position,
      original,
      ending,
      prefix,
      selected,
      folds,
      offsets,
    });
  }
  if (
    !plans.some(
      (plan) =>
        plan.original.length > 1024 * 1024 && needsNormalization(plan.original, plan.ending),
    )
  )
    return null;
  const current = editor.captureTextMutationGuard(options);
  const expectedRevision = buffer.getTextRevision();
  const mode = buffer.getLanguageMode();
  const preferred = buffer.getPreferredLineEnding();
  const check = () => {
    if (
      !current() ||
      options.signal?.aborted ||
      buffer.getLanguageMode() !== mode ||
      buffer.getPreferredLineEnding() !== preferred
    )
      throw Object.assign(new Error("Line duplication cancelled"), { name: "AbortError" });
  };
  return (async () => {
    for (const plan of plans) {
      check();
      const anchors = plan.offsets.map((offset) =>
        Math.max(0, Math.min(plan.original.length, offset)),
      );
      const normalized = await normalize(plan.original, plan.ending, anchors, check);
      plan.normalized = normalized;
      plan.text = plan.prefix ? normalized.source.replace(0, 0, plan.prefix) : normalized.source;
    }
    check();
    let insertedUnits = 0;
    const edits = plans
      .slice()
      .reverse()
      .map((plan) => {
        plan.finalStart = snapshot.offsetAt(plan.position) + insertedUnits;
        insertedUnits += plan.text.length;
        return { range: [plan.position, plan.position], text: plan.text };
      });
    return buffer.applyTextEdits(edits, {
      expectedRevision,
      signal: options.signal,
      isCurrent: () => {
        check();
        return true;
      },
      didCommit() {
        const after = buffer.getTextSnapshot();
        for (const plan of plans) {
          const point = (index) =>
            after.positionAt(plan.finalStart + plan.normalized.offsets[index] + plan.prefix.length);
          let anchor = 0;
          for (const item of plan.selected) {
            item.selection.setBufferRange(new Range(point(anchor++), point(anchor++)), {
              reversed: item.reversed,
              autoscroll: false,
            });
          }
          for (let index = 0; index < plan.folds.length; index++) {
            const range = new Range(point(anchor), point(anchor + 1));
            anchor += 2;
            editor.displayLayer.foldBufferRange(range);
          }
        }
        editor.getLastSelection().autoscroll();
      },
    });
  })();
}

module.exports = { duplicateWithNormalization, normalize };
