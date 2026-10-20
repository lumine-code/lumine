const { Node } = require("web-tree-sitter");
const TreeSitterParser = require("./tree-sitter-parser");
const HighlightCache = require("./tree-sitter-highlight-cache");
const TreeSitterPresentation = require("./tree-sitter-presentation");
const captureQuery = require("./tree-sitter-query-cache");
const TreeSitterDocument = require("./tree-sitter-document");
const parserScheduler = require("./tree-sitter-scheduler");
const { Point, Range } = require("./text-buffer");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const ScopeDescriptor = require("./scope-descriptor");
const ScopeResolver = require("./scope-resolver");
const FoldResolver = require("./tree-sitter-fold-resolver");
const IndentResolver = require("./tree-sitter-indent-resolver");
const { comparePoints } = require("./tree-sitter-node-helpers");
const TreeSitterRangeList = require("./tree-sitter-range-list");
const TreeSitterInvalidationRanges = require("./tree-sitter-invalidation-ranges");
const { collectInjectionMatches } = require("./tree-sitter-injections");
const {
  MINIMUM_BOUNDARY_DISTANCE,
  smallFragmentRegions,
  splitIncludedRanges,
} = require("./tree-sitter-parse-ranges");
const Token = require("./token");
const { matcherForSelector } = require("./selectors");
const { commentStringsFromDelimiters, getDelimitersForScope } = require("./comment-utils.js");

const createTree = require("./rb-tree");
const {
  setTimeout: scheduleBackgroundTask,
  clearTimeout: cancelBackgroundTask,
} = require("node:timers");

const ONE_CHAR_FORWARD_TRAVERSAL = Object.freeze(Point(0, 1));

const FEATURE_ASYNC_INDENT = true;
const FEATURE_ASYNC_PARSE = true;

const LINE_LENGTH_LIMIT_FOR_HIGHLIGHTING = 10000;
// Initial loading shares a task budget and resumes in bounded WASM slices.
// Fast steady edits publish synchronously. Repeatedly slow large-buffer
// updates return to the same resumable path instead of blocking every key.
const PARSE_JOB_LIMIT_MICROS = 5000;
const LARGE_BUFFER_ASYNC_THRESHOLD = 512 * 1024;
const SLOW_SYNCHRONOUS_UPDATE_MS = 12;
const SLOW_PARSE_COALESCE_MS = 50;
// After a parse lands, fold data is prefilled eagerly so the gutter's
// chevrons don't each pay a query. Beyond this many rows the prefill would
// dwarf the parse itself — a whole-buffer prefill of a 15k-line file costs
// hundreds of milliseconds — so larger invalidations warm only this many rows
// and leave the rest to the on-demand path, which windows its own queries.
const FOLD_PREFILL_MAX_ROWS = 400;

// `Node#descendantsOfType` materializes its entire result synchronously.
// Injection points often target common leaf nodes — strings and comments — so
// one whole-file call can monopolize the renderer for hundreds of milliseconds.
// Row and code-unit windows keep each traversal bounded while preserving
// document order; nodes spanning a window boundary are deduplicated below.
const INJECTION_CANDIDATE_CHUNK_ROWS = 1000;
const INJECTION_CANDIDATE_CHUNK_CODE_UNITS = 8192;
const INJECTION_RECONCILE_CHUNK_SIZE = 1000;
// Full-buffer queries can return hundreds of thousands of captures. Keep both
// query execution and predicate resolution in small tasks so background symbol
// refreshes let typing and painting continue between batches.
const QUERY_CAPTURE_CHUNK_ROWS = 200;
const QUERY_CAPTURE_CHUNK_CODE_UNITS = 8192;
// Newly-created injection layers often become ready together because they
// share a grammar's cached language and queries. Without a shared budget,
// their first parses all begin in the same microtask checkpoint and each may
// consume its own synchronous parse allowance before yielding.
const INITIAL_INJECTION_UPDATE_BUDGET_MILLIS = 8;
const MAX_IDLE_PARSERS_PER_LANGUAGE = 2;
const OPTIONAL_QUERY_TYPES = new Set(["localsQuery", "tagsQuery", "parseBoundariesQuery"]);
const ANCILLARY_QUERY_TYPES = ["foldsQuery", "indentsQuery"];
const HIGHLIGHT_CONFIG_KEYS = new WeakMap();
const FUNCTION_TRUE = () => true;

function last(array) {
  return array[array.length - 1];
}

function configKeysForHighlightQuery(query) {
  let keys = HIGHLIGHT_CONFIG_KEYS.get(query);
  if (keys) return keys;
  keys = new Set();
  for (const properties of [
    query.setProperties,
    query.assertedProperties,
    query.refutedProperties,
  ]) {
    for (const pattern of properties ?? []) {
      const value = pattern?.["test.config"];
      if (typeof value !== "string") continue;
      const key = value.split(" ", 1)[0];
      if (key) keys.add(key);
    }
  }
  HIGHLIGHT_CONFIG_KEYS.set(query, keys);
  return keys;
}

function removeLastOccurrenceOf(array, item) {
  const index = array.lastIndexOf(item);
  if (index === -1) return [];
  return array.splice(index, 1);
}

function rangeForNode(node) {
  return new Range(node.startPosition, node.endPosition);
}

function nodeBreadth(node) {
  return node.endIndex - node.startIndex;
}

function rangeToTreeSitterRangeSpec(range, buffer) {
  // Tree-sitter positions can end between CR and LF. Buffer point clipping
  // would drop that CR, so preserve raw UTF-16 columns relative to row starts.
  let startIndex = buffer.characterIndexForPosition([range.start.row, 0]) + range.start.column;
  let endIndex = buffer.characterIndexForPosition([range.end.row, 0]) + range.end.column;
  let startPosition = { row: range.start.row, column: range.start.column };
  let endPosition = { row: range.end.row, column: range.end.column };

  return { startIndex, startPosition, endIndex, endPosition };
}

// The old `TreeSitterLanguageMode` added a `range` property to nodes that
// returns a `Range` instance. We do the same for reasons of backward
// compatibility — but it's also rather convenient.
Object.defineProperty(Node.prototype, "range", {
  get() {
    return rangeForNode(this);
  },
});

// A comparison function for a red-black tree that uses a point/range tuple as
// its key.
//
// We use this for folds. The primary indexing method of a fold is by point,
// but that point is one end of a range; and when two folds share a boundary,
// we need to be able to break the tie somehow.
function comparePointAndRangeBundles(bundleA, bundleB) {
  let [pointA, rangeA] = bundleA;
  let [pointB, rangeB] = bundleB;
  let pointComparison = comparePoints(pointA, pointB);
  if (pointComparison !== 0) {
    return pointComparison;
  }

  let aIsEnd = rangeA.end.isEqual(pointA);
  let bIsEnd = rangeB.end.isEqual(pointB);

  // If one range ends at the given point and the other starts at the given
  // point, then the one that ends should be handled earlier.
  if (aIsEnd !== bIsEnd) {
    return aIsEnd ? -1 : 1;
  }

  // Otherwise, the larger of the two ranges should be considered to begin
  // first and end last. (This comparison function does not envision ranges
  // that overlap but where one is not contained by the other; it's up to the
  // author of a `folds.scm` file to avoid those unusual scenarios, since they
  // break the mental model of how folds work.)
  if (rangeA.containsRange(rangeB)) {
    return aIsEnd ? 1 : -1;
  } else if (rangeB.containsRange(rangeA)) {
    return bIsEnd ? -1 : 1;
  }
  return 0;
}

function isBetweenPoints(point, a, b) {
  let comp = comparePoints(a, b);
  let lesser = comp > 0 ? b : a;
  let greater = comp > 0 ? a : b;
  return comparePoints(point, lesser) >= 0 && comparePoints(point, greater) <= 0;
}

const COMMENT_MATCHER = matcherForSelector("comment");
const MAX_RANGE = new Range(Point.ZERO, Point.INFINITY).freeze();

/**
 * The language mode a grammar with a tree-sitter parser installs on a
 * buffer. Packages reach what it computes through {@link TextEditor} rather than
 * holding one directly.
 *
 * @private
 */
class TreeSitterLanguageMode {
  constructor({
    buffer,
    grammar,
    config,
    grammars,
    syncTimeoutMicros,
    injectionCandidateChunkRows,
    injectionCandidateChunkCodeUnits,
    injectionReconcileChunkSize,
    queryCaptureChunkRows,
    queryCaptureChunkCodeUnits,
    initialInjectionUpdateBudgetMs,
    maxIdleParsersPerLanguage,
  }) {
    this.buffer = buffer;
    this.document = new TreeSitterDocument(buffer);
    this.highlightCache = new HighlightCache({ maxEvents: 128000 });
    this.backgroundSnapshots = new WeakSet();
    this.parseDetails = new WeakMap();
    this.synchronousUpdates = false;
    this.publicationPending = true;
    this.publicationRanges = new TreeSitterRangeList();
    this.grammar = grammar;
    this.config = config ?? lumine.config;
    this.grammarRegistry = grammars;

    this.syncTimeoutMicros = syncTimeoutMicros ?? PARSE_JOB_LIMIT_MICROS;
    this.useAsyncParsing = FEATURE_ASYNC_PARSE;
    this.useAsyncIndent = FEATURE_ASYNC_INDENT;
    this.injectionCandidateChunkRows =
      injectionCandidateChunkRows ?? INJECTION_CANDIDATE_CHUNK_ROWS;
    this.injectionCandidateChunkCodeUnits =
      injectionCandidateChunkCodeUnits ?? INJECTION_CANDIDATE_CHUNK_CODE_UNITS;
    this.injectionReconcileChunkSize =
      injectionReconcileChunkSize ?? INJECTION_RECONCILE_CHUNK_SIZE;
    this.queryCaptureChunkRows = queryCaptureChunkRows ?? QUERY_CAPTURE_CHUNK_ROWS;
    this.queryCaptureChunkCodeUnits = queryCaptureChunkCodeUnits ?? QUERY_CAPTURE_CHUNK_CODE_UNITS;
    this.initialInjectionUpdateBudgetMs =
      initialInjectionUpdateBudgetMs ?? INITIAL_INJECTION_UPDATE_BUDGET_MILLIS;
    this.maxIdleParsersPerLanguage = maxIdleParsersPerLanguage ?? MAX_IDLE_PARSERS_PER_LANGUAGE;

    this.injectionsMarkerLayer = buffer.addMarkerLayer();

    this.rootScopeDescriptor = new ScopeDescriptor({
      scopes: [grammar.scopeName],
    });
    this.rootScopeId = this.grammar.idForScope(this.grammar.scopeName);

    this.emitter = new Emitter();
    this.isFoldableCache = new Map();
    this.foldRangeIndex = null;
    this.scopeDescriptorCache = null;
    this.pendingDirtyHighlightRanges = new TreeSitterRangeList();
    this.dirtyHighlightPromise = null;

    this.tokenized = false;

    this.subscriptions = new CompositeDisposable();
    this.presentation = new TreeSitterPresentation({
      buffer,
      cache: this.highlightCache,
      capture: () => this.capturePresentationVersion(),
      isCurrent: (stamp) => this.presentationVersionIsCurrent(stamp),
      iterator: () => new HighlightIterator(this),
      hasBudget: () =>
        this.shouldParseSynchronously() || parserScheduler.hasBudget(this.syncTimeoutMicros),
      publish: (range) => this.emitter.emit("did-change-highlighting", range),
    });
    this.subscriptions.add(
      buffer.onDidApplyChanges(() => {
        if (this.destroyed) return;
        for (const layer of this.getAllLanguageLayers()) {
          layer?.parseAbort?.abort();
        }
        queueMicrotask(() => {
          if (
            !this.destroyed &&
            this.rootLanguageLayer &&
            !this.rootLanguageLayer.updating &&
            this.rootLanguageLayer.tree?.revision !== buffer.getTextRevision()
          )
            this.requestDocumentUpdate();
        });
      }),
    );
    this.subscriptions.add(this.onDidTokenize(() => (this.tokenized = true)));

    this.rootLanguage = null;
    this.rootLanguageLayer = null;

    this.grammarForLanguageString = this.grammarForLanguageString.bind(this);

    this.parsersByLanguage = new Map();
    this.grammarsByLanguage = new Map();
    this.pendingInitialInjectionUpdates = [];
    this.initialInjectionUpdateDrainPromise = null;
    this.pendingTransactionRanges = new TreeSitterRangeList();

    this.autoIndentRequests = 0;

    // For our purposes, the “transaction” life cycle exposed by this promise
    // is a lot like the buffer's own concept of transactions, with one
    // exception: if transaction 2 finishes before transaction 1 is done
    // parsing, then the transaction 1 life cycle “adopts” all the changes of
    // transaction 2. That means that the `atTransactionEnd` method won't
    // resolve until the tree is clean and all outstanding updates are
    // performed and injections are populated.
    this.resolveNextTransactionPromise();

    // In contrast to `FoldResolver`s — which exist on each layer — we create a
    // single `IndentResolver` per language mode.
    //
    // We do this because folds aggregate, so we can always either (a) delegate
    // a job to an arbitrary layer's `FoldResolver`, or (b) ask _all_ layers to
    // do something and then assemble the results.
    //
    // Indentation tasks, on the other hand, cannot be divided into work that
    // considers only a single `LanguageLayer` at a time. For instance, a given
    // indentation task might consult one layer's indentation query to know
    // whether to indent a line, but another layer's indentation query to know
    // whether to dedent the line. There are no simplicity gains to be made.
    //
    // `IndentResolver` _could_ therefore fold its methods into
    // `TreeSitterLanguageMode`, but is separate from it for reasons of
    // code organization.
    this.indentResolver = new IndentResolver(this.buffer, this);

    this.ready = this.grammar
      .getLanguage()
      .then((language) => {
        if (this.destroyed) return null;
        this.rootLanguage = language;
        this.registerGrammarForLanguage(language, grammar);
        this.rootLanguageLayer = new LanguageLayer(null, this, grammar, 0);
        this.subscriptions.add(
          ScopeResolver.onDidChangeConfiguration(this.config, (event) =>
            this.highlightConfigurationChanged(event),
          ),
        );
        return this.getOrCreateParserForLanguage(language);
      })
      .then((parser) => {
        if (this.destroyed || !parser) return null;
        // An edit queued before language loading can start the root update
        // first. Readiness must join it rather than treating reentry as done.
        return this.rootLanguageLayer.currentParsePromise ?? this.rootLanguageLayer.update(null);
      })
      .then((shouldEndTransaction) => {
        if (this.destroyed) return;
        if (shouldEndTransaction && this.resolveNextTransaction) {
          // An edit can arrive while the initial parse is waiting on its first
          // injection layers. The buffer's update is then subsumed into this
          // one, so its own completion callback receives `false`; finish that
          // pending transaction here after the initial update adopts it.
          this.finishTransactionUpdate();
        }
        this.publishCurrentLayers();
        this.emitter.emit("did-tokenize");
        return this.presentation.flush();
      })
      .catch((error) => {
        if (!this.destroyed) {
          if (this.resolveNextTransaction || this.pendingTransactionRanges.ranges.length > 0) {
            this.finishTransactionUpdate(error);
          }
          throw error;
        }
      });
  }

  destroy() {
    // Queued and running initial parses observe destruction before publishing.
    this.destroyed = true;
    this.document.close();
    this.presentation.destroy();
    this.highlightCache.clear();

    let layers = this.getAllLanguageLayers();
    for (let layer of layers) {
      layer?.destroy();
    }
    this.cancelPendingInitialInjectionUpdates();
    this.pendingTransactionRanges.clear();
    this.resolveNextTransactionPromise();
    this.transactionChangeCount = 0;
    this.autoIndentRequests = 0;
    this.injectionsMarkerLayer?.destroy();
    this.rootLanguageLayer = null;
    this.pendingDirtyHighlightRanges.clear();
    this.subscriptions?.dispose();

    // close() cancels active work; the binding keeps its resources alive until
    // completion. The active pool entry is removed by the parse finalizer.
    for (const [language, pool] of this.parsersByLanguage) {
      for (const parser of pool.active) parser.close();
      for (const parser of pool.idle) {
        parser.close();
      }
      pool.idle.length = 0;
      if (pool.active.size === 0) this.parsersByLanguage.delete(language);
    }
  }

  getGrammar() {
    return this.grammar;
  }

  getLanguageId() {
    return this.grammar.scopeName;
  }

  getNonWordCharacters(position) {
    const scope = this.scopeDescriptorForPosition(position);
    return this.config.get("editor.nonWordCharacters", { scope });
  }

  getRootParser() {
    return this.getOrCreateParserForLanguage(this.rootLanguage);
  }

  registerGrammarForLanguage(language, grammar) {
    this.grammarsByLanguage.set(language, grammar);
  }

  getParserPoolForLanguage(language) {
    let pool = this.parsersByLanguage.get(language);
    if (!pool) {
      pool = { idle: [], active: new Set() };
      this.parsersByLanguage.set(language, pool);
    }
    return pool;
  }

  createParserForLanguage(language) {
    const grammar = this.grammarsByLanguage.get(language);
    if (!grammar) {
      throw new Error("Cannot create a Tree-sitter parser for an unregistered language");
    }
    return grammar.createParser(language);
  }

  getOrCreateParserForLanguage(language) {
    const pool = this.getParserPoolForLanguage(language);
    if (pool.idle.length === 0) {
      pool.idle.push(this.createParserForLanguage(language));
    }
    return pool.idle[pool.idle.length - 1];
  }

  acquireParserForLanguage(language) {
    const pool = this.getParserPoolForLanguage(language);
    const parser = pool.idle.pop() ?? this.createParserForLanguage(language);
    pool.active.add(parser);
    return parser;
  }

  releaseParserForLanguage(language, parser) {
    const pool = this.parsersByLanguage.get(language);
    if (!pool?.active.delete(parser)) return;

    if (this.destroyed || pool.idle.length >= this.maxIdleParsersPerLanguage) {
      parser.close();
    } else {
      pool.idle.push(parser);
    }

    if (pool.idle.length === 0 && pool.active.size === 0) {
      this.parsersByLanguage.delete(language);
    }
  }

  _yieldForInjectionCandidateScan() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  _yieldForInjectionReconcile() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  _yieldForQueryCaptureScan() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  _yieldForInitialInjectionUpdates() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  scheduleAfterHighlightPaint(callback) {
    const workspace = globalThis.lumine?.workspace;
    const domWindow = [
      workspace?.getFocusedWindow()?.getDOMWindow(),
      ...(workspace?.getWindows().map((window) => window.getDOMWindow()) ?? []),
      globalThis.window,
    ].find((window) => window && !window.closed && window.document.visibilityState !== "hidden");
    const cancelFrame = domWindow?.cancelAnimationFrame.bind(domWindow);
    const cancelIdle = domWindow?.cancelIdleCallback?.bind(domWindow);
    let cancelled = false;
    let frame = null;
    let idle = null;
    let timer = null;
    const run = () => {
      if (cancelled) return;
      cancel();
      if (!this.destroyed) callback();
    };
    const afterFrame = () => {
      frame = null;
      if (cancelled || this.destroyed) return;
      if (domWindow?.requestIdleCallback) {
        idle = domWindow.requestIdleCallback(run, { timeout: 1000 });
      } else {
        run();
      }
    };
    // Idle work queued from a frame runs after its rendering opportunity. A
    // microtask here would compile before the new highlighting could paint.
    const cancel = () => {
      cancelled = true;
      if (frame != null) cancelFrame(frame);
      if (idle != null) cancelIdle(idle);
      if (timer != null) cancelBackgroundTask(timer);
      frame = idle = timer = null;
    };
    // The fallback also covers a window being occluded after its frame was
    // queued. Hidden presentations have no paint opportunity to wait for.
    timer = scheduleBackgroundTask(run, domWindow ? 1000 : 0);
    if (domWindow) frame = domWindow.requestAnimationFrame(afterFrame);
    return cancel;
  }

  scheduleInitialInjectionUpdate(callback) {
    if (this.destroyed) return Promise.resolve(false);

    let resolveJob;
    let rejectJob;
    const jobPromise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    this.pendingInitialInjectionUpdates.push({
      callback,
      resolve: resolveJob,
      reject: rejectJob,
    });
    this.ensureInitialInjectionUpdateDrain();
    return jobPromise;
  }

  ensureInitialInjectionUpdateDrain() {
    if (this.destroyed || this.initialInjectionUpdateDrainPromise) return;

    const drainPromise = this.drainInitialInjectionUpdates();
    this.initialInjectionUpdateDrainPromise = drainPromise;
    drainPromise.then(
      () => this.finishInitialInjectionUpdateDrain(drainPromise),
      (error) => {
        const pendingJobs = this.pendingInitialInjectionUpdates.splice(0);
        for (const job of pendingJobs) job.reject(error);
        this.finishInitialInjectionUpdateDrain(drainPromise);
      },
    );
  }

  async drainInitialInjectionUpdates() {
    while (!this.destroyed && this.pendingInitialInjectionUpdates.length > 0) {
      await this._yieldForInitialInjectionUpdates();
      if (this.destroyed) break;

      const startedAt = performance.now();
      do {
        const job = this.pendingInitialInjectionUpdates.shift();
        if (!job) break;

        let result;
        try {
          result = job.callback();
        } catch (error) {
          job.reject(error);
          continue;
        }
        Promise.resolve(result).then(job.resolve, job.reject);
      } while (
        !this.destroyed &&
        this.pendingInitialInjectionUpdates.length > 0 &&
        performance.now() - startedAt < this.initialInjectionUpdateBudgetMs
      );
    }

    if (this.destroyed) this.cancelPendingInitialInjectionUpdates();
  }

  finishInitialInjectionUpdateDrain(drainPromise) {
    if (this.initialInjectionUpdateDrainPromise !== drainPromise) return;
    this.initialInjectionUpdateDrainPromise = null;
    if (!this.destroyed && this.pendingInitialInjectionUpdates.length > 0) {
      this.ensureInitialInjectionUpdateDrain();
    }
  }

  cancelPendingInitialInjectionUpdates() {
    const pendingJobs = this.pendingInitialInjectionUpdates.splice(0);
    for (const job of pendingJobs) job.resolve(false);
  }

  canBatchTextChanges(count) {
    return count >= TreeSitterParser.bulkEditLimit;
  }

  // Large independent batches already force a fresh parser tree. Invalidate
  // presentation and injection routing once over their affected extent; the
  // document journal still receives every exact splice for revision tracking.
  bufferDidChangeBatch(change, count) {
    this.bufferDidChange(change);
    if (this.rootLanguageLayer) this.transactionChangeCount += count - 1;
  }

