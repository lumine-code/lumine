// Owns the parser's view of committed document revisions. It never edits text
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
    if (previous && next !== revision && this.revision === revision) {
      for (const batch of this.batches) {
        if (batch.beforeRevision !== next) continue;
        for (const { startIndex, oldEndIndex, newText } of batch.changes) {
          edits.push(Object.freeze({ startIndex, oldEndIndex, newText }));
        }
        next = batch.afterRevision;
        if (next === revision) break;
      }
    }
    // A gap or an in-transaction live read requires a fresh parse, not guessed
    // intermediate coordinates. The original snapshot remains untouched.
    if (next !== revision) return { text, revision, previous: null, edits: [] };
    Object.freeze(edits);
    if (previous) this.editLists.set(previous.revision, edits);
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
