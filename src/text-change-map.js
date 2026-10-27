// Presentation coordinates for an atomic publication. Repeated edit geometry
// shares one run (for example indenting millions of rows); irregular edits use
// separate runs without retaining replacement objects. Syntax keeps a budgeted
// journal. The before/after snapshots are shared with ordinary undo history.
const PieceTree = require("./piece-tree");

class TextChangeMap {
  constructor(before) {
    this.before = before;
    this.runs = [];
    this.delta = 0;
  }

  add(start, end, length) {
    const oldLength = end - start;
    const last = this.runs.at(-1);
    const step = last && start - (last.start + (last.count - 1) * last.step);
    if (
      last &&
      last.oldLength === oldLength &&
      last.newLength === length &&
      (last.count === 1 || step === last.step)
    ) {
      if (last.count === 1) last.step = step;
      last.count++;
    } else {
      this.runs.push({ start, oldLength, newLength: length, step: 0, count: 1, delta: this.delta });
    }
    this.delta += length - oldLength;
  }

  finish(after) {
    this.after = after;
    for (const run of this.runs) Object.freeze(run);
    Object.freeze(this.runs);
    return Object.freeze(this);
  }

  mapPoint(point, right = false) {
    const offset = this.before.offsetAt(point);
    let low = 0,
      high = this.runs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const start = this.runs[middle].start;
      if (start < offset || (right && start === offset)) low = middle + 1;
      else high = middle;
    }
    const run = this.runs[low - 1];
    if (!run) return this.after.positionAt(offset);
    const index = run.step
      ? Math.min(
          run.count - 1,
          right
            ? Math.floor((offset - run.start) / run.step)
            : Math.ceil((offset - run.start) / run.step) - 1,
        )
      : run.count - 1;
    const start = run.start + index * run.step;
    const delta = run.delta + index * (run.newLength - run.oldLength);
    const mapped =
      offset < start + run.oldLength
        ? start + delta + (right ? run.newLength : 0)
        : offset + delta + run.newLength - run.oldLength;
    return this.after.positionAt(mapped);
  }

  invert() {
    const inverse = new TextChangeMap(this.after);
    inverse.runs = this.runs.map((run) => ({
      start: run.start + run.delta,
      oldLength: run.newLength,
      newLength: run.oldLength,
      step: run.count === 1 ? 0 : run.step + run.newLength - run.oldLength,
      count: run.count,
      delta: -run.delta,
    }));
    inverse.delta = -this.delta;
    return inverse.finish(this.before);
  }

  serializeSnapshot(deferred = true) {
    return {
      type: "bulk",
      before: this.before.serializeSnapshot(deferred),
      after: this.after.serializeSnapshot(deferred),
      runs: this.runs,
    };
  }

  static deserialize(data) {
    if (data?.type === "transfer")
      return TextChangeMap.transfer(
        TextChangeMap.deserialize(data.base),
        data.transfers,
        data.inverted,
      );
    if (data?.type === "chain" && Array.isArray(data.maps))
      return TextChangeMap.compose(data.maps.map((map) => TextChangeMap.deserialize(map)));
    if (data?.type === "edits" && Array.isArray(data.edits)) {
      if (!data.edits.every((edit) => [edit.start, edit.oldEnd, edit.newEnd].every(validPoint)))
        throw new Error("Invalid text change map coordinates");
      return scalarMap(data.edits);
    }
    if (data?.type !== "bulk" || !Array.isArray(data.runs))
      throw new Error("Invalid text change map");
    const before = PieceTree.deserializeSnapshot(data.before),
      after = PieceTree.deserializeSnapshot(data.after);
    const result = new TextChangeMap(before);
    let end = -1,
      delta = 0;
    result.runs = data.runs.map((run) => {
      if (
        ![run.start, run.oldLength, run.newLength, run.step, run.count].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        !run.count ||
        run.delta !== delta ||
        run.start < end ||
        (run.count > 1 && run.step < run.oldLength)
      )
        throw new Error("Invalid text change map run");
      end = run.start + (run.count - 1) * run.step + run.oldLength;
      delta += run.count * (run.newLength - run.oldLength);
      if (!Number.isSafeInteger(end) || end > before.length || !Number.isSafeInteger(delta))
        throw new Error("Invalid text change map extent");
      return { ...run };
    });
    if (before.length + delta !== after.length) throw new Error("Invalid text change map length");
    result.delta = delta;
    return result.finish(after);
  }

  static fromChanges(changes) {
    const edits = changes.map((change) => ({
      start: change.newStart,
      oldEnd: traverse(change.newStart, distance(change.oldEnd, change.oldStart)),
      newEnd: change.newEnd,
    }));
    return scalarMap(edits);
  }

  static transfer(base, transfers, inverted = false) {
    transfers = Object.freeze(
      transfers.map(({ start, end, target, copy = false }) => {
        if (![start, end, target].every(validPoint) || compare(start, end) > 0)
          throw new Error("Invalid text transfer coordinates");
        return Object.freeze({
          start: Object.freeze({ ...start }),
          end: Object.freeze({ ...end }),
          target: Object.freeze({ ...target }),
          copy: Boolean(copy),
        });
      }),
    );
    return Object.freeze({
      base,
      transfers: inverted
        ? Object.freeze(
            transfers
              .filter((item) => !item.copy)
              .map(({ start, end, target }) =>
                Object.freeze({
                  start: target,
                  end: Object.freeze(traverse(target, distance(end, start))),
                  target: start,
                }),
              ),
          )
        : transfers,
      mapPoint: (point, right) => base.mapPoint(point, right),
      invert() {
        return TextChangeMap.transfer(base.invert(), transfers, !inverted);
      },
      serializeSnapshot(deferred = true) {
        return { type: "transfer", base: base.serializeSnapshot(deferred), transfers, inverted };
      },
    });
  }

  static compose(maps) {
    maps = Object.freeze(maps.flatMap((map) => map.maps ?? [map]));
    if (maps.length === 1) return maps[0];
    return Object.freeze({
      maps,
      serializeSnapshot(deferred = true) {
        return { type: "chain", maps: maps.map((map) => map.serializeSnapshot(deferred)) };
      },
      mapPoint(point, right) {
        for (const map of maps) point = map.mapPoint(point, right);
        return point;
      },
      invert() {
        return TextChangeMap.compose(
          maps
            .slice()
            .reverse()
            .map((map) => map.invert()),
        );
      },
    });
  }
}

