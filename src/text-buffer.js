const { Emitter, CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const File = require("./text-buffer-file");
const { watchFile } = require("./file-watch");
const diff = require("diff");
const _ = require("@lumine-code/underscore-plus");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const TextStore = require("./text-store");
const TextPatch = require("./text-patch");
const { idleDisposals } = require("./idle-disposal-queue");
const Point = require("./point");
const Range = require("./range");
const DefaultHistoryProvider = require("./default-history-provider");
const NullLanguageMode = require("./null-language-mode");
const Marker = require("./marker");
const MarkerLayer = require("./marker-layer");
const DisplayLayer = require("./display-layer");
const {
  spliceArray,
  newlineRegex,
  patchFromChanges,
  compactPatchChanges,
  normalizePatchChanges,
  debounce,
} = require("./helpers");
const { traverse, traversal } = require("./point-helpers");
const Grim = require("@lumine-code/grim");
const getSubstitution = require("./text-substitution");
const { SaveCancelledError } = require("./save-errors");
const { confirmSave, sameSavePath } = require("./save-confirmation");

function textExtent(text) {
  let row = 0,
    last = -1;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    row++;
    last = index;
  }
  return new Point(row, text.length - last - 1);
}

function textChangesOnlyPatch(patch) {
  if (!patch || patch.getChangeCount() === 0) return patch;
  // A file load can invert an edit and rollback into an identical replacement.
  // Applying that replacement to marker layers would still move their ranges.
  const changes = patch.getChanges();
  const textChanges = changes.filter((change) => change.oldText !== change.newText);
  return textChanges.length === changes.length ? patch : patchFromChanges(textChanges);
}

// Patch geometry can address the physical boundary between CR and LF. Editor
// points clip that boundary, so retain its code unit when reading patch data.
function indexForPatchPoint(buffer, point) {
  const clipped = buffer.clipPosition(point);
  return buffer.characterIndexForPosition(clipped) + point.column - clipped.column;
}

function textForPatchRange(buffer, range) {
  const start = buffer.clipPosition(range.start);
  const end = buffer.clipPosition(range.end);
  const startOffset = range.start.column - start.column;
  const endOffset = range.end.column - end.column;
  const readEnd = endOffset ? new Point(end.row + 1, 0) : end;
  const text = buffer.getTextInRange(new Range(start, readEnd));
  return text.slice(startOffset, text.length - (endOffset ? 2 - endOffset : 0));
}

function fileChangesWithWholeLineEndings(text, changes) {
  const insideCRLF = (offset) => text[offset - 1] === "\r" && text[offset] === "\n";
  if (!changes.some(({ start, end }) => insideCRLF(start) || insideCRLF(end))) return changes;

  // Buffer positions cannot address the middle of CRLF. Include the whole
  // ending and combine edits that now overlap, retaining their exact output.
  const groups = [];
  for (const change of changes) {
    const start = insideCRLF(change.start) ? change.start - 1 : change.start;
    const end = insideCRLF(change.end) ? change.end + 1 : change.end;
    const previous = groups.at(-1);
    if (previous && start < previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.changes.push(change);
    } else {
      groups.push({ start, end, changes: [change] });
    }
  }
  return groups.map(({ start, end, changes: edits }) => {
    const parts = [];
    let offset = start;
    for (const edit of edits) {
      parts.push(text.slice(offset, edit.start), edit.newText);
      offset = edit.end;
    }
    parts.push(text.slice(offset, end));
    return { start, end, newText: parts.join("") };
  });
}

function changeOrigin(origins) {
  if (origins.size === 0) return "edit";
  return origins.size === 1 ? origins.values().next().value : "mixed";
}

function advanceStringIndex(text, index, unicode) {
  if (!unicode || index + 1 >= text.length) return index + 1;

  const firstCodeUnit = text.charCodeAt(index);
  if (firstCodeUnit < 0xd800 || firstCodeUnit > 0xdbff) return index + 1;

  const secondCodeUnit = text.charCodeAt(index + 1);
  if (secondCodeUnit < 0xdc00 || secondCodeUnit > 0xdfff) return index + 1;

  return index + 2;
}

function lastOccupiedRowForRange(range) {
  if (range.end.row > range.start.row && range.end.column === 0) {
    return range.end.row - 1;
  }

  return range.end.row;
}

function scanFirstMatchInRange(buffer, regex, range, options, callback) {
  const matchRange = buffer.findInRangeSync(regex, range);
  if (matchRange && !(range.end.isEqual(matchRange.start) && range.end.column > 0)) {
    callback(new SearchCallbackArgument(buffer, Range.fromObject(matchRange), regex, options));
  }
}

/**
 * @public
 * @status extended
 *
 * A mutable text container with undo/redo support and the ability to
 * annotate logical regions in the text.
 *
 * ## Observing Changes
 *
 * You can observe changes in a {@link TextBuffer} using methods like {@link #onDidChange},
 * {@link #onDidStopChanging}, and {@link #getChangesSinceCheckpoint}. These methods report
 * aggregated buffer updates as arrays of change objects containing the following
 * fields: `oldRange`, `newRange`, `oldText`, and `newText`. The `oldText`,
 * `newText`, and `newRange` fields are self-explanatory, but the interpretation
 * of `oldRange` is more nuanced:
 *
 * The reported `oldRange` is the range of the replaced text in the original
 * contents of the buffer *irrespective of the spatial impact of any other
 * reported change*. So, for example, if you wanted to apply all the changes made
 * in a transaction to a clone of the observed buffer, the easiest approach would
 * be to apply the changes in reverse:
 *
 * ```js
 * buffer1.onDidChange(({changes}) => {
 *   for (const {oldRange, newText} of changes.reverse()) {
 *     buffer2.setTextInRange(oldRange, newText)
 *   }
 * })
 * ```
 *
 * If you needed to apply the changes in the forwards order, you would need to
 * incorporate the impact of preceding changes into the range passed to
 * {@link #setTextInRange}, as follows:
 *
 * ```js
 * buffer1.onDidChange(({changes}) => {
 *   for (const {oldRange, newRange, newText} of changes) {
 *     const rangeToReplace = Range(
 *       newRange.start,
 *       newRange.start.traverse(oldRange.getExtent())
 *     )
 *     buffer2.setTextInRange(rangeToReplace, newText)
 *   }
 * })
 * ```
 */
class TextBuffer {
  /**
   * @category Construction
   */

  /**
   * @public
   * @status public
   *
   * Create a new buffer with the given params.
   *
   * function Object() { [native code] }
   *
   * @param {Object|String} [params] - or `String` of text
   * @param {String} [params.text] - The initial `String` text of the buffer.
   * @param {String} [params.filePath] - The initial backing path; the constructor does not load its contents.
   * @param {String} [params.encoding=utf8] - The initial character encoding.
   * @param {String|null} [params.preferredLineEnding=null] - Preferred line ending for inserted text, or null to derive it from the buffer.
   * @param {Number} [params.maxUndoEntries] - Maximum undo history size; defaults to the buffer limit.
   */
  constructor(params) {
    if (params == null) params = {};

    this.refcount = 0;
    this.fileWatchClient = params.fileWatchClient;
    this.file = null;
    this.fileSubscriptions = null;
    this.oldFileSubscriptions = null;
    this.stoppedChangingTimeout = null;
    this.emitter = new Emitter();
    this.changesSinceLastStoppedChangingEvent = [];
    this.changesSinceLastDidChangeTextEvent = [];
    this.changeOriginsSinceLastDidChangeTextEvent = new Set();
    this.transactionsSinceLastStoppedChangingEvent = [];
    this.id = crypto.randomBytes(16).toString("hex");
    this.buffer = new TextStore(typeof params === "string" ? params : params.text || "");
    this._textRevision = 0;
    this.debouncedEmitDidStopChangingEvent = debounce(
      this.emitDidStopChangingEvent.bind(this),
      this.stoppedChangingDelay,
    );
    this.maxUndoEntries = params.maxUndoEntries ?? this.defaultMaxUndoEntries;
    this.setHistoryProvider(new DefaultHistoryProvider(this));
    this.languageMode = new NullLanguageMode({ buffer: this });
    this.nextMarkerLayerId = 0;
    this.nextDisplayLayerId = 0;
    this.defaultMarkerLayer = new MarkerLayer(this, String(this.nextMarkerLayerId++));
    this.displayLayers = {};
    this.markerLayers = {};
    this.markerLayers[this.defaultMarkerLayer.id] = this.defaultMarkerLayer;
    this.markerLayersWithPendingUpdateEvents = new Set();
    this.selectionsMarkerLayerIds = new Set();
    this.nextMarkerId = 1;
    this.outstandingSaveCount = 0;
    this.saveConfirmation = null;
    this.saveConfirmationDecision = "ask";
    this.pendingConfirmedSave = null;
    this.loadCount = 0;
    this.cachedHasAstral = null;
    this._emittedWillChangeEvent = false;

    // File state is deliberately independent of the text store's dirty bit.
    // Conflict and removal remain visible until a disk operation reconciles
    // them, even if undo happens to return the text to its saved base.
    this.fileState = this.buffer.getLength() > 0 ? "modified" : "unmodified";
    this.fileOperationGeneration = 0;

    // Whether a buffer has ever had a backing file, whether or not it exists
    // now.
    this.didHaveFileOnDisk = false;

    this.fileWatchOperationDepth = 0;
    this.explicitReloadDepth = 0;
    this.pendingFileLoads = 0;
    this.fileLoadWaiters = [];
    this.pendingFileReconcile = false;

    this.setEncoding(params.encoding);
    this.setPreferredLineEnding(params.preferredLineEnding);

    this.loaded = false;
    this.destroyed = false;
    this.transactCallDepth = 0;
    this.markerUpdateBatchDepth = 0;
    this.digestWhenLastPersisted = false;

    if (params.filePath) {
      this.setPath(params.filePath);
    }
    if (params.saveConfirmation != null) this.setSaveConfirmation(params.saveConfirmation);
  }

  toString() {
    return `<TextBuffer ${this.id}>`;
  }

  /**
   * @public
   * @status public
   *
   * Create a new buffer backed by the given file path.
   *
   * @param {String|Object} source - Either a `String` path to a local file or (experimentally) a file `Object` as described by the {@link #setFile} method.
   * @param {Object} [params] - An `Object` with the following properties:
   * @param {String} [params.encoding] - The file's encoding.
   * @param {Boolean} [params.mustExist=false] - Reject a missing path instead of creating an empty buffer.
   * @returns {Promise<TextBuffer>} Resolves to the buffer when the operation completes.
   */
  static load(source, params) {
    const buffer = new TextBuffer(params);
    if (typeof source === "string") {
      buffer.setPath(source);
    } else {
      buffer.setFile(source);
    }
    return buffer
      .load({ clearHistory: true, internal: true, mustExist: params && params.mustExist })
      .then(() => buffer)
      .catch((err) => {
        buffer.destroy();
        throw err;
      });
  }

  /**
   * @public
   * @status public
   *
   * Create a new buffer backed by the given file path. For better
   * performance, use {@link TextBuffer.load} instead.
   *
   * @param {String} filePath - The `String` file path.
   * @param {Object} [params] - An `Object` with the following properties:
   * @param {String} [params.encoding] - The file's encoding.
   * @param {Boolean} [params.mustExist=false] - Reject a missing path instead of creating an empty buffer.
   * @returns {TextBuffer} instance.
   */
  static loadSync(filePath, params) {
    const buffer = new TextBuffer(params);
    buffer.setPath(filePath);
    try {
      buffer.loadSync({ internal: true, mustExist: params && params.mustExist });
    } catch (e) {
      buffer.destroy();
      throw e;
    }
    return buffer;
  }

  /**
   * @public
   * @status public
   *
   * Restore a {@link TextBuffer} based on an earlier state created using
   * the `TextBuffer.serialize` method.
   *
   * @param {Object} params - An `Object` returned from `TextBuffer.serialize`
   * @returns {Promise<TextBuffer|undefined>} Resolves to the restored buffer, or undefined when the serialized version is incompatible.
   */
  static async deserialize(params) {
    if (params.version && params.version !== TextBuffer.version) return;

    params = { ...params };
    delete params.load;

    let buffer;
    let fileContentsChanged = false;
    if (params.filePath) {
      // `text` is the serialized in-memory contents of a dirty file-backed
      // buffer, not its saved base. Load the actual base (or an empty missing
      // path) first, then apply the serialized text in the branches below.
      buffer = await TextBuffer.load(params.filePath, { ...params, text: "" });
      const fileExists = fs.existsSync(params.filePath);
      const persistedBaseMatchesDisk =
        fileExists && buffer.digestWhenLastPersisted === params.digestWhenLastPersisted;
      const hadBackingFile = params.digestWhenLastPersisted !== false;
      const serializedState = params.fileState || "unmodified";
      const serializedDirty = serializedState !== "unmodified";

      if (persistedBaseMatchesDisk && serializedState === "modified") {
        const changes = params.outstandingChanges;
        buffer.buffer.deserializeChanges(
          typeof changes === "string" ? Buffer.from(changes, "base64") : changes,
        );
        buffer._textRevision++;
      }

      if (!fileExists) {
        if (serializedDirty && params.text != null) {
          buffer.buffer.setText(params.text);
          buffer._textRevision++;
        }
        fileContentsChanged = hadBackingFile;
        if (hadBackingFile) {
          buffer.didHaveFileOnDisk = true;
          buffer.setFileState("removed");
        } else {
          buffer.updateFileStateFromBuffer({ resolveStickyState: true });
        }
      } else if (persistedBaseMatchesDisk) {
        if (
          (serializedState === "conflicted" || serializedState === "removed") &&
          params.text != null
        ) {
          buffer.buffer.setText(params.text);
          buffer._textRevision++;
        }
        buffer.setFileState(buffer.deriveFileStateFromBuffer());
      } else if (serializedDirty && params.text != null) {
        buffer.buffer.setText(params.text);
        buffer._textRevision++;
        fileContentsChanged = true;
        buffer.setFileState("conflicted");
      } else {
        fileContentsChanged = true;
        buffer.setFileState("unmodified");
      }
    } else {
      buffer = new TextBuffer(params);
    }

    buffer.id = params.id;
    buffer.preferredLineEnding = params.preferredLineEnding;
    buffer.nextMarkerId = params.nextMarkerId;
    buffer.nextMarkerLayerId = params.nextMarkerLayerId;
    buffer.nextDisplayLayerId = params.nextDisplayLayerId;
    buffer.historyProvider.deserialize(fileContentsChanged ? {} : params.history, buffer);

    const foldMarkerLayerIds = new Set(
      Object.values(params.displayLayers || {}).map(({ foldsMarkerLayerId }) =>
        String(foldsMarkerLayerId),
      ),
    );

    for (const layerId in params.markerLayers) {
      let layerState = params.markerLayers[layerId];
      if (fileContentsChanged && foldMarkerLayerIds.has(String(layerId))) {
        // A fold is meaningful only for the exact file contents it described.
        // Clipping it can hide unrelated text after an external rewrite.
        layerState = { ...layerState, markersById: {} };
      }
      let layer;
      if (layerId === params.defaultMarkerLayerId) {
        buffer.defaultMarkerLayer.id = layerId;
        buffer.defaultMarkerLayer.deserialize(layerState);
        layer = buffer.defaultMarkerLayer;
      } else {
        layer = MarkerLayer.deserialize(buffer, layerState);
      }
      buffer.markerLayers[layerId] = layer;
    }

    for (const layerId in params.displayLayers) {
      const layerState = params.displayLayers[layerId];
      buffer.displayLayers[layerId] = DisplayLayer.deserialize(buffer, layerState);
    }

    return buffer;
  }

  // Returns a `String` representing a unique identifier for this {@link TextBuffer}.
  getId() {
    return this.id;
  }

  /**
   * @public
   * @status extended
   *
   * Capture this buffer's state for restoration with {@link TextBuffer.deserialize}.
   *
   * @param {Object} [options] - Serialization options.
   * @param {Boolean} [options.markerLayers=true] - Include persistent marker layers.
   * @param {Boolean} [options.history=true] - Include undo and redo history.
   * @returns {Object} State accepted by {@link TextBuffer.deserialize}.
   * @category Serialization
   */

