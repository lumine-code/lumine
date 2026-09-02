/**
 * Maintains buffer ranges in document order while coalescing intersections.
 *
 * @private
 */
module.exports = class TreeSitterRangeList {
  constructor() {
    this.ranges = [];
  }

  clear() {
    this.ranges.length = 0;
  }

  add(range) {
    this.addAll([range]);
  }

  addAll(newRanges) {
    if (newRanges.length === 0) return;

    const ranges = [...this.ranges, ...newRanges].sort((a, b) => {
      return a.start.compare(b.start) || a.end.compare(b.end);
    });
    this.ranges.length = 0;

    for (const range of ranges) {
      const previous = this.ranges[this.ranges.length - 1];
      if (previous?.intersectsWith(range)) {
        this.ranges[this.ranges.length - 1] = previous.union(range);
      } else {
        this.ranges.push(range);
      }
    }
  }

  inspect() {
    return `[TreeSitterRangeList: ${this.ranges.map((range) => range.toString()).join(", ")}]`;
  }

  *[Symbol.iterator]() {
    yield* this.ranges;
  }
};
