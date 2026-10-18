const { Parser } = require("web-tree-sitter");
require("./tree-sitter-cursor");

const metadata = new WeakMap();
const BULK_EDIT_LIMIT = 128;
const ASYNC_SLICE_MS = 4;
const yieldTask = () => new Promise((resolve) => setImmediate(resolve));

function positionAt(text, index) {
  let row = 0,
    start = 0;
  for (
    let next = text.indexOf("\n");
    next !== -1 && next < index;
    next = text.indexOf("\n", next + 1)
  ) {
    row++;
    start = next + 1;
  }
  return { row, column: index - start };
}

function isBulkChange(previous, edits) {
  if (!previous) return true;
  if (edits.length >= BULK_EDIT_LIMIT) return true;
  let changed = 0;
  for (const edit of edits) changed += edit.oldEndIndex - edit.startIndex + edit.newText.length;
  return changed >= 8192 && changed >= previous.input.length / 2;
}

function applyEdits(tree, previous, text, edits) {
  let source = previous.input;
  const replay = edits.some((edit) => !edit.startPosition);
  for (const edit of edits) {
    const { startIndex, oldEndIndex, newText } = edit;
    const startPosition = edit.startPosition ?? positionAt(source, startIndex);
    const oldEndPosition = edit.oldEndPosition ?? positionAt(source, oldEndIndex);
    const extent = positionAt(newText, newText.length);
    const newEndPosition = edit.newEndPosition ?? {
      row: startPosition.row + extent.row,
      column: extent.row ? extent.column : startPosition.column + extent.column,
    };
    tree.edit({
      startIndex,
      oldEndIndex,
      newEndIndex: startIndex + newText.length,
      startPosition,
      oldEndPosition,
      newEndPosition,
    });
    // Document journals already carry coordinates. Synthetic boundary edits
    // are coordinate-neutral; only callers without coordinates need replay.
    if (replay) source = source.slice(0, startIndex) + newText + source.slice(oldEndIndex);
  }
  tree.textCallback = (index) => text.slice(index);
  return tree;
}

function publish(tree, text, revision, incremental, changedRanges = []) {
  metadata.set(tree, { text, revision });
  Object.defineProperties(tree, {
    input: { value: text },
    revision: { value: revision },
    incremental: { value: incremental },
    changedRanges: {
      value: Object.freeze(
        changedRanges.map((range) =>
          Object.freeze({
            ...range,
            startPosition: Object.freeze({ ...range.startPosition }),
            endPosition: Object.freeze({ ...range.endPosition }),
          }),
        ),
      ),
    },
    edit: {
      value() {
        throw new Error("Cannot edit a published syntax tree; copy it first");
      },
    },
    delete: {
      value() {
        throw new Error("Published syntax trees follow their consumers' lifetimes");
      },
    },
  });
  return tree;
}

// Owns a private editable tree and a resumable WASM parse. Published trees
// remain valid for consumers holding nodes or cursors from older revisions.
class TreeSitterParser {
  constructor(language) {
    this.language = language;
    this.parser = new Parser().setLanguage(language);
    this.pending = null;
    this.closed = false;
    this.running = false;
    this.executing = false;
    this.disposed = false;
  }

  static isBulkChange(previous, edits) {
    return isBulkChange(previous, edits);
  }

  static prepareTree(previous, text, { edits = [] } = {}) {
    return applyEdits(previous.copy(), previous, text, edits);
  }

  static reuseSnapshot(previous, text, { edits = [], includedRanges, revision = 0 } = {}) {
    if (!metadata.has(previous) || !includedRanges?.length || isBulkChange(previous, edits))
      return null;
    const before = previous.getIncludedRanges();
    if (before.length !== includedRanges.length) return null;
    const shift = includedRanges[0].startPosition.row - before[0].startPosition.row;
    for (let i = 0; i < before.length; i++) {
      const a = before[i],
        b = includedRanges[i];
      if (
        a.endIndex > previous.input.length ||
        b.endIndex > text.length ||
        b.startPosition.row - a.startPosition.row !== shift ||
        b.endPosition.row - a.endPosition.row !== shift ||
        a.startPosition.column !== b.startPosition.column ||
        a.endPosition.column !== b.endPosition.column ||
        previous.input.slice(a.startIndex, a.endIndex) !== text.slice(b.startIndex, b.endIndex)
      )
        return null;
      const first = previous.input.charCodeAt(a.startIndex),
        last = previous.input.charCodeAt(a.endIndex - 1);
      if (
        (first >= 0xdc00 && first <= 0xdfff) ||
        (last >= 0xd800 && last <= 0xdbff) ||
        (first === 0xfeff && (a.startIndex === 0) !== (b.startIndex === 0))
      )
        return null;
    }
    const tree = this.prepareTree(previous, text, { edits });
    const shifted = tree.getIncludedRanges();
    const matches =
      shifted.length === includedRanges.length &&
      shifted.every((a, i) => {
        const b = includedRanges[i];
        return (
          a.startIndex === b.startIndex &&
          a.endIndex === b.endIndex &&
          a.startPosition.row === b.startPosition.row &&
          a.startPosition.column === b.startPosition.column &&
          a.endPosition.row === b.endPosition.row &&
          a.endPosition.column === b.endPosition.column
        );
      });
    if (!matches) {
      tree.delete();
      return null;
    }
    return publish(tree, text, revision, true);
  }

