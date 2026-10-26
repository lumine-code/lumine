const { TextPatch: Patch } = require("./text-model");
const { Emitter } = require("@lumine-code/event-kit");
const Point = require("./point");
const Range = require("./range");
const DisplayMarkerLayer = require("./display-marker-layer");
const { traverse, traversal, compare, max, isEqual } = require("./point-helpers");
const isCharacterPair = require("./is-character-pair");
const ScreenLineBuilder = require("./screen-line-builder");
const RowSequence = require("./row-sequence");
const ScreenLineCache = require("./screen-line-cache");
const { MAX_BUILT_IN_SCOPE_ID } = require("./constants");
const { isWrapBoundary: defaultIsWrapBoundary } = require("./text-utils");

const SIMPLE_LINE_FAST_PATH_MIN_LENGTH = 4096;
const HARD_TAB_RUN_MIN_LENGTH = 64;
const ASCII_WRAP_BOUNDARY_NONE = 0;
const ASCII_WRAP_BOUNDARY_WHITESPACE = 1;
const ASCII_WRAP_BOUNDARY_STANDARD = 2;
const SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE = 1 << 0;
const ASCII_EVENT_DENSITY_SAMPLE_SIZE = 4096;
const ASCII_EVENT_DENSITY_LIMIT = 0.25;
const WHITESPACE_WRAP_BOUNDARY_CHARACTERS = [" "];
const STANDARD_WRAP_BOUNDARY_CHARACTERS = [" ", "-", "/"];
const WHITESPACE_EVENT_BOUNDARY_CHARACTERS = [" ", "\t"];
const STANDARD_EVENT_BOUNDARY_CHARACTERS = [" ", "\t", "-", "/"];
// eslint-disable-next-line no-control-regex
const ASCII_ONLY_REGEXP = /^[\x00-\x7f]*$/;
const ASCII_WITHOUT_WHITESPACE_REGEXP = /^[^\t \u0080-\uffff]*$/;
const ASCII_WITHOUT_STANDARD_WRAP_BOUNDARIES_REGEXP = /^[^\t \x2d\x2f\u0080-\uffff]*$/;
const GEOMETRY_STABLE_REPLACEMENT_REGEXP = /^[A-Za-z0-9_]+$/;
let nextLayoutGroupId = 1;

class DisplayLayer {
  constructor(id, buffer, params = {}) {
    this.id = id;
    this.buffer = buffer;
    this.layoutGroupId = params.layoutGroupId ?? nextLayoutGroupId++;
    this.layoutState = params.layoutState || createEmptyLayoutState();
    this.emitter = new Emitter();
    this.screenLineBuilder = new ScreenLineBuilder(this);
    this.singleLineHighlightingOwner = {};
    this.cachedScreenLines = new ScreenLineCache();
    this.cachedScreenLines.length = this.screenLineLengths.length;
    this.builtInScopeIdsByFlags = new Map();
    this.builtInClassNamesByScopeId = new Map();
    this.nextBuiltInScopeId = 1;
    this.displayMarkerLayersById = new Map();
    this.destroyed = false;
    this.changesSinceLastEvent = new Patch();
    this.changeOriginsSinceLastEvent = new Set();
    this.mappingGeneration = 0;
    this.windowGeneration = 0;
    this.pendingGeometryStableChange = null;

    this.invisibles = params.invisibles != null ? params.invisibles : {};
    this.tabLength = params.tabLength != null ? params.tabLength : 4;
    this.softWrapColumn =
      params.softWrapColumn != null ? Math.max(1, params.softWrapColumn) : Infinity;
    this.softWrapHangingIndent =
      params.softWrapHangingIndent != null ? params.softWrapHangingIndent : 0;
    this.ratioForCharacter =
      params.ratioForCharacter != null ? params.ratioForCharacter : unitRatio;
    this.standardRatioForCharacter = params.standardRatioForCharacter ?? null;
    this.isWrapBoundary = params.isWrapBoundary != null ? params.isWrapBoundary : isWordStart;
    this.foldCharacter = params.foldCharacter != null ? params.foldCharacter : "⋯";
    this.atomicSoftTabs = params.atomicSoftTabs != null ? params.atomicSoftTabs : true;
    this.resolveSoftWrapColumn = params.resolveSoftWrapColumn ?? null;

    this.eolInvisibles = {
      "\r": this.invisibles.cr,
      "\n": this.invisibles.eol,
      "\r\n": this.invisibles.cr + this.invisibles.eol,
    };

    this.foldsMarkerLayer =
      params.foldsMarkerLayer ||
      buffer.addMarkerLayer({
        // Folds ride the undo history, so undoing an edit that destroyed one
        // brings it back. The buffer restores those markers behind this
        // layer's back, which is why it also calls `foldsDidRestore` — see
        // that method.
        //
        // Every transaction snapshots the layer twice. Those snapshots share
        // unchanged history blocks; edits that move folds still update the
        // affected ranges. See benchmark/marker-history-benchmark.js.
        maintainHistory: true,
        persistent: true,
        destroyInvalidatedMarkers: true,
      });
    // These flags describe fold behavior, not workspace state. Reassert them
    // for marker layers restored from older serialized buffers as well.
    this.foldsMarkerLayer.persistent = true;
    this.foldsMarkerLayer.destroyInvalidatedMarkers = true;
    this.foldsMarkerLayer.enableHistorySnapshots();
    this.foldIdCounter = params.foldIdCounter || 1;

    this.bufferDidChangeLanguageMode();
  }

  get spatialIndex() {
    return this.layoutState.spatialIndex;
  }

  set spatialIndex(value) {
    this.layoutState.spatialIndex = value;
  }

  get tabCounts() {
    return this.layoutState.tabCounts;
  }

  set tabCounts(value) {
    this.layoutState.tabCounts = value;
  }

  get screenLineStartFlags() {
    return this.layoutState.screenLineStartFlags;
  }

  set screenLineStartFlags(value) {
    this.layoutState.screenLineStartFlags = value;
  }

  get screenLineLengths() {
    return this.layoutState.screenLineLengths;
  }

  set screenLineLengths(value) {
    this.layoutState.screenLineLengths = value;
  }

  get rightmostScreenPosition() {
    if (this.layoutState.unwrapped) {
      const position = this.findRightmostScreenPosition();
      if (!isEqual(position, this.layoutState.rightmostScreenPosition)) {
        this.layoutState.rightmostScreenPosition = position;
      }
    }
    return this.layoutState.rightmostScreenPosition;
  }

  set rightmostScreenPosition(value) {
    this.layoutState.rightmostScreenPosition = value;
  }

  get indexedBufferRowCount() {
    return this.layoutState.indexedBufferRowCount;
  }

  set indexedBufferRowCount(value) {
    this.layoutState.indexedBufferRowCount = value;
  }

  static deserialize(buffer, params) {
    const foldsMarkerLayer = buffer.getMarkerLayer(params.foldsMarkerLayerId);
    return new DisplayLayer(params.id, buffer, { foldsMarkerLayer });
  }

  serialize() {
    return {
      id: this.id,
      foldsMarkerLayerId: this.foldsMarkerLayer.id,
      foldIdCounter: this.foldIdCounter,
    };
  }

  reset(params) {
    this.pendingGeometryStableChange = null;
    if (!this.isDestroyed() && this.setParams(params)) {
      this.markMarkerScreenPositionsDirty();
      this.clearSpatialIndex();
      this.emitter.emit("did-reset");
      this.notifyObserversIfMarkerScreenPositionsChanged();
    }
  }

  copy() {
    const copyId = this.buffer.nextDisplayLayerId++;
    const copy = new DisplayLayer(copyId, this.buffer, {
      foldsMarkerLayer: this.foldsMarkerLayer.copy(),
      foldIdCounter: this.foldIdCounter,
      layoutState: this.layoutState,
      invisibles: this.invisibles,
      tabLength: this.tabLength,
      softWrapColumn: this.softWrapColumn,
      softWrapHangingIndent: this.softWrapHangingIndent,
      ratioForCharacter: this.ratioForCharacter,
      standardRatioForCharacter: this.standardRatioForCharacter,
      isWrapBoundary: this.isWrapBoundary,
      foldCharacter: this.foldCharacter,
      atomicSoftTabs: this.atomicSoftTabs,
      resolveSoftWrapColumn: this.resolveSoftWrapColumn,
      layoutGroupId: this.layoutGroupId,
    });
    this.buffer.displayLayers[copyId] = copy;
    return copy;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.singleLineHighlightingOwner.destroyed = true;
    this.cachedScreenLines.length = 0;
    this.foldsMarkerLayer.destroy();
    this.displayMarkerLayersById.forEach((layer) => layer.destroy());
    if (this.languageModeDisposable) this.languageModeDisposable.dispose();
    this.languageModeDisposable = null;
    delete this.buffer.displayLayers[this.id];

    // Error stacks and other consumers can retain a destroyed view. Detach
    // its geometry instead of clearing arrays shared with a surviving split.
    this.clearSpatialIndex();
    this.screenLineBuilder = new ScreenLineBuilder(this);
    this.changesSinceLastEvent = new Patch();
    this.changeOriginsSinceLastEvent.clear();
    this.emitter.dispose();
  }

  isDestroyed() {
    return this.destroyed;
  }

  separateLayoutGroup(preserveSpatialState = true) {
    this.pendingGeometryStableChange = null;
    this.layoutGroupId = nextLayoutGroupId++;
    this.layoutState = preserveSpatialState
      ? copyLayoutState(this.layoutState)
      : createEmptyLayoutState();
  }

  clearSpatialIndex() {
    this.separateLayoutGroup(false);
    this.cachedScreenLines.length = 0;
  }

