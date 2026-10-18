const PieceTree = require("./piece-tree");

function range(start, end) {
  return Object.freeze({ start: Object.freeze(start), end: Object.freeze(end) });
}

function change(before, after, startIndex, removed, inserted) {
  const oldEndIndex = startIndex + removed.length;
  const newEndIndex = startIndex + inserted.length;
  return Object.freeze({
    startIndex,
    oldEndIndex,
    newEndIndex,
    oldRange: range(before.positionAt(startIndex), before.positionAt(oldEndIndex)),
    newRange: range(after.positionAt(startIndex), after.positionAt(newEndIndex)),
    removed,
    inserted,
    // Text payloads stay as shared pieces until a string consumer requests them.
    get oldText() {
      return removed.toString();
    },
    get newText() {
      return inserted.toString();
    },
  });
}

class ChangeSet {
  constructor(changes) {
    this.changes = Object.freeze(changes.slice());
    Object.freeze(this);
  }

  mapIndex(index, affinity = "right") {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("Invalid offset");
    if (affinity !== "left" && affinity !== "right") throw new RangeError("Invalid affinity");
    for (const { startIndex, oldEndIndex, newEndIndex } of this.changes) {
      if (index < startIndex) continue;
      if (index > oldEndIndex || (index === oldEndIndex && oldEndIndex > startIndex))
        index += newEndIndex - oldEndIndex;
      else index = affinity === "left" ? startIndex : newEndIndex;
    }
    return index;
  }

  invert() {
    return new ChangeSet(
      this.changes
        .slice()
        .reverse()
        .map((entry) =>
          Object.freeze({
            startIndex: entry.startIndex,
            oldEndIndex: entry.newEndIndex,
            newEndIndex: entry.oldEndIndex,
            oldRange: entry.newRange,
            newRange: entry.oldRange,
            removed: entry.inserted,
            inserted: entry.removed,
            get oldText() {
              return entry.newText;
            },
            get newText() {
              return entry.oldText;
            },
          }),
        ),
    );
  }
}

// Drafts are private working states. No live text, observer or history changes
// until commit; nested command logic may read and edit the same explicit draft.
class DocumentDraft {
  #commit;
  #base;
  #text;
  #changes = [];
  #closed = false;

  constructor(base, commit) {
    this.#commit = commit;
    this.#base = base;
    this.#text = this.#base.text;
  }

  get text() {
    if (this.#closed) throw new Error("Draft is closed");
    return this.#text;
  }

  replace(start, end, text) {
    if (this.#closed) throw new Error("Draft is closed");
    const inserted = text instanceof PieceTree ? text : new PieceTree(text);
    const before = this.#text;
    const removed = before.subtext(start, end);
    if (removed.equals(inserted)) return this;
    const after = before.replace(start, end, inserted);
    this.#changes.push(change(before, after, start, removed, inserted));
    this.#text = after;
    return this;
  }

  // Batch offsets address the draft before this call. Overlaps and ambiguous
  // equal-position insertions reject before any draft state is changed.
  replaceAll(edits) {
    if (this.#closed) throw new Error("Draft is closed");
    const ordered = edits
      .map(({ start, end, text }) => ({ start, end, text }))
      .sort((a, b) => a.start - b.start);
    let previous;
    for (const edit of ordered) {
      this.#text.subtext(edit.start, edit.end);
      if (typeof edit.text !== "string" && !(edit.text instanceof PieceTree))
        throw new TypeError("Document text must be a string or piece tree");
      if (previous && (edit.start < previous.end || edit.start === previous.start))
        throw new RangeError("Batch edits overlap");
      previous = edit;
    }
    for (let index = ordered.length - 1; index >= 0; index--) {
      const { start, end, text } = ordered[index];
      this.replace(start, end, text);
    }
    return this;
  }

  commit() {
    if (this.#closed) throw new Error("Draft is closed");
    const commit = this.#commit;
    const base = this.#base;
    const text = this.#text;
    const changes = new ChangeSet(this.#changes);
    this.abort();
    return commit(base, text, changes);
  }

  abort() {
    this.#closed = true;
    this.#base = this.#text = this.#commit = null;
    this.#changes = [];
  }
}

// Persistent document kernel. TextStore disables its standalone history while
// the editor facade owns user-visible history, marker policy and notifications.
class DocumentCore {
  #snapshot;
  #undo = [];
  #redo = [];
  #listeners = new Set();
  #batches = [];
  #publishing = false;
  #historyLimit;

  constructor(text = "", { historyLimit = 100 } = {}) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0)
      throw new RangeError("Invalid history limit");
    this.#historyLimit = historyLimit;
    this.#snapshot = Object.freeze({
      revision: 0,
      text: text instanceof PieceTree ? text : new PieceTree(text),
    });
  }

  snapshot() {
    return this.#snapshot;
  }
  getTextSnapshot() {
    return this.#snapshot.text;
  }
  getTextRevision() {
    return this.#snapshot.revision;
  }
  getText() {
    return this.#snapshot.text.toString();
  }
  begin() {
    return new DocumentDraft(this.#snapshot, (base, text, changes) =>
      this.#commitDraft(base, text, changes),
    );
  }

  transact(callback) {
    const draft = this.begin();
    try {
      const result = callback(draft);
      if (result?.then) throw new TypeError("Document transactions must be synchronous");
      return draft.commit();
    } catch (error) {
      draft.abort();
      throw error;
    }
  }

  #commitDraft(base, text, changes) {
    if (base !== this.#snapshot) throw new Error("Draft revision is stale");
    if (changes.changes.length === 0) return null;
    const entry = { before: base.text, after: text, changes };
    if (this.#historyLimit) {
      this.#undo.push(entry);
      if (this.#undo.length > this.#historyLimit) this.#undo.shift();
    }
    this.#redo.length = 0;
    return this.#publish(text, changes, "edit");
  }

  undo() {
    const entry = this.#undo.pop();
    if (!entry) return null;
    this.#redo.push(entry);
    return this.#publish(entry.before, entry.changes.invert(), "undo");
  }

  redo() {
    const entry = this.#redo.pop();
    if (!entry) return null;
    this.#undo.push(entry);
    return this.#publish(entry.after, entry.changes, "redo");
  }

  clearHistory() {
    this.#undo.length = this.#redo.length = 0;
  }

  onDidApplyChanges(callback) {
    this.#listeners.add(callback);
    return { dispose: () => this.#listeners.delete(callback) };
  }

  #publish(text, changeSet, origin) {
    const beforeRevision = this.#snapshot.revision;
    this.#snapshot = Object.freeze({ revision: beforeRevision + 1, text });
    const snapshot = this.#snapshot;
    const batch = Object.freeze({
      beforeRevision,
      afterRevision: snapshot.revision,
      snapshot,
      changeSet,
      changes: changeSet.changes,
      origin,
      isCurrent: () => this.#snapshot === snapshot,
    });
    this.#batches.push(batch);
    if (!this.#publishing) {
      this.#publishing = true;
      const errors = [];
      try {
        while (this.#batches.length) {
          const next = this.#batches.shift();
          for (const listener of [...this.#listeners]) {
            try {
              listener(next);
            } catch (error) {
              errors.push(error);
            }
          }
        }
      } finally {
        this.#publishing = false;
      }
      if (errors.length) throw new AggregateError(errors, "Document observer failed after commit");
    }
    return batch;
  }
}

module.exports = { DocumentCore, ChangeSet };