const compare = (a, b) => a.row - b.row || a.column - b.column;
const validPoint = (point) =>
  point && [point.row, point.column].every((n) => Number.isSafeInteger(n) && n >= 0);
const distance = (a, b) => ({
  row: a.row - b.row,
  column: a.row === b.row ? a.column - b.column : a.column,
});
const traverse = (a, b) => ({ row: a.row + b.row, column: b.row ? b.column : a.column + b.column });
function scalarMap(edits) {
  edits = Object.freeze(
    edits.map((edit) =>
      Object.freeze({
        start: Object.freeze({ ...edit.start }),
        oldEnd: Object.freeze({ ...edit.oldEnd }),
        newEnd: Object.freeze({ ...edit.newEnd }),
      }),
    ),
  );
  return Object.freeze({
    serializeSnapshot() {
      return { type: "edits", edits };
    },
    mapPoint(point, right = false) {
      for (const { start, oldEnd, newEnd } of edits) {
        const before = compare(point, start);
        if (before < 0 || (before === 0 && !right)) continue;
        point =
          compare(point, oldEnd) < 0
            ? right
              ? newEnd
              : start
            : traverse(newEnd, distance(point, oldEnd));
      }
      return point;
    },
    invert() {
      return scalarMap(
        edits
          .slice()
          .reverse()
          .map(({ start, oldEnd, newEnd }) => ({ start, oldEnd: newEnd, newEnd: oldEnd })),
      );
    },
  });
}

module.exports = TextChangeMap;