  doBackgroundWork(deadline) {
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), Infinity, deadline);
    return this.indexedBufferRowCount < this.buffer.getLineCount();
  }

  bufferDidChangeLanguageMode() {
    this.windowGeneration++;
    this.cachedScreenLines.length = 0;
    if (this.languageModeDisposable) this.languageModeDisposable.dispose();
    this.languageModeDisposable = this.buffer.languageMode.onDidChangeHighlighting(
      (bufferRange) => {
        bufferRange = Range.fromObject(bufferRange);
        this.populateSpatialIndexIfNeeded(bufferRange.end.row + 1, Infinity);
        const startBufferRow = this.findBoundaryPrecedingBufferRow(bufferRange.start.row);
        const endBufferRow = this.findBoundaryFollowingBufferRow(bufferRange.end.row + 1);
        const startRow = this.translateBufferPositionWithSpatialIndex(
          Point(startBufferRow, 0),
          "backward",
        ).row;
        const endRow = this.translateBufferPositionWithSpatialIndex(
          Point(endBufferRow, 0),
          "backward",
        ).row;
        const extent = Point(endRow - startRow, 0);
        this.cachedScreenLines.spliceRows(startRow, extent.row, extent.row);
        this.didChange({
          start: Point(startRow, 0),
          oldExtent: extent,
          newExtent: extent,
          origin: "highlight",
        });
      },
    );
  }

  addMarkerLayer(options) {
    const markerLayer = new DisplayMarkerLayer(this, this.buffer.addMarkerLayer(options), true);
    this.displayMarkerLayersById.set(markerLayer.id, markerLayer);
    return markerLayer;
  }

  getMarkerLayer(id) {
    if (this.displayMarkerLayersById.has(id)) {
      return this.displayMarkerLayersById.get(id);
    } else {
      const bufferMarkerLayer = this.buffer.getMarkerLayer(id);
      if (bufferMarkerLayer) {
        const displayMarkerLayer = new DisplayMarkerLayer(this, bufferMarkerLayer, false);
        this.displayMarkerLayersById.set(id, displayMarkerLayer);
        return displayMarkerLayer;
      }
    }
  }

  didDestroyMarkerLayer(id) {
    this.displayMarkerLayersById.delete(id);
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidReset(callback) {
    return this.emitter.on("did-reset", callback);
  }

  bufferRangeForFold(foldId) {
    return this.foldsMarkerLayer.getMarkerRange(foldId);
  }

  foldBufferRange(bufferRange) {
    bufferRange = Range.fromObject(bufferRange);
    const containingFoldMarkers = this.foldsMarkerLayer.findMarkers({ containsRange: bufferRange });
    if (containingFoldMarkers.length === 0) {
      this.populateSpatialIndexIfNeeded(bufferRange.end.row + 1, Infinity);
    }
    this.separateLayoutGroup();
    const foldId = this.foldsMarkerLayer.markRange(bufferRange, {
      invalidate: "overlap",
      exclusive: true,
    }).id;
    if (containingFoldMarkers.length === 0) {
      const foldStartRow = bufferRange.start.row;
      const foldEndRow = bufferRange.end.row + 1;
      this.markMarkerScreenPositionsDirty();
      this.didChange(this.updateSpatialIndex(foldStartRow, foldEndRow, foldEndRow, Infinity));
      this.notifyObserversIfMarkerScreenPositionsChanged();
    }
    return foldId;
  }

  destroyFold(foldId) {
    const foldMarker = this.foldsMarkerLayer.getMarker(foldId);
    if (foldMarker) {
      this.destroyFoldMarkers([foldMarker]);
    }
  }

  destroyAllFolds() {
    return this.destroyFoldMarkers(this.foldsMarkerLayer.findMarkers({}));
  }

  destroyFoldsIntersectingBufferRange(bufferRange) {
    return this.destroyFoldMarkers(
      this.foldsMarkerLayer.findMarkers({
        intersectsRange: this.buffer.clipRange(bufferRange),
      }),
    );
  }

  destroyFoldsContainingBufferPositions(bufferPositions, excludeEndpoints) {
    const markersContainingPositions = new Set();
    for (const position of bufferPositions) {
      const clippedPosition = this.buffer.clipPosition(position);
      const foundMarkers = this.foldsMarkerLayer.findMarkers({
        containsPosition: clippedPosition,
      });
      for (const marker of foundMarkers) {
        if (!excludeEndpoints || marker.getRange().containsPoint(clippedPosition, true)) {
          markersContainingPositions.add(marker);
        }
      }
    }
    const sortedMarkers = Array.from(markersContainingPositions).sort((a, b) => a.compare(b));
    return this.destroyFoldMarkers(sortedMarkers);
  }

  // The buffer's fold ranges, as the spatial index currently believes them to
  // be. Taken before a marker snapshot is restored so the rows that actually
  // moved can be worked out afterwards.
  foldRangesSnapshot() {
    return this.foldsMarkerLayer.findMarkers({}).map((marker) => marker.getRange());
  }

  // Undo and redo restore fold markers directly onto the marker layer, without
  // going through `foldBufferRange` or `destroyFoldMarkers`. Nothing else tells
  // this layer, so its spatial index would keep describing the folds as they
  // were before the restore: the text would come back unfolded while the
  // markers say otherwise. Reconcile over the rows the two sets disagree on.
  foldsDidRestore(previousRanges, origin = "edit") {
    const currentRanges = this.foldRangesSnapshot();
    const changedRows = differingRowSpan(previousRanges, currentRanges);
    if (changedRows == null) return;

    this.separateLayoutGroup();
    const { startRow, endRow } = changedRows;
    this.populateSpatialIndexIfNeeded(endRow + 1, Infinity);
    this.markMarkerScreenPositionsDirty();
    this.didChange({
      ...this.updateSpatialIndex(startRow, endRow + 1, endRow + 1, Infinity),
      origin,
    });
    this.notifyObserversIfMarkerScreenPositionsChanged(origin);
  }

  destroyFoldMarkers(foldMarkers) {
    const foldedRanges = [];
    if (foldMarkers.length === 0) return foldedRanges;

    this.separateLayoutGroup();
    const combinedRangeStart = foldMarkers[0].getStartPosition();
    let combinedRangeEnd = combinedRangeStart;
    for (const foldMarker of foldMarkers) {
      const foldedRange = foldMarker.getRange();
      foldedRanges.push(foldedRange);
      combinedRangeEnd = max(combinedRangeEnd, foldedRange.end);
    }

    this.populateSpatialIndexIfNeeded(combinedRangeEnd.row + 1, Infinity);

    for (const foldMarker of foldMarkers) {
      foldMarker.destroy();
    }

    this.markMarkerScreenPositionsDirty();
    this.didChange(
      this.updateSpatialIndex(
        combinedRangeStart.row,
        combinedRangeEnd.row + 1,
        combinedRangeEnd.row + 1,
        Infinity,
      ),
    );
    this.notifyObserversIfMarkerScreenPositionsChanged();

    return foldedRanges;
  }

  foldsIntersectingBufferRange(bufferRange) {
    return this.foldsMarkerLayer
      .findMarkers({
        intersectsRange: this.buffer.clipRange(bufferRange),
      })
      .map((marker) => marker.id);
  }

  translateBufferPosition(bufferPosition, options) {
    bufferPosition = this.buffer.clipPosition(bufferPosition);
    this.populateSpatialIndexIfNeeded(bufferPosition.row + 1, Infinity);

    const clipDirection = (options && options.clipDirection) || "closest";
    const columnDelta = this.getClipColumnDelta(bufferPosition, clipDirection);
    if (columnDelta !== 0) {
      bufferPosition = Point(bufferPosition.row, bufferPosition.column + columnDelta);
    }

    let screenPosition = this.translateBufferPositionWithSpatialIndex(
      bufferPosition,
      clipDirection,
    );
    const tabCount = this.tabCounts.get(screenPosition.row);
    if (tabCount > 0) {
      screenPosition = shouldSkipHardTabRuns(this, screenPosition, tabCount)
        ? translateHardTabsWithRunSkipping(this, screenPosition, tabCount, true)
        : this.expandHardTabs(screenPosition, bufferPosition, tabCount);
    }

    return Point.fromObject(screenPosition);
  }

  translateBufferPositionWithSpatialIndex(bufferPosition, clipDirection) {
    // Most buffers have no folds or soft wraps, and hard tabs do not add
    // row/column mappings to this patch. Avoid a patch tree lookup when the
    // mapping is the identity; cursor movement calls this thousands of times
    // in a large multi-selection.
    if (this.spatialIndex.getChangeCount() === 0) return bufferPosition;

    return bufferPositionThroughHunk(
      bufferPosition,
      this.spatialIndex.changeForOldPosition(bufferPosition),
      clipDirection,
    );
  }

  translateBufferPositions(positions, options) {
    // Small reads and custom callbacks keep the scalar call order, including
    // any reentrant work those callbacks perform. No secondary index is built.
    if (
      positions.length < 64 ||
      !this.hasStandardCharacterWidth() ||
      !this.hasStandardWrapBoundary() ||
      this.spatialIndex.getChangeCount() === 0
    ) {
      return positions.map((position) => this.translateBufferPosition(position, options));
    }

    const generation = this.mappingGeneration;
    const atomicSoftTabs = this.atomicSoftTabs;
    const clipDirection = options?.clipDirection || "closest";
    const clipped = positions.map((position) => this.buffer.clipPosition(position));
    let endBufferRow = 0;
    for (const position of clipped) endBufferRow = Math.max(endBufferRow, position.row + 1);
    this.populateSpatialIndexIfNeeded(endBufferRow, Infinity);
    if (this.mappingGeneration !== generation) {
      return positions.map((position) => this.translateBufferPosition(position, options));
    }
    if (this.spatialIndex.getChangeCount() === 0) {
      return positions.map((position) => this.translateBufferPosition(position, options));
    }

    const packed = new Uint32Array(clipped.length * 2);
    for (let index = 0; index < clipped.length; index++) {
      const point = clipped[index];
      const delta = this.getClipColumnDelta(point, clipDirection);
      if (delta !== 0) clipped[index] = Point(point.row, point.column + delta);
      packed[index * 2] = clipped[index].row;
      packed[index * 2 + 1] = clipped[index].column;
    }
    if (this.mappingGeneration !== generation || this.atomicSoftTabs !== atomicSoftTabs) {
      return positions.map((position) => this.translateBufferPosition(position, options));
    }
    const changes = this.spatialIndex.changesForOldPositions(packed);
    const hunk = {
      oldStart: { row: 0, column: 0 },
      oldEnd: { row: 0, column: 0 },
      newStart: { row: 0, column: 0 },
      newEnd: { row: 0, column: 0 },
    };
    return clipped.map((position, index) => {
      const offset = index * 9;
      let screenPosition = position;
      if (changes[offset]) {
        hunk.oldStart.row = changes[offset + 1];
        hunk.oldStart.column = changes[offset + 2];
        hunk.oldEnd.row = changes[offset + 3];
        hunk.oldEnd.column = changes[offset + 4];
        hunk.newStart.row = changes[offset + 5];
        hunk.newStart.column = changes[offset + 6];
        hunk.newEnd.row = changes[offset + 7];
        hunk.newEnd.column = changes[offset + 8];
        screenPosition = bufferPositionThroughHunk(position, hunk, clipDirection);
      }
      const tabCount = this.tabCounts.get(screenPosition.row);
      if (tabCount > 0) {
        screenPosition = shouldSkipHardTabRuns(this, screenPosition, tabCount)
          ? translateHardTabsWithRunSkipping(this, screenPosition, tabCount, true)
          : this.expandHardTabs(screenPosition, position, tabCount);
      }
      // The packed decoder reuses its four points; never expose one of them.
      return Point.fromObject(screenPosition);
    });
  }

  translateBufferRange(bufferRange, options) {
    bufferRange = Range.fromObject(bufferRange);
    return Range(
      this.translateBufferPosition(bufferRange.start, options),
      this.translateBufferPosition(bufferRange.end, options),
    );
  }

  translateScreenPosition(screenPosition, options) {
    screenPosition = Point.fromObject(screenPosition);
    Point.assertValid(screenPosition);
    const clipDirection = (options && options.clipDirection) || "closest";
    const skipSoftWrapIndentation = options && options.skipSoftWrapIndentation;
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), screenPosition.row + 1);
    screenPosition = this.constrainScreenPosition(screenPosition, clipDirection);
    const tabCount = this.tabCounts.get(screenPosition.row);
    if (tabCount > 0) {
      screenPosition = shouldSkipHardTabRuns(this, screenPosition, tabCount)
        ? translateHardTabsWithRunSkipping(this, screenPosition, tabCount, false, clipDirection)
        : this.collapseHardTabs(screenPosition, tabCount, clipDirection);
    }
    const bufferPosition = this.translateScreenPositionWithSpatialIndex(
      screenPosition,
      clipDirection,
      skipSoftWrapIndentation,
    );

    if (global.lumine && bufferPosition.row >= this.buffer.getLineCount()) {
      global.lumine.assert(false, "Invalid translated buffer row", {
        bufferPosition,
        bufferLineCount: this.buffer.getLineCount(),
      });
      return this.buffer.getEndPosition();
    }

    const columnDelta = this.getClipColumnDelta(bufferPosition, clipDirection);
    if (columnDelta !== 0) {
      return Point(bufferPosition.row, bufferPosition.column + columnDelta);
    } else {
      return Point.fromObject(bufferPosition);
    }
  }

  translateScreenPositionWithSpatialIndex(screenPosition, clipDirection, skipSoftWrapIndentation) {
    if (this.spatialIndex.getChangeCount() === 0) return screenPosition;

    let hunk = this.spatialIndex.changeForNewPosition(screenPosition);
    if (hunk) {
      if (compare(screenPosition, hunk.newEnd) < 0) {
        if (this.isSoftWrapHunk(hunk)) {
          if (
            (clipDirection === "backward" && !skipSoftWrapIndentation) ||
            (clipDirection === "closest" && isEqual(hunk.newStart, screenPosition))
          ) {
            return this.translateScreenPositionWithSpatialIndex(
              traverse(hunk.newStart, Point(0, -1)),
              clipDirection,
              skipSoftWrapIndentation,
            );
          } else {
            return hunk.oldStart;
          }
        } else {
          // Hunk is a fold. Since folds are 1 character on screen, we're at the start.
          return hunk.oldStart;
        }
      } else {
        return traverse(hunk.oldEnd, traversal(screenPosition, hunk.newEnd));
      }
    } else {
      return screenPosition;
    }
  }

  translateScreenRange(screenRange, options) {
    screenRange = Range.fromObject(screenRange);
    return Range(
      this.translateScreenPosition(screenRange.start, options),
      this.translateScreenPosition(screenRange.end, options),
    );
  }

  clipScreenPosition(screenPosition, options) {
    return this.translateBufferPosition(
      this.translateScreenPosition(screenPosition, options),
      options,
    );
  }

  constrainScreenPosition(screenPosition, clipDirection) {
    let { row, column } = screenPosition;

    if (row < 0) {
      return new Point(0, 0);
    }

    const maxRow = this.screenLineLengths.length - 1;
    if (row > maxRow) {
      return new Point(maxRow, this.screenLineLengths.get(maxRow));
    }

    if (column < 0) {
      return new Point(row, 0);
    }

    const maxColumn = this.screenLineLengths.get(row);
    if (column > maxColumn) {
      if (clipDirection === "forward" && row < maxRow) {
        return new Point(row + 1, 0);
      } else {
        return new Point(row, maxColumn);
      }
    }

    return screenPosition;
  }

  expandHardTabs(targetScreenPosition, targetBufferPosition, tabCount) {
    if (this.layoutState.unwrapped) return translateUnwrappedTabs(this, targetScreenPosition, true);
    const screenRowStart = Point(targetScreenPosition.row, 0);
    const hunks = this.spatialIndex.getChangesInNewRange(screenRowStart, targetScreenPosition);
    let hunkIndex = 0;
    let unexpandedScreenColumn = 0;
    let expandedScreenColumn = 0;
    let { row: bufferRow, column: bufferColumn } =
      this.translateScreenPositionWithSpatialIndex(screenRowStart);
    let bufferLine = this.buffer.lineForRow(bufferRow);

    while (tabCount > 0) {
      if (unexpandedScreenColumn === targetScreenPosition.column) {
        break;
      }

      let nextHunk = hunks[hunkIndex];
      if (
        nextHunk &&
        nextHunk.oldStart.row === bufferRow &&
        nextHunk.oldStart.column === bufferColumn
      ) {
        if (this.isSoftWrapHunk(nextHunk)) {
          if (hunkIndex !== 0) throw new Error("Unexpected soft wrap hunk");
          unexpandedScreenColumn = hunks[0].newEnd.column;
          expandedScreenColumn = unexpandedScreenColumn;
        } else {
          ({ row: bufferRow, column: bufferColumn } = nextHunk.oldEnd);
          bufferLine = this.buffer.lineForRow(bufferRow);
          unexpandedScreenColumn++;
          expandedScreenColumn++;
        }

        hunkIndex++;
        continue;
      }

      if (bufferLine[bufferColumn] === "\t") {
        expandedScreenColumn += this.tabLength - (expandedScreenColumn % this.tabLength);
        tabCount--;
      } else {
        expandedScreenColumn++;
      }
      unexpandedScreenColumn++;
      bufferColumn++;
    }

    expandedScreenColumn += targetScreenPosition.column - unexpandedScreenColumn;
    if (expandedScreenColumn === targetScreenPosition.column) {
      return targetScreenPosition;
    } else {
      return Point(targetScreenPosition.row, expandedScreenColumn);
    }
  }

  collapseHardTabs(targetScreenPosition, tabCount, clipDirection) {
    if (this.layoutState.unwrapped)
      return translateUnwrappedTabs(this, targetScreenPosition, false, clipDirection);
    const screenRowStart = Point(targetScreenPosition.row, 0);
    const screenRowEnd = Point(
      targetScreenPosition.row,
      this.screenLineLengths.get(targetScreenPosition.row),
    );

    const hunks = this.spatialIndex.getChangesInNewRange(screenRowStart, screenRowEnd);
    let hunkIndex = 0;
    let unexpandedScreenColumn = 0;
    let expandedScreenColumn = 0;
    let { row: bufferRow, column: bufferColumn } =
      this.translateScreenPositionWithSpatialIndex(screenRowStart);
    let bufferLine = this.buffer.lineForRow(bufferRow);

    while (tabCount > 0) {
      if (expandedScreenColumn === targetScreenPosition.column) {
        break;
      }

      let nextHunk = hunks[hunkIndex];
      if (
        nextHunk &&
        nextHunk.oldStart.row === bufferRow &&
        nextHunk.oldStart.column === bufferColumn
      ) {
        if (this.isSoftWrapHunk(nextHunk)) {
          if (hunkIndex !== 0) throw new Error("Unexpected soft wrap hunk");
          unexpandedScreenColumn = Math.min(targetScreenPosition.column, nextHunk.newEnd.column);
          expandedScreenColumn = unexpandedScreenColumn;
        } else {
          ({ row: bufferRow, column: bufferColumn } = nextHunk.oldEnd);
          bufferLine = this.buffer.lineForRow(bufferRow);
          unexpandedScreenColumn++;
          expandedScreenColumn++;
        }
        hunkIndex++;
        continue;
      }

      if (bufferLine[bufferColumn] === "\t") {
        const nextTabStopColumn =
          expandedScreenColumn + this.tabLength - (expandedScreenColumn % this.tabLength);
        if (nextTabStopColumn > targetScreenPosition.column) {
          if (clipDirection === "backward") {
            return Point(targetScreenPosition.row, unexpandedScreenColumn);
          } else if (clipDirection === "forward") {
            return Point(targetScreenPosition.row, unexpandedScreenColumn + 1);
          } else {
            if (
              targetScreenPosition.column >
              Math.ceil((nextTabStopColumn + expandedScreenColumn) / 2)
            ) {
              return Point(targetScreenPosition.row, unexpandedScreenColumn + 1);
            } else {
              return Point(targetScreenPosition.row, unexpandedScreenColumn);
            }
          }
        }
        expandedScreenColumn = nextTabStopColumn;
        tabCount--;
      } else {
        expandedScreenColumn++;
      }
      unexpandedScreenColumn++;
      bufferColumn++;
    }

    unexpandedScreenColumn += targetScreenPosition.column - expandedScreenColumn;
    if (unexpandedScreenColumn === targetScreenPosition.column) {
      return targetScreenPosition;
    } else {
      return Point(targetScreenPosition.row, unexpandedScreenColumn);
    }
  }

  getClipColumnDelta(bufferPosition, clipDirection) {
    const { row, column } = bufferPosition;
    // A line start cannot split a character pair or sit inside a soft tab.
    if (column === 0) return 0;

    // Treat paired unicode characters as atomic...
    const character = this.buffer.getCharacterAtPosition(bufferPosition);
    const previousCharacter = this.buffer.getCharacterAtPosition([row, column - 1]);
    if (previousCharacter && character && isCharacterPair(previousCharacter, character)) {
      if (clipDirection === "closest" || clipDirection === "backward") {
        return -1;
      } else {
        return 1;
      }
    }

    // Clip atomic soft tabs...

    if (!this.atomicSoftTabs) return 0;

    if (column * this.ratioForCharacter(" ") > this.softWrapColumn) {
      return 0;
    }

    // The common case is a position in text, not inside leading spaces. We
    // already fetched its character for the paired-character check above, so
    // do not cross the text store boundary a second time just to reject it.
    if (character !== " ") return 0;

    const previousTabStop = column - (column % this.tabLength);
    if (column === previousTabStop) return 0;
    const nextTabStop = previousTabStop + this.tabLength;

    // Read a long indentation once per cursor movement, then scan the string
    // without repeating buffer lookups for every preceding space.
    const source = this.buffer.getTextSnapshot();
    const lineStart = source.lineStart(row);
    if (nextTabStop > this.buffer.lineLengthForRow(row)) return 0;
    // Inspect nearby text first. Most spaces far into a giant generated line
    // are not indentation; never materialize that line to answer this query.
    let end = nextTabStop;
    while (end > 0) {
      const start = Math.max(0, end - 32768);
      if (/[^ ]/.test(source.slice(lineStart + start, lineStart + end))) return 0;
      end = start;
    }

    let clippedColumn;
    if (clipDirection === "closest") {
      if (column - previousTabStop > this.tabLength / 2) {
        clippedColumn = nextTabStop;
      } else {
        clippedColumn = previousTabStop;
      }
    } else if (clipDirection === "backward") {
      clippedColumn = previousTabStop;
    } else if (clipDirection === "forward") {
      clippedColumn = nextTabStop;
    }

    return clippedColumn - column;
  }

  getText(startRow, endRow) {
    return this.getScreenLines(startRow, endRow)
      .map((line) => line.lineText)
      .join("\n");
  }

  lineLengthForScreenRow(screenRow) {
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), screenRow + 1);
    return this.screenLineLengths.get(screenRow);
  }

  getLastScreenRow() {
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), Infinity);
    return this.screenLineLengths.length - 1;
  }

  getScreenLineCount() {
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), Infinity);
    return this.screenLineLengths.length;
  }

  getApproximateScreenLineCount() {
    if (this.indexedBufferRowCount > 0) {
      return Math.floor(
        (this.buffer.getLineCount() * this.screenLineLengths.length) / this.indexedBufferRowCount,
      );
    } else {
      return this.buffer.getLineCount();
    }
  }

  getRightmostScreenPosition() {
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), Infinity);
    // Exact width is deliberately distinct from the viewport's approximate
    // query. Row positions and counts never require measuring unseen lines.
    if (this.layoutState.unwrapped) {
      for (let row = 0; row < this.screenLineLengths.length; row++) this.screenLineLengths.get(row);
    }
    return this.rightmostScreenPosition;
  }

  getApproximateRightmostScreenPosition() {
    return this.rightmostScreenPosition;
  }

  getScreenLine(screenRow, highlightingOwner) {
    // Width measurements and token consumers must not replace the viewport's
    // pending highlighting request while its preparation is yielding.
    if (!highlightingOwner && !this.cachedScreenLines.get(screenRow))
      this.prepareHighlightingForScreenRows(
        screenRow,
        screenRow + 1,
        this.singleLineHighlightingOwner,
      );
    return (
      this.cachedScreenLines.get(screenRow) ||
      this.screenLineBuilder.buildScreenLines(
        screenRow,
        screenRow + 1,
        highlightingOwner ?? this.singleLineHighlightingOwner,
      )[0]
    );
  }

  getScreenLines(screenStartRow = 0, screenEndRow = this.getScreenLineCount()) {
    this.prepareHighlightingForScreenRows(screenStartRow, screenEndRow, this);
    return this.screenLineBuilder.buildScreenLines(screenStartRow, screenEndRow);
  }

  getScreenLineWindow(screenRow, startScreenColumn, endScreenColumn, highlightingOwner) {
    this.populateSpatialIndexIfNeeded(Infinity, screenRow + 1);
    if (!this.layoutState.unwrapped)
      throw new Error("Horizontal windows require an unwrapped layout");
    this.prepareHighlightingForScreenRows(screenRow, screenRow + 1, highlightingOwner ?? this);
    const line = this.screenLineBuilder.buildScreenLineWindow(
      screenRow,
      startScreenColumn,
      endScreenColumn,
      highlightingOwner ?? this,
    );
    line.startPixelColumn = this.pixelColumnForScreenColumn(screenRow, line.startScreenColumn);
    line.totalPixelColumns = this.getUnwrappedRowPixelGeometry(screenRow).pixelLength;
    return line;
  }

  getUnwrappedRowPixelGeometry(screenRow) {
    const row = this.getUnwrappedRow(screenRow);
    const signature = [" ", "我", "한", "ｱ"]
      .map((character) => this.ratioForCharacter(character))
      .join(":");
    if (row.pixelRatio === this.ratioForCharacter && row.pixelRatioSignature === signature)
      return row;
    const firstRow = this.translateScreenPositionWithSpatialIndex(Point(screenRow, 0)).row;
    const source = this.buffer.getTextSnapshot();
    let pixel = 0;
    for (const run of row.runs) {
      run.pixelColumn = pixel;
      const offset = source.lineStart(firstRow + run.rowDelta) + run.column;
      const text = run.fold ? this.foldCharacter : source.slice(offset, offset + run.textLength);
      const result = measureUnwrappedPixelColumns(
        this,
        text,
        run.screenColumn,
        pixel,
        source.charCodeAt(offset - 1),
        Infinity,
        Infinity,
      );
      pixel = result.pixel;
      run.pixelEndColumn = pixel;
    }
    row.pixelLength = pixel;
    row.pixelRatio = this.ratioForCharacter;
    row.pixelRatioSignature = signature;
    return row;
  }

  pixelColumnForScreenColumn(screenRow, column) {
    return this.translateUnwrappedPixelColumn(screenRow, column, false);
  }

  screenColumnForPixelColumn(screenRow, pixel) {
    return this.translateUnwrappedPixelColumn(screenRow, pixel, true);
  }

  translateUnwrappedPixelColumn(screenRow, target, fromPixel) {
    const row = this.getUnwrappedRowPixelGeometry(screenRow);
    const key = fromPixel ? "pixelColumn" : "screenColumn";
    let low = 0;
    let high = row.runs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (row.runs[middle][key] <= target) low = middle + 1;
      else high = middle;
    }
    const run = row.runs[Math.max(0, low - 1)];
    if (!run) return 0;
    const firstRow = this.translateScreenPositionWithSpatialIndex(Point(screenRow, 0)).row;
    const source = this.buffer.getTextSnapshot();
    const offset = source.lineStart(firstRow + run.rowDelta) + run.column;
    const text = run.fold ? this.foldCharacter : source.slice(offset, offset + run.textLength);
    const result = measureUnwrappedPixelColumns(
      this,
      text,
      run.screenColumn,
      run.pixelColumn,
      source.charCodeAt(offset - 1),
      fromPixel ? Infinity : target,
      fromPixel ? target : Infinity,
    );
    return fromPixel ? result.column : result.pixel;
  }

  requiresScreenLineWindow(screenRow) {
    if (this.softWrapColumn !== Infinity) return false;
    const length = this.lineLengthForScreenRow(screenRow);
    return length > 10000 || this.layoutState.unwrappedRows.get(screenRow)?.longSourceLine === true;
  }

  getUnwrappedRow(screenRow) {
    return (
      this.layoutState.unwrappedRows.get(screenRow) ??
      measureUnwrappedRow(this.layoutState, screenRow)
    );
  }

  prepareHighlightingForScreenRows(startRow, endRow, owner) {
    const languageMode = this.buffer.languageMode;
    if (!languageMode.requestHighlighting) return;
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), endRow);
    const lastRow = Math.min(endRow, this.screenLineLengths.length) - 1;
    if (lastRow < startRow) {
      languageMode.requestHighlighting(owner, []);
      return;
    }
    let row = this.translateScreenPositionWithSpatialIndex(Point(startRow, 0), "forward", true).row;
    const endBufferRow = this.translateScreenPositionWithSpatialIndex(
      Point(lastRow, this.screenLineLengths.get(lastRow)),
      "forward",
      false,
    ).row;
    const ranges = [];
    const hunks = this.spatialIndex.getChangesInNewRange(Point(startRow, 0), Point(endRow, 0));
    for (const hunk of hunks) {
      if (this.isSoftWrapHunk(hunk) || hunk.oldEnd.row < row || hunk.oldStart.row > endBufferRow)
        continue;
      if (hunk.oldStart.row >= row) ranges.push([row, hunk.oldStart.row]);
      row = Math.max(row, hunk.oldEnd.row);
    }
    if (row <= endBufferRow) ranges.push([row, endBufferRow]);
    // Ready scopes can invalidate cached screen lines and notify observers.
    // Finish that work before ScreenLineBuilder captures its mutable state or
    // uncached ranges, including when a subscriber reads another screen line.
    return languageMode.requestHighlighting(owner, ranges, true, {
      priority: owner === this ? 0 : owner === this.singleLineHighlightingOwner ? 3 : 2,
      prefetch: owner !== this.singleLineHighlightingOwner,
      background: owner === this,
    });
  }

  bufferRowsForScreenRows(startRow, endRow) {
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), endRow);

    const startPosition = Point(startRow, 0);
    const bufferRows = [];
    let lastScreenRow = startRow;
    let lastBufferRow = this.translateScreenPositionWithSpatialIndex(startPosition).row;
    const hunks = this.spatialIndex.getChangesInNewRange(startPosition, Point(endRow, 0));
    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      while (lastScreenRow <= hunk.newStart.row) {
        bufferRows.push(lastBufferRow);
        lastScreenRow++;
        lastBufferRow++;
      }

      lastBufferRow = this.isSoftWrapHunk(hunk) ? hunk.oldEnd.row : hunk.oldEnd.row + 1;
    }

    while (lastScreenRow < endRow) {
      bufferRows.push(lastBufferRow);
      lastScreenRow++;
      lastBufferRow++;
    }

    return bufferRows;
  }

  // Translates the same pair of screen columns across every row from startRow
  // through endRow (inclusive), exactly as translateScreenPosition would with
  // default options, but with one spatial-index query for the whole span
  // instead of two per row. Returns one entry per row: {bufferRange,
  // screenColumn}, where screenColumn is the screen column an empty range's
  // position round-trips to -- what tells a row whose text ends before the
  // block apart from a row the block genuinely intersects -- and null for
  // non-empty ranges.
  //
  // Rows a hunk touches (folds, soft wraps), rows containing hard tabs, rows
  // outside the screen line range, and the block's own first row take the
  // exact per-position methods, so their results cannot drift from
  // translateScreenPosition and translateBufferPosition. The first row is on
  // that list because the span query excludes a hunk ending exactly at its
  // start -- a soft wrap continuing with zero indent -- which still offsets
  // that one row's columns. Every other row is an identity mapping apart from
  // a row offset, the clip to the screen line length, and the column clipping
  // getClipColumnDelta applies on the slow path. A column that clips to the
  // end of its line needs no clip delta at all: the character there is a line
  // terminator or the buffer's end, which is never the second element of an
  // atomic pair and never a space, so both of its branches return zero.
  translateScreenColumnBlock(startRow, endRow, startColumn, endColumn) {
    this.populateSpatialIndexIfNeeded(this.buffer.getLineCount(), endRow + 1);
    const maxRow = this.screenLineLengths.length - 1;
    const hunks = this.spatialIndex.getChangesInNewRange(Point(startRow, 0), Point(endRow + 1, 0));

    const results = [];
    let hunkIndex = 0;
    // The buffer row of the block's first screen row, correct even when that
    // row continues a wrapped line; clean rows advance from here in lockstep
    // until a hunk moves the base.
    let baseScreenRow = startRow;
    let baseBufferRow =
      startRow >= 0 && startRow <= maxRow
        ? this.translateScreenPositionWithSpatialIndex(Point(startRow, 0)).row
        : 0;

    for (let row = startRow; row <= endRow; row++) {
      while (hunkIndex < hunks.length && hunks[hunkIndex].newEnd.row < row) {
        const passed = hunks[hunkIndex++];
        baseScreenRow = passed.newEnd.row;
        baseBufferRow = passed.oldEnd.row;
      }
      const hunk = hunkIndex < hunks.length ? hunks[hunkIndex] : null;
      const rowTouchesHunk = hunk !== null && hunk.newStart.row <= row;

      if (
        row === startRow ||
        row < 0 ||
        row > maxRow ||
        rowTouchesHunk ||
        this.tabCounts.get(row) > 0
      ) {
        const bufferRange = Range(
          this.translateScreenPosition(Point(row, startColumn)),
          this.translateScreenPosition(Point(row, endColumn)),
        );
        const screenColumn = bufferRange.isEmpty()
          ? this.translateBufferPosition(bufferRange.start).column
          : null;
        results.push({ bufferRange, screenColumn });
        continue;
      }

      const bufferRow = baseBufferRow + (row - baseScreenRow);
      const lineLength = this.screenLineLengths.get(row);
      let column1 = startColumn < 0 ? 0 : Math.min(startColumn, lineLength);
      let column2 = endColumn < 0 ? 0 : Math.min(endColumn, lineLength);
      if (column1 < lineLength) {
        column1 += this.getClipColumnDelta(Point(bufferRow, column1), "closest");
      }
      if (column2 < lineLength) {
        column2 += this.getClipColumnDelta(Point(bufferRow, column2), "closest");
      }
      const bufferRange = Range(Point(bufferRow, column1), Point(bufferRow, column2));
      results.push({ bufferRange, screenColumn: column1 === column2 ? column1 : null });
    }
    return results;
  }

  findTrailingWhitespaceStartColumn(bufferRow) {
    const line = this.buffer.lineForRow(bufferRow);
    if (line == null) return 0;

    // Read the line once and scan its string, including long runs of padding
    // in generated files, without repeated buffer lookups.
    let column = line.length;
    while (column > 0) {
      const character = line[column - 1];
      if (character !== " " && character !== "\t") break;
      column--;
    }
    return column;
  }

  registerBuiltInScope(flags, className) {
    if (this.nextBuiltInScopeId > MAX_BUILT_IN_SCOPE_ID) {
      throw new Error("Built in scope ids exhausted");
    }

    let scopeId;
    if (className.length > 0) {
      scopeId = this.nextBuiltInScopeId += 2;
      this.builtInClassNamesByScopeId.set(scopeId, className);
    } else {
      scopeId = 0;
    }
    this.builtInScopeIdsByFlags.set(flags, scopeId);
    return scopeId;
  }

  getBuiltInScopeId(flags) {
    if (this.builtInScopeIdsByFlags.has(flags)) {
      return this.builtInScopeIdsByFlags.get(flags);
    } else {
      return -1;
    }
  }

  classNameForScopeId(scopeId) {
    if (scopeId <= MAX_BUILT_IN_SCOPE_ID) {
      return this.builtInClassNamesByScopeId.get(scopeId);
    } else {
      return this.buffer.languageMode.classNameForScopeId(scopeId);
    }
  }

  scopeIdForTag(tag) {
    if (this.isCloseTag(tag)) tag++;
    return -tag;
  }

  classNameForTag(tag) {
    return this.classNameForScopeId(this.scopeIdForTag(tag));
  }

  openTagForScopeId(scopeId) {
    return -scopeId;
  }

  closeTagForScopeId(scopeId) {
    return -scopeId - 1;
  }

  isOpenTag(tag) {
    return tag < 0 && (tag & 1) === 1;
  }

  isCloseTag(tag) {
    return tag < 0 && (tag & 1) === 0;
  }

  bufferWillChange(change) {
    // Keep the exact event as a preparation token. A nested edit or layout
    // reset during population invalidates it before we can reuse geometry.
    this.pendingGeometryStableChange = change;
    const ratioForCharacter = this.ratioForCharacter;
    const isWrapBoundary = this.isWrapBoundary;
    const lineCount = this.buffer.getLineCount();
    let endRow = change.oldRange.end.row;
    while (
      this.softWrapColumn !== Infinity &&
      endRow + 1 < lineCount &&
      this.buffer.lineLengthForRow(endRow + 1) === 0
    ) {
      endRow++;
    }
    this.populateSpatialIndexIfNeeded(endRow + 1, Infinity);

    if (this.pendingGeometryStableChange !== change) return;
    this.pendingGeometryStableChange = null;
    const { oldRange, newRange } = change;
    if (
      oldRange.start.row !== oldRange.end.row ||
      !isEqual(oldRange.start, newRange.start) ||
      !isEqual(oldRange.end, newRange.end)
    )
      return;
    if (change.oldTextSource?.length > 64 || change.newTextSource?.length > 64) return;
    const { oldText, newText } = change;
    if (
      ratioForCharacter !== this.ratioForCharacter ||
      isWrapBoundary !== this.isWrapBoundary ||
      !this.hasStandardCharacterWidth() ||
      !this.hasStandardWrapBoundary() ||
      typeof oldText !== "string" ||
      typeof newText !== "string" ||
      oldText.length === 0 ||
      oldText.length > 64 ||
      oldText.length !== newText.length ||
      oldRange.start.row !== oldRange.end.row ||
      !isEqual(oldRange.start, newRange.start) ||
      !isEqual(oldRange.end, newRange.end) ||
      !GEOMETRY_STABLE_REPLACEMENT_REGEXP.test(oldText) ||
      !GEOMETRY_STABLE_REPLACEMENT_REGEXP.test(newText) ||
      this.foldsMarkerLayer.findMarkers({ intersectsRow: oldRange.start.row }).length > 0
    ) {
      return;
    }

    // The exclusive end may be the beginning of the next wrap. Invalidate
    // the rows containing replaced characters, including their first row.
    const startScreenRow = this.translateBufferPositionWithSpatialIndex(
      oldRange.start,
      "forward",
    ).row;
    const lastScreenRow = this.translateBufferPositionWithSpatialIndex(
      Point(oldRange.end.row, oldRange.end.column - 1),
      "forward",
    ).row;
    this.pendingGeometryStableChange = {
      change,
      layoutState: this.layoutState,
      ratioForCharacter,
      isWrapBoundary,
      startScreenRow,
      rowCount: lastScreenRow - startScreenRow + 1,
    };
  }

  prepareProjectionForChange(change) {
    if (!this.resolveSoftWrapColumn) return;
    let delta = change.newEndIndex - change.oldEndIndex;
    if (!Number.isFinite(delta)) {
      const extentLength = (range) =>
        range.start.row === range.end.row ? range.end.column - range.start.column : undefined;
      delta =
        (change.newTextSource?.length ?? extentLength(change.newRange)) -
        (change.oldTextSource?.length ?? extentLength(change.oldRange));
    }
    const length = this.buffer.getLength() + (Number.isFinite(delta) ? delta : 0);
    const lineCount =
      this.buffer.getLineCount() + change.newRange.end.row - change.oldRange.end.row;
    const softWrapColumn = this.resolveSoftWrapColumn({ length, lineCount });
    this.pendingProjection = null;
    const previousColumn = this.resolveSoftWrapColumn({
      length: this.buffer.getLength(),
      lineCount: this.buffer.getLineCount(),
    });
    if (softWrapColumn === previousColumn) return;
    if (softWrapColumn === this.softWrapColumn) return;
    if (this.softWrapColumn === Infinity && softWrapColumn !== Infinity) {
      // A large deletion must not first wrap the old, still-large document.
      // Apply the cheaper projection while reading the old text, then rebuild
      // the small result after commit. Siblings adopt that same final reset.
      this.pendingProjection = { softWrapColumn, oldScreenLineCount: this.getScreenLineCount() };
    } else this.reset({ softWrapColumn });
  }

  hasStandardCharacterWidth() {
    return (
      this.ratioForCharacter === unitRatio ||
      (this.standardRatioForCharacter != null &&
        this.ratioForCharacter === this.standardRatioForCharacter)
    );
  }

  hasStandardWrapBoundary() {
    return this.isWrapBoundary === isWordStart || this.isWrapBoundary === defaultIsWrapBoundary;
  }

  bufferDidChange(change) {
    if (this.pendingProjection) {
      const { softWrapColumn, oldScreenLineCount } = this.pendingProjection;
      this.pendingProjection = null;
      this.reset({ softWrapColumn });
      const layoutChange = {
        start: Point(0, 0),
        oldExtent: Point(oldScreenLineCount, 0),
        newExtent: Point(this.getScreenLineCount(), 0),
        softWrapColumn,
        origin: change.origin ?? "edit",
      };
      this.didChange(layoutChange);
      return layoutChange;
    }
    const preparedChange = this.pendingGeometryStableChange;
    this.pendingGeometryStableChange = null;
    const { oldRange, newRange } = change;
    const startRow = oldRange.start.row;
    const oldEndRow = oldRange.end.row;
    const newEndRow = newRange.end.row;

    this.indexedBufferRowCount += newEndRow - oldEndRow;
    this.markMarkerScreenPositionsDirty();
    let layoutChange;
    if (
      preparedChange?.change === change &&
      preparedChange.layoutState === this.layoutState &&
      preparedChange.ratioForCharacter === this.ratioForCharacter &&
      preparedChange.isWrapBoundary === this.isWrapBoundary &&
      this.hasStandardCharacterWidth() &&
      this.hasStandardWrapBoundary()
    ) {
      const { startScreenRow, rowCount } = preparedChange;
      for (
        let row = startScreenRow,
          end = Math.min(startScreenRow + rowCount, this.cachedScreenLines.length);
        row < end;
        row++
      ) {
        this.cachedScreenLines.set(row, undefined);
      }
      const extent = Point(rowCount, 0);
      layoutChange = { start: Point(startScreenRow, 0), oldExtent: extent, newExtent: extent };
    } else {
      layoutChange = this.updateSpatialIndex(startRow, oldEndRow + 1, newEndRow + 1, Infinity);
    }
    layoutChange.origin = change.origin ?? "edit";
    this.didChange(layoutChange);
    return layoutChange;
  }

  adoptSpatialStateFrom(source, layoutChange = null) {
    this.pendingGeometryStableChange = null;
    this.layoutState = source.layoutState;

    if (layoutChange == null) return;

    if (Object.hasOwn(layoutChange, "softWrapColumn")) {
      this.pendingProjection = null;
      this.softWrapColumn = layoutChange.softWrapColumn;
      this.layoutGroupId = source.layoutGroupId;
    }

    if (layoutChange.start.row <= this.cachedScreenLines.length) {
      this.cachedScreenLines.spliceRows(
        layoutChange.start.row,
        layoutChange.oldExtent.row,
        layoutChange.newExtent.row,
      );
    }
    // A sibling can be farther through background indexing than this layer.
    // Keep the sparse cache's coordinate space aligned with the adopted row
    // summaries even when the changed range starts beyond its old length.
    this.cachedScreenLines.length = this.screenLineLengths.length;
    this.markMarkerScreenPositionsDirty();
    this.didChange(layoutChange);
  }

  didChange({ start, oldExtent, newExtent, origin = "edit" }) {
    this.windowGeneration++;
    this.changesSinceLastEvent.splice(start, oldExtent, newExtent);
    this.changeOriginsSinceLastEvent.add(origin);
    if (this.buffer.transactCallDepth === 0) this.emitDeferredChangeEvents();
  }

  emitDeferredChangeEvents() {
    if (this.changesSinceLastEvent.getChangeCount() === 0) {
      this.changeOriginsSinceLastEvent.clear();
      return;
    }
    const origin =
      this.changeOriginsSinceLastEvent.size === 1
        ? this.changeOriginsSinceLastEvent.values().next().value
        : "mixed";
    const changes = this.changesSinceLastEvent.getChanges().map((change) => ({
      oldRange: new Range(change.oldStart, change.oldEnd),
      newRange: new Range(change.newStart, change.newEnd),
      origin,
    }));
    this.changesSinceLastEvent = new Patch();
    this.changeOriginsSinceLastEvent.clear();
    this.emitter.emit("did-change", changes);
  }

  notifyObserversIfMarkerScreenPositionsChanged(origin = "edit") {
    this.displayMarkerLayersById.forEach((layer) => {
      layer.notifyObserversIfMarkerScreenPositionsChanged(origin);
    });
  }

  markMarkerScreenPositionsDirty() {
    this.mappingGeneration++;
    this.displayMarkerLayersById.forEach((layer) => layer.markScreenPositionsDirty());
  }

  updateSpatialIndex(
    startBufferRow,
    oldEndBufferRow,
    newEndBufferRow,
    endScreenRow,
    deadline = NullDeadline,
  ) {
    if (this.softWrapColumn === Infinity) {
      return this.updateUnwrappedSpatialIndex(startBufferRow, oldEndBufferRow, newEndBufferRow);
    }
    const originalOldEndBufferRow = oldEndBufferRow;
    startBufferRow = this.findBoundaryPrecedingBufferRow(startBufferRow);
    oldEndBufferRow = this.findBoundaryFollowingBufferRow(oldEndBufferRow);
    newEndBufferRow += oldEndBufferRow - originalOldEndBufferRow;

    const startScreenRow = this.translateBufferPositionWithSpatialIndex(
      { row: startBufferRow, column: 0 },
      "backward",
    ).row;
    const oldEndScreenRow = this.translateBufferPositionWithSpatialIndex(
      { row: oldEndBufferRow, column: 0 },
      "backward",
    ).row;
    this.spatialIndex.spliceOld(
      { row: startBufferRow, column: 0 },
      { row: oldEndBufferRow - startBufferRow, column: 0 },
      { row: newEndBufferRow - startBufferRow, column: 0 },
    );
    const pendingSpatialSplices = [];

    const folds = this.computeFoldsInBufferRowRange(startBufferRow, newEndBufferRow);
    const foldEvents = sortedFoldEvents(folds);
    let foldEventIndex = 0;
    while (foldEvents[foldEventIndex]?.bufferRow < startBufferRow) foldEventIndex++;
    let nextFoldEvent = foldEvents[foldEventIndex];

    const insertedScreenLineLengths = [];
    const insertedTabCounts = [];
    const insertedScreenLineStartFlags = [];
    const currentScreenLineTabColumns = [];
    let rightmostInsertedScreenPosition = Point(0, -1);
    let bufferRow = startBufferRow;
    let screenRow = startScreenRow;
    let bufferColumn = 0;
    let unexpandedScreenColumn = 0;
    let expandedScreenColumn = 0;

    let source = this.buffer.getTextSnapshot();
    let reader = source.lineReader();
    const readLine = (row) => {
      const current = this.buffer.getTextSnapshot();
      if (current !== source) {
        source = current;
        reader = source.lineReader();
      }
      return reader(row);
    };

    while (true) {
      if (bufferRow >= newEndBufferRow) break;
      if (screenRow >= endScreenRow && bufferColumn === 0) break;
      if (deadline.timeRemaining() < 2) break;
      let bufferLine = readLine(bufferRow);
      if (bufferLine == null) break;
      let bufferLineLength = bufferLine.length;
      let screenLineBuilderInLeadingWhitespace = true;
      let currentScreenLineStartFlags = SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE;

      const foldEndsByColumn = folds[bufferRow];

      // With wrapping disabled and no fold beginning on this row, display and
      // buffer columns differ only at hard tabs. The general character loop
      // still asks the width and wrap-boundary callbacks about every code unit,
      // even though neither answer can affect the result. Long generated lines
      // turn that constant overhead into a visible input stall, so derive the
      // row metrics directly and let String#indexOf scan tab-free runs in
      // native code.
      if (
        !foldEndsByColumn &&
        this.softWrapColumn === Infinity &&
        canUseUnwrappedLineFastPath(this, bufferLine, bufferLineLength)
      ) {
        let tabCount = 0;
        let expandedLineLength = bufferLineLength;
        let tabColumn = bufferLine.indexOf("\t");
        if (tabColumn >= 0) {
          expandedLineLength = 0;
          let sourceColumn = 0;
          do {
            expandedLineLength += tabColumn - sourceColumn;
            expandedLineLength += this.tabLength - (expandedLineLength % this.tabLength);
            sourceColumn = tabColumn + 1;
            tabCount++;
            tabColumn = bufferLine.indexOf("\t", sourceColumn);
          } while (tabColumn >= 0);
          expandedLineLength += bufferLineLength - sourceColumn;
        }

        insertedScreenLineLengths.push(expandedLineLength);
        insertedTabCounts.push(tabCount);
        insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
        if (expandedLineLength > rightmostInsertedScreenPosition.column) {
          rightmostInsertedScreenPosition.row = screenRow;
          rightmostInsertedScreenPosition.column = expandedLineLength;
        }

        bufferRow++;
        screenRow++;
        continue;
      }

      // The editor's maximum-screen-line guard commonly splits huge ASCII
      // tokens at a fixed column even when user-facing soft wrap is disabled.
      // If every source character is one column wide and neither supported
      // boundary predicate can find a preferred word boundary, those splits
      // are regular. Emit them a screen row at a time instead of interpreting
      // every character. Unknown callbacks, tabs, folds, indentation and
      // non-ASCII text retain the fully general path below.
      let asciiWrapBoundaryMode = asciiWrapBoundaryModeForLine(this, bufferLine, bufferLineLength);
      if (
        !foldEndsByColumn &&
        asciiWrapBoundaryMode !== ASCII_WRAP_BOUNDARY_NONE &&
        canUseSimpleLineFastPath(this, bufferLine, asciiWrapBoundaryMode)
      ) {
        let remainingLength = bufferLineLength;
        while (remainingLength > this.softWrapColumn) {
          queueSpatialSplice(pendingSpatialSplices, screenRow, this.softWrapColumn, 0, 0, 1, 0);
          insertedScreenLineLengths.push(this.softWrapColumn);
          insertedTabCounts.push(0);
          insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
          if (this.softWrapColumn > rightmostInsertedScreenPosition.column) {
            rightmostInsertedScreenPosition.row = screenRow;
            rightmostInsertedScreenPosition.column = this.softWrapColumn;
          }
          screenRow++;
          remainingLength -= this.softWrapColumn;
          currentScreenLineStartFlags = 0;
        }

        insertedScreenLineLengths.push(remainingLength);
        insertedTabCounts.push(0);
        insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
        if (remainingLength > rightmostInsertedScreenPosition.column) {
          rightmostInsertedScreenPosition.row = screenRow;
          rightmostInsertedScreenPosition.column = remainingLength;
        }

        bufferRow++;
        screenRow++;
        continue;
      }

      if (
        !foldEndsByColumn &&
        canUseAsciiBoundaryFastPath(this, bufferLine, asciiWrapBoundaryMode)
      ) {
        screenRow = populateSpatialIndexForAsciiBoundaryLine(
          this,
          bufferLine,
          screenRow,
          asciiWrapBoundaryMode,
          pendingSpatialSplices,
          insertedScreenLineLengths,
          insertedTabCounts,
          insertedScreenLineStartFlags,
          rightmostInsertedScreenPosition,
        );
        bufferRow++;
        screenRow++;
        continue;
      }

      if (!foldEndsByColumn && canUseAsciiEventFastPath(this, bufferLine, asciiWrapBoundaryMode)) {
        screenRow = populateSpatialIndexForAsciiEventLine(
          this,
          bufferLine,
          screenRow,
          asciiWrapBoundaryMode,
          pendingSpatialSplices,
          insertedScreenLineLengths,
          insertedTabCounts,
          insertedScreenLineStartFlags,
          rightmostInsertedScreenPosition,
        );
        bufferRow++;
        screenRow++;
        continue;
      }

      currentScreenLineTabColumns.length = 0;
      let asciiRunEvents = asciiRunEventsForLine(this, bufferLine, asciiWrapBoundaryMode);
      let nextAsciiRunEventColumn = -1;
      let screenLineWidth = 0;
      let lastWrapBoundaryUnexpandedScreenColumn = 0;
      let lastWrapBoundaryExpandedScreenColumn = 0;
      let lastWrapBoundaryScreenLineWidth = 0;
      let firstNonWhitespaceScreenColumn = -1;

      while (bufferColumn <= bufferLineLength) {
        let foldEnd = null;
        if (
          nextFoldEvent &&
          nextFoldEvent.bufferRow === bufferRow &&
          nextFoldEvent.bufferColumn === bufferColumn
        ) {
          foldEnd = nextFoldEvent.end;
          nextFoldEvent = foldEvents[++foldEventIndex];
        }
        const previousCharacter = bufferLine[bufferColumn - 1];
        const character = foldEnd ? this.foldCharacter : bufferLine[bufferColumn];

        // Are we in leading whitespace? If yes, record the *end* of the leading
        // whitespace if we've reached a non whitespace character. If no, record
        // the current column if it is a viable soft wrap boundary.
        if (firstNonWhitespaceScreenColumn < 0) {
          if (character !== " " && character !== "\t") {
            firstNonWhitespaceScreenColumn = expandedScreenColumn;
          }
        } else {
          let atWrapBoundary = false;
          if (previousCharacter && character) {
            if (foldEnd) {
              // The fold marker need not be ASCII. Preserve custom widths,
              // combining-character protection and the standard predicate's
              // special handling of CJK while retaining the cheap known mode
              // for ordinary characters on either side of it.
              atWrapBoundary = this.isWrapBoundary(previousCharacter, character);
            } else {
              atWrapBoundary =
                asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_WHITESPACE
                  ? (previousCharacter === " " || previousCharacter === "\t") &&
                    character !== " " &&
                    character !== "\t"
                  : asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_STANDARD
                    ? (previousCharacter === " " ||
                        previousCharacter === "\t" ||
                        previousCharacter === "-" ||
                        previousCharacter === "/") &&
                      character !== " " &&
                      character !== "\t"
                    : this.isWrapBoundary(previousCharacter, character);
            }
          }
          if (atWrapBoundary) {
            lastWrapBoundaryUnexpandedScreenColumn = unexpandedScreenColumn;
            lastWrapBoundaryExpandedScreenColumn = expandedScreenColumn;
            lastWrapBoundaryScreenLineWidth = screenLineWidth;
          }
        }

        // Determine the on-screen width of the character for soft-wrap calculations
        let characterWidth;
        if (character === "\t") {
          const distanceToNextTabStop = this.tabLength - (expandedScreenColumn % this.tabLength);
          characterWidth =
            (asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_NONE ? this.ratioForCharacter(" ") : 1) *
            distanceToNextTabStop;
        } else if (character) {
          characterWidth =
            asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_NONE || foldEnd
              ? this.ratioForCharacter(character)
              : 1;
        } else {
          characterWidth = 0;
        }

        const insertSoftLineBreak =
          screenLineWidth > 0 &&
          characterWidth > 0 &&
          screenLineWidth + characterWidth > this.softWrapColumn &&
          previousCharacter &&
          character &&
          ((asciiWrapBoundaryMode !== ASCII_WRAP_BOUNDARY_NONE && !foldEnd) ||
            !isCharacterPair(previousCharacter, character));

        if (insertSoftLineBreak) {
          let indentLength =
            firstNonWhitespaceScreenColumn < this.softWrapColumn
              ? Math.max(0, firstNonWhitespaceScreenColumn)
              : 0;
          if (indentLength + this.softWrapHangingIndent < this.softWrapColumn) {
            indentLength += this.softWrapHangingIndent;
          }

          const unexpandedWrapColumn =
            lastWrapBoundaryUnexpandedScreenColumn || unexpandedScreenColumn;
          const expandedWrapColumn = lastWrapBoundaryExpandedScreenColumn || expandedScreenColumn;
          const wrapWidth = lastWrapBoundaryScreenLineWidth || screenLineWidth;
          queueSpatialSplice(
            pendingSpatialSplices,
            screenRow,
            unexpandedWrapColumn,
            0,
            0,
            1,
            indentLength,
          );

          insertedScreenLineLengths.push(expandedWrapColumn);
          insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
          if (expandedWrapColumn > rightmostInsertedScreenPosition.column) {
            rightmostInsertedScreenPosition.row = screenRow;
            rightmostInsertedScreenPosition.column = expandedWrapColumn;
          }
          screenRow++;
          currentScreenLineStartFlags = screenLineBuilderInLeadingWhitespace
            ? SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE
            : 0;

          // To determine the expanded screen column following the wrap, we need
          // to re-expand each tab following the wrap boundary, because tabs may
          // take on different lengths due to starting at different screen columns.
          let unexpandedScreenColumnAfterLastTab = indentLength;
          let expandedScreenColumnAfterLastTab = indentLength;
          let tabCountPrecedingWrap = 0;
          for (let i = 0; i < currentScreenLineTabColumns.length; i++) {
            const tabColumn = currentScreenLineTabColumns[i];
            if (tabColumn < unexpandedWrapColumn) {
              tabCountPrecedingWrap++;
            } else {
              const tabColumnAfterWrap = indentLength + tabColumn - unexpandedWrapColumn;
              expandedScreenColumnAfterLastTab +=
                tabColumnAfterWrap - unexpandedScreenColumnAfterLastTab;
              expandedScreenColumnAfterLastTab +=
                this.tabLength - (expandedScreenColumnAfterLastTab % this.tabLength);
              unexpandedScreenColumnAfterLastTab = tabColumnAfterWrap + 1;
              currentScreenLineTabColumns[i - tabCountPrecedingWrap] = tabColumnAfterWrap;
            }
          }
          insertedTabCounts.push(tabCountPrecedingWrap);
          currentScreenLineTabColumns.length -= tabCountPrecedingWrap;

          unexpandedScreenColumn = unexpandedScreenColumn - unexpandedWrapColumn + indentLength;
          expandedScreenColumn =
            expandedScreenColumnAfterLastTab +
            unexpandedScreenColumn -
            unexpandedScreenColumnAfterLastTab;
          screenLineWidth =
            indentLength *
              (asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_NONE
                ? this.ratioForCharacter(" ")
                : 1) +
            (screenLineWidth - wrapWidth);

          lastWrapBoundaryUnexpandedScreenColumn = 0;
          lastWrapBoundaryExpandedScreenColumn = 0;
          lastWrapBoundaryScreenLineWidth = 0;
        }

        if (!foldEnd && character && character !== " " && character !== "\t") {
          screenLineBuilderInLeadingWhitespace = false;
        }

        // If there is a fold at this position, splice it into the spatial index
        // and jump to the end of the fold.
        if (foldEnd) {
          const foldCrossesRows = foldEnd.row !== bufferRow;
          const foldExtent = traversal(foldEnd, { row: bufferRow, column: bufferColumn });
          queueSpatialSplice(
            pendingSpatialSplices,
            screenRow,
            unexpandedScreenColumn,
            foldExtent.row,
            foldExtent.column,
            0,
            1,
          );
          unexpandedScreenColumn++;
          expandedScreenColumn++;
          screenLineWidth += characterWidth;
          bufferRow = foldEnd.row;
          bufferColumn = foldEnd.column;
          bufferLine = readLine(bufferRow);
          bufferLineLength = bufferLine.length;
          if (foldCrossesRows) {
            // A cross-row fold can land in a line with a different alphabet.
            // Reclassify it before interpreting the visible suffix.
            asciiWrapBoundaryMode = asciiWrapBoundaryModeForLine(
              this,
              bufferLine,
              bufferLineLength,
            );
            asciiRunEvents = asciiRunEventsForLine(this, bufferLine, asciiWrapBoundaryMode);
            nextAsciiRunEventColumn = -1;
          }
        } else {
          // If there is no fold at this position, check if we need to handle
          // a hard tab at this position and advance by a single buffer column.
          if (character === "\t") {
            currentScreenLineTabColumns.push(unexpandedScreenColumn);
            const distanceToNextTabStop = this.tabLength - (expandedScreenColumn % this.tabLength);
            expandedScreenColumn += distanceToNextTabStop;
            screenLineWidth +=
              distanceToNextTabStop *
              (asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_NONE
                ? this.ratioForCharacter(" ")
                : 1);
          } else {
            expandedScreenColumn++;
            screenLineWidth += characterWidth;
          }
          unexpandedScreenColumn++;
          bufferColumn++;

          // A Unicode event needs the full width, boundary and paired-character
          // logic, but it does not make the ordinary ASCII around it special.
          // Consume the event's first successor normally, then jump over the
          // rest of its run. Keep the next event cached across wrap points so
          // a distant Unicode character is searched for only once.
          if (
            asciiRunEvents &&
            character &&
            character.charCodeAt(0) < 128 &&
            character !== " " &&
            character !== "\t" &&
            character !== "-" &&
            character !== "/" &&
            Number.isInteger(screenLineWidth) &&
            Number.isInteger(unexpandedScreenColumn) &&
            Number.isInteger(expandedScreenColumn)
          ) {
            if (bufferColumn >= nextAsciiRunEventColumn) {
              asciiRunEvents.lastIndex = bufferColumn;
              nextAsciiRunEventColumn = asciiRunEvents.exec(bufferLine)?.index ?? Infinity;
            }
            let runEndColumn = Math.min(
              bufferLineLength,
              nextAsciiRunEventColumn,
              bufferColumn + Math.max(0, Math.floor(this.softWrapColumn - screenLineWidth)),
            );
            if (nextFoldEvent?.bufferRow === bufferRow) {
              runEndColumn = Math.min(runEndColumn, nextFoldEvent.bufferColumn);
            }
            const runLength = runEndColumn - bufferColumn;
            if (runLength > 0) {
              bufferColumn = runEndColumn;
              unexpandedScreenColumn += runLength;
              expandedScreenColumn += runLength;
              screenLineWidth += runLength;
            }
          }
        }
      }

      expandedScreenColumn--;
      insertedScreenLineLengths.push(expandedScreenColumn);
      insertedTabCounts.push(currentScreenLineTabColumns.length);
      insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
      if (expandedScreenColumn > rightmostInsertedScreenPosition.column) {
        rightmostInsertedScreenPosition.row = screenRow;
        rightmostInsertedScreenPosition.column = expandedScreenColumn;
      }

      bufferRow++;
      bufferColumn = 0;

      screenRow++;
      unexpandedScreenColumn = 0;
      expandedScreenColumn = 0;
    }

    applyGeometrySplices(this.spatialIndex, pendingSpatialSplices);

    if (bufferRow > this.indexedBufferRowCount) {
      this.indexedBufferRowCount = bufferRow;
    }

    const oldScreenRowCount = oldEndScreenRow - startScreenRow;
    this.spliceScreenLineLengths(startScreenRow, oldScreenRowCount, insertedScreenLineLengths);
    this.tabCounts.spliceRows(startScreenRow, oldScreenRowCount, insertedTabCounts);
    this.screenLineStartFlags.spliceRows(
      startScreenRow,
      oldScreenRowCount,
      insertedScreenLineStartFlags,
    );

    const lastRemovedScreenRow = startScreenRow + oldScreenRowCount;
    if (rightmostInsertedScreenPosition.column > this.rightmostScreenPosition.column) {
      this.rightmostScreenPosition = rightmostInsertedScreenPosition;
    } else if (lastRemovedScreenRow < this.rightmostScreenPosition.row) {
      this.rightmostScreenPosition.row += insertedScreenLineLengths.length - oldScreenRowCount;
    } else if (startScreenRow <= this.rightmostScreenPosition.row) {
      this.rightmostScreenPosition = this.findRightmostScreenPosition();
    }

    this.cachedScreenLines.spliceRows(
      startScreenRow,
      oldScreenRowCount,
      insertedScreenLineLengths.length,
    );

    return {
      start: Point(startScreenRow, 0),
      oldExtent: Point(oldScreenRowCount, 0),
      newExtent: Point(insertedScreenLineLengths.length, 0),
    };
  }

  spliceScreenLineLengths(startRow, oldRowCount, insertedLengths) {
    this.screenLineLengths.spliceRows(startRow, oldRowCount, insertedLengths);
  }

  findRightmostScreenPosition() {
    return Point(this.screenLineLengths.maximumIndex, this.screenLineLengths.maximum);
  }

  populateSpatialIndexIfNeeded(endBufferRow, endScreenRow, deadline = NullDeadline) {
    if (this.softWrapColumn === Infinity) {
      if (!this.layoutState.unwrapped) {
        this.layoutState.unwrapped = true;
        configureUnwrappedMetrics(this.layoutState, this.buffer, this.tabLength);
        this.updateUnwrappedSpatialIndex(0, 0, this.buffer.getLineCount());
      }
      return;
    }
    endBufferRow = Math.min(this.buffer.getLineCount(), endBufferRow);
    if (endBufferRow > this.indexedBufferRowCount && endScreenRow > this.screenLineLengths.length) {
      this.updateSpatialIndex(
        this.indexedBufferRowCount,
        endBufferRow,
        endBufferRow,
        endScreenRow,
        deadline,
      );
    }
  }

  // With wrapping disabled only folds change row geometry. Build the patch
  // from those exceptions and leave all ordinary row metrics unmaterialized.
  // A jump across ten million rows is therefore the same operation as a jump
  // across ten; edit cost depends on changed folds and measured blocks only.
  updateUnwrappedSpatialIndex(startBufferRow, oldEndBufferRow, newEndBufferRow) {
    const originalOldEnd = oldEndBufferRow;
    startBufferRow = this.findBoundaryPrecedingBufferRow(startBufferRow);
    oldEndBufferRow = this.findBoundaryFollowingBufferRow(oldEndBufferRow);
    newEndBufferRow += oldEndBufferRow - originalOldEnd;
    const start = Point(startBufferRow, 0);
    const oldEnd = Point(oldEndBufferRow, 0);
    const startScreenRow = this.translateBufferPositionWithSpatialIndex(start, "backward").row;
    const oldEndScreenRow = this.translateBufferPositionWithSpatialIndex(oldEnd, "backward").row;
    this.spatialIndex.spliceOld(
      start,
      Point(oldEndBufferRow - startBufferRow, 0),
      Point(newEndBufferRow - startBufferRow, 0),
    );
    const folds = sortedFoldEvents(
      this.computeFoldsInBufferRowRange(startBufferRow, newEndBufferRow),
    );
    let insertedRowCount = newEndBufferRow - startBufferRow;
    for (const fold of folds) {
      const foldStart = Point(fold.bufferRow, fold.bufferColumn);
      const screenStart = this.translateBufferPositionWithSpatialIndex(foldStart, "backward");
      this.spatialIndex.splice(screenStart, traversal(fold.end, foldStart), Point(0, 1));
      insertedRowCount -= fold.end.row - fold.bufferRow;
    }
    const removedRowCount = oldEndScreenRow - startScreenRow;
    this.screenLineLengths.spliceRows(startScreenRow, removedRowCount, insertedRowCount);
    this.tabCounts.spliceRows(startScreenRow, removedRowCount, insertedRowCount);
    this.screenLineStartFlags.spliceRows(startScreenRow, removedRowCount, insertedRowCount);
    this.layoutState.unwrappedRows.spliceRows(startScreenRow, removedRowCount, insertedRowCount);
    this.cachedScreenLines.spliceRows(startScreenRow, removedRowCount, insertedRowCount);
    this.indexedBufferRowCount = this.buffer.getLineCount();
    return {
      start: Point(startScreenRow, 0),
      oldExtent: Point(removedRowCount, 0),
      newExtent: Point(insertedRowCount, 0),
    };
  }

  findBoundaryPrecedingBufferRow(bufferRow) {
    while (true) {
      if (bufferRow === 0) return 0;
      let screenPosition = this.translateBufferPositionWithSpatialIndex(
        Point(bufferRow, 0),
        "backward",
      );
      let bufferPosition = this.translateScreenPositionWithSpatialIndex(
        Point(screenPosition.row, 0),
        "backward",
        false,
      );
      if (screenPosition.column === 0 && bufferPosition.column === 0) {
        return bufferPosition.row;
      } else {
        bufferRow = bufferPosition.row;
      }
    }
  }

  findBoundaryFollowingBufferRow(bufferRow) {
    while (true) {
      let screenPosition = this.translateBufferPositionWithSpatialIndex(
        Point(bufferRow, 0),
        "forward",
      );
      if (screenPosition.column === 0) {
        return bufferRow;
      } else {
        const endOfScreenRow = Point(
          screenPosition.row,
          this.screenLineLengths.get(screenPosition.row),
        );
        bufferRow =
          this.translateScreenPositionWithSpatialIndex(endOfScreenRow, "forward", false).row + 1;
      }
    }
  }

  findBoundaryFollowingScreenRow(screenRow) {
    while (true) {
      let bufferPosition = this.translateScreenPositionWithSpatialIndex(
        Point(screenRow, 0),
        "forward",
      );
      if (bufferPosition.column === 0) {
        return [bufferPosition.row, screenRow];
      } else {
        const endOfBufferRow = Point(
          bufferPosition.row,
          this.buffer.lineLengthForRow(bufferPosition.row),
        );
        screenRow = this.translateBufferPositionWithSpatialIndex(endOfBufferRow, "forward").row + 1;
      }
    }
  }

  // Returns a map describing fold starts and ends, structured as
  // fold start row -> fold start column -> fold end point
  computeFoldsInBufferRowRange(startBufferRow, endBufferRow) {
    const folds = {};
    const foldMarkers = this.foldsMarkerLayer.findMarkers({
      intersectsRowRange: [startBufferRow, endBufferRow - 1],
    });

    // If the given buffer range exceeds the indexed range, we need to ensure
    // we consider any folds that intersect the combined row range of the
    // initially-queried folds, since we couldn't use the index to expand the
    // row range to account for these extra folds ahead of time.
    if (endBufferRow >= this.indexedBufferRowCount) {
      for (let i = 0; i < foldMarkers.length; i++) {
        const marker = foldMarkers[i];
        const nextMarker = foldMarkers[i + 1];
        if (
          marker.getEndPosition().row >= endBufferRow &&
          (!nextMarker || nextMarker.getEndPosition().row < marker.getEndPosition().row)
        ) {
          const intersectingMarkers = this.foldsMarkerLayer.findMarkers({
            intersectsRow: marker.getEndPosition().row,
          });
          endBufferRow = marker.getEndPosition().row + 1;
          foldMarkers.splice(i, foldMarkers.length - i, ...intersectingMarkers);
        }
      }
    }

    for (let i = 0; i < foldMarkers.length; i++) {
      const foldStart = foldMarkers[i].getStartPosition();
      let foldEnd = foldMarkers[i].getEndPosition();

      // Merge overlapping folds
      while (i < foldMarkers.length - 1) {
        const nextFoldMarker = foldMarkers[i + 1];
        if (compare(nextFoldMarker.getStartPosition(), foldEnd) < 0) {
          if (compare(foldEnd, nextFoldMarker.getEndPosition()) < 0) {
            foldEnd = nextFoldMarker.getEndPosition();
          }
          i++;
        } else {
          break;
        }
      }

      // Add non-empty folds to the returned result
      if (compare(foldStart, foldEnd) < 0) {
        if (!folds[foldStart.row]) folds[foldStart.row] = {};
        folds[foldStart.row][foldStart.column] = foldEnd;
      }
    }

    return folds;
  }

  setParams(params) {
    let paramsChanged = false;
    if (Object.hasOwn(params, "resolveSoftWrapColumn")) {
      this.resolveSoftWrapColumn = params.resolveSoftWrapColumn;
    }
    if (Object.hasOwn(params, "tabLength") && params.tabLength !== this.tabLength) {
      paramsChanged = true;
      this.tabLength = params.tabLength;
    }
    if (
      Object.hasOwn(params, "invisibles") &&
      !invisiblesEqual(params.invisibles, this.invisibles)
    ) {
      paramsChanged = true;
      this.invisibles = params.invisibles;
      this.eolInvisibles = {
        "\r": this.invisibles.cr,
        "\n": this.invisibles.eol,
        "\r\n": this.invisibles.cr + this.invisibles.eol,
      };
    }
    if (Object.hasOwn(params, "softWrapColumn")) {
      let softWrapColumn =
        params.softWrapColumn != null ? Math.max(1, params.softWrapColumn) : Infinity;
      if (softWrapColumn !== this.softWrapColumn) {
        paramsChanged = true;
        this.softWrapColumn = softWrapColumn;
      }
    }
    if (
      Object.hasOwn(params, "softWrapHangingIndent") &&
      params.softWrapHangingIndent !== this.softWrapHangingIndent
    ) {
      paramsChanged = true;
      this.softWrapHangingIndent = params.softWrapHangingIndent;
    }
    if (
      Object.hasOwn(params, "ratioForCharacter") &&
      params.ratioForCharacter !== this.ratioForCharacter
    ) {
      paramsChanged = true;
      this.ratioForCharacter = params.ratioForCharacter;
      this.standardRatioForCharacter = null;
    }
    if (Object.hasOwn(params, "standardRatioForCharacter")) {
      this.standardRatioForCharacter = params.standardRatioForCharacter;
    }
    if (Object.hasOwn(params, "isWrapBoundary") && params.isWrapBoundary !== this.isWrapBoundary) {
      paramsChanged = true;
      this.isWrapBoundary = params.isWrapBoundary;
    }
    if (Object.hasOwn(params, "foldCharacter") && params.foldCharacter !== this.foldCharacter) {
      paramsChanged = true;
      this.foldCharacter = params.foldCharacter;
    }
    if (Object.hasOwn(params, "atomicSoftTabs") && params.atomicSoftTabs !== this.atomicSoftTabs) {
      paramsChanged = true;
      this.atomicSoftTabs = params.atomicSoftTabs;
    }
    return paramsChanged;
  }

  isSoftWrapHunk(hunk) {
    return isEqual(hunk.oldStart, hunk.oldEnd);
  }
}

