const Point = require("./point");
let newlineRegex = null;

function __range__(left, right, inclusive) {
  let range = [];
  let ascending = left < right;
  let end = !inclusive ? right : ascending ? right + 1 : right - 1;
  for (let i = left; ascending ? i < end : i > end; ascending ? i++ : i--) {
    range.push(i);
  }
  return range;
}

/**
 * Represents a region in a buffer in row/column coordinates.
 *
 * Every public method that takes a range also accepts a *range-compatible*
 * `Array`. This means a 2-element array containing {@link Point Points} or point-compatible
 * arrays. So the following are equivalent:
 *
 * ## Examples
 *
 * ```js
 * new Range(new Point(0, 1), new Point(2, 3))
 * new Range([0, 1], [2, 3])
 * [[0, 1], [2, 3]] // Range-compatible array
 * ```
 *
 * @public
 * @api-status Public
 */
class Range {
  /**
   * @category Construction
   */

  /**
   * Convert any range-compatible object to a {@link Range}.
   *
   * @param object - This can be an object that's already a {@link Range}, in which case it's simply returned, or an array containing two {@link Point Points} or point-compatible arrays.
   * @param copy - An optional boolean indicating whether to force the copying of objects that are already ranges.
   * @returns {Range} A range based on the given object.
   * @public
   * @api-status Public
   */
  static fromObject(object, copy) {
    if (Array.isArray(object)) {
      return new this(object[0], object[1]);
    } else if (object instanceof this) {
      if (copy) {
        return object.copy();
      } else {
        return object;
      }
    } else {
      return new this(object.start, object.end);
    }
  }

  /**
   * Returns a range based on an optional starting point and the given text. If
   * no starting point is given it will be assumed to be `[0, 0]`.
   *
   * @param {Point} [startPoint] - Where the range should start.
   * @param {String} text - Text after which the range should end. The range has
   *   as many rows as the text has lines and an end column based on the length
   *   of the last line.
   * @returns {Range} The resulting range.
   * @private
   */
  static fromText(...args) {
    let startPoint;
    if (newlineRegex == null) {
      ({ newlineRegex } = require("./helpers"));
    }

    if (args.length > 1) {
      startPoint = Point.fromObject(args.shift());
    } else {
      startPoint = new Point(0, 0);
    }
    const text = args.shift();
    const endPoint = startPoint.copy();
    const lines = text.split(newlineRegex);
    if (lines.length > 1) {
      const lastIndex = lines.length - 1;
      endPoint.row += lastIndex;
      endPoint.column = lines[lastIndex].length;
    } else {
      endPoint.column += lines[0].length;
    }
    return new this(startPoint, endPoint);
  }

  // Returns a {@link Range} that starts at the given point and ends at the
  // start point plus the given row and column deltas.
  //
  // * `startPoint` A {@link Point} or point-compatible `Array`
  // * `rowDelta` A `Number` indicating how many rows to add to the start point
  //   to get the end point.
  // * `columnDelta` A `Number` indicating how many rows to columns to the start
  //   point to get the end point.
  static fromPointWithDelta(startPoint, rowDelta, columnDelta) {
    startPoint = Point.fromObject(startPoint);
    const endPoint = new Point(startPoint.row + rowDelta, startPoint.column + columnDelta);
    return new this(startPoint, endPoint);
  }

  static fromPointWithTraversalExtent(startPoint, extent) {
    startPoint = Point.fromObject(startPoint);
    return new this(startPoint, startPoint.traverse(extent));
  }

  /**
   * @category Serialization and Deserialization
   */

  /**
   * Call this with the result of {@link Range#serialize} to construct a new Range.
   *
   * @param {Array} array - of params to pass to the {@link #constructor}
   * @public
   * @api-status Public
   */
  static deserialize(array) {
    if (Array.isArray(array)) {
      return new this(array[0], array[1]);
    } else {
      return new this();
    }
  }

  /**
   * @category Construction
   */

