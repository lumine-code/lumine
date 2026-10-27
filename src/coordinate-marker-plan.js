const ReplacementMarkerPlan = require("./replacement-marker-plan");
const { MarkerIndex } = require("./text-model");
const Point = require("./point");
const Range = require("./range");
const flags = { touch: 1, inside: 2, overlap: 4, surround: 8 };

// Replay a prepared operation's real edit order on private marker indexes.
// Transfers affect paint only; ordinary markers retain scalar splice semantics.
module.exports = class CoordinateMarkerPlan extends ReplacementMarkerPlan {
  constructor(buffer, source) {
    super(buffer, source);
    for (const plan of this.layers) {
      plan.index = new MarkerIndex();
      for (const [id, state] of plan.planned) {
        plan.index.insert(id, state.range.start, state.range.end);
        plan.index.setExclusive(id, state.marker.isExclusive());
      }
    }
  }

  async apply(map, check) {
    let deadline = performance.now() + 4;
    const splice = (start, oldExtent, newExtent) => {
      for (const { layer, planned, index } of this.layers) {
        const touched = index.splicePacked(start, oldExtent, newExtent);
        for (let i = 0; touched && i < touched.length; i += 2) {
          const id = touched[i],
            state = planned.get(id);
          if (!state || !(touched[i + 1] & flags[state.invalidate])) continue;
          if (layer.destroyInvalidatedMarkers) {
            planned.delete(id);
            index.remove(id);
          } else state.valid = false;
        }
      }
    };
    const visit = async (current) => {
      check();
      if (current.maps) {
        for (const child of current.maps) await visit(child);
        return;
      }
      if (current.transfers) {
        await visit(current.base);
        return;
      }
      if (current.edits) {
        for (const { start, oldEnd, newEnd } of current.edits) {
          splice(
            start,
            Point.fromObject(oldEnd).traversalFrom(start),
            Point.fromObject(newEnd).traversalFrom(start),
          );
          if (performance.now() >= deadline) {
            await new Promise((resolve) => setImmediate(resolve));
            check();
            deadline = performance.now() + 4;
          }
        }
      } else {
        for (const run of current.runs)
          for (let i = 0; i < run.count; i++) {
            const before = run.start + i * run.step,
              after = before + run.delta + i * (run.newLength - run.oldLength);
            const start = current.before.positionAt(before),
              at = current.after.positionAt(after);
            const oldEnd = Point.fromObject(current.before.positionAt(before + run.oldLength));
            const newEnd = Point.fromObject(current.after.positionAt(after + run.newLength));
            splice(at, oldEnd.traversalFrom(start), newEnd.traversalFrom(at));
            if (performance.now() >= deadline) {
              await new Promise((resolve) => setImmediate(resolve));
              check();
              deadline = performance.now() + 4;
            }
          }
      }
    };
    await visit(map);
    check();
    this.verify();
  }

  preparePublication() {
    this.publication = this.layers.map(({ layer, planned, index }) => ({
      layer,
      states: Object.fromEntries(
        [...planned].map(([id, state]) => [
          id,
          { ...state, range: Range.fromObject(index.getRange(id)) },
        ]),
      ),
    }));
    return this.publication;
  }
};