  bufferDidChange(change) {
    this.highlightCache.edit(change);
    this.presentation.edit(change);
    this.publicationPending = true;
    if (!this.rootLanguageLayer) {
      return;
    }

    const { oldRange, newRange } = change;
    this.foldRangeIndex = null;
    this.scopeDescriptorCache = null;

    const { startIndex } = change;

    // Mark edits in the tree, but don't actually reparse until
    // `bufferDidFinishTransaction`.
    let edit = {
      startIndex,
      oldEndIndex: change.oldEndIndex ?? startIndex + change.oldText.length,
      newEndIndex: change.newEndIndex ?? startIndex + change.newText.length,
      startPosition: oldRange.start,
      oldEndPosition: oldRange.end,
      newEndPosition: newRange.end,
    };

    if (!this.resolveNextTransaction) {
      // This is the first change after the last transaction finished, so we
      // need to create a new promise that will resolve when the next
      // transaction is finished.
      this.transactionChangeCount = 1;
      this.refreshNextTransactionPromise();
      this.lastTransactionParseError = null;
    } else {
      // We have a different definition of "changes" than what we get from
      // `bufferDidFinishTransaction`. Even when multiple calls to `insertText`
      // happen within a transaction, `TextBuffer` will attempt to consolidate
      // them into a single "change" — but what we care about is how many
      // atomic operations have taken place. So we keep track on our own.
      this.transactionChangeCount++;
    }

    this.rootLanguageLayer.handleTextChange(edit);

    const sameExtent =
      edit.oldEndIndex === edit.newEndIndex && edit.oldEndPosition.isEqual(edit.newEndPosition);
    const changedEndRow = Math.max(edit.oldEndPosition.row, edit.newEndPosition.row);
    let foldRowCacheInvalidated = false;
    const markers = this.injectionsMarkerLayer.getMarkers();
    let packedRanges;
    if (markers.length >= 64 && typeof this.injectionsMarkerLayer.index.getRanges === "function") {
      const ids = new Uint32Array(markers.length);
      for (let index = 0; index < markers.length; index++) ids[index] = markers[index].id;
      // The synchronous routing loop only edits trees and clears their caches;
      // it cannot mutate owner markers while this position snapshot is in use.
      packedRanges = this.injectionsMarkerLayer.index.getRanges(ids);
    }
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index];
      // Marker layers have already incorporated this buffer splice. If an
      // injection still ends strictly before the edit starts, neither its
      // contents nor any absolute position in its tree can have changed. A
      // boundary touch is deliberately not skipped: injection markers are
      // non-exclusive by default, so an insertion at either edge may become
      // part of the injection.
      const offset = index * 4;
      const markerRange = packedRanges ? null : marker.getRange();
      const endsBeforeEdit = packedRanges
        ? packedRanges[offset + 2] < edit.startPosition.row ||
          (packedRanges[offset + 2] === edit.startPosition.row &&
            packedRanges[offset + 3] < edit.startPosition.column)
        : markerRange.end.isLessThan(edit.startPosition);
      const startsAfterEdit =
        sameExtent &&
        (packedRanges
          ? edit.newEndPosition.row < packedRanges[offset] ||
            (edit.newEndPosition.row === packedRanges[offset] &&
              edit.newEndPosition.column < packedRanges[offset + 1])
          : edit.newEndPosition.isLessThan(markerRange.start));
      const layer = marker.languageLayer;
      // An equal-extent edit strictly before both the owner and all cached
      // content ranges cannot change this layer's source or coordinates. The
      // content check also protects injections that return ranges outside
      // their owner node. Unknown ranges keep the full path for leading edits.
      if (
        endsBeforeEdit ||
        (startsAfterEdit &&
          layer.currentRangesCache?.length &&
          layer.currentRangesCache.every((range) => edit.newEndPosition.isLessThan(range.start)))
      ) {
        // Fold predicates can inspect the full buffer row outside the layer's
        // ranges, so unchanged syntax does not imply unchanged fold captures.
        layer.foldResolver?.reset();
        // Their boolean row cache needs invalidation as well, even if the fold
        // starts on a different row. Unrelated row contexts retain the cache;
        // unknown content ranges conservatively invalidate it once per edit.
        const ranges = layer.currentRangesCache;
        if (
          !foldRowCacheInvalidated &&
          (!ranges?.length ||
            ranges.some(
              (range) =>
                range.start.row <= changedEndRow && range.end.row >= edit.startPosition.row,
            ))
        ) {
          this.isFoldableCache = new Map();
          foldRowCacheInvalidated = true;
        }
        continue;
      }
      layer.handleTextChange(edit);
    }
  }

  bufferDidFinishTransaction({ changes }) {
    if (!this.rootLanguageLayer) {
      return;
    }
    if (this.deferLargeBufferUpdates) {
      const now = performance.now();
      this.coalesceLargeBufferEdits =
        now - (this.lastLargeBufferEditAt ?? -Infinity) < SLOW_PARSE_COALESCE_MS;
      this.lastLargeBufferEditAt = now;
    }
    this.rebaseFoldCache(changes);
    this.pendingTransactionRanges.addAll(changes.map(({ newRange }) => newRange));

    this.requestDocumentUpdate();
  }

  rebaseFoldCache(changes) {
    if (
      this.isFoldableCache.size === 0 ||
      !changes.some(
        ({ oldRange, newRange }) =>
          oldRange.start.row !== oldRange.end.row || newRange.start.row !== newRange.end.row,
      )
    )
      return;

    // Transaction changes are ordered in original and final coordinates.
    // Move only rows the gutter has actually queried, once per transaction;
    // shifting a document-sized sparse array once per cursor is quadratic.
    const rebased = new Map();
    for (const [row, value] of this.isFoldableCache) {
      let low = 0;
      let high = changes.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (changes[middle].oldRange.start.row <= row) low = middle + 1;
        else high = middle;
      }
      if (low === 0) {
        rebased.set(row, value);
      } else {
        const { oldRange, newRange } = changes[low - 1];
        if (row > oldRange.end.row) rebased.set(row + newRange.end.row - oldRange.end.row, value);
      }
    }
    this.isFoldableCache = rebased;
  }

  requestDocumentUpdate() {
    if (this.destroyed || !this.rootLanguageLayer) return;
    this.publicationPending = true;
    if (!this.resolveNextTransaction) this.refreshNextTransactionPromise();
    this.updateRootLayer();
  }

  rootLanguageRangesChanged() {
    const layer = this.rootLanguageLayer;
    if (this.destroyed || !layer || this.grammarRegistry?.windowUnloading) return;
    if (!layer.tree) {
      layer.rootRangePolicyNeedsUpdate = true;
      return;
    }
    layer.resolveRootRangeSet();
    if (!layer.rootRangeInvalidationPending) return;
    layer.rootRangePolicyNeedsUpdate = true;
    layer.treeIsDirty = true;
    this.scopeDescriptorCache = null;
    if (!this.resolveNextTransaction) this.refreshNextTransactionPromise();
    this.updateRootLayer();
  }

  updateRootLayer() {
    try {
      const measure =
        this.shouldParseSynchronously() &&
        this.rootLanguageLayer.tree &&
        this.buffer.getLength() >= LARGE_BUFFER_ASYNC_THRESHOLD;
      const started = measure ? performance.now() : 0;
      const result = this.rootLanguageLayer.update(null);
      if (measure) {
        this.recordSynchronousUpdate(performance.now() - started);
      }
      const finish = (shouldEndTransaction) => {
        if (shouldEndTransaction) this.finishTransactionUpdate();
      };
      if (result?.then) result.then(finish, (error) => this.finishTransactionUpdate(error));
      else finish(result);
    } catch (error) {
      this.finishTransactionUpdate(error);
    }
  }

  finishTransactionUpdate(error = null) {
    const revision = this.buffer.getTextRevision();
    if (!error) this.publishCurrentLayers();
    if (revision !== this.buffer.getTextRevision()) return;
    this.lastTransactionEditedRange = this.rootLanguageLayer?.lastTransactionEditedRange;
    this.lastTransactionChangeCount = this.transactionChangeCount;
    this.lastTransactionAutoIndentRequests = this.autoIndentRequests;
    this.lastTransactionParseError = error;

    this.pendingTransactionRanges.clear();
    if (error) {
      console.error("Tree-sitter update failed", error);
    } else {
      // Warm only current views, not thousands of individual edit ranges.
      // Off-screen folds remain invalidated and resolve when requested.
      for (const range of this.presentation.getRequestedRanges()) {
        let prefillRange = range;
        if (range.end.row - range.start.row > FOLD_PREFILL_MAX_ROWS) {
          prefillRange = new Range(
            range.start,
            new Point(range.start.row + FOLD_PREFILL_MAX_ROWS, 0),
          );
        }
        if (!parserScheduler.hasBudget(this.syncTimeoutMicros)) break;
        this.prefillFoldCache(prefillRange);
      }

      for (const layer of this.getAllInjectionLayers()) {
        // The owning update has now either reparsed this layer or proved that
        // the transaction did not affect its contents.
        layer.treeIsDirty = false;
        layer.editedRange = null;
      }
    }

    const finish = () => {
      if (revision !== this.buffer.getTextRevision()) return;
      this.resolveNextTransactionPromise();
      this.transactionChangeCount = 0;
      this.autoIndentRequests = 0;
    };
    const presentation = !error && this.presentation.flush();
    if (presentation?.then) presentation.then(finish, finish);
    else finish();
  }

  // Invalidate fold caches for the rows touched by the given range.
  //
  // Invalidating syntax highlighting also invalidates fold caches for the same
  // range, but this method allows us to invalidate parts of the fold cache
  // without affecting syntax highlighting.
  emitFoldUpdate(range, { prefill = true } = {}) {
    this.foldRangeIndex = null;
    const startRow = range.start.row;
    const endRow = range.end.row;
    if (endRow - startRow < this.isFoldableCache.size) {
      for (let row = startRow; row <= endRow; row++) this.isFoldableCache.delete(row);
    } else {
      for (const row of this.isFoldableCache.keys())
        if (row >= startRow && row <= endRow) this.isFoldableCache.delete(row);
    }
    if (!prefill) return;
    // Invalidation must cover the whole range, but eager re-computation must
    // not: prefilling a whole large buffer after its initial parse costs more
    // than the parse did. Rows past the cap resolve on demand the first time
    // the gutter asks about them.
    let prefillRange = range;
    if (endRow - startRow > FOLD_PREFILL_MAX_ROWS) {
      prefillRange = new Range(range.start, new Point(startRow + FOLD_PREFILL_MAX_ROWS, 0));
    }
    if (parserScheduler.hasBudget(this.syncTimeoutMicros)) this.prefillFoldCache(prefillRange);
  }

  emitRangeUpdate(range) {
    this.presentation.invalidate(range);
    if (this.publicationPending) {
      this.publicationRanges.add(this.buffer.clipRange(range));
      return;
    }
    this.scopeDescriptorCache = null;
    this.emitFoldUpdate(range, { prefill: false });
    this.emitter.emit("did-change-highlighting", range);
    this.presentation.flush();
  }

  publishCurrentLayers() {
    if (this.destroyed) return false;
    const revision = this.buffer.getTextRevision();
    if (
      this.getAllLanguageLayers().some(
        (layer) =>
          layer &&
          !layer.destroyed &&
          (layer.tree?.revision !== revision ||
            layer.updating ||
            layer.injectionPopulationDrainPromise ||
            layer.queryReloadPromise),
      )
    )
      return false;
    this.publicationPending = false;
    this.synchronousUpdates = true;
    const ranges = [...this.publicationRanges];
    this.publicationRanges.clear();
    for (const range of ranges) {
      this.scopeDescriptorCache = null;
      this.emitFoldUpdate(range, { prefill: false });
      this.emitter.emit("did-change-highlighting", range);
    }
    this.presentation.flush();
    return true;
  }

  advanceUnchangedLayers() {
    const revision = this.buffer.getTextRevision();
    const layers = this.getAllInjectionLayers().sort((a, b) => a.depth - b.depth);
    const advance = (index) => {
      for (; index < layers.length; index++) {
        if (this.destroyed || revision !== this.buffer.getTextRevision()) return;
        const layer = layers[index];
        if (layer.destroyed || layer.tree?.revision === revision) continue;
        if (layer.currentParsePromise) return layer.currentParsePromise.then(() => advance(index));
        const capture = this.document.capture(layer.backgroundTree);
        const ranges = (layer.getCurrentRanges() ?? []).map((range) =>
          rangeToTreeSitterRangeSpec(range, this.buffer),
        );
        const reused =
          capture.previous &&
          TreeSitterParser.reuseSnapshot(capture.previous, capture.text, {
            edits: capture.edits,
            revision: capture.revision,
            includedRanges: ranges,
          });
        if (reused) {
          this.backgroundSnapshots.add(reused);
          layer.tree = layer.lastSyntaxTree = layer.backgroundTree = reused;
          layer.treeIsDirty = false;
          layer.includedRangesAreCurrent = true;
          layer.lastIncludedRanges = ranges;
          layer.nodesToInvalidateOnChange.rebase();
          layer.foldNodesToInvalidateOnChange.rebase();
          layer.scopeResolver.reset();
          const children = layer.hasInjectionDescendants()
            ? layer._populateInjections(layer.editedRange ?? layer.getExtent(), null)
            : null;
          layer.editedRange = null;
          if (children?.then) return children.then(() => advance(index + 1));
          continue;
        }
        const result = layer.update({ getRanges: () => ranges, rangesUnchanged: true });
        if (result?.then) return result.then(() => advance(index + 1));
      }
    };
    return advance(0);
  }

  highlightConfigurationChanged(event) {
    if (this.destroyed) return;
    const ranges = new TreeSitterRangeList();
    for (const layer of this.getAllLanguageLayers()) {
      const query = layer?.queries?.highlightsQuery;
      if (!query) continue;
      const keys = configKeysForHighlightQuery(query);
      for (const key of keys) {
        if (event?.affectsConfiguration && !event.affectsConfiguration(key)) continue;
        ranges.add(layer.getExtent());
        break;
      }
    }
    for (const range of ranges) {
      this.presentation.invalidate(range);
      this.scopeDescriptorCache = null;
    }
    this.presentation.flush();
  }

  scheduleDirtyHighlightUpdate(range) {
    this.pendingDirtyHighlightRanges.add(range);
    if (this.dirtyHighlightPromise) return;

    const updatePromise = this.atTransactionEnd().then(() => {
      const ranges = [...this.pendingDirtyHighlightRanges];
      this.pendingDirtyHighlightRanges.clear();
      if (this.destroyed) return;
      for (const dirtyRange of ranges) {
        this.emitRangeUpdate(dirtyRange);
      }
    });
    this.dirtyHighlightPromise = updatePromise;
    updatePromise.then(
      () => this.finishDirtyHighlightUpdate(updatePromise),
      (error) => {
        console.error("Error scheduling Tree-sitter highlight update", error);
        this.pendingDirtyHighlightRanges.clear();
        this.finishDirtyHighlightUpdate(updatePromise);
      },
    );
  }

  finishDirtyHighlightUpdate(updatePromise) {
    if (this.dirtyHighlightPromise !== updatePromise) return;
    this.dirtyHighlightPromise = null;
    if (!this.destroyed && this.pendingDirtyHighlightRanges.ranges.length > 0) {
      this.scheduleDirtyHighlightUpdate(this.pendingDirtyHighlightRanges.ranges[0]);
    }
  }

  // Resolve the promise that was created when we reacted to the first change
  // in a given transaction. We resolve it with the number of changes in the
  // transaction so that we can react differently to batches of changes than to
  // single changes.
  resolveNextTransactionPromise() {
    if (this.resolveNextTransaction) {
      this.resolveNextTransaction();
      this.resolveNextTransaction = null;
    }

    if (!this.nextTransaction) {
      // No edits have happened yet, so we should put this here as a
      // placeholder until the user edits the buffer for the first time.
      this.nextTransaction = Promise.resolve();
    }
  }

  // Create a promise that will resolve when the next transaction is done and
  // all its side effects are handled. When this promise resolves, all parse
  // trees will be clean and up to date. This promise cannot reject — only
  // resolve.
  refreshNextTransactionPromise() {
    if (this.resolveNextTransaction) {
      return false;
    }
    this.nextTransaction = new Promise((resolve) => {
      this.resolveNextTransaction = (changes) => {
        resolve(changes);
      };
    });
    return true;
  }

  // Resolves the next time that all Tree-sitter trees are clean — or
  // immediately, if they're clean at the time of invocation.
  //
  // Resolves with metadata about the previous transaction that may be useful
  // for the caller to know:
  //
  // * How many atomic changes have been made since the last clean tree.
  // * The range that represents the extent of the changes made since the last
  //   clean tree.
  // * How many times Lumine requested auto-indent actions that this language
  //   mode couldn't fulfill (see `suggestedIndentForLineAtBufferRow`).
  //
  async atTransactionEnd() {
    if (!this.tokenized) {
      // `this.ready` resolves with nothing, and callers destructure what they
      // are given: a mode that has not tokenized yet still owes them a
      // description of a transaction, even an empty one.
      await this.ready;
      return this.transactionMetadata();
    }
    if (this.atTransactionEndPromise) {
      return this.atTransactionEndPromise;
    }
    let prerequisite = this.nextTransaction || Promise.resolve();
    this.atTransactionEndPromise = prerequisite
      .then(() => this.transactionMetadata())
      .finally(() => {
        this.atTransactionEndPromise = null;
      });
    return this.atTransactionEndPromise;
  }

  // Resolves after the current parse transaction and in-flight query/layer
  // work settle. Queued ancillary idle work is not a prerequisite: a consumer
  // requests the query it needs rather than forcing background compiles before
  // the first paint. Awaiting a batch may create another layer or schedule
  // another reload, so rescan until no unseen in-flight work remains.
  async atGrammarSettlement() {
    await this.ready;
    let transaction = await this.atTransactionEnd();
    const awaitedPromises = new Set();

    while (!this.destroyed && !transaction.parseError) {
      const pending = new Set();
      for (const layer of this.getAllLanguageLayers()) {
        for (const promise of [
          layer?.queryReloadPromise,
          layer?.injectionPopulationDrainPromise,
          layer?.currentParsePromise,
          ...(layer?.queryLoadPromises?.values?.() ?? []),
        ]) {
          if (typeof promise?.then === "function" && !awaitedPromises.has(promise)) {
            pending.add(promise);
          }
        }
      }
      if (pending.size === 0) break;

      for (const promise of pending) awaitedPromises.add(promise);
      await Promise.all(pending);
      if (this.destroyed) break;
      transaction = await this.atTransactionEnd();
    }

    if (!this.destroyed && !transaction.parseError) {
      this.publishCurrentLayers();
      while (!this.destroyed) {
        const pending = this.presentation.flush();
        if (!pending) break;
        await pending;
      }
    }
    return transaction;
  }

  transactionMetadata() {
    return {
      changeCount: this.lastTransactionChangeCount ?? 0,
      range: this.lastTransactionEditedRange ?? null,
      autoIndentRequests: this.lastTransactionAutoIndentRequests ?? 0,
      parseError: this.lastTransactionParseError ?? null,
    };
  }

  prefillFoldCache(range) {
    this.rootLanguageLayer?.foldResolver?.prefillFoldCache(range);

    let markers = this.injectionsMarkerLayer.findMarkers({
      intersectsRange: range,
    });

    for (let marker of markers) {
      let { foldResolver } = marker.languageLayer;
      if (!foldResolver) {
        continue;
      }
      foldResolver.prefillFoldCache(range);
    }
  }

  grammarForLanguageString(languageString) {
    let result = this.grammarRegistry.treeSitterGrammarForLanguageString(languageString);
    return result;
  }

  // Called when any grammar is added or changed, on the off chance that it
  // affects an injection of ours.
  updateInjectionsForGrammar(grammar) {
    if (!this.rootLanguageLayer) {
      // We haven't gotten far enough for this to matter yet. Injections will
      // be handled later.
      return;
    }
    if (!grammar.injectionNames?.length) {
      // This grammar has no injection aliases, hence there's no way for
      // another grammar to use it for injection.
      return;
    }
    // Now we'll visit every layer in the document in turn and see if any of
    // them might be affected by the addition of this grammar. We keep a cache
    // to cut down on redundant lookups.
    let cache = new Map();

    // Each layer calls `updateInjectionsForGrammar` on its children, so we
    // need only start the process.
    this.rootLanguageLayer.updateInjectionsForGrammar(grammar, cache);
    cache.clear();
    this.publishCurrentLayers();
  }

  repopulateInjections() {
    // Grammar removal can arrive before the root is ready or after this mode
    // was destroyed while its buffer still refers to it.
    if (this.destroyed || !this.rootLanguageLayer) return;
    // Grammar removal/replacement must cancel any plan holding the old target
    // grammar, including plans that have not published their child layers yet.
    for (const layer of this.getAllLanguageLayers()) layer.injectionPointVersion++;
    this.rootLanguageLayer?._populateInjections(MAX_RANGE, null);
  }

  /*
  Section - Highlighting
  */

  onDidTokenize(callback) {
    return this.emitter.on("did-tokenize", callback);
  }

  // An injection grammar becomes used as soon as an injection point has
  // resolved it and supplied non-empty content. This deliberately fires before
  // its child LanguageLayer is constructed: listeners can prepare any
  // package-owned lazy grammar work before that layer performs tokenization.
  onDidUseInjectionGrammar(callback) {
    return this.emitter.on("did-use-injection-grammar", callback);
  }

  emitInjectionGrammarUsed(grammar) {
    this.emitter.emit("did-use-injection-grammar", grammar);
  }

  onDidChangeHighlighting(callback) {
    return this.emitter.on("did-change-highlighting", callback);
  }

  buildHighlightIterator() {
    if (!this.rootLanguageLayer) {
      return new NullLanguageModeHighlightIterator();
    }
    if (this.publicationPending) return new PendingHighlightIterator(this);
    return new HighlightIterator(this);
  }

  buildPresentationHighlightIterator(owner) {
    return new PendingHighlightIterator(this, true, owner);
  }

  requestHighlighting(owner, ranges) {
    const synchronous = this.shouldParseSynchronously();
    this.presentation.requestRanges(owner, ranges, !synchronous);
    if (synchronous) this.presentation.flush();
  }

  capturePresentationVersion() {
    if (this.destroyed || this.publicationPending) return null;
    return {
      revision: this.buffer.getTextRevision(),
      generation: this.presentation.generation,
      layers: this.getAllLanguageLayers()
        .filter(Boolean)
        .map((layer) => ({
          layer,
          tree: layer.tree,
          grammar: layer.grammar,
          query: layer.queries?.highlightsQuery,
          queryGeneration: layer.grammar.queryLoadGeneration,
          topology: layer.injectionPointVersion,
        })),
    };
  }

  presentationVersionIsCurrent(stamp) {
    const layers = this.getAllLanguageLayers().filter(Boolean);
    return (
      !this.destroyed &&
      !this.publicationPending &&
      stamp.revision === this.buffer.getTextRevision() &&
      stamp.generation === this.presentation.generation &&
      layers.length === stamp.layers.length &&
      stamp.layers.every((entry, index) => {
        const layer = layers[index];
        return (
          entry.layer === layer &&
          !layer.destroyed &&
          entry.tree === layer.tree &&
          entry.grammar === layer.grammar &&
          entry.query === layer.queries?.highlightsQuery &&
          entry.queryGeneration === layer.grammar.queryLoadGeneration &&
          entry.topology === layer.injectionPointVersion
        );
      })
    );
  }

  classNameForScopeId(scopeId) {
    return this.grammar.classNameForScopeId(scopeId);
  }

  scopeNameForScopeId(scopeId) {
    return this.grammar.scopeNameForScopeId(scopeId);
  }

  idForScope(name) {
    return this.grammar.idForScope(name);
  }

  // Behaves like `scopeDescriptorForPosition`, but returns a list of
  // Tree-sitter node names. Useful for understanding Tree-sitter parsing or
  // for writing syntax highlighting query files.
  syntaxTreeScopeDescriptorForPosition(point) {
    point = this.normalizePointForPositionQuery(point);
    let index = this.buffer.characterIndexForPosition(point);

    let layers = this.languageLayersAtPoint(point);
    let matches = [];

    for (let layer of layers) {
      if (!layer.tree) {
        continue;
      }
      let layerMatches = [];

      let root = layer.tree.rootNode;
      let current = root.descendantForIndex(index);

      while (current) {
        // Keep track of layer depth as well so we can use it to break ties
        // later.
        layerMatches.unshift({ node: current, depth: layer.depth });
        current = current.parent;
      }

      matches.push(...layerMatches);
    }

    // The nodes are mostly already sorted from smallest to largest,
    // but for files with multiple syntax trees (e.g. ERB), each tree's
    // nodes are separate. Sort the nodes from largest to smallest.
    matches.sort(
      (a, b) =>
        a.node.startIndex - b.node.startIndex ||
        b.node.endIndex - a.node.endIndex ||
        a.depth - b.depth,
    );

    let scopes = matches.map(({ node }) => (node.isNamed ? node.type : `"${node.type}"`));
    scopes.unshift(this.grammar.scopeName);

    return new ScopeDescriptor({ scopes });
  }

  // Returns the buffer range for the first scope to match the given scope
  // selector, starting with the smallest scope and moving outward.
  bufferRangeForScopeAtPosition(selector, point) {
    point = this.normalizePointForPositionQuery(point);

    if (typeof selector === "function") {
      // We've been given a node-matching function instead of a scope name.
      let node = this.getSyntaxNodeAtPosition(point, selector);
      return node?.range;
    }
    // Results returned from `scopeMapAtPosition` lack the context to know
    // whether they've been covered by deeper scopes. Keep a scope descriptor
    // around so that we can compare results with reality.
    let scopeDescriptor = this.scopeDescriptorForPosition(point).getScopesArray();

    let match = selector ? matcherForSelector(selector) : FUNCTION_TRUE;

    if (!this.rootLanguageLayer) {
      return match("text") ? this.buffer.getRange() : null;
    }

    let layers = this.languageLayersAtPoint(point);
    let results = [];
    for (let layer of layers) {
      if (layer.grammar.scopeName === selector) {
        return layer.getExtent();
      }
      let items = layer.scopeMapAtPosition(point);
      for (let { capture, adjustedRange } of items) {
        let range = rangeForNode(adjustedRange);
        if (!range.containsPoint(point)) {
          continue;
        }
        // If this scope name isn't present in the scope descriptor, assume
        // it's been covered by an injection layer. This isn't perfect but
        // it'll be good enough for now.
        if (!scopeDescriptor.includes(capture.name)) {
          continue;
        }
        results.push({ capture, adjustedRange, range });
      }
    }

    // We need the results sorted from smallest to biggest.
    results = results.sort((a, b) => {
      return nodeBreadth(a.adjustedRange) - nodeBreadth(b.adjustedRange);
    });

    for (let { capture, range } of results) {
      if (match(capture.name)) {
        return range;
      }
    }
  }

  // Given a point, return all scopes active at that point.
  scopeDescriptorForPosition(point) {
    if (!this.rootLanguageLayer || this.publicationPending) {
      return new ScopeDescriptor({ scopes: [this.grammar.scopeName, "text"] });
    }
    point = this.normalizePointForPositionQuery(point);
    if (this.scopeDescriptorCache?.point.isEqual(point)) {
      return this.scopeDescriptorCache.descriptor;
    }

    // The most accurate way to do this is to reconstruct the results from the
    // highlight iterator itself.
    const iterator = this.buildHighlightIterator();
    const scopes = [];

    // Add scopes that were open already at this point.
    for (const scope of iterator.seek(point, point.row + 1)) {
      scopes.push(this.grammar.scopeNameForScopeId(scope));
    }

    while (point.isEqual(iterator.getPosition())) {
      for (const scope of iterator.getOpenScopeIds()) {
        scopes.push(this.grammar.scopeNameForScopeId(scope));
      }
      // Don't count anything that ends at this point.
      for (const scope of iterator.getCloseScopeIds()) {
        removeLastOccurrenceOf(scopes, this.grammar.scopeNameForScopeId(scope));
      }
      iterator.moveToSuccessor();
    }

    if (
      (!this.rootLanguageLayer.rootRangesRestricted ||
        this.rootLanguageLayer.containsPoint(point)) &&
      (scopes.length === 0 || scopes[0] !== this.grammar.scopeName)
    ) {
      scopes.unshift(this.grammar.scopeName);
    }
    const descriptor = new ScopeDescriptor({ scopes });
    this.scopeDescriptorCache = { point: point.freeze(), descriptor };
    return descriptor;
  }

  normalizePointForPositionQuery(point) {
    // Convert bare arrays to points.
    if (Array.isArray(point)) {
      point = new Point(...point);
    }

    // Convert bare objects to points and ensure we're dealing with a copy.
    if (!("copy" in point)) {
      point = Point.fromObject(point, true);
    } else {
      point = point.copy();
    }

    // Constrain the point to the buffer range.
    point = this.buffer.clipPosition(point);

    // If the position is the end of a line, get the scope of the character to
    // its left instead of the newline.
    if (point.column > 0 && point.column === this.buffer.lineLengthForRow(point.row)) {
      point.column--;
    }

    return point;
  }

  // A parser fault can surface with a stack that stops at `Parser.parse` — it
  // names neither the grammar nor what it was parsing, and an injection layer
  // means the file's own grammar is not even a good guess.
  // This says which grammar faulted and on what, which is the whole difference
  // between a reportable bug and a shrug.
  describeParseFailure(error, { scopeName, includedRanges }) {
    let where = scopeName ? `grammar '${scopeName}'` : "an unknown grammar";
    let ranges = includedRanges?.length ? ` over ${includedRanges.length} included range(s)` : "";
    let detail = `${where}${ranges}, buffer length ${this.buffer.getLength()}`;
    let wrapped = new Error(`Tree-sitter parse failed in ${detail}: ${error.message}`);
    wrapped.stack = `${wrapped.message}\n${error.stack ?? ""}`;
    wrapped.cause = error;
    return wrapped;
  }

  async parseAsync(
    language,
    oldTree,
    includedRanges,
    { scopeName = null, signal, depth = 0, onStart, extraEdits = [] } = {},
  ) {
    if (this.destroyed || signal?.aborted) return null;
    if (
      depth === 0 &&
      oldTree &&
      this.deferLargeBufferUpdates &&
      this.coalesceLargeBufferEdits &&
      this.buffer.getLength() >= LARGE_BUFFER_ASYNC_THRESHOLD
    ) {
      // A slow parse cannot finish between repeat-key events. Coalesce them
      // before copying a tree or capturing a growing revision journal. Ranges
      // still belong to the submitted revision; never pair them with new text.
      const revision = this.buffer.getTextRevision();
      await new Promise((resolve) => {
        const finish = () => {
          cancelBackgroundTask(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = scheduleBackgroundTask(
          finish,
          Math.max(0, this.lastLargeBufferEditAt + SLOW_PARSE_COALESCE_MS - performance.now()),
        );
        signal?.addEventListener("abort", finish, { once: true });
      });
      if (this.destroyed || signal?.aborted || revision !== this.buffer.getTextRevision())
        return null;
    }
    // Ranges and compaction edits describe the revision at submission. Capture
    // its input before queuing so a later edit cannot pair them with new text.
    const previous =
      oldTree?.language === language && this.backgroundSnapshots.has(oldTree) ? oldTree : null;
    const capture = this.document.capture(previous);
    return parserScheduler
      .run(
        async () => {
          if (this.destroyed) return null;
          onStart?.();
          const parser = this.acquireParserForLanguage(language);
          try {
            signal?.throwIfAborted();
            const options = {
              deadlineForSlice: () => parserScheduler.deadline(4000),
              previous: capture.previous,
              edits: extraEdits.length
                ? Object.freeze([...capture.edits, ...extraEdits])
                : capture.edits,
              revision: capture.revision,
              includedRanges: includedRanges ?? undefined,
            };
            let tree =
              this.syncTimeoutMicros > 0
                ? parser.tryParseSync(capture.text, {
                    ...options,
                    deadline: parserScheduler.deadline(this.syncTimeoutMicros),
                  })
                : null;
            if (!tree) tree = await parser.parse(capture.text, { ...options, signal });
            if (!tree) return null;
            this.backgroundSnapshots.add(tree);
            this.parseDetails.set(tree, { incremental: tree.incremental });
            return tree;
          } catch (error) {
            if (error.name === "AbortError" || this.destroyed) return null;
            throw this.describeParseFailure(error, { scopeName, includedRanges });
          } finally {
            this.releaseParserForLanguage(language, parser);
          }
        },
        {
          signal,
          priority: () =>
            (lumine.workspace?.getActiveTextEditor()?.getBuffer() === this.buffer ? 0 : 100) +
            depth,
        },
      )
      .catch((error) => {
        if (error.name === "AbortError" || this.destroyed) return null;
        throw error;
      });
  }

  parse(
    language,
    oldTree,
    includedRanges,
    { scopeName = null, extraEdits = [], budgetOnly = false, signal } = {},
  ) {
    if (this.destroyed) return null;
    const previous =
      oldTree?.language === language && this.backgroundSnapshots.has(oldTree) ? oldTree : null;
    const capture = this.document.capture(previous);
    const parser = this.acquireParserForLanguage(language);
    const options = {
      signal,
      deadlineForSlice: () => parserScheduler.deadline(4000),
      previous: capture.previous,
      edits: extraEdits.length ? Object.freeze([...capture.edits, ...extraEdits]) : capture.edits,
      revision: capture.revision,
      includedRanges: includedRanges ?? undefined,
    };
    const finish = (tree) => {
      if (!tree) return null;
      this.backgroundSnapshots.add(tree);
      this.parseDetails.set(tree, { incremental: tree.incremental });
      return tree;
    };
    try {
      const tree =
        budgetOnly && !this.shouldParseSynchronously()
          ? parser.tryParseSync(capture.text, {
              ...options,
              deadline: parserScheduler.deadline(this.syncTimeoutMicros),
            })
          : parser.parseSync(capture.text, options);
      if (tree) return finish(tree);
      if (budgetOnly) {
        parser.reset();
        return null;
      }
      return null;
    } catch (error) {
      if (error.name === "AbortError") return null;
      throw this.describeParseFailure(error, { scopeName, includedRanges });
    } finally {
      this.releaseParserForLanguage(language, parser);
    }
  }

  get tree() {
    return this.publicationPending ? null : this.rootLanguageLayer?.tree;
  }

  /*
  Section - Syntax Tree APIs
  */

  getSyntaxNodeContainingRange(range, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer) {
      return null;
    }
    return this.getSyntaxNodeAndGrammarContainingRange(range, where)?.node;
  }

  getSyntaxNodeAndGrammarContainingRange(range, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer || this.publicationPending) {
      return { node: null, grammar: null };
    }

    let layersAtStart = this.languageLayersAtPoint(range.start, { exact: true });
    let layersAtEnd = new Set(this.languageLayersAtPoint(range.end, { exact: true }));
    let sharedLayers = layersAtStart.filter((layer) => layersAtEnd.has(layer));
    let indexStart = this.buffer.characterIndexForPosition(range.start);
    let indexEnd = this.buffer.characterIndexForPosition(range.end);
    let rangeBreadth = indexEnd - indexStart;

    sharedLayers.reverse();
    let results = [];
    for (let layer of sharedLayers) {
      if (!layer.tree) {
        continue;
      }
      let { grammar, depth } = layer;
      let rootNode = layer.tree.rootNode;

      if (rootNode.startIndex > indexStart || rootNode.endIndex < indexEnd) {
        // There's often a difference between (a) the areas that we consider to
        // be our canonical content ranges for a layer and (b) the range
        // covered by the layer's root node. Root tree nodes usually ignore any
        // whitespace that occurs before the first meaningful content of the
        // node, but we consider that space to be under the purview of the
        // layer all the same.
        //
        // If we've gotten this far, we've already decided that this layer
        // includes this range. So let's just pretend that the root node covers
        // this area.
        results.push({ node: rootNode, grammar, depth });
        continue;
      }

      let node = rootNode.descendantForIndex(indexStart);
      while (node) {
        let breadth = node.endIndex - node.startIndex;
        const qualifies =
          node.startIndex <= indexEnd && node.endIndex >= indexEnd && breadth > rangeBreadth;
        if (qualifies) break;
        node = node.parent;
      }

      if (node) {
        results.push({ node, grammar, depth });
      }
    }

    results.sort((a, b) => {
      return (
        // Favor smaller nodes first…
        nodeBreadth(a.node) - nodeBreadth(b.node) ||
        // …but deeper grammars in case of ties.
        b.depth - a.depth
      );
    });

    for (let { node, grammar } of results) {
      if (where(node, grammar)) {
        return { node, grammar };
      }
    }

    return { node: null, grammar: null };
  }

  getRangeForSyntaxNodeContainingRange(range, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer) {
      return null;
    }
    let node = this.getSyntaxNodeContainingRange(range, where);
    return node && rangeForNode(node);
  }

  // Return the smallest syntax node at the given position, or the smallest
  // node that matches the optional `where` predicate. The `where` predicate is
  // given the node and the associated grammar as arguments.
  getSyntaxNodeAtPosition(position, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer || this.publicationPending) {
      return null;
    }
    position = this.buffer.clipPosition(position);
    let allLayers = this.languageLayersAtPoint(position);
    const index = this.buffer.characterIndexForPosition(position);

    if (where === FUNCTION_TRUE) {
      let bestNode = null;
      let bestBreadth = Infinity;
      let bestDepth = -Infinity;
      for (let i = allLayers.length - 1; i >= 0; i--) {
        const layer = allLayers[i];
        if (!layer.tree) continue;
        const rootNode = layer.tree.rootNode;
        const node =
          rootNode.startIndex <= index && rootNode.endIndex >= index
            ? rootNode.descendantForIndex(index)
            : rootNode;
        const breadth = nodeBreadth(node);
        if (breadth < bestBreadth || (breadth === bestBreadth && layer.depth > bestDepth)) {
          bestNode = node;
          bestBreadth = breadth;
          bestDepth = layer.depth;
        }
      }
      return bestNode;
    }

    // We start with the deepest layer and move outward.
    //
    // TODO: Instead of sorting all candidates at the end, let's just keep
    // track of the smallest we've seen and then return it after all the
    // looping.
    allLayers.reverse();
    let results = [];
    for (let layer of allLayers) {
      if (!layer.tree) {
        continue;
      }
      let { depth, grammar } = layer;
      let rootNode = layer.tree.rootNode;
      if (rootNode.startIndex > index || rootNode.endIndex < index) {
        // There's often a difference between (a) the areas that we consider to
        // be our canonical content ranges for a layer and (b) the range
        // covered by the layer's root node. Root tree nodes usually ignore any
        // whitespace that occurs before the first meaningful content of the
        // node, but we consider that space to be under the purview of the
        // layer all the same.
        //
        // If we've gotten this far, we've already decided that this layer
        // includes this point. So let's just pretend that the root node covers
        // this area.
        results.push({ node: rootNode, depth, grammar });
        continue;
      }

      let node = rootNode.descendantForIndex(index);
      while (node) {
        // We aren't checking against the predicate yet because passing the
        // predicate won't end our search. Users will reasonably expect that
        // returning `true` from the predicate will mean that the predicate
        // won't run any more. Since the predicate can have side effects, we
        // should keep this contract. That means throwing all nodes into the
        // bucket and not sifting through them until later.
        //
        // TODO: If we need to optimize performance here, we could compromise
        // by re-running the predicate at the end even though we already know
        // it's going to match.
        results.push({ node, depth, grammar });
        node = node.parent;
      }
    }

    // Sort results from smallest to largest.
    results.sort((a, b) => {
      return (
        // Favor smaller nodes first…
        nodeBreadth(a.node) - nodeBreadth(b.node) ||
        // …but deeper grammars in case of ties.
        b.depth - a.depth
      );
    });

    for (let { node, grammar } of results) {
      if (where(node, grammar)) {
        return node;
      }
    }
    return null;
  }

  /*
  Section - Folds
  */
  getFoldableRangeContainingPoint(point) {
    if (this.publicationPending) return null;
    this.ensureQueriesForLayersSync("foldsQuery");
    point = this.buffer.clipPosition(point);
    if (point.column >= this.buffer.lineLengthForRow(point.row)) {
      let fold = this.getFoldRangeForRow(point.row);
      if (fold) {
        return fold;
      }
    }

    const entries = this.foldRangeIndex ?? (this.foldRangeIndex = this.buildFoldRangeIndex());
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].range.start.row < point.row) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    let best = null;
    for (let i = low - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.greatestEndThroughHere.isLessThan(point)) break;
      if (!entry.range.containsPoint(point)) continue;
      if (
        !best ||
        entry.range.start.row > best.range.start.row ||
        (entry.range.start.row === best.range.start.row && entry.depth > best.depth)
      ) {
        best = entry;
      }
      if (best && i > 0 && entries[i - 1].range.start.row < best.range.start.row) break;
    }
    return best?.range ?? null;
  }

  buildFoldRangeIndex() {
    const entries = [];
    for (const layer of this.getAllLanguageLayers()) {
      for (const range of layer.foldResolver.getAllFoldRanges()) {
        entries.push({ range, depth: layer.depth });
      }
    }
    entries.sort((a, b) => {
      return a.range.start.compare(b.range.start) || b.depth - a.depth;
    });

    let greatestEnd = Point.ZERO;
    for (const entry of entries) {
      greatestEnd = Point.max(greatestEnd, entry.range.end);
      entry.greatestEndThroughHere = greatestEnd;
    }
    return entries;
  }

  getFoldableRanges() {
    if (!this.tokenized || this.publicationPending) {
      return [];
    }
    this.ensureQueriesForLayersSync("foldsQuery");

    let layers = this.getAllLanguageLayers();
    let allFolds = [];
    for (let layer of layers) {
      let folds = layer.foldResolver.getAllFoldRanges();
      allFolds.push(...folds);
    }
    return allFolds;
  }

  // This method is improperly named, and is based on an assumption that every
  // nesting of folds carries an extra level of indentation. Several languages
  // violate that — perhaps most notably the C grammar in its use of nested
  // folds within `#ifdef` and its siblings.
  //
  // Instead, a level of `0` means “all folds that are not contained by any
  // other fold,” a level of `1` means “all folds that are contained by exactly
  // one other fold,” and so on. This happens to work as expected if you're
  // working in a language where nested folds are always indented relative to
  // their enclosing fold, but it doesn't require it.
  //
  getFoldableRangesAtIndentLevel(goalLevel) {
    if (!this.tokenized || this.publicationPending) {
      return [];
    }
    this.ensureQueriesForLayersSync("foldsQuery");

    // The key for this red-black tree needs to be a combination of a point and
    // a range. We do this because we want to order primarily by buffer
    // position; but secondarily we need to consider whether the point is the
    // start or the end of a range so that we can ensure that we visit the
    // points in the order that properly expresses containment.
    let rangeTree = createTree(comparePointAndRangeBundles);

    // No easy way around this. The way to pull it off is to get _all_ folds in
    // the document on all language layers, then place their boundaries into a
    // red-black tree so we can iterate through them later in the proper order
    // while keeping track of nesting level.
    let layers = this.getAllLanguageLayers();
    for (let layer of layers) {
      let folds = layer.foldResolver.getAllFoldRanges();
      for (let fold of folds) {
        rangeTree = rangeTree.insert([fold.start, fold], { start: fold });
        rangeTree = rangeTree.insert([fold.end, fold], { end: fold });
      }
    }

    let foldsAtGoalLevel = [];
    let currentLevel = 0;
    let iterator = rangeTree.begin;

    // Whatever `currentLevel` is at when we reach a given `@fold.start` marker
    // is the depth of that marker.
    while (iterator.key) {
      let { start, end } = iterator.value;
      if (start) {
        if (currentLevel === goalLevel) foldsAtGoalLevel.push(start);
        currentLevel++;
      } else if (end) {
        currentLevel--;
      }
      iterator.next();
    }

    return foldsAtGoalLevel;
  }

  // Adjusts a buffer position by a fixed number of characters.
  adjustPositionByOffset(position, offset) {
    let { buffer } = this;
    let index = buffer.characterIndexForPosition(position);
    index += offset;
    return buffer.positionForCharacterIndex(index);
  }

  isFoldableAtRow(row) {
    if (this.tokenized) {
      const point = new Point(row, this.buffer.lineLengthForRow(row));
      this.ensureQueriesForLayersSync("foldsQuery", this.languageLayersAtPoint(point));
    }
    return this.isFoldableAtRowForRendering(row);
  }

  isFoldableAtRowForRendering(row) {
    // A read inside an open transaction must not cache an incomplete result.
    if (this.publicationPending) return false;
    const cached = this.isFoldableCache.get(row);
    if (cached != null) return cached;

    // The gutter asks during rendering. It can acquire chevrons after the
    // deferred query lands without making that render compile a cold query.
    let range = this.getFoldRangeForRowInternal(row, false);

    // A later ancillary-query update invalidates this cache, including an
    // initial false result while the gutter is waiting for its query.
    if (this.tokenized) {
      // We can easily keep track of _if_ this row is foldable, even if edits
      // to the buffer end up moving this row around. But we don't bother to
      // cache the actual _range_ because it'd just get stale once the buffer
      // is edited. Better to wait and look it up when it's needed.
      this.isFoldableCache.set(row, !!range);
    }
    return !!range;
  }

  getFoldRangeForRow(row) {
    return this.getFoldRangeForRowInternal(row, true);
  }

  getFoldRangeForRowInternal(row, demandQuery) {
    if (!this.tokenized || this.publicationPending) {
      return null;
    }

    let rowEnd = this.buffer.lineLengthForRow(row);
    let point = new Point(row, rowEnd);
    let layers = this.languageLayersAtPoint(point);
    if (demandQuery) this.ensureQueriesForLayersSync("foldsQuery", layers);

    let leadingCandidate = null;
    // Multiple language layers may want to claim a fold for a given row.
    // Prefer deeper layers over shallower ones.
    for (let layer of layers) {
      let { depth } = layer;
      let candidateFold = layer.foldResolver?.getFoldRangeForRow(row);
      if (!candidateFold) {
        continue;
      }
      if (!leadingCandidate || depth > leadingCandidate.depth) {
        leadingCandidate = { fold: candidateFold, depth };
      }
    }

    return leadingCandidate?.fold ?? null;
  }

  /*
  Section - Comments
  */

  // Returns the correct comment delimiters for the given buffer position. This
  // may be defined on the grammar itself, but it can also be defined as a
  // scope-specific setting for scenarios where a language has different
  // comment delimiters for different contexts.
  //
  // Returns `commentStartString` and (sometimes) `commentEndString`
  // properties. If only the former is a `String`, then “Toggle Line Comments”
  // will insert a line comment; if both are `Strings`, it'll insert a block
  // comment.
  //
  // NOTE: This method also returns a `commentDelimiters` property with
  // metadata about the comment delimiters at the given position. Since the
  // main purpose of this method, historically, has been to determine which
  // delimiter(s) to use for the “Toggle Line Comment” command, we adjust the
  // position we're given to cover the first non-whitespace content on the line
  // for more accurate results. But `commentDelimiters` contains unadjusted
  // data wherever possible because we don't make assumptions about how the
  // caller will use the data.
  //
  // This might produce surprising results sometimes — like `commentDelimiters`
  // containing delimiters from a different language than the delimiters in the
  // other returned properties. But that's OK. Consumers of this function will
  // know why those properties disagree and which one they're most interested
  // in, and it still makes sense for these different use cases to share code.
  //
  // TODO: When toggling comments on a line or buffer range, our understanding
  // of the correct delimiters for a given buffer position is only as granular
  // as the entire buffer row. This can bite us in edge cases like JSX. It's
  // the right decision if the user toggles a comment with an empty selection,
  // but if specific buffer text is selected, we should look up the right
  // delimiters for that specific range. This will require a new branch in the
  // “Editor: Toggle Line Comments” command.
  commentStringsForPosition(position) {
    const range = this.firstNonWhitespaceRange(position.row) || new Range(position, position);

    // Ask the config system if it has a setting for this scope. This allows
    // for overrides from the grammar default.
    const scope = this.scopeDescriptorForPosition(range.start);
    const commentStartEntries = this.config.getAll("editor.commentStart", { scope });
    const commentEndEntries = this.config.getAll("editor.commentEnd", { scope });

    // If a `commentDelimiters` setting exists, attach it to the return object.
    // This can contain more comprehensive delimiter metadata for snippets and
    // other purposes.
    //
    // This is just general metadata. We don't know the user's intended use
    // case. So we should look up the scope descriptor of the _original_
    // position, not the one at the beginning of the line.
    const originalScope = this.scopeDescriptorForPosition(position);
    const commentDelimiters = getDelimitersForScope(originalScope);

    // The two config entries are separate, but if they're paired, then we need
    // to make sure we're reading them from the same layer. Otherwise we could
    // wind up with, say, `<!--` and `*/` as “paired” delimiters.
    const commentStartEntry = commentStartEntries.find((entry) => !!entry);
    const commentEndEntry = commentEndEntries.find((entry) => {
      return entry.scopeSelector === commentStartEntry?.scopeSelector;
    });

    if (commentStartEntry) {
      return {
        commentStartString: commentStartEntry && commentStartEntry.value,
        commentEndString: commentEndEntry && commentEndEntry.value,
        commentDelimiters: commentDelimiters,
      };
    } else {
      // If we have only comment delimiter data, rather than the legacy
      // `comment(Start|End)` settings, we can still construct the expected
      // output.
      let adjustedDelimiters = getDelimitersForScope(scope);
      if (adjustedDelimiters) {
        let result = commentStringsFromDelimiters(adjustedDelimiters);
        if (commentDelimiters) {
          result.commentDelimiters = commentDelimiters;
        }
        return result;
      }
    }

    // Fall back to looking up this information on the grammar. (This is better
    // than just returning `commentDelimiters` data because we still want to
    // take the adjusted range into account if we can.)
    const { grammar } = this.getSyntaxNodeAndGrammarContainingRange(range);
    const { grammar: originalPositionGrammar } = this.getSyntaxNodeAndGrammarContainingRange(
      new Range(position, position),
    );

    if (grammar && grammar.getCommentDelimiters) {
      let delimiters = grammar.getCommentDelimiters();
      let result = commentStringsFromDelimiters(delimiters);
      if (originalPositionGrammar !== grammar) {
        let originalPositionDelimiters = originalPositionGrammar.getCommentDelimiters();
        result = {
          ...result,
          commentDelimiters: originalPositionDelimiters,
        };
      }
      return result;
    } else if (commentDelimiters) {
      // This is an unusual case, and it's the one case that doesn't take into
      // account the difference between the original position and our adjusted
      // position — which is why we've tried other techniques first. But it's
      // better than nothing!
      return commentStringsFromDelimiters(commentDelimiters);
    }
    return {
      commentStartString: undefined,
      commentEndString: undefined,
      commentDelimiters: { line: undefined, block: undefined },
    };
  }

  isRowCommented(row) {
    const range = this.firstNonWhitespaceRange(row);
    if (range) {
      let descriptor = this.scopeDescriptorForPosition(range.start);
      return descriptor.getScopesArray().some((scope) => COMMENT_MATCHER(scope));
    }
    return false;
  }

  /*
  Section - auto-indent
  */

  indentLevelForLine(line, tabLength) {
    let indentLength = 0;
    for (let i = 0, { length } = line; i < length; i++) {
      const char = line[i];
      if (char === "\t") {
        indentLength += tabLength - (indentLength % tabLength);
      } else if (char === " ") {
        indentLength++;
      } else {
        break;
      }
    }
    return indentLength / tabLength;
  }

  recordSynchronousUpdate(duration) {
    this.slowSynchronousUpdates =
      duration > SLOW_SYNCHRONOUS_UPDATE_MS ? (this.slowSynchronousUpdates ?? 0) + 1 : 0;
    if (this.slowSynchronousUpdates >= 2) this.deferLargeBufferUpdates = true;
  }

  // One cold call or GC interruption must not change ordinary editing policy.
  // Slow large grammars use the existing revision-checked async publication
  // and indentation paths. Small buffers always retain synchronous updates.
  shouldParseSynchronously() {
    return (
      !this.useAsyncParsing ||
      (this.synchronousUpdates &&
        !(this.deferLargeBufferUpdates && this.buffer.getLength() >= LARGE_BUFFER_ASYNC_THRESHOLD))
    );
  }

  shouldUseAsyncIndent() {
    return !this.shouldParseSynchronously() && this.useAsyncIndent;
  }

  /**
   * @public
   * @status essential
   *
   * Get the suggested indentation level for an existing line in the
   * buffer.
   *
   * * `bufferRow` A `Number` indicating the buffer row.
   * * `tabLength` A `Number` signifying the length of a tab, in spaces,
   *   according to the current settings of the buffer.
   * * `options` An optional `Object` with the following properties, all of
   *   which are themselves optional:
   *   * `options.skipBlankLines`: `Boolean` indicating whether to ignore blank
   *     lines when determining which row to use as a reference row. Default is
   *     `true`. Irrelevant if `options.comparisonRow` is specified.
   *   * `options.skipDedentCheck`: `Boolean` indicating whether to skip the
   *     second phase of the check and determine only if the current row should
   *     _start out_ indented from the reference row.
   *   * `options.preserveLeadingWhitespace`: `Boolean` indicating whether to
   *     adjust the returned number to account for the indentation level of any
   *     whitespace that may already be on the row. Defaults to `false`.
   *   * `options.forceTreeParse`: `Boolean` indicating whether to force this
   *     method to synchronously parse the buffer into a tree, even if it
   *     otherwise would not. Defaults to `false`.
   *   * `options.comparisonRow`: A `Number` specifying the row to use as a
   *     reference row. Must be a valid row that occurs earlier in the buffer
   *     than `row`. If omitted, this method will determine the reference row
   *     on its own.
   *
   *
   * This method will return a synchronous result if (a) the tree is clean, (b)
   * the language mode decides it can afford to do a synchronous re-parse of
   * the buffer, or (c) `options.forceTreeParse` is `true`. Otherwise, this
   * method will wait until the end of the current buffer transaction. If this
   * method synchronously returns `null`, it means that this method cannot make
   * a suggestion.
   *
   * When acting asynchronously, this method may or may not be able to give an
   * answer. If it can, it will return a `Promise` that resolves with a
   * `Number` signifying the suggested indentation level. If it can't — because
   * it thinks the content has been altered too much for it to make a
   * suggestion — it will return a `Promise` that resolves with `undefined`,
   * signalling that a fallback style of indentation adjustment should take
   * place.
   *
   * @returns {Number}, `null`, or a `Promise` that will resolve with either a `Number` or `undefined`.
   */
  suggestedIndentForBufferRow(...args) {
    this.ensureQueriesForLayersSync("indentsQuery");
    const result = this.indentResolver.suggestedIndentForBufferRow(...args);
    // A newline burst can supersede every individual revision-bound hint.
    // Keep the transaction-level correction alive so it plans all affected
    // rows together once the latest syntax has settled.
    if (result?.then) this.autoIndentRequests++;
    return result;
  }

  // Given a range of buffer rows, retrieves the suggested indent for each one
  // while re-using the same tree. Computing these results in bulk may prevent
  // a tree re-parse after each individual line adjustment when auto-indenting
  // multiple rows at once.
  //
  // * `startRow` The row `Number` to start at.
  // * `endRow` The row `Number` to end at.
  //
  // Returns either a `Map` or `null`. If a `Map`, its keys will be row numbers
  // and its values will be desired indentation levels, or null to explicitly
  // preserve a row's whitespace. Missing rows request fallback. May not return the
  // entire range of requested rows, in which case the caller should
  // auto-indent the remaining rows through another means. If `null`, signifies
  // that no auto-indent should be attempted at all for the given range.
  suggestedIndentForBufferRows(...args) {
    this.ensureQueriesForLayersSync("indentsQuery");
    return this.indentResolver.suggestedIndentForBufferRows(...args);
  }

  suggestedIndentForBufferRowsAtRows(rows, tabLength, options = {}) {
    this.ensureQueriesForLayersSync("indentsQuery");
    const results = this.indentResolver.suggestedIndentForBufferRows(
      rows[0],
      rows[rows.length - 1],
      tabLength,
      { ...options, rows },
    );
    if (!results) return results;
    for (const row of rows) {
      if (results.has(row)) continue;
      const indent = this.indentResolver.suggestedIndentForBufferRow(row, tabLength, options);
      if (typeof indent === "number") results.set(row, indent);
    }
    return results;
  }

  // Get the suggested indentation level for a line in the buffer on which the
  // user is currently typing. This may return a different result from
  // {@link #suggestedIndentForBufferRow} in order to avoid unexpected changes in
  // indentation. It may also return undefined if no change should be made.
  //
  // * row - The row `Number`
  //
  // Returns a `Number`.
  suggestedIndentForEditedBufferRow(...args) {
    this.ensureQueriesForLayersSync("indentsQuery");
    return this.indentResolver.suggestedIndentForEditedBufferRow(...args);
  }

  // Get the suggested indentation level for a given line of text, if it were
  // inserted at the given row in the buffer.
  //
  // * bufferRow - A `Number` indicating the buffer row
  //
  // Returns a `Number`.
  suggestedIndentForLineAtBufferRow(row, _line, tabLength) {
    // We can't answer this question accurately for text that isn't yet in the
    // tree, so instead we'll just note that this request was made and try to
    // correct indentation when the transaction is over.
    this.autoIndentRequests++;
    return this.suggestedIndentForBufferRow(row, tabLength);
  }

  // Private

  getAllInjectionLayers() {
    let markers = this.injectionsMarkerLayer.getMarkers();
    return markers.map((m) => m.languageLayer);
  }

  getAllLanguageLayers(where = null) {
    let layers = [this.rootLanguageLayer, ...this.getAllInjectionLayers()];
    if (!where) return layers;

    let results = [];
    for (let layer of layers) {
      if (!where(layer)) continue;
      results.push(layer);
    }

    return results;
  }

  ensureQueriesForLayersSync(queryType, layers = this.getAllLanguageLayers()) {
    for (const layer of layers) {
      if (layer?.ready && layer.tree) layer.ensureQuerySync(queryType);
    }
  }

  hasQuery(queryType) {
    const declaresQuery = (grammar) => {
      return typeof grammar?.[queryType] === "string" || Boolean(grammar?.queryPaths?.[queryType]);
    };
    if (declaresQuery(this.grammar)) return true;
    return this.getAllLanguageLayers((layer) => declaresQuery(layer?.grammar)).length > 0;
  }

  async getQueryCaptureGroups(queryType, { signal } = {}) {
    let layers;
    while (true) {
      const transaction = await this.atGrammarSettlement();
      if (this.destroyed || signal?.aborted || transaction.parseError) return [];

      // Promise continuations run in their own microtask. Topology work may
      // have been scheduled after the settlement's final scan but before this
      // continuation, so take one last synchronous snapshot. Once it contains
      // no pending work, captures below run in the same stack and therefore
      // describe exactly this layer set.
      layers = this.getAllLanguageLayers();
      await Promise.all(layers.map((layer) => layer?.ensureQuery?.(queryType)));
      if (this.destroyed || signal?.aborted) return [];
      const currentLayers = this.getAllLanguageLayers();
      if (
        layers.length !== currentLayers.length ||
        layers.some((layer, index) => layer !== currentLayers[index])
      )
        continue;
      const hasPendingWork = layers.some(
        (layer) =>
          layer?.queryReloadPromise?.then ||
          layer?.injectionPopulationDrainPromise?.then ||
          layer?.queryLoadPromises?.size,
      );
      if (!this.resolveNextTransaction && !hasPendingWork) {
        if (this.lastTransactionParseError) return [];
        break;
      }
    }

    const snapshots = layers.map((layer) => ({
      layer,
      tree: layer?.tree,
      query: layer?.queries?.[queryType],
      injectionPointVersion: layer?.injectionPointVersion,
    }));
    const isCurrent = () => this.queryCaptureSnapshotIsCurrent(snapshots, queryType, signal);
    const groups = [];
    for (const { layer, tree, query } of snapshots) {
      if (!query || !tree) continue;
      const extent = layer.getExtent();
      const resolvedCaptures = [];
      // Highlight and fold requests also use the layer's resolver while this
      // scan yields. Give the scan its own state so capture.final and capture.shy
      // continue to apply across the complete, ordered stream.
      layer.scopeResolver.reset();
      const scopeResolver = new ScopeResolver(layer, layer.scopeResolver.idForScope);
      try {
        const chunkRows = Math.max(1, this.queryCaptureChunkRows);
        const chunkCodeUnits = Math.max(1, this.queryCaptureChunkCodeUnits);
        const endIndex = this.buffer.characterIndexForPosition(extent.end);
        let start = extent.start;
        let startIndex = this.buffer.characterIndexForPosition(start);
        let firstChunk = true;

        do {
          if (!isCurrent()) return [];
          const endRow = Math.min(extent.end.row, start.row + chunkRows);
          const rowEnd = endRow === extent.end.row ? extent.end : new Point(endRow, 0);
          const rowEndIndex = this.buffer.characterIndexForPosition(rowEnd);
          const chunkEndIndex = Math.min(endIndex, startIndex + chunkCodeUnits, rowEndIndex);
          const end =
            chunkEndIndex === endIndex
              ? extent.end
              : this.buffer.positionForCharacterIndex(chunkEndIndex);
          const captures = query.captures(tree.rootNode, {
            startPosition: start,
            endPosition: end,
          });

          for (const capture of captures) {
            // Range queries also return captures enclosing the window. Their
            // original starting position owns them: later windows skip them,
            // while genuine duplicate captures within that first window stay
            // intact and in the order supplied by Tree-sitter.
            if (!firstChunk && comparePoints(capture.node.startPosition, start) < 0) continue;
            if (chunkEndIndex < endIndex && comparePoints(capture.node.startPosition, end) >= 0)
              continue;
            if (scopeResolver.store(capture, { boundaries: false })) {
              resolvedCaptures.push(capture);
            }
          }

          if (chunkEndIndex >= endIndex) break;
          start = end;
          startIndex = chunkEndIndex;
          firstChunk = false;
          await this._yieldForQueryCaptureScan();
        } while (true);
      } finally {
        scopeResolver.destroy();
      }
      groups.push({ grammar: layer.grammar, captures: resolvedCaptures });
    }
    if (!isCurrent()) return [];
    return groups;
  }

  queryCaptureSnapshotIsCurrent(snapshots, queryType, signal) {
    if (this.destroyed || signal?.aborted || this.resolveNextTransaction) return false;
    for (const { layer, tree, query, injectionPointVersion } of snapshots) {
      if (
        layer?.destroyed ||
        layer?.tree !== tree ||
        layer?.queries?.[queryType] !== query ||
        layer?.injectionPointVersion !== injectionPointVersion ||
        layer?.queryReloadPromise ||
        layer?.injectionPopulationDrainPromise ||
        tree?.revision !== this.buffer.getTextRevision()
      ) {
        return false;
      }
    }
    const layers = this.getAllLanguageLayers();
    return (
      layers.length === snapshots.length && layers.every((layer, i) => layer === snapshots[i].layer)
    );
  }

  /**
   * @public
   * @status extended
   *
   * Re-compiles every query of every grammar in use in this buffer —
   * the root grammar plus any injected grammars — from its current source and
   * reports an error notification for each query that fails to compile.
   *
   * Compilation is done freshly rather than through the query cache, so this
   * validates edits made to query files after the grammar first loaded.
   *
   * @returns {Array} of failure descriptors (see {@link TreeSitterGrammar#describeQueryError}); the array is empty when every query compiled.
   */
  validateGrammarQueries() {
    const queryTypes = [
      "highlightsQuery",
      "injectionsQuery",
      "foldsQuery",
      "indentsQuery",
      "localsQuery",
      "tagsQuery",
      "parseBoundariesQuery",
    ];
    let failures = [];
    let grammars = new Set();
    for (let layer of this.getAllLanguageLayers()) {
      if (layer?.grammar) grammars.add(layer.grammar);
    }

    let validatedCount = 0;
    for (let grammar of grammars) {
      // A grammar whose language hasn't loaded yet can't compile anything
      // synchronously; skip it rather than misreport it as broken.
      if (!grammar.getLanguageSync()) continue;
      for (let queryType of queryTypes) {
        let source = grammar[queryType];
        if (typeof source !== "string") continue;
        try {
          grammar._createGrammarQuery(grammar.getLanguageSync(), queryType);
          // Native query ownership follows JavaScript references.
          validatedCount++;
        } catch (error) {
          let descriptor = error.queryDescriptor ?? grammar.describeQueryError(error, queryType);
          failures.push(descriptor);
          lumine.notifications.addError(`Tree-sitter query error in ${grammar.scopeName}`, {
            detail: grammar.constructor.formatQueryErrorDescriptor(descriptor),
            dismissable: true,
          });
        }
      }
    }

    if (failures.length === 0) {
      lumine.notifications.addSuccess(
        `All Tree-sitter queries compiled (${grammars.size} grammar${grammars.size === 1 ? "" : "s"}, ${validatedCount} quer${validatedCount === 1 ? "y" : "ies"})`,
      );
    }
    return failures;
  }

  // Given a {@link Point}, returns all injection `LanguageLayers` that include that
  // point. Does not include the root language layer.
  //
  // A `LanguageLayer` can have multiple content ranges. Its “extent” is a
  // single contiguous {@link Range} that includes all of its content ranges. To
  // return only layers with a content range that spans the given point, pass
  // `{ exact: true }` as the second argument.
  // Layers with the same extent are ordered from deepest to shallowest.
  //
  // * point - A {@link Point} representing a buffer position.
  // * options - An `Object` containing these keys:
  //   * exact - `Boolean` that, when `true`, checks for containment within the
  //     layer's _content ranges_ instead of its _extent_ (see description
  //     above).
  injectionLayersAtPoint(point, { exact = false } = {}) {
    let injectionMarkers = this.injectionsMarkerLayer.findMarkers({
      containsPosition: point,
    });

    injectionMarkers.sort((a, b) => {
      return a.getRange().compare(b.getRange()) || b.languageLayer.depth - a.languageLayer.depth;
    });

    let results = injectionMarkers.map((m) => m.languageLayer);

    if (exact) {
      results = results.filter((l) => l.containsPoint(point));
    }
    return results;
  }

  // Given a {@link Point}, returns all `LanguageLayers` that include that point,
  // including the root language layer.
  //
  // A `LanguageLayer` can have multiple content ranges. Its “extent” is a
  // single contiguous {@link Range} that includes all of its content ranges. To
  // return only layers with a content range that spans the given point, pass
  // `{ exact: true }` as the second argument.
  //
  // * point - A {@link Point} representing a buffer position.
  // * options - An `Object` containing these keys: * exact - `Boolean` that,
  //   when `true`, checks for containment within the layer's _content ranges_
  //   instead of its _extent_ (see description above).
  languageLayersAtPoint(point, { exact = false } = {}) {
    let injectionLayers = this.injectionLayersAtPoint(point, { exact });
    if (
      (exact || this.rootLanguageLayer?.rootRangesRestricted) &&
      !this.rootLanguageLayer?.containsPoint(point)
    )
      return injectionLayers;
    return [this.rootLanguageLayer, ...injectionLayers];
  }

  // Returns the deepest language layer at a given point, or optionally the
  // deepest layer to fulfill a criterion.
  //
  // Will ignore any layer whose content ranges do not include the point, even if
  // the point is within its extent.
  controllingLayerAtPoint(point, where = FUNCTION_TRUE) {
    let layers = this.languageLayersAtPoint(point, { exact: true });

    // Deeper layers go first.
    layers.sort((a, b) => b.depth - a.depth);
    return layers.find((layer) => where(layer)) ?? null;
  }

  firstNonWhitespaceRange(row) {
    return this.buffer.findInRangeSync(
      /\S/,
      new Range(new Point(row, 0), new Point(row, Infinity)),
    );
  }

  // If you want to analyze the content at a point, prefer inspecting the syntax
  // tree or running queries against it.
  tokenForPosition(point) {
    if (Array.isArray(point)) {
      point = new Point(...point);
    }
    const scopes = this.scopeDescriptorForPosition(point).getScopesArray();
    let range = this.bufferRangeForScopeAtPosition(last(scopes), point);
    return new Token({
      scopes,
      value: this.buffer.getTextInRange(range),
    });
  }
}

