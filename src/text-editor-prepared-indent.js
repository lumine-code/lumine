const { CompositeDisposable } = require("@lumine-code/event-kit");
const TextBuffer = require("./text-buffer");
const { PieceTree } = require("./text-model");
const TextChangeMap = require("./text-change-map");
const CoordinateMarkerPlan = require("./coordinate-marker-plan");
const { inspectRows, indentSource } = require("./text-editor-comment-operations");
const { autoIndentRanges, mergeRanges } = require("./text-editor-auto-indent");
const { insertPreparedSource, insertedSourceEvent } = require("./text-editor-snapshot-operations");
const pending = new WeakMap();
const queues = new WeakMap();
const pause = () => new Promise((resolve) => setImmediate(resolve));
const aborted = () =>
  Object.assign(new Error("Prepared indentation edit was cancelled"), { name: "AbortError" });

function applies(mode, data, options) {
  return (
    options.autoIndent &&
    typeof mode.scanPreparedIndentation === "function" &&
    [data.text, ...(data.metadata?.selections?.map((s) => s.text) ?? [])].some(
      (text) =>
        typeof text === "string" &&
        (text.length > 65536 || (text.includes("\n") && /\S/.test(text))),
    )
  );
}

async function sourceFor(text, check) {
  if (typeof text !== "string") throw new TypeError("Clipboard text must be a string");
  let source = new PieceTree(),
    nonblank = false,
    deadline = performance.now() + 4;
  for (let offset = 0; offset < text.length; offset += 65536) {
    check();
    const part = text.slice(offset, offset + 65536);
    nonblank ||= /\S/.test(part);
    source = source.replace(source.length, source.length, part);
    if (performance.now() >= deadline) {
      await pause();
      check();
      deadline = performance.now() + 4;
    }
  }
  return { source, nonblank };
}

async function adjustBasis(editor, source, delta, check) {
  if (!delta || source.lineCount < 2) return source;
  if (!Number.isFinite(delta)) throw new RangeError("Invalid clipboard indentation basis");
  const buffer = new TextBuffer({ text: source });
  const inspect = inspectRows(source, editor.getTabLength(), check);
  try {
    async function* edits() {
      let deadline = performance.now() + 4;
      for (let row = 1; row < source.lineCount; row++) {
        check();
        if (performance.now() >= deadline) {
          await pause();
          check();
          deadline = performance.now() + 4;
        }
        const start = source.lineStart(row);
        const end = row + 1 < source.lineCount ? source.lineStart(row + 1) - 1 : source.length;
        if (start === end) continue;
        if (delta > 0)
          yield {
            range: [
              [row, 0],
              [row, 0],
            ],
            text: indentSource(editor, delta),
          };
        else {
          const info = await inspect(row);
          if (info.indentLength)
            yield {
              range: [
                [row, 0],
                [row, info.indentLength],
              ],
              text: indentSource(editor, Math.max(0, info.indentLevel + delta)),
            };
        }
      }
    }
    await buffer.applyTextEdits(edits());
    check();
    return buffer.getTextSnapshot();
  } finally {
    buffer.destroy();
  }
}