function shouldSkipHardTabRuns(layer, position, tabCount) {
  // Dense rows and short queries keep the scalar loop: searching a succession
  // of tiny runs costs more than advancing their individual characters.
  return (
    !layer.layoutState.unwrapped &&
    layer.screenLineLengths.get(position.row) >= tabCount * HARD_TAB_RUN_MIN_LENGTH &&
    position.column >= HARD_TAB_RUN_MIN_LENGTH &&
    Number.isInteger(position.column) &&
    Number.isInteger(layer.tabLength) &&
    Number.isInteger(layer.softWrapHangingIndent)
  );
}

function translateHardTabsWithRunSkipping(layer, target, tabCount, expanding, clipDirection) {
  const screenRowStart = Point(target.row, 0);
  const screenRowEnd = expanding
    ? target
    : Point(target.row, layer.screenLineLengths.get(target.row));
  const hunks = layer.spatialIndex.getChangesInNewRange(screenRowStart, screenRowEnd);
  let hunkIndex = 0;
  let unexpandedColumn = 0;
  let expandedColumn = 0;
  let { row: bufferRow, column: bufferColumn } =
    layer.translateScreenPositionWithSpatialIndex(screenRowStart);
  let line = layer.buffer.lineForRow(bufferRow);

  while (tabCount > 0) {
    const remaining = target.column - (expanding ? unexpandedColumn : expandedColumn);
    if (remaining === 0) break;

    const hunk = hunks[hunkIndex];
    if (hunk && hunk.oldStart.row === bufferRow && hunk.oldStart.column === bufferColumn) {
      if (layer.isSoftWrapHunk(hunk)) {
        if (hunkIndex !== 0) throw new Error("Unexpected soft wrap hunk");
        unexpandedColumn = expanding
          ? hunk.newEnd.column
          : Math.min(target.column, hunk.newEnd.column);
        expandedColumn = unexpandedColumn;
      } else {
        ({ row: bufferRow, column: bufferColumn } = hunk.oldEnd);
        line = layer.buffer.lineForRow(bufferRow);
        unexpandedColumn++;
        expandedColumn++;
      }
      hunkIndex++;
      continue;
    }

    if (line[bufferColumn] === "\t") {
      const nextTabStop = expanding
        ? expandedColumn + (layer.tabLength - (expandedColumn % layer.tabLength))
        : expandedColumn + layer.tabLength - (expandedColumn % layer.tabLength);
      if (!expanding && nextTabStop > target.column) {
        const forward =
          clipDirection === "forward" ||
          (clipDirection !== "backward" &&
            target.column > Math.ceil((nextTabStop + expandedColumn) / 2));
        return Point(target.row, unexpandedColumn + (forward ? 1 : 0));
      }
      expandedColumn = nextTabStop;
      unexpandedColumn++;
      bufferColumn++;
      tabCount--;
    } else {
      // Ordinary UTF-16 runs have identical buffer and screen extents. Bound
      // the search by the target and next fold; a tab far beyond an early
      // target must not make a cursor query scan the rest of a huge line.
      let endColumn = Math.min(line.length, bufferColumn + remaining);
      if (hunk && hunk.oldStart.row === bufferRow) {
        endColumn = Math.min(endColumn, hunk.oldStart.column);
      }
      const nextTabOffset = line.slice(bufferColumn, endColumn).indexOf("\t");
      if (nextTabOffset >= 0) endColumn = bufferColumn + nextTabOffset;
      const distance = endColumn - bufferColumn;
      unexpandedColumn += distance;
      expandedColumn += distance;
      bufferColumn = endColumn;
    }
  }

  const column = expanding
    ? expandedColumn + target.column - unexpandedColumn
    : unexpandedColumn + target.column - expandedColumn;
  return column === target.column ? target : Point(target.row, column);
}

