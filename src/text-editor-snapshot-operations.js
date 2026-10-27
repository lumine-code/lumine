const { transformSnapshot, transformSnapshotSync } = require("./text-snapshot-transforms");
const ASYNC_TRANSFORM_UNITS = 1024 * 1024;

function transformSelections(editor, kind, options = {}) {
  if (kind !== "reverse") {
    editor.mergeIntersectingSelections(() => {
      for (const selection of editor.getSelections())
        if (selection.isEmpty()) selection.selectWord();
    });
  }
  const buffer = editor.getBuffer();
  const plans = editor.getSelectionsOrderedByBufferPosition().map((selection) => {
    const range = selection.getBufferRange();
    return {
      selection,
      range,
      reversed: selection.isReversed(),
      source: buffer.getTextSnapshotInRange(range),
    };
  });
  const isCurrent = editor.captureTextMutationGuard(options);
  const check = () => {
    if (options.signal?.aborted || !isCurrent())
      throw Object.assign(
        new Error("Text transformation was cancelled because its document or selections changed"),
        { name: "AbortError" },
      );
  };
  const apply = () => {
    check();
    return editor.transact(() => {
      for (let i = plans.length - 1; i >= 0; i--) {
        const { selection, range, source, transformed, reversed } = plans[i];
        if (kind === "reverse" && range.isEmpty()) {
          // Preserve the existing adjacent-character operation for cursors.
          selection.selectRight();
          const moved = selection.getBufferRange();
          const text = selection.getText();
          const transfer = { start: moved.start, end: moved.end, target: moved.start };
          buffer.transact({ textTransfers: [transfer] }, () => {
            selection.delete(options);
            selection.cursor.moveLeft();
            transfer.target = selection.cursor.getBufferPosition();
            selection.insertText(text, options);
          });
        } else if (source.length && transformed !== source) {
          const inserted = buffer.setTextInRange(range, transformed, {
            normalizeLineEndings: false,
          });
          if (kind === "reverse")
            selection.cursor.setBufferPosition(inserted.end, { autoscroll: false });
          else selection.setBufferRange(inserted, { reversed, autoscroll: false });
        }
      }
      editor.getLastSelection().autoscroll();
      return true;
    });
  };
  const units = plans.reduce((sum, plan) => sum + plan.source.length, 0);
  if (units <= ASYNC_TRANSFORM_UNITS) {
    for (const plan of plans) plan.transformed = transformSnapshotSync(plan.source, kind);
    return apply();
  }
  return (async () => {
    try {
      for (const plan of plans)
        plan.transformed = await transformSnapshot(plan.source, kind, { check });
      return apply();
    } catch (error) {
      if (error.name === "AbortError") return false;
      throw error;
    }
  })();
}

module.exports = { transformSelections, ASYNC_TRANSFORM_UNITS };
function insertPreparedSource(selection, source, options = {}) {
  if (!selection.ensureWritable("insertText", options)) return;
  const range = selection.getBufferRange(),
    reversed = selection.isReversed();
  selection.clear(options);
  const inserted = selection.editor.buffer.setTextInRange(range, source, {
    undo: options.undo,
    normalizeLineEndings: options.normalizeLineEndings,
  });
  if (options.select) selection.setBufferRange(inserted, { reversed });
  else if (reversed) selection.cursor.setBufferPosition(inserted.end);
  if (options.autoscroll ?? selection.isLastSelection())
    selection.autoscroll({ mode: options.mode });
  return inserted;
}

function insertedSourceEvent(source, range) {
  const event = { range };
  Object.defineProperties(event, {
    textSource: { value: source },
    text: { enumerable: true, get: () => source.toString() },
  });
  return event;
}
module.exports.insertPreparedSource = insertPreparedSource;
module.exports.insertedSourceEvent = insertedSourceEvent;