class NullLanguageModeHighlightIterator {
  seek() {
    return [];
  }
  compare() {
    return 1;
  }
  moveToSuccessor() {}
  getPosition() {
    return Point.INFINITY;
  }
  getOpenScopeIds() {
    return [];
  }
  getCloseScopeIds() {
    return [];
  }
}

class NullLayerHighlightIterator {
  constructor(languageLayer) {
    this.languageLayer = languageLayer;
    this.name = languageLayer.grammar.scopeName;
    this.depth = languageLayer.depth;
    this.coverShallowerScopes = false;
  }

  seek() {
    return [false, new OpenScopeMap()];
  }
  compare() {
    return 1;
  }
  moveToSuccessor() {}
  getPosition() {
    return Point.INFINITY;
  }
  getOpenScopeIds() {
    return [];
  }
  getCloseScopeIds() {
    return [];
  }
}

// Highlight boundaries arrive from ScopeResolver in document order and are
// consumed sequentially. A persistent red-black tree used to clone O(log n)
// nodes for every insertion even though this path never mutates or performs a
// random lookup after construction.
class SortedBoundaryList {
  constructor() {
    this.entries = [];
  }

  add(key, value) {
    this.entries.push({ key, value });
  }

  get begin() {
    return new SortedBoundaryIterator(this.entries);
  }
}