function createEmptyLayoutState() {
  return {
    spatialIndex: new Patch({
      mergeAdjacentChanges: false,
    }),
    tabCounts: new RowSequence(),
    screenLineStartFlags: new RowSequence(),
    screenLineLengths: new RowSequence(),
    rightmostScreenPosition: Point(0, 0),
    indexedBufferRowCount: 0,
    unwrappedRows: new RowSequence(),
  };
}

function copyLayoutState(state) {
  const copy = {
    spatialIndex: state.spatialIndex.copy(),
    tabCounts: state.tabCounts.copy(),
    screenLineStartFlags: state.screenLineStartFlags.copy(),
    screenLineLengths: state.screenLineLengths.copy(),
    rightmostScreenPosition: state.rightmostScreenPosition.copy(),
    indexedBufferRowCount: state.indexedBufferRowCount,
    unwrapped: state.unwrapped,
    unwrappedRows: state.unwrappedRows.copy(),
  };
  if (state.unwrapped) configureUnwrappedMetrics(copy, state.buffer, state.tabLength);
  return copy;
}

function configureUnwrappedMetrics(state, buffer, tabLength) {
  state.buffer = buffer;
  state.tabLength = tabLength;
  state.screenLineLengths.resolve = (row) => measureUnwrappedRow(state, row).length;
  state.tabCounts.resolve = (row) => measureUnwrappedRow(state, row).tabs;
  state.screenLineStartFlags.resolve = () => SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE;
}

