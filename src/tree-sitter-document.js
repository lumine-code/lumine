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
    for (const change of batch.changes)
      this.textUnits += change.oldText.length + change.newText.length;
    while (this.changeCount > this.maxChanges || this.textUnits > this.maxTextUnits) {
      const removed = this.batches.shift();
      this.changeCount -= removed.changes.length;
      for (const change of removed.changes)
        this.textUnits -= change.oldText.length + change.newText.length;
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
      this.textSnapshot = Object.freeze({ revision, text: this.buffer.getText() });
    }
    const { text } = this.textSnapshot;
    const cached = previous && this.editLists.get(previous.revision);
    if (cached && this.revision === revision) return { text, revision, previous, edits: cached };
    const edits = [];
    let next = previous?.revision;
    let textUnits = 0;
    const append = (batch) => {
      for (const {
        startIndex,
        oldEndIndex,
        oldText,
        newText,
        oldRange,
        newRange,
      } of batch.changes) {
        textUnits += oldText.length + newText.length;
        edits.push(
          Object.freeze({
            startIndex,
            oldEndIndex,
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