class SortedBoundaryIterator {
  constructor(entries) {
    this.entries = entries;
    this.index = 0;
  }

  get key() {
    return this.entries[this.index]?.key;
  }

  get value() {
    return this.entries[this.index]?.value;
  }

  get hasNext() {
    return this.index + 1 < this.entries.length;
  }

  next() {
    this.index++;
  }

  prev() {
    this.index--;
  }
}

// An iterator for marking boundaries in the buffer to apply syntax
// highlighting.
//
// Manages a collection of `LayerHighlightIterators`, which are the classes
// doing the real work of marking boundaries. `HighlightIterator` is in charge
// of understanding, at any given point, which of the iterators needs to be
// advanced next.
class HighlightIterator {
  constructor(languageMode) {
    this.languageMode = languageMode;
    this.iterators = null;
  }

  seek(start, endRow) {
    if (!(start instanceof Point)) {
      start = Point.fromObject(start, true);
    }
    let { buffer, rootLanguageLayer } = this.languageMode;
    if (!rootLanguageLayer) {
      return [];
    }

    if (endRow == null) {
      // If `endRow` isn’t specified, assume the caller wants to go to the
      // end of the buffer. This is why `endRow` defaults to `Infinity`. It
      // will get clipped to the end of the buffer or the end of the language
      // layer as appropriate.
      //
      // This can theoretically get very costly — but it'd be the consumer's
      // fault for using a private API and not doing its own chunking.
      endRow = buffer.getEndPosition().row;
    }

    let end = {
      row: endRow,
      column: buffer.lineLengthForRow(endRow),
    };

    this.end = end;
    this.iterators = [];

    if (Math.max(start.column, end.column) > LINE_LENGTH_LIMIT_FOR_HIGHLIGHTING) {
      return [];
    }

    let injectionMarkers = this.languageMode.injectionsMarkerLayer.findMarkers({
      intersectsRange: new Range(start, new Point(endRow + 1, 0)),
    });

    injectionMarkers.sort((a, b) => {
      // Shallower injections get visited first.
      return a.languageLayer.depth - b.languageLayer.depth;
    });

    const iterator = rootLanguageLayer.buildHighlightIterator();

    // We need to know which open scopes were contributed by which language
    // layer so that we know which ones to “cover” if we see an injection with
    // the `coverShallowerScopes` option.
    //
    // What's worse is that we need to know _where_ each of those open scopes
    // would've been added, because that open scope shouldn't truly be added
    // _if_ it would've been suppressed by a deeper layer.
    let openScopesByLayer = new Map();

    // The contract of `LayerHighlightIterator#seek` is different from the
    // contract of `HighlightIterator#seek`. Instead of an array of open
    // scopes, we have it return a two-item array.
    //
    // The first item is a boolean that indicates whether the iterator needs to
    // mark anything _within_ the range that will be highlighted. If not, it
    // doesn't need to go into the list of iterators.
    //
    // The second item is an `OpenScopeMap` (rather than just an array of
    // already open scopes) that retains information about where each open
    // scope was opened, because we'll need that information in a moment.
    //
    let [result, openScopes] = iterator.seek(start, endRow);

    if (rootLanguageLayer?.tree?.rootNode.hasChanges) {
      // The tree is dirty. We should keep going — if we stop now, then the
      // user will see a flash of unhighlighted text over this whole range. But
      // we should also schedule a re-highlight at the end of the transaction,
      // once the tree will be clean again.
      let range = new Range(start, iterator._getEndPosition(endRow));
      this.languageMode.scheduleDirtyHighlightUpdate(range);
    }

    // An iterator can contribute to the list of already open scopes even if it
    // has no boundaries to mark within the range of this highlighting job.
    openScopesByLayer.set(iterator, openScopes);

    if (result) {
      this.iterators.push(iterator);
    }

    // The logic that we use for `coverShallowerScopes` needs to be respected
    // here. As we build these iterators, if we find that any of them cover
    // their parent iterator at this position, we need to revisit the list of
    // open scopes, removing any that aren't their layer's base language scope.
    for (const marker of injectionMarkers) {
      const iterator = marker.languageLayer.buildHighlightIterator();
      let [result, openScopes] = iterator.seek(start, endRow);

      // Just as with the root layer, any injection layer may need to add to
      // the list of open scopes whether or not they need to mark anything
      // within this range.
      if (result) {
        this.iterators.push(iterator);
      }

      if (iterator.coverShallowerScopes) {
        // The procedure we follow for covering scopes in the _middle_ of a
        // highlighting task needs to be emulated when deciding which scopes
        // are already open at the _start_ of the task. This layer wants to
        // cover shallower scopes, so we need to re-assess our list of already
        // open scopes to see if any of them _would've_ been covered at the
        // point when they were opened.
        for (let [earlierIterator, earlierOpenScopes] of openScopesByLayer) {
          // It's possible, though uncommon, for injections to overlap, because
          // there's no mechanism that prevents it. Since we sorted the layers
          // by depth earlier, this iterator won't have a lower depth than the
          // previous one. But it may have _the same_ depth, so we need to
          // account for that.
          if (earlierIterator.depth >= iterator.depth) {
            continue;
          }

          // For each of the open scopes that an earlier iterator gave us, we
          // need to look at the point at which that scope would've been added.
          // If that point falls within the purview of our newer iterator, then
          // we should suppress that scope unless it's the layer's base
          // language scope.
          let languageScopeId = earlierIterator.languageLayer.languageScopeId;
          for (let [point, scopes] of earlierOpenScopes) {
            const coverage = iterator.coversIteratorAtPosition(earlierIterator, point);
            // These scopes opened at this point. An injection ending here can
            // cover closing boundaries, but must preserve these openings.
            if (coverage !== true && coverage !== "open") {
              continue;
            }
            earlierOpenScopes.set(
              point,
              scopes.filter((id) => id === languageScopeId),
            );
          }
        }
      }
      openScopesByLayer.set(iterator, openScopes);
    }

    // Sort the iterators so that the last one in the array is the earliest
    // in the document, and represents the current position.
    this.iterators.sort((a, b) => b.compare(a));

    this.detectCoveredScope();

    // Our nightmare is almost over, but one chore remains. The ordering of
    // already open scopes should be consistent; scopes added earlier in the
    // buffer should appear in the list before scopes added later. This ensures
    // that, e.g., `scopeDescriptorForPosition` returns scopes in the proper
    // hierarchy.
    let sortedOpenScopes = [];

    // First we'll gather all the point/scope-list pairs into a flat list…
    let unsortedScopeBundles = [];
    for (let [iterator, layerOpenScopeMap] of openScopesByLayer) {
      for (let [point, scopes] of layerOpenScopeMap) {
        unsortedScopeBundles.push({ point, scopes, iterator });
      }
    }

    // …then sort them by buffer position, with shallower layers first in case
    // of ties.
    unsortedScopeBundles.sort(
      (a, b) => a.point.compare(b.point) || a.iterator.depth - b.iterator.depth,
    );

    // Now we can flatten all the scopes themselves, preserving order.
    for (let { scopes } of unsortedScopeBundles) {
      sortedOpenScopes.push(...scopes);
    }

    return sortedOpenScopes;
  }

  moveToSuccessor() {
    // `this.iterators` is _always_ sorted from farthest position to nearest
    // position, so the last item in the collection is always the next one to
    // act.
    let leader = last(this.iterators);
    if (!leader) {
      return;
    }

    if (leader.moveToSuccessor()) {
      // It was able to move to a successor, so now we have to "file" it into
      // the right place in `this.iterators` so that the sorting is correct.
      const leaderIndex = this.iterators.length - 1;
      let i = leaderIndex;
      while (i > 0 && this.iterators[i - 1].compare(leader) < 0) {
        i--;
      }
      if (i < leaderIndex) {
        this.iterators.splice(i, 0, this.iterators.pop());
      }
    } else {
      // It was not able to move to a successor, so it must be done. Remove it
      // from the collection.
      this.iterators.pop();
    }

    this.detectCoveredScope();
  }

  getPosition() {
    let iterator = last(this.iterators || []);
    if (iterator) {
      // this.logPosition();
      return iterator.getPosition();
    } else {
      return Point.INFINITY;
    }
  }

  getCloseScopeIds() {
    let iterator = last(this.iterators);
    // if (this.currentIteratorIsCovered === true || this.currentIteratorIsCovered === 'close') {
    //   console.log(
    //     iterator.name,
    //     iterator.depth,
    //     'would close',
    //     iterator._inspectScopes(
    //       iterator.getCloseScopeIds()
    //     ),
    //     'at',
    //     iterator.getPosition().toString(),
    //     'but scope is covered!'
    //   );
    // } else {
    //   console.log(
    //     iterator.name,
    //     iterator.depth,
    //     'CLOSING',
    //     iterator.getPosition().toString(),
    //     iterator._inspectScopes(
    //       iterator.getCloseScopeIds()
    //     )
    //   );
    // }
    if (iterator) {
      // If this iterator is covered completely, or if it's covered in a
      // position that prevents us from closing scopes…
      if (this.currentIteratorIsCovered === true || this.currentIteratorIsCovered === "close") {
        // …then the only closing scope we're allowed to apply is one that ends
        // the base scope of an injection range.
        return iterator.getCloseScopeIds().filter((id) => {
          return iterator.languageLayer.languageScopeId === id;
        });
      } else {
        return iterator.getCloseScopeIds();
      }
    }
    return [];
  }

  getOpenScopeIds() {
    let iterator = last(this.iterators);
    // let ids = iterator.getOpenScopeIds();
    // if (this.currentIteratorIsCovered === true || this.currentIteratorIsCovered === 'open') {
    //   console.log(
    //     iterator.name,
    //     iterator.depth,
    //     'would open',
    //     iterator._inspectScopes(
    //       iterator.getOpenScopeIds()
    //     ),
    //     'at',
    //     iterator.getPosition().toString(),
    //     'but scope is covered!'
    //   );
    // } else {
    //   console.log(
    //     iterator.name,
    //     iterator.depth,
    //     'OPENING',
    //     iterator.getPosition().toString(),
    //     iterator._inspectScopes(
    //       iterator.getOpenScopeIds()
    //     )
    //   );
    // }
    if (iterator) {
      // If this iterator is covered completely, or if it's covered in a
      // position that prevents us from opening scopes…
      if (this.currentIteratorIsCovered === true || this.currentIteratorIsCovered === "open") {
        // …then the only opening scope we're allowed to apply is one that ends
        // the base scope of an injection range.
        return iterator.getOpenScopeIds().filter((id) => {
          return iterator.languageLayer.languageScopeId === id;
        });
      } else {
        return iterator.getOpenScopeIds();
      }
    }
    return [];
  }

  // Detect whether the iterator that's about to act has its scopes covered by
  // a different iterator asserting a `coverShallowerScopes` option.
  detectCoveredScope() {
    const layerCount = this.iterators.length;
    if (layerCount > 1) {
      const leader = this.iterators[layerCount - 1];
      const position = leader.getPosition();
      for (let i = 0; i < layerCount - 1; i++) {
        const iterator = this.iterators[i];
        if (!iterator.coverShallowerScopes || leader.depth >= iterator.depth) continue;
        const iteratorCovers = iterator.coversIteratorAtPosition(leader, position);
        if (iteratorCovers !== false) {
          this.currentIteratorIsCovered = iteratorCovers;
          return;
        }
      }
    }

    this.currentIteratorIsCovered = false;
  }

  logPosition() {
    let iterator = last(this.iterators);
    iterator?.logPosition();
  }
}

const EMPTY_SCOPES = Object.freeze([]);

// Iterates through everything that a `LanguageLayer` is responsible for,
// marking boundaries for scope insertion.
class LayerHighlightIterator {
  constructor(languageLayer) {
    this.languageLayer = languageLayer;
    this.name = languageLayer.grammar.scopeName;
    this.depth = languageLayer.depth;

    let { injectionPoint } = this.languageLayer;

    this.coverShallowerScopes = injectionPoint?.coverShallowerScopes ?? false;
  }

  // If this isn't the root language layer, we need to make sure this iterator
  // doesn't try to go past its marker boundary.
  _getEndPosition(endRow) {
    let { marker } = this.languageLayer;
    let { buffer } = this.languageLayer.languageMode;
    let naiveEndPoint = new Point(endRow, buffer.lineLengthForRow(endRow));

    if (marker) {
      return Point.min(marker.getRange().end, naiveEndPoint);
    } else {
      return buffer.clipPosition(naiveEndPoint);
    }
  }

  // TODO: This still doesn't make much sense, so I suppose it's good that
  // we've now made it an opt-in feature.
  //
  // The main problem with this logic is that it runs the risk of covering only
  // one half of a pair of boundaries. If a scope range from the root layer is
  // coterminous with a scope range from an injection layer, that's easy to
  // detect and handle; but what if the root layer's range starts at the same
  // point but ends later? We'd prevent the root layer from opening the scope
  // but not closing it.
  //
  // I still don't fully understand the use cases for `detectCoveredScope`,
  // though I assume there are at least a few. I am quite sure, however, that
  // if we want an injection layer to veto a shallower layer's scope, it ought
  // to happen in a way that either prevents _both_ boundaries or allows _both_
  // boundaries. I'm not sure how to pull that off at this point, though.
  //
  // https://github.com/atom/atom/pull/19556 has good discussion about the
  // impetus for this feature.
  coversIteratorAtPosition(iterator, position) {
    // When does a layer prevent another layer from applying scopes?

    // When the option is asserted…
    if (!this.coverShallowerScopes) {
      return false;
    }

    // …and this iterator is deeper than the other…
    if (iterator.depth >= this.depth) {
      return false;
    }

    // …and one of this iterator's content ranges actually includes this
    // position. (With caveats!)
    // A given layer's content ranges aren't allowed to overlap each other, so
    // a binary search can identify the only possible match.
    let overlappingRange = this.languageLayer.currentRangeContainingPoint(position);
    if (!overlappingRange) return false;

    // If the current position is right in the middle of an injection's
    // range, then it should cover all attempts to apply scopes. But what if
    // we're on one of its edges? Since closing scopes act before opening
    // scopes,
    //
    // * if this iterator _starts_ a range at position X, it doesn't get to
    //   prevent another iterator from _ending_ a scope at position X;
    // * if this iterator _ends_ a range at position X, it doesn't get to
    //   prevent another iterator from _starting_ a scope at position X.
    //
    // So at a given position, `currentIteratorIsCovered` can be `true` (all
    // scopes suppressed), `false` (none suppressed), `"close"` (only closing
    // scopes suppressed), or `"open"` (only opening scopes suppressed).
    if (overlappingRange.end.compare(position) === 0) {
      // We're at the right edge of the injection range. We want to prevent
      // iterators from closing scopes, but not from opening them.
      return "close";
    } else if (overlappingRange.start.compare(position) === 0) {
      // We're at the left edge of the injection range. We want to prevent
      // iterators from opening scopes, but not from closing them.
      return "open";
    } else {
      return true;
    }
  }

  seek(start, endRow) {
    let end = this._getEndPosition(endRow);
    // let isDevMode = lumine.window.isDevMode();

    // let timeKey;
    // if (isDevMode) {
    //   timeKey = `${this.name} getSyntaxBoundaries`;
    //   console.time(timeKey);
    // }
    let [boundaries, openScopes] = this.languageLayer.getSyntaxBoundaries(start, end);

    this.iterator = boundaries?.begin;
    if (!this.iterator?.key) {
      return [false, openScopes];
    }

    this.start = Point.fromObject(start, true);
    this.end = end;
    // if (isDevMode) { console.timeEnd(timeKey); }
    return [true, openScopes];
  }

  isAtInjectionBoundary() {
    let position = Point.fromObject(this.iterator.key.position);
    return position.isEqual(this.start) || position.isEqual(this.end);
  }

  _inspectScopes(ids) {
    if (Array.isArray(ids)) {
      return ids.map((id) => this._inspectScopes(id)).join(", ");
    }
    return this.languageLayer.languageMode.scopeNameForScopeId(ids);
  }

  getOpenScopeIds() {
    let { key, value } = this.iterator;
    return key.boundary === "end" ? EMPTY_SCOPES : value.scopeIds;
  }

  getCloseScopeIds() {
    let { key, value } = this.iterator;
    return key.boundary === "start" ? EMPTY_SCOPES : value.scopeIds;
  }

  opensScopes() {
    return this.iterator?.key?.boundary === "start";
  }

  closesScopes() {
    return this.iterator?.key?.boundary === "end";
  }

  getPosition() {
    return this.iterator?.key?.position ?? Point.INFINITY;
  }

  logPosition() {
    let pos = this.getPosition();
    let { key, value } = this.iterator;

    let { languageMode } = this.languageLayer;
    let verb = key.boundary === "end" ? "close" : "open";

    console.log(
      `[highlight] (${pos.row}, ${pos.column})`,
      verb,
      value.scopeIds.map((id) => languageMode.scopeNameForScopeId(id)),
      "next?",
      this.iterator.hasNext,
    );
  }

  compare(other) {
    // First, favor the one whose current position is earlier.
    const result = comparePoints(this.iterator.key.position, other.iterator.key.position);
    if (result !== 0) {
      return result;
    }

    // Failing that, favor iterators that need to close scopes over those that
    // don't.
    let ourBoundary = this.iterator.key.boundary;
    let theirBoundary = other.iterator.key.boundary;
    let bothClosing = ourBoundary === "end" && theirBoundary === "end";

    if (ourBoundary === "end" && !bothClosing) {
      return -1;
    } else if (theirBoundary === "end" && !bothClosing) {
      return 1;
    }

    if (bothClosing) {
      // When both iterators are closing scopes, the deeper layer should act
      // first.
      return other.languageLayer.depth - this.languageLayer.depth;
    } else {
      // When both iterators are opening scopes, the shallower layer should act
      // first.
      return this.languageLayer.depth - other.languageLayer.depth;
    }
  }