function measureUnwrappedRow(state, screenRow) {
  const start = Point(screenRow, 0);
  const prior = state.spatialIndex.changeForNewPosition(start);
  let position = prior ? traverse(prior.oldEnd, traversal(start, prior.newEnd)) : start;
  // A fold beginning at column zero still displays its fold character.
  if (prior && compare(start, prior.newEnd) < 0) position = prior.oldStart;
  const startBufferRow = position.row;
  const folds = state.spatialIndex.getChangesInNewRange(start, Point(screenRow + 1, 0));
  const source = state.buffer.getTextSnapshot();
  const reader = source.reader(32768);
  let length = 0;
  let tabs = 0;
  let rawLength = 0;
  let firstNonWhitespaceRawColumn = Infinity;
  const runs = [];
  let longSourceLine = false;
  const append = (from, to) => {
    if (state.buffer.lineLengthForRow(from.row) > 10000) longSourceLine = true;
    let offset = source.lineStart(from.row) + from.column;
    let column = from.column;
    const end = source.lineStart(to.row) + to.column;
    while (offset < end) {
      const part = reader(offset).slice(0, end - offset);
      if (firstNonWhitespaceRawColumn === Infinity) {
        const first = part.search(/[^ \t]/);
        if (first >= 0) firstNonWhitespaceRawColumn = rawLength + first;
      }
      const run = {
        rowDelta: from.row - startBufferRow,
        column,
        rawColumn: rawLength,
        screenColumn: length,
        textLength: part.length,
      };
      let previous = 0;
      for (let tab = part.indexOf("\t"); tab >= 0; tab = part.indexOf("\t", previous)) {
        length += tab - previous;
        length += state.tabLength - (length % state.tabLength);
        tabs++;
        previous = tab + 1;
      }
      length += part.length - previous;
      run.screenEndColumn = length;
      runs.push(run);
      rawLength += part.length;
      column += part.length;
      offset += part.length;
    }
  };
  for (const fold of folds) {
    if (fold.newStart.row !== screenRow) continue;
    append(position, fold.oldStart);
    runs.push({
      rawColumn: rawLength,
      screenColumn: length,
      screenEndColumn: length + 1,
      fold: true,
      rowDelta: fold.oldStart.row - startBufferRow,
      column: fold.oldStart.column,
      textLength: 1,
      endRowDelta: fold.oldEnd.row - startBufferRow,
      endColumn: fold.oldEnd.column,
    });
    rawLength++;
    length++;
    position = fold.oldEnd;
  }
  append(position, Point(position.row, state.buffer.lineLengthForRow(position.row)));
  state.screenLineLengths.set(screenRow, length);
  state.tabCounts.set(screenRow, tabs);
  const result = { length, tabs, rawLength, runs, firstNonWhitespaceRawColumn, longSourceLine };
  // Ordinary rows need only their two numeric summaries. Large rows retain
  // bounded-chunk checkpoints so navigation and windows start near the target.
  if (rawLength > 8192 || longSourceLine) state.unwrappedRows.set(screenRow, result);
  return result;
}