  /**
   * Construct a {@link Range} object
   *
   * @param {Point} pointA - or Point compatible `Array` (default: [0,0])
   * @param {Point} pointB - or Point compatible `Array` (default: [0,0])
   * @public
   * @api-status Public
   */
  constructor(pointA, pointB) {
    if (pointA == null) {
      pointA = new Point(0, 0);
    }
    if (pointB == null) {
      pointB = new Point(0, 0);
    }
    if (!(this instanceof Range)) {
      return new Range(pointA, pointB);
    }

    pointA = Point.fromObject(pointA);
    pointB = Point.fromObject(pointB);

    if (pointA.isLessThanOrEqual(pointB)) {
      this.start = pointA;
      this.end = pointB;
    } else {
      this.start = pointB;
      this.end = pointA;
    }
  }

  /**
   * @returns {Range} new range with the same start and end positions.
   * @public
   * @api-status Public
   */
  copy() {
    return new this.constructor(this.start.copy(), this.end.copy());
  }

  /**
   * @returns {Range} new range with the start and end positions negated.
   * @public
   * @api-status Public
   */
  negate() {
    return new this.constructor(this.start.negate(), this.end.negate());
  }

  /**
   * @category Serialization and Deserialization
   */

  /**
   * @returns {Object} plain JavaScript object representation of the range.
   * @public
   * @api-status Public
   */
  serialize() {
    return [this.start.serialize(), this.end.serialize()];
  }

  /**
   * @category Range Details
   */

  /**
   * Is the start position of this range equal to the end position?
   *
   * @returns {Boolean}
   * @public
   * @api-status Public
   */
  isEmpty() {
    return this.start.isEqual(this.end);
  }

  /**
   * @returns {Boolean} indicating whether this range starts and ends on the same row.
   * @public
   * @api-status Public
   */
  isSingleLine() {
    return this.start.row === this.end.row;
  }

  /**
   * Get the number of rows in this range.
   *
   * @returns {Number}
   * @public
   * @api-status Public
   */
  getRowCount() {
    return this.end.row - this.start.row + 1;
  }

  /**
   * @returns {Array} array of all rows in the range.
   * @public
   * @api-status Public
   */
  getRows() {
    return __range__(this.start.row, this.end.row, true);
  }

  /**
   * @category Operations
   */

  /**
   * Freezes the range and its start and end point so it becomes
   * immutable and returns itself.
   *
   * @returns {Range} immutable version of this {@link Range}
   * @public
   * @api-status Public
   */
  freeze() {
    this.start.freeze();
    this.end.freeze();
    return Object.freeze(this);
  }

  /**
   * @param otherRange - A {@link Range} or range-compatible `Array`
   * @returns {Range} new range that contains this range and the given range.
   * @public
   * @api-status Public
   */
  union(otherRange) {
    const start = this.start.isLessThan(otherRange.start) ? this.start : otherRange.start;
    const end = this.end.isGreaterThan(otherRange.end) ? this.end : otherRange.end;
    return new this.constructor(start, end);
  }

  /**
   * Build and return a new range by translating this range's start and
   * end points by the given delta(s).
   *
   * @param startDelta - A {@link Point} by which to translate the start of this range.
   * @param [endDelta] - A {@link Point} to by which to translate the end of this range. If omitted, the `startDelta` will be used instead.
   * @returns {Range}
   * @public
   * @api-status Public
   */
  translate(startDelta, endDelta) {
    if (endDelta == null) {
      endDelta = startDelta;
    }
    return new this.constructor(this.start.translate(startDelta), this.end.translate(endDelta));
  }

  /**
   * Build and return a new range by traversing this range's start and
   * end points by the given delta.
   *
   * See {@link Point#traverse} for details of how traversal differs from translation.
   *
   * @param delta - A {@link Point} containing the rows and columns to traverse to derive the new range.
   * @returns {Range}
   * @public
   * @api-status Public
   */
  traverse(delta) {
    return new this.constructor(this.start.traverse(delta), this.end.traverse(delta));
  }

  /**
   * @category Comparison
   */

  /**
   * Compare two Ranges
   *
   * @param other - A {@link Range} or range-compatible `Array`.
   * @returns {Number} `-1` when this range starts first, `0` when the ranges are equal, or `1` when the argument starts first.
   * @public
   * @api-status Public
   */
  compare(other) {
    let value;
    other = this.constructor.fromObject(other);
    if ((value = this.start.compare(other.start))) {
      return value;
    } else {
      return other.end.compare(this.end);
    }
  }