  serialize(options) {
    if (options == null) options = {};
    if (options.markerLayers == null) options.markerLayers = true;
    if (options.history == null) options.history = true;

    const markerLayers = {};
    if (options.markerLayers) {
      for (const id in this.markerLayers) {
        const layer = this.markerLayers[id];
        if (layer.persistent) {
          markerLayers[id] = layer.serialize();
        }
      }
    }

    const displayLayers = {};
    for (const id in this.displayLayers) {
      const layer = this.displayLayers[id];
      displayLayers[id] = layer.serialize();
    }

    let history = {};
    if (options.history) {
      history = this.historyProvider.serialize(options);
    }

    const result = {
      id: this.getId(),
      version: TextBuffer.version,
      defaultMarkerLayerId: this.defaultMarkerLayer.id,
      markerLayers,
      displayLayers,
      nextMarkerLayerId: this.nextMarkerLayerId,
      nextDisplayLayerId: this.nextDisplayLayerId,
      history,
      encoding: this.getEncoding(),
      preferredLineEnding: this.preferredLineEnding,
      nextMarkerId: this.nextMarkerId,
    };
    const saveConfirmation = this.getSaveConfirmation();
    if (saveConfirmation) result.saveConfirmation = saveConfirmation;

    const filePath = this.getPath();
    if (filePath) {
      if (this.baseTextDigestCache == null) this.baseTextDigestCache = this.buffer.baseTextDigest();
      result.filePath = filePath;
      result.digestWhenLastPersisted = this.digestWhenLastPersisted;
      // Session snapshots pass through JSON; keep binary patches out of its byte-array form.
      result.outstandingChanges = this.buffer.serializeChanges().toString("base64");
      result.fileState = this.fileState;
      if (this.fileState !== "unmodified") result.text = this.getText();
    } else {
      result.text = this.getText();
      result.fileState = this.fileState;
    }

    return result;
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status public
   *
   * Invoke the given callback synchronously _before_ the content of the
   * buffer changes.
   *
   * Because observers are invoked synchronously, it's important not to perform
   * any expensive operations via this method.
   * Observers may read the document but must not edit it, undo, or redo.
   * Reentrant edits belong in post-transaction notifications instead.
   *
   * @param {Function} callback - to be called when the buffer changes.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillChange(callback) {
    return this.emitter.on("will-change", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback synchronously when a transaction
   * finishes with a list of all the changes in the transaction.
   *
   * @param {Function} callback - to be called when a transaction in which textual changes occurred is completed.
   * @param {Object} callback.event - with the following keys:
   * @param {String} callback.event.origin - `edit` for editor and API mutations, `undo` or `redo` for history replay, `reload` for text loaded from the backing file, or `mixed` when a transaction contains more than one origin. `edit` includes programmatic changes and does not prove that a key was pressed.
   * @param {Range} callback.event.oldRange - The smallest combined {@link Range} containing all of the old text.
   * @param {Range} callback.event.newRange - The smallest combined {@link Range} containing all of the new text.
   * @param {Array<Object>} callback.event.changes - of `Objects` summarizing the aggregated changes that occurred during the transaction. See *Working With Aggregated Changes* in the description of the {@link TextBuffer} class for details.
   * @param {Range} callback.event.changes[].oldRange - The {@link Range} of the deleted text in the contents of the buffer as it existed *before* the batch of changes reported by this event.
   * @param {Range} callback.event.changes[].newRange - The {@link Range} of the inserted text in the current contents of the buffer.
   * @param {String} callback.event.changes[].oldText - A `String` representing the deleted text.
   * @param {String} callback.event.changes[].newText - A `String` representing the inserted text.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChange(callback) {
    return this.emitter.on("did-change-text", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the callback synchronously at the end of a transaction with its
   * individual edits in application order, before the consolidated change event.
   * Each edit uses the coordinates of the buffer immediately before and after
   * that edit. Edits that cancel each other still appear, allowing external
   * range snapshots to follow every applied edit.
   *
   * @param {Function} callback - Receives an object containing a `changes` array
   * of immutable edits with `oldRange`, `newRange`, `oldText`, `newText`,
   * `startIndex`, `oldEndIndex`, and `newEndIndex`. Indices and columns count
   * UTF-16 code units. `beforeRevision` and `afterRevision` identify the text
   * states surrounding the batch; compare them with {@link #getTextRevision}.
   * `isCurrent()` returns false after the buffer advances beyond this batch.
   * `origin` identifies the batch as `edit`, `undo`, `redo`, `reload`, or `mixed`;
   * each individual edit also carries its own `origin`.
   * @returns {Disposable} Subscription to the applied edit batches.
   */
  onDidApplyChanges(callback) {
    return this.emitter.on("did-apply-changes", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to aggregated buffer changes; an alias of {@link #onDidChange}.
   * @param {Function} callback - Called when tokenization completes.
   * @returns {Disposable} Subscription to the same change events as {@link #onDidChange}.
   */
  onDidChangeText(callback) {
    return this.onDidChange(callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback asynchronously following one or more
   * changes after {@link #getStoppedChangingDelay} milliseconds elapse without an
   * additional change.
   *
   * This method can be used to perform potentially expensive operations that
   * don't need to be performed synchronously. If you need to run your callback
   * synchronously, use {@link #onDidChange} instead.
   *
   * @param {Function} callback - to be called when the buffer stops changing.
   * @param {Object} callback.event - with the following keys:
   * @param {String} callback.event.origin - `edit`, `undo`, `redo`, `reload`, or `mixed`, covering all transactions in this idle interval. `mixed` means that more than one origin occurred.
   * @param {Array} callback.event.transactions - Immutable transaction snapshots in application order, each containing `origin` and `changes`. Their ranges use the coordinates of their own transaction. Use these for reactions to the latest edit rather than treating the combined diff as user input.
   * @param {Array<Object>} callback.event.changes - An `Array` containing `Objects` summarizing the aggregated changes. See *Working With Aggregated Changes* in the description of the {@link TextBuffer} class for details.
   * @param {Range} callback.event.changes[].oldRange - The {@link Range} of the deleted text in the contents of the buffer as it existed *before* the batch of changes reported by this event.
   * @param {Range} callback.event.changes[].newRange - The {@link Range} of the inserted text in the current contents of the buffer.
   * @param {String} callback.event.changes[].oldText - A `String` representing the deleted text.
   * @param {String} callback.event.changes[].newText - A `String` representing the inserted text.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidStopChanging(callback) {
    return this.emitter.on("did-stop-changing", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the value of {@link #getFileState} changes.
   *
   * @param {Function} callback - to be called with the new state string from {@link #getFileState}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeFileState(callback) {
    return this.emitter.on("did-change-file-state", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when all marker `::onDidChange`
   * observers have been notified following a change to the buffer.
   *
   * The order of events following a buffer change is as follows:
   *
   * * The text of the buffer is changed
   * * All markers are updated accordingly, but their `::onDidChange` observers
   *   are not notified.
   * * `TextBuffer::onDidChange` observers are notified.
   * * `Marker::onDidChange` observers are notified.
   * * `TextBuffer::onDidUpdateMarkers` observers are notified.
   *
   * Basically, this method gives you a way to take action after both a buffer
   * change and all associated marker changes.
   *
   * @param {Function} callback - to be called after markers are updated.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidUpdateMarkers(callback) {
    return this.emitter.on("did-update-markers", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when a marker is created.
   *
   * @param {Function} callback - to be called when a marker is created.
   * @param {Marker} callback.marker - that was created.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidCreateMarker(callback) {
    return this.emitter.on("did-create-marker", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the value of {@link #getPath} changes.
   *
   * @param {Function} callback - to be called when the path changes.
   * @param {String|undefined} callback.path - representing the buffer's current path on disk.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangePath(callback) {
    return this.emitter.on("did-change-path", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the value of {@link #getEncoding} changes.
   *
   * @param {Function} callback - to be called when the encoding changes.
   * @param {String} callback.encoding - character set encoding of the buffer.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeEncoding(callback) {
    return this.emitter.on("did-change-encoding", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback before the buffer is saved to disk.
   *
   * @param {Function} callback - to be called before the buffer is saved. If this function returns a `Promise`, then the buffer will not be saved until the promise resolves.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillSave(callback) {
    return this.emitter.on("will-save", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback after the buffer is saved to disk.
   *
   * @param {Function} callback - to be called after the buffer is saved.
   * @param {Object} callback.event - with the following keys:
   * @param {String} callback.event.path - The path to which the buffer was saved.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidSave(callback) {
    return this.emitter.on("did-save", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback before the buffer is reloaded from the
   * contents of its file on disk.
   *
   * @param {Function} callback - to be called before the buffer is reloaded.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillReload(callback) {
    return this.emitter.on("will-reload", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback after the buffer is reloaded from the
   * contents of its file on disk.
   *
   * @param {Function} callback - to be called after the buffer is reloaded.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidReload(callback) {
    return this.emitter.on("did-reload", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the buffer is destroyed.
   *
   * @param {Function} callback - to be called when the buffer is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when there is an error in watching the
   * file.
   *
   * @param {Function} callback - callback
   * @param {Object} callback.errorObject
   * @param {Object} callback.errorObject.error - the error object
   * @param {Function} callback.errorObject.handle - call this to indicate you have handled the error. The error will not be thrown if this function is called.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillThrowWatchError(callback) {
    return this.emitter.on("will-throw-watch-error", callback);
  }

  /**
   * @public
   * @status public
   *
   * Get the number of milliseconds that will elapse without a change
   * before {@link #onDidStopChanging} observers are invoked following a change.
   *
   * @returns {Number}
   * @category Configuration
   */
  getStoppedChangingDelay() {
    return this.stoppedChangingDelay;
  }

  /**
   * @category File Details
   */

  /**
   * @public
   * @status public
   *
   * Get the buffer's mutually exclusive persistence state.
   *
   * `"unmodified"` matches the saved base, `"modified"` has local changes,
   * `"conflicted"` has diverged from its backing file, and `"removed"` has lost
   * its backing file.
   *
   * @returns {String} `"unmodified"`, `"modified"`, `"conflicted"`, or `"removed"`.
   */
  getFileState() {
    return this.fileState;
  }

  /**
   * @public
   * @status public
   *
   * Get the path of the associated file.
   *
   * @returns {String|undefined} The backing path, or undefined when the buffer has no backing file.
   */
  getPath() {
    return this.file ? this.file.getPath() : undefined;
  }

  /**
   * @public
   * @status public
   *
   * Set the path for the buffer's associated file.
   *
   * @param {String|null} filePath - A `String` representing the new file path
   */
  setPath(filePath) {
    if (filePath === this.getPath()) return;
    return this.setFile(filePath && new File(filePath));
  }

  /** @private */
  getFileMovePath() {
    return this.file instanceof File || typeof this.file?.setPath === "function"
      ? this.getPath()
      : null;
  }

  /** @private */
  async relocateFile(filePath) {
    const file = this.file;
    if (!file || this.destroyed || filePath === file.getPath()) return;
    if (file instanceof File) return this.setPath(filePath);
    if (typeof file.setPath !== "function") {
      throw new Error("This data source does not support filesystem relocation");
    }
    const previousPath = file.getPath();
    this.fileOperationGeneration++;
    this.loadCount++;
    this.relocatingFile = file;
    try {
      await file.setPath(filePath);
    } finally {
      try {
        if (!this.destroyed && this.file === file) {
          this.subscribeToFile();
          if (file.getPath() !== previousPath) {
            this.fileRelocationNotice = { file, path: file.getPath() };
            this.emitter.emit("did-change-path", file.getPath());
          }
        }
      } finally {
        if (this.relocatingFile === file) this.relocatingFile = null;
      }
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Set a custom `File` object as the buffer's backing store.
   *
   * @param {Object|null} file - An `Object` with the following properties:
   * @param {Function} file.getPath - A `Function` that returns the `String` path to the file.
   * @param {Function} [file.setPath] - A `Function` that retargets this same data source, optionally returning a Promise. Supplying it opts into editor-initiated filesystem moves; without it, the provider owns relocation.
   * @param {Function} file.createReadStream - A `Function` that returns a `Readable` stream that can be used to load the file's content.
   * @param {Function} file.createWriteStream - A `Function` that returns a `Writable` stream that can be used to save content to the file.
   * @param {Function} file.existsSync - A `Function` that returns a `Boolean`, true if the file exists, false otherwise.
   * @param {Function} [file.onDidChange] - A `Function` that invokes its callback argument when the file changes. The method should return a `Disposable` that can be used to prevent further calls to the callback.
   * @param {Function} [file.onDidDelete] - A `Function` that invokes its callback argument when the file is deleted. The method should return a `Disposable` that can be used to prevent further calls to the callback.
   * @param {Function} [file.onDidRename] - A `Function` that invokes its callback argument when the file is renamed. The method should return a `Disposable` that can be used to prevent further calls to the callback.
   */
  setFile(file) {
    if (!this.file && !file) return;
    if (file === this.file) return;

    if (!sameSavePath(this.getPath(), file?.getPath())) {
      this.pendingConfirmedSave?.cancel();
      this.saveConfirmation = null;
      this.saveConfirmationDecision = "ask";
    }

    const hadFile = Boolean(this.file);
    this.fileOperationGeneration++;
    this.loadCount++;
    this.file = file;
    // A new File object represents a new backing path. Do not carry the old
    // path's deletion history into it, even when the new path does not exist.
    this.didHaveFileOnDisk = false;
    this.updateDidHaveFileOnDisk();
    this.fileRelocationNotice = null;
    if (this.file && !this.destroyed) {
      if (typeof this.file.setEncoding === "function") {
        this.file.setEncoding(this.getEncoding());
      }
      this.subscribeToFile();
    } else {
      this.fileSubscriptions?.dispose();
      this.oldFileSubscriptions?.dispose();
      this.fileSubscriptions = null;
      this.oldFileSubscriptions = null;
      this.reconcileWatchedFile = null;
      this.fileWatchStartPromise = Promise.resolve();
    }

    if (!this.file) {
      this.updateFileStateFromBuffer({ resolveStickyState: true });
    } else if (hadFile) {
      if (this.didHaveFileOnDisk) {
        this.updateFileStateFromBuffer({ resolveStickyState: true });
      } else {
        // A buffer retargeted to a path that has never existed is an unsaved
        // document, not a removed instance of its previous backing file.
        this.setFileState("modified");
      }
    }

    this.emitter.emit("did-change-path", this.getPath());
  }

  /**
   * @public
   * @status public
   *
   * Sets the character set encoding for this buffer.
   *
   * @param {String} encoding - The `String` encoding to use (default: 'utf8').
   */
  setEncoding(encoding = "utf8") {
    if (encoding === this.getEncoding()) return;

    this.encoding = encoding;
    if (this.file) {
      if (typeof this.file.setEncoding === "function") {
        this.file.setEncoding(encoding);
      }
      this.emitter.emit("did-change-encoding", encoding);
      if (this.fileState === "unmodified") {
        this.load({ clearHistory: true, internal: true });
      }
    } else {
      this.emitter.emit("did-change-encoding", encoding);
    }
  }

  /**
   * @public
   * @status public
   *
   * Get the character encoding used by this buffer.
   *
   * @returns {String} encoding of this buffer.
   */
  getEncoding() {
    return this.encoding || (this.file && this.file.getEncoding());
  }

  setPreferredLineEnding(preferredLineEnding = null) {
    this.preferredLineEnding = preferredLineEnding;
  }

  getPreferredLineEnding() {
    return this.preferredLineEnding;
  }

  /**
   * @public
   * @status public
   *
   * Get the path of the associated file.
   *
   * @returns {String|undefined} The backing path, or undefined when the buffer has no backing file.
   */
  getUri() {
    return this.getPath();
  }

  // Get the basename of the associated file.
  //
  // The basename is the name portion of the file's path, without the containing
  // directories.
  //
  // Returns a `String`.
  getBaseName() {
    return this.file && this.file.getBaseName();
  }

  /**
   * @category Reading Text
   */

  /**
   * @public
   * @status public
   *
   * Determine whether the buffer is empty.
   *
   * @returns {Boolean}
   */
  isEmpty() {
    return this.buffer.getLength() === 0;
  }

  /**
   * @public
   * @status public
   *
   * Get the entire text of the buffer. Avoid using this unless you know that the
   * buffer's text is reasonably short.
   *
   * @returns {String}
   */
  getText() {
    if (this.cachedText == null) this.cachedText = this.buffer.getText();
    return this.cachedText;
  }

  /**
   * @public
   * @status extended
   *
   * Capture immutable text without copying the document. The snapshot remains
   * valid after edits, undo and buffer destruction. Its read interface exposes
   * `length`, `lineCount`, `slice(start, end)`, `charCodeAt(index)`, `chunks()`,
   * `lines(startRow, endRow)`, `lineReader()`, `positionAt(index)` and `offsetAt(point)`.
   * A line reader returns a row-to-text function with efficient sequential reads
   * and indexed jumps; requests outside the snapshot return `undefined`.
   * Offsets count UTF-16 units; line iteration strips LF/CRLF and uses an
   * exclusive end row. Explicit string reads materialize only their range.
   * Read {@link #getTextRevision} alongside the snapshot when preparing an
   * asynchronous edit plan, then pass that revision when applying the plan.
   * @returns {Object} An immutable text snapshot with indexed and sequential readers.
   * @category Reading Text
   */
  getTextSnapshot() {
    return this.buffer.getTextSnapshot();
  }

  /**
   * @public
   * @status public
   *
   * Get the revision of the current text state. Revisions increase before
   * change observers read the new text, including undo, redo and file loads.
   * A revision identifies a state of this buffer, not an undo entry or byte offset.
   *
   * @returns {Number} Monotonically increasing text revision for this buffer.
   */
  getTextRevision() {
    return this._textRevision;
  }

  getCharacterAtPosition(position) {
    return this.buffer.getCharacterAtPosition(Point.fromObject(position));
  }

  /**
   * @public
   * @status public
   *
   * Get the text in a range.
   *
   * @param {Range|Array|Object} range - A {@link Range}
   * @returns {String}
   */
  getTextInRange(range) {
    return this.buffer.getTextInRange(Range.fromObject(range));
  }

  /**
   * @public
   * @status public
   *
   * Get the text of all lines in the buffer, without their line endings.
   *
   * @returns {Array<String>} The buffer lines, excluding line endings.
   */
  getLines() {
    return this.buffer.getLines();
  }

  /**
   * @public
   * @status public
   *
   * Get the text of the last line of the buffer, without its line
   * ending.
   *
   * @returns {String}
   */
  getLastLine() {
    return this.lineForRow(this.getLastRow());
  }

  /**
   * @public
   * @status public
   *
   * Get the text of the line at the given 0-indexed row, without its
   * line ending.
   *
   * @param {Number} row - A `Number` representing the row.
   * @returns {String}
   */
  lineForRow(row) {
    return this.buffer.lineForRow(row);
  }

  /**
   * @public
   * @status public
   *
   * Get the line ending for the given 0-indexed row.
   *
   * @param {Number} row - A `Number` indicating the row.
   * @returns {String} The returned newline is represented as a literal string: `'\n'`, `'\r\n'`, or `''` for the last line of the buffer, which doesn't end in a newline.
   */
  lineEndingForRow(row) {
    return this.buffer.lineEndingForRow(row);
  }

  /**
   * @public
   * @status experimental
   * @returns {Set<string>} LF and/or CRLF endings currently present in the buffer.
   * Reads persistent tree metadata in constant time. A lone CR is ordinary text.
   */
  getLineEndings() {
    return this.buffer.getLineEndings();
  }

  /**
   * @public
   * @status public
   *
   * Get the length of the line for the given 0-indexed row, without its
   * line ending.
   *
   * @param {Number} row - A `Number` indicating the row.
   * @returns {Number}
   */
  lineLengthForRow(row) {
    return this.buffer.lineLengthForRow(row);
  }

  /**
   * @public
   * @status public
   *
   * Determine if the given row contains only whitespace.
   *
   * @param {Number} row - A `Number` representing a 0-indexed row.
   * @returns {Boolean}
   */
  isRowBlank(row) {
    return !/\S/.test(this.lineForRow(row));
  }

  /**
   * @public
   * @status public
   *
   * Given a row, find the first preceding row that's not blank.
   *
   * @param {Number} startRow - A `Number` identifying the row to start checking at.
   * @returns {Number|null} The preceding non-blank row, or null when none exists.
   */
  previousNonBlankRow(startRow) {
    if (startRow === 0) return null;
    startRow = Math.min(startRow, this.getLastRow());
    for (let row = startRow - 1; row >= 0; row--) {
      if (!this.isRowBlank(row)) return row;
    }
    return null;
  }

  /**
   * @public
   * @status public
   *
   * Given a row, find the next row that's not blank.
   *
   * @param {Number} startRow - A `Number` identifying the row to start checking at.
   * @returns {Number|null} The next non-blank row, or null when none exists.
   */
  nextNonBlankRow(startRow) {
    const lastRow = this.getLastRow();
    if (startRow < lastRow) {
      for (let row = startRow + 1; row <= lastRow; row++) {
        if (!this.isRowBlank(row)) return row;
      }
    }
    return null;
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the buffer contains Unicode surrogate pairs.
   *
   * @returns {Boolean} Whether the buffer contains astral-plane Unicode characters encoded as surrogate pairs.
   */
  hasAstral() {
    if (this.cachedHasAstral !== null) {
      return this.cachedHasAstral;
    } else {
      this.cachedHasAstral = this.buffer.hasAstral();
      return this.cachedHasAstral;
    }
  }

  /**
   * @category Mutating Text
   */

  /**
   * @public
   * @status public
   *
   * Replace the entire contents of the buffer with the given text.
   *
   * @param {String} text - A `String`
   * @returns {Range} spanning the new buffer contents.
   */
  setText(text) {
    return this.setTextInRange(this.getRange(), text, { normalizeLineEndings: false });
  }

  /**
   * @public
   * @status extended
   *
   * Compute diff changes to target text without modifying this buffer,
   * its history, markers or observers. Ranges use UTF-16 buffer coordinates.
   *
   * @param {String} text - Target text.
   * @returns {Array<Object>} Changes containing oldRange, newRange, oldText and newText.
   */
  getChangesToText(text) {
    return this.buffer
      .diff(text)
      .getChanges()
      .map((change) => ({
        oldRange: new Range(change.oldStart, change.oldEnd),
        newRange: new Range(change.newStart, change.newEnd),
        oldText: change.oldText,
        newText: change.newText,
      }));
  }

  /**
   * @public
   * @status public
   *
   * Replace the current buffer contents by applying a diff based on the
   * given text.
   *
   * @param {String} text - A `String` containing the new buffer contents.
   */
  setTextViaDiff(text) {
    const patch = this.buffer.diff(text);
    const changes = patch.getChanges();
    if (changes.length === 0) return;

    // A bounded diff may replace unchanged interior lines after its deadline.
    // Recompute by lines without that deadline to preserve their markers.
    if (patch.isCoarse) {
      return this.setTextViaLineDiff(text);
    }

    const changeOptions = { normalizeLineEndings: false };
    this.transact(() => {
      for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        this.setTextInRange([change.oldStart, change.oldEnd], change.newText, changeOptions);
      }
    });
  }

  setTextViaLineDiff(text) {
    const currentText = this.getText();
    if (currentText === text) return;

    const computeBufferColumn = function (str) {
      const newlineIndex = str.lastIndexOf("\n");
      if (newlineIndex === -1) {
        return str.length;
      } else {
        return str.length - newlineIndex - 1;
      }
    };

    this.transact(() => {
      let row = 0;
      let column = 0;
      const currentPosition = [0, 0];

      const lineDiff = diff.diffLines(currentText, text);
      const changeOptions = { normalizeLineEndings: false };

      for (let change of lineDiff) {
        const lineCount = change.count;
        currentPosition[0] = row;
        currentPosition[1] = column;

        if (change.added) {
          row += lineCount;
          column = computeBufferColumn(change.value);
          this.setTextInRange([currentPosition, currentPosition], change.value, changeOptions);
        } else if (change.removed) {
          const endRow = row + lineCount;
          const endColumn = column + computeBufferColumn(change.value);
          this.setTextInRange([currentPosition, [endRow, endColumn]], "", changeOptions);
        } else {
          row += lineCount;
          column = computeBufferColumn(change.value);
        }
      }
    });
  }

  /**
   * @public
   * @status public
   *
   * Set the text in the given range.
   *
   * @param {Range|Array|Object} range - A {@link Range}
   * @param {String} newText - A `String`
   * @param {Object} [options]
   * @param {Boolean} [options.normalizeLineEndings] - (default: true)
   * @param {String} [options.undo] - *Deprecated* `String` 'skip' will cause this change to be grouped with the preceding change for the purposes of undo and redo. This property is deprecated. Call groupLastChanges() on the buffer after instead.
   * @returns {Range} of the inserted text.
   */
  setTextInRange(range, newText, options) {
    this.assertCanEdit();
    let normalizeLineEndings, undo;
    if (options) ({ normalizeLineEndings, undo } = options);
    if (normalizeLineEndings == null) normalizeLineEndings = true;
    if (undo != null) {
      Grim.deprecate(
        "The `undo` option is deprecated. Call groupLastChanges() on the TextBuffer afterward instead.",
      );
    }

    if (this.transactCallDepth === 0) {
      const newRange = this.transact(() =>
        this.setTextInRange(range, newText, { normalizeLineEndings }),
      );
      if (undo === "skip") this.groupLastChanges();
      return newRange;
    }

    const oldRange = this.clipRange(range);

    if (normalizeLineEndings) {
      const normalizedEnding =
        this.preferredLineEnding ||
        this.lineEndingForRow(oldRange.start.row) ||
        this.lineEndingForRow(oldRange.start.row - 1);
      if (normalizedEnding) {
        newText = newText.replace(newlineRegex, normalizedEnding);
      }
    }

    this.emitWillChangeEvent();
    const edit = this.buffer.prepareEdit(oldRange, newText);
    const newRange = this.applyChange(edit, { recordHistory: true });
    if (undo === "skip") this.groupLastChanges();
    return newRange;
  }

  /**
   * @public
   * @status extended
   *
   * Apply disjoint edits against the current revision as one undo
   * operation. Ranges may span multiple rows but cannot overlap or share a start.
   * Text is stored literally unless line-ending normalization is requested. Input order does not matter. All edits are
   * validated before changing text; stale revisions and overlapping ranges reject.
   *
   * Large batches share unchanged text and update display geometry once.
   * Custom range trackers retain intermediate-text callbacks.
   * @param {Array<Object>} edits - Objects with a buffer `range` and replacement `text`.
   * @param {Object} [options] - Batch options.
   * @param {Number} [options.expectedRevision] - Required current revision for an asynchronous plan.
   * @param {Boolean} [options.normalizeLineEndings=false] - Normalize replacements using each original start row's line ending.
   * @returns {Boolean} Whether the batch changed text.
   * @category Mutating Text
   */
  setTextInIndependentRanges(
    edits,
    { expectedRevision = this.getTextRevision(), normalizeLineEndings = false } = {},
  ) {
    this.assertCanEdit();
    if (expectedRevision !== this.getTextRevision())
      throw Object.assign(new Error("Edit plan no longer matches the buffer revision"), {
        code: "ERR_STALE_EDIT",
      });
    const planned = edits
      .map(({ range, text }) => {
        range = this.clipRange(range);
        if (
          typeof text !== "string" ||
          ![range.start.row, range.start.column, range.end.row, range.end.column].every(
            Number.isSafeInteger,
          )
        )
          throw new RangeError("Independent edits require integer ranges and string text");
        if (normalizeLineEndings) {
          const ending =
            this.preferredLineEnding ||
            this.lineEndingForRow(range.start.row) ||
            this.lineEndingForRow(range.start.row - 1);
          if (ending) text = text.replace(newlineRegex, ending);
        }
        return { range, text };
      })
      .sort((a, b) => a.range.start.compare(b.range.start));
    for (let i = 1; i < planned.length; i++) {
      const previous = planned[i - 1].range,
        current = planned[i].range;
      if (previous.end.compare(current.start) > 0 || previous.start.isEqual(current.start))
        throw new RangeError("Independent edit ranges overlap");
    }
    const changes = planned.filter(({ range, text }) => this.getTextInRange(range) !== text);
    if (!changes.length) return false;
    const source = this.getTextSnapshot();
    return this.transact(() => {
      if (!this.tryApplyIndependentEdits(changes, true)) {
        let oldEnd = Point.ZERO,
          newEnd = Point.ZERO;
        for (const { range, text } of changes) {
          const newStart = newEnd.traverse(range.start.traversalFrom(oldEnd));
          const oldText = source.slice(source.offsetAt(range.start), source.offsetAt(range.end));
          // A previous edit can form CRLF around the next physical boundary.
          // Preserve the original plan's offsets instead of clipping it again.
          this.emitWillChangeEvent();
          this.applyChange(
            this.buffer.prepareEditFromChange({
              oldStart: range.start,
              oldEnd: range.end,
              newStart,
              oldText,
              newText: text,
            }),
            { recordHistory: true },
          );
          oldEnd = range.end;
          newEnd = newStart.traverse(textExtent(text));
        }
      }
      return true;
    });
  }

  tryApplyIndependentEdits(edits, recordHistory, origin = "edit") {
    const requiresIntermediateText = () =>
      Object.values(this.markerLayers).some(
        (layer) =>
          layer.getMarkerCount() > 0 && (layer.trackRanges || layer.destroyInvalidatedMarkers),
      );
    if (edits.length < 64 || requiresIntermediateText()) return false;

    const source = this.getTextSnapshot();
    const changes = [];
    const canonicalChanges = [];
    const storageEdits = [];
    let previousRange = null;
    let previousNewEnd = Point.ZERO;
    let previousOutputLastUnit = NaN;
    let offset = 0;
    let endIndex = 0;
    let firstIndex;
    for (const planned of edits) {
      const { range, text } = planned;
      const oldRange = this.clipRange(range);
      if (
        typeof text !== "string" ||
        !Number.isInteger(oldRange.start.row) ||
        !Number.isInteger(oldRange.start.column) ||
        !Number.isInteger(oldRange.end.column) ||
        !Number.isInteger(oldRange.end.row) ||
        !oldRange.isEqual(range) ||
        (previousRange &&
          (previousRange.end.compare(oldRange.start) > 0 ||
            previousRange.start.compare(oldRange.start) >= 0))
      )
        return false;
      const index = this.characterIndexForPosition(oldRange.start);
      const oldEndIndex =
        oldRange.start.row === oldRange.end.row
          ? index + oldRange.end.column - oldRange.start.column
          : this.characterIndexForPosition(oldRange.end);
      const oldText = source.slice(index, oldEndIndex);
      if (Object.hasOwn(planned, "oldText") && planned.oldText !== oldText) return false;
      const leftUnit =
        previousRange && index === endIndex ? previousOutputLastUnit : source.charCodeAt(index - 1);
      // Scalar storage expands edits that split or create CRLF. Keep those
      // boundary-affinity semantics by retaining scalar application at seams.
      if (
        (leftUnit === 13 &&
          (source.charCodeAt(index) === 10 ||
            text.charCodeAt(0) === 10 ||
            (!text.length && source.charCodeAt(oldEndIndex) === 10))) ||
        (text.charCodeAt(text.length - 1) === 13 && source.charCodeAt(oldEndIndex) === 10)
      )
        return false;
      if (changes.length === 0) firstIndex = endIndex = index;
      storageEdits.push({ start: index, end: oldEndIndex, text });
      endIndex = oldEndIndex;
      const newStart = previousRange
        ? previousNewEnd.traverse(oldRange.start.traversalFrom(previousRange.end))
        : oldRange.start;
      const newEnd = newStart.traverse(textExtent(text));
      canonicalChanges.push({
        oldStart: oldRange.start,
        oldEnd: oldRange.end,
        newStart,
        newEnd,
        oldText,
        newText: text,
      });
      changes.push({
        oldStart: newStart,
        oldEnd: newStart.traverse(oldRange.getExtent()),
        newStart,
        newEnd,
        oldText,
        newText: text,
        startIndex: index + offset,
        oldEndIndex: oldEndIndex + offset,
        newEndIndex: index + offset + text.length,
      });
      offset += text.length - oldText.length;
      previousRange = oldRange;
      previousNewEnd = newEnd;
      previousOutputLastUnit = text.length ? text.charCodeAt(text.length - 1) : leftUnit;
    }

    this.emitWillChangeEvent();
    if (requiresIntermediateText()) return false;
    const batchLanguageMode =
      typeof this.languageMode.bufferDidChangeBatch === "function" &&
      this.languageMode.canBatchTextChanges?.(changes.length)
        ? this.languageMode
        : null;
    const range = new Range(canonicalChanges[0].oldStart, canonicalChanges.at(-1).oldEnd);
    const edit = this.buffer.prepareEdits(storageEdits);
    const wasApplying = this.applyingEdit;
    try {
      this.applyingEdit = true;
      const displayChange = {
        oldRange: range,
        newRange: new Range(range.start, changes.at(-1).newEnd),
        startIndex: firstIndex,
        oldEndIndex: endIndex,
        newEndIndex: endIndex + offset,
        get oldText() {
          return source.slice(firstIndex, endIndex);
        },
        get newText() {
          return edit.snapshot.slice(firstIndex, endIndex + offset);
        },
        origin,
      };
      this.prepareDisplayLayersForChange(displayChange);
      const patch = recordHistory
        ? (TextPatch.fromIndependentChanges(canonicalChanges) ?? patchFromChanges(changes))
        : null;
      edit.commit();
      this.cachedText = null;
      if (recordHistory) this.historyProvider.pushPatch(patch);
      const updateErrors = [];
      const historyLayers = Object.values(this.markerLayers);
      for (const layer of historyLayers) layer.beginHistoryBatch();
      try {
        for (const change of changes) {
          this._textRevision++;
          const oldRange = new Range(change.oldStart, change.oldEnd).freeze();
          const newRange = new Range(change.newStart, change.newEnd).freeze();
          const event = Object.freeze({
            oldRange,
            newRange,
            oldText: change.oldText,
            newText: change.newText,
            startIndex: change.startIndex,
            oldEndIndex: change.oldEndIndex,
            newEndIndex: change.newEndIndex,
            origin,
          });
          this.changesSinceLastDidChangeTextEvent.push(change);
          this.changesSinceLastStoppedChangingEvent.push(change);
          this.changeOriginsSinceLastDidChangeTextEvent.add(origin);
          this.recordAppliedChange(event);
          const oldExtent = oldRange.getExtent();
          const newExtent = newRange.getExtent();
          for (const layer of Object.values(this.markerLayers)) {
            try {
              layer.splice(oldRange.start, oldExtent, newExtent, change.newText);
            } catch (error) {
              updateErrors.push(error);
            }
            this.markerLayersWithPendingUpdateEvents.add(layer);
          }
          try {
            if (!batchLanguageMode && (!oldRange.isEmpty() || !newRange.isEmpty()))
              this.languageMode.bufferDidChange(event);
          } catch (error) {
            updateErrors.push(error);
          }
        }
      } finally {
        for (const layer of historyLayers) layer.endHistoryBatch();
      }
      if (batchLanguageMode) {
        try {
          batchLanguageMode.bufferDidChangeBatch(displayChange, changes.length);
        } catch (error) {
          updateErrors.push(error);
        }
      }
      // Text already committed in full. Finish recording and delivering its
      // splices before surfacing an observer error so rollback can invert the
      // same complete batch rather than an unreported suffix.
      try {
        this.updateDisplayLayersForChange(displayChange);
      } catch (error) {
        updateErrors.push(error);
      }
      if (updateErrors.length) throw updateErrors[0];
      return true;
    } finally {
      edit.dispose();
      this.applyingEdit = wasApplying;
    }
  }

  applyHistoryUpdates(changes, origin = "edit") {
    if (changes.length >= 64) {
      const edits = changes.map((change) => ({
        range: new Range(change.oldStart, change.oldEnd),
        text: change.newText,
        oldText: change.oldText,
      }));
      if (this.tryApplyIndependentEdits(edits, false, origin)) return;
    }
    for (const change of changes)
      this.applyChange(this.buffer.prepareEditFromChange(change), { origin });
  }

  /**
   * @public
   * @status public
   *
   * Insert text at the given position.
   *
   * @param {Point|Array<Number>|Object} position - A {@link Point} representing the insertion location. The position is clipped before insertion.
   * @param {String} text - A `String` representing the text to insert.
   * @param {Object} [options]
   * @param {Boolean} [options.normalizeLineEndings] - (default: true)
   * @param {String} [options.undo] - *Deprecated* The value `skip` groups this edit with the preceding change. Call {@link #groupLastChanges} afterward instead.
   * @returns {Range} of the inserted text.
   */
  insert(position, text, options) {
    return this.setTextInRange(new Range(position, position), text, options);
  }

  /**
   * @public
   * @status public
   *
   * Append text to the end of the buffer.
   *
   * @param {String} text - A `String` representing the text to append.
   * @param {Object} [options]
   * @param {Boolean} [options.normalizeLineEndings] - (default: true)
   * @param {String} [options.undo] - *Deprecated* The value `skip` groups this edit with the preceding change. Call {@link #groupLastChanges} afterward instead.
   * @returns {Range} of the inserted text
   */
  append(text, options) {
    return this.insert(this.getEndPosition(), text, options);
  }

  // All synchronous mutations commit a prepared text edit. History receives
  // the same immutable text blocks; notifications receive only value snapshots.
  applyChange(edit, { recordHistory = false, origin = "edit" } = {}) {
    const wasApplying = this.applyingEdit;
    try {
      this.assertCanEdit();
      this.applyingEdit = true;
      const change = edit.getChange();
      const {
        oldStart,
        oldEnd,
        newStart,
        newEnd,
        oldText,
        newText,
        startIndex,
        oldEndIndex,
        newEndIndex,
      } = change;
      const oldRange = new Range(oldStart, oldEnd).freeze();
      const newRange = new Range(newStart, newEnd).freeze();
      const oldExtent = oldRange.getExtent();
      const newExtent = newRange.getExtent();
      const changeEvent = Object.freeze({
        oldRange,
        newRange,
        oldText,
        newText,
        origin,
        startIndex,
        oldEndIndex,
        newEndIndex,
      });

      this.prepareDisplayLayersForChange(changeEvent);
      const patch = recordHistory ? edit.createPatch() : null;
      edit.commit();
      // The public text revision advances before any observer reads parser input.
      this._textRevision++;
      this.cachedText = null;
      if (recordHistory) this.historyProvider.pushPatch(patch);

      this.changesSinceLastDidChangeTextEvent.push(change);
      this.changesSinceLastStoppedChangingEvent.push(change);
      this.changeOriginsSinceLastDidChangeTextEvent.add(origin);
      this.recordAppliedChange(changeEvent);

      if (this.markerLayers) {
        for (const id in this.markerLayers) {
          const markerLayer = this.markerLayers[id];
          markerLayer.splice(oldRange.start, oldExtent, newExtent, newText);
          this.markerLayersWithPendingUpdateEvents.add(markerLayer);
        }
      }

      this.emitDidChangeEvent(changeEvent);
      return newRange;
    } finally {
      edit.dispose();
      this.applyingEdit = wasApplying;
    }
  }

  emitDidChangeEvent(changeEvent) {
    if (!changeEvent.oldRange.isEmpty() || !changeEvent.newRange.isEmpty()) {
      this.languageMode.bufferDidChange(changeEvent);
      this.updateDisplayLayersForChange(changeEvent);
    }
  }

  recordAppliedChange(change) {
    if (this.emitter.listenerCountForEventName("did-apply-changes") > 0) {
      if (!this.appliedChanges?.length) this.appliedChangesBeforeRevision = this._textRevision - 1;
      (this.appliedChanges ||= []).push(Object.freeze({ ...change }));
    }
  }

  // A private parser snapshot can be requested between edits of a transaction
  // (for indentation). Expose the exact already-applied splices without
  // delivering the public event early or sharing its mutable accumulator.
  getPendingAppliedChanges() {
    if (this.applyingEdit || !this.appliedChanges?.length) return null;
    return Object.freeze({
      beforeRevision: this.appliedChangesBeforeRevision,
      afterRevision: this._textRevision,
      changes: Object.freeze(this.appliedChanges.slice()),
    });
  }

  emitAppliedChanges(changes, origin, beforeRevision) {
    const afterRevision = this._textRevision;
    (this.appliedChangeBatches ||= []).push(
      Object.freeze({
        changes: Object.freeze(changes),
        origin,
        beforeRevision,
        afterRevision,
        isCurrent: () => !this.isDestroyed() && afterRevision === this._textRevision,
      }),
    );
    // An observer can make another edit. Finish delivering the current batch
    // before its nested batch so every range tracker sees application order.
    if (this.emittingAppliedChanges) return;
    this.emittingAppliedChanges = true;
    try {
      while (this.appliedChangeBatches.length)
        this.emitter.emit("did-apply-changes", this.appliedChangeBatches.shift());
    } finally {
      this.emittingAppliedChanges = false;
    }
  }

  updateDisplayLayersForChange(changeEvent) {
    for (const group of this.groupDisplayLayersByLayout()) {
      const source = this.mostCompletelyIndexedDisplayLayer(group);
      const layoutChange = source.bufferDidChange(changeEvent);
      for (const displayLayer of group) {
        if (displayLayer !== source) displayLayer.adoptSpatialStateFrom(source, layoutChange);
      }
    }
  }

  prepareDisplayLayersForChange(changeEvent) {
    for (const group of this.groupDisplayLayersByLayout()) {
      const source = this.mostCompletelyIndexedDisplayLayer(group);
      source.bufferWillChange(changeEvent);
      for (const displayLayer of group) {
        if (
          displayLayer !== source &&
          displayLayer.indexedBufferRowCount < source.indexedBufferRowCount
        ) {
          displayLayer.adoptSpatialStateFrom(source);
        }
      }
    }
  }

  groupDisplayLayersByLayout() {
    const groups = new Map();
    for (const id in this.displayLayers) {
      const displayLayer = this.displayLayers[id];
      let group = groups.get(displayLayer.layoutGroupId);
      if (!group) groups.set(displayLayer.layoutGroupId, (group = []));
      group.push(displayLayer);
    }
    return groups.values();
  }

  mostCompletelyIndexedDisplayLayer(group) {
    let source = group[0];
    for (let i = 1; i < group.length; i++) {
      if (group[i].indexedBufferRowCount > source.indexedBufferRowCount) source = group[i];
    }
    return source;
  }

  /**
   * @public
   * @status public
   *
   * Delete the text in the given range.
   *
   * @param {Range|Array|Object} range - A {@link Range} in which to delete. The range is clipped before deleting.
   * @returns {Range} empty {@link Range} starting at the start of deleted range.
   */
  delete(range) {
    return this.setTextInRange(range, "");
  }

  /**
   * @public
   * @status public
   *
   * Delete the line associated with a specified 0-indexed row.
   *
   * @param {Number} row - A `Number` representing the row to delete.
   * @returns {Range} of the deleted text.
   */
  deleteRow(row) {
    return this.deleteRows(row, row);
  }

  /**
   * @public
   * @status public
   *
   * Delete the lines associated with the specified 0-indexed row range.
   *
   * If the row range is out of bounds, it will be clipped. If the `startRow` is
   * greater than the `endRow`, they will be reordered.
   *
   * @param {Number} startRow - A `Number` representing the first row to delete.
   * @param {Number} endRow - A `Number` representing the last row to delete, inclusive.
   * @returns {Range} of the deleted text.
   */
  deleteRows(startRow, endRow) {
    let endPoint, startPoint;
    const lastRow = this.getLastRow();

    if (startRow > endRow) {
      [startRow, endRow] = [endRow, startRow];
    }

    if (endRow < 0) {
      return new Range(this.getFirstPosition(), this.getFirstPosition());
    }

    if (startRow > lastRow) {
      return new Range(this.getEndPosition(), this.getEndPosition());
    }

    startRow = Math.max(0, startRow);
    endRow = Math.min(lastRow, endRow);

    if (endRow < lastRow) {
      startPoint = new Point(startRow, 0);
      endPoint = new Point(endRow + 1, 0);
    } else {
      if (startRow === 0) {
        startPoint = new Point(startRow, 0);
      } else {
        startPoint = new Point(startRow - 1, this.lineLengthForRow(startRow - 1));
      }
      endPoint = new Point(endRow, this.lineLengthForRow(endRow));
    }

    return this.delete(new Range(startPoint, endPoint));
  }

  /**
   * @category Markers
   */

  /**
   * @public
   * @status public
   *
   * Create a layer to contain a set of related markers.
   *
   * @param {Object} [options] - An `Object` containing the following keys:
   * @param {Boolean} [options.maintainHistory] - A `Boolean` indicating whether or not the state of this layer should be restored on undo/redo operations. Defaults to `false`.
   * @param {Boolean} [options.persistent] - A `Boolean` indicating whether or not this marker layer should be serialized and deserialized along with the rest of the buffer. Defaults to `false`. If `true`, the marker layer's id will be maintained across the serialization boundary, allowing you to retrieve it via {@link #getMarkerLayer}.
   * @param {String} [options.role] - A `String` indicating role of this marker layer
   * @param {Function} [options.trackRanges] - A synchronous `(ranges, change)` callback overriding the ranges of markers touched by an edit. `ranges` is a sorted array of `{id, range}` entries in pre-edit buffer coordinates; each `range` is a {@link Range}. `change` contains `oldRange`, `newRange` and `newText`. Return an array of `{id, range}` entries in post-edit coordinates, using each supplied id at most once. Omitting an id or returning a null range invalidates that marker. Untouched markers follow the standard index update. The callback must not edit the buffer or markers; exceptions and invalid results are reported and invalidate the touched markers without cancelling the text edit. The callback is retained by layer copies but is not serialized; see {@link MarkerLayer#setRangeTracker} to replace or remove it.
   * @returns {MarkerLayer}
   */
  addMarkerLayer(options) {
    const layer = new MarkerLayer(this, String(this.nextMarkerLayerId++), options);
    this.markerLayers[layer.id] = layer;
    return layer;
  }

  /**
   * @public
   * @status public
   *
   * Get a {@link MarkerLayer} by id.
   *
   * @param {String} id - The id of the marker layer to retrieve.
   * @returns {MarkerLayer|undefined} The layer, or undefined when the id is unknown.
   */
  getMarkerLayer(id) {
    return this.markerLayers[id];
  }

  /**
   * @public
   * @status public
   *
   * Get the default {@link MarkerLayer}.
   *
   * All `Marker` APIs not tied to an explicit layer interact with this default
   * layer.
   *
   * @returns {MarkerLayer}
   */
  getDefaultMarkerLayer() {
    return this.defaultMarkerLayer;
  }

  /**
   * @public
   * @status public
   *
   * Create a `Marker` with the given range in the default {@link MarkerLayer}.
   * This marker will maintain its logical location as the buffer is changed,
   * so if you mark a particular word, the marker will remain over that word
   * even if the word's location in the buffer changes.
   *
   * @param {Range|Array|Object} range - A {@link Range} or range-compatible `Array`
   * @param {Object} [properties] - A hash of key-value pairs to associate with the marker. There are also reserved property names that have marker-specific meaning.
   * @param {Boolean} [properties.reversed] - Creates the marker in a reversed orientation. (default: false)
   * @param {String} [properties.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @param {Boolean} [properties.exclusive] - indicating whether insertions at the start or end of the marked range should be interpreted as happening *outside* the marker. Defaults to `false`, except when using the `inside` invalidation strategy or when the marker has no tail, in which case it defaults to true. Explicitly assigning this option overrides the default.
   * @returns {Marker}
   */
  markRange(range, properties) {
    return this.defaultMarkerLayer.markRange(range, properties);
  }

  /**
   * @public
   * @status public
   *
   * Create a `Marker` at the given position with no tail in the default
   * marker layer.
   *
   * @param {Point} position - or point-compatible `Array`
   * @param {Object} [options] - An `Object` with the following keys:
   * @param {String} [options.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @param {Boolean} [options.exclusive] - indicating whether insertions at the start or end of the marked range should be interpreted as happening *outside* the marker. Defaults to `false`, except when using the `inside` invalidation strategy or when the marker has no tail, in which case it defaults to true. Explicitly assigning this option overrides the default.
   * @returns {Marker}
   */
  markPosition(position, options) {
    return this.defaultMarkerLayer.markPosition(position, options);
  }

  /**
   * @public
   * @status public
   *
   * Get all existing markers on the default marker layer.
   *
   * @returns {Array<Marker>} The matching markers.
   */
  getMarkers() {
    return this.defaultMarkerLayer.getMarkers();
  }

  /**
   * @public
   * @status public
   *
   * Get an existing marker by its id from the default marker layer.
   *
   * @param {Number} id - id of the marker to retrieve
   * @returns {Marker|undefined} The marker on the default layer, or undefined when the id is unknown.
   */
  getMarker(id) {
    return this.defaultMarkerLayer.getMarker(id);
  }

  /**
   * @public
   * @status public
   *
   * Find markers conforming to the given parameters in the default
   * marker layer.
   *
   * Markers are sorted based on their position in the buffer. If two markers
   * start at the same position, the larger marker comes first.
   *
   * @param {Object} [params] - A hash of key-value pairs constraining the set of returned markers. You can query against custom marker properties by listing the desired key-value pairs here. In addition, the following keys are reserved and have special semantics:
   * @param {Point} [params.startPosition] - Only include markers that start at the given {@link Point}.
   * @param {Point} [params.endPosition] - Only include markers that end at the given {@link Point}.
   * @param {Range} [params.startsInRange] - Only include markers that start inside the given {@link Range}.
   * @param {Range} [params.endsInRange] - Only include markers that end inside the given {@link Range}.
   * @param {Point} [params.containsPoint] - Only include markers that contain the given {@link Point}, inclusive.
   * @param {Range} [params.containsRange] - Only include markers that contain the given {@link Range}, inclusive.
   * @param {Number} [params.startRow] - Only include markers that start at the given row `Number`.
   * @param {Number} [params.endRow] - Only include markers that end at the given row `Number`.
   * @param {Number} [params.intersectsRow] - Only include markers that intersect the given row `Number`.
   * @returns {Array<Marker>} The matching markers.
   */
  findMarkers(params) {
    return this.defaultMarkerLayer.findMarkers(params);
  }

  /**
   * @public
   * @status public
   *
   * Get the number of markers in the default marker layer.
   *
   * @returns {Number}
   */
  getMarkerCount() {
    return this.defaultMarkerLayer.getMarkerCount();
  }

  destroyMarker(id) {
    const marker = this.getMarker(id);
    if (marker) marker.destroy();
  }

  /**
   * @category History
   */

  setHistoryProvider(historyProvider) {
    this.historyProvider = historyProvider;
  }

  restoreDefaultHistoryProvider(history) {
    const provider = new DefaultHistoryProvider(this);
    provider.restoreFromSnapshot(history);
    return this.setHistoryProvider(provider);
  }

  getHistory(maxEntries) {
    if (this.transactCallDepth > 0) {
      throw new Error("Cannot build history snapshots within transactions");
    }

    const snapshot = this.historyProvider.getSnapshot(maxEntries);

    const baseTextBuffer = new TextStore(this.getTextSnapshot());
    for (const change of snapshot.undoPatch.getChanges()) {
      const edit = baseTextBuffer.prepareEditFromChange(change);
      try {
        edit.commit();
      } finally {
        edit.dispose();
      }
    }

    return {
      baseText: baseTextBuffer.getText(),
      undoStack: snapshot.undoStack,
      redoStack: snapshot.redoStack,
      nextCheckpointId: snapshot.nextCheckpointId,
    };
  }

  /**
   * @public
   * @status public
   *
   * Undo the last operation. If a transaction is in progress, aborts it.
   *
   * @param {Object} [options]
   * @param {MarkerLayer} [options.selectionsMarkerLayer] - Restore snapshot of selections marker layer to given selectionsMarkerLayer.
   * @returns {Boolean} of whether or not a change was made.
   */
  undo(options) {
    this.assertCanEdit();
    const pop = this.historyProvider.undo();
    if (!pop) return false;

    this.emitWillChangeEvent();
    this.transactCallDepth++;
    try {
      this.applyHistoryUpdates(pop.textUpdates, "undo");
    } finally {
      this.transactCallDepth--;
    }
    this.restoreFromMarkerSnapshot(pop.markers, options && options.selectionsMarkerLayer, "undo");
    const origin = this.emitDidChangeTextEvent();
    this.emitMarkerChangeEvents(pop.markers, origin);
    return true;
  }

  /**
   * @public
   * @status public
   *
   * Redo the last operation
   *
   * @param {Object} [options]
   * @param {MarkerLayer} [options.selectionsMarkerLayer] - Restore snapshot of selections marker layer to given selectionsMarkerLayer.
   * @returns {Boolean} of whether or not a change was made.
   */
  redo(options) {
    this.assertCanEdit();
    const pop = this.historyProvider.redo();
    if (!pop) return false;

    this.emitWillChangeEvent();
    this.transactCallDepth++;
    try {
      this.applyHistoryUpdates(pop.textUpdates, "redo");
    } finally {
      this.transactCallDepth--;
    }
    this.restoreFromMarkerSnapshot(pop.markers, options && options.selectionsMarkerLayer, "redo");
    const origin = this.emitDidChangeTextEvent();
    this.emitMarkerChangeEvents(pop.markers, origin);
    return true;
  }

  /**
   * @public
   * @status public
   *
   * Batch multiple operations as a single undo/redo step.
   *
   * Any group of operations that are logically grouped from the perspective of
   * undoing and redoing should be performed in a transaction. If you want to
   * abort the transaction, call {@link #abortTransaction} to terminate the function's
   * execution and revert any changes performed up to the abortion.
   *
   * Pass only a callback to use default options. A numeric first argument supplies a grouping interval.
   *
   * The callback runs synchronously; returned promises are not awaited before committing.
   *
   * @param {Object|Number|Function} [options]
   * @param {Number} [options.groupingInterval] - Milliseconds for which this
   *   transaction remains open for grouping. A subsequent transaction committed
   *   in that interval is merged with it for undo and redo.
   * @param {MarkerLayer} [options.selectionsMarkerLayer] - Skip snapshots for
   *   other selection marker layers.
   * @param {Function} [fn] - A `Function` to call inside the transaction.
   * @returns {*} The callback result, or undefined when the transaction is aborted.
   */
  transact(options, fn) {
    let groupingInterval, result, selectionsMarkerLayer;
    const revisionBefore = this.getTextRevision();
    let aborted = false;
    if (typeof options === "function") {
      fn = options;
      groupingInterval = 0;
    } else if (typeof options === "object") {
      ({ groupingInterval, selectionsMarkerLayer } = options);
      if (groupingInterval == null) {
        groupingInterval = 0;
      }
    } else {
      groupingInterval = options;
    }

    const checkpointBefore = this.historyProvider.createCheckpoint({
      markers: this.createMarkerSnapshot(selectionsMarkerLayer),
      isBarrier: true,
    });

    try {
      this.transactCallDepth++;
      result = fn();
    } catch (exception) {
      aborted = true;
      this.revertToCheckpoint(checkpointBefore, { deleteCheckpoint: true });
      if (!(exception instanceof TransactionAbortedError)) throw exception;
      return;
    } finally {
      this.transactCallDepth--;
      if (aborted && this.transactCallDepth === 0 && !this.isDestroyed()) {
        const origin = this.emitDidChangeTextEvent();
        this.emitMarkerChangeEvents(null, origin);
      }
    }

    if (this.isDestroyed()) return result;
    const endMarkerSnapshot = this.createMarkerSnapshot(selectionsMarkerLayer);
    this.historyProvider.groupChangesSinceCheckpoint(checkpointBefore, {
      markers: endMarkerSnapshot,
      deleteCheckpoint: true,
      returnChanges: false,
    });
    if (this.getTextRevision() !== revisionBefore) {
      this.historyProvider.applyGroupingInterval(groupingInterval);
    }
    this.historyProvider.enforceUndoStackSizeLimit();
    const origin = this.emitDidChangeTextEvent();
    this.emitMarkerChangeEvents(endMarkerSnapshot, origin);
    return result;
  }

  // Coalesce layer-level marker notifications without opening an undo
  // transaction or delaying individual Marker change events. TextEditor uses
  // this when one command moves a whole selection set.
  batchMarkerLayerUpdates(fn) {
    this.markerUpdateBatchDepth++;
    try {
      return fn();
    } finally {
      this.markerUpdateBatchDepth--;
      this.emitPendingMarkerLayerUpdateEvents();
    }
  }

  // Scalar selection edits still expose every intermediate text state. Defer
  // history after row shifts; column-only edits keep their local index probes.
  // Snapshot readers flush dirty maps even inside a nested batch.
  batchMarkerHistory(fn) {
    const layers = Object.values(this.markerLayers).filter((layer) => layer.historyShadow);
    for (const layer of layers) layer.beginHistoryBatch(false);
    try {
      return fn();
    } finally {
      for (const layer of layers) layer.endHistoryBatch(false);
    }
  }

  /**
   * @public
   * @status public
   *
   * Abort the currently running transaction
   *
   * Only intended to be called within the `fn` option to {@link #transact}
   */
  abortTransaction() {
    throw new TransactionAbortedError("Transaction aborted.");
  }

  /**
   * @public
   * @status public
   *
   * Clear the undo stack.
   */
  clearUndoStack() {
    return this.historyProvider.clearUndoStack();
  }

  /**
   * @public
   * @status extended
   *
   * Clear the redo stack without changing text or the undo stack.
   */
  clearRedoStack() {
    return this.historyProvider.clearRedoStack();
  }

  /**
   * @public
   * @status public
   *
   * Create a pointer to the current state of the buffer for use
   * with {@link #revertToCheckpoint} and {@link #groupChangesSinceCheckpoint}.
   *
   * @param {Object} [options]
   * @param {MarkerLayer} [options.selectionsMarkerLayer] - When provided, skip taking snapshot for other selections markerLayers except given one.
   * @returns {Number} checkpoint id value.
   */
  createCheckpoint(options) {
    return this.historyProvider.createCheckpoint({
      markers: this.createMarkerSnapshot(options?.selectionsMarkerLayer ?? undefined),
      isBarrier: false,
    });
  }

  /**
   * @public
   * @status public
   *
   * Revert the buffer to the state it was in when the given
   * checkpoint was created.
   *
   * The redo stack will be empty following this operation, so changes since the
   * checkpoint will be lost. If the given checkpoint is no longer present in the
   * undo history, no changes will be made to the buffer and this method returns false.
   *
   * @param {Number} checkpoint - id of the checkpoint to revert to.
   * @param {Object} [options]
   * @param {MarkerLayer} [options.selectionsMarkerLayer] - Restore snapshot of selections marker layer to given selectionsMarkerLayer.
   * @returns {Boolean} Whether the operation succeeded.
   */
  revertToCheckpoint(checkpoint, options) {
    this.assertCanEdit();
    const truncated = this.historyProvider.revertToCheckpoint(checkpoint);
    if (!truncated) return false;
    if (truncated.textUpdates.length > 0) this.emitWillChangeEvent();
    this.transactCallDepth++;
    try {
      this.applyHistoryUpdates(truncated.textUpdates);
    } finally {
      this.transactCallDepth--;
    }
    this.restoreFromMarkerSnapshot(truncated.markers, options && options.selectionsMarkerLayer);
    const origin = this.emitDidChangeTextEvent();
    this.emitter.emit("did-update-markers");
    this.emitMarkerChangeEvents(truncated.markers, origin);
    return true;
  }

  /**
   * @public
   * @status public
   *
   * Group all changes since the given checkpoint into a single
   * transaction for purposes of undo/redo.
   *
   * If the given checkpoint is no longer present in the undo history, no
   * grouping will be performed and this method will return `false`.
   *
   * @param {Number} checkpoint - id of the checkpoint to group changes since.
   * @param {Object} [options]
   * @param {MarkerLayer} [options.selectionsMarkerLayer] - When provided, skip taking snapshot for other selections markerLayers except given one.
   * @returns {Boolean} indicating whether the operation succeeded.
   */
  groupChangesSinceCheckpoint(checkpoint, options) {
    return this.historyProvider.groupChangesSinceCheckpoint(checkpoint, {
      markers: this.createMarkerSnapshot(options && options.selectionsMarkerLayer),
      deleteCheckpoint: false,
    });
  }

  /**
   * @public
   * @status public
   *
   * Group the last two text changes for purposes of undo/redo.
   *
   * This operation will only succeed if there are two changes on the undo
   * stack. It will not group past the beginning of an open transaction.
   *
   * @returns {Boolean} indicating whether the operation succeeded.
   */
  groupLastChanges() {
    return this.historyProvider.groupLastChanges();
  }

  /**
   * @public
   * @status public
   *
   * Get the aggregated text changes since a checkpoint.
   *
   * If the given checkpoint is no longer present in the undo history, this
   * method will return an empty `Array`.
   *
   *
   * * `oldRange` The {@link Range} of the deleted text in the text as it existed when
   *   the checkpoint was created.
   * * `newRange`: The {@link Range} of the inserted text in the current text.
   * * `oldText`: A `String` representing the deleted text.
   * * `newText`: A `String` representing the inserted text.
   *
   * @param {Number} checkpoint - id of the checkpoint to get changes since.
   * @returns {Array<Object>} Changes since the checkpoint. See *Working With Aggregated Changes* in the {@link TextBuffer} class description for the fields.
   */
  getChangesSinceCheckpoint(checkpoint) {
    const changes = this.historyProvider.getChangesSinceCheckpoint(checkpoint);
    if (changes) {
      return normalizePatchChanges(changes);
    } else {
      return [];
    }
  }

  /**
   * @category Searching and Replacing
   */

  /**
   * @public
   * @status public
   *
   * Scan regular expression matches in the entire buffer, calling the
   * given iterator function on each match.
   *
   * If you're programmatically modifying the results, you may want to try
   * {@link #backwardsScan} to avoid tripping over your own changes.
   *
   * When options is omitted, pass the callback in its place.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Object|Function} [options]
   * @param {Number} [options.leadingContextLineCount] - default `0`; The number of lines before the matched line to include in the results object.
   * @param {Number} [options.trailingContextLineCount] - default `0`; The number of lines after the matched line to include in the results object.
   * @param {Function} [iterator] - A `Function` that's called on each match with an `Object` containing the following keys:
   * @param {Object} iterator.result - Match information supplied as the callback's only argument.
   * @param {Array} iterator.result.match - The current regular expression match.
   * @param {String} iterator.result.matchText - A `String` with the text of the match.
   * @param {Range} iterator.result.range - The {@link Range} of the match.
   * @param {Function} iterator.result.stop - Call this `Function` to terminate the scan.
   * @param {Function} iterator.result.replace - Call this `Function` with a `String` to replace the match.
   * @param {Array<String>} iterator.result.leadingContextLines - An `Array` with `leadingContextLineCount` lines before the match.
   * @param {Array<String>} iterator.result.trailingContextLines - An `Array` with `trailingContextLineCount` lines after the match.
   */
  scan(regex, options = {}, iterator) {
    if (_.isFunction(options)) {
      iterator = options;
      options = {};
    }

    return this.scanInRange(regex, this.getRange(), options, iterator);
  }

  /**
   * @public
   * @status public
   *
   * Scan regular expression matches in the entire buffer in reverse
   * order, calling the given iterator function on each match.
   *
   * When options is omitted, pass the callback in its place.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Object|Function} [options]
   * @param {Number} [options.leadingContextLineCount] - default `0`; The number of lines before the matched line to include in the results object.
   * @param {Number} [options.trailingContextLineCount] - default `0`; The number of lines after the matched line to include in the results object.
   * @param {Function} [iterator] - A `Function` that's called on each match with an `Object` containing the following keys:
   * @param {Object} iterator.result - Match information supplied as the callback's only argument.
   * @param {Array} iterator.result.match - The current regular expression match.
   * @param {String} iterator.result.matchText - A `String` with the text of the match.
   * @param {Range} iterator.result.range - The {@link Range} of the match.
   * @param {Function} iterator.result.stop - Call this `Function` to terminate the scan.
   * @param {Function} iterator.result.replace - Call this `Function` with a `String` to replace the match.
   * @param {Array<String>} iterator.result.leadingContextLines - An `Array` with `leadingContextLineCount` lines before the match.
   * @param {Array<String>} iterator.result.trailingContextLines - An `Array` with `trailingContextLineCount` lines after the match.
   */
  backwardsScan(regex, options = {}, iterator) {
    if (_.isFunction(options)) {
      iterator = options;
      options = {};
    }

    return this.backwardsScanInRange(regex, this.getRange(), options, iterator);
  }

  /**
   * @public
   * @status public
   *
   * Scan regular expression matches in a given range , calling the given
   * iterator function on each match.
   *
   * When options is omitted, pass the callback in its place.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Range|Array|Object} range - A {@link Range} in which to search.
   * @param {Object|Function} [options]
   * @param {Number} [options.leadingContextLineCount] - default `0`; The number of lines before the matched line to include in the results object.
   * @param {Number} [options.trailingContextLineCount] - default `0`; The number of lines after the matched line to include in the results object.
   * @param {Function} [callback] - A `Function` that's called on each match with an `Object` containing the following keys:
   * @param {Object} callback.result - Match information supplied as the callback's only argument.
   * @param {Array} callback.result.match - The current regular expression match.
   * @param {String} callback.result.matchText - A `String` with the text of the match.
   * @param {Range} callback.result.range - The {@link Range} of the match.
   * @param {Function} callback.result.stop - Call this `Function` to terminate the scan.
   * @param {Function} callback.result.replace - Call this `Function` with a `String` to replace the match.
   * @param {Array<String>} callback.result.leadingContextLines - An `Array` with `leadingContextLineCount` lines before the match.
   * @param {Array<String>} callback.result.trailingContextLines - An `Array` with `trailingContextLineCount` lines after the match.
   * @param {Boolean} [reverse] - Visit matches in reverse order. Defaults to false.
   */
  scanInRange(regex, range, options = {}, callback, reverse = false) {
    if (_.isFunction(options)) {
      reverse = callback;
      callback = options;
      options = {};
    }

    range = this.clipRange(range);
    if (!regex.global && !reverse) {
      // A forward scan without /g visits only its first match. Avoid finding
      // and allocating every other match in the range before that callback.
      return scanFirstMatchInRange(this, regex, range, options, callback);
    }
    const matchRanges = this.findAllInRangeSync(regex, range);
    let startIndex = 0;
    let endIndex = matchRanges.length;
    let increment = 1;
    let previousRow = -1;
    let replacementColumnDelta = 0;
    if (reverse) {
      startIndex = matchRanges.length - 1;
      endIndex = -1;
      increment = -1;
    }

    for (let i = startIndex; i !== endIndex; i += increment) {
      const matchRange = matchRanges[i];
      if (range.end.isEqual(matchRange.start) && range.end.column > 0) continue;
      if (matchRange.start.row !== previousRow) {
        replacementColumnDelta = 0;
      }
      previousRow = matchRange.start.row;
      matchRange.start.column += replacementColumnDelta;
      matchRange.end.column += replacementColumnDelta;

      const argument = new SearchCallbackArgument(
        this,
        Range.fromObject(matchRange),
        regex,
        options,
      );
      callback(argument);
      if (argument.stopped || !regex.global) break;

      if (!reverse && argument.replacementText != null) {
        replacementColumnDelta +=
          matchRange.start.column + argument.replacementText.length - matchRange.end.column;
      }
    }
  }

  /**
   * @public
   * @status public
   *
   * Scan regular expression matches in a given range in reverse order,
   * calling the given iterator function on each match.
   *
   * When options is omitted, pass the callback in its place.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Range|Array|Object} range - A {@link Range} in which to search.
   * @param {Object|Function} [options]
   * @param {Number} [options.leadingContextLineCount] - default `0`; The number of lines before the matched line to include in the results object.
   * @param {Number} [options.trailingContextLineCount] - default `0`; The number of lines after the matched line to include in the results object.
   * @param {Function} [iterator] - A `Function` that's called on each match with an `Object` containing the following keys:
   * @param {Object} iterator.result - Match information supplied as the callback's only argument.
   * @param {Array} iterator.result.match - The current regular expression match.
   * @param {String} iterator.result.matchText - A `String` with the text of the match.
   * @param {Range} iterator.result.range - The {@link Range} of the match.
   * @param {Function} iterator.result.stop - Call this `Function` to terminate the scan.
   * @param {Function} iterator.result.replace - Call this `Function` with a `String` to replace the match.
   */
  backwardsScanInRange(regex, range, options = {}, iterator) {
    if (_.isFunction(options)) {
      iterator = options;
      options = {};
    }

    return this.scanInRange(regex, range, options, iterator, true);
  }

  /**
   * @public
   * @status public
   *
   * Replace all regular expression matches in the entire buffer.
   *
   * @param {RegExp} regex - A `RegExp` representing the matches to be replaced.
   * @param {String} replacementText - A `String` representing the text to replace each match.
   * @returns {Number} representing the number of replacements made.
   */
  replace(regex, replacementText) {
    this.assertCanEdit();
    replacementText = String(replacementText);

    const flags = regex.global ? regex.flags : `${regex.flags}g`;
    const globalRegex = new RegExp(regex.source, flags);
    const sourceText = this.getText();
    const source = this.getTextSnapshot();
    const replacements = [];
    const unicode = globalRegex.unicode || globalRegex.unicodeSets;
    let match;

    while ((match = globalRegex.exec(sourceText)) != null) {
      const startIndex = match.index;
      const endIndex = startIndex + match[0].length;
      const start = source.positionAt(startIndex),
        end = source.positionAt(endIndex);
      const range = new Range(this.clipPosition(start), this.clipPosition(end));
      replacements.push({
        range,
        oldText: match[0],
        physicalRange:
          start.column !== range.start.column || end.column !== range.end.column
            ? { start, end }
            : null,
        text: getSubstitution(
          match[0],
          sourceText,
          startIndex,
          match.slice(1),
          match.groups,
          replacementText,
        ),
      });

      if (match[0].length === 0) {
        globalRegex.lastIndex = advanceStringIndex(sourceText, globalRegex.lastIndex, unicode);
      }
    }

    this.transact(() => {
      if (
        !replacements.some((replacement) => replacement.physicalRange) &&
        this.tryApplyIndependentEdits(replacements, true)
      )
        return;
      for (let i = replacements.length - 1; i >= 0; i--) {
        const replacement = replacements[i];
        if (replacement.physicalRange) {
          // Editor positions clip the interior of CRLF. Regex indices do not:
          // preserve either half through storage's physical-boundary handling.
          this.emitWillChangeEvent();
          const { start, end } = replacement.physicalRange;
          this.applyChange(
            this.buffer.prepareEditFromChange({
              oldStart: start,
              oldEnd: end,
              newStart: start,
              oldText: replacement.oldText,
              newText: replacement.text,
            }),
            { recordHistory: true },
          );
        } else {
          this.setTextInRange(replacement.range, replacement.text, {
            normalizeLineEndings: false,
          });
        }
      }
    });

    return replacements.length;
  }

  /**
   * @public
   * @status experimental
   *
   * Asynchronously search the buffer for a given regex.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @returns {Promise<Object|null>} Resolves to the first range-compatible object with start/end points, or null when no match exists. Use {@link Range.fromObject} when a Range instance is needed.
   */
  find(regex) {
    return this.buffer.find(regex);
  }

  /**
   * @public
   * @status experimental
   *
   * Asynchronously search a given range of the buffer for a given regex.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Range|Array|Object} range - A {@link Range} to search within.
   * @returns {Promise<Object|null>} Resolves to the first range-compatible object with start/end points, or null when no match exists. Use {@link Range.fromObject} when a Range instance is needed.
   */
  findInRange(regex, range) {
    return this.buffer.findInRange(regex, Range.fromObject(range));
  }

  /**
   * @public
   * @status experimental
   *
   * Search the buffer for a given regex.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @returns {Object|null} The first range-compatible object with start/end points, or null when no match exists. Use {@link Range.fromObject} when a Range instance is needed.
   */
  findSync(regex) {
    return this.buffer.findSync(regex);
  }

  /**
   * @public
   * @status experimental
   *
   * Search a given range of the buffer for a given regex.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Range|Array|Object} range - A {@link Range} to search within.
   * @returns {Object|null} The first range-compatible object with start/end points, or null when no match exists. Use {@link Range.fromObject} when a Range instance is needed.
   */
  findInRangeSync(regex, range) {
    return this.buffer.findInRangeSync(regex, Range.fromObject(range));
  }

  /**
   * @public
   * @status experimental
   *
   * Asynchronously search the buffer for a given regex.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @returns {Promise<Array<Object>>} Resolves to range-compatible objects with start/end points. Convert an entry with {@link Range.fromObject} when a Range instance is needed.
   */
  findAll(regex) {
    return this.buffer.findAll(regex);
  }

  /**
   * @public
   * @status experimental
   *
   * Asynchronously search a given range of the buffer for a given regex.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Range|Array|Object} range - A {@link Range} to search within.
   * @returns {Promise<Array<Object>>} Resolves to range-compatible objects with start/end points. Convert an entry with {@link Range.fromObject} when a Range instance is needed.
   */
  findAllInRange(regex, range) {
    return this.buffer.findAllInRange(regex, Range.fromObject(range));
  }

  /**
   * @public
   * @status experimental
   *
   * Run an regexp search on the buffer
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @returns {Array<Object>} Range-compatible objects with start/end points. Convert an entry with {@link Range.fromObject} when a Range instance is needed.
   */
  findAllSync(regex) {
    return this.buffer.findAllSync(regex);
  }

  /**
   * @public
   * @status experimental
   *
   * Search a given range of the buffer for a given regex.
   *
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Range|Array|Object} range - A {@link Range} to search within.
   * @returns {Array<Object>} Range-compatible objects with start/end points. Convert an entry with {@link Range.fromObject} when a Range instance is needed.
   */
  findAllInRangeSync(regex, range) {
    return this.buffer.findAllInRangeSync(regex, Range.fromObject(range));
  }

  /**
   * @public
   * @status experimental
   *
   * Search a given range of the buffer for a given regex. Store
   * the matching ranges in the given marker layer.
   *
   * @param {MarkerLayer} markerLayer - A {@link MarkerLayer} to populate.
   * @param {RegExp} regex - A `RegExp` to search for.
   * @param {Range|Array|Object} range - A {@link Range} to search within.
   * @param {Object} [options] - Options for this operation.
   * @param {Boolean} [options.exclusive] - Treat edits at the marker endpoints as outside the marker.
   * @param {String} [options.invalidate=overlap] - Marker invalidation strategy; see {@link #markRange}.
   * @param {Boolean} [options.tailed=true] - Whether each match marker retains a tail.
   * @returns {Array<Marker>} The matching markers.
   */
  findAndMarkAllInRangeSync(markerLayer, regex, range, options = {}) {
    const startId = this.nextMarkerId;
    const exclusive =
      options.exclusive ?? (options.invalidate === "inside" || options.tailed === false);
    for (const match of this.buffer.findAllInRangeSync(regex, Range.fromObject(range))) {
      const id = this.nextMarkerId++;
      markerLayer.index.insert(id, match.start, match.end);
      markerLayer.index.setExclusive(id, exclusive);
    }
    const markers = [];
    for (let id = startId; id < this.nextMarkerId; id++) {
      const marker = new Marker(id, markerLayer, null, options, true);
      markerLayer.markersById.set(id, marker);
      markers.push(marker);
    }
    return markers;
  }

  /**
   * @public
   * @status experimental
   *
   * Find fuzzy match suggestions in the buffer
   *
   * @param {String} query - A `String` to search for.
   * @param {String} extraWordCharacters - A `String` of additional word characters to use when deciphering word boundaries
   * @param {Number} maxCount - A `Number` that limits the number of matches returned
   * @returns {Promise<Array<Object>|null>} Resolves to subsequence matches containing plain row/column positions, or null when the search provides no result.
   */
  findWordsWithSubsequence(query, extraWordCharacters, maxCount) {
    return this.buffer.findWordsWithSubsequence(query, extraWordCharacters, maxCount);
  }

  /**
   * @public
   * @status experimental
   *
   * Find fuzzy match suggestions in the buffer in a given range
   *
   * @param {String} query - A `String` to search for.
   * @param {String} extraWordCharacters - A `String` of additional word characters to use when deciphering word boundaries
   * @param {Number} maxCount - A `Number` that limits the number of matches returned
   * @param {Range|Array|Object} range - A {@link Range} that specifies the portion of the buffer to search
   * @returns {Promise<Array<Object>|null>} Resolves to subsequence matches containing plain row/column positions, or null when the search provides no result.
   */
  findWordsWithSubsequenceInRange(query, extraWordCharacters, maxCount, range) {
    return this.buffer.findWordsWithSubsequenceInRange(
      query,
      extraWordCharacters,
      maxCount,
      Range.fromObject(range),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Find completion words in an immutable snapshot without allocating every
   * occurrence. Coordinates are absolute UTF-16 buffer points. Each result
   * contains word, score, matchIndices, the first position, occurrences,
   * minimum row distance and containsPosition (inclusive of the word's end).
   * Words and queries are limited to 80 UTF-16 units. Word characters cannot
   * include line endings; use the legacy subsequence API for multiline tokens.
   * @param {String} query - Typed subsequence.
   * @param {Object} [options] - Search options.
   * @param {Range} [options.range] - Clipped search range; defaults to the buffer.
   * @param {Point} [options.position] - Cursor for distance and containment.
   * @param {String} [options.extraWordCharacters] - Additional word characters.
   * @param {Number} [options.maxCount=20] - Maximum distinct words returned.
   * @param {AbortSignal} [options.signal] - Cancel obsolete work; resolves to an empty list.
   * @returns {Promise<Array<Object>>} Ranked candidates. Distance is Infinity without a position.
   * @category Searching
   */
  findWordCandidates(query, options = {}) {
    return this.buffer.findWordCandidates(query, {
      ...options,
      range: options.range ? this.clipRange(options.range) : undefined,
      position: options.position ? this.clipPosition(options.position) : undefined,
    });
  }

  /**
   * @category Buffer Range Details
   */

  /**
   * @public
   * @status public
   *
   * Get the range spanning from `[0, 0]` to {@link #getEndPosition}.
   *
   * @returns {Range}
   */
  getRange() {
    return new Range(this.getFirstPosition(), this.getEndPosition());
  }

  /**
   * @public
   * @status public
   *
   * Get the number of lines in the buffer.
   *
   * @returns {Number}
   */
  getLineCount() {
    return this.buffer.getLineCount();
  }

  /**
   * @public
   * @status public
   *
   * Get the last 0-indexed row in the buffer.
   *
   * @returns {Number}
   */
  getLastRow() {
    return this.getLineCount() - 1;
  }

  /**
   * @public
   * @status public
   *
   * Get the first position in the buffer, which is always `[0, 0]`.
   *
   * @returns {Point}
   */
  getFirstPosition() {
    return new Point(0, 0);
  }

  /**
   * @public
   * @status public
   *
   * Get the maximal position in the buffer, where new text would be
   * appended.
   *
   * @returns {Point}
   */
  getEndPosition() {
    return Point.fromObject(this.buffer.getExtent());
  }

  /**
   * @public
   * @status public
   *
   * Get the length of the buffer's text.
   * @returns {Number} The number of UTF-16 code units, including line endings.
   */
  getLength() {
    return this.buffer.getLength();
  }

  /**
   * @public
   * @status public
   *
   * Get the length of the buffer in characters.
   *
   * @returns {Number}
   */
  getMaxCharacterIndex() {
    return this.characterIndexForPosition(Point.INFINITY);
  }

  /**
   * @public
   * @status public
   *
   * Get the range for the given row
   *
   * @param {Number} row - A `Number` representing a 0-indexed row.
   * @param {Boolean} [includeNewline] - A `Boolean` indicating whether or not to include the newline, which results in a range that extends to the start of the next line. (default: `false`)
   * @returns {Range}
   */
  rangeForRow(row, includeNewline) {
    row = Math.max(row, 0);
    row = Math.min(row, this.getLastRow());
    if (includeNewline && row < this.getLastRow()) {
      return new Range(new Point(row, 0), new Point(row + 1, 0));
    } else {
      return new Range(new Point(row, 0), new Point(row, this.lineLengthForRow(row)));
    }
  }

  /**
   * @public
   * @status public
   *
   * Convert a position in the buffer in row/column coordinates to an
   * absolute character offset, inclusive of line ending characters.
   *
   * The position is clipped prior to translating.
   *
   * @param {Point|Array<Number>|Object} position - A {@link Point} or point-compatible `Array`.
   * @returns {Number}
   */
  characterIndexForPosition(position) {
    return this.buffer.characterIndexForPosition(Point.fromObject(position));
  }

  /**
   * @public
   * @status public
   *
   * Convert an absolute character offset, inclusive of newlines, to a
   * position in the buffer in row/column coordinates.
   *
   * The offset is clipped prior to translating.
   *
   * @param {Number} offset - A `Number`.
   * @returns {Point}
   */
  positionForCharacterIndex(offset) {
    return Point.fromObject(this.buffer.positionForCharacterIndex(offset));
  }

  /**
   * @public
   * @status public
   *
   * Clip the given range so it starts and ends at valid positions.
   *
   * For example, the position `[1, 100]` is out of bounds if the line at row 1 is
   * only 10 characters long, and it would be clipped to `(1, 10)`.
   *
   * @param {Range|Array|Object} range - A {@link Range} or range-compatible `Array` to clip.
   * @returns {Range} given {@link Range} if it is already in bounds, or a new clipped {@link Range} if the given range is out-of-bounds.
   */
  clipRange(range) {
    range = Range.fromObject(range);
    if (this.clipPosition === defaultClipPosition && range.start.row === range.end.row) {
      Point.assertValid(range.start);
      Point.assertValid(range.end);
      const row = range.start.row;
      if (row >= 0 && row <= this.getLastRow()) {
        // Both endpoints share the same bounds. A single-row edit should not
        // repeat the line count and line length lookups for each point.
        const lineLength = this.lineLengthForRow(row);
        const start =
          range.start.column < 0
            ? new Point(row, 0)
            : range.start.column > lineLength
              ? new Point(row, lineLength)
              : range.start;
        const end =
          range.end.column < 0
            ? new Point(row, 0)
            : range.end.column > lineLength
              ? new Point(row, lineLength)
              : range.end;
        return start === range.start && end === range.end ? range : new Range(start, end);
      }
    }
    const start = this.clipPosition(range.start);
    const end = this.clipPosition(range.end);
    if (range.start.isEqual(start) && range.end.isEqual(end)) {
      return range;
    } else {
      return new Range(start, end);
    }
  }

  /**
   * @public
   * @status public
   *
   * Clip the given point so it is at a valid position in the buffer.
   *
   * For example, the position (1, 100) is out of bounds if the line at row 1 is
   * only 10 characters long, and it would be clipped to (1, 10)
   *
   * @param {Point|Array<Number>|Object} position - A {@link Point} or point-compatible `Array`.
   * @param {Object} [options] - Options for this operation.
   * @param {String} [options.clipDirection] - The value forward moves a position at or beyond a non-final line ending to the start of the next row.
   * @returns {Point} new {@link Point} if the given position is invalid, otherwise returns the given position.
   */
  clipPosition(position, options) {
    position = Point.fromObject(position);
    Point.assertValid(position);
    const { row, column } = position;
    if (row < 0) {
      return this.getFirstPosition();
    } else if (row > this.getLastRow()) {
      return this.getEndPosition();
    } else if (column < 0) {
      return Point(row, 0);
    } else if (column === 0 && options?.clipDirection !== "forward") {
      // Every line contains its start; only forward clipping can cross it.
      return position;
    } else {
      const lineLength = this.lineLengthForRow(row);
      if (
        column >= lineLength &&
        row < this.getLastRow() &&
        options &&
        options.clipDirection === "forward"
      ) {
        return new Point(row + 1, 0);
      } else if (column > lineLength) {
        return new Point(row, lineLength);
      } else {
        return position;
      }
    }
  }

  /**
   * @category Buffer Operations
   */

  /**
   * @public
   * @status public
   *
   * Save the buffer.
   *
   * @param {Object} [options]
   * @param {EditorWindow} [options.window] - Window that owns a save-confirmation notification; defaults to the focused window.
   * @returns {Promise<TextBuffer>} Resolves to the saved buffer, or rejects with SaveCancelledError when confirmation is cancelled.
   */
  save(options = {}) {
    return this.saveTo(this.file, options);
  }

  /**
   * @public
   * @status public
   *
   * Save the buffer at a specific path.
   *
   * @param {String} filePath - The path to save at.
   * @param {Object} [options]
   * @param {EditorWindow} [options.window] - Window that owns a save-confirmation notification; defaults to the focused window.
   * @returns {Promise<TextBuffer>} Resolves to the saved buffer, or rejects with SaveCancelledError when confirmation is cancelled. A successful save to another path clears the confirmation policy.
   */
  saveAs(filePath, options = {}) {
    if (!filePath) {
      throw new Error("Can't save buffer with no file path");
    }
    let file;
    if (this.file?.getPath() === filePath) {
      file = this.file;
    } else {
      file = new File(filePath);
    }
    return this.saveTo(file, options);
  }

  /**
   * @public
   * @status public
   *
   * Require confirmation before saving to the current backing path. The
   * serializable policy is shared by all editors of this buffer. The warning
   * offers approval once, approval for this buffer's session, or cancellation.
   * Session approval is not serialized. Setting the same policy again
   * preserves its pending warning and session approval.
   *
   * @param {Object|null} confirmation - Warning text, or null to clear it.
   * @param {String} confirmation.message - The question shown before saving.
   * @param {String} [confirmation.detail] - Additional plain-text context.
   */
  setSaveConfirmation(confirmation) {
    if (confirmation != null) {
      if (
        typeof confirmation !== "object" ||
        Array.isArray(confirmation) ||
        typeof confirmation.message !== "string" ||
        !confirmation.message.trim() ||
        (confirmation.detail != null && typeof confirmation.detail !== "string")
      ) {
        throw new TypeError("Save confirmation requires a message and optional detail strings");
      }
      if (!this.getPath()) throw new Error("Save confirmation requires a backing path");
      if (
        this.saveConfirmation &&
        sameSavePath(this.saveConfirmation.path, this.getPath()) &&
        this.saveConfirmation.message === confirmation.message &&
        this.saveConfirmation.detail === (confirmation.detail ?? undefined)
      ) {
        return;
      }
    }
    this.pendingConfirmedSave?.cancel();
    this.saveConfirmationDecision = "ask";
    this.saveConfirmation =
      confirmation == null
        ? null
        : {
            path: this.getPath(),
            message: confirmation.message,
            ...(confirmation.detail == null ? {} : { detail: confirmation.detail }),
          };
  }

  /**
   * @public
   * @status public
   *
   * Return a copy of the current backing path's save-confirmation policy.
   *
   * @returns {Object|null} The message and optional detail, or null.
   */
  getSaveConfirmation() {
    if (!this.saveConfirmation || !sameSavePath(this.saveConfirmation.path, this.getPath())) {
      return null;
    }
    const { message, detail } = this.saveConfirmation;
    return { message, ...(detail == null ? {} : { detail }) };
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current path can be saved automatically without
   * asking for confirmation. Ordinary buffers and paths approved for this
   * buffer's session return true; policies awaiting approval return false.
   *
   * @returns {Boolean} Whether an automatic save may proceed.
   */
  canSaveAutomatically() {
    return (
      !this.saveConfirmation ||
      !sameSavePath(this.saveConfirmation.path, this.getPath()) ||
      this.saveConfirmationDecision === "always"
    );
  }

  /** @private */
  saveTo(file, options = {}) {
    if (this.destroyed) return Promise.reject(new Error("Can't save destroyed buffer"));
    if (!file) return Promise.reject(new Error("Can't save a buffer with no file"));
    const filePath = file.getPath();
    const confirmation = this.saveConfirmation;
    if (!confirmation || !sameSavePath(confirmation.path, filePath)) {
      return this.performSave(file);
    }
    const pending = this.pendingConfirmedSave;
    if (pending && sameSavePath(pending.path, filePath) && !pending.cancelled) {
      return pending.promise;
    }
    const operation = {
      path: filePath,
      confirmation,
      fileOperationGeneration: this.fileOperationGeneration,
      started: false,
      cancelled: false,
      cancel: () => {
        operation.cancelled = true;
        operation.cancelPrompt?.();
      },
    };
    this.pendingConfirmedSave = operation;
    operation.promise = Promise.resolve()
      .then(() => {
        this.assertConfirmedSaveCurrent(operation);
        return this.saveConfirmationDecision === "always"
          ? "always"
          : confirmSave(this, confirmation, operation, options.window);
      })
      .then((decision) => {
        this.assertConfirmedSaveCurrent(operation);
        if (decision === "always") this.saveConfirmationDecision = "always";
        return this.performSave(file, operation);
      })
      .finally(() => {
        if (this.pendingConfirmedSave === operation) this.pendingConfirmedSave = null;
      });
    return operation.promise;
  }

  /** @private */
  assertConfirmedSaveCurrent(operation) {
    if (
      this.destroyed ||
      operation.cancelled ||
      this.saveConfirmation !== operation.confirmation ||
      (!operation.started && operation.fileOperationGeneration !== this.fileOperationGeneration) ||
      !sameSavePath(operation.path, this.getPath())
    ) {
      throw new SaveCancelledError("Save cancelled because the buffer or its backing file changed");
    }
  }

  /** @private */
  async performSave(file, operation) {
    if (this.destroyed) throw new Error("Can't save destroyed buffer");
    if (!file) throw new Error("Can't save a buffer with no file");

    const filePath = file.getPath();

    if (operation) operation.started = true;
    this.fileOperationGeneration++;
    this.outstandingSaveCount++;

    try {
      let destination;
      if (file instanceof File) {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        destination = filePath;
      } else {
        destination = file.createWriteStream();
      }

      await this.emitter.emitAsync("will-save", { path: filePath });
      if (operation) this.assertConfirmedSaveCurrent(operation);

      try {
        await this.buffer.save(destination, this.getEncoding());
        this.didHaveFileOnDisk = true;
      } catch (error) {
        if (!["EACCES", "EPERM"].includes(error.code) || destination !== filePath) throw error;

        const isWindows = process.platform === "win32";
        if (isWindows) {
          const winattr = await getWinattr();
          const attrs = await winattr.getAttributes(filePath);
          if (!attrs.hidden) throw error;

          try {
            await winattr.setAttributes(filePath, { hidden: false });
            try {
              await this.buffer.save(filePath, this.getEncoding());
            } finally {
              await winattr.setAttributes(filePath, { hidden: true });
            }
          } catch {
            throw error;
          }
        } else {
          const fsAdmin = require("@lumine-code/fs-admin");
          try {
            await this.buffer.save(fsAdmin.createWriteStream(filePath), this.getEncoding());
          } catch {
            throw error;
          }
        }
      }
    } finally {
      this.outstandingSaveCount--;
      if (this.pendingFileReconcile) queueMicrotask(() => void this.reconcileWatchedFile?.());
    }

    this.setFile(file);
    this.fileOperationGeneration++;
    this.digestWhenLastPersisted = this.buffer.baseTextDigest();
    this.loaded = true;
    this.updateFileStateFromBuffer({ resolveStickyState: true });
    this.emitter.emit("did-save", { path: filePath });
    return this;
  }

  /**
   * @public
   * @status public
   *
   * Reload the file's content from disk.
   *
   * @returns {Promise<TextBuffer|undefined>} Resolves to this buffer after loading, or undefined when a newer operation supersedes the load.
   */
  async reload() {
    this.explicitReloadDepth++;
    try {
      return await this.load({ discardChanges: true, internal: true });
    } finally {
      this.explicitReloadDepth--;
      if (this.explicitReloadDepth === 0 && this.pendingFileReconcile) {
        await this.reconcileWatchedFile?.();
      }
    }
  }

  /**
   * @category Display Layers
   */

  addDisplayLayer(params) {
    const id = this.nextDisplayLayerId++;
    const displayLayer = new DisplayLayer(id, this, params);
    this.displayLayers[id] = displayLayer;
    return displayLayer;
  }

  getDisplayLayer(id) {
    return this.displayLayers[id];
  }

  setDisplayLayers(displayLayers) {
    this.displayLayers = displayLayers;
    // Used for deserialization
  }

  /**
   * @category Language Modes
   */

  /**
   * @public
   * @status experimental
   *
   * Get the language mode associated with this buffer.
   *
   * @returns {Object} language mode `Object` (See {@link TextBuffer#setLanguageMode} for its interface).
   */
  getLanguageMode() {
    return this.languageMode;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the language mode for this buffer.
   *
   * @param {Object} languageMode - an `Object` with the following methods:
   * @param {Function} languageMode.getLanguageId - A `Function` that returns a `String` identifying the language.
   * @param {Function} languageMode.bufferDidChange - A `Function` that is called whenever the buffer changes.
   * @param {Object} languageMode.bufferDidChange.change - An `Object` with the following fields:
   * @param {String} languageMode.bufferDidChange.change.oldText - The deleted text
   * @param {Range} languageMode.bufferDidChange.change.oldRange - The {@link Range} of the deleted text before the change took place.
   * @param {String} languageMode.bufferDidChange.change.newText - The inserted text
   * @param {Range} languageMode.bufferDidChange.change.newRange - The {@link Range} of the inserted text after the change took place.
   * @param {Function} languageMode.onDidChangeHighlighting - A `Function` that takes a callback `Function` and calls it with a {@link Range} argument whenever the syntax of a given part of the buffer is updated.
   * @param {Function} languageMode.buildHighlightIterator - A function that returns an iterator object with the following methods:
   * @param {Function} languageMode.buildHighlightIterator.seek - A `Function` that takes a {@link Point} and resets the iterator to that position.
   * @param {Function} languageMode.buildHighlightIterator.moveToSuccessor - A `Function` that advances the iterator to the next token
   * @param {Function} languageMode.buildHighlightIterator.getPosition - A `Function` that returns a {@link Point} representing the iterator's current position in the buffer.
   * @param {Function} languageMode.buildHighlightIterator.getCloseScopeIds - A `Function` that returns an `Array` of `Numbers` representing scopes that end at the current position.
   * @param {Function} languageMode.buildHighlightIterator.getOpenScopeIds - A `Function` that returns an `Array` of `Numbers` representing scopes that begin at the current position.
   * @param {Function} languageMode.bufferDidFinishTransaction - Called after the text changes in a transaction have been aggregated.
   */
  setLanguageMode(languageMode) {
    if (languageMode !== this.languageMode) {
      const oldLanguageMode = this.languageMode;
      if (typeof this.languageMode.destroy === "function") {
        this.languageMode.destroy();
      }
      this.languageMode = languageMode || new NullLanguageMode({ buffer: this });
      for (const id in this.displayLayers) {
        const displayLayer = this.displayLayers[id];
        displayLayer.bufferDidChangeLanguageMode(languageMode);
      }
      this.emitter.emit("did-change-language-mode", {
        newMode: this.languageMode,
        oldMode: oldLanguageMode,
      });
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Call the given callback whenever the buffer's language mode changes.
   *
   * @param {Function} callback - A `Function` to call when the language mode changes.
   * @param {Object} callback.languageMode - The buffer's new language mode `Object`. See {@link TextBuffer#setLanguageMode} for its interface.
   * @param {Object} callback.oldLanguageMode - The buffer's old language mode `Object`. See {@link TextBuffer#setLanguageMode} for its interface.
   * @returns {Disposable} that can be used to stop the callback from being called.
   * @category Event Subscription
   */
  onDidChangeLanguageMode(callback) {
    return this.emitter.on("did-change-language-mode", ({ newMode, oldMode }) =>
      callback(newMode, oldMode),
    );
  }

  /**
   * @category Private Utility Methods
   */
  setFileState(fileState) {
    if (this.fileState === fileState) return false;
    this.fileState = fileState;
    this.emitter.emit("did-change-file-state", fileState);
    return true;
  }

  deriveFileStateFromBuffer() {
    if (this.file) {
      return this.buffer.isModified() ? "modified" : "unmodified";
    }
    return this.buffer.getLength() > 0 ? "modified" : "unmodified";
  }

  updateFileStateFromBuffer({ resolveStickyState = false } = {}) {
    if (!resolveStickyState && (this.fileState === "conflicted" || this.fileState === "removed")) {
      return false;
    }
    return this.setFileState(this.deriveFileStateFromBuffer());
  }

  updateDidHaveFileOnDisk() {
    if (this.didHaveFileOnDisk || !this.file) return;
    this.didHaveFileOnDisk = this.file.existsSync();
  }

  registerSelectionsMarkerLayer(markerLayer) {
    return this.selectionsMarkerLayerIds.add(markerLayer.id);
  }

  loadSync(options) {
    this.fileOperationGeneration++;
    this.updateDidHaveFileOnDisk();
    let patch;
    let checkpoint = null;
    let changesText = false;
    try {
      try {
        patch = this.buffer.loadSync(this.getPath(), this.getEncoding(), (percentDone, patch) => {
          if (textChangesOnlyPatch(patch)?.getChangeCount() > 0) {
            changesText = true;
            checkpoint = this.historyProvider.createCheckpoint({
              markers: this.createMarkerSnapshot(),
              isBarrier: true,
            });
            this.emitter.emit("will-reload");
            this.emitWillChangeEvent();
          }
        });
      } finally {
        // Native loading can commit text even when a reload observer throws.
        // Invalidate before either finishLoading or the outer error handler.
        if (changesText) this._textRevision++;
        this.cachedText = null;
      }
      patch = textChangesOnlyPatch(patch);
      this.finishLoading(checkpoint, patch, options);
    } catch (error) {
      if ((!options || !options.mustExist) && error.code === "ENOENT") {
        this.loaded = true;
        this.emitter.emit("will-reload");
        if (options && options.discardChanges) this.clearTextForReload();
        if (this.didHaveFileOnDisk) this.setFileState("removed");
        this.emitter.emit("did-reload");
      } else {
        throw error;
      }
    }

    return this;
  }

  async load(options) {
    this.pendingFileLoads++;
    this.updateDidHaveFileOnDisk();

    const file = this.file;
    const loadCount = ++this.loadCount;
    const operationGeneration = ++this.fileOperationGeneration;

    let checkpoint = null;
    let patch;
    let guardedPatch;
    try {
      const source = file instanceof File ? file.getPath() : file.createReadStream();
      patch = await this.buffer.load(
        source,
        {
          encoding: this.getEncoding(),
          force: options && options.discardChanges,
          patch: this.loaded,
        },
        // The text loader calls this once more before applying its patch.
        // Ignoring an obsolete result only after it resolves is too late: it
        // would already have changed the base text and invalidated undo and
        // the diff returned by the next load.
        (_percentDone, patch) => {
          const current =
            this.loadCount === loadCount &&
            this.fileOperationGeneration === operationGeneration &&
            this.file === file &&
            !this.isDestroyed();
          // The final guard receives the patch and returns straight into the
          // text reset; progress-only callbacks do not change the text.
          if (current && patch !== undefined) {
            guardedPatch = textChangesOnlyPatch(patch);
            if (patch === null || guardedPatch.getChangeCount() > 0) this._textRevision++;
          }
          return current;
        },
      );

      // If this is not the most recent load of this file, then we should bow
      // out and let the newer call to `load` handle the tasks below.
      if (
        this.loadCount !== loadCount ||
        this.fileOperationGeneration !== operationGeneration ||
        this.file !== file
      ) {
        return;
      }

      patch = guardedPatch ?? textChangesOnlyPatch(patch);

      // A non-forced reload can begin while the buffer is clean, then finish
      // after the user has edited it. The text store returns `null` in that
      // case so it does not overwrite the edit. Every caller, including an
      // encoding change, must compare the unchanged base text with the file
      // instead of treating the cancelled load as a successful reload.
      if (patch == null && this.loaded && !options?.discardChanges) {
        await this.reconcileFileChangeAfterCancelledLoad(loadCount, operationGeneration, file);
        return this;
      }

      if (patch) {
        if (patch.getChangeCount() > 0) {
          checkpoint = this.historyProvider.createCheckpoint({
            markers: this.createMarkerSnapshot(),
            isBarrier: true,
          });
          this.emitter.emit("will-reload");
          this.emitWillChangeEvent();
        } else if (options && options.discardChanges) {
          this.emitter.emit("will-reload");
        }
      }
      this.finishLoading(checkpoint, patch, options);
    } catch (error) {
      if ((!options || !options.mustExist) && error.code === "ENOENT") {
        if (
          this.loadCount !== loadCount ||
          this.fileOperationGeneration !== operationGeneration ||
          this.file !== file
        ) {
          return this;
        }
        // An automatic read can race with deletion. It leaves the text intact,
        // so only initial loads and explicit reloads publish reload events.
        const notifyReload = !this.loaded || Boolean(options?.discardChanges);
        this.loaded = true;
        if (notifyReload) this.emitter.emit("will-reload");
        if (options && options.discardChanges) this.clearTextForReload();
        if (this.didHaveFileOnDisk) this.setFileState("removed");
        if (notifyReload) this.emitter.emit("did-reload");
      } else {
        throw error;
      }
    } finally {
      this.pendingFileLoads--;
      if (this.pendingFileLoads === 0) {
        for (const resolve of this.fileLoadWaiters.splice(0)) resolve();
      }
      if (this.pendingFileReconcile) queueMicrotask(() => void this.reconcileWatchedFile?.());
    }

    return this;
  }

  clearTextForReload() {
    if (this.isEmpty()) return;
    this.transact(() => {
      this.emitWillChangeEvent();
      this.applyChange(this.buffer.prepareEdit(this.getRange(), ""), {
        recordHistory: true,
        origin: "reload",
      });
    });
  }

  finishLoading(checkpoint, patch, options) {
    if (this.isDestroyed()) {
      if (options && options.discardChanges) {
        this.emitter.emit("did-reload");
      }
      return;
    }

    if (this.loaded && checkpoint == null && patch != null) {
      // The file was read successfully, but its contents were already equal
      // to the buffer's base text, so there is no patch or reload event.
      this.digestWhenLastPersisted = this.buffer.baseTextDigest();
      this.updateFileStateFromBuffer({ resolveStickyState: true });
      if (options && options.discardChanges) {
        this.emitter.emit("did-reload");
      }
      return;
    }

    this.digestWhenLastPersisted = this.buffer.baseTextDigest();
    this.cachedText = null;

    if (this.loaded && patch && patch.getChangeCount() > 0) {
      const changes = patch.getChanges();

      if (options && options.clearHistory) {
        this.historyProvider.clearUndoStack();
      } else {
        this.historyProvider.pushPatch(patch);
      }

      if (changes) {
        this.changesSinceLastDidChangeTextEvent.push(...changes);
        this.changesSinceLastStoppedChangingEvent.push(...changes);
        this.changeOriginsSinceLastDidChangeTextEvent.add("reload");
      }

      for (const change of changes) {
        if (this.markerLayers != null) {
          for (const id in this.markerLayers) {
            const markerLayer = this.markerLayers[id];
            markerLayer.splice(
              change.newStart,
              traversal(change.oldEnd, change.oldStart),
              traversal(change.newEnd, change.newStart),
              change.newText,
            );
          }
        }
        const start = Point.fromObject(change.newStart);
        const startIndex = indexForPatchPoint(this, start);
        this.recordAppliedChange({
          startIndex,
          oldEndIndex: startIndex + change.oldText.length,
          newEndIndex: startIndex + change.newText.length,
          oldRange: Range(
            start,
            traverse(start, traversal(change.oldEnd, change.oldStart)),
          ).freeze(),
          newRange: Range(start, change.newEnd).freeze(),
          oldText: change.oldText,
          newText: change.newText,
          origin: "reload",
        });
      }

      const markersSnapshot = this.createMarkerSnapshot();
      this.historyProvider.groupChangesSinceCheckpoint(checkpoint, {
        markers: markersSnapshot,
        deleteCheckpoint: true,
        returnChanges: false,
      });

      this.emitDidChangeEvent(new ChangeEvent(this, changes, "reload"));
      this.updateFileStateFromBuffer({ resolveStickyState: true });
      const origin = this.emitDidChangeTextEvent();
      this.emitMarkerChangeEvents(markersSnapshot, origin);
    }

    this.loaded = true;
    this.updateFileStateFromBuffer({ resolveStickyState: true });
    this.emitter.emit("did-reload");
    return this;
  }

  async reconcileFileChangeAfterCancelledLoad(loadCount, operationGeneration, file) {
    const source = file instanceof File ? file.getPath() : file.createReadStream();
    let baseTextMatchesFile;
    try {
      baseTextMatchesFile = await this.buffer.baseTextMatchesFile(source, this.getEncoding());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (
        this.loadCount === loadCount &&
        this.fileOperationGeneration === operationGeneration &&
        this.file === file &&
        !this.isDestroyed()
      ) {
        this.pendingConfirmedSave?.cancel();
        this.setFileState("removed");
      }
      return;
    }

    // A newer load or a new backing file owns the state now. Do not let this
    // older comparison clear or reintroduce its conflict.
    if (
      this.loadCount !== loadCount ||
      this.fileOperationGeneration !== operationGeneration ||
      this.file !== file ||
      this.isDestroyed()
    ) {
      return;
    }

    if (baseTextMatchesFile) {
      this.updateFileStateFromBuffer({ resolveStickyState: true });
    } else {
      // A save prompt can open after this load starts but before its backing
      // file comparison finishes, sharing the same operation generation.
      this.pendingConfirmedSave?.cancel();
      this.setFileState("conflicted");
    }
  }

  /**
   * @public
   * @status essential
   *
   * Destroy this buffer, dispose its file watcher and marker layers, and notify destruction observers.
   *
   * @category Lifecycle
   */

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingConfirmedSave?.cancel();
    this.emitter.emit("did-destroy");
    this.emitter.clear();

    this.fileSubscriptions?.dispose();

    for (const id in this.markerLayers) {
      const markerLayer = this.markerLayers[id];
      markerLayer.destroy();
    }
    if (this.outstandingSaveCount === 0) {
      this.buffer.reset("");
      this._textRevision++;
    } else {
      var subscription = this.onDidSave(() => {
        if (this.outstandingSaveCount === 0) {
          this.buffer.reset("");
          this._textRevision++;
          subscription.dispose();
        }
      });
    }

    this.cachedText = null;
    if (typeof this.historyProvider.clear === "function") this.historyProvider.clear();
    if (typeof this.languageMode.destroy === "function") this.languageMode.destroy();
  }

  isAlive() {
    return !this.destroyed;
  }

  /**
   * @public
   * @status essential
   *
   * Determine whether this buffer has been destroyed.
   *
   * @returns {Boolean} Whether the buffer has been destroyed.
   * @category Lifecycle
   */

  isDestroyed() {
    return this.destroyed;
  }

  isRetained() {
    return this.refcount > 0;
  }

  retain() {
    this.refcount++;
    return this;
  }

  release() {
    this.refcount--;
    if (this.refcount <= 0) this.destroy();
    return this;
  }

  // Integrate an editor-owned disk write without searching unsaved text again.
  // The caller suspends file observation until this synchronous merge finishes.
  applyFileChanges({ oldText, newText, changes }) {
    if (this.isDestroyed() || oldText === newText) return;
    const previous = new TextStore(oldText);
    const baseDigest = this.buffer.baseTextDigest();
    if (baseDigest !== previous.baseTextDigest()) {
      // A reload may already have consumed the write. Any other baseline is an
      // unrelated external change and cannot safely be merged with these edits.
      if (baseDigest !== new TextStore(newText).baseTextDigest()) {
        this.setFileState("conflicted");
      }
      return;
    }

    const file = this.file;
    const filePath = this.getPath();
    this.emitter.emit("will-reload");
    // Reload observers may edit, retarget or destroy the buffer. Derive the
    // mappings only after their edits, and keep this write on its original file.
    if (
      this.isDestroyed() ||
      this.file !== file ||
      this.getPath() !== filePath ||
      this.buffer.baseTextDigest() !== baseDigest
    ) {
      return;
    }
    const currentText = this.getText();
    if (currentText === newText) {
      this.buffer.reset(newText);
      this.baseTextDigestCache = null;
      this.digestWhenLastPersisted = this.buffer.baseTextDigest();
      this.updateFileStateFromBuffer({ resolveStickyState: true });
      this.emitter.emit("did-reload");
      return;
    }

    const localChanges = previous
      .diff(currentText)
      .getChanges()
      .map((change) => ({
        start: previous.characterIndexForPosition(change.oldStart),
        end: previous.characterIndexForPosition(change.oldEnd),
        newEnd: this.buffer.characterIndexForPosition(change.newEnd),
        newText: change.newText,
      }));
    const mapOffset = (offset, end) => {
      let low = 0;
      let high = localChanges.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const local = localChanges[middle];
        if (local.end < offset || (local.end === offset && (!end || local.start !== local.end))) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      const local = localChanges[low - 1];
      return local ? offset + local.newEnd - local.end : offset;
    };

    let conflicted = false;
    let localIndex = 0;
    const adoptedInsertions = new Set();
    const mappedChanges = [];
    const fileChanges = fileChangesWithWholeLineEndings(oldText, changes);
    for (let fileIndex = 0; fileIndex < fileChanges.length; fileIndex++) {
      const fileChange = fileChanges[fileIndex];
      const { start, end, newText: replacement } = fileChange;
      while (
        localIndex < localChanges.length &&
        (localChanges[localIndex].end < start ||
          (localChanges[localIndex].end === start &&
            localChanges[localIndex].start !== localChanges[localIndex].end))
      ) {
        localIndex++;
      }
      if (start === end) {
        // Native diff can shift an insertion across identical adjacent text.
        // Recognize an equivalent local insertion once, even after that shift.
        const alreadyApplied = [localChanges[localIndex - 1], localChanges[localIndex]].find(
          (local) => {
            if (
              !local ||
              local.start !== local.end ||
              local.newText.length !== replacement.length ||
              adoptedInsertions.has(local)
            ) {
              return false;
            }
            const gapStart = Math.min(start, local.start);
            const gapEnd = Math.max(start, local.start);
            if (
              local.start !== start &&
              [fileChanges[fileIndex - 1], fileChanges[fileIndex + 1]].some(
                (other) => other && other.start <= gapEnd && other.end >= gapStart,
              )
            ) {
              return false;
            }
            const gap = oldText.slice(gapStart, gapEnd);
            return local.start >= start
              ? gap + local.newText === replacement + gap
              : local.newText + gap === gap + replacement;
          },
        );
        if (alreadyApplied) {
          adoptedInsertions.add(alreadyApplied);
          continue;
        }
      }
      let overlaps = false;
      let contained = true;
      for (let i = localIndex; i < localChanges.length && localChanges[i].start <= end; i++) {
        const local = localChanges[i];
        const intersects =
          start === end
            ? (local.start < start && start < local.end) ||
              (local.start === start && local.end === end)
            : local.start === local.end
              ? start < local.start && local.start < end
              : start < local.end && local.start < end;
        if (intersects) {
          overlaps = true;
          if (local.start < start || local.end > end) contained = false;
        }
      }
      const mappedStart = this.positionForCharacterIndex(mapOffset(start, false));
      const mappedEnd = this.positionForCharacterIndex(mapOffset(end, start !== end));
      const mappedRange = new Range(mappedStart, mappedEnd);
      if (overlaps) {
        // A user may already have made this exact replacement. Adopt the new
        // disk baseline without repeating the edit or adding an undo entry.
        if (start !== end && contained && this.getTextInRange(mappedRange) === replacement) {
          continue;
        }
        conflicted = true;
        continue;
      }
      mappedChanges.push({ range: mappedRange, text: replacement });
    }

    this.transact(() => {
      for (let i = mappedChanges.length - 1; i >= 0; i--) {
        this.emitWillChangeEvent();
        const { range, text } = mappedChanges[i];
        this.applyChange(this.buffer.prepareEdit(range, text), {
          recordHistory: true,
          origin: "reload",
        });
      }
      if (conflicted) {
        // Keep the old baseline so file observation continues to report the
        // unresolved overlap, including after undoing the propagated edits.
        this.setFileState("conflicted");
      } else {
        const mergedText = this.getText();
        this.buffer.reset(newText);
        this.buffer.setText(mergedText);
        this.baseTextDigestCache = null;
        this.digestWhenLastPersisted = this.buffer.baseTextDigest();
        this.updateFileStateFromBuffer({ resolveStickyState: true });
      }
    });
    this.emitter.emit("did-reload");
  }

  async beginFileOperation() {
    this.fileWatchOperationDepth++;
    this.fileOperationGeneration++;
    while (this.pendingFileLoads > 0) {
      await new Promise((resolve) => this.fileLoadWaiters.push(resolve));
    }
  }

  async endFileOperation() {
    this.fileWatchOperationDepth = Math.max(0, this.fileWatchOperationDepth - 1);
    if (this.fileWatchOperationDepth === 0) {
      await this.fileWatchStartPromise;
      await this.reconcileWatchedFile?.();
    }
  }

  subscribeToFile() {
    const file = this.file;
    let disposed = false;
    this.reconcileWatchedFile = null;
    if (this.fileSubscriptions) {
      // If we were to unsubscribe and immediately resubscribe, we might
      // trigger destruction and recreation of a native file watcher — which is
      // costly and unnecessary. We can avoid that cost by overlapping the
      // switch and only disposing of the old `CompositeDisposable` after the
      // new one has attached its subscriptions.
      this.oldFileSubscriptions = this.fileSubscriptions;
    }
    this.fileSubscriptions = new CompositeDisposable();
    this.fileSubscriptions.add(
      new Disposable(() => {
        disposed = true;
      }),
    );

    // Reset each time we resubscribe; the default-data-source branch below
    // replaces this with the new watcher's arm promise.
    this.fileWatchStartPromise = Promise.resolve();

    const reconcileChange = async () => {
      if (disposed || this.destroyed || this.file !== file) return;
      if (
        this.fileWatchOperationDepth ||
        this.explicitReloadDepth > 0 ||
        this.outstandingSaveCount > 0 ||
        !this.loaded
      ) {
        this.pendingFileReconcile = true;
        return;
      }
      this.pendingFileReconcile = false;
      // On Linux we get change events when the file is deleted. This yields
      // consistent behavior with Mac/Windows.
      if (!this.file || !this.file.existsSync()) return;
      if (this.outstandingSaveCount > 0) return;
      const operationGeneration = ++this.fileOperationGeneration;

      if (this.fileState !== "unmodified") {
        // Read the file the same way `load` does. A custom data source (see
        // `setFile`) may transform its contents on the way in and out, so its
        // raw bytes on disk are not what the base text was loaded from —
        // comparing against the path would report a conflict for every save.
        const source = file instanceof File ? file.getPath() : file.createReadStream();
        let baseTextMatchesFile;
        try {
          baseTextMatchesFile = await this.buffer.baseTextMatchesFile(source, this.getEncoding());
        } catch (error) {
          if (error.code === "ENOENT") return onDidDelete();
          throw error;
        }
        if (
          this.fileOperationGeneration !== operationGeneration ||
          this.file !== file ||
          this.isDestroyed()
        ) {
          return;
        }

        if (!baseTextMatchesFile) {
          // A confirmation can open while this read is pending and capture the
          // generation above. Invalidate it when the changed backing contents
          // are observed, before publishing conflict to save-capable observers.
          this.pendingConfirmedSave?.cancel();
          if (this.buffer.isModified() || this.fileState === "conflicted") {
            // Keep the current buffer contents so the user's changes are not
            // lost. Conflict remains sticky across undo until disk and base
            // are explicitly reconciled.
            this.setFileState("conflicted");
          } else {
            // A clean buffer whose removed file reappeared with different
            // contents can safely follow the disk again.
            return this.load({ internal: true });
          }
        } else {
          this.updateFileStateFromBuffer({ resolveStickyState: true });
        }
      } else {
        // This buffer was previously in sync with what was on disk, so we
        // can update its contents to match the new contents on disk. By
        // definition, this means there is no conflict if the load succeeds.
        return this.load({ internal: true });
      }
    };
    const reportWatchError = (error) => {
      if (error.code === "ABORT_ERR" || this.destroyed) return;
      let handled = false;
      this.emitter.emit("will-throw-watch-error", {
        error,
        handle: () => {
          handled = true;
        },
      });
      if (!handled) console.error(error);
    };
    const onDidChange = debounce(() => {
      void reconcileChange().catch(reportWatchError);
    }, this.fileChangeDelay);

    const onDidDelete = () => {
      if (disposed || this.destroyed || this.file !== file) return;
      this.didHaveFileOnDisk = true;
      if (
        this.fileWatchOperationDepth ||
        this.explicitReloadDepth > 0 ||
        (this.pendingFileLoads > 0 && !this.loaded) ||
        this.outstandingSaveCount > 0
      ) {
        this.pendingFileReconcile = true;
        return;
      }
      this.fileOperationGeneration++;
      // Keep `this.file` so a regular Save recreates the same path. The
      // workspace owns the optional clean-tab auto-close policy.
      return this.setFileState("removed");
    };

    const onDidRename = () => {
      if (disposed || this.destroyed || this.file !== file) return;
      if (this.relocatingFile === file) return;
      if (
        this.fileRelocationNotice?.file === file &&
        this.fileRelocationNotice.path === file.getPath()
      )
        return;
      this.fileRelocationNotice = null;
      this.emitter.emit("did-change-path", this.getPath());
    };

    // Both filesystem and custom sources can defer notifications during load,
    // save or an explicit move. A single reconciliation path drains those
    // notifications when the operation finishes, including a deferred delete.
    const reconcile = async () => {
      if (disposed || this.destroyed || this.file !== file) return;
      if (
        this.fileWatchOperationDepth ||
        this.explicitReloadDepth > 0 ||
        this.outstandingSaveCount > 0 ||
        !this.loaded
      ) {
        this.pendingFileReconcile = true;
        return;
      }
      this.pendingFileReconcile = false;
      if (!file.existsSync()) {
        if (this.didHaveFileOnDisk) onDidDelete();
      } else {
        await reconcileChange();
      }
    };
    const reconcileWatchedFile = () => reconcile().catch(reportWatchError);
    this.reconcileWatchedFile = reconcileWatchedFile;

    if (this.file.onDidChange || this.file.onDidDelete || this.file.onDidRename) {
      // A custom data source (see `setFile`) supplies its own change
      // notifications; wire them straight through to the on-disk handlers.
      if (this.file.onDidChange) this.fileSubscriptions.add(this.file.onDidChange(onDidChange));
      if (this.file.onDidDelete) this.fileSubscriptions.add(this.file.onDidDelete(onDidDelete));
      if (this.file.onDidRename) this.fileSubscriptions.add(this.file.onDidRename(onDidRename));
      if (this.file.onWillThrowWatchError) {
        this.fileSubscriptions.add(
          this.file.onWillThrowWatchError((error) => {
            this.emitter.emit("will-throw-watch-error", error);
          }),
        );
      }
      this.watchedFilePath = null;
    } else if (typeof this.file.getPath === "function") {
      const watcher = this.fileWatchClient
        ? this.fileWatchClient.watchFile(file.getPath())
        : watchFile(file.getPath());
      // Catch up changes that raced with watcher startup before exposing the
      // watcher as ready. Otherwise callers can write immediately after
      // awaiting this promise while the startup reload still owns an older
      // snapshot of the file.
      this.fileWatchStartPromise = watcher.ready.then(() => reconcileWatchedFile());
      this.fileWatchStartPromise.catch(() => {});
      this.fileSubscriptions.add(
        new Disposable(() => {
          disposed = true;
          watcher.dispose();
        }),
        watcher.onDidChange((events) => {
          if (events.some((event) => event.action === "deleted")) void reconcileWatchedFile();
          else onDidChange();
        }),
        watcher.onDidInvalidate(() => void reconcileWatchedFile()),
        watcher.onDidError(reportWatchError),
      );
    }

    if (this.oldFileSubscriptions) {
      this.oldFileSubscriptions.dispose();
      this.oldFileSubscriptions = null;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Wait until this buffer's file watcher is ready to report external changes.
   *
   * @returns {Promise} that resolves once this buffer's file watcher has been armed and is delivering external-change events. Watching is served asynchronously by the file-watcher worker; this lets callers wait for it before relying on external-change detection. Resolves immediately when the buffer has no path or a custom data source that watches synchronously.
   * @category Buffer Operations
   */
  getFileWatchStartPromise() {
    return this.fileWatchStartPromise || Promise.resolve();
  }

  createMarkerSnapshot(selectionsMarkerLayer) {
    const snapshot = {};
    for (const markerLayerId in this.markerLayers) {
      const markerLayer = this.markerLayers[markerLayerId];
      if (!markerLayer.maintainHistory) continue;
      if (
        selectionsMarkerLayer &&
        markerLayer.getRole() === "selections" &&
        markerLayerId !== selectionsMarkerLayer.id
      )
        continue;
      snapshot[markerLayerId] = markerLayer.createSnapshot();
    }
    return snapshot;
  }

  restoreFromMarkerSnapshot(snapshot, selectionsMarkerLayer, origin = "edit") {
    if (snapshot == null) return;
    // Fold markers are restored straight onto their layer below, so each
    // display layer has to be told afterwards which rows moved — see
    // `DisplayLayer::foldsDidRestore`.
    const foldRangesByDisplayLayerId = new Map();
    for (const id in this.displayLayers) {
      const displayLayer = this.displayLayers[id];
      if (snapshot[displayLayer.foldsMarkerLayer.id]) {
        foldRangesByDisplayLayerId.set(id, displayLayer.foldRangesSnapshot());
      }
    }

    let selectionsSnapshotId;
    if (selectionsMarkerLayer != null) {
      // Do selective selections marker restoration only when snapshot includes single selections snapshot.
      const selectionsSnapshotIds = Object.keys(snapshot).filter((id) =>
        this.selectionsMarkerLayerIds.has(id),
      );
      if (selectionsSnapshotIds.length === 1) {
        selectionsSnapshotId = selectionsSnapshotIds[0];
      }
    }

    for (const markerLayerId in snapshot) {
      const layerSnapshot = snapshot[markerLayerId];
      if (markerLayerId === selectionsSnapshotId) {
        this.markerLayers[selectionsMarkerLayer.id].restoreFromSnapshot(
          layerSnapshot,
          markerLayerId !== selectionsMarkerLayer.id,
          origin,
        );
      } else if (this.markerLayers[markerLayerId]) {
        this.markerLayers[markerLayerId].restoreFromSnapshot(layerSnapshot, false, origin);
      }
    }

    for (const [id, previousRanges] of foldRangesByDisplayLayerId) {
      const displayLayer = this.displayLayers[id];
      if (displayLayer) displayLayer.foldsDidRestore(previousRanges, origin);
    }
  }

  emitMarkerChangeEvents(snapshot, origin = "edit") {
    this.emitPendingMarkerLayerUpdateEvents();

    for (const markerLayerId in this.markerLayers) {
      const markerLayer = this.markerLayers[markerLayerId];
      markerLayer.emitChangeEvents(snapshot && snapshot[markerLayerId], origin);
    }
  }

  emitPendingMarkerLayerUpdateEvents() {
    if (this.transactCallDepth !== 0 || this.markerUpdateBatchDepth !== 0) return;

    while (this.markerLayersWithPendingUpdateEvents.size > 0) {
      const updatedMarkerLayers = Array.from(this.markerLayersWithPendingUpdateEvents);
      this.markerLayersWithPendingUpdateEvents.clear();
      for (const markerLayer of updatedMarkerLayers) {
        markerLayer.emitUpdateEvent();
        if (markerLayer === this.defaultMarkerLayer) {
          this.emitter.emit("did-update-markers");
        }
      }
    }
  }

  emitWillChangeEvent() {
    if (!this._emittedWillChangeEvent) {
      this._emittedWillChangeEvent = true;
      this.emittingWillChange = true;
      try {
        this.emitter.emit("will-change");
      } catch (error) {
        this._emittedWillChangeEvent = false;
        throw error;
      } finally {
        this.emittingWillChange = false;
      }
    }
  }

  assertCanEdit() {
    if (this.emittingWillChange) {
      throw new Error("Document edits are not allowed from onWillChange observers");
    }
    if (this.applyingEdit) {
      throw new Error("Document edits are not allowed during synchronous edit notifications");
    }
  }

  emitDidChangeTextEvent() {
    this.cachedHasAstral = null;
    const origin = changeOrigin(this.changeOriginsSinceLastDidChangeTextEvent);
    if (this.transactCallDepth === 0) {
      this._emittedWillChangeEvent = false;
      if (this.changesSinceLastDidChangeTextEvent.length > 0) {
        this.changeOriginsSinceLastDidChangeTextEvent.clear();
        const appliedChanges = this.appliedChanges;
        const beforeRevision = this.appliedChangesBeforeRevision;
        this.appliedChanges = null;
        this.appliedChangesBeforeRevision = null;
        const compactedChanges = compactPatchChanges(this.changesSinceLastDidChangeTextEvent);
        this.changesSinceLastDidChangeTextEvent.length = 0;
        this.transactionsSinceLastStoppedChangingEvent.push(
          Object.freeze({
            origin,
            changes: Object.freeze(
              normalizePatchChanges(compactedChanges).map((change) => {
                change.oldRange.freeze();
                change.newRange.freeze();
                return Object.freeze(change);
              }),
            ),
          }),
        );
        if (appliedChanges?.length) this.emitAppliedChanges(appliedChanges, origin, beforeRevision);
        if (compactedChanges.length > 0) {
          idleDisposals.didEdit();
          const changeEvent = new ChangeEvent(this, compactedChanges, origin);
          this.languageMode.bufferDidFinishTransaction(changeEvent);
          this.emitter.emit("did-change-text", changeEvent);
        }
        this.debouncedEmitDidStopChangingEvent();
      }
      for (const id in this.displayLayers) {
        const displayLayer = this.displayLayers[id];
        displayLayer.emitDeferredChangeEvents();
      }
      this.updateFileStateFromBuffer();
    }
    return origin;
  }

  // Identifies if the buffer belongs to multiple editors.
  //
  // For example, if the `EditorView` was split.
  //
  // Returns a `Boolean`.
  hasMultipleEditors() {
    return this.refcount > 1;
  }

  emitDidStopChangingEvent() {
    if (this.destroyed) return;
    const compactedChanges = Object.freeze(
      normalizePatchChanges(compactPatchChanges(this.changesSinceLastStoppedChangingEvent)),
    );
    this.changesSinceLastStoppedChangingEvent.length = 0;
    const transactions = Object.freeze(this.transactionsSinceLastStoppedChangingEvent.splice(0));
    const origin = changeOrigin(new Set(transactions.map((transaction) => transaction.origin)));
    this.emitter.emit("did-stop-changing", { changes: compactedChanges, origin, transactions });
  }

  logLines(start = 0, end = this.getLastRow()) {
    for (let row = start; row <= end; row++) {
      const line = this.lineForRow(row);
      console.log(row, line, line.length);
    }
  }

  /**
   * @category Private History Delegate Methods
   */

  invertChange(change) {
    return Object.freeze({
      oldRange: change.newRange,
      newRange: change.oldRange,
      oldText: change.newText,
      newText: change.oldText,
    });
  }

  serializeChange(change) {
    return {
      oldRange: change.oldRange.serialize(),
      newRange: change.newRange.serialize(),
      oldText: change.oldText,
      newText: change.newText,
    };
  }

  deserializeChange(change) {
    return {
      oldRange: Range.deserialize(change.oldRange),
      newRange: Range.deserialize(change.newRange),
      oldText: change.oldText,
      newText: change.newText,
    };
  }

  serializeSnapshot(snapshot, options) {
    if (!options.markerLayers) return;

    return MarkerLayer.serializeSnapshot(snapshot);
  }

  deserializeSnapshot(snapshot) {
    return MarkerLayer.deserializeSnapshot(snapshot);
  }

  /**
   * @category Private MarkerLayer Delegate Methods
   */

  markerLayerDestroyed(markerLayer) {
    return delete this.markerLayers[markerLayer.id];
  }

  markerCreated(layer, marker) {
    if (layer === this.defaultMarkerLayer) {
      return this.emitter.emit("did-create-marker", marker);
    }
  }

  markersUpdated(layer) {
    if (this.transactCallDepth === 0 && this.markerUpdateBatchDepth === 0) {
      layer.emitUpdateEvent();
      if (layer === this.defaultMarkerLayer) {
        return this.emitter.emit("did-update-markers");
      }
    } else {
      return this.markerLayersWithPendingUpdateEvents.add(layer);
    }
  }

  getNextMarkerId() {
    return this.nextMarkerId++;
  }
}

const defaultClipPosition = TextBuffer.prototype.clipPosition;

Object.assign(TextBuffer, {
  version: 6,
  Point: Point,
  Range: Range,
  newlineRegex: newlineRegex,
  spliceArray: spliceArray,
});

Object.assign(TextBuffer.prototype, {
  stoppedChangingDelay: 300,
  fileChangeDelay: 200,
  backwardsScanChunkSize: 8000,
  defaultMaxUndoEntries: 10000,
});

class TransactionAbortedError extends Error {}

class ChangeEvent {
  constructor(buffer, changes, origin = "edit") {
    this.origin = origin;
    this.changes = Object.freeze(normalizePatchChanges(changes));

    const start = changes[0].oldStart;
    const { oldEnd, newEnd } = changes[changes.length - 1];
    this.oldRange = new Range(start, oldEnd).freeze();
    this.newRange = new Range(start, newEnd).freeze();
    Object.defineProperty(this, "startIndex", {
      value: indexForPatchPoint(buffer, this.newRange.start),
    });

    let oldText = null;
    let newText = null;

    Object.defineProperty(this, "oldText", {
      enumerable: false,
      get() {
        if (oldText == null) {
          const currentText = this.newText || "";
          const parts = [];
          let end = 0;
          // Normalized patch changes are ordered and disjoint in the final
          // text. Reconstruct once instead of copying the whole span for each
          // splice when a package reads a bulk transaction's oldText.
          for (const change of changes) {
            const offset = indexForPatchPoint(buffer, change.newStart) - this.startIndex;
            parts.push(currentText.slice(end, offset), change.oldText);
            end = offset + change.newText.length;
          }
          parts.push(currentText.slice(end));
          oldText = parts.join("");
        }
        return oldText;
      },
    });

    Object.defineProperty(this, "newText", {
      enumerable: false,
      get() {
        if (newText == null) {
          newText = textForPatchRange(buffer, this.newRange);
        }
        return newText;
      },
    });
  }

  isEqual(other) {
    return (
      this.origin === other.origin &&
      this.changes.length === other.changes.length &&
      this.changes.every((change, i) => change.isEqual(other.changes[i])) &&
      this.oldRange.isEqual(other.oldRange) &&
      this.newRange.isEqual(other.newRange)
    );
  }
}

class SearchCallbackArgument {
  get row() {
    return this.range.start.row;
  }

  get lineText() {
    const lines = [];
    const lastOccupiedRow = lastOccupiedRowForRange(this.range);
    for (let row = this.range.start.row; row <= lastOccupiedRow; row++) {
      lines.push(this.buffer.lineForRow(row));
    }
    return lines.join("\n");
  }

  get lineTextOffset() {
    return 0;
  }

  get matchText() {
    return this.buffer.getTextInRange(this.range);
  }

  get match() {
    this.regex.lastIndex = 0;
    return this.regex.exec(this.matchText);
  }

  static addContextLines(argument, options) {
    argument.leadingContextLines = [];
    let row = Math.max(0, argument.range.start.row - (options.leadingContextLineCount || 0));
    while (row < argument.range.start.row) {
      argument.leadingContextLines.push(argument.buffer.lineForRow(row));
      row += 1;
    }

    argument.trailingContextLines = [];
    const lastOccupiedRow = lastOccupiedRowForRange(argument.range);
    for (let i = 0, end = options.trailingContextLineCount || 0; i < end; i++) {
      row = lastOccupiedRow + i + 1;
      if (row >= argument.buffer.getLineCount()) break;
      argument.trailingContextLines.push(argument.buffer.lineForRow(row));
    }
  }

  constructor(buffer, range, regex, options) {
    this.replace = this.replace.bind(this);
    this.stop = this.stop.bind(this);
    this.buffer = buffer;
    this.range = range;
    this.regex = regex;
    this.stopped = false;
    this.replacementText = null;
    SearchCallbackArgument.addContextLines(this, options);
  }

  replace(text) {
    this.replacementText = text;
    return this.buffer.setTextInRange(this.range, text);
  }

  stop() {
    this.stopped = true;
  }
}

let _winattrPromise = null;
const getWinattr = function () {
  if (_winattrPromise === null) _winattrPromise = import("winattr");
  return _winattrPromise;
};

module.exports = TextBuffer;