// Stable prefix estimates are computed once per chunk, independent of the
// viewport window. DOM measurements refine visible glyph positions; changing
// the window must never redefine the coordinate of an already-known prefix.
function measureUnwrappedPixelColumns(
  layer,
  text,
  column,
  pixel,
  previousCode,
  targetColumn,
  targetPixel,
) {
  const asciiEvents = /[\t\u0080-\uffff]/g;
  const standard = layer.hasStandardCharacterWidth();
  for (let index = 0; index < text.length;) {
    if (column >= targetColumn || pixel >= targetPixel) break;
    const code = text.charCodeAt(index);
    let columns = 1;
    let width;
    if (standard && code < 128 && code !== 9) {
      asciiEvents.lastIndex = index;
      const end = asciiEvents.exec(text)?.index ?? text.length;
      columns = end - index;
      width = columns;
    } else if (code === 9) {
      columns = layer.tabLength - (column % layer.tabLength);
      width = columns * layer.ratioForCharacter(" ");
    } else if (
      (code >= 0xdc00 && code <= 0xdfff && previousCode >= 0xd800 && previousCode <= 0xdbff) ||
      code === 0x200d ||
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    ) {
      width = 0;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      width = 2 * layer.ratioForCharacter(" ");
    } else width = layer.ratioForCharacter(text[index]);
    if (!Number.isFinite(width) || width < 0) width = columns;
    const fraction = Math.max(
      0,
      Math.min(1, (targetColumn - column) / columns, width > 0 ? (targetPixel - pixel) / width : 1),
    );
    column += columns * fraction;
    pixel += width * fraction;
    if (fraction < 1) break;
    const consumed = standard && code < 128 && code !== 9 ? columns : 1;
    previousCode = text.charCodeAt(index + consumed - 1);
    index += consumed;
  }
  return { column, pixel };
}