  moveToSuccessor() {
    if (!this.iterator.hasNext || this.done) {
      return false;
    }
    this.iterator.next();
    this.done = this.isDone();
    return true;
  }

  peekAtSuccessor() {
    if (!this.iterator.hasNext) {
      return null;
    }
    this.iterator.next();
    let key = this.iterator.key;
    this.iterator.prev();
    return key;
  }

  isDone() {
    if (!this.iterator.hasNext) {
      return true;
    }
    if (!this.end) {
      return false;
    }

    let next = this.peekAtSuccessor();
    return comparePoints(next.position, this.end) > 0;
  }
}

class GrammarLoadError extends Error {
  constructor(grammar, queryType, originalError = null) {
    super(
      `Grammar ${grammar.scopeName} failed to load its ${queryType}. Please fix this error or contact the maintainer.`,
    );
    this.name = "GrammarLoadError";
    this.queryType = queryType;
    this.originalError = originalError;
  }
}

// Manages all aspects of a given language's parsing duties over a given region
// of the buffer.
//
// The base `LanguageLayer` that's in charge of the entire buffer is the "root"
// `LanguageLayer`. Other `LanguageLayer`s are created when injections are
// required. Those injected languages may require injections themselves,
// meaning a layer could be of arbitrary depth.
//
// For example: a PHP file could inject an HTML grammar, which in turn injects
// a JavaScript grammar for `SCRIPT` blocks, which in turn injects a regex
// grammar for regular expressions.
//
// Thus, for many editor-related tasks that depend on the context of the
// cursor, we should figure out how many different `LanguageLayer`s are
// operating in that particular region, and either (a) compose their output or
// (b) choose the output of the most specific layer that meets our needs,
// depending on the task.
//
class LanguageLayer {
  constructor(marker, languageMode, grammar, depth, injectionPoint) {
    this.marker = marker;
    this.languageMode = languageMode;
    this.buffer = this.languageMode.buffer;
    this.grammar = grammar;
    this.grammarGeneration = grammar.queryLoadGeneration;
    this.depth = depth;
    this.injectionPoint = injectionPoint;
    this.rangeList = new TreeSitterRangeList();

    this.nodesToInvalidateOnChange = new TreeSitterInvalidationRanges();
    this.foldNodesToInvalidateOnChange = new TreeSitterInvalidationRanges();

    this.tree = null;
    this.lastSyntaxTree = null;

    this.subscriptions = new CompositeDisposable();

    this.injectionPointVersion = 0;
    this.injectionPopulationNeedsRetry = false;
    this.pendingInjectionPopulationRequests = [];
    this.injectionPopulationDrainPromise = null;
    this.pendingQueryReloadTypes = new Set();
    this.queryReloadPromise = null;
    this.queryLoadPromises = new Map();
    this.requestedQueryTypes = new Set();
    this.queryLoadFailures = new Map();
    this.queryRequestVersions = new Map();
    this.cancelAncillaryQueryLoad = null;
    this.currentRangesCache = undefined;
    this.lastIncludedRanges = null;
    this.includedRangesAreCurrent = false;
    this.rootRangesRestricted = false;
    this.rootRangePolicyNeedsUpdate = false;
    this.rootRangeSet = null;
    this.rootIncludedRanges = null;

    const handleInjectionPointChanges = () => {
      // When we add or remove injection points on this grammar, this language
      // layer must repopulate its injections.
      this.injectionPointVersion++;
      this._populateInjections(MAX_RANGE, null);
    };

    this.subscriptions.add(
      this.grammar.onDidAddInjectionPoint(handleInjectionPointChanges),
      this.grammar.onDidRemoveInjectionPoint(handleInjectionPointChanges),
    );

    this.currentRangesLayer = this.buffer.addMarkerLayer();
    this.ready = false;
    this.queries = {};

    // The markers that hold all the language layer children of this layer.
    this.childLayerMarkers = new Set();
    // Combined injections keep leaf discovery markers separate from their
    // shared parser's extent, so editing one member never widens discovery to
    // every other member of the document.
    this.combinedInjectionGroups = new Map();
    this.combinedInjectionMembersLayer = null;
    // All language strings that were given to us by injection points in the
    // past, but could not be matched to grammars.
    this.unrecognizedLanguageStrings = new Set();
    this.recognizedLanguageStrings = new Set();

    // A constructor can't go async, so all our async administrative tasks hang
    // off this promise. We can `await this.languageLoaded` later on.
    const finishInitialization = (loaded) => {
      if (!loaded || this.destroyed) return;
      // This used to be called only in dev mode. But there are other use cases
      // for dynamically reloading queries, so now we observer for changes in a
      // grammar's queries in all cases.
      //
      // The grammar itself, however, will still only watch the query files
      // themselves for changes if we're in dev mode.
      this.observeQueryChanges();

      this.tree = null;
      this.scopeResolver = new ScopeResolver(this, (name) => this.languageMode.idForScope(name));
      this.foldResolver = new FoldResolver(this.buffer, this);
      // Reusing a grammar must keep the warm path synchronous. Only a cold
      // compile is deferred; attaching the grammar's cached handle is cheap.
      for (const queryType of ANCILLARY_QUERY_TYPES) {
        const query = this.grammar.queryCache.get(queryType);
        if (query) this.adoptQuery(queryType, query);
      }

      // What should our language scope name be? Should we even have one?
      let languageScope;
      if (depth === 0) {
        languageScope = this.grammar.scopeName;
      } else {
        // Injections can control the base scope name of the grammar being
        // injected.
        languageScope = injectionPoint.languageScope;

        // The `languageScope` parameter can be a function. That means we won't
        // decide now; we'll decide later on a range-by-range basis.

        // Honor an explicit `null`, but fall back to the default scope name
        // otherwise.
        if (languageScope === undefined) {
          languageScope = this.grammar.scopeName;
        }
      }

      this.languageScope = languageScope;
      if (languageScope === null || typeof languageScope === "function") {
        // If `languageScope` is a function, we'll still often end up with a
        // `languageScopeId` (or several); we just won't be able to compute it
        // ahead of time.
        this.languageScopeId = null;
      } else {
        this.languageScopeId = this.languageMode.idForScope(languageScope);
      }
      this.ready = true;
    };
    const warmLanguage = this.grammar.getLanguageSync();
    if (
      this.languageMode.shouldParseSynchronously() &&
      warmLanguage &&
      this.grammar._queryFilesLoaded
    ) {
      this.language = warmLanguage;
      this.languageMode.registerGrammarForLanguage(warmLanguage, this.grammar);
      const queries = ["highlightsQuery", "injectionsQuery"];
      if (this.depth === 0 || this.grammar.queryPaths?.parseBoundariesInjections === true)
        queries.push("parseBoundariesQuery");
      for (const queryType of queries) {
        if (!grammar[queryType]) continue;
        this.requestedQueryTypes.add(queryType);
        try {
          this.queries[queryType] = grammar.getQuerySync(queryType);
        } catch (error) {
          grammar.reportQueryError(error, queryType);
        }
      }
      finishInitialization(true);
      this.languageLoaded = Promise.resolve(true);
      return;
    }
    this.languageLoaded = this.grammar
      .getLanguage()
      .then((language) => {
        if (this.destroyed) return false;
        this.language = language;
        this.languageMode.registerGrammarForLanguage(language, this.grammar);
        // All queries are optional. Regular expression language layers, for
        // instance, don't really have a need for any queries other than
        // `highlightsQuery`, and some kinds of layers don't even need
        // `highlightsQuery`.
        let queries = ["highlightsQuery", "injectionsQuery"];
        if (this.depth === 0 || this.grammar.queryPaths?.parseBoundariesInjections === true)
          queries.push("parseBoundariesQuery");
        let promises = [];
        let failures = [];

        for (let queryType of queries) {
          if (grammar[queryType]) {
            this.requestedQueryTypes.add(queryType);
            let promise = this.grammar
              .getQuery(queryType)
              .then((query) => {
                if (this.destroyed) return;
                this.queries[queryType] = query;
              })
              .catch((error) => {
                if (this.destroyed) return;
                if (error.name === "AbortError") {
                  this.destroy();
                  return;
                }
                // Collect every failure instead of letting `Promise.all`
                // reject on the first one; each broken query is reported
                // individually below, and the layer still activates.
                failures.push(new GrammarLoadError(grammar, queryType, error));
              });
            promises.push(promise);
          }
        }
        return Promise.all(promises).then(() => {
          if (this.destroyed) return false;
          for (let failure of failures) {
            grammar.reportQueryError(failure.originalError ?? failure, failure.queryType);
          }
          if (failures.some((failure) => failure.queryType === "highlightsQuery")) {
            // Recover by setting an empty `highlightsQuery` so that we don't
            // propagate errors.
            grammar.setQueryForTest("highlightsQuery", `; (placeholder)`);
          }
          return true;
        });
      })
      .then(finishInitialization)
      .catch((error) => {
        if (error.name === "AbortError") {
          this.destroy();
          return;
        }
        if (!this.destroyed) throw error;
      });
  }

  inspect() {
    let { scopeName } = this.grammar;
    return `[LanguageLayer ${scopeName || "(anonymous)"} depth=${this.depth} file=${this.buffer.getPath()}]`;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.parseAbort?.abort();
    this.backgroundTree = null;
    this.cancelAncillaryQueryLoad?.();
    this.cancelAncillaryQueryLoad = null;
    this.injectionPointVersion++;
    this.pendingInjectionPopulationRequests.length = 0;
    this.pendingQueryReloadTypes.clear();
    this.queryLoadPromises.clear();
    this.queryLoadFailures.clear();
    this.currentRangesCache = null;
    this.lastIncludedRanges = null;
    this.includedRangesAreCurrent = false;

    this.tree = null;
    this.lastSyntaxTree = null;

    this.marker?.parentLanguageLayer?.childLayerMarkers.delete(this.marker);
    this.marker?.destroy();
    this.currentRangesLayer?.destroy();
    this.combinedInjectionMembersLayer?.destroy();
    this.combinedInjectionGroups.clear();
    this.foldResolver?.reset();
    this.scopeResolver?.destroy();
    this.subscriptions.dispose();
    this.queries = {};

    const childLayerMarkers = [...this.childLayerMarkers];
    this.childLayerMarkers.clear();
    for (const marker of childLayerMarkers) {
      marker.languageLayer.destroy();
    }
  }

  // Start ancillary work only after this layer has published its first tree.
  scheduleAncillaryQueries() {
    if (
      this.destroyed ||
      this.cancelAncillaryQueryLoad ||
      this.grammar.queryLoadGeneration !== this.grammarGeneration ||
      this.grammar.getLanguageSync() !== this.language
    )
      return;
    const needsLoad = (type) =>
      typeof this.grammar[type] === "string" &&
      !this.queries[type] &&
      !this.queryLoadFailures.has(type);
    if (!ANCILLARY_QUERY_TYPES.some(needsLoad)) return;
    this.cancelAncillaryQueryLoad = this.languageMode.scheduleAfterHighlightPaint(() => {
      this.cancelAncillaryQueryLoad = null;
      if (this.destroyed || this.grammar.queryLoadGeneration !== this.grammarGeneration) return;
      const queryType = ANCILLARY_QUERY_TYPES.find(needsLoad);
      if (!queryType) return;
      // One compile per rendering opportunity also avoids combining two cold
      // compiles into a single long task. Demanded loads share this promise.
      this.ensureQuery(queryType).then(
        () => this.scheduleAncillaryQueries(),
        (error) => {
          if (!this.destroyed) {
            console.error(`Error loading deferred queries for ${this.grammar.scopeName}`, error);
          }
        },
      );
    });
  }

  ensureQuerySync(queryType) {
    if (this.destroyed || typeof this.grammar[queryType] !== "string") return null;
    this.requestedQueryTypes.add(queryType);
    if (this.queries[queryType]) return this.queries[queryType];
    const source = this.grammar[queryType];
    const generation = this.grammar.queryLoadGeneration;
    const failed = this.queryLoadFailures.get(queryType);
    if (failed?.source === source && failed.generation === generation) return null;
    if (this.grammar.getLanguageSync() !== this.language) return null;
    try {
      const query = this.grammar.getQuerySync(queryType);
      if (this.destroyed || generation !== this.grammar.queryLoadGeneration) return null;
      this.adoptQuery(queryType, query);
      this.queryLoadFailures.delete(queryType);
      return query;
    } catch (error) {
      if (error.name !== "AbortError" && generation === this.grammar.queryLoadGeneration) {
        this.queryLoadFailures.set(queryType, { source, generation });
        this.grammar.reportQueryError(error, queryType);
      }
      return null;
    }
  }

  adoptQuery(queryType, query) {
    const previous = this.queries[queryType];
    if (!query || query === previous) return;
    this.queries[queryType] = query;
    if (queryType === "foldsQuery" && this.tree) {
      this.foldResolver.reset();
      this.languageMode.emitRangeUpdate(this.getExtent());
    }
  }

  // Reload a query of a given type from the grammar.
  ensureQuery(queryType) {
    if (this.destroyed || typeof this.grammar[queryType] !== "string") {
      return Promise.resolve(null);
    }
    this.requestedQueryTypes.add(queryType);
    if (this.queries[queryType]) return Promise.resolve(this.queries[queryType]);
    const pending = this.queryLoadPromises.get(queryType);
    if (pending) return pending;
    const failed = this.queryLoadFailures.get(queryType);
    if (
      failed?.source === this.grammar[queryType] &&
      failed.generation === this.grammar.queryLoadGeneration
    ) {
      return Promise.resolve(null);
    }
    const promise = this.loadRequestedQuery(queryType).finally(() => {
      if (this.queryLoadPromises.get(queryType) === promise)
        this.queryLoadPromises.delete(queryType);
    });
    this.queryLoadPromises.set(queryType, promise);
    return promise;
  }

  async loadRequestedQuery(queryType) {
    while (!this.destroyed && typeof this.grammar[queryType] === "string") {
      const source = this.grammar[queryType];
      const generation = this.grammar.queryLoadGeneration;
      const version = this.queryRequestVersions.get(queryType);
      let query;
      try {
        query = await this.grammar.getQuery(queryType);
      } catch (error) {
        if (
          this.destroyed ||
          error.name === "AbortError" ||
          generation !== this.grammar.queryLoadGeneration
        )
          return null;
        if (
          source !== this.grammar[queryType] ||
          version !== this.queryRequestVersions.get(queryType)
        )
          continue;
        this.queryLoadFailures.set(queryType, { source, generation });
        this.grammar.reportQueryError(error, queryType);
        return null;
      }
      if (this.destroyed || generation !== this.grammar.queryLoadGeneration || !query) return null;
      if (
        source !== this.grammar[queryType] ||
        version !== this.queryRequestVersions.get(queryType)
      )
        continue;
      this.adoptQuery(queryType, query);
      this.queryLoadFailures.delete(queryType);
      return query;
    }
    return null;
  }

  async reloadGrammarQuery(queryType) {
    if (typeof this.grammar[queryType] !== "string") {
      return;
    }
    const query = await this.loadRequestedQuery(queryType);
    if (this.destroyed || !query) return;
    if (queryType === "injectionsQuery") {
      this.injectionPointVersion++;
      await this._populateInjections(MAX_RANGE, null);
      if (this.destroyed) return;
    }
    if (queryType === "foldsQuery") {
      this.foldResolver.reset();
    }

    // Force a re-highlight of this layer's entire region.
    let range = this.getExtent();
    this.nodesToInvalidateOnChange.clear();
    this.foldNodesToInvalidateOnChange.clear();
    this.languageMode.emitRangeUpdate(range);
  }

  // Observe the grammar for changes in queries.
  //
  // This won't happen very often. It can happen if a user edits a grammar’s
  // query files, but those edits are only monitored in dev mode.
  //
  // It can also happen if an installed package uses an API on
  // {@link TreeSitterGrammar} to modify a query after initial load.
  observeQueryChanges() {
    this.subscriptions.add(
      this.grammar.onDidChangeQuery(({ queryType }) => this.scheduleQueryReload(queryType)),
    );
  }

  scheduleQueryReload(queryType) {
    if (this.destroyed) return null;
    this.queryRequestVersions.set(queryType, (this.queryRequestVersions.get(queryType) ?? 0) + 1);
    this.queryLoadFailures.delete(queryType);
    if (OPTIONAL_QUERY_TYPES.has(queryType) && !this.requestedQueryTypes.has(queryType))
      return null;
    this.pendingQueryReloadTypes.add(queryType);
    if (this.queryReloadPromise) return this.queryReloadPromise;

    const reloadPromise = this.drainQueryReloads();
    this.queryReloadPromise = reloadPromise;
    reloadPromise.then(
      () => this.finishQueryReload(reloadPromise),
      (error) => {
        console.error(`Error reloading Tree-sitter queries for ${this.grammar.scopeName}`, error);
        this.finishQueryReload(reloadPromise);
      },
    );
    return reloadPromise;
  }

  async drainQueryReloads() {
    while (!this.destroyed && this.pendingQueryReloadTypes.size > 0) {
      const queryType = this.pendingQueryReloadTypes.values().next().value;
      this.pendingQueryReloadTypes.delete(queryType);
      await this.reloadGrammarQuery(queryType);
    }
  }

  finishQueryReload(reloadPromise) {
    if (this.queryReloadPromise !== reloadPromise) return;
    this.queryReloadPromise = null;
    if (!this.destroyed && this.pendingQueryReloadTypes.size > 0) {
      this.scheduleQueryReload(this.pendingQueryReloadTypes.values().next().value);
    }
    if (!this.destroyed) this.languageMode.publishCurrentLayers();
  }

  getExtent() {
    return this.marker?.getRange() ?? this.languageMode.buffer.getRange();
  }

  // Given a grammar, returns whether the grammar might be used for this
  // layer's current injection points.
  //
  // Optionally accepts a `Map` so that it can cache results across a large
  // number of calls.
  injectionPointsMatchGrammar(grammar, cache = null) {
    let matches = (lang, grammar, cache) => {
      if (cache && cache.has(lang)) {
        return cache.get(lang) === grammar;
      }
      let match = this.languageMode.grammarForLanguageString(lang);
      if (cache) {
        cache.set(lang, match);
      }
      return match === grammar;
    };

    // Would this grammar have been a candidate for injection _instead_ of a
    // grammar that handled one of our active injections?
    for (let { languageString: lang } of this.childLayerMarkers) {
      if (matches(lang, grammar, cache)) return true;
    }
    // Would this grammar have matched a language string that we were unable to
    // match to an injection on this layer previously?
    for (let lang of Array.from(this.unrecognizedLanguageStrings)) {
      if (matches(lang, grammar, cache)) return true;
    }
    // A static rule may recognize a grammar but reject its owner through the
    // target's content filter. Replacing that filter still needs rediscovery.
    for (const lang of this.recognizedLanguageStrings) {
      if (matches(lang, grammar, cache)) return true;
    }
    return false;
  }

  // Determine whether a newly added or changed grammar warrants a
  // reexamination of this layer's injections.
  updateInjectionsForGrammar(grammar, cache = null) {
    // Changes to both buffer contents and the grammar's injection points each
    // independently trigger re-evaluation of injections. This code path is
    // solely for deciding whether the presence of a specific new or altered
    // grammar has implications for our current injections.
    //
    // Since reworking _all_ our injections is costly, we try to avoid it. If
    // we can demonstrate that this grammar would not be used even if we _did_
    // rebuild all injections on this layer from scratch, then we'll have
    // proven that this step can be skipped.
    // An in-flight plan has not published its recognized or unrecognized
    // language strings yet. If a grammar arrives while that plan is yielded,
    // consulting only the committed layer state can miss it permanently: the
    // old plan may resume, cache the earlier failed lookup, and commit the
    // language string as unrecognized after this notification has passed.
    // Queueing another full population is cheap here because the drain
    // coalesces requests, and grammar registrations are rare compared with
    // buffer edits.
    if (this.injectionPopulationDrainPromise || this.injectionPointsMatchGrammar(grammar, cache)) {
      this.injectionPointVersion++;
      this._populateInjections(MAX_RANGE, null);
    }

    let childLayers = Array.from(this.childLayerMarkers).map((m) => m.languageLayer);
    for (let child of childLayers) {
      child.updateInjectionsForGrammar(grammar, cache);
    }
  }

  // Run a highlights query for the given range and process the raw captures
  // through a `ScopeResolver`.
  getSyntaxBoundaries(from, to) {
    let { buffer } = this.languageMode;
    if (!(this.language && this.tree) || this.tree.revision !== buffer.getTextRevision()) {
      return [[], new OpenScopeMap()];
    }

    from = buffer.clipPosition(Point.fromObject(from, true));
    to = buffer.clipPosition(Point.fromObject(to, true));

    let boundaries = new SortedBoundaryList();
    let extent = this.getExtent();

    let captures =
      captureQuery(this, this.queries.highlightsQuery, this.tree, {
        startPosition: from,
        endPosition: to,
      }) ?? [];
    this.scopeResolver.reset();

    for (let capture of captures) {
      let { node } = capture;
      if (this.scopeResolver.shouldInvalidateOnChange(capture)) {
        // This node wants to be invalidated in its entirety whenever a change
        // happens within it. This setting should be added to a query whenever
        // (a) a certain node's scope name can change just from its contents
        // changing, and (b) that node can possibly span more than one line.
        //
        // Without this setting, we're liable to invalidate only the line that
        // a change happened on, because we have no other way of knowing how
        // significant of a change it is. If we were able to do so, we'd set
        // this property automatically on any capture that (a) involved a
        // `#match?` predicate, and (b) started and ended on different lines.
        this.nodesToInvalidateOnChange.add(node);
      }
      // Phantom nodes invented by the parse tree. Indentation captures can use
      // `allowEmpty` to force these to be considered, but for marking scopes,
      // there's no need for it; it'd just cause us to open and close a scope
      // in the same position.
      if (node.childCount === 0 && node.startIndex === node.endIndex) {
        continue;
      }

      // Ask the `ScopeResolver` to process each capture in turn. Some captures
      // will be ignored if they fail certain tests, and some will have their
      // original range altered.
      this.scopeResolver.store(capture);
    }

    // A `HighlightIterator` will want to know which scopes were already open
    // when this range began. Sadly, we also have to keep track of the point in
    // the buffer at which each of those scopes would've been added, because
    // it's possible that later we'll find out that a deeper iterator has
    // suppressed the application of that scope boundary at that position.
    let alreadyOpenScopes = new OpenScopeMap();

    // How do we add a layer's root scope? There's no easy answer.
    //
    // If we rely on the grammar author to map the tree's root node to the
    // language's root scope, they could forget to do it, or map a scope that
    // isn't the same as the one given in the grammar's config file. We'd also
    // limit the ability of that `highlights.scm` to be used in multiple
    // contexts — for example, the HTML grammar would always carry around a
    // `text.html.basic` scope name no matter where we put it.
    //
    // If we manage it ourselves, we invite the complexity of _manually_
    // applying a root scope — plus knowing when it actually _shouldn't_ be
    // applied, and making sure that `scopeDescriptorForPosition` returns
    // results that agree with reality.
    //
    // Option B is the one we reluctantly choose because it gives us more
    // control. Here's roughly how this works:
    //
    // * The base language scope on the root layer will always be applied.
    // * The base language scope on an injection layer will be applied in areas
    //   where that injection is active, unless we were told otherwise in
    //   `addInjectionPoint`. That method's `languageScope` property can
    //   define another scope name to use instead… or pass `null`, signaling
    //   that we should skip the root scope altogether. (This is the best
    //   approach for special-purpose injections like `todo` and `hyperlink`.)
    // * A grammar can still opt to place a root scope conditionally based on
    //   whether it's on an injection layer. This also allows a grammar to
    //   apply that root scope more selectively in injection contexts if
    //   desired.

    // Ensure the whole source file (or whole bounds of the injection) is
    // annotated with the language's base scope name. We _do not_ want to leave
    // this up to the grammar author; it's too important. Also ensure that the
    // base scope name of an injection covers the true boundaries of where that
    // injection is active.
    //
    // NOTE: If an injection is active over a number of disjoint ranges, this
    // may have some surprising effects. For instance, areas where PHP is
    // injected into HTML…
    //
    //    <h1><?php echo "foo" ?></h1>
    //
    // …will include `<?php`, `echo`, `"foo"`, and `?>`, but may exclude the
    // spaces between those tokens. This is a consequence of the design of
    // a particular Tree-sitter parser and should be mitigated with the
    // `includeAdjacentWhitespace` option of `addInjectionPoint`.
    //
    let includedRanges =
      this.depth === 0 && !this.rootRangesRestricted ? [extent] : this.getCurrentRanges();

    let languageScopeIdForRange = () => this.languageScopeId;
    if (typeof this.languageScope === "function") {
      languageScopeIdForRange = (range) => {
        let scopeName = this.languageScope(this.grammar, this.languageMode.buffer, range);
        if (Array.isArray(scopeName)) {
          return scopeName.map((s) => this.languageMode.idForScope(s));
        } else {
          return this.languageMode.idForScope(scopeName);
        }
      };
    }

    if (this.languageScopeId || typeof this.languageScope === "function") {
      for (let range of includedRanges) {
        // Filter out ranges that have no intersection with ours.
        if (range.end.isLessThanOrEqual(from)) {
          continue;
        }
        if (range.start.isGreaterThanOrEqual(to)) {
          continue;
        }

        let languageScopeIds = languageScopeIdForRange(range);
        if (!languageScopeIds) continue;

        if (!Array.isArray(languageScopeIds)) {
          languageScopeIds = [languageScopeIds];
        }

        if (range.start.isLessThan(from)) {
          // If we get this far, we know that the base language scope was open
          // when our range began.
          alreadyOpenScopes.set(range.start, languageScopeIds);
        } else {
          // Range start must be between `from` and `to`, or else equal `from`
          // exactly.
          for (let id of languageScopeIds) {
            this.scopeResolver.setBoundary(range.start, id, "open", {
              root: true,
              length: Infinity,
            });
          }
        }

        if (range.end.isGreaterThan(to)) {
          // Do nothing; we don't need to set this boundary.
        } else {
          // The range must end somewhere within our range.
          //
          // Close the boundaries in the opposite order of how we opened them.
          for (let i = languageScopeIds.length - 1; i >= 0; i--) {
            this.scopeResolver.setBoundary(range.end, languageScopeIds[i], "close", {
              root: true,
              length: Infinity,
            });
          }
        }
      }
    }

    // `ScopeResolver` ensures that these points will be iterated in buffer
    // order.
    for (let [point, data] of this.scopeResolver) {
      // The boundaries that occur before the start of our range will tell us
      // which scopes should already be open when our range starts.
      if (point.isLessThan(from)) {
        alreadyOpenScopes.set(point, data.open);
        for (let c of data.close) {
          alreadyOpenScopes.removeLastOccurrenceOf(c);
        }
        continue;
      } else if (point.isGreaterThan(to)) {
        continue;
      }

      let OPEN_KEY = { position: point, boundary: "start" };
      let CLOSE_KEY = { position: point, boundary: "end" };

      // Each point will contain either one or more scopes to _close_…
      if (data.close.length > 0) {
        boundaries.add(CLOSE_KEY, {
          scopeIds: Object.freeze(data.close),
        });
      }

      // …or one or more scopes to _open_. One point is not allowed to close
      // one scope and open another; there's always a chance that a different
      // injection layer needs to act in between.
      if (data.open.length > 0) {
        boundaries.add(OPEN_KEY, {
          scopeIds: Object.freeze(data.open),
        });
      }
    }

    return [boundaries, alreadyOpenScopes];
  }

