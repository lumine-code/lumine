const { MarkerIndex } = require("./text-model");
const Range = require("./range");
const FLAGS = { touch: 1, inside: 2, overlap: 4, surround: 8 };

// Detached indexes use UTF-16 offsets as columns. Their exact interval
// invalidation rules stay identical to ordinary edits, while no live marker
// is touched until the complete replacement is ready to publish.
module.exports = class ReplacementMarkerPlan {
  constructor(buffer, snapshot) {
    this.buffer = buffer;
    this.snapshot = snapshot;
    this.layers = [];
    this.delta = 0;
    for (const layer of Object.values(buffer.markerLayers)) {
      if (!layer.getMarkerCount()) continue;
      if (layer.trackRanges)
        throw Object.assign(
          new Error(
            "This document has a custom range tracker that requires intermediate edits. Use Replace Next for this document.",
          ),
          { code: "ERR_REPLACE_RANGE_TRACKER" },
        );
      const original = layer.createEagerSnapshot();
      const planned = new Map();
      const index = new MarkerIndex();
      for (const [idText, state] of Object.entries(original)) {
        const id = Number(idText);
        planned.set(id, { ...state });
        index.insert(
          id,
          { row: 0, column: snapshot.offsetAt(state.range.start) },
          { row: 0, column: snapshot.offsetAt(state.range.end) },
        );
        index.setExclusive(id, state.marker.isExclusive());
      }
      this.layers.push({
        layer,
        original,
        planned,
        index,
        tracker: layer.trackRanges,
        destroyInvalidatedMarkers: layer.destroyInvalidatedMarkers,
        stableRanges: null,
        stableCursor: 0,
      });
    }
  }

  splice(start, end, insertedLength, { previousUnit, insertedFirst, insertedLast }) {
    let physicalStart = start + this.delta,
      physicalEnd = end + this.delta;
    let length = insertedLength;
    const source = this.snapshot;
    // Match TextStore.prepareEdit's expansion of split/new CRLF boundaries.
    const splitStart = previousUnit === 13 && source.charCodeAt(start) === 10;
    const splitEnd = source.charCodeAt(end - 1) === 13 && source.charCodeAt(end) === 10;
    if (splitStart) {
      physicalStart--;
      length++;
      insertedFirst = 13;
      if (!insertedLength) insertedLast = 13;
    }
    if (splitEnd) {
      physicalEnd++;
      length++;
      insertedLast = 10;
      if (!insertedLength && !splitStart) insertedFirst = 10;
    }
    if (
      !splitStart &&
      previousUnit === 13 &&
      (insertedFirst === 10 || (!length && source.charCodeAt(end) === 10))
    ) {
      physicalStart--;
      length++;
      if (!insertedLength) insertedLast = 13;
    }
    if (!splitEnd && source.charCodeAt(end) === 10 && insertedLast === 13) {
      physicalEnd++;
      length++;
    }
    const at = { row: 0, column: physicalStart };
    const removed = { row: 0, column: physicalEnd - physicalStart };
    const inserted = { row: 0, column: length };
    for (const plan of this.layers) {
      const { layer, planned, index } = plan;
      if (!planned.size) continue;
      // Equal-width edits cannot move a marker outside the union of its
      // existing interval and the touched edit. Cache conservative intervals
      // to skip millions of edits in unmarked gaps without treap mutations.
      let interval;
      if (removed.column === inserted.column) {
        if (!plan.stableRanges) {
          plan.stableRanges = Object.values(index.dump())
            .map((range) => ({ start: range.start.column, end: range.end.column }))
            .sort((a, b) => a.start - b.start);
          plan.stableCursor = 0;
        }
        const intervals = plan.stableRanges;
        while (
          plan.stableCursor < intervals.length &&
          intervals[plan.stableCursor].end < physicalStart
        )
          plan.stableCursor++;
        interval = intervals[plan.stableCursor];
        if (!interval || interval.start > physicalEnd) continue;
      } else plan.stableRanges = null;
      const invalidated = index.splicePacked(at, removed, inserted);
      if (!invalidated) continue;
      if (interval) {
        const intervals = plan.stableRanges;
        interval.end = Math.max(interval.end, physicalEnd);
        while (intervals[plan.stableCursor + 1]?.start <= interval.end) {
          interval.end = Math.max(interval.end, intervals[plan.stableCursor + 1].end);
          intervals.splice(plan.stableCursor + 1, 1);
        }
      }
      for (let i = 0; i < invalidated.length; i += 2) {
        const id = invalidated[i],
          state = planned.get(id);
        if (!state || !(invalidated[i + 1] & FLAGS[state.invalidate])) continue;
        if (layer.destroyInvalidatedMarkers) {
          planned.delete(id);
          index.remove(id);
        } else state.valid = false;
      }
    }
    this.delta += insertedLength - (end - start);
  }

  verify() {
    for (const { layer, original, tracker, destroyInvalidatedMarkers } of this.layers) {
      if (
        layer.trackRanges !== tracker ||
        layer.destroyInvalidatedMarkers !== destroyInvalidatedMarkers
      )
        this.stale();
      const entries = Object.entries(original);
      if (layer.isDestroyed() || layer.getMarkerCount() !== entries.length) this.stale();
      for (const [id, before] of entries) {
        const marker = layer.getMarker(Number(id));
        if (!marker || !marker.getRange().isEqual(before.range)) this.stale();
        const now = marker.getSnapshot(null);
        for (const key of ["valid", "reversed", "tailed", "exclusive", "invalidate", "properties"])
          if (now[key] !== before[key]) this.stale();
      }
    }
    const oldLayers = new Set(this.layers.map(({ layer }) => layer));
    for (const layer of Object.values(this.buffer.markerLayers))
      if (!oldLayers.has(layer) && layer.getMarkerCount()) this.stale();
  }

  stale() {
    throw Object.assign(
      new Error(
        "Selections or markers changed while preparing replacement. Run Replace All again.",
      ),
      { code: "ERR_STALE_EDIT" },
    );
  }

  preparePublication(snapshot) {
    this.publication = this.layers.map(({ layer, planned, index }) => {
      const states = {};
      for (const [id, state] of planned) {
        const range = index.getRange(id);
        states[id] = {
          ...state,
          range: new Range(
            snapshot.positionAt(range.start.column),
            snapshot.positionAt(range.end.column),
          ),
        };
      }
      return { layer, states };
    });
    return this.publication;
  }

  publish(snapshot) {
    for (const { layer, states } of this.publication ?? this.preparePublication(snapshot)) {
      layer.restoreFromSnapshot(states, false);
      this.buffer.markerLayersWithPendingUpdateEvents.add(layer);
    }
    this.publication = null;
  }
};