function translateUnwrappedTabs(layer, target, expanding, clipDirection) {
  const row = layer.getUnwrappedRow(target.row);
  // Preserve the legacy fractional-column contract: its scalar traversal can
  // only stop at an exactly equal buffer column, so a fractional target visits
  // every tab before applying the residual offset.
  if (expanding && !Number.isInteger(target.column)) {
    return Point(target.row, row.length + target.column - row.rawLength);
  }
  if (!expanding && (!Number.isInteger(target.column) || !Number.isInteger(layer.tabLength))) {
    let raw = 0;
    let screen = 0;
    let tabs = row.tabs;
    const firstRow = layer.translateScreenPositionWithSpatialIndex(Point(target.row, 0)).row;
    const source = layer.buffer.getTextSnapshot();
    for (const run of row.runs) {
      const offset = source.lineStart(firstRow + run.rowDelta) + run.column;
      const text = run.fold ? layer.foldCharacter : source.slice(offset, offset + run.textLength);
      for (const character of text.split("")) {
        if (screen === target.column || tabs === 0)
          return Point(target.row, raw + target.column - screen);
        if (character === "\t") {
          const next = screen + layer.tabLength - (screen % layer.tabLength);
          if (next > target.column)
            return Point(
              target.row,
              raw +
                (clipDirection === "forward" ||
                (clipDirection !== "backward" && target.column > Math.ceil((screen + next) / 2))
                  ? 1
                  : 0),
            );
          screen = next;
          tabs--;
        } else screen++;
        raw++;
      }
    }
    return Point(target.row, raw + target.column - screen);
  }
  const key = expanding ? "rawColumn" : "screenColumn";
  let low = 0;
  let high = row.runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (row.runs[middle][key] <= target.column) low = middle + 1;
    else high = middle;
  }
  const run = row.runs[Math.max(0, low - 1)];
  if (!run) return target;
  let raw = run.rawColumn;
  let screen = run.screenColumn;
  const startBufferRow = layer.translateScreenPositionWithSpatialIndex(Point(target.row, 0)).row;
  const source = layer.buffer.getTextSnapshot();
  const offset = source.lineStart(startBufferRow + run.rowDelta) + run.column;
  const text = run.fold ? layer.foldCharacter : source.slice(offset, offset + run.textLength);
  let previous = 0;
  for (let tab = text.indexOf("\t"); tab >= 0; tab = text.indexOf("\t", previous)) {
    const distance = tab - previous;
    if (target.column < (expanding ? raw : screen) + distance) break;
    raw += distance;
    screen += distance;
    if (!expanding && target.column === screen) return Point(target.row, raw);
    const next = screen + layer.tabLength - (screen % layer.tabLength);
    if (expanding) {
      if (target.column <= raw) break;
    } else if (target.column < next) {
      return Point(
        target.row,
        raw +
          (clipDirection === "forward" ||
          (clipDirection !== "backward" && target.column > Math.ceil((screen + next) / 2))
            ? 1
            : 0),
      );
    }
    screen = next;
    raw++;
    previous = tab + 1;
  }
  return Point(target.row, expanding ? screen + target.column - raw : raw + target.column - screen);
}

function bufferPositionThroughHunk(bufferPosition, hunk, clipDirection) {
  if (!hunk) return bufferPosition;
  if (compare(bufferPosition, hunk.oldEnd) >= 0) {
    return traverse(hunk.newEnd, traversal(bufferPosition, hunk.oldEnd));
  }
  if (compare(hunk.oldStart, bufferPosition) === 0 || clipDirection === "backward") {
    return hunk.newStart;
  }
  if (clipDirection === "forward") return hunk.newEnd;
  const fromStart = traversal(bufferPosition, hunk.oldStart);
  const toEnd = traversal(hunk.oldEnd, bufferPosition);
  return compare(fromStart, toEnd) <= 0 ? hunk.newStart : hunk.newEnd;
}

