const { Emitter } = require("@lumine-code/event-kit");
const Point = require("./point");
const Range = require("./range");
const Marker = require("./marker");
const { MarkerIndex } = require("@lumine-code/superstring");
const { intersectSet } = require("./set-helpers");
const { traverse } = require("./point-helpers");
const SerializationVersion = 2;

// Compare every lazily-built history snapshot against the eager dump-based one
// and throw on any divergence. The referee for the shadow-range bookkeeping;
// costs the very dump the shadow exists to avoid, so specs only.
const VERIFY_HISTORY_SNAPSHOTS = Boolean(process.env.LUMINE_VERIFY_MARKER_SNAPSHOTS);

/**
 * @public
 * @status experimental
 *
 * A container for a related set of markers.
 *
 * This API is experimental and subject to change on any release.
 */
class MarkerLayer {
  static deserialize(delegate, state) {
    var store;
    store = new MarkerLayer(delegate, 0);
    store.deserialize(state);
    return store;
  }

  static deserializeSnapshot(snapshot) {
    var layerId, markerId, markerSnapshot, markerSnapshots, result;
    result = {};
    for (layerId in snapshot) {
      markerSnapshots = snapshot[layerId];
      result[layerId] = {};
      for (markerId in markerSnapshots) {
        markerSnapshot = markerSnapshots[markerId];
        result[layerId][markerId] = {
          ...markerSnapshot,
          range: Range.fromObject(markerSnapshot.range),
        };
      }
    }
    return result;
  }

  /**
   * @category Lifecycle
   */
  constructor(
    delegate,
    id,
    { destroyInvalidatedMarkers = false, maintainHistory = false, persistent = false, role } = {},
  ) {
    this.delegate = delegate;
    this.id = id;
    this.maintainHistory = maintainHistory;
    // Mirror of the index's ranges, `id -> {sr, sc, er, ec}`, kept only for
    // history-maintaining layers. Snapshots read this instead of paying the
    // native `index.dump()` — the dominant cost of snapshotting a layer with
    // many markers — so every index mutation below keeps it exact.
    this.historyShadow = maintainHistory ? new Map() : null;
    this.destroyInvalidatedMarkers = destroyInvalidatedMarkers;
    this.role = role;
    if (this.role === "selections") {
      this.delegate.registerSelectionsMarkerLayer(this);
    }
    this.persistent = persistent;

    this.emitter = new Emitter();
    this.index = new MarkerIndex();
    this.markersById = new Map();
    this.markersWithChangeListeners = new Set();
    this.markersWithDestroyListeners = new Set();
    this.displayMarkerLayers = new Set();
    this.destroyed = false;
    this.emitCreateMarkerEvents = false;
  }

  /**
   * @public
   * @status public
   *
   * Create a copy of this layer with markers in the same state and
   * locations.
   */
  copy() {
    let copy = this.delegate.addMarkerLayer({
      destroyInvalidatedMarkers: this.destroyInvalidatedMarkers,
      maintainHistory: this.maintainHistory,
      persistent: this.persistent,
      role: this.role,
    });
    for (let marker of this.markersById.values()) {
      let snapshot = marker.getSnapshot(null);
      copy.createMarker(marker.getRange(), snapshot);
    }
    return copy;
  }

