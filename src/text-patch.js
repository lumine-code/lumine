const PieceTree = require("./piece-tree");
const ChangeTree = require("./change-tree");
const point = (p) => ({ row: p.row + 0, column: p.column + 0 });
const coordinate = (value) => Math.min(0xffffffff, Math.max(0, Math.trunc(value) || 0));
const inputPoint = (p) => ({ row: coordinate(p.row), column: coordinate(p.column) });
const compare = (a, b) => a.row - b.row || a.column - b.column;
const traverse = (a, b) => ({
  row: Math.min(0xffffffff, a.row + b.row),
  column: b.row ? b.column : Math.min(0xffffffff, a.column + b.column),
});
const distance = (a, b) => ({
  row: a.row - b.row,
  column: a.row === b.row ? a.column - b.column : a.column,
});
const shift = (p, before, after) => traverse(after, distance(p, before));
const zero = (p) => p.row === 0 && p.column === 0;
const asText = (value) =>
  value == null ? null : value instanceof PieceTree ? value : new PieceTree(value);
const append = (a, b) => a.replace(a.length, a.length, b);

// Geometry records are immutable once stored in ChangeTree. Lazy suffix shifts
// create new records, while copied roots can safely share this frozen snapshot.
// Text-bearing records stay uncached so their lazy flattened strings do not
// acquire the lifetime of a persistent patch merely because it was queried.
const geometrySnapshots = new WeakMap();

function snapshot(change) {
  const geometryOnly = change.oldSource == null && change.newSource == null;
  const cached = geometryOnly && geometrySnapshots.get(change);
  if (cached) return cached;
  let oldText, newText;
  const result = {
    oldStart: Object.freeze(point(change.oldStart)),
    oldEnd: Object.freeze(point(change.oldEnd)),
    newStart: Object.freeze(point(change.newStart)),
    newEnd: Object.freeze(point(change.newEnd)),
  };
  Object.defineProperties(result, {
    oldTextSource: { value: change.oldSource },
    newTextSource: { value: change.newSource },
  });
  if (change.oldSource && change.newSource)
    Object.defineProperties(result, {
      oldText: { enumerable: true, get: () => (oldText ??= change.oldSource.toString()) },
      newText: { enumerable: true, get: () => (newText ??= change.newSource.toString()) },
    });
  Object.freeze(result);
  if (geometryOnly) geometrySnapshots.set(change, result);
  return result;
}