  /**
   * @param other - A {@link Range} or range-compatible `Array`.
   * @returns {Boolean} indicating whether this range has the same start and end points as the given {@link Range} or range-compatible `Array`.
   * @public
   * @api-status Public
   */
  isEqual(other) {
    if (other == null) {
      return false;
    }
    other = this.constructor.fromObject(other);
    return other.start.isEqual(this.start) && other.end.isEqual(this.end);
  }

  /**
   * @param other - A {@link Range} or range-compatible `Array`.
   * @returns {Boolean} indicating whether this range starts and ends on the same row as the argument.
   * @public
   * @api-status Public
   */
  coversSameRows(other) {
    return this.start.row === other.start.row && this.end.row === other.end.row;
  }

  /**
   * Determines whether this range intersects with the argument.
   *
   * @param otherRange - A {@link Range} or range-compatible `Array`
   * @param {Boolean} [exclusive] - indicating whether to exclude endpoints when testing for intersection. Defaults to `false`.
   * @returns {Boolean}
   * @public
   * @api-status Public
   */
  intersectsWith(otherRange, exclusive) {
    if (exclusive) {
      return !(
        this.end.isLessThanOrEqual(otherRange.start) ||
        this.start.isGreaterThanOrEqual(otherRange.end)
      );
    } else {
      return !(this.end.isLessThan(otherRange.start) || this.start.isGreaterThan(otherRange.end));
    }
  }

  /**
   * @param otherRange - A {@link Range} or range-compatible `Array`
   * @param {Boolean} [exclusive] - including that the containment should be exclusive of endpoints. Defaults to false.
   * @returns {Boolean} indicating whether this range contains the given range.
   * @public
   * @api-status Public
   */
  containsRange(otherRange, exclusive) {
    const { start, end } = this.constructor.fromObject(otherRange);
    return this.containsPoint(start, exclusive) && this.containsPoint(end, exclusive);
  }

  /**
   * @param point - A {@link Point} or point-compatible `Array`
   * @param {Boolean} [exclusive] - including that the containment should be exclusive of endpoints. Defaults to false.
   * @returns {Boolean} indicating whether this range contains the given point.
   * @public
   * @api-status Public
   */
  containsPoint(point, exclusive) {
    point = Point.fromObject(point);
    if (exclusive) {
      return point.isGreaterThan(this.start) && point.isLessThan(this.end);
    } else {
      return point.isGreaterThanOrEqual(this.start) && point.isLessThanOrEqual(this.end);
    }
  }

  /**
   * @param row - Row `Number`
   * @returns {Boolean} indicating whether this range intersects the given row `Number`.
   * @public
   * @api-status Public
   */
  intersectsRow(row) {
    return this.start.row <= row && row <= this.end.row;
  }

  /**
   * @param {Number} startRow - start row
   * @param {Number} endRow - end row
   * @returns {Boolean} indicating whether this range intersects the row range indicated by the given startRow and endRow `Numbers`.
   * @public
   * @api-status Public
   */
  intersectsRowRange(startRow, endRow) {
    if (startRow > endRow) {
      [startRow, endRow] = [endRow, startRow];
    }
    return this.end.row >= startRow && endRow >= this.start.row;
  }

  getExtent() {
    return this.end.traversalFrom(this.start);
  }

  /**
   * @category Conversion
   */

  toDelta() {
    let columns;
    const rows = this.end.row - this.start.row;
    if (rows === 0) {
      columns = this.end.column - this.start.column;
    } else {
      columns = this.end.column;
    }
    return new Point(rows, columns);
  }

  /**
   * @returns {String} string representation of the range.
   * @public
   * @api-status Public
   */
  toString() {
    return `[${this.start} - ${this.end}]`;
  }
}

// ES5 classes differ from their predecessors in that you are not allowed to
// call them like ordinary functions. Hence we must write this wrapper function
// which delegates to `new Range` whether it was called with `new` or not.
function _Range(...args) {
  return new Range(...args);
}
_Range.displayName = "Range";
_Range.prototype = Range.prototype;
Object.assign(_Range.prototype, {
  start: null,
  end: null,
});
// Make the wrapper inherit the parent's static methods.
Object.setPrototypeOf(_Range, Range);

module.exports = _Range;