function invisiblesEqual(left, right) {
  let leftKeys = Object.keys(left);
  let rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function isWordStart(previousCharacter, character) {
  return (
    (previousCharacter === " " || previousCharacter === "\t") &&
    character !== " " &&
    character !== "\t"
  );
}

function unitRatio() {
  return 1;
}

function sortedFoldEvents(folds) {
  const events = [];
  for (const row of Object.keys(folds)) {
    const bufferRow = Number(row);
    for (const column of Object.keys(folds[row])) {
      events.push({
        bufferRow,
        bufferColumn: Number(column),
        end: folds[row][column],
      });
    }
  }
  events.sort(
    (left, right) => left.bufferRow - right.bufferRow || left.bufferColumn - right.bufferColumn,
  );
  return events;
}

function asciiWrapBoundaryModeForLine(displayLayer, line, lineLength) {
  if (lineLength < SIMPLE_LINE_FAST_PATH_MIN_LENGTH) return ASCII_WRAP_BOUNDARY_NONE;
  if (!ASCII_ONLY_REGEXP.test(line)) return ASCII_WRAP_BOUNDARY_NONE;
  if (
    displayLayer.ratioForCharacter !== unitRatio &&
    !asciiCharactersHaveUnitWidth(displayLayer.ratioForCharacter)
  ) {
    return ASCII_WRAP_BOUNDARY_NONE;
  }

  if (displayLayer.isWrapBoundary === isWordStart) return ASCII_WRAP_BOUNDARY_WHITESPACE;
  if (displayLayer.isWrapBoundary === defaultIsWrapBoundary) return ASCII_WRAP_BOUNDARY_STANDARD;
  return ASCII_WRAP_BOUNDARY_NONE;
}

function canUseSimpleLineFastPath(displayLayer, line, asciiWrapBoundaryMode) {
  if (!Number.isInteger(displayLayer.softWrapColumn)) return false;
  if (displayLayer.softWrapColumn < 1 || displayLayer.softWrapHangingIndent !== 0) return false;

  if (asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_WHITESPACE) {
    if (!ASCII_WITHOUT_WHITESPACE_REGEXP.test(line)) return false;
  } else if (asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_STANDARD) {
    if (!ASCII_WITHOUT_STANDARD_WRAP_BOUNDARIES_REGEXP.test(line)) return false;
  } else {
    return false;
  }
  return true;
}

function canUseAsciiBoundaryFastPath(displayLayer, line, asciiWrapBoundaryMode) {
  if (!Number.isInteger(displayLayer.softWrapColumn)) return false;
  if (displayLayer.softWrapColumn < 1 || displayLayer.softWrapHangingIndent !== 0) return false;
  if (line[0] === " " || line.indexOf("\t") >= 0) return false;
  return (
    asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_WHITESPACE ||
    asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_STANDARD
  );
}

function asciiRunEventsForLine(displayLayer, line, asciiWrapBoundaryMode) {
  if (
    line.length < SIMPLE_LINE_FAST_PATH_MIN_LENGTH ||
    asciiWrapBoundaryMode !== ASCII_WRAP_BOUNDARY_NONE ||
    !displayLayer.hasStandardCharacterWidth() ||
    !displayLayer.hasStandardWrapBoundary()
  ) {
    return null;
  }
  const mode =
    displayLayer.isWrapBoundary === defaultIsWrapBoundary
      ? ASCII_WRAP_BOUNDARY_STANDARD
      : ASCII_WRAP_BOUNDARY_WHITESPACE;
  return canUseAsciiEventFastPath(displayLayer, line, mode, true)
    ? /[\t \x2d\x2f\u0080-\uffff]/g
    : null;
}

function canUseAsciiEventFastPath(
  displayLayer,
  line,
  asciiWrapBoundaryMode,
  includeUnicode = false,
) {
  if (
    asciiWrapBoundaryMode !== ASCII_WRAP_BOUNDARY_WHITESPACE &&
    asciiWrapBoundaryMode !== ASCII_WRAP_BOUNDARY_STANDARD
  ) {
    return false;
  }
  if (!Number.isInteger(displayLayer.softWrapColumn) || displayLayer.softWrapColumn < 1) {
    return false;
  }
  if (!Number.isInteger(displayLayer.tabLength) || displayLayer.tabLength < 1) return false;
  if (
    !Number.isInteger(displayLayer.softWrapHangingIndent) ||
    displayLayer.softWrapHangingIndent < 0
  ) {
    return false;
  }

  // The event scanner wins by jumping over ordinary runs. When delimiters,
  // tabs and wrap points themselves occupy much of the line, its bookkeeping
  // costs more than the compact character loop. Probe bounded windows at the
  // start, middle, and end, and leave dense lines on the general path.
  const sampleLength = Math.min(line.length, ASCII_EVENT_DENSITY_SAMPLE_SIZE);
  const windowLength = line.length <= sampleLength ? sampleLength : Math.floor(sampleLength / 3);
  const windowStarts =
    line.length <= sampleLength
      ? [0]
      : [0, Math.floor((line.length - windowLength) / 2), line.length - windowLength];
  const sampledCharacterCount = windowLength * windowStarts.length;
  let eventCount = Math.ceil(sampledCharacterCount / displayLayer.softWrapColumn);
  const eventLimit = sampledCharacterCount * ASCII_EVENT_DENSITY_LIMIT;
  for (const windowStart of windowStarts) {
    const windowEnd = windowStart + windowLength;
    for (let i = windowStart; i < windowEnd; i++) {
      const character = line[i];
      if (character === "\t") {
        // A tab is both a width-changing event and a possible wrap delimiter.
        eventCount += 2;
      } else if (
        (includeUnicode && character.charCodeAt(0) > 127) ||
        character === " " ||
        ((includeUnicode || asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_STANDARD) &&
          (character === "-" || character === "/"))
      ) {
        eventCount++;
      }
      if (eventCount > eventLimit) return false;
    }
  }
  return true;
}

function queueSpatialSplice(
  splices,
  startRow,
  startColumn,
  deletedRows,
  deletedColumns,
  insertedRows,
  insertedColumns,
) {
  splices.push(startRow, startColumn, deletedRows, deletedColumns, insertedRows, insertedColumns);
}

function applyGeometrySplices(patch, splices) {
  if (splices.length === 0) return;

  const packed = new Uint32Array(splices.length);
  for (let i = 0; i < splices.length; i++) {
    packed[i] = Number.isFinite(splices[i]) ? splices[i] : 0xffffffff;
  }
  patch.spliceMany(packed);
}

function populateSpatialIndexForAsciiBoundaryLine(
  displayLayer,
  line,
  screenRow,
  asciiWrapBoundaryMode,
  pendingSpatialSplices,
  insertedScreenLineLengths,
  insertedTabCounts,
  insertedScreenLineStartFlags,
  rightmostInsertedScreenPosition,
) {
  const boundaryCharacters =
    asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_WHITESPACE
      ? WHITESPACE_WRAP_BOUNDARY_CHARACTERS
      : STANDARD_WRAP_BOUNDARY_CHARACTERS;
  const nextBoundaryColumns = boundaryCharacters.map((character) => line.indexOf(character));
  const softWrapColumn = displayLayer.softWrapColumn;
  let bufferLineStartColumn = 0;
  let lastBoundaryColumn = 0;
  let currentScreenLineStartFlags = SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE;

  while (line.length - bufferLineStartColumn > softWrapColumn) {
    const targetColumn = bufferLineStartColumn + softWrapColumn;

    while (true) {
      let boundaryCharacterIndex = -1;
      let delimiterColumn = Infinity;
      for (let i = 0; i < nextBoundaryColumns.length; i++) {
        const candidateColumn = nextBoundaryColumns[i];
        if (candidateColumn >= 0 && candidateColumn < delimiterColumn) {
          boundaryCharacterIndex = i;
          delimiterColumn = candidateColumn;
        }
      }

      if (boundaryCharacterIndex < 0 || delimiterColumn + 1 > targetColumn) break;

      const boundaryColumn = delimiterColumn + 1;
      if (boundaryColumn > bufferLineStartColumn && line[boundaryColumn] !== " ") {
        lastBoundaryColumn = boundaryColumn;
      }
      nextBoundaryColumns[boundaryCharacterIndex] = line.indexOf(
        boundaryCharacters[boundaryCharacterIndex],
        boundaryColumn,
      );
    }

    const wrapColumn =
      lastBoundaryColumn > bufferLineStartColumn ? lastBoundaryColumn : targetColumn;
    const screenLineLength = wrapColumn - bufferLineStartColumn;
    queueSpatialSplice(pendingSpatialSplices, screenRow, screenLineLength, 0, 0, 1, 0);
    insertedScreenLineLengths.push(screenLineLength);
    insertedTabCounts.push(0);
    insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
    if (screenLineLength > rightmostInsertedScreenPosition.column) {
      rightmostInsertedScreenPosition.row = screenRow;
      rightmostInsertedScreenPosition.column = screenLineLength;
    }

    screenRow++;
    bufferLineStartColumn = wrapColumn;
    lastBoundaryColumn = 0;
    currentScreenLineStartFlags = 0;
  }

  const finalScreenLineLength = line.length - bufferLineStartColumn;
  insertedScreenLineLengths.push(finalScreenLineLength);
  insertedTabCounts.push(0);
  insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
  if (finalScreenLineLength > rightmostInsertedScreenPosition.column) {
    rightmostInsertedScreenPosition.row = screenRow;
    rightmostInsertedScreenPosition.column = finalScreenLineLength;
  }

  return screenRow;
}

function populateSpatialIndexForAsciiEventLine(
  displayLayer,
  line,
  screenRow,
  asciiWrapBoundaryMode,
  pendingSpatialSplices,
  insertedScreenLineLengths,
  insertedTabCounts,
  insertedScreenLineStartFlags,
  rightmostInsertedScreenPosition,
) {
  const boundaryCharacters =
    asciiWrapBoundaryMode === ASCII_WRAP_BOUNDARY_WHITESPACE
      ? WHITESPACE_EVENT_BOUNDARY_CHARACTERS
      : STANDARD_EVENT_BOUNDARY_CHARACTERS;
  const nextDelimiterColumns = boundaryCharacters.map((character) => line.indexOf(character));
  const softWrapColumn = displayLayer.softWrapColumn;
  const tabLength = displayLayer.tabLength;
  const hangingIndent = displayLayer.softWrapHangingIndent;
  const firstNonWhitespaceBufferColumn = line.search(/[^ \t]/);

  const nextBoundaryColumnAtOrAfter = (minimumColumn) => {
    while (true) {
      let boundaryCharacterIndex = -1;
      let delimiterColumn = Infinity;
      for (let i = 0; i < nextDelimiterColumns.length; i++) {
        const candidateColumn = nextDelimiterColumns[i];
        if (candidateColumn >= 0 && candidateColumn < delimiterColumn) {
          boundaryCharacterIndex = i;
          delimiterColumn = candidateColumn;
        }
      }
      if (boundaryCharacterIndex < 0) return Infinity;

      const boundaryColumn = delimiterColumn + 1;
      nextDelimiterColumns[boundaryCharacterIndex] = line.indexOf(
        boundaryCharacters[boundaryCharacterIndex],
        boundaryColumn,
      );
      if (
        boundaryColumn >= minimumColumn &&
        boundaryColumn < line.length &&
        line[boundaryColumn] !== " " &&
        line[boundaryColumn] !== "\t"
      ) {
        return boundaryColumn;
      }
    }
  };

  let nextBoundaryColumn = nextBoundaryColumnAtOrAfter(0);
  let nextTabColumn = line.indexOf("\t");
  let bufferColumn = 0;
  let unexpandedScreenColumn = 0;
  let expandedScreenColumn = 0;
  let screenLineWidth = 0;
  let firstNonWhitespaceScreenColumn = -1;
  let lastWrapBoundaryUnexpandedScreenColumn = 0;
  let lastWrapBoundaryExpandedScreenColumn = 0;
  let lastWrapBoundaryScreenLineWidth = 0;
  let screenLineBuilderInLeadingWhitespace = true;
  let currentScreenLineStartFlags = SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE;
  const currentScreenLineTabColumns = [];

  const insertSoftLineBreak = () => {
    let indentLength =
      firstNonWhitespaceScreenColumn < softWrapColumn
        ? Math.max(0, firstNonWhitespaceScreenColumn)
        : 0;
    if (indentLength + hangingIndent < softWrapColumn) indentLength += hangingIndent;

    const unexpandedWrapColumn = lastWrapBoundaryUnexpandedScreenColumn || unexpandedScreenColumn;
    const expandedWrapColumn = lastWrapBoundaryExpandedScreenColumn || expandedScreenColumn;
    const wrapWidth = lastWrapBoundaryScreenLineWidth || screenLineWidth;
    queueSpatialSplice(
      pendingSpatialSplices,
      screenRow,
      unexpandedWrapColumn,
      0,
      0,
      1,
      indentLength,
    );
    insertedScreenLineLengths.push(expandedWrapColumn);
    insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
    if (expandedWrapColumn > rightmostInsertedScreenPosition.column) {
      rightmostInsertedScreenPosition.row = screenRow;
      rightmostInsertedScreenPosition.column = expandedWrapColumn;
    }
    screenRow++;
    currentScreenLineStartFlags = screenLineBuilderInLeadingWhitespace
      ? SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE
      : 0;

    // A word-boundary wrap can move already-scanned tabs onto the next screen
    // row. Re-expand those tabs from the new indentation, exactly as the
    // general loop does.
    let unexpandedScreenColumnAfterLastTab = indentLength;
    let expandedScreenColumnAfterLastTab = indentLength;
    let tabCountPrecedingWrap = 0;
    for (let i = 0; i < currentScreenLineTabColumns.length; i++) {
      const tabColumn = currentScreenLineTabColumns[i];
      if (tabColumn < unexpandedWrapColumn) {
        tabCountPrecedingWrap++;
      } else {
        const tabColumnAfterWrap = indentLength + tabColumn - unexpandedWrapColumn;
        expandedScreenColumnAfterLastTab += tabColumnAfterWrap - unexpandedScreenColumnAfterLastTab;
        expandedScreenColumnAfterLastTab +=
          tabLength - (expandedScreenColumnAfterLastTab % tabLength);
        unexpandedScreenColumnAfterLastTab = tabColumnAfterWrap + 1;
        currentScreenLineTabColumns[i - tabCountPrecedingWrap] = tabColumnAfterWrap;
      }
    }
    insertedTabCounts.push(tabCountPrecedingWrap);
    currentScreenLineTabColumns.length -= tabCountPrecedingWrap;

    unexpandedScreenColumn = unexpandedScreenColumn - unexpandedWrapColumn + indentLength;
    expandedScreenColumn =
      expandedScreenColumnAfterLastTab +
      unexpandedScreenColumn -
      unexpandedScreenColumnAfterLastTab;
    screenLineWidth = indentLength + (screenLineWidth - wrapWidth);
    lastWrapBoundaryUnexpandedScreenColumn = 0;
    lastWrapBoundaryExpandedScreenColumn = 0;
    lastWrapBoundaryScreenLineWidth = 0;
  };

  while (bufferColumn < line.length) {
    const nextFirstNonWhitespaceColumn =
      firstNonWhitespaceScreenColumn < 0 && firstNonWhitespaceBufferColumn >= bufferColumn
        ? firstNonWhitespaceBufferColumn
        : Infinity;
    const nextSpecialColumn = Math.min(
      nextBoundaryColumn,
      nextTabColumn >= 0 ? nextTabColumn : Infinity,
      nextFirstNonWhitespaceColumn,
      line.length,
    );
    const fittingCharacterCount = Math.max(0, Math.floor(softWrapColumn - screenLineWidth));
    const overflowColumn = screenLineWidth > 0 ? bufferColumn + fittingCharacterCount : Infinity;
    const runEndColumn = Math.min(nextSpecialColumn, overflowColumn, line.length);

    if (runEndColumn > bufferColumn) {
      const runLength = runEndColumn - bufferColumn;
      bufferColumn = runEndColumn;
      unexpandedScreenColumn += runLength;
      expandedScreenColumn += runLength;
      screenLineWidth += runLength;
      continue;
    }

    const character = line[bufferColumn];
    const previousCharacter = line[bufferColumn - 1];
    if (firstNonWhitespaceScreenColumn < 0) {
      if (character !== " " && character !== "\t") {
        firstNonWhitespaceScreenColumn = expandedScreenColumn;
      }
    } else if (bufferColumn === nextBoundaryColumn) {
      lastWrapBoundaryUnexpandedScreenColumn = unexpandedScreenColumn;
      lastWrapBoundaryExpandedScreenColumn = expandedScreenColumn;
      lastWrapBoundaryScreenLineWidth = screenLineWidth;
    }
    if (bufferColumn === nextBoundaryColumn) {
      nextBoundaryColumn = nextBoundaryColumnAtOrAfter(bufferColumn + 1);
    }

    const characterWidth = character === "\t" ? tabLength - (expandedScreenColumn % tabLength) : 1;
    if (
      screenLineWidth > 0 &&
      screenLineWidth + characterWidth > softWrapColumn &&
      previousCharacter &&
      character
    ) {
      insertSoftLineBreak();
    }

    if (character !== " " && character !== "\t") {
      screenLineBuilderInLeadingWhitespace = false;
    }
    if (character === "\t") {
      currentScreenLineTabColumns.push(unexpandedScreenColumn);
      const distanceToNextTabStop = tabLength - (expandedScreenColumn % tabLength);
      expandedScreenColumn += distanceToNextTabStop;
      screenLineWidth += distanceToNextTabStop;
      nextTabColumn = line.indexOf("\t", bufferColumn + 1);
    } else {
      expandedScreenColumn++;
      screenLineWidth++;
    }
    unexpandedScreenColumn++;
    bufferColumn++;
  }

  insertedScreenLineLengths.push(expandedScreenColumn);
  insertedTabCounts.push(currentScreenLineTabColumns.length);
  insertedScreenLineStartFlags.push(currentScreenLineStartFlags);
  if (expandedScreenColumn > rightmostInsertedScreenPosition.column) {
    rightmostInsertedScreenPosition.row = screenRow;
    rightmostInsertedScreenPosition.column = expandedScreenColumn;
  }
  return screenRow;
}

function canUseUnwrappedLineFastPath(displayLayer, line, lineLength) {
  if (displayLayer.hasStandardCharacterWidth()) return true;
  if (lineLength < SIMPLE_LINE_FAST_PATH_MIN_LENGTH || !ASCII_ONLY_REGEXP.test(line)) return false;
  return asciiCharactersHaveUnitWidth(displayLayer.ratioForCharacter);
}

function asciiCharactersHaveUnitWidth(ratioForCharacter) {
  // A fixed 128 callbacks is cheaper and more predictable than searching a
  // multi-megabyte line once per possible character. This also makes the fast
  // path independent of the line's alphabet.
  for (let code = 0; code < 128; code++) {
    const character = String.fromCharCode(code);
    if (ratioForCharacter(character) !== 1) return false;
  }
  return true;
}

// The span of buffer rows covered by the folds that are in one set and not the
// other, or null when the two describe the same folds. Ranges are compared by
// value: a restored marker is a different object from the one it replaces.
function differingRowSpan(before, after) {
  const key = (range) =>
    `${range.start.row},${range.start.column},${range.end.row},${range.end.column}`;

  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));

  let startRow = Infinity;
  let endRow = -Infinity;
  const consider = (range) => {
    if (range.start.row < startRow) startRow = range.start.row;
    if (range.end.row > endRow) endRow = range.end.row;
  };

  for (const range of before) if (!afterKeys.has(key(range))) consider(range);
  for (const range of after) if (!beforeKeys.has(key(range))) consider(range);

  return endRow < startRow ? null : { startRow, endRow };
}

const NullDeadline = {
  didTimeout: false,
  timeRemaining() {
    return Infinity;
  },
};

module.exports = DisplayLayer;
