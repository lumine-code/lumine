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
 * @public
 * @status public
 *
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
 */
class Range {
  /**
   * @category Construction
   */

  /**
   * @public
   * @status public
   *
   * Convert any range-compatible object to a {@link Range}.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} object - A {@link Range}, an array containing two point-compatible endpoints, or an object with `start` and `end` properties. An existing range is returned unless copying is requested.
   * @param {Boolean} [copy=false] - An optional boolean indicating whether to force the copying of objects that are already ranges.
   * @returns {Range} A range based on the given object.
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

  /**
   * @public
   * @status public
   *
   * Construct a range from a point and independent row and column offsets.
   *
   * Both offsets are added to the original coordinates. The resulting
   * endpoints are ordered in buffer order, so a negative offset can place
   * the supplied point at the end of the range.
   *
   * @param {Point|Array<Number>|Object} startPoint - A point, a `[row, column]` array, or an object with `row` and `column` properties.
   * @param {Number} rowDelta - The number of rows to add to the supplied point.
   * @param {Number} columnDelta - The number of columns to add to the supplied point.
   * @returns {Range} The range spanning the supplied point and the offset point.
   * @category Construction
   */
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
   * @public
   * @status public
   *
   * Call this with the result of {@link Range#serialize} to construct a new Range.
   *
   * @param {Array<Array<Number>>} [array] - of params to pass to the {@link #constructor}
   * @returns {Range} The restored range, or an empty range when the input is not an array.
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
   * @public
   * @status public
   *
   * Construct a {@link Range} with its endpoints in buffer order.
   *
   * @param {Point|Array<Number>|Object} [pointA] - or Point compatible `Array` (default: [0,0])
   * @param {Point|Array<Number>|Object} [pointB] - or Point compatible `Array` (default: [0,0])
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
   * @public
   * @status public
   *
   * Create a range with the same start and end positions.
   *
   * @returns {Range} new range with the same start and end positions.
   */
  copy() {
    return new this.constructor(this.start.copy(), this.end.copy());
  }

  /**
   * @public
   * @status public
   *
   * Create a range with its endpoints negated and reordered.
   *
   * @returns {Range} new range with the start and end positions negated.
   * @category Operations
   */
  negate() {
    return new this.constructor(this.start.negate(), this.end.negate());
  }

  /**
   * @category Serialization and Deserialization
   */

  /**
   * @public
   * @status public
   *
   * Serialize this range as two row-and-column arrays.
   *
   * @returns {Array<Array<Number>>} The start and end positions as row-and-column arrays.
   */
  serialize() {
    return [this.start.serialize(), this.end.serialize()];
  }

  /**
   * @category Range Details
   */

  /**
   * @public
   * @status public
   *
   * Is the start position of this range equal to the end position?
   *
   * @returns {Boolean}
   */
  isEmpty() {
    return this.start.isEqual(this.end);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this range starts and ends on the same row.
   *
   * @returns {Boolean} indicating whether this range starts and ends on the same row.
   */
  isSingleLine() {
    return this.start.row === this.end.row;
  }

  /**
   * @public
   * @status public
   *
   * Get the number of rows in this range.
   *
   * @returns {Number}
   */
  getRowCount() {
    return this.end.row - this.start.row + 1;
  }

  /**
   * @public
   * @status public
   *
   * Get all row numbers touched by this range.
   *
   * @returns {Array<Number>} Every row from the start row through the end row, inclusive.
   */
  getRows() {
    return __range__(this.start.row, this.end.row, true);
  }

  /**
   * @category Operations
   */

  /**
   * @public
   * @status public
   *
   * Freezes the range and its start and end point so it becomes
   * immutable and returns itself.
   *
   * @returns {Range} immutable version of this {@link Range}
   */
  freeze() {
    this.start.freeze();
    this.end.freeze();
    return Object.freeze(this);
  }

  /**
   * @public
   * @status public
   *
   * Create the smallest range containing this range and another.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} otherRange - A {@link Range} or range-compatible `Array`
   * @returns {Range} new range that contains this range and the given range.
   */
  union(otherRange) {
    otherRange = this.constructor.fromObject(otherRange);
    const start = this.start.isLessThan(otherRange.start) ? this.start : otherRange.start;
    const end = this.end.isGreaterThan(otherRange.end) ? this.end : otherRange.end;
    return new this.constructor(start, end);
  }

  /**
   * @public
   * @status public
   *
   * Build and return a new range by translating this range's start and
   * end points by the given delta(s).
   *
   * @param {Point|Array<Number>|Object} startDelta - A {@link Point} by which to translate the start of this range.
   * @param {Point|Array<Number>|Object} [endDelta] - A {@link Point} to by which to translate the end of this range. If omitted, the `startDelta` will be used instead.
   * @returns {Range}
   */
  translate(startDelta, endDelta) {
    if (endDelta == null) {
      endDelta = startDelta;
    }
    return new this.constructor(this.start.translate(startDelta), this.end.translate(endDelta));
  }

  /**
   * @public
   * @status public
   *
   * Build and return a new range by traversing this range's start and
   * end points by the given delta.
   *
   * See {@link Point#traverse} for details of how traversal differs from translation.
   *
   * @param {Point|Array<Number>|Object} delta - A {@link Point} containing the rows and columns to traverse to derive the new range.
   * @returns {Range}
   */
  traverse(delta) {
    return new this.constructor(this.start.traverse(delta), this.end.traverse(delta));
  }

  /**
   * @category Comparison
   */

  /**
   * @public
   * @status public
   *
   * Compare ranges by start position, ordering longer ranges first on a tie.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} other - A {@link Range} or range-compatible `Array`.
   * @returns {Number} `-1` when this range sorts first, `0` when equal, or `1` when the argument sorts first.
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
   * @public
   * @status public
   *
   * Determine whether this range has the same endpoints as another.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} other - A {@link Range} or range-compatible `Array`.
   * @returns {Boolean} indicating whether this range has the same start and end points as the given {@link Range} or range-compatible `Array`.
   */
  isEqual(other) {
    if (other == null) {
      return false;
    }
    other = this.constructor.fromObject(other);
    return other.start.isEqual(this.start) && other.end.isEqual(this.end);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this range starts and ends on the same rows as another.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} other - A {@link Range} or range-compatible `Array`.
   * @returns {Boolean} indicating whether this range starts and ends on the same row as the argument.
   */
  coversSameRows(other) {
    other = this.constructor.fromObject(other);
    return this.start.row === other.start.row && this.end.row === other.end.row;
  }

  /** @category Range Queries */

  /**
   * @public
   * @status public
   *
   * Determines whether this range intersects with the argument.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} otherRange - A {@link Range} or range-compatible `Array`
   * @param {Boolean} [exclusive=false] - indicating whether to exclude endpoints when testing for intersection. Defaults to `false`.
   * @returns {Boolean}
   */
  intersectsWith(otherRange, exclusive) {
    otherRange = this.constructor.fromObject(otherRange);
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
   * @public
   * @status public
   *
   * Determine whether this range contains another range.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} otherRange - A {@link Range} or range-compatible `Array`
   * @param {Boolean} [exclusive=false] - including that the containment should be exclusive of endpoints. Defaults to false.
   * @returns {Boolean} indicating whether this range contains the given range.
   */
  containsRange(otherRange, exclusive) {
    const { start, end } = this.constructor.fromObject(otherRange);
    return this.containsPoint(start, exclusive) && this.containsPoint(end, exclusive);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this range contains a buffer position.
   *
   * @param {Point|Array<Number>|Object} point - A {@link Point} or point-compatible `Array`
   * @param {Boolean} [exclusive=false] - including that the containment should be exclusive of endpoints. Defaults to false.
   * @returns {Boolean} indicating whether this range contains the given point.
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
   * @public
   * @status public
   *
   * Determine whether this range intersects a row.
   *
   * @param {Number} row - Row `Number`
   * @returns {Boolean} indicating whether this range intersects the given row `Number`.
   */
  intersectsRow(row) {
    return this.start.row <= row && row <= this.end.row;
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this range intersects an inclusive range of rows.
   *
   * @param {Number} startRow - start row
   * @param {Number} endRow - end row
   * @returns {Boolean} indicating whether this range intersects the row range indicated by the given startRow and endRow `Numbers`.
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
   * @public
   * @status public
   *
   * Get a string representation of this range.
   *
   * @returns {String} string representation of the range.
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
