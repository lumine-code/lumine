const Point = require("./point");
const Range = require("./range");

const key = (range) =>
  `${range.start.row}:${range.start.column}/${range.end.row}:${range.end.column}`;
function shift(point, edit, right) {
  const start = Point.fromObject(edit.startPosition);
  const end = Point.fromObject(edit.oldEndPosition);
  const next = Point.fromObject(edit.newEndPosition);
  if (point.isLessThan(start) || (!right && point.isEqual(start))) return point;
  if (point.isLessThan(end)) return right ? next : start;
  return next.traverse(point.traversalFrom(end));
}

// Dependency ranges belong to painted scopes/folds, not mutable syntax-node
// identities. Keep untouched dependencies when another region is reparsed.
module.exports = class TreeSitterInvalidationRanges {
  constructor() {
    this.ranges = new Map();
    this.edits = [];
  }
  add(node) {
    this.rebase();
    const range = new Range(node.startPosition, node.endPosition);
    this.ranges.set(key(range), range);
  }
  edit(edit) {
    if (this.ranges.size && !Point.fromObject(edit.oldEndPosition).isEqual(edit.newEndPosition))
      this.edits.push(edit);
  }
  rebase() {
    if (!this.edits.length) return;
    const ranges = new Map();
    for (let range of this.ranges.values()) {
      for (const edit of this.edits)
        range = new Range(shift(range.start, edit, false), shift(range.end, edit, true));
      ranges.set(key(range), range);
    }
    this.ranges = ranges;
    this.edits.length = 0;
  }
  takeIntersecting(affectedRange) {
    this.rebase();
    const result = [];
    for (const [key, range] of this.ranges) {
      if (range.intersectsWith(affectedRange)) {
        result.push(range);
        this.ranges.delete(key);
      }
    }
    return result;
  }
  clear() {
    this.ranges.clear();
    this.edits.length = 0;
  }
};