  buildHighlightIterator() {
    if (this.tree) {
      return new LayerHighlightIterator(this, this.tree);
    } else {
      return new NullLayerHighlightIterator(this);
    }
  }

  handleTextChange(edit) {
    this.nodesToInvalidateOnChange.edit(edit);
    this.foldNodesToInvalidateOnChange.edit(edit);
    // Any text change within the layer invalidates our cached fold boundary
    // tree. This usually isn't a big deal because the language mode's own cache
    // is able to adjust when content shifts up and down, so typically only the
    // ranges that actually change will have fold data re-queried.
    if (this.foldResolver) {
      this.foldResolver.reset();
    }
    const sameExtent =
      edit.oldEndIndex === edit.newEndIndex &&
      Point.fromObject(edit.oldEndPosition).isEqual(edit.newEndPosition);
    const editedRange = new Range(edit.startPosition, edit.oldEndPosition);
    if (
      this.marker?.combinedInjectionGroup &&
      this.tree &&
      sameExtent &&
      this.currentRangesCache?.length &&
      !this.currentParsePromise &&
      this.currentRangesLayer.findMarkers({ intersectsRange: editedRange }).length === 0
    ) {
      // A combined owner spans holes between its actual parser ranges. An
      // equal-extent edit strictly inside a hole changes neither parser input
      // nor coordinates; tree.edit would only make this valid tree look dirty.
      // Descendant callbacks still receive the same local discovery range.
      // Boundary touches and edits during a parse retain the full path.
      if (this.hasInjectionDescendants()) {
        this.editedRange = this.editedRange ? this.editedRange.union(editedRange) : editedRange;
      }
      return;
    }
    const containingRange = this.currentRangesCache
      ? this.currentRangeContainingPoint(edit.startPosition)
      : null;
    // Equal-length edits wholly inside one included range (or wholly outside
    // every range) cannot move any of its boundaries or absolute indices.
    const rangesUnmoved =
      sameExtent &&
      this.currentRangesCache !== undefined &&
      (containingRange?.containsRange(editedRange) ||
        this.currentRangesLayer.findMarkers({ intersectsRange: editedRange }).length === 0);
    if (!rangesUnmoved) {
      this.currentRangesCache = undefined;
      this.includedRangesAreCurrent = false;
    }

    const { startPosition, oldEndPosition, newEndPosition } = edit;

    if (this.tree) {
      // We're tentatively marking this tree as dirty; we won't know if it
      // needs to be reparsed until the transaction is done. If it doesn't,
      // that means that the edits didn't encroach on the contents of the
      // layer, and we'll mark those trees as clean at the end of the
      // transaction.
      this.treeIsDirty = true;
      if (this.editedRange) {
        if (startPosition.isLessThan(this.editedRange.start)) {
          this.editedRange.start = startPosition;
        }
        if (oldEndPosition.isLessThan(this.editedRange.end)) {
          this.editedRange.end = newEndPosition.traverse(
            this.editedRange.end.traversalFrom(oldEndPosition),
          );
        } else {
          this.editedRange.end = newEndPosition;
        }
      } else {
        this.editedRange = new Range(startPosition, newEndPosition);
      }
    }
  }

  update(nodeRangeSet, params = {}) {
    if (this.destroyed) return false;
    if (this.updating) {
      this.updateRequested = true;
      this.pendingNodeRangeSet = nodeRangeSet;
      return false;
    }
    this.updating = true;
    this.languageMode.publicationPending = true;
    const needsRetry = () =>
      !params.initialInjectionUpdateAborted &&
      !this.destroyed &&
      (this.updateRequested ||
        this.injectionPopulationNeedsRetry ||
        this.rootRangePolicyNeedsUpdate ||
        !this.tree ||
        this.treeIsDirty ||
        this.tree.revision !== this.buffer.getTextRevision());
    const next = () => (needsRetry() ? run() : true);
    const afterParse = () => {
      if (this.depth === 0 && this.tree?.revision === this.buffer.getTextRevision()) {
        const advanced = this.languageMode.advanceUnchangedLayers();
        if (advanced?.then) return advanced.then(next);
      }
      return next();
    };
    const run = () => {
      if (this.destroyed) return false;
      if (!this.ready) return this.languageLoaded.then(run);
      if (
        this.depth > 0 &&
        this.marker?.parentLanguageLayer?.tree?.revision !== this.buffer.getTextRevision()
      ) {
        this.requestInjectionParentRetry({ layer: this.marker?.parentLanguageLayer });
        return false;
      }
      this.updateRequested = false;
      if (this.pendingNodeRangeSet) {
        nodeRangeSet = this.pendingNodeRangeSet;
        this.pendingNodeRangeSet = null;
      }
      params = {
        ...params,
        async: !this.languageMode.shouldParseSynchronously(),
        initialInjectionUpdateAborted: false,
      };
      const result = this._performUpdate(nodeRangeSet, params);
      return result?.then ? result.then(afterParse) : afterParse();
    };
    try {
      const result = run();
      if (result?.then) {
        const pending = result.finally(() => {
          if (this.currentParsePromise === pending) this.currentParsePromise = null;
          this.updating = false;
        });
        this.currentParsePromise = pending;
        return pending;
      }
      this.updating = false;
      return result;
    } catch (error) {
      this.updating = false;
      throw error;
    }
  }

  resolveRootRangeSet() {
    const registration = this.languageMode.grammarRegistry?.rootLanguageRangesByBuffer?.get(
      this.buffer,
    );
    const requested = registration?.provider(this.buffer) ?? null;
    this.rootRangePolicyNeedsUpdate = false;
    if (requested === null) {
      if (this.rootRangesRestricted) {
        this.rootRangesRestricted = false;
        this.rootRangeSet.version++;
        this.injectionPointVersion++;
        this.rootIncludedRanges = null;
        for (const marker of this.currentRangesLayer.getMarkers()) marker.destroy();
        this.currentRangesCache = null;
        this.lastIncludedRanges = null;
        this.rootRangeInvalidationPending = true;
      }
      return null;
    }
    if (!Array.isArray(requested))
      throw new TypeError("A range provider must return ranges or null");
    const ranges = requested.map((range) => this.buffer.clipRange(Range.fromObject(range)));
    ranges.sort((a, b) => a.compare(b));
    const normalized = [];
    for (const range of ranges) {
      const previous = last(normalized);
      if (previous && !previous.end.isLessThan(range.start)) {
        normalized[normalized.length - 1] = previous.union(range);
      } else {
        normalized.push(range);
      }
    }
    if (normalized.length === 0) {
      const eof = this.buffer.getEndPosition();
      normalized.push(new Range(eof, eof));
    }
    const current = this.rootRangesRestricted ? this.getCurrentRanges() : null;
    const changed =
      !current ||
      current.length !== normalized.length ||
      current.some((range, index) => !range.isEqual(normalized[index]));
    this.rootRangeSet ??= {
      isRootLanguageRangeSet: true,
      version: 0,
      rangesUnchanged: true,
      getRanges: () => this.rootIncludedRanges,
    };
    if (changed) {
      this.rootRangeSet.version++;
      this.injectionPointVersion++;
      this.rootRangeInvalidationPending = true;
    }
    this.rootRangesRestricted = true;
    this.rootIncludedRanges = normalized.map((range) =>
      rangeToTreeSitterRangeSpec(range, this.buffer),
    );
    // Marker positions already follow edits, including a moving EOF. Reuse them
    // unless the provider actually changed which source belongs to the language.
    if (changed) this.setCurrentRanges(this.rootIncludedRanges);
    else {
      this.currentRangesCache = normalized;
      this.lastIncludedRanges = this.rootIncludedRanges;
      this.includedRangesAreCurrent = true;
    }
    return this.rootRangeSet;
  }

  injectionParentSnapshotIsCurrent({ layer, tree, injectionPointVersion }) {
    return Boolean(
      layer &&
      tree &&
      !layer.destroyed &&
      layer.tree === tree &&
      layer.injectionPointVersion === injectionPointVersion &&
      tree.revision === this.buffer.getTextRevision(),
    );
  }

  requestInjectionParentRetry(parentSnapshot) {
    const parentLayer = parentSnapshot?.layer;
    if (parentLayer && !parentLayer.destroyed) {
      parentLayer.injectionPopulationNeedsRetry = true;
    }
  }

  isSafeParseBoundary(index, position) {
    const length = this.buffer.getLength();
    if (index < 0 || index > length || this.buffer.characterIndexForPosition(position) !== index)
      return false;
    if (index === 0 || index === length) return true;
    const surrounding = this.buffer.getTextInRange(
      new Range(
        this.buffer.positionForCharacterIndex(index - 1),
        this.buffer.positionForCharacterIndex(index + 1),
      ),
    );
    const first = surrounding.charCodeAt(0);
    const second = surrounding.charCodeAt(1);
    return (
      surrounding !== "\r\n" &&
      !(
        surrounding.length === 2 &&
        first >= 0xd800 &&
        first <= 0xdbff &&
        second >= 0xdc00 &&
        second <= 0xdfff
      )
    );
  }

  getParseBoundaryCaptures(tree = this.tree) {
    const query = this.queries.parseBoundariesQuery;
    const root = tree.rootNode;
    const maxStartDepth = this.grammar.queryPaths?.parseBoundariesMaxStartDepth;
    if (!Number.isSafeInteger(maxStartDepth) || maxStartDepth < 0 || maxStartDepth > 32)
      return query.captures(root);

    const shallow = query.captures(root, { maxStartDepth });
    const keyFor = ({ name, node }) => `${name}:${node.id}`;
    const captures = [];
    const seen = new Set();
    const pending = [];
    const expanded = new Set();
    const wantedSuccessor = new Map();
    const anchoredTypes = new Set();
    const addCapture = (capture) => {
      const key = keyFor(capture);
      if (seen.has(key)) return;
      const { name, node } = capture;
      if (
        name === "parse.boundary" &&
        node.childCount > 0 &&
        typeof node.type === "string" &&
        Number.isSafeInteger(node.startIndex) &&
        Number.isSafeInteger(node.endIndex)
      ) {
        // Leading uncaptured padding can change without marking a group dirty.
        // Keep its first stable anchor, then only nearby successors of edits.
        if (!anchoredTypes.has(node.type)) {
          anchoredTypes.add(node.type);
          wantedSuccessor.set(node.type, node.startIndex);
        }
        if (node.hasChanges) wantedSuccessor.set(node.type, node.endIndex);
        else {
          const anchorEnd = wantedSuccessor.get(node.type);
          if (anchorEnd === undefined || node.startIndex < anchorEnd) return;
          if (node.endIndex >= anchorEnd + MINIMUM_BOUNDARY_DISTANCE)
            wantedSuccessor.delete(node.type);
        }
      }
      seen.add(key);
      captures.push(capture);
      pending.push(capture.node);
    };
    shallow.forEach(addCapture);
    const childOptions = { maxStartDepth: Math.max(1, maxStartDepth + 1) };
    while (pending.length) {
      const node = pending.pop();
      if (!node.hasChanges || node.childCount === 0 || expanded.has(node.id)) continue;
      expanded.add(node.id);
      query.captures(node, childOptions).forEach(addCapture);
    }
    return captures;
  }

  getParseRanges(includedRanges) {
    // These are parser hints, never new ownership boundaries for injections.
    // A scanner must explicitly opt in and tolerate adjacent included ranges.
    this.parseCompactionEdits = [];
    const query = this.queries.parseBoundariesQuery;
    if (
      (this.depth !== 0 && this.grammar.queryPaths?.parseBoundariesInjections !== true) ||
      !this.backgroundTree ||
      !query
    )
      return includedRanges;
    if (this.backgroundTree.language !== this.grammar.getLanguageSync()) return includedRanges;
    const capture = this.languageMode.document.capture(this.backgroundTree);
    if (!capture.previous || TreeSitterParser.isBulkChange(capture.previous, capture.edits))
      return includedRanges;
    const tree = TreeSitterParser.prepareTree(capture.previous, capture.text, {
      edits: capture.edits,
    });
    try {
      const length = this.buffer.getLength();
      let captures = this.getParseBoundaryCaptures(tree);
      const fragments = [];
      for (const { name, node } of captures) {
        if (name !== "parse.boundary") continue;
        const startIndex = node.startIndex;
        const endIndex = node.endIndex;
        if (endIndex - startIndex >= MINIMUM_BOUNDARY_DISTANCE) continue;
        fragments.push({
          startIndex,
          endIndex,
          startPosition: node.startPosition,
          endPosition: node.endPosition,
        });
      }
      // Repeated edits can accumulate reused tiny leaves. Mark only a bounded
      // contiguous region dirty without changing any byte or coordinate, so the
      // scanner can consolidate it during this parse. Reacquire nodes afterward.
      let compacted = false;
      for (const edit of smallFragmentRegions(fragments)) {
        if (
          includedRanges &&
          !includedRanges.some(
            (range) => edit.startIndex >= range.startIndex && edit.oldEndIndex <= range.endIndex,
          )
        )
          continue;
        if (
          !this.isSafeParseBoundary(edit.startIndex, edit.startPosition) ||
          !this.isSafeParseBoundary(edit.oldEndIndex, edit.oldEndPosition)
        )
          continue;
        tree.edit(edit);
        this.parseCompactionEdits.push(
          Object.freeze({
            startIndex: edit.startIndex,
            oldEndIndex: edit.oldEndIndex,
            newText: capture.text.slice(edit.startIndex, edit.oldEndIndex),
            startPosition: Object.freeze({ ...edit.startPosition }),
            oldEndPosition: Object.freeze({ ...edit.oldEndPosition }),
            newEndPosition: Object.freeze({ ...edit.newEndPosition }),
          }),
        );
        compacted = true;
      }
      if (compacted) {
        this.treeIsDirty = true;
        captures = this.getParseBoundaryCaptures(tree);
      }
      const boundaries = [];
      for (const { name, node } of captures) {
        if (name !== "parse.boundary") continue;
        const index = node.endIndex;
        if (index <= 0 || index >= length) continue;
        const position = node.endPosition;
        if (!this.isSafeParseBoundary(index, position)) continue;
        boundaries.push({ index, position });
      }
      return splitIncludedRanges(
        includedRanges ?? [rangeToTreeSitterRangeSpec(this.buffer.getRange(), this.buffer)],
        boundaries,
      );
    } finally {
      tree.delete();
    }
  }

  _performUpdate(nodeRangeSet, params = {}) {
    params.async = !this.languageMode.shouldParseSynchronously();
    // It's much more common in specs than in real life, but it's always
    // possible for a layer to get destroyed during the async period between
    // layer updates.
    if (this.destroyed) return;

    const injectionOnlyParent = nodeRangeSet?.injectionOnlyParentSnapshot;
    if (injectionOnlyParent && !this.injectionParentSnapshotIsCurrent(injectionOnlyParent)) {
      this.requestInjectionParentRetry(injectionOnlyParent);
      params.initialInjectionUpdateAborted = true;
      return;
    }
    if (
      nodeRangeSet?.injectionOnly &&
      nodeRangeSet.rangesUnchanged &&
      this.includedRangesAreCurrent &&
      this.tree &&
      this.tree === this.lastSyntaxTree &&
      !this.treeIsDirty &&
      this.tree.revision === this.buffer.getTextRevision() &&
      !this.injectionPopulationNeedsRetry &&
      !this.rootRangePolicyNeedsUpdate &&
      nodeRangeSet.getRanges(this.buffer) === this.lastIncludedRanges
    ) {
      const affectedRange = this.editedRange;
      this.lastTransactionEditedRange = affectedRange;
      this.editedRange = null;
      const included = this.lastIncludedRanges;
      const range =
        affectedRange ?? new Range(included[0].startPosition, last(included).endPosition);
      // This is the existing discovery extent with no syntax changes. Keep
      // update's async/retry lifecycle, without parsing, publishing or freeing
      // the unchanged tree. No broader scan of external callback state is added.
      const finish = () => {
        if (this.destroyed) return;
        if (injectionOnlyParent && !this.injectionParentSnapshotIsCurrent(injectionOnlyParent)) {
          this.requestInjectionParentRetry(injectionOnlyParent);
          params.initialInjectionUpdateAborted = true;
        }
      };
      const result = this._populateInjections(range, nodeRangeSet);
      return result?.then ? result.then(finish) : finish();
    }

    if (
      !this.languageMode.shouldParseSynchronously() &&
      this.depth > 0 &&
      !this.tree &&
      !params.initialInjectionUpdateStarted
    ) {
      // The topology for this layer has already been committed. Defer only its
      // first parse so a burst of newly-ready injection layers shares one
      // renderer-task budget instead of each consuming a separate initial
      // parse allowance in the same microtask checkpoint.
      const parentLayer = this.marker?.parentLanguageLayer;
      const parentSnapshot = {
        layer: parentLayer,
        tree: parentLayer?.tree,
        injectionPointVersion: parentLayer?.injectionPointVersion,
      };
      params.async = true;
      return this.languageMode.scheduleInitialInjectionUpdate(() => {
        if (this.destroyed || !this.injectionParentSnapshotIsCurrent(parentSnapshot)) {
          // The included ranges were planned from an older parent tree. Let
          // the parent's in-flight update finish and retry reconciliation
          // instead of parsing invalid ranges or spinning this layer's retry
          // loop while the parent is waiting on it.
          this.requestInjectionParentRetry(parentSnapshot);
          params.initialInjectionUpdateAborted = true;
          return;
        }
        const updatePromise = this._performUpdate(nodeRangeSet, {
          ...params,
          initialInjectionUpdateStarted: true,
          initialInjectionParentSnapshot: parentSnapshot,
        });
        return Promise.resolve(updatePromise).finally(() => {
          if (!this.injectionParentSnapshotIsCurrent(parentSnapshot)) {
            this.requestInjectionParentRetry(parentSnapshot);
            params.initialInjectionUpdateAborted = true;
          }
        });
      });
    }

    if (this.depth === 0) nodeRangeSet = this.resolveRootRangeSet();
    const rootRangeVersion = this.depth === 0 ? this.rootRangeSet?.version : null;
    let includedRanges = null;
    this.rangeList.clear();

    if (nodeRangeSet) {
      includedRanges = nodeRangeSet.getRanges(this.languageMode.buffer);
      if (includedRanges.length === 0) {
        // We have no ranges to inject into. This layer should no longer exist.
        const range = this.marker.getRange();
        this.destroy();
        this.languageMode.emitRangeUpdate(range);
        return;
      }
    }

    const language = this.grammar.getLanguageSync();
    const generation = this.grammar.queryLoadGeneration;
    const revision = this.buffer.getTextRevision();
    const context = {
      params,
      nodeRangeSet,
      includedRanges,
      rootRangeVersion,
      generation,
      revision,
    };
    if (nodeRangeSet?.rangesUnchanged && this.backgroundTree && !this.treeIsDirty) {
      // An owner can change inside a hole without changing any parser input.
      // Preserve this optimization with a new immutable snapshot: callbacks
      // still need the current text between the included ranges.
      const capture = this.languageMode.document.capture(this.backgroundTree);
      const reused =
        capture.previous &&
        TreeSitterParser.reuseSnapshot(capture.previous, capture.text, {
          edits: capture.edits,
          revision,
          includedRanges,
        });
      if (reused) {
        this.languageMode.backgroundSnapshots.add(reused);
        this.languageMode.parseDetails.set(reused, { incremental: true });
        return this._applyParsedTree(reused, context);
      }
    }
    const parseRanges = this.getParseRanges(includedRanges);
    if (this.languageMode.shouldParseSynchronously()) {
      const controller = new AbortController();
      this.parseAbort = controller;
      const tree = this.languageMode.parse(language, this.backgroundTree, parseRanges, {
        scopeName: this.grammar.scopeName,
        extraEdits: this.parseCompactionEdits,
        signal: controller.signal,
      });
      if (tree?.then)
        return tree
          .then((result) => this._applyParsedTree(result, context))
          .finally(() => {
            if (this.parseAbort === controller) this.parseAbort = null;
          });
      this.parseAbort = null;
      return this._applyParsedTree(tree, context);
    }
    const controller = new AbortController();
    this.parseAbort = controller;
    return this.languageMode
      .parseAsync(language, this.backgroundTree, parseRanges, {
        scopeName: this.grammar.scopeName,
        extraEdits: this.parseCompactionEdits,
        signal: controller.signal,
        depth: this.depth,
      })
      .then((tree) => this._applyParsedTree(tree, context))
      .finally(() => {
        if (this.parseAbort === controller) this.parseAbort = null;
      });
  }

  _applyParsedTree(
    tree,
    { params, nodeRangeSet, includedRanges, rootRangeVersion, generation, revision },
  ) {
    if (!tree || this.destroyed) return;
    if (
      tree.revision !== this.buffer.getTextRevision() ||
      revision !== tree.revision ||
      generation !== this.grammar.queryLoadGeneration
    )
      return;
    if (this.depth === 0 && rootRangeVersion !== this.rootRangeSet?.version) {
      this.rootRangePolicyNeedsUpdate = true;
      return;
    }
    if (
      params.initialInjectionParentSnapshot &&
      !this.injectionParentSnapshotIsCurrent(params.initialInjectionParentSnapshot)
    ) {
      this.requestInjectionParentRetry(params.initialInjectionParentSnapshot);
      return;
    }
    this.backgroundTree = tree;

    if (includedRanges && !nodeRangeSet.rangesUnchanged) {
      this.setCurrentRanges(includedRanges);
    }

    let affectedRange = this.editedRange;
    if (affectedRange) this.rangeList.add(affectedRange);
    this.lastTransactionEditedRange = this.editedRange;
    this.editedRange = null;
    if (this.rootRangeInvalidationPending) {
      this.rootRangeInvalidationPending = false;
      affectedRange = this.buffer.getRange();
      this.rangeList.add(affectedRange);
    }

    let foldRangeList = new TreeSitterRangeList();

    if (this.languageMode.parseDetails.get(tree)?.incremental) {
      if (affectedRange) {
        this.rangeList.addAll(this.nodesToInvalidateOnChange.takeIntersecting(affectedRange));
        foldRangeList.addAll(this.foldNodesToInvalidateOnChange.takeIntersecting(affectedRange));
      } else {
        this.nodesToInvalidateOnChange.rebase();
        this.foldNodesToInvalidateOnChange.rebase();
      }
    } else {
      // A fresh parse invalidates the whole layer. Its new queries will record
      // dependencies again; do not replay a large edit batch through old ones.
      this.nodesToInvalidateOnChange.clear();
      this.foldNodesToInvalidateOnChange.clear();
    }
    if (this.lastSyntaxTree) {
      const rangesWithSyntaxChanges = this.languageMode.parseDetails.get(tree)?.incremental
        ? tree.changedRanges
        : [tree.rootNode];

      this.lastSyntaxTree = tree;
      this.tree = tree;
      this.treeIsDirty = false;

      if (rangesWithSyntaxChanges.length > 0) {
        const syntaxRanges = rangesWithSyntaxChanges.map((range) => {
          const result = rangeForNode(range);
          // Switching between explicit ranges and the parser's unrestricted
          // sentinel can report a changed range ending beyond the buffer.
          return this.depth === 0 && this.rootRangeSet ? this.buffer.clipRange(result) : result;
        });
        this.rangeList.addAll(syntaxRanges);

        const combinedRangeWithSyntaxChange = new Range(
          syntaxRanges[0].start,
          last(syntaxRanges).end,
        );

        if (affectedRange) {
          this.rangeList.add(affectedRange);
          affectedRange = affectedRange.union(combinedRangeWithSyntaxChange);
        } else {
          affectedRange = combinedRangeWithSyntaxChange;
        }
      }
    } else {
      this.tree = tree;
      this.treeIsDirty = false;

      // Store a reference to this tree so we can compare it with the next
      // transaction's tree later on.
      this.lastSyntaxTree = tree;

      this.rangeList.add(rangeForNode(tree.rootNode));
      if (includedRanges) {
        affectedRange = new Range(
          includedRanges[0].startPosition,
          last(includedRanges).endPosition,
        );
      } else {
        affectedRange = MAX_RANGE;
      }
    }

    // Now that we've assembled and coalesced all the ranges that need
    // invalidating, we'll invalidate them in buffer order.
    for (let range of this.rangeList) {
      if (this.depth === 0 && this.rootRangeSet) range = this.buffer.clipRange(range);
      this.languageMode.emitRangeUpdate(range);
    }

    for (let range of foldRangeList) {
      // The fold cache is automatically cleared for any range that needs
      // re-highlighting. But sometimes we need to go further and invalidate
      // rows that don't even need highlighting changes.
      this.languageMode.emitFoldUpdate(range);
    }
    this.scheduleAncillaryQueries();

    if (this.injectionPopulationNeedsRetry) {
      // A queued child update was planned from an older tree. The current tree
      // may already have been synchronously replaced with a clean one, so its
      // `hasChanges` bit alone cannot request this reconciliation retry.
      affectedRange = this.getExtent();
      this.injectionPopulationNeedsRetry = false;
    }

    if (affectedRange) {
      let injectionPromise = this._populateInjections(affectedRange, nodeRangeSet);
      if (injectionPromise) {
        params.async = true;
        return injectionPromise;
      }
    }
  }

  setCurrentRanges(includedRanges) {
    if (this.depth === 0 && !this.rootRangesRestricted) {
      return;
    }
    const newRanges = includedRanges.map((range) => rangeForNode(range).freeze());
    const oldMarkers = this.currentRangesLayer.getMarkers();
    const markersByRange = new Map();
    const rangeKey = (range) =>
      `${range.start.row},${range.start.column}/${range.end.row},${range.end.column}`;

    for (const marker of oldMarkers) {
      const key = rangeKey(marker.getRange());
      let markers = markersByRange.get(key);
      if (!markers) {
        markers = [];
        markersByRange.set(key, markers);
      }
      markers.push(marker);
    }

    // These are the “official” ranges, received right after the parent layer's
    // tree parse. We'll get a new set of official ranges at the end of the
    // next transaction, but until then, we should try our best to adapt to
    // buffer changes, and to allow each range to shift or grow or shrink so
    // that off-schedule parses are more likely to be accurate.
    const retainedMarkers = new Set();
    const unmatchedRanges = [];
    for (const range of newRanges) {
      const markers = markersByRange.get(rangeKey(range));
      const marker = markers?.shift();
      if (marker) {
        retainedMarkers.add(marker);
      } else {
        unmatchedRanges.push(range);
      }
    }

    const unmatchedMarkers = oldMarkers.filter((marker) => !retainedMarkers.has(marker));
    const reusedCount = Math.min(unmatchedMarkers.length, unmatchedRanges.length);
    for (let index = 0; index < reusedCount; index++) {
      unmatchedMarkers[index].setRange(unmatchedRanges[index]);
    }
    for (let index = reusedCount; index < unmatchedMarkers.length; index++) {
      unmatchedMarkers[index].destroy();
    }
    for (let index = reusedCount; index < unmatchedRanges.length; index++) {
      this.currentRangesLayer.markRange(unmatchedRanges[index]);
    }

    this.currentRangesCache = newRanges;
    this.lastIncludedRanges = includedRanges;
    this.includedRangesAreCurrent = true;
  }

