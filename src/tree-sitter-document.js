const { PieceTree } = require("./text-model");

// Owns the parser's view of applied document revisions. It never edits text
// or trees and never infers offsets from clipped buffer positions.
class TreeSitterDocument {
  constructor(buffer, { maxChanges = 10000, maxTextUnits = 8 * 1024 * 1024 } = {}) {
    this.buffer = buffer;
    this.revision = buffer.getTextRevision();
    this.maxChanges = maxChanges;
    this.maxTextUnits = maxTextUnits;
    this.batches = [];
    this.changeCount = 0;
    this.textUnits = 0;
    this.textSnapshot = null;
    this.editLists = new Map();
    this.subscription = buffer.onDidApplyChanges((batch) => this.apply(batch));
  }

  apply(batch) {
    if (this.closed) return;
    this.editLists.clear();
    if (batch.beforeRevision !== this.revision) this.clearHistory();
    this.revision = batch.afterRevision;
    this.batches.push(batch);
    this.changeCount += batch.changes.length;
    for (const change of batch.changes) this.textUnits += changeTextUnits(change);
    while (this.changeCount > this.maxChanges || this.textUnits > this.maxTextUnits) {
      const removed = this.batches.shift();
      this.changeCount -= removed.changes.length;
      for (const change of removed.changes) this.textUnits -= changeTextUnits(change);
    }
    if (this.textSnapshot?.revision !== this.buffer.getTextRevision()) this.textSnapshot = null;
  }

  clearHistory() {
    this.batches.length = 0;
    this.changeCount = 0;
    this.textUnits = 0;
    this.editLists.clear();
  }

  capture(previous = null) {
    if (this.closed) throw new Error("Parser document is closed");
    const revision = this.buffer.getTextRevision();
    if (this.textSnapshot?.revision !== revision) {
      this.textSnapshot = Object.freeze({
        revision,
        text: this.buffer.getTextSnapshot?.() ?? this.buffer.getText(),
      });
    }
    const { text } = this.textSnapshot;
    const cached = previous && this.editLists.get(previous.revision);
    if (cached && this.revision === revision) return { text, revision, previous, edits: cached };
    let edits = [];
    let next = previous?.revision;
    let textUnits = 0;
    const append = (batch) => {
      for (const change of batch.changes) {
        const { startIndex, oldEndIndex, oldRange, newRange } = change;
        const newText = change.inserted ?? change.newText;
        textUnits += changeTextUnits(change);
        edits.push(
          Object.freeze({
            startIndex,
            oldEndIndex,
            newEndIndex: change.newEndIndex ?? startIndex + newText.length,
            newText,
            ...(oldRange && newRange
              ? {
                  startPosition: oldRange.start,
                  oldEndPosition: oldRange.end,
                  newEndPosition: newRange.end,
                }
              : {}),
          }),
        );
      }
      next = batch.afterRevision;
    };
    if (previous && next !== revision) {
      for (const batch of this.batches) {
        if (batch.beforeRevision !== next) continue;
        append(batch);
        if (next === revision) break;
      }
      if (next !== revision) {
        const pending = this.buffer.getPendingAppliedChanges?.();
        if (pending?.beforeRevision === next && pending.afterRevision === revision) append(pending);
      }
    }
    // Never bridge a gap by guessing offsets. Pending edits have the same
    // exact coordinates as the eventual event, but remain private until then.
    if (next !== revision || edits.length > this.maxChanges || textUnits > this.maxTextUnits)
      return { text, revision, previous: null, edits: [] };
    if (edits.length >= 32) edits = coalesceEdits(edits, text);
    Object.freeze(edits);
    if (previous && this.revision === revision) this.editLists.set(previous.revision, edits);
    return { text, revision, previous, edits };
  }

  isCurrent(snapshot) {
    return !this.closed && snapshot.revision === this.buffer.getTextRevision();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.subscription.dispose();
    this.clearHistory();
    this.textSnapshot = null;
  }
}

module.exports = TreeSitterDocument;

function changeTextUnits(change) {
  return (
    (change.removed?.length ?? change.oldText.length) +
    (change.inserted?.length ?? change.newText.length)
  );
}

// Compose only consecutive, touching replacements. Parsing consumes coordinates;
// inserted text is materialized only if an explicit consumer asks for it.
function coalesceEdits(edits, text) {
  const result = [];
  let current,
    first = 0;
  const shift = (point, before, after) =>
    Object.freeze({
      row: after.row + point.row - before.row,
      column: point.row === before.row ? after.column + point.column - before.column : point.column,
    });
  const flush = (end) => {
    if (!current) return;
    if (end === first + 1) {
      result.push(edits[first]);
      return;
    }
    const from = first,
      record = current;
    let inserted;
    Object.defineProperty(record, "newText", {
      get() {
        if (inserted === undefined) {
          // A single connected group describes this exact final snapshot.
          // Multiple groups keep their intermediate sequential text instead.
          inserted =
            from === 0 && end === edits.length
              ? (text.subtext?.(record.startIndex, record.newEndIndex) ??
                text.slice(record.startIndex, record.newEndIndex))
              : materializeEdits(edits, from, end);
        }
        return inserted;
      },
    });
    result.push(Object.freeze(record));
  };
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i],
      end = current?.newEndIndex;
    if (
      !current?.startPosition ||
      !edit.startPosition ||
      edit.startIndex > end ||
      edit.oldEndIndex < current.startIndex
    ) {
      flush(i);
      first = i;
      current = { ...edit };
      continue;
    }
    if (edit.oldEndIndex > end) {
      current.oldEndIndex += edit.oldEndIndex - end;
      current.oldEndPosition = shift(
        edit.oldEndPosition,
        current.newEndPosition,
        current.oldEndPosition,
      );
    }
    current.newEndIndex = Math.max(end, edit.oldEndIndex) + edit.newEndIndex - edit.oldEndIndex;
    current.newEndPosition =
      edit.oldEndIndex >= end
        ? edit.newEndPosition
        : shift(current.newEndPosition, edit.oldEndPosition, edit.newEndPosition);
    if (edit.startIndex < current.startIndex) {
      current.startIndex = edit.startIndex;
      current.startPosition = edit.startPosition;
    }
  }
  flush(edits.length);
  return result;
}

function materializeEdits(edits, first, end) {
  let start = edits[first].startIndex;
  let text = edits[first].newText;
  if (!(text instanceof PieceTree)) text = new PieceTree(text);
  for (let i = first + 1; i < end; i++) {
    const edit = edits[i];
    text = text.replace(
      Math.max(0, edit.startIndex - start),
      Math.min(text.length, edit.oldEndIndex - start),
      edit.newText,
    );
    start = Math.min(start, edit.startIndex);
  }
  return text;
}
