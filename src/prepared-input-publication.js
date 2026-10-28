const Range = require("./range");
const { TextPatch } = require("./text-model");
const markerEvents = require("./text-buffer-marker-events");
const DefaultHistoryProvider = require("./default-history-provider");
const editsForMap = require("./text-change-map-edits");

function* localEdits(changes) {
  for (const change of changes) {
    if (change.coordinateMap?.runs) yield* editsForMap(change.coordinateMap);
    else yield change;
  }
}

function backupHistory(history) {
  if (history instanceof DefaultHistoryProvider) {
    const undo = history.undoStack.slice(),
      redo = history.redoStack.slice(),
      checkpoint = history.nextCheckpointId;
    return () => {
      history.undoStack = undo.slice();
      history.redoStack = redo.slice();
      history.nextCheckpointId = checkpoint;
    };
  }
  const snapshot = history.getSnapshot(Infinity);
  return () => history.restoreFromSnapshot(snapshot);
}

function containsTransfer(map) {
  return Boolean(map?.transfers?.length || map?.maps?.some(containsTransfer));
}

function useLocalPresentation(changes, edits, map) {
  if (!changes.length || edits.length < 2 || edits.length > 64 || containsTransfer(map))
    return false;
  const span = changes.at(-1).oldEnd.row - changes[0].oldStart.row;
  const touched = edits.reduce((count, edit) => {
    const change = edit.getChange();
    return count + change.oldEnd.row - change.oldStart.row + 1;
  }, 0);
  return span > Math.max(256, touched * 8);
}

// A prepared keystroke is a local edit, even when its document has millions of
// annotations. Replay its real splices on the live indexes in one synchronous
// transaction. Only opted-in marker layers belong in undo history.
module.exports = async function publishPreparedInput({
  buffer,
  changes,
  appliedChanges,
  coordinateMap,
  finalSource,
  check,
  finalize,
  groupingInterval,
  withPublication = (callback) => callback(),
}) {
  check();
  buffer.assertCanEdit();
  const context = { token: Symbol("prepared input publication") };
  const errors = [];
  const attempt = (callback) => {
    try {
      return callback();
    } catch (error) {
      errors.push(error);
    }
  };
  const prepared = await buffer.buffer.preparePublication(localEdits(appliedChanges), { check });
  let presentation;
  try {
    if (!prepared.snapshot.equals(finalSource))
      throw new Error("Prepared input journal does not produce its final snapshot");
    const patch = TextPatch.fromIndependentChanges(changes);
    if (!patch) throw new Error("Prepared input history is not a canonical text patch");
    patch.coordinateMap = coordinateMap;
    if (changes.length) {
      const first = changes[0],
        last = changes.at(-1);
      const inserted = finalSource.subtext(
        finalSource.offsetAt(first.newStart),
        finalSource.offsetAt(last.newEnd),
      );
      presentation = buffer.buffer.prepareEdit(new Range(first.oldStart, last.oldEnd), inserted);
    }
    const event =
      presentation &&
      buffer.changeEventForPreparedEdit(presentation.getChange(), "edit", { coordinateMap });
    const localEvents = useLocalPresentation(changes, prepared.edits, coordinateMap)
      ? prepared.edits.map((edit) => buffer.changeEventForPreparedEdit(edit.getChange()))
      : null;
    check();
    prepared.validate();
    return withPublication(() => {
      let committed = false,
        failure,
        events;
      const restoreHistory = backupHistory(buffer.historyProvider);
      buffer.atomicEditContext = context;
      try {
        buffer.transact({ atomicToken: context.token, groupingInterval, coordinateMap }, () => {
          // Do not throw out of a transaction before its first publication:
          // its normal rollback is an edit and cannot run under our lock.
          try {
            buffer.emitWillChangeEvent();
            check();
            prepared.validate();
            if (localEvents?.length)
              buffer.prepareDisplayLayersForChange(localEvents[0], prepared.edits[0].snapshot);
            else if (event) buffer.prepareDisplayLayersForChange(event, finalSource);
            // A custom history provider can reject a patch, including after
            // modifying its own stacks. Restore it before any live text or
            // marker is touched, rather than attempting an inverse text edit.
            buffer.historyProvider.pushPatch(patch);
            events = markerEvents.begin(buffer);
          } catch (error) {
            failure = error;
            restoreHistory();
            return;
          }
          committed = true;
          for (const [index, edit] of prepared.edits.entries()) {
            // Widely separated small edits must not rebuild layout in their
            // unchanged gaps. These updates remain in the same synchronous
            // transaction; display and marker observers publish at its end.
            if (localEvents && index > 0)
              attempt(() =>
                buffer.prepareDisplayLayersForChange(localEvents[index], edit.snapshot),
              );
            buffer.applyChange(edit, {
              atomicToken: context.token,
              skipDisplayPreparation: true,
              deferDidChange: true,
              collectErrors: (error) => errors.push(error),
            });
            if (localEvents) attempt(() => buffer.emitDidChangeEvent(localEvents[index]));
          }
          if (event && !localEvents) attempt(() => buffer.emitDidChangeEvent(event));
          attempt(finalize);
          attempt(() => require("./text-buffer-marker-finalizers").run(buffer));
          context.selectionFinalizersHandled = true;
          events.flush(errors);
        });
      } catch (error) {
        if (committed) errors.push(error);
        else {
          failure ??= error;
          restoreHistory();
        }
      } finally {
        if (committed) events?.flush(errors);
        events?.dispose();
        buffer.atomicEditContext = null;
        if (context.historyProviderUpdates?.has(buffer))
          buffer.setHistoryProvider(context.historyProviderUpdates.get(buffer));
      }
      if (failure) throw failure;
      if (errors.length)
        throw Object.assign(
          new Error("Text input was committed, but an observer failed", {
            cause: new AggregateError(errors),
          }),
          { code: "ERR_EDIT_OBSERVER_FAILED", committed: true },
        );
    });
  } finally {
    presentation?.dispose();
    prepared.dispose();
  }
};