  begin(text, options) {
    if (this.closed) throw new Error("Parser is closed");
    const { previous = null, edits = [], revision = 0, includedRanges } = options;
    if (this.pending) {
      const job = this.pending;
      if (
        job.text === text &&
        job.previous === previous &&
        (job.edits === edits || (!job.edits.length && !edits.length)) &&
        job.revision === revision &&
        job.includedRanges === includedRanges
      )
        return job;
      this.resetPending();
    }
    const incremental =
      previous?.language === this.language &&
      metadata.has(previous) &&
      !isBulkChange(previous, edits);
    const oldTree = incremental ? TreeSitterParser.prepareTree(previous, text, { edits }) : null;
    return (this.pending = {
      text,
      previous,
      edits,
      revision,
      includedRanges,
      oldTree,
      incremental,
    });
  }

  step(job, deadline, signal) {
    signal?.throwIfAborted();
    let tree;
    this.executing = true;
    try {
      tree = this.parser.parse(job.text, job.oldTree, {
        includedRanges: job.includedRanges,
        progressCallback: () => this.closed || signal?.aborted || performance.now() >= deadline,
      });
    } finally {
      this.executing = false;
      if (this.closed) {
        tree?.delete();
        this.dispose();
      }
    }
    if (this.closed) return null;
    if (signal?.aborted) {
      tree?.delete();
      signal.throwIfAborted();
    }
    if (!tree) return null;
    try {
      const changed = job.oldTree ? job.oldTree.getChangedRanges(tree) : [];
      return publish(tree, job.text, job.revision, job.incremental, changed);
    } catch (error) {
      tree.delete();
      throw error;
    } finally {
      job.oldTree?.delete();
      this.pending = null;
    }
  }

  parseSync(text, options = {}) {
    if (this.running) throw new Error("Parser already has an active parse");
    this.running = true;
    try {
      return this.step(this.begin(text, options), Infinity, options.signal);
    } catch (error) {
      this.resetPending();
      throw error;
    } finally {
      this.running = false;
    }
  }

  tryParseSync(text, options = {}) {
    if (this.running) throw new Error("Parser already has an active parse");
    this.running = true;
    const deadline = options.deadline ?? performance.now() + (options.timeoutMicros ?? 5000) / 1000;
    try {
      if (performance.now() >= deadline) return null;
      return this.step(this.begin(text, options), deadline, options.signal);
    } catch (error) {
      this.resetPending();
      throw error;
    } finally {
      this.running = false;
    }
  }

  async parse(text, options = {}) {
    if (this.running) throw new Error("Parser already has an active parse");
    this.running = true;
    try {
      const job = this.begin(text, options);
      for (;;) {
        await yieldTask();
        if (this.closed) return null;
        options.signal?.throwIfAborted();
        const deadline = options.deadlineForSlice?.() ?? performance.now() + ASYNC_SLICE_MS;
        if (performance.now() >= deadline) continue;
        const tree = this.step(job, deadline, options.signal);
        if (this.closed) return null;
        if (tree) return tree;
      }
    } catch (error) {
      this.resetPending();
      throw error;
    } finally {
      this.running = false;
    }
  }

  reset() {
    if (this.running)
      throw new Error("Cannot reset an active parse; cancel it or close the parser");
    this.resetPending();
  }

  resetPending() {
    if (!this.disposed) this.parser.reset();
    this.pending?.oldTree?.delete();
    this.pending = null;
  }

  getLogger() {
    return this.closed ? null : this.parser.getLogger();
  }

  setLogger(logger) {
    if (this.running || this.closed)
      throw new Error("Cannot change the logger of an active or closed parser");
    this.parser.setLogger(logger);
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.resetPending();
    this.parser.delete();
    this.disposed = true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.executing) this.dispose();
  }
}

module.exports = TreeSitterParser;