  getCurrentRanges() {
    if (this.currentRangesCache !== undefined) {
      return this.currentRangesCache;
    }
    let markers = this.currentRangesLayer?.getMarkers();
    if (!markers || markers.length === 0) {
      this.currentRangesCache = null;
    } else {
      this.currentRangesCache = markers.map((marker) => marker.getRange());
    }
    return this.currentRangesCache;
  }

  // Checks whether a given {@link Point} lies within one of this layer's content
  // ranges — not just its extent. The optional `exclusive` flag will return
  // `false` if the point lies on a boundary of a content range.
  containsPoint(point, exclusive = false) {
    if (this.depth === 0 && !this.rootRangesRestricted) {
      return this.getExtent().containsPoint(point, exclusive);
    }
    return Boolean(this.currentRangeContainingPoint(point, exclusive));
  }

  currentRangeContainingPoint(point, exclusive = false) {
    const ranges = this.getCurrentRanges();
    if (!ranges?.length) return null;

    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle].start.compare(point) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    const candidate = ranges[low - 1];
    return candidate?.containsPoint(point, exclusive) ? candidate : null;
  }

  // Return the current immutable snapshot, or parse a private snapshot for an
  // in-transaction indentation request. Private snapshots never replace the
  // committed tree; retained nodes remain valid. force:false returns null when
  // the committed snapshot is stale.
  getOrParseTree({ force = true, bounded = false } = {}) {
    if (this.tree?.revision === this.buffer.getTextRevision() && !this.treeIsDirty) {
      return this.tree;
    }
    if (!force) return null;

    let ranges;
    if (this.depth === 0) {
      ranges = this.resolveRootRangeSet()?.getRanges(this.buffer) ?? null;
    } else {
      ranges = this.getCurrentRanges().map((r) => {
        return rangeToTreeSitterRangeSpec(r, this.buffer);
      });
    }

    return this.languageMode.parse(this.language, this.tree, this.getParseRanges(ranges), {
      scopeName: this.grammar.scopeName,
      extraEdits: this.parseCompactionEdits,
      budgetOnly: bounded,
    });
  }

  // Given a point, return all syntax captures that are active at that point.
  // Used by `bufferRangeForScopeAtPosition`.
  scopeMapAtPosition(point) {
    if (!this.language || !this.tree || this.tree.revision !== this.buffer.getTextRevision()) {
      return [];
    }
    let { scopeResolver } = this;
    scopeResolver.reset();

    // If the cursor is resting before column X, we want all scopes that cover
    // the character in column X.
    let captures =
      captureQuery(this, this.queries.highlightsQuery, this.tree, {
        startPosition: point,
        endPosition: point.translate(ONE_CHAR_FORWARD_TRAVERSAL),
      }) ?? [];

    let results = [];
    for (let capture of captures) {
      // Storing the capture will return its range (after any potential
      // adjustments) — or `false`, to signify that the capture was ignored.
      let range = scopeResolver.store(capture, { boundaries: false });
      if (!range) {
        continue;
      }

      // Since the range might have been adjusted, we wait until after
      // resolution.
      if (comparePoints(range.endPosition, point) === 0) {
        continue;
      }
      if (isBetweenPoints(point, range.startPosition, range.endPosition)) {
        results.push({ capture, adjustedRange: range });
      }
    }

    scopeResolver.reset();

    // Sort from biggest to smallest.
    results = results.sort((a, b) => {
      return nodeBreadth(b.adjustedRange) - nodeBreadth(a.adjustedRange);
    });

    return results;
  }

  // Like `TreeSitterLanguageMode#getSyntaxNodeAtPosition`, but for just this
  // layer.
  getSyntaxNodeAtPosition(position, where = FUNCTION_TRUE) {
    if (!this.language || !this.tree) {
      return null;
    }
    let { buffer } = this.languageMode;

    let index = buffer.characterIndexForPosition(position);
    let node = this.tree.rootNode.descendantForIndex(index);

    while (node) {
      if (where(node, this.grammar)) {
        return node;
      }
      node = node.parent;
    }

    return null;
  }

  // Used to find the most specific node affected by an edited range.
  getSyntaxNodeContainingRange(range, where = FUNCTION_TRUE) {
    if (!this.language || !this.tree) {
      return null;
    }
    let { buffer } = this.languageMode;

    if (range.start.isEqual(range.end)) {
      return this.getSyntaxNodeAtPosition(range.start, where);
    }

    let indexStart = buffer.characterIndexForPosition(range.start);
    let indexEnd = buffer.characterIndexForPosition(range.end);

    let rangeBreadth = indexEnd - indexStart;
    let node = this.getSyntaxNodeAtPosition(range.start, (node) => {
      let breadth = node.endIndex - node.startIndex;
      let qualifies =
        node.startIndex <= indexEnd && node.endIndex >= indexEnd && breadth >= rangeBreadth;
      return qualifies && where(node);
    });

    return node ?? null;
  }

  // Assuming a buffer change in the given range, decides which injections need
  // to be created and where to create them, ideally reusing as many layers as
  // possible from previous updates.
  _populateInjections(range, nodeRangeSet) {
    if (!this.tree || this.destroyed || this.languageMode.grammarRegistry?.windowUnloading) {
      return;
    }
    if (!this.hasInjectionDescendants()) {
      return;
    }

    if (!nodeRangeSet && this.depth === 0 && this.rootRangesRestricted) {
      nodeRangeSet = this.rootRangeSet;
    } else if (!nodeRangeSet && this.depth > 0) {
      // Grammar and registration changes do not carry the parent update's
      // range set. Preserve this layer's current included ranges when its
      // descendants are rebuilt outside a buffer transaction.
      nodeRangeSet = {
        rootRangeSet: this.languageMode.rootLanguageLayer.rootRangesRestricted
          ? this.languageMode.rootLanguageLayer.rootRangeSet
          : undefined,
        getRanges: (buffer) =>
          (this.getCurrentRanges() ?? []).map((current) =>
            rangeToTreeSitterRangeSpec(current, buffer),
          ),
      };
    }
    if (this.languageMode.shouldParseSynchronously() && !this.injectionPopulationDrainPromise) {
      const result = this._performPopulateInjections(range, nodeRangeSet);
      if (!result?.then) return result;
      const finish = () => {
        if (!this.destroyed && this.pendingInjectionPopulationRequests.length > 0)
          return this._drainInjectionPopulationRequests().then(finish);
      };
      const pending = result.then(finish).finally(() => {
        if (this.injectionPopulationDrainPromise === pending)
          this.injectionPopulationDrainPromise = null;
        if (!this.destroyed) this.languageMode.publishCurrentLayers();
      });
      this.injectionPopulationDrainPromise = pending;
      return pending;
    }
    this.pendingInjectionPopulationRequests.push({ range, nodeRangeSet });
    if (this.injectionPopulationDrainPromise) {
      return this.injectionPopulationDrainPromise;
    }

    let resolveDrain;
    let rejectDrain;
    const drainPromise = new Promise((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });
    this.injectionPopulationDrainPromise = drainPromise;

    const finishDrain = () => {
      if (!this.destroyed && this.pendingInjectionPopulationRequests.length > 0) {
        this._drainInjectionPopulationRequests().then(finishDrain, failDrain);
        return;
      }
      if (this.injectionPopulationDrainPromise === drainPromise) {
        this.injectionPopulationDrainPromise = null;
      }
      resolveDrain();
      if (!this.destroyed) this.languageMode.publishCurrentLayers();
    };
    const failDrain = (error) => {
      this.pendingInjectionPopulationRequests.length = 0;
      if (this.injectionPopulationDrainPromise === drainPromise) {
        this.injectionPopulationDrainPromise = null;
      }
      rejectDrain(error);
    };

    this._drainInjectionPopulationRequests().then(finishDrain, failDrain);
    return drainPromise;
  }

  hasInjectionDescendants() {
    return Boolean(
      this.childLayerMarkers.size ||
      this.combinedInjectionGroups.size ||
      this.queries.injectionsQuery ||
      Object.keys(this.grammar.injectionPointsByType).length,
    );
  }

  async _drainInjectionPopulationRequests() {
    while (!this.destroyed && this.pendingInjectionPopulationRequests.length > 0) {
      const { range, nodeRangeSet } = this._takePendingInjectionPopulationRequest();
      await this._performPopulateInjections(range, nodeRangeSet);
    }
    if (this.destroyed) {
      this.pendingInjectionPopulationRequests.length = 0;
    }
  }

  _takePendingInjectionPopulationRequest() {
    const requests = this.pendingInjectionPopulationRequests.splice(0);
    let range = requests[0].range;
    let nodeRangeSet = requests[0].nodeRangeSet;
    for (let index = 1; index < requests.length; index++) {
      const request = requests[index];
      range = range.union(request.range);
      if (request.nodeRangeSet) nodeRangeSet = request.nodeRangeSet;
    }
    return { range, nodeRangeSet };
  }

  _performPopulateInjections(range, nodeRangeSet) {
    if (!this.tree || this.destroyed || this.languageMode.grammarRegistry?.windowUnloading) {
      return;
    }

    // We won't touch _all_ injections, but we will touch any injection that
    // could possibly have been affected by this layer's update.
    const childMarkerRanges = Array.from(this.childLayerMarkers)
      .filter((marker) => !marker.combinedInjectionGroup)
      .map((marker) => ({
        marker,
        range: marker.getRange(),
      }));
    let existingInjectionMarkerEntries = childMarkerRanges.filter((entry) =>
      entry.range.intersectsWith(range),
    );

    if (existingInjectionMarkerEntries.length > 0) {
      // Enlarge our range to contain all of the injection zones in the
      // affected buffer range.
      let earliest = range.start,
        latest = range.end;
      for (const entry of existingInjectionMarkerEntries) {
        if (entry.range.start.compare(earliest) === -1) {
          earliest = entry.range.start;
        }
        if (entry.range.end.compare(latest) === 1) {
          latest = entry.range.end;
        }
      }

      range = range.union(new Range(earliest, latest));
    }

    let existingCombinedMembers =
      this.combinedInjectionMembersLayer
        ?.findMarkers({ intersectsRange: range })
        .filter((marker) => marker.combinedInjectionMember)
        .map((marker) => marker.combinedInjectionMember) ?? [];
    for (const member of existingCombinedMembers) {
      range = range.union(member.marker.getRange());
    }
    // Widening to a member's owner node can catch more members (for example,
    // content subranges from overlapping registrations on the same owner).
    existingCombinedMembers =
      this.combinedInjectionMembersLayer
        ?.findMarkers({ intersectsRange: range })
        .filter((marker) => marker.combinedInjectionMember)
        .map((marker) => marker.combinedInjectionMember) ?? [];
    const affectedCombinedGroups = [];
    for (const byLanguage of this.combinedInjectionGroups.values()) {
      for (const pool of byLanguage.values()) {
        for (const group of pool.groups) {
          // Joined newline/whitespace ranges can be affected without touching
          // an owner. Rebuild their included ranges, but keep discovery local.
          if (
            group.marker?.languageLayer.currentRangesLayer.findMarkers({ intersectsRange: range })
              .length
          ) {
            affectedCombinedGroups.push(group);
          }
        }
      }
    }

    // Why do we have to do this explicitly? Because `descendantsOfType` will
    // incorrectly return nodes if the range runs from (0, 0) to (0, 0). All
    // other empty ranges seem not to have this problem. Upon cursory
    // inspection, this bug doesn't seem to be limited to `web-tree-sitter`.
    if (
      range.isEmpty() &&
      existingInjectionMarkerEntries.length === 0 &&
      existingCombinedMembers.length === 0 &&
      affectedCombinedGroups.length === 0
    ) {
      return;
    }

    // Imagine our original range touched the outer boundaries of some
    // injection markers. Above, we widened the range so that it covered the
    // full bounds of all those markers. But now that we've widened the range,
    // we should look for markers again. It's possible there are some new ones
    // that weren't caught in the first pass.
    //
    // This time, though, we check for containment rather than intersection
    // so that we don't have to enlarge the range again.
    existingInjectionMarkerEntries = childMarkerRanges.filter((entry) =>
      range.containsRange(entry.range),
    );
    existingInjectionMarkerEntries.sort((a, b) => a.range.compare(b.range));
    const existingInjectionMarkers = existingInjectionMarkerEntries.map((entry) => entry.marker);
    const rangesByInjectionMarker = new Map(
      existingInjectionMarkerEntries.map((entry) => [entry.marker, entry.range]),
    );

    const tree = this.tree;
    const injectionPointVersion = this.injectionPointVersion;
    const injectionPointsByType = {};
    for (const [type, injectionPoints] of Object.entries(this.grammar.injectionPointsByType)) {
      injectionPointsByType[type] = injectionPoints.slice();
    }

    // Query for all the nodes within the original range that could possibly
    // prompt the creation of injection points. A large range is collected in
    // bounded row windows so the query cannot monopolize one task.
    const nodes = this._collectInjectionCandidateNodes(
      tree,
      Object.keys(injectionPointsByType),
      range,
      injectionPointVersion,
    );
    const staticCandidates = this._collectStaticInjectionCandidates(
      tree,
      range,
      injectionPointVersion,
    );
    if (nodes?.then || staticCandidates?.then) {
      return Promise.all([nodes, staticCandidates]).then(
        ([resolvedNodes, resolvedStaticCandidates]) => {
          if (
            resolvedNodes === null ||
            resolvedStaticCandidates === null ||
            !this._injectionCandidateScanIsCurrent(tree, injectionPointVersion)
          ) {
            return;
          }
          return this._reconcileInjections(
            resolvedNodes,
            nodeRangeSet,
            existingInjectionMarkers,
            rangesByInjectionMarker,
            injectionPointsByType,
            tree,
            injectionPointVersion,
            existingCombinedMembers,
            affectedCombinedGroups,
            resolvedStaticCandidates,
          );
        },
      );
    }

    if (!this._injectionCandidateScanIsCurrent(tree, injectionPointVersion)) {
      return;
    }
    return this._reconcileInjections(
      nodes,
      nodeRangeSet,
      existingInjectionMarkers,
      rangesByInjectionMarker,
      injectionPointsByType,
      tree,
      injectionPointVersion,
      existingCombinedMembers,
      affectedCombinedGroups,
      staticCandidates,
    );
  }

  _injectionCandidateScanIsCurrent(tree, injectionPointVersion) {
    return (
      !this.destroyed &&
      !this.languageMode.grammarRegistry?.windowUnloading &&
      this.tree === tree &&
      this.injectionPointVersion === injectionPointVersion &&
      tree.revision === this.buffer.getTextRevision()
    );
  }

  _collectInjectionCandidateNodes(tree, types, range, injectionPointVersion) {
    if (types.length === 0) {
      return [];
    }

    const treeRange = rangeForNode(tree.rootNode);
    const start = Point.max(range.start, treeRange.start);
    const end = Point.min(range.end, treeRange.end);
    if (start.compare(end) >= 0) {
      return [];
    }

    const chunkRows = Math.max(1, this.languageMode.injectionCandidateChunkRows);
    const chunkCodeUnits = Math.max(1, this.languageMode.injectionCandidateChunkCodeUnits);
    const startIndex = this.buffer.characterIndexForPosition(start);
    const endIndex = this.buffer.characterIndexForPosition(end);
    if (
      this.languageMode.shouldParseSynchronously() ||
      (end.row - start.row <= chunkRows && endIndex - startIndex <= chunkCodeUnits)
    ) {
      return tree.rootNode.descendantsOfType(types, start, end);
    }

    let candidateQuery = null;
    try {
      const patterns = types
        .map((type) =>
          /^[A-Za-z_][A-Za-z0-9_-]*$/.test(type) ? `  (${type})` : `  ${JSON.stringify(type)}`,
        )
        .join("\n");
      candidateQuery = this.grammar._getOrCreateInternalQuerySync(
        `[\n${patterns}\n] @_INJECTION_CANDIDATE_`,
      );
    } catch {
      // A type the query compiler doesn't recognize can still use the slower
      // compatibility traversal.
    }

    return this._collectInjectionCandidateNodesInChunks(
      tree,
      types,
      start,
      end,
      startIndex,
      endIndex,
      chunkRows,
      chunkCodeUnits,
      injectionPointVersion,
      candidateQuery,
    );
  }

  _collectStaticInjectionCandidates(tree, range, injectionPointVersion) {
    const query = this.queries.injectionsQuery;
    if (!query) return [];
    const treeRange = rangeForNode(tree.rootNode);
    const start = Point.max(range.start, treeRange.start);
    const end = Point.min(range.end, treeRange.end);
    if (start.compare(end) >= 0) return [];
    const chunkRows = Math.max(1, this.languageMode.injectionCandidateChunkRows);
    const chunkCodeUnits = Math.max(1, this.languageMode.injectionCandidateChunkCodeUnits);
    const startIndex = this.buffer.characterIndexForPosition(start);
    const endIndex = this.buffer.characterIndexForPosition(end);
    if (
      this.languageMode.shouldParseSynchronously() ||
      (end.row - start.row <= chunkRows && endIndex - startIndex <= chunkCodeUnits)
    ) {
      return collectInjectionMatches(
        query.matches(tree.rootNode, { startPosition: start, endPosition: end }),
        query.injectionDescriptors,
      ).records;
    }
    return this._collectStaticInjectionCandidatesInChunks(
      tree,
      query,
      start,
      end,
      startIndex,
      endIndex,
      chunkRows,
      chunkCodeUnits,
      injectionPointVersion,
    );
  }

  async _collectStaticInjectionCandidatesInChunks(
    tree,
    query,
    start,
    end,
    startIndex,
    endIndex,
    chunkRows,
    chunkCodeUnits,
    injectionPointVersion,
  ) {
    let state;
    let records = [];
    let chunkStart = start;
    let chunkStartIndex = startIndex;
    while (chunkStartIndex < endIndex) {
      const nextRow = Math.min(end.row, chunkStart.row + chunkRows);
      const rowEnd = nextRow === end.row ? end : new Point(nextRow, 0);
      const chunkEndIndex = Math.min(
        endIndex,
        this.buffer.characterIndexForPosition(rowEnd),
        chunkStartIndex + chunkCodeUnits,
      );
      const chunkEnd =
        chunkEndIndex === endIndex ? end : this.buffer.positionForCharacterIndex(chunkEndIndex);
      ({ records, state } = collectInjectionMatches(
        query.matches(tree.rootNode, { startPosition: chunkStart, endPosition: chunkEnd }),
        query.injectionDescriptors,
        state,
      ));
      if (chunkEndIndex >= endIndex) break;
      await this.languageMode._yieldForInjectionCandidateScan();
      if (!this._injectionCandidateScanIsCurrent(tree, injectionPointVersion)) return null;
      chunkStart = chunkEnd;
      chunkStartIndex = chunkEndIndex;
    }
    return records;
  }

  async _collectInjectionCandidateNodesInChunks(
    tree,
    types,
    start,
    end,
    startIndex,
    endIndex,
    chunkRows,
    chunkCodeUnits,
    injectionPointVersion,
    candidateQuery,
  ) {
    const result = [];
    const seenNodeIds = new Set();
    const rootNode = tree.rootNode;
    let chunkStart = start;
    let chunkStartIndex = startIndex;

    while (chunkStartIndex < endIndex) {
      const nextRow = Math.min(end.row, chunkStart.row + chunkRows);
      const rowChunkEnd = nextRow === end.row ? end : new Point(nextRow, 0);
      const rowChunkEndIndex = this.buffer.characterIndexForPosition(rowChunkEnd);
      const codeUnitChunkEndIndex = Math.min(endIndex, chunkStartIndex + chunkCodeUnits);
      let chunkEndIndex = Math.min(rowChunkEndIndex, codeUnitChunkEndIndex);
      if (chunkEndIndex <= chunkStartIndex) {
        chunkEndIndex = codeUnitChunkEndIndex;
      }
      const chunkEnd =
        chunkEndIndex === endIndex ? end : this.buffer.positionForCharacterIndex(chunkEndIndex);

      const chunkNodes = candidateQuery
        ? candidateQuery
            .captures(rootNode, {
              startPosition: chunkStart,
              endPosition: chunkEnd,
            })
            .map((capture) => capture.node)
        : rootNode.descendantsOfType(types, chunkStart, chunkEnd);
      for (const node of chunkNodes) {
        if (seenNodeIds.has(node.id)) continue;
        seenNodeIds.add(node.id);
        result.push(node);
      }

      if (chunkEndIndex >= endIndex) break;
      await this.languageMode._yieldForInjectionCandidateScan();
      if (!this._injectionCandidateScanIsCurrent(tree, injectionPointVersion)) {
        return null;
      }
      chunkStart = chunkEnd;
      chunkStartIndex = chunkEndIndex;
    }

    return result;
  }

  _reconcileInjections(
    nodes,
    nodeRangeSet,
    existingInjectionMarkers,
    rangesByInjectionMarker,
    injectionPointsByType,
    tree,
    injectionPointVersion,
    existingCombinedMembers = [],
    affectedCombinedGroups = [],
    staticCandidates = [],
  ) {
    const plan = {
      nodes,
      nodeRangeSet,
      injectionPointsByType,
      tree,
      injectionPointVersion,
      nodeIndex: 0,
      injectionPointIndex: 0,
      staticCandidates,
      staticCandidateIndex: 0,
      candidates: [],
      combinedCandidates: [],
      existingCombinedMembers,
      affectedCombinedGroups,
      recognizedLanguageNames: new Set(),
      unrecognizedLanguageNames: new Set(),
      grammarsByLanguageName: new Map(),
      phase: "static-candidates",
      candidateIndex: 0,
      existingInjectionMarkers,
      rangesByInjectionMarker,
      existingInjectionMarkerIndex: 0,
      claimedMarkers: new Set(),
      assignments: [],
    };
    const chunkSize = this.languageMode.shouldParseSynchronously()
      ? Infinity
      : Math.max(1, this.languageMode.injectionReconcileChunkSize);

    const commit = (completedPlan) => {
      if (!completedPlan || !this._injectionCandidateScanIsCurrent(tree, injectionPointVersion)) {
        this._discardPreparedCombinedMembers(plan);
        return;
      }
      return this._commitInjectionPlan(completedPlan);
    };
    try {
      if (this._advanceInjectionPlan(plan, chunkSize, tree, injectionPointVersion)) {
        return commit(plan);
      }
    } catch (error) {
      this._discardPreparedCombinedMembers(plan);
      throw error;
    }
    return this._finishInjectionPlanInChunks(plan, chunkSize, tree, injectionPointVersion)
      .then(commit)
      .catch((error) => {
        this._discardPreparedCombinedMembers(plan);
        throw error;
      });
  }

  _advanceInjectionPlan(plan, chunkSize, tree, injectionPointVersion) {
    let operations = 0;
    const isCurrent = () => this._injectionCandidateScanIsCurrent(tree, injectionPointVersion);

    if (plan.phase === "static-candidates") {
      while (plan.staticCandidateIndex < plan.staticCandidates.length) {
        if (!isCurrent()) {
          plan.stale = true;
          return true;
        }
        const { node, injectionPoint, languageName, contentNodes } =
          plan.staticCandidates[plan.staticCandidateIndex++];
        const grammar = this._grammarForInjectionLanguage(plan, languageName);
        if (grammar && grammar._matchesInjectionContent(node)) {
          this._appendInjectionCandidate(
            plan,
            node,
            injectionPoint,
            languageName,
            contentNodes,
            grammar,
            isCurrent,
          );
          if (plan.stale) return true;
        }
        if (++operations >= chunkSize) return false;
      }
      plan.phase = "candidates";
    }

    if (plan.phase === "candidates") {
      while (plan.nodeIndex < plan.nodes.length) {
        const node = plan.nodes[plan.nodeIndex];
        const injectionPoints = plan.injectionPointsByType[node.type] ?? [];

        while (plan.injectionPointIndex < injectionPoints.length) {
          if (!isCurrent()) {
            plan.stale = true;
            return true;
          }

          const injectionPoint = injectionPoints[plan.injectionPointIndex++];
          operations++;

          const languageName = injectionPoint.language(node);
          if (!isCurrent()) {
            plan.stale = true;
            return true;
          }

          if (languageName) {
            const grammar = this._grammarForInjectionLanguage(plan, languageName);

            if (grammar) {
              const contentNodes = injectionPoint.content(node, this.buffer);
              if (!isCurrent()) {
                plan.stale = true;
                return true;
              }
              if (contentNodes) {
                const injectionNodes = Array.isArray(contentNodes) ? contentNodes : [contentNodes];
                if (injectionNodes.length > 0) {
                  this._appendInjectionCandidate(
                    plan,
                    node,
                    injectionPoint,
                    languageName,
                    injectionNodes,
                    grammar,
                    isCurrent,
                  );
                  if (plan.stale) return true;
                }
              }
            }
          }

          if (operations >= chunkSize) return false;
        }

        plan.nodeIndex++;
        plan.injectionPointIndex = 0;
      }

      // Static and dynamic discovery each preserve order independently. Pair
      // their union in owner order so existing markers remain reusable.
      if (plan.staticCandidates.length > 0) {
        plan.candidates.sort((a, b) => a.injectionRange.compare(b.injectionRange));
      }
      plan.phase = "pairing";
    }

    while (plan.candidateIndex < plan.candidates.length) {
      if (!isCurrent()) {
        plan.stale = true;
        return true;
      }

      const candidate = plan.candidates[plan.candidateIndex++];
      const { grammar, injectionPoint, injectionRange } = candidate;
      let marker;

      for (
        let index = plan.existingInjectionMarkerIndex;
        index < plan.existingInjectionMarkers.length;
        index++
      ) {
        const existingMarker = plan.existingInjectionMarkers[index];
        const comparison = plan.rangesByInjectionMarker.get(existingMarker).compare(injectionRange);
        if (comparison > 0) {
          break;
        } else if (comparison === 0) {
          if (
            !plan.claimedMarkers.has(existingMarker) &&
            existingMarker.languageLayer.grammar === grammar &&
            existingMarker.languageLayer.injectionPoint === injectionPoint
          ) {
            marker = existingMarker;
            plan.claimedMarkers.add(existingMarker);
            break;
          }
        } else {
          plan.existingInjectionMarkerIndex = index + 1;
        }
      }

      plan.assignments.push({ candidate, marker });
      operations++;
      if (operations >= chunkSize) return false;
    }

    return true;
  }

  _grammarForInjectionLanguage(plan, languageName) {
    if (!plan.grammarsByLanguageName.has(languageName)) {
      plan.grammarsByLanguageName.set(
        languageName,
        this.languageMode.grammarForLanguageString(languageName),
      );
    }
    const grammar = plan.grammarsByLanguageName.get(languageName);
    if (grammar) plan.recognizedLanguageNames.add(languageName);
    else plan.unrecognizedLanguageNames.add(languageName);
    return grammar;
  }

  _appendInjectionCandidate(
    plan,
    node,
    injectionPoint,
    languageName,
    injectionNodes,
    grammar,
    isCurrent,
  ) {
    this.languageMode.emitInjectionGrammarUsed(grammar);
    if (!isCurrent()) {
      plan.stale = true;
      return;
    }
    const candidate = {
      grammar,
      injectionPoint,
      languageName,
      injectionRange: node.range,
      nodeRangeSet: new NodeRangeSet(plan.nodeRangeSet, injectionNodes, injectionPoint),
    };
    const combined =
      typeof injectionPoint.combined === "function"
        ? injectionPoint.combined(node)
        : injectionPoint.combined;
    if (!isCurrent()) {
      plan.stale = true;
      return;
    }
    if (combined) {
      plan.combinedCandidates.push(candidate);
      candidate.preparedMember = this._prepareCombinedInjectionMember(candidate);
    } else plan.candidates.push(candidate);
  }
  async _finishInjectionPlanInChunks(plan, chunkSize, tree, injectionPointVersion) {
    while (true) {
      await this.languageMode._yieldForInjectionReconcile();
      if (!this._injectionCandidateScanIsCurrent(tree, injectionPointVersion)) {
        return null;
      }
      if (this._advanceInjectionPlan(plan, chunkSize, tree, injectionPointVersion)) {
        return plan;
      }
    }
  }

  _commitInjectionPlan(plan) {
    if (plan.stale) {
      this._discardPreparedCombinedMembers(plan);
      return;
    }

    const createdMarkers = [];
    const markersToUpdate = new Map();

    try {
      for (const assignment of plan.assignments) {
        const { candidate } = assignment;
        let { marker } = assignment;
        const { grammar, injectionPoint, languageName, injectionRange, nodeRangeSet } = candidate;

        if (!marker) {
          marker = this.languageMode.injectionsMarkerLayer.markRange(injectionRange);
          createdMarkers.push(marker);
          marker.languageLayer = new LanguageLayer(
            marker,
            this.languageMode,
            grammar,
            this.depth + 1,
            injectionPoint,
          );
          marker.parentLanguageLayer = this;
          marker.languageString = languageName;
          this.childLayerMarkers.add(marker);
        }

        markersToUpdate.set(marker, nodeRangeSet);
      }
      this._commitCombinedInjections(plan, markersToUpdate, createdMarkers);
    } catch (error) {
      for (const marker of createdMarkers) {
        this.childLayerMarkers.delete(marker);
        if (marker.languageLayer) {
          marker.languageLayer.destroy();
        } else {
          marker.destroy();
        }
      }
      throw error;
    }

    const staleRanges = [];
    for (const marker of plan.existingInjectionMarkers) {
      if (!plan.claimedMarkers.has(marker)) {
        staleRanges.push(marker.getRange());
        this.childLayerMarkers.delete(marker);
        marker.languageLayer.destroy();
      }
    }

    for (const languageName of plan.recognizedLanguageNames) {
      this.unrecognizedLanguageStrings.delete(languageName);
      this.recognizedLanguageStrings.add(languageName);
    }
    for (const languageName of plan.unrecognizedLanguageNames) {
      this.unrecognizedLanguageStrings.add(languageName);
      this.recognizedLanguageStrings.delete(languageName);
    }

    for (const staleRange of staleRanges) {
      this.languageMode.emitRangeUpdate(staleRange);
    }

    const promises = [];
    for (const [marker, ranges] of markersToUpdate) {
      const result = marker.languageLayer.update(ranges);
      if (result?.then) promises.push(result);
    }

    return promises.length > 0 ? Promise.all(promises) : undefined;
  }

  _prepareCombinedInjectionMember({ injectionPoint, injectionRange, nodeRangeSet }) {
    // Resolve child subtraction per member; apply parent intersection and
    // newline/whitespace joins only after every member has been combined.
    const memberRanges = new NodeRangeSet(null, [], injectionPoint);
    memberRanges.nodeSpecs = nodeRangeSet.nodeSpecs;
    memberRanges.newlinesBetween = false;
    const ranges = memberRanges.getRanges(this.buffer);
    if (ranges.length === 0) return null;
    this.combinedInjectionMembersLayer ??= this.buffer.addMarkerLayer();
    const marker = this.combinedInjectionMembersLayer.markRange(injectionRange);
    return {
      marker,
      contentMarkers: ranges.map((range) => {
        const contentRange = rangeForNode(range);
        // Both roles use this layer's default marker options. A single exact
        // content range therefore follows every splice exactly like its owner.
        return ranges.length === 1 && contentRange.isEqual(injectionRange)
          ? marker
          : this.combinedInjectionMembersLayer.markRange(contentRange);
      }),
      initialRange: injectionRange,
      initialNodeSpecs: ranges,
    };
  }

  _discardPreparedCombinedMembers(plan) {
    for (const candidate of plan.combinedCandidates) {
      const member = candidate.preparedMember;
      if (!member || member.group) continue;
      this._destroyCombinedInjectionMember(member);
    }
  }

  _destroyCombinedInjectionMember(member) {
    member.marker.destroy();
    for (const marker of member.contentMarkers) {
      if (marker !== member.marker) marker.destroy();
    }
  }

  _commitCombinedInjections(plan, markersToUpdate, createdMarkers) {
    if (
      plan.combinedCandidates.length === 0 &&
      plan.existingCombinedMembers.length === 0 &&
      plan.affectedCombinedGroups.length === 0
    )
      return;
    const changedGroups = new Set(plan.affectedCombinedGroups);
    const changedTopology = new Set();
    const retainedMembers = new Set();
    const membersByPoint = new Map();
    const memberKey = (languageName, range) => `${languageName}:${range.toString()}`;
    for (const member of plan.existingCombinedMembers) {
      const { injectionPoint, languageName } = member.group;
      let byRange = membersByPoint.get(injectionPoint);
      if (!byRange) {
        byRange = new Map();
        membersByPoint.set(injectionPoint, byRange);
      }
      const key = memberKey(languageName, member.marker.getRange());
      let matching = byRange.get(key);
      if (!matching) {
        matching = [];
        byRange.set(key, matching);
      }
      matching.push(member);
    }
    for (const candidate of plan.combinedCandidates) {
      const prepared = candidate.preparedMember;
      if (!prepared) continue;
      const matching = membersByPoint
        .get(candidate.injectionPoint)
        ?.get(memberKey(candidate.languageName, candidate.injectionRange));
      const existing = matching?.find(
        (member) =>
          !retainedMembers.has(member) &&
          member.group.injectionPoint === candidate.injectionPoint &&
          member.group.grammar === candidate.grammar &&
          member.group.languageName === candidate.languageName &&
          member.marker.getRange().isEqual(candidate.injectionRange) &&
          member.contentMarkers.length === prepared.contentMarkers.length &&
          member.contentMarkers.every((marker, index) =>
            marker.getRange().isEqual(prepared.contentMarkers[index].getRange()),
          ),
      );
      if (!existing) continue;
      retainedMembers.add(existing);
      this._destroyCombinedInjectionMember(prepared);
      candidate.preparedMember = null;
      changedGroups.add(existing.group);
      this._updateCombinedMemberLimit(existing.group.pool, changedGroups, changedTopology);
    }
    for (const member of plan.existingCombinedMembers) {
      if (retainedMembers.has(member)) continue;
      member.group.members.delete(member);
      this._destroyCombinedInjectionMember(member);
      if (
        member.group.members.size === 0 &&
        (!member.group.marker || member.group.marker.languageLayer.destroyed)
      ) {
        member.group.pool.pruneEmptyGroups = true;
      }
      changedGroups.add(member.group);
      changedTopology.add(member.group);
    }
    for (const candidate of plan.combinedCandidates) {
      const { injectionPoint, grammar, languageName, preparedMember: member } = candidate;
      if (!member) continue;
      let byLanguage = this.combinedInjectionGroups.get(injectionPoint);
      if (!byLanguage) {
        byLanguage = new Map();
        this.combinedInjectionGroups.set(injectionPoint, byLanguage);
      }
      let pool = byLanguage.get(languageName);
      if (pool && pool.grammar !== grammar) {
        // A newly available grammar can replace the previous exact alias
        // target. Retire every old group, including any outside this scan.
        for (const group of pool.groups) {
          for (const oldMember of group.members) {
            this._destroyCombinedInjectionMember(oldMember);
          }
          group.members.clear();
          changedGroups.add(group);
        }
        pool.groups = [];
        pool = null;
      }
      if (!pool) {
        pool = { injectionPoint, grammar, languageName, groups: [], maxMembers: Infinity };
        byLanguage.set(languageName, pool);
      }
      this._updateCombinedMemberLimit(pool, changedGroups, changedTopology);
      const group = this._combinedGroupForRange(pool, candidate.injectionRange);
      member.group = group;
      member.marker.combinedInjectionMember = member;
      group.members.add(member);
      const extent = this._combinedGroupExtent(group);
      group.pendingExtent = extent
        ? extent.union(candidate.injectionRange)
        : candidate.injectionRange;
      changedGroups.add(group);
      changedTopology.add(group);
      if (group.members.size > pool.maxMembers)
        this._splitCombinedGroup(group, changedGroups, changedTopology);
    }
    this._compactCombinedGroups(changedGroups, changedTopology);
    for (const group of changedGroups) {
      if (group.marker?.languageLayer.destroyed) group.marker = null;
      if (group.members.size === 0) {
        if (group.marker) {
          this.languageMode.emitRangeUpdate(group.marker.getRange());
          group.marker.languageLayer.destroy();
        }
        const byLanguage = this.combinedInjectionGroups.get(group.injectionPoint);
        if (byLanguage?.get(group.languageName) === group.pool && group.pool.groups.length === 0)
          byLanguage.delete(group.languageName);
        if (byLanguage?.size === 0) this.combinedInjectionGroups.delete(group.injectionPoint);
        continue;
      }
      const layer = group.marker?.languageLayer;
      const optionsUnchanged =
        group.rangeSet?.newlinesBetween === group.injectionPoint.newlinesBetween &&
        group.rangeSet?.includeAdjacentWhitespace ===
          group.injectionPoint.includeAdjacentWhitespace;
      if (
        !changedTopology.has(group) &&
        layer?.includedRangesAreCurrent &&
        optionsUnchanged &&
        group.rangeSet.previous === plan.nodeRangeSet &&
        group.rangeSet.previousVersion === plan.nodeRangeSet?.version
      ) {
        // Content changed while every range stayed put. Reuse both the
        // serialized parser ranges and the current-range marker list.
        if (
          layer.tree &&
          !layer.treeIsDirty &&
          layer.tree.revision === this.buffer.getTextRevision() &&
          !layer.currentParsePromise &&
          !layer.injectionPopulationNeedsRetry &&
          !layer.rootRangePolicyNeedsUpdate &&
          layer.includedRangesAreCurrent
        ) {
          // Discovery can widen across an adjacent owner even when the edit
          // touched only a hole. Its content and topology are still unchanged.
          if (!layer.hasInjectionDescendants()) continue;
          markersToUpdate.set(group.marker, {
            rootRangeSet: group.rangeSet.rootRangeSet,
            rangesUnchanged: true,
            getRanges: () => layer.lastIncludedRanges,
            injectionOnly: true,
            injectionOnlyParentSnapshot: {
              layer: this,
              tree: plan.tree,
              injectionPointVersion: plan.injectionPointVersion,
            },
          });
          continue;
        }
        markersToUpdate.set(group.marker, {
          rootRangeSet: group.rangeSet.rootRangeSet,
          rangesUnchanged: true,
          getRanges: () => layer.lastIncludedRanges,
        });
        continue;
      }
      const nodes = [];
      let extent = null;
      for (const member of group.members) {
        const range = member.initialRange ?? member.marker.getRange();
        extent = extent ? extent.union(range) : range;
        if (member.initialNodeSpecs) {
          nodes.push(...member.initialNodeSpecs);
          member.initialNodeSpecs = null;
          member.initialRange = null;
        } else {
          for (const marker of member.contentMarkers) {
            nodes.push(rangeToTreeSitterRangeSpec(marker.getRange(), this.buffer));
          }
        }
      }
      const ranges = new NodeRangeSet(plan.nodeRangeSet, nodes, {
        ...group.injectionPoint,
        includeChildren: true,
      });
      group.rangeSet = ranges;
      if (!group.marker) {
        const marker = this.languageMode.injectionsMarkerLayer.markRange(extent);
        createdMarkers.push(marker);
        marker.combinedInjectionGroup = group;
        marker.parentLanguageLayer = this;
        marker.languageString = group.languageName;
        marker.languageLayer = new LanguageLayer(
          marker,
          this.languageMode,
          group.grammar,
          this.depth + 1,
          group.injectionPoint,
        );
        this.childLayerMarkers.add(marker);
        group.marker = marker;
      } else {
        group.marker.setRange(extent);
      }
      group.pendingExtent = null;
      markersToUpdate.set(group.marker, ranges);
    }
  }

  _createCombinedGroup(pool, index) {
    const { injectionPoint, grammar, languageName } = pool;
    const group = { injectionPoint, grammar, languageName, pool, members: new Set(), marker: null };
    pool.groups.splice(index, 0, group);
    return group;
  }

  _combinedGroupExtent(group) {
    return (
      group.pendingExtent ??
      (group.marker && !group.marker.languageLayer.destroyed
        ? group.marker.getRange()
        : this._combinedMembersExtent(group.members))
    );
  }

  _combinedGroupForRange(pool, range) {
    if (pool.pruneEmptyGroups) {
      // A cancelled child can leave owner markers until the next parent
      // reconciliation. Empty dead groups have no usable extent or parser.
      pool.groups = pool.groups.filter(
        (group) =>
          group.members.size > 0 || (group.marker && !group.marker.languageLayer.destroyed),
      );
      pool.pruneEmptyGroups = false;
    }
    const { groups, maxMembers } = pool;
    if (groups.length === 0) return this._createCombinedGroup(pool, 0);
    if (maxMembers === Infinity) return groups[0];
    // Initial discovery is in source order. Keep that common append path
    // constant-time, without looking through every existing group per owner.
    const finalGroup = last(groups);
    if (!range.start.isLessThan(this._combinedGroupExtent(finalGroup).end)) {
      return finalGroup.members.size < maxMembers
        ? finalGroup
        : this._createCombinedGroup(pool, groups.length);
    }
    let low = 0;
    let high = groups.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this._combinedGroupExtent(groups[middle]).start.isGreaterThan(range.start)) high = middle;
      else low = middle + 1;
    }
    const index = Math.max(0, low - 1);
    const group = groups[index];
    if (group.members.size < maxMembers) return group;
    const extent = this._combinedGroupExtent(group);
    if (!range.end.isGreaterThan(extent.start)) return this._createCombinedGroup(pool, index);
    if (!range.start.isLessThan(extent.end)) return this._createCombinedGroup(pool, index + 1);
    return group;
  }

  _combinedMembersExtent(members) {
    let extent = null;
    for (const member of members) {
      const range = member.initialRange ?? member.marker.getRange();
      extent = extent ? extent.union(range) : range;
    }
    return extent;
  }

  _splitCombinedGroup(group, changedGroups, changedTopology) {
    const { pool } = group;
    const members = [...group.members].sort((a, b) =>
      (a.initialRange ?? a.marker.getRange()).compare(b.initialRange ?? b.marker.getRange()),
    );
    const split = Math.ceil(members.length / 2);
    const next = this._createCombinedGroup(pool, pool.groups.indexOf(group) + 1);
    group.members = new Set(members.slice(0, split));
    next.members = new Set(members.slice(split));
    for (const member of next.members) member.group = next;
    for (const item of [group, next]) {
      item.pendingExtent = this._combinedMembersExtent(item.members);
      changedGroups.add(item);
      changedTopology.add(item);
    }
  }

  _updateCombinedMemberLimit(pool, changedGroups, changedTopology) {
    const value = pool.injectionPoint.combinedMaxMembers;
    // Registration validates the option. Ignore a later invalid direct
    // mutation rather than allowing an impossible zero-member split loop.
    const limit = Number.isSafeInteger(value) && value > 0 ? value : Infinity;
    if (pool.maxMembers === limit) return;
    pool.maxMembers = limit;
    for (let index = 0; index < pool.groups.length; index++) {
      const group = pool.groups[index];
      changedGroups.add(group);
      changedTopology.add(group);
      while (group.members.size > limit)
        this._splitCombinedGroup(group, changedGroups, changedTopology);
    }
  }

  _compactCombinedGroups(changedGroups, changedTopology) {
    const pools = new Set([...changedTopology].map((group) => group.pool));
    const eligible = new Set(changedTopology);
    for (const pool of pools) {
      const compacted = [];
      let removedNeighbor = false;
      // Build the ordered array once. Repeated indexOf/splice would make
      // initial cap=1 and whole-document deletion quadratic in group count.
      for (const group of pool.groups) {
        const previous = last(compacted);
        if (group.members.size === 0) {
          removedNeighbor = true;
          if (previous) eligible.add(previous);
          continue;
        }
        if (removedNeighbor) eligible.add(group);
        removedNeighbor = false;
        if (
          previous &&
          (eligible.has(previous) || eligible.has(group)) &&
          previous.members.size + group.members.size <= pool.maxMembers
        ) {
          const extent = this._combinedGroupExtent(previous).union(
            this._combinedGroupExtent(group),
          );
          for (const member of group.members) {
            member.group = previous;
            previous.members.add(member);
          }
          group.members.clear();
          previous.pendingExtent = extent;
          eligible.add(previous);
          for (const item of [previous, group]) {
            changedGroups.add(item);
            changedTopology.add(item);
          }
        } else compacted.push(group);
      }
      pool.groups = compacted;
    }
  }
}