  /**
   * @public
   * @status public
   *
   * Destroy this layer.
   */
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.clear();
    // Mark the layer destroyed before notifying the display marker layers; a
    // display layer that owns this layer calls back into this method.
    this.destroyed = true;
    this.delegate.markerLayerDestroyed(this);
    this.displayMarkerLayers.forEach(function (displayMarkerLayer) {
      return displayMarkerLayer.destroy();
    });
    this.displayMarkerLayers.clear();
    this.emitter.emit("did-destroy");
    return this.emitter.clear();
  }

  /**
   * @public
   * @status public
   *
   * Remove all markers from this layer.
   */
  clear() {
    this.markersWithDestroyListeners.forEach(function (marker) {
      // Suppress the per-marker update events; a single one is emitted below.
      return marker.destroy(true);
    });
    this.markersWithDestroyListeners.clear();
    this.markersById = new Map();
    this.index = new MarkerIndex();
    if (this.historyShadow) this.historyShadow = new Map();
    this.displayMarkerLayers.forEach(function (layer) {
      return layer.didClearBufferMarkerLayer();
    });
    return this.delegate.markersUpdated(this);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this layer has been destroyed.
   */
  isDestroyed() {
    return this.destroyed;
  }

  isAlive() {
    return !this.destroyed;
  }

  /**
   * @category Querying
   */
  /**
   * @public
   * @status public
   *
   * Get an existing marker by its id.
   */

  // Returns a `Marker`.
  getMarker(id) {
    return this.markersById.get(parseInt(id));
  }

  /**
   * @public
   * @status public
   *
   * Get all existing markers on the marker layer.
   */

  // Returns an `Array` of `Markers`.
  getMarkers() {
    return [...this.markersById.values()];
  }

  /**
   * @public
   * @status public
   *
   * Get the number of markers in the marker layer.
   */

  // Returns a `Number`.
  getMarkerCount() {
    return this.markersById.size;
  }

  /**
   * @public
   * @status public
   *
   * Find markers in the layer conforming to the given parameters.
   * See {@link TextBuffer#findMarkers} for the supported search parameters.
   */
  findMarkers(params) {
    let markerIds = null;
    // Range-based params are consumed by the index queries below; the rest are
    // matched against each candidate marker. The caller's object is not mutated.
    const markerParams = {};
    for (let [key, value] of Object.entries(params)) {
      let start, end, position;
      switch (key) {
        case "startPosition":
          markerIds = filterSet(markerIds, this.index.findStartingAt(Point.fromObject(value)));
          break;
        case "endPosition":
          markerIds = filterSet(markerIds, this.index.findEndingAt(Point.fromObject(value)));
          break;
        case "startsInRange":
          ({ start, end } = Range.fromObject(value));
          markerIds = filterSet(markerIds, this.index.findStartingIn(start, end));
          break;
        case "endsInRange":
          ({ start, end } = Range.fromObject(value));
          markerIds = filterSet(markerIds, this.index.findEndingIn(start, end));
          break;
        case "containsPoint":
        case "containsPosition":
          position = Point.fromObject(value);
          markerIds = filterSet(markerIds, this.index.findContaining(position, position));
          break;
        case "containsRange":
          ({ start, end } = Range.fromObject(value));
          markerIds = filterSet(markerIds, this.index.findContaining(start, end));
          break;
        case "intersectsRange":
          ({ start, end } = Range.fromObject(value));
          markerIds = filterSet(markerIds, this.index.findIntersecting(start, end));
          break;
        case "startRow":
          markerIds = filterSet(
            markerIds,
            this.index.findStartingIn(Point(value, 0), Point(value, Infinity)),
          );
          break;
        case "endRow":
          markerIds = filterSet(
            markerIds,
            this.index.findEndingIn(Point(value, 0), Point(value, Infinity)),
          );
          break;
        case "intersectsRow":
          markerIds = filterSet(
            markerIds,
            this.index.findIntersecting(Point(value, 0), Point(value, Infinity)),
          );
          break;
        case "intersectsRowRange":
          markerIds = filterSet(
            markerIds,
            this.index.findIntersecting(Point(value[0], 0), Point(value[1], Infinity)),
          );
          break;
        case "containedInRange":
          ({ start, end } = Range.fromObject(value));
          markerIds = filterSet(markerIds, this.index.findContainedIn(start, end));
          break;
        default:
          markerParams[key] = value;
      }
    }
    if (markerIds == null) {
      markerIds = new Set(this.markersById.keys());
    }
    let result = [];
    for (let markerId of markerIds) {
      let marker = this.markersById.get(markerId);
      if (!marker.matchesParams(markerParams)) continue;
      result.push(marker);
    }
    // Tiebreak equal ranges by id so the order doesn't depend on the
    // insertion order of `markersById`.
    result.sort((a, b) => a.compare(b) || a.id - b.id);
    return result;
  }

  /**
   * @public
   * @status public
   *
   * Get the role of the marker layer e.g. `lumine.selection`.
   */

  // Returns a `String`.
  getRole() {
    return this.role;
  }

  /**
   * @category Marker creation
   */
  /**
   * @public
   * @status public
   *
   * Create a marker with the given range.
   *
   * @param range - A {@link Range} or range-compatible `Array`
   * @param options - A hash of key-value pairs to associate with the marker. There are also reserved property names that have marker-specific meaning.
   * @param {Boolean} [options.reversed] - Creates the marker in a reversed orientation. (default: false)
   * @param {String} [options.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @param {Boolean} options.exclusive - indicating whether insertions at the start or end of the marked range should be interpreted as happening *outside* the marker. Defaults to `false`, except when using the `inside` invalidation strategy or when the marker has no tail, in which case it defaults to true. Explicitly assigning this option overrides behavior in all circumstances.
   */

  // Returns a `Marker`.
  markRange(range, options = {}) {
    return this.createMarker(this.delegate.clipRange(range), Marker.extractParams(options));
  }

  /**
   * @public
   * @status public
   *
   * Create a marker at with its head at the given position with no tail.
   *
   * @param {Point} position - or point-compatible `Array`
   * @param [options] - An `Object` with the following keys:
   * @param {String} [options.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @param {Boolean} options.exclusive - indicating whether insertions at the start or end of the marked range should be interpreted as happening *outside* the marker. Defaults to `false`, except when using the `inside` invalidation strategy or when the marker has no tail, in which case it defaults to true. Explicitly assigning this option overrides behavior in all circumstances.
   */

  // Returns a `Marker`.
  markPosition(position, options = {}) {
    position = this.delegate.clipPosition(position);
    options = Marker.extractParams(options);
    options.tailed = false;
    return this.createMarker(this.delegate.clipRange(new Range(position, position)), options);
  }

  /**
   * @category Event subscription
   */
  /**
   * @public
   * @status public
   *
   * Subscribe to be notified whenever markers are created, updated,
   * or destroyed on this layer. *Prefer this method for optimal performance
   * when interacting with layers that could contain large numbers of markers.*
   *
   *
   * Changes made within a {@link TextBuffer#transact} block are batched: subscribers
   * are notified once, at the end of the transaction. Changes made outside a
   * transaction notify subscribers synchronously per change. Either way, you
   * should re-query the layer to determine the state of markers in which you're
   * interested in. It may be counter-intuitive, but this is much more efficient
   * than subscribing to events on individual markers, which are expensive to
   * deliver.
   *
   * @param callback - A `Function` that will be called with no arguments when changes occur on this layer.
   */

  // Returns a `Disposable`.
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to be notified synchronously whenever markers are created
   * on this layer. *Avoid this method for optimal performance when interacting
   * with layers that could contain large numbers of markers.*
   *
   *
   * You should prefer {@link #onDidUpdate} when synchronous notifications aren't
   * absolutely necessary.
   *
   * @param callback - A `Function` that will be called with a `Marker` whenever a new marker is created.
   */

  // Returns a `Disposable`.
  onDidCreateMarker(callback) {
    this.emitCreateMarkerEvents = true;
    return this.emitter.on("did-create-marker", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to be notified synchronously when this layer is destroyed.
   */

  // Returns a `Disposable`.
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  /**
   * @category Private - TextBuffer interface
   */
  splice(start, oldExtent, newExtent) {
    // Markers the splice touches (closed interval, so boundary contact counts)
    // move in ways plain arithmetic cannot reproduce — a deletion collapses
    // their boundaries — so they are re-read from the index afterwards. Every
    // other marker's endpoints sit strictly outside the spliced region and
    // translate exactly.
    let touched = null;
    if (this.historyShadow) {
      touched = this.index.findIntersecting(start, traverse(start, oldExtent));
    }

    this.displayMarkerLayers.forEach((layer) => layer.bufferMarkerRangesDidChange());
    let invalidated = this.index.splice(start, oldExtent, newExtent);
    for (let id of invalidated.touch) {
      let marker = this.markersById.get(id);
      if (invalidated[marker.getInvalidationStrategy()]?.has(id)) {
        if (this.destroyInvalidatedMarkers) {
          marker.destroy();
        } else {
          marker.valid = false;
          marker.refreshHistoryProps();
        }
      }
    }

    if (this.historyShadow) {
      this.spliceHistoryShadow(touched, start, oldExtent, newExtent);
    }
  }

  spliceHistoryShadow(touched, start, oldExtent, newExtent) {
    const oldEnd = traverse(start, oldExtent);
    const newEnd = traverse(start, newExtent);
    const startRow = start.row;
    const startColumn = start.column;
    const oldEndRow = oldEnd.row;
    const oldEndColumn = oldEnd.column;
    const newEndRow = newEnd.row;
    const newEndColumn = newEnd.column;
    const rowDelta = newEndRow - oldEndRow;

    if (rowDelta !== 0 || oldEndColumn !== newEndColumn) {
      for (const [id, entry] of this.historyShadow) {
        if (touched.has(id)) continue;
        // Entirely before the splice: nothing moved.
        if (entry.er < startRow || (entry.er === startRow && entry.ec < startColumn)) continue;
        // Entirely after it: both endpoints translate by the extent change. An
        // endpoint on the old end row also shifts in column.
        if (entry.sr === oldEndRow) {
          entry.sr = newEndRow;
          entry.sc = newEndColumn + (entry.sc - oldEndColumn);
        } else {
          entry.sr += rowDelta;
        }
        if (entry.er === oldEndRow) {
          entry.er = newEndRow;
          entry.ec = newEndColumn + (entry.ec - oldEndColumn);
        } else {
          entry.er += rowDelta;
        }
      }
    }

    for (const id of touched) {
      if (!this.markersById.has(id)) continue; // destroyed by invalidation
      const range = this.index.getRange(id);
      const entry = this.historyShadow.get(id);
      entry.sr = range.start.row;
      entry.sc = range.start.column;
      entry.er = range.end.row;
      entry.ec = range.end.column;
    }
  }

  restoreFromSnapshot(snapshots, alwaysCreate) {
    if (snapshots == null) return;
    snapshots = MarkerLayer.materializeSnapshot(snapshots);
    this.displayMarkerLayers.forEach((layer) => layer.bufferMarkerRangesDidChange());

    let snapshotIds = Object.keys(snapshots);
    let existingMarkerIds = [...this.markersById.keys()];

    for (let id of snapshotIds) {
      let snapshot = snapshots[id];
      if (alwaysCreate) {
        this.createMarker(snapshot.range, snapshot, true);
        continue;
      }
      let marker = this.markersById.get(parseInt(id));
      if (marker) {
        marker.update(marker.getRange(), snapshot, true, true);
      } else {
        marker = snapshot.marker;
        if (marker) {
          this.markersById.set(marker.id, marker);
          let { range } = snapshot;
          this.index.insert(marker.id, range.start, range.end);
          this.historyShadow?.set(marker.id, {
            sr: range.start.row,
            sc: range.start.column,
            er: range.end.row,
            ec: range.end.column,
          });
          marker.refreshHistoryProps();
          marker.update(marker.getRange(), snapshot, true, true);
          if (this.emitCreateMarkerEvents) {
            this.emitter.emit("did-create-marker", marker);
          }
        } else {
          this.createMarker(snapshot.range, snapshot, true);
        }
      }
    }

    for (let id of existingMarkerIds) {
      let marker = this.markersById.get(id);
      if (marker && !snapshots[id]) {
        marker.destroy(true);
      }
    }
  }

  createSnapshot() {
    if (this.historyShadow) {
      const ranges = new Map();
      for (const [id, entry] of this.historyShadow) {
        ranges.set(id, { sr: entry.sr, sc: entry.sc, er: entry.er, ec: entry.ec });
      }
      const props = new Map();
      for (const [id, marker] of this.markersById) {
        props.set(id, marker.historyProps);
      }
      const snapshot = { __lazyMarkerSnapshot: true, ranges, props };
      if (VERIFY_HISTORY_SNAPSHOTS) this.verifyHistorySnapshot(snapshot);
      return snapshot;
    }

    return this.createEagerSnapshot();
  }

  // The pre-shadow snapshot: one native dump plus an object per marker. Kept as
  // the fallback for layers without a shadow, and as the referee the shadow is
  // verified against.
  createEagerSnapshot() {
    let result = {};
    let ranges = this.index.dump();
    for (let [id, marker] of this.markersById) {
      result[id] = marker.getSnapshot(Range.fromObject(ranges[id]));
    }
    return result;
  }

  // A lazy snapshot in the shape `restoreFromSnapshot` and history
  // serialization consume: `{id: {range, ...props, marker}}`. Built only when
  // an undo, redo, revert or serialization actually reads the snapshot —
  // taking one stays allocation-cheap however many times it happens.
  static materializeSnapshot(snapshot) {
    if (!snapshot?.__lazyMarkerSnapshot) return snapshot;
    const result = {};
    for (const [id, entry] of snapshot.ranges) {
      const props = snapshot.props.get(id);
      result[id] = Object.freeze({
        ...props,
        range: Range(Point(entry.sr, entry.sc), Point(entry.er, entry.ec)),
      });
    }
    return result;
  }

  verifyHistorySnapshot(lazySnapshot) {
    const expected = this.createEagerSnapshot();
    const actual = MarkerLayer.materializeSnapshot(lazySnapshot);
    const expectedIds = Object.keys(expected).sort();
    const actualIds = Object.keys(actual).sort();
    if (expectedIds.join(",") !== actualIds.join(",")) {
      throw new Error(
        `History snapshot id sets diverged: expected [${expectedIds}] got [${actualIds}]`,
      );
    }
    for (const id of expectedIds) {
      const a = actual[id];
      const e = expected[id];
      if (!a.range.isEqual(e.range)) {
        throw new Error(`History snapshot range diverged for ${id}: ${a.range} vs ${e.range}`);
      }
      for (const key of [
        "properties",
        "reversed",
        "tailed",
        "valid",
        "invalidate",
        "exclusive",
        "marker",
      ]) {
        const same =
          key === "properties"
            ? JSON.stringify(a[key]) === JSON.stringify(e[key])
            : a[key] === e[key];
        if (!same) {
          throw new Error(`History snapshot ${key} diverged for ${id}`);
        }
      }
    }
  }

  // Turns history snapshotting on for a layer built without it — the
  // deserialization paths flip `maintainHistory` after construction. Builds the
  // shadow from one dump and stamps every marker's props.
  enableHistorySnapshots() {
    this.maintainHistory = true;
    if (this.historyShadow) return;
    this.historyShadow = new Map();
    const ranges = this.index.dump();
    for (const id of Object.keys(ranges)) {
      const range = ranges[id];
      this.historyShadow.set(parseInt(id), {
        sr: range.start.row,
        sc: range.start.column,
        er: range.end.row,
        ec: range.end.column,
      });
    }
    for (const marker of this.markersById.values()) {
      marker.refreshHistoryProps();
    }
  }

  emitChangeEvents(snapshot) {
    // Runs with the end-of-transaction snapshot on every transact, so a lazy
    // snapshot is read per listener id rather than materialized wholesale.
    const rangeFor = (id) => {
      if (snapshot == null) return undefined;
      if (snapshot.__lazyMarkerSnapshot) {
        const entry = snapshot.ranges.get(id);
        return entry && Range(Point(entry.sr, entry.sc), Point(entry.er, entry.ec));
      }
      return snapshot[id]?.range;
    };
    let completed = false;
    try {
      this.markersWithChangeListeners.forEach(function (marker) {
        if (!marker.isDestroyed()) {
          // event handlers could destroy markers
          return marker.emitChangeEvent(rangeFor(marker.id), true, false);
        }
      });
      completed = true;
    } finally {
      // A throwing listener aborts the iteration, leaving later DisplayMarker
      // caches stale. Keep those layers dirty so getters re-read the index;
      // the next complete change-event pass will make them cacheable again.
      if (completed) {
        this.displayMarkerLayers.forEach((layer) => layer.didEmitBufferMarkerChangeEvents());
      }
    }
  }

  serialize() {
    let ranges = this.index.dump();
    let markersById = {};
    for (let [id, marker] of this.markersById) {
      markersById[id] = marker.getSnapshot(Range.fromObject(ranges[id]), false);
    }
    return {
      id: this.id,
      maintainHistory: this.maintainHistory,
      destroyInvalidatedMarkers: this.destroyInvalidatedMarkers,
      role: this.role,
      persistent: this.persistent,
      markersById,
      version: SerializationVersion,
    };
  }

  deserialize(state) {
    // var id, markerState, range, ref;
    if (state.version !== SerializationVersion) {
      return;
    }
    this.id = state.id;
    if (state.maintainHistory) this.enableHistorySnapshots();
    this.destroyInvalidatedMarkers = Boolean(state.destroyInvalidatedMarkers);
    this.role = state.role;
    if (this.role === "selections") {
      this.delegate.registerSelectionsMarkerLayer(this);
    }
    this.persistent = state.persistent;
    for (let [id, markerState] of Object.entries(state.markersById)) {
      let range = this.delegate.clipRange(Range.fromObject(markerState.range));
      // `markerState` is frozen, so instead of deleting its `range` we'll
      // create a new object and copy all properties _except_ `range`.
      let { range: _range, ...params } = markerState;
      this.addMarker(id, range, { ...params });
    }
  }

  /**
   * @category Private - Marker interface
   */
  markerUpdated() {
    return this.delegate.markersUpdated(this);
  }

  destroyMarker(marker, suppressMarkerLayerUpdateEvents = false) {
    if (this.markersById.has(marker.id)) {
      this.markersById.delete(marker.id);
      this.index.remove(marker.id);
      this.historyShadow?.delete(marker.id);
      this.markersWithChangeListeners.delete(marker);
      this.markersWithDestroyListeners.delete(marker);
      this.displayMarkerLayers.forEach(function (displayMarkerLayer) {
        displayMarkerLayer.destroyMarker(marker.id);
      });
      if (!suppressMarkerLayerUpdateEvents) {
        this.delegate.markersUpdated(this);
      }
    }
  }

  hasMarker(id) {
    return !this.destroyed && this.index.has(id);
  }

  getMarkerRange(id) {
    return Range.fromObject(this.index.getRange(id));
  }

  getMarkerStartPosition(id) {
    return Point.fromObject(this.index.getStart(id));
  }

  getMarkerEndPosition(id) {
    return Point.fromObject(this.index.getEnd(id));
  }

  compareMarkers(id1, id2) {
    return this.index.compare(id1, id2);
  }

  setMarkerRange(id, range) {
    id = parseInt(id);
    let { start, end } = Range.fromObject(range);
    start = this.delegate.clipPosition(start);
    end = this.delegate.clipPosition(end);
    this.index.remove(id);
    const inserted = this.index.insert(id, start, end);
    this.historyShadow?.set(id, {
      sr: start.row,
      sc: start.column,
      er: end.row,
      ec: end.column,
    });
    return inserted;
  }

  setMarkerIsExclusive(id, exclusive) {
    return this.index.setExclusive(id, exclusive);
  }

  createMarker(range, params, suppressMarkerLayerUpdateEvents = false) {
    let id = this.delegate.getNextMarkerId();
    let marker = this.addMarker(id, range, params);
    this.delegate.markerCreated(this, marker);
    if (!suppressMarkerLayerUpdateEvents) {
      this.delegate.markersUpdated(this);
    }
    marker.trackDestruction = this.trackDestructionInOnDidCreateMarkerCallbacks ?? false;
    if (this.emitCreateMarkerEvents) {
      this.emitter.emit("did-create-marker", marker);
    }
    marker.trackDestruction = false;
    return marker;
  }

  /**
   * @category Internal
   */
  addMarker(id, range, params) {
    id = parseInt(id);
    range = Range.fromObject(range);
    Point.assertValid(range.start);
    Point.assertValid(range.end);
    this.index.insert(id, range.start, range.end);
    this.historyShadow?.set(id, {
      sr: range.start.row,
      sc: range.start.column,
      er: range.end.row,
      ec: range.end.column,
    });
    const marker = new Marker(id, this, range, params);
    this.markersById.set(id, marker);
    return marker;
  }

  emitUpdateEvent() {
    return this.emitter.emit("did-update");
  }
}

function filterSet(set1, set2) {
  if (set1) {
    intersectSet(set1, set2);
    return set1;
  } else {
    return set2;
  }
}

module.exports = MarkerLayer;