function lowerBound(array, predicate) {
  if (array instanceof ChangeTree) return array.lowerBound(predicate);
  let low = 0,
    high = array.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (predicate(array[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}

class Patch {
  #changes = new ChangeTree();
  #merge;
  #discardIdentities = false;
  constructor({ mergeAdjacentChanges = true, discardIdentityChanges = false } = {}) {
    this.#merge = mergeAdjacentChanges;
    this.#discardIdentities = discardIdentityChanges;
  }

  static fromIndependentChanges(changes, { discardIdentityChanges = false } = {}) {
    const records = [],
      texts = new Map();
    const source = (value) => {
      if (typeof value !== "string" || value.length > 1024) return asText(value);
      if (texts.has(value)) return texts.get(value);
      const text = asText(value);
      if (texts.size < 128) texts.set(value, text);
      return text;
    };
    let previous = null;
    for (const change of changes) {
      const { oldStart, oldEnd, newStart, newEnd } = change;
      if (
        ![oldStart, oldEnd, newStart, newEnd].every(
          (p) => p && coordinate(p.row) === p.row && coordinate(p.column) === p.column,
        ) ||
        (previous &&
          (compare(oldStart, previous.oldEnd) < 0 || compare(oldStart, previous.oldStart) <= 0)) ||
        compare(oldEnd, oldStart) < 0 ||
        compare(newEnd, newStart) < 0 ||
        compare(
          newStart,
          previous ? shift(oldStart, previous.oldEnd, previous.newEnd) : oldStart,
        ) !== 0
      )
        return null;
      const oldSource = source(change.oldTextSource ?? change.oldText);
      const newSource = source(change.newTextSource ?? change.newText);
      if (
        !oldSource ||
        !newSource ||
        compare(oldSource.positionAt(oldSource.length), distance(oldEnd, oldStart)) !== 0 ||
        compare(newSource.positionAt(newSource.length), distance(newEnd, newStart)) !== 0
      )
        return null;
      previous = change;
      if (
        (!oldSource.length && !newSource.length) ||
        (discardIdentityChanges && oldSource.equals(newSource))
      )
        continue;
      const record = {
        oldStart: point(oldStart),
        oldEnd: point(oldEnd),
        newStart: point(newStart),
        newEnd: point(newEnd),
        oldSource,
        newSource,
      };
      const last = records.at(-1);
      if (last && compare(last.oldEnd, oldStart) === 0 && compare(last.newEnd, newStart) === 0) {
        last.oldEnd = record.oldEnd;
        last.newEnd = record.newEnd;
        last.oldSource = append(last.oldSource, oldSource);
        last.newSource = append(last.newSource, newSource);
      } else records.push(record);
    }
    const patch = new Patch({ discardIdentityChanges });
    patch.#changes = new ChangeTree(records);
    return patch;
  }

  #project(position, axis, end = false) {
    const from = axis === "new" ? "new" : "old";
    const to = from === "new" ? "old" : "new";
    if (end) {
      const boundary = lowerBound(this.#changes, (h) => compare(h[`${from}Start`], position) >= 0);
      const next = this.#changes.at(boundary);
      if (next && compare(next[`${from}Start`], position) === 0) return point(next[`${to}Start`]);
    }
    const index = lowerBound(this.#changes, (h) => compare(h[`${from}Start`], position) > 0) - 1;
    if (index < 0) return point(position);
    const h = this.#changes.at(index);
    if (compare(position, h[`${from}End`]) < 0) return point(h[`${to}${end ? "End" : "Start"}`]);
    return traverse(h[`${to}End`], distance(position, h[`${from}End`]));
  }

  splice(start, oldExtent, newExtent, oldText, newText) {
    start = inputPoint(start);
    oldExtent = inputPoint(oldExtent);
    newExtent = inputPoint(newExtent);
    if (zero(oldExtent) && zero(newExtent)) return;
    const end = traverse(start, oldExtent),
      insertedEnd = traverse(start, newExtent);
    const first = lowerBound(this.#changes, (h) =>
      this.#merge ? compare(h.newEnd, start) >= 0 : compare(h.newEnd, start) > 0,
    );
    let last = lowerBound(this.#changes, (h) =>
      this.#merge ? compare(h.newStart, end) > 0 : compare(h.newStart, end) >= 0,
    );
    last = Math.max(first, last);
    const overlapping = this.#changes.slice(first, last);
    const mergedStart =
      overlapping.length && compare(overlapping[0].newStart, start) < 0
        ? overlapping[0].newStart
        : start;
    const mergedEnd =
      overlapping.length && compare(overlapping.at(-1).newEnd, end) > 0
        ? overlapping.at(-1).newEnd
        : end;
    const oldStart =
      overlapping.length && compare(mergedStart, overlapping[0].newStart) === 0
        ? point(overlapping[0].oldStart)
        : this.#project(mergedStart, "new");
    const oldEnd =
      !overlapping.length && zero(oldExtent)
        ? point(oldStart)
        : overlapping.length && compare(mergedEnd, overlapping.at(-1).newEnd) === 0
          ? point(overlapping.at(-1).oldEnd)
          : this.#project(mergedEnd, "new", true);
    let oldSource = null,
      newSource = null;
    const deleted = asText(oldText),
      inserted = asText(newText);
    if (deleted && inserted && !overlapping.length) {
      oldSource = deleted;
      newSource = inserted;
    } else if (deleted && inserted && overlapping.every((h) => h.oldSource && h.newSource)) {
      let current = deleted;
      if (compare(mergedStart, start) < 0) {
        const h = overlapping[0];
        const length = h.newSource.offsetAt(distance(start, h.newStart));
        current = append(h.newSource.subtext(0, length), current);
      }
      if (compare(mergedEnd, end) > 0) {
        const h = overlapping.at(-1);
        current = append(
          current,
          h.newSource.subtext(h.newSource.offsetAt(distance(end, h.newStart))),
        );
      }
      const begin = current.offsetAt(distance(start, mergedStart));
      const finish = current.offsetAt(distance(end, mergedStart));
      newSource = current.replace(begin, finish, inserted);
      oldSource = current;
      for (let index = overlapping.length - 1; index >= 0; index--) {
        const h = overlapping[index];
        const a = oldSource.offsetAt(distance(h.newStart, mergedStart));
        const b = oldSource.offsetAt(distance(h.newEnd, mergedStart));
        oldSource = oldSource.replace(a, b, h.oldSource);
      }
    }
    const next = {
      oldStart,
      oldEnd,
      newStart: point(mergedStart),
      newEnd: shift(mergedEnd, end, insertedEnd),
      oldSource,
      newSource,
    };
    this.#changes.shiftSuffix(last, null, null, end, insertedEnd);
    const empty =
      (compare(next.oldStart, next.oldEnd) === 0 && compare(next.newStart, next.newEnd) === 0) ||
      (this.#discardIdentities && oldSource && newSource && oldSource.equals(newSource));
    this.#changes.splice(first, last - first, ...(empty ? [] : [next]));
  }

  spliceOld(start, oldExtent, newExtent) {
    start = inputPoint(start);
    oldExtent = inputPoint(oldExtent);
    newExtent = inputPoint(newExtent);
    if (!this.#changes.length) return;
    const end = traverse(start, oldExtent),
      nextEnd = traverse(start, newExtent);
    const first = lowerBound(this.#changes, (h) => compare(h.oldEnd, start) > 0);
    const last = lowerBound(
      this.#changes,
      (h) => compare(h.oldStart, end) >= 0 && compare(h.oldStart, start) > 0,
    );
    const suffixIndex = Math.max(first, last);
    const lower = first > 0 ? this.#changes.at(first - 1) : null;
    const upper = this.#changes.at(suffixIndex);
    if (upper) {
      const anchor = lower ? traverse(lower.newEnd, distance(nextEnd, lower.oldEnd)) : nextEnd;
      const newNewStart = traverse(anchor, distance(upper.oldStart, end));
      this.#changes.shiftSuffix(suffixIndex, end, nextEnd, upper.newStart, newNewStart);
    }
    this.#changes.splice(first, suffixIndex - first);
    const a = first > 0 ? this.#changes.at(first - 1) : null,
      b = this.#changes.at(first);
    if (a && b && compare(a.oldEnd, b.oldStart) === 0) {
      this.#changes.splice(first - 1, 2, {
        oldStart: a.oldStart,
        oldEnd: b.oldEnd,
        newStart: a.newStart,
        newEnd: traverse(a.newEnd, distance(b.newEnd, b.newStart)),
        oldSource: a.oldSource && b.oldSource ? append(a.oldSource, b.oldSource) : null,
        newSource: a.newSource && b.newSource ? append(a.newSource, b.newSource) : null,
      });
    }
  }

  spliceMany(values) {
    if (!(values instanceof Uint32Array) || values.length % 6)
      throw new TypeError("Invalid packed splices");
    for (let i = 0; i < values.length; i += 6)
      this.splice(
        { row: values[i], column: values[i + 1] },
        { row: values[i + 2], column: values[i + 3] },
        { row: values[i + 4], column: values[i + 5] },
      );
  }

  getChanges() {
    return this.#changes.map(snapshot);
  }
  getChangeCount() {
    return this.#changes.length;
  }
  getBounds() {
    if (!this.#changes.length) return undefined;
    const a = this.#changes.at(0),
      b = this.#changes.at(-1);
    return {
      oldStart: point(a.oldStart),
      oldEnd: point(b.oldEnd),
      newStart: point(a.newStart),
      newEnd: point(b.newEnd),
    };
  }
  #inRange(start, end, axis) {
    const first = lowerBound(this.#changes, (h) => compare(h[`${axis}End`], start) > 0);
    const last = lowerBound(this.#changes, (h) => compare(h[`${axis}Start`], end) >= 0);
    return this.#changes.slice(first, Math.max(first, last)).map(snapshot);
  }
  getChangesInOldRange(start, end) {
    return this.#inRange(start, end, "old");
  }
  getChangesInNewRange(start, end) {
    return this.#inRange(start, end, "new");
  }
  #before(position, axis) {
    const index = lowerBound(this.#changes, (h) => compare(h[`${axis}Start`], position) > 0) - 1;
    return index < 0 ? undefined : snapshot(this.#changes.at(index));
  }
  changeForOldPosition(position) {
    return this.#before(position, "old");
  }
  changeForNewPosition(position) {
    return this.#before(position, "new");
  }
  changesForOldPositions(values) {
    if (!(values instanceof Uint32Array) || values.length % 2)
      throw new TypeError("Invalid packed positions");
    const result = new Uint32Array((values.length / 2) * 9);
    for (let i = 0; i < values.length; i += 2) {
      const h = this.changeForOldPosition({ row: values[i], column: values[i + 1] });
      if (h)
        result.set(
          [
            1,
            h.oldStart.row,
            h.oldStart.column,
            h.oldEnd.row,
            h.oldEnd.column,
            h.newStart.row,
            h.newStart.column,
            h.newEnd.row,
            h.newEnd.column,
          ],
          (i / 2) * 9,
        );
    }
    return result;
  }
  copy() {
    const patch = new Patch({
      mergeAdjacentChanges: this.#merge,
      discardIdentityChanges: this.#discardIdentities,
    });
    patch.#changes = this.#changes.copy();
    return patch;
  }
  invert() {
    const patch = new Patch({ mergeAdjacentChanges: this.#merge });
    patch.#changes = new ChangeTree(
      this.#changes.map((h) => ({
        oldStart: h.newStart,
        oldEnd: h.newEnd,
        newStart: h.oldStart,
        newEnd: h.oldEnd,
        oldSource: h.newSource,
        newSource: h.oldSource,
      })),
    );
    return patch;
  }
  serialize() {
    return Buffer.from(
      JSON.stringify({ version: 2, merge: this.#merge, changes: this.getChanges() }),
    );
  }
  serializeSnapshot(deferred = true) {
    return {
      version: 3,
      merge: this.#merge,
      changes: this.#changes.map((h) => ({
        oldStart: point(h.oldStart),
        oldEnd: point(h.oldEnd),
        newStart: point(h.newStart),
        newEnd: point(h.newEnd),
        oldText: h.oldSource && h.oldSource.serializeSnapshot(deferred),
        newText: h.newSource && h.newSource.serializeSnapshot(deferred),
      })),
    };
  }
  getTextSize() {
    let length = 0;
    for (const h of this.#changes)
      length += (h.oldSource?.length || 0) + (h.newSource?.length || 0);
    return length;
  }
  static deserialize(bytes) {
    const data = bytes?.version === 3 ? bytes : JSON.parse(Buffer.from(bytes).toString());
    if (data.version !== 2 && data.version !== 3) throw new Error("Unsupported text patch version");
    const readText = data.version === 3 ? PieceTree.deserializeSnapshot : asText;
    const patch = new Patch({ mergeAdjacentChanges: data.merge });
    if (!Array.isArray(data.changes)) throw new Error("Invalid text patch changes");
    const changes = data.changes.map((h) => ({
      ...h,
      oldSource: h.oldText == null ? null : readText(h.oldText),
      newSource: h.newText == null ? null : readText(h.newText),
    }));
    if (data.version === 3) {
      let previous;
      for (const change of changes) {
        const { oldStart, oldEnd, newStart, newEnd, oldSource, newSource } = change;
        if (
          ![oldStart, oldEnd, newStart, newEnd].every(
            (p) => p && coordinate(p.row) === p.row && coordinate(p.column) === p.column,
          ) ||
          compare(oldStart, oldEnd) > 0 ||
          compare(newStart, newEnd) > 0 ||
          (previous &&
            (compare(previous.oldEnd, oldStart) > 0 || compare(previous.newEnd, newStart) > 0)) ||
          (oldSource &&
            compare(oldSource.positionAt(oldSource.length), distance(oldEnd, oldStart)) !== 0) ||
          (newSource &&
            compare(newSource.positionAt(newSource.length), distance(newEnd, newStart)) !== 0)
        )
          throw new Error("Invalid text patch geometry");
        previous = change;
      }
    }
    patch.#changes = new ChangeTree(changes);
    return patch;
  }
  static compose(patches) {
    // Multicursor transactions produce one patch per selection. When those
    // splices are ordered and disjoint, recover original coordinates once
    // instead of repeatedly inserting them into the growing history tree.
    if (patches.length >= 64) {
      const independent = [];
      let oldEnd = { row: 0, column: 0 },
        newEnd = oldEnd,
        ordered = true;
      outer: for (const patch of patches) {
        for (const change of patch.#changes) {
          if (!change.oldSource || !change.newSource || compare(change.newStart, newEnd) < 0) {
            ordered = false;
            break outer;
          }
          const oldStart = shift(change.newStart, newEnd, oldEnd);
          oldEnd = traverse(oldStart, distance(change.oldEnd, change.oldStart));
          newEnd = change.newEnd;
          independent.push({
            oldStart,
            oldEnd,
            newStart: change.newStart,
            newEnd,
            oldTextSource: change.oldSource,
            newTextSource: change.newSource,
          });
        }
      }
      if (ordered) {
        const result = Patch.fromIndependentChanges(independent, { discardIdentityChanges: true });
        if (result) {
          result.#discardIdentities = false;
          return result;
        }
      }
    }
    const result = new Patch();
    result.#discardIdentities = true;
    let first = true;
    for (const patch of patches) {
      if (first && patch.#merge) {
        // Transaction grouping commonly receives one already canonical patch.
        // Preserve its persistent tree instead of replaying thousands of splices.
        const changes = [];
        let removedIdentity = false;
        for (const change of patch.#changes) {
          if (change.oldSource && change.newSource && change.oldSource.equals(change.newSource))
            removedIdentity = true;
          else changes.push(change);
        }
        result.#changes = removedIdentity ? new ChangeTree(changes) : patch.#changes.copy();
        first = false;
        continue;
      }
      first = false;
      for (const h of patch.#changes) {
        result.splice(
          h.newStart,
          distance(h.oldEnd, h.oldStart),
          distance(h.newEnd, h.newStart),
          h.oldSource,
          h.newSource,
        );
      }
    }
    result.#discardIdentities = false;
    return result;
  }
}

module.exports = Patch;
