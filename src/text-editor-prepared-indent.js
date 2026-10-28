const { CompositeDisposable } = require("@lumine-code/event-kit");
const TextBuffer = require("./text-buffer");
const { PieceTree } = require("./text-model");
const TextChangeMap = require("./text-change-map");
const { inspectRows, indentSource } = require("./text-editor-comment-operations");
const { autoIndentRanges, mergeRanges } = require("./text-editor-auto-indent");
const { insertPreparedSource, insertedSourceEvent } = require("./text-editor-snapshot-operations");
const pending = new WeakMap();
const queues = new WeakMap();
const inputVersions = new WeakMap();
const inputObservers = new WeakMap();
const activeInputs = new WeakMap();
const publishingEditors = new WeakSet();
function notifyInput(editor) {
  if (activeInputs.has(editor)) return activeInputs.get(editor);
  const version = (inputVersions.get(editor) ?? 0) + 1;
  inputVersions.set(editor, version);
  for (const notify of inputObservers.get(editor) ?? []) notify();
  return version;
}
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
  const setPublishing = (value) => {
    publishing = value;
    if (value) publishingEditors.add(editor);
    else publishingEditors.delete(editor);
  };
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
      // This editor plans buffer edits and never paints. The ordinary line
      // safety-wrap would index every preceding row to position a distant
      // cursor. Use the exact unwrapped projection, including folds and tabs.
      maxScreenLineLength: Infinity,
      autoIndent: false,
    });
    staged.emitWillPublishTextInsertion = (event) =>
      editor.emitWillPublishTextInsertion(event, staged);
    if (data.move || data.mutation) {
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
    const records = [],
      appliedChanges = [];
    subscriptions.add(draft.onDidApplyChanges((batch) => appliedChanges.push(...batch.changes)));
    let mutation;
    if (data.mutation) {
      staged.autoIndent = editor.shouldAutoIndent();
      staged.emitWillInsertTextEvent = (text) => {
        const accepted = editor.emitWillInsertTextEvent(text);
        if (!accepted) controller.abort(aborted());
        return accepted;
      };
      mutation = require("./text-editor-prepared-mutation")(staged, data.mutation, records, mode);
      if (mutation.result === false && !draft.getChangesSinceCheckpoint(checkpoint).length)
        return false;
    } else if (data.move) {
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
          staged.emitWillPublishTextInsertion(insertedSourceEvent(inserted, range));
          if (fullLine) {
            const position = oldPosition.translate([1, 0]);
            selection.setBufferRange([position, position]);
          }
        });
      }
    }
    const ranges = mutation
      ? mutation.ranges
      : data.move
        ? mergeRanges(
            staged.getSelectionsOrderedByBufferPosition().map((s) => s.getBufferRowRange()),
          )
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
          isPastedText: !data.move && !mutation,
          rowOptions: mutation?.rowOptions,
          preserveLeadingWhitespace: options.preserveLeadingWhitespace,
          insertedIndentLengths: options.insertedIndentLengths,
        });
      await autoIndentRanges(staged, ranges, {
        ...options,
        signal,
        isPastedText: !data.move && !mutation,
        rowOptions: mutation?.rowOptions,
      });
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
    const events = records.map(({ marker, text }) => {
      const range = marker.getBufferRange();
      if (mutation) return { text, range };
      return insertedSourceEvent(
        finalSource.subtext(finalSource.offsetAt(range.start), finalSource.offsetAt(range.end)),
        range,
      );
    });
    const changes = draft.historyProvider.getChangesSinceCheckpoint(checkpoint);
    const coordinateMap = changes.coordinateMap ?? TextChangeMap.fromChanges(changes);
    const folds =
      data.move || mutation
        ? staged.displayLayer.foldsMarkerLayer.getMarkers().map((m) => m.getRange())
        : null;
    let failure, committedRevision;
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
            preserveFolds: Boolean(data.move || mutation),
          });
        for (const { selection } of selections) if (!survivors.has(selection)) selection.destroy();
      });
      editor.mergeIntersectingSelections(() => {});
      committedRevision = buffer.getTextRevision();
    };
    try {
      check();
      await require("./prepared-input-publication")({
        buffer,
        changes,
        appliedChanges,
        coordinateMap,
        finalSource,
        check,
        finalize: finalizeSelections,
        groupingInterval: options.groupUndo ? editor.getUndoGroupingInterval() : 0,
        withPublication(callback) {
          setPublishing(true);
          try {
            return callback();
          } finally {
            setPublishing(false);
          }
        },
      });
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
    if (mutation) return events.length ? events.map((event) => event.range) : mutation.result;
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
  notifyInput(editor);
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
    let resolve, reject;
    task = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    queue.tail = task;
    Promise.resolve(prepare(editor, data, options, queue)).then(resolve, reject);
  } else {
    task = queue.tail.then(
      () => (queue.cancelled ? false : prepare(editor, data, options, queue)),
      () => false,
    );
    queue.tail = task;
  }
  return task.finally(() => {
    if (queues.get(editor) === queue && queue.tail === task) queues.delete(editor);
  });
}

module.exports = {
  applies,
  paste: (editor, data, options) => enqueue(editor, data, options),
  moveLines: (editor, move, options) => enqueue(editor, { move }, options),
  mutate: (editor, mutation, options) => enqueue(editor, { mutation }, options),
  isPending: (editor) => Boolean(queues.get(editor) && !queues.get(editor).cancelled),
  pendingTask: (editor) => queues.get(editor)?.tail,
  isPublishing: (editor) => publishingEditors.has(editor),
  inputVersion: (editor) => inputVersions.get(editor) ?? 0,
  activeInput: (editor) => activeInputs.get(editor),
  notifyInput,
  withInput(editor, version, operation) {
    const previous = activeInputs.get(editor);
    activeInputs.set(editor, version);
    try {
      return operation();
    } finally {
      if (previous == null) activeInputs.delete(editor);
      else activeInputs.set(editor, previous);
    }
  },
  observeInput(editor, callback) {
    let observers = inputObservers.get(editor);
    if (!observers) inputObservers.set(editor, (observers = new Set()));
    observers.add(callback);
    return {
      dispose() {
        observers.delete(callback);
        if (!observers.size) inputObservers.delete(editor);
      },
    };
  },
  cancel: (editor) => {
    const queue = queues.get(editor);
    if (queue) queue.cancelled = true;
    pending.get(editor)?.abort(aborted());
  },
};