// Keep independent pastes independent, but never reindent the same row twice.
function rowRanges(records) {
  const result = [];
  for (const record of records
    .filter((r) => r.indent)
    .sort((a, b) => a.marker.getBufferRange().start.compare(b.marker.getBufferRange().start))) {
    const range = record.marker.getBufferRange();
    const start = range.start.row,
      end = range.end.row - (range.end.column === 0 ? 1 : 0);
    if (end < start) continue;
    const last = result.at(-1);
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

function moveSelectionRange(range, map) {
  if (map.maps) {
    for (const child of map.maps) range = moveSelectionRange(range, child);
    return range;
  }
  if (map.transfers) {
    for (const { start, end, target } of map.transfers) {
      const span = new TextBuffer.Range(start, end);
      if (span.containsRange(range) && range.start.compare(end) < 0) {
        const at = TextBuffer.Point.fromObject(target);
        return new TextBuffer.Range(
          at.traverse(range.start.traversalFrom(start)),
          at.traverse(range.end.traversalFrom(start)),
        );
      }
    }
  }
  const start = map.mapPoint(range.start, true);
  return new TextBuffer.Range(start, range.isEmpty() ? start : map.mapPoint(range.end, false));
}

async function prepare(editor, data, options, queue) {
  pending.get(editor)?.abort(aborted());
  const controller = new AbortController();
  pending.set(editor, controller);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const buffer = editor.getBuffer(),
    mode = buffer.getLanguageMode();
  const source = buffer.getTextSnapshot();
  const tabLength = editor.getTabLength(),
    softTabs = editor.getSoftTabs();
  const lineEnding = buffer.getPreferredLineEnding();
  const epoch = mode.getSyntaxRequestEpoch?.();
  const selections = editor.getSelections().map((selection) => ({
    selection,
    range: selection.getBufferRange(),
    reversed: selection.isReversed(),
  }));
  const current = editor.captureTextMutationGuard(options);
  const isCurrent = () =>
    current() &&
    !signal.aborted &&
    buffer.getLanguageMode() === mode &&
    mode.getSyntaxRequestEpoch?.() === epoch &&
    editor.getTabLength() === tabLength &&
    editor.getSoftTabs() === softTabs &&
    buffer.getPreferredLineEnding() === lineEnding &&
    editor
      .getSelections()
      .every(
        (selection, i) =>
          selection === selections[i]?.selection &&
          selection.isReversed() === selections[i].reversed,
      );
  const check = () => {
    if (!isCurrent()) throw aborted();
  };
  let publishing = false,
    staged,
    draft;
  const cancel = () => {
    if (!publishing) {
      queue.cancelled = true;
      controller.abort(aborted());
    }
  };
  const subscriptions = new CompositeDisposable(
    buffer.onDidApplyChanges(cancel),
    buffer.onDidChangeLanguageMode(cancel),
    buffer.onDidChangePath(cancel),
    buffer.onDidDestroy(cancel),
    editor.onDidDestroy(cancel),
    editor.onDidChangeSelectionRange(cancel),
    editor.onDidChangeReadOnly(cancel),
  );
  try {
    check();
    draft = new TextBuffer({
      text: source,
      preferredLineEnding: buffer.getPreferredLineEnding(),
      maxUndoEntries: Infinity,
    });
    const TextEditor = require("./text-editor");
    staged = new TextEditor({
      buffer: draft,
      tabLength,
      softTabs,
      softWrapped: false,
      autoIndent: false,
    });
    if (data.move) {
      subscriptions.add(editor.displayLayer.foldsMarkerLayer.onDidUpdate(cancel));
      for (const marker of editor.displayLayer.foldsMarkerLayer.getMarkers())
        staged.foldBufferRange(marker.getRange());
    }
    staged.suppressSelectionMerging = true;
    staged.setSelectedBufferRanges(
      selections.map((s) => s.range),
      { preserveFolds: true },
    );
    const owners = new Map(
      staged.getSelections().map((s, i) => {
        s.setBufferRange(selections[i].range, {
          reversed: selections[i].reversed,
          preserveFolds: true,
        });
        return [s, selections[i].selection];
      }),
    );
    const checkpoint = draft.createCheckpoint();
    const records = [];
    if (data.move) {
      staged[data.move](options);
      const movement = draft.historyProvider.getChangesSinceCheckpoint(checkpoint).coordinateMap;
      if (movement) {
        const translated = selections.map((s) => moveSelectionRange(s.range, movement));
        staged.setSelectedBufferRanges(translated, { preserveFolds: true, autoscroll: false });
        owners.clear();
        staged.getSelections().forEach((selection, i) => {
          selection.setBufferRange(translated[i], {
            reversed: selections[i].reversed,
            preserveFolds: true,
            autoscroll: false,
          });
          owners.set(selection, selections[i].selection);
        });
      }
    } else {
      const metadata = data.metadata ?? {};
      const targets = staged.getSelectionsOrderedByBufferPosition();
      const sources = new Map();
      for (let i = 0; i < targets.length; i++) {
        check();
        const selection = targets[i];
        const entry =
          metadata.selections?.length === targets.length ? metadata.selections[i] : metadata;
        const text = metadata.selections?.length === targets.length ? entry.text : data.text;
        // Hashing a clipboard-sized string can itself monopolize the renderer.
        const key =
          text.length > 65536
            ? metadata.selections?.length === targets.length
              ? entry
              : data
            : text;
        let input = sources.get(key);
        if (!input) {
          input = await sourceFor(text, check);
          sources.set(key, input);
        }
        let inserted = input.source;
        const oldPosition = selection.getBufferRange().start;
        const fullLine = entry.fullLine && selection.isEmpty();
        const prefix = draft.getTextSnapshotInRange([[oldPosition.row, 0], oldPosition]);
        const prefixInfo = await inspectRows(prefix, tabLength, check)(0);
        const multiline = input.source.lineCount > 1;
        const indent = (fullLine || prefixInfo.blank) && input.nonblank && multiline;
        const basis =
          entry.indentBasis != null && (multiline || prefixInfo.blank) ? entry.indentBasis : null;
        if (basis != null && !options.preserveTrailingLineIndentation) {
          const level = fullLine ? 0 : prefixInfo.indentLevel;
          inserted = await adjustBasis(staged, inserted, level - basis, check);
        } else if (
          basis == null &&
          indent &&
          !fullLine &&
          !options.preserveTrailingLineIndentation
        ) {
          // The first line already inherits the destination's whitespace prefix.
          // Give following clipboard lines that same origin before asking the
          // grammar for a relative pasted-block adjustment.
          inserted = await adjustBasis(staged, inserted, prefixInfo.indentLevel, check);
        }
        if (fullLine)
          selection.setBufferRange([
            [oldPosition.row, 0],
            [oldPosition.row, 0],
          ]);
        if (options.normalizeLineEndings !== false) {
          const row = selection.getBufferRange().start.row;
          const ending =
            draft.getPreferredLineEnding() ||
            draft.lineEndingForRow(row) ||
            draft.lineEndingForRow(row - 1);
          inserted = (
            await require("./text-editor-duplicate-lines").normalize(inserted, ending, [], check)
          ).source;
        }
        check();
        staged.transact(() => {
          const range = insertPreparedSource(selection, inserted, {
            ...options,
            undo: undefined,
            normalizeLineEndings: false,
            autoscroll: false,
          });
          records.push({ marker: staged.markBufferRange(range, { invalidate: "never" }), indent });
          if (fullLine) {
            const position = oldPosition.translate([1, 0]);
            selection.setBufferRange([position, position]);
          }
        });
      }
    }
    const ranges = data.move
      ? mergeRanges(staged.getSelectionsOrderedByBufferPosition().map((s) => s.getBufferRowRange()))
      : rowRanges(records);
    if (
      data.move &&
      !draft.getChangesSinceCheckpoint(checkpoint).length &&
      staged.getSelections().length === selections.length &&
      staged.getSelections().every((s, i) => s.getBufferRange().isEqual(selections[i].range))
    )
      return false;
    if (ranges.length) {
      let delta = 0;
      const changes = draft.getChangesSinceCheckpoint(checkpoint).map((change) => {
        const start = source.offsetAt(change.oldRange.start),
          end = source.offsetAt(change.oldRange.end);
        const inserted = change.newTextSource ?? change.newText;
        const result = {
          oldRange: change.oldRange,
          startIndex: start + delta,
          oldEndIndex: end + delta,
          newTextSource: inserted,
        };
        delta += inserted.length - (end - start);
        return result;
      });
      draft.getLanguageMode().scanSuggestedIndentation = () =>
        mode.scanPreparedIndentation(changes, ranges, tabLength, {
          signal,
          isCurrent,
          softTabs,
          isPastedText: !data.move,
          preserveLeadingWhitespace: options.preserveLeadingWhitespace,
          insertedIndentLengths: options.insertedIndentLengths,
        });
      await autoIndentRanges(staged, ranges, { ...options, signal, isPastedText: !data.move });
    }
    check();
    staged.suppressSelectionMerging = false;
    staged.mergeIntersectingSelections(() => {});
    const finalSelections = staged.getSelections().map((selection) => ({
      owner: owners.get(selection),
      range: selection.getBufferRange(),
      reversed: selection.isReversed(),
    }));
    if (finalSelections.some((selection) => !selection.owner))
      throw new Error("Prepared indentation created an unowned selection");
    const finalSource = draft.getTextSnapshot();
    const events = records.map(({ marker }) => {
      const range = marker.getBufferRange();
      return insertedSourceEvent(
        finalSource.subtext(finalSource.offsetAt(range.start), finalSource.offsetAt(range.end)),
        range,
      );
    });
    const changes = draft.historyProvider.getChangesSinceCheckpoint(checkpoint);
    const coordinateMap = changes.coordinateMap ?? TextChangeMap.fromChanges(changes);
    const markerPlan = new CoordinateMarkerPlan(buffer, source);
    await markerPlan.apply(coordinateMap, check);
    const folds = data.move
      ? staged.displayLayer.foldsMarkerLayer.getMarkers().map((m) => m.getRange())
      : null;
    let failure,
      finalized = false,
      committedRevision;
    const finalizeSelections = () => {
      editor.avoidMergingSelections(() => {
        if (folds) {
          const desired = new Map(folds.map((range) => [range.toString(), range]));
          for (const marker of editor.displayLayer.foldsMarkerLayer.getMarkers()) {
            const key = marker.getRange().toString();
            if (desired.has(key)) desired.delete(key);
            else marker.destroy();
          }
          for (const range of desired.values()) editor.foldBufferRange(range);
        }
        const survivors = new Set(finalSelections.map((s) => s.owner));
        for (const { owner, range, reversed } of finalSelections)
          owner.setBufferRange(range, {
            reversed,
            autoscroll: false,
            preserveFolds: Boolean(data.move),
          });
        for (const { selection } of selections) if (!survivors.has(selection)) selection.destroy();
      });
      editor.mergeIntersectingSelections(() => {});
      finalized = true;
      committedRevision = buffer.getTextRevision();
    };
    try {
      check();
      if (changes.length) {
        let delta = 0;
        const syntaxChanges = changes.map((change) => {
          const oldRange = new TextBuffer.Range(change.oldStart, change.oldEnd);
          const start = source.offsetAt(change.oldStart),
            end = source.offsetAt(change.oldEnd);
          const oldTextSource = change.oldTextSource ?? source.subtext(start, end);
          const newTextSource = change.newTextSource;
          const at = TextBuffer.Point.fromObject(change.newStart);
          const local = {
            oldStart: at,
            oldEnd: at.traverse(oldRange.getExtent()),
            newStart: at,
            newEnd: change.newEnd,
            startIndex: start + delta,
            oldEndIndex: end + delta,
            newEndIndex: start + delta + newTextSource.length,
            oldTextSource,
            newTextSource,
            get oldText() {
              return oldTextSource.toString();
            },
            get newText() {
              return newTextSource.toString();
            },
          };
          delta += newTextSource.length - (end - start);
          return buffer.changeEventForPreparedEdit(local);
        });
        const first = changes[0],
          last = changes.at(-1);
        const range = new TextBuffer.Range(first.oldStart, last.oldEnd);
        const inserted = finalSource.subtext(
          finalSource.offsetAt(first.newStart),
          finalSource.offsetAt(last.newEnd),
        );
        const plan = require("./prepared-text-replacements").createPlan({
          buffer,
          before: source,
          snapshot: finalSource,
          count: changes.length,
          changedCount: changes.length,
          range,
          inserted,
          coordinateMap,
          markerPlan,
          syntaxChanges,
          check,
        });
        publishing = true;
        try {
          plan.commit({ signal, isCurrent, didCommit: finalizeSelections });
        } finally {
          publishing = false;
          plan.dispose();
        }
      }
      if (!finalized) {
        check();
        publishing = true;
        const captureAll = buffer.captureAllMarkerLayers;
        buffer.captureAllMarkerLayers = true;
        try {
          editor.transact(() => {
            // Identical text can still move a cursor, fold or other marker.
            // Keep its history just as a scalar delete/insert transaction does.
            buffer.historyProvider.pushPatch(new (require("./text-model").TextPatch)());
            markerPlan.verify();
            markerPlan.publish(finalSource);
            finalizeSelections();
          });
        } finally {
          buffer.captureAllMarkerLayers = captureAll;
          publishing = false;
        }
      }
      if (options.undo === "skip" && buffer.getTextRevision() === committedRevision)
        buffer.groupLastChanges();
    } catch (error) {
      if (!error.committed) throw error;
      failure = error;
    }
    for (const event of events) {
      try {
        editor.emitter.emit("did-insert-text", event);
      } catch (error) {
        failure ??= Object.assign(error, { committed: true });
      }
    }
    if (options.autoscroll !== false) editor.getLastSelection()?.autoscroll({ mode: options.mode });
    if (failure) throw failure;
  } catch (error) {
    queue.cancelled = true;
    if (error.code === "ERR_SYNTAX_QUERY_BUDGET" && !signal.aborted && isCurrent())
      throw Object.assign(
        new Error("Unable to prepare final indentation within the syntax budget", { cause: error }),
        { code: error.code },
      );
    if (!error.committed && (error.name === "AbortError" || error.code === "ERR_STALE_EDIT"))
      return false;
    throw error;
  } finally {
    subscriptions.dispose();
    controller.abort(aborted());
    if (pending.get(editor) === controller) pending.delete(editor);
    try {
      staged?.destroy();
    } finally {
      if (draft && !draft.isDestroyed()) draft.destroy();
    }
  }
}

function enqueue(editor, data, options) {
  data = {
    ...data,
    metadata: data.metadata && {
      ...data.metadata,
      selections: data.metadata.selections?.map((entry) => ({ ...entry })),
    },
  };
  options = { ...options };
  let queue = queues.get(editor),
    task;
  if (!queue || queue.cancelled) {
    queue = { cancelled: false };
    queues.set(editor, queue);
    task = prepare(editor, data, options, queue);
  } else {
    task = queue.tail.then(
      (result) =>
        result === false || queue.cancelled ? false : prepare(editor, data, options, queue),
      () => false,
    );
  }
  queue.tail = task;
  return task.finally(() => {
    if (queues.get(editor) === queue && queue.tail === task) queues.delete(editor);
  });
}

module.exports = {
  applies,
  paste: (editor, data, options) => enqueue(editor, data, options),
  moveLines: (editor, move, options) => enqueue(editor, { move }, options),
  cancel: (editor) => {
    const queue = queues.get(editor);
    if (queue) queue.cancelled = true;
    pending.get(editor)?.abort(aborted());
  },
};