class PendingHighlightIterator extends NullLanguageModeHighlightIterator {
  constructor(languageMode, presentation = false, owner = null) {
    super();
    this.languageMode = languageMode;
    this.presentation = presentation;
    this.owner = owner;
  }

  seek(position, endRow) {
    const mode = this.languageMode;
    position = Point.fromObject(position);
    // Screen lines built without a current snapshot must be rebuilt when it
    // arrives, including unchanged lines queried beside the edited rows.
    const range = mode.buffer.clipRange(
      new Range([position.row, 0], [endRow == null ? Infinity : endRow + 1, 0]),
    );
    if (mode.publicationPending) mode.publicationRanges.add(range);
    if (this.presentation && !this.owner) mode.presentation.request(position.row, range.end.row);
    const cached = mode.highlightCache.read(position, range.end, [
      mode.idForScope(mode.grammar.scopeName),
    ]);
    this.iterator = cached.iterator;
    return cached.scopes;
  }
  getPosition() {
    return this.iterator?.getPosition() ?? Point.INFINITY;
  }
  getOpenScopeIds() {
    return this.iterator?.getOpenScopeIds() ?? [];
  }
  getCloseScopeIds() {
    return this.iterator?.getCloseScopeIds() ?? [];
  }
  moveToSuccessor() {
    return this.iterator?.moveToSuccessor();
  }
}

/**
 * An injection `LanguageLayer` may need to parse and highlight a
 * strange subset of its stated range — for instance, all the descendants
 * within a parent that are of a particular type. A `NodeRangeSet` is how that
 * strange subset is expressed.
 *
 * @private
 */
class NodeRangeSet {
  constructor(previous, nodes, injectionPoint) {
    this.previous = previous;
    this.previousVersion = previous?.version;
    this.rootRangeSet = previous?.isRootLanguageRangeSet ? previous : previous?.rootRangeSet;
    this.newlinesBetween = injectionPoint.newlinesBetween;
    this.includeAdjacentWhitespace = injectionPoint.includeAdjacentWhitespace;
    this.includeChildren = injectionPoint.includeChildren;
    this.excludeChildrenLines = injectionPoint.excludeChildrenLines;

    // We shouldn't retain references to nodes here because the tree might get
    // disposed of later. Let's compile the information we need now while we're
    // sure the tree is fresh.
    this.nodeSpecs = [];
    for (let node of nodes) {
      this.nodeSpecs.push(this.getNodeSpec(node, !this.includeChildren));
    }
    this.nodeSpecs.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
  }

  // Extracts the information we need from fresh tree nodes so that it's
  // guaranteed to survive even if the tree is destroyed.
  getNodeSpec(node, getChildren) {
    let { startIndex, endIndex, startPosition, endPosition } = node;
    let result = { startIndex, endIndex, startPosition, endPosition };
    if (getChildren && node.childCount > 0) {
      result.children = [];
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        result.children.push(this.getNodeSpec(child, false));
      }
    }
    return result;
  }

  getRanges(buffer) {
    const previousRanges = this.previous?.getRanges(buffer);
    let result = [];

    for (let node of this.nodeSpecs) {
      // An injection point isn't given the point at which the buffer ends, so
      // it's free to return an `endIndex` of `Infinity` here and rely on us to
      // clip it to the boundary of the buffer.
      if (node.endIndex === Infinity) {
        node = this._clipRange(node, buffer);
      }
      let position = node.startPosition,
        index = node.startIndex;

      if (node.children && !this.includeChildren) {
        // If `includeChildren` is `false`, we're effectively collecting all
        // the disjoint text nodes that are direct descendants of this node.
        let children = node.children;
        if (this.excludeChildrenLines) {
          children = [];
          for (const child of node.children) {
            if (child.endIndex <= child.startIndex) continue;
            const startPosition = Point.max(
              node.startPosition,
              new Point(child.startPosition.row, 0),
            );
            const nextRow = child.endPosition.row + (child.endPosition.column === 0 ? 0 : 1);
            const endPosition = Point.min(node.endPosition, buffer.clipPosition([nextRow, 0]));
            const startIndex = Math.max(
              node.startIndex,
              buffer.characterIndexForPosition(startPosition),
            );
            const endIndex = Math.min(node.endIndex, buffer.characterIndexForPosition(endPosition));
            if (endIndex <= startIndex) continue;
            const previous = children.at(-1);
            if (previous && startIndex <= previous.endIndex) {
              if (endIndex > previous.endIndex) {
                previous.endIndex = endIndex;
                previous.endPosition = endPosition;
              }
            } else children.push({ startIndex, endIndex, startPosition, endPosition });
          }
        }
        for (const child of children) {
          const nextIndex = child.startIndex;
          if (nextIndex > index) {
            this._pushRange(buffer, previousRanges, result, {
              startIndex: index,
              endIndex: nextIndex,
              startPosition: position,
              endPosition: child.startPosition,
            });
          }
          position = child.endPosition;
          index = child.endIndex;
        }
      }

      if (node.endIndex > index) {
        this._pushRange(buffer, previousRanges, result, {
          startIndex: index,
          endIndex: node.endIndex,
          startPosition: position,
          endPosition: node.endPosition,
        });
      }
    }

    if (this.includeAdjacentWhitespace && result.length > 1) {
      const rangesWithWhitespace = [result[0]];
      // Look at the region between each pair of results. If it's entirely
      // whitespace, include it in the range.
      for (let i = 1; i < result.length; i++) {
        let current = result[i],
          previous = result[i - 1];
        if (current.startIndex !== previous.endIndex) {
          let pseudoRange = {
            startPosition: previous.endPosition,
            startIndex: previous.endIndex,
            endPosition: current.startPosition,
            endIndex: current.startIndex,
          };
          let rangeText = buffer.getTextInRange(rangeForNode(pseudoRange));
          if (!/\S/.test(rangeText)) {
            rangesWithWhitespace.push(pseudoRange);
          }
        }
        rangesWithWhitespace.push(current);
      }
      result = rangesWithWhitespace;
    }
    if (this.rootRangeSet && (this.newlinesBetween || this.includeAdjacentWhitespace)) {
      const clipped = [];
      const rootRanges = this.rootRangeSet.getRanges(buffer);
      for (const range of result) this._pushRange(buffer, rootRanges, clipped, range, false);
      result = clipped;
    }
    return this._consolidateRanges(result);
  }

  _clipRange(range, buffer) {
    // Convert this range spec to an actual `Range`, clip it, then convert it
    // back to a range spec with accurate `startIndex` and `endIndex` values.
    let clippedRange = buffer.clipRange(rangeForNode(range));
    return rangeToTreeSitterRangeSpec(clippedRange, buffer);
  }

  // Combine adjacent ranges to minimize the number of boundaries.
  _consolidateRanges(ranges) {
    if (ranges.length === 1) {
      return ranges;
    }
    let consolidated = [];
    let candidate;
    let lastIndex = ranges.length - 1;
    for (let i = 0; i < ranges.length; i++) {
      let range = ranges[i];
      if (!candidate) {
        candidate = range;
        continue;
      }
      if (candidate.endIndex === range.startIndex) {
        // Keep enlarging the last node for as long as subsequent nodes are
        // adjacent to it.
        candidate = {
          startIndex: candidate.startIndex,
          startPosition: candidate.startPosition,
          endIndex: range.endIndex,
          endPosition: range.endPosition,
        };
        if (i === lastIndex) {
          consolidated.push(candidate);
        }
      } else {
        // We found a disjoint range, so push our candidate into the result set
        // and promote a new candidate (unless we're at the end).
        consolidated.push(candidate);
        if (i === lastIndex) {
          consolidated.push(range);
        } else {
          candidate = range;
        }
      }
    }

    return consolidated;
  }

  _pushRange(buffer, previousRanges, newRanges, newRange, allowNewline = true) {
    if (!previousRanges) {
      if (allowNewline && this.newlinesBetween) {
        const { startIndex, startPosition } = newRange;
        this._ensureNewline(buffer, newRanges, startIndex, startPosition);
      }
      newRanges.push(newRange);
      return;
    }

    let low = 0;
    let high = previousRanges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (previousRanges[middle].endIndex <= newRange.startIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    for (let i = low; i < previousRanges.length; i++) {
      const previousRange = previousRanges[i];
      if (previousRange.endIndex <= newRange.startIndex) continue;
      if (previousRange.startIndex >= newRange.endIndex) break;
      const startIndex = Math.max(previousRange.startIndex, newRange.startIndex);
      const endIndex = Math.min(previousRange.endIndex, newRange.endIndex);
      const startPosition = Point.max(previousRange.startPosition, newRange.startPosition);
      const endPosition = Point.min(previousRange.endPosition, newRange.endPosition);
      if (allowNewline && this.newlinesBetween) {
        this._ensureNewline(buffer, newRanges, startIndex, startPosition);
      }
      newRanges.push({ startIndex, endIndex, startPosition, endPosition });
    }
  }

  // For injection points with `newlinesBetween` enabled, ensure that a
  // newline is included between each disjoint range.
  _ensureNewline(buffer, newRanges, startIndex, startPosition) {
    const lastRange = last(newRanges);
    if (lastRange && lastRange.endPosition.row < startPosition.row) {
      const newlineStart = new Point(
        startPosition.row - 1,
        buffer.lineLengthForRow(startPosition.row - 1),
      );
      const newlineIndex = buffer.characterIndexForPosition(newlineStart);
      const overlapsPrevious = lastRange.endIndex > newlineIndex;
      newRanges.push({
        startPosition: overlapsPrevious ? lastRange.endPosition : newlineStart,
        endPosition: new Point(startPosition.row, 0),
        // Include CRLF exactly once, even when the previous node already owns CR.
        startIndex: Math.max(lastRange.endIndex, newlineIndex),
        endIndex: startIndex - startPosition.column,
      });
    }
  }
}

/**
 * A subclass of `Map` that associates a set of scope names with the
 * editor locations at which they are opened.
 *
 * In some complicated scenarios, we need to know where a scope was opened when
 * deciding how to handle it.
 *
 * @private
 */
class OpenScopeMap extends Map {
  removeLastOccurrenceOf(scopeId) {
    let candidateKey;
    // Of the keys whose values include this scope, find the one that occurs
    // latest in the document.
    for (let key of this.keys()) {
      let value = this.get(key);
      if (!value.includes(scopeId)) continue;
      if (!candidateKey || comparePoints(key, candidateKey) === 1) {
        candidateKey = key;
      }
    }
    if (!candidateKey) return false;
    removeLastOccurrenceOf(this.get(candidateKey), scopeId);
    return true;
  }
}

module.exports = TreeSitterLanguageMode;
