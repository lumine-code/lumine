const Point = require("./point");
const TextStore = require("./text-store");
const editsForMap = require("./text-change-map-edits");
const markerEvents = require("./text-buffer-marker-events");

function* splices(map) {
  if (map.maps) {
    for (const child of map.maps) yield* splices(child);
  } else if (map.transfers) {
    // Transfers describe paint ownership. Annotation indexes retain the
    // ordinary source-splice semantics of the transfer's underlying edits.
    yield* splices(map.base);
  } else if (map.edits) {
    for (const edit of map.edits)
      yield {
        start: edit.start,
        oldExtent: Point.fromObject(edit.oldEnd).traversalFrom(edit.start),
        newExtent: Point.fromObject(edit.newEnd).traversalFrom(edit.start),
      };
  } else {
    // Compressed runs have sources but describe logical edit boundaries.
    // Compile their physical CRLF expansions against private intermediate
    // text, exactly as normal history replay does, without changing live text.
    const scratch = new TextStore(map.before, { wordIndex: false });
    for (const change of editsForMap(map)) {
      const edit = scratch.prepareEditFromChange(change);
      try {
        const physical = edit.getChange();
        edit.commit();
        yield {
          start: physical.oldStart,
          oldExtent: Point.fromObject(physical.oldEnd).traversalFrom(physical.oldStart),
          newExtent: Point.fromObject(physical.newEnd).traversalFrom(physical.newStart),
        };
      } finally {
        edit.dispose();
      }
    }
  }
}

// Old scalar coordinate maps omitted source snapshots. Their enclosing text
// patch remains replayable, but splicing its whole span would move or retire
// annotations in untouched gaps. Apply the retained geometry on live indexes
// separately; it must be published once, after the final enclosing text edit.
module.exports = function createLegacyHistoryMarkerPlan(buffer, map, onError) {
  return {
    verify() {},
    publish() {
      const layers = Object.values(buffer.markerLayers).filter((layer) => layer.getMarkerCount());
      const events = markerEvents.begin(buffer);
      const errors = [];
      const attempt = (callback) => {
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      };
      for (const layer of layers) layer.beginHistoryBatch();
      try {
        for (const { start, oldExtent, newExtent } of splices(map)) {
          for (const layer of layers) {
            if (layer.isDestroyed()) continue;
            attempt(() =>
              layer.splice(start, oldExtent, newExtent, undefined, {
                suppressRangeTracking: true,
              }),
            );
          }
        }
      } finally {
        for (const layer of layers) {
          attempt(() => layer.endHistoryBatch());
          if (!layer.isDestroyed()) buffer.markerLayersWithPendingUpdateEvents.add(layer);
        }
        events.flush(errors);
        events.dispose();
      }
      if (errors.length) {
        const error = new AggregateError(errors, "Legacy annotation history observers failed");
        if (onError) onError(error);
        else throw error;
      }
    },
  };
};
