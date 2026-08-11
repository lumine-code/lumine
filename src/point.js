function isActualNumber(value) {
  return typeof value === "number" && !Number.isNaN(value);
}

/**
 * @public
 * @status public
 *
 * Represents a point in a buffer in row/column coordinates.
 *
 * Every public method that takes a point also accepts a *point-compatible*
 * `Array`. This means a 2-element array containing `Numbers` representing the
 * row and column. So the following are equivalent:
 *
 * ```js
 * new Point(1, 2)
 * [1, 2] // Point-compatible Array
 * ```
 */
class Point {
  /**
   * @category Construction
   */

  static ZERO = Object.freeze(new Point(0, 0));
  static INFINITY = Object.freeze(new Point(Infinity, Infinity));

  /**
   * @public
   * @status public
   *
   * Convert any point-compatible object to a {@link Point}.
   *
   * @param object - This can be an object that's already a {@link Point}, in which case it's simply returned; or an array containing two `Numbers` representing the row and column.
   * @param copy - An optional boolean indicating whether to force the copying of objects that are already points.
   * @returns {Point} A point based on the given object.
   */
  static fromObject(object, copy) {
    if (object instanceof Point) {
      return copy ? object.copy() : object;
    } else {
      let column, row;
      if (Array.isArray(object)) {
        [row, column] = object;
      } else {
        ({ row, column } = object);
      }

      return new Point(row, column);
    }
  }

  /**
   * @category Comparison
   */

  /**
   * @public
   * @status public
   *
   * @param {Point} point1
   * @param {Point} point2
   * @returns {Point} given {@link Point} that occurs earlier in the buffer.
   */
  static min(point1, point2) {
    point1 = this.fromObject(point1);
    point2 = this.fromObject(point2);
    if (point1.isLessThanOrEqual(point2)) {
      return point1;
    } else {
      return point2;
    }
  }

  /**
   * @public
   * @status public
   *
   * @param {Point} point1
   * @param {Point} point2
   * @returns {Point} given {@link Point} that occurs later in the buffer.
   */
  static max(point1, point2) {
    point1 = Point.fromObject(point1);
    point2 = Point.fromObject(point2);
    if (point1.compare(point2) >= 0) {
      return point1;
    } else {
      return point2;
    }
  }

  /**
   * @public
   * @status public
   *
   * Ensure the given {@link Point} is valid by throwing a `TypeError` if
   * either its `row` or its `column` is not an integer.
   */
  static assertValid(point) {
    if (!isActualNumber(point.row) || !isActualNumber(point.column)) {
      throw new TypeError(`Invalid Point: ${point}`);
    }
  }

  /**
   * @category Construction
   */

  /**
   * @public
   * @status public
   *
   * Construct a {@link Point} object.
   *
   * @param {Number} row - row
   * @param {Number} column - column
   */
  constructor(row = 0, column = 0) {
    this.row = row;
    this.column = column;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Point} new {@link Point} with the same row and column.
   */
  copy() {
    return new Point(this.row, this.column);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Point} new {@link Point} with the row and column negated.
   */
  negate() {
    return new Point(-this.row, -this.column);
  }

  /**
   * @category Operations
   */

  /**
   * @public
   * @status public
   *
   * Make this point immutable and return itself.
   *
   * @returns {Point} immutable version of this {@link Point}.
   */
  freeze() {
    return Object.freeze(this);
  }

  /**
   * @public
   * @status public
   *
   * Build and return a new point by adding the rows and columns of
   * the given point.
   *
   * @param other - A {@link Point} whose row and column will be added to this point's row and column to build the returned point.
   * @returns {Point}
   */
  translate(other) {
    const { row, column } = Point.fromObject(other);
    return new Point(this.row + row, this.column + column);
  }

  /**
   * @public
   * @status public
   *
   * Build and return a new {@link Point} by traversing the rows and columns
   * specified by the given point.
   *
   *
   * This method differs from the direct, vector-style addition offered by
   * {@link #translate}. Rather than adding the rows and columns directly, it derives
   * the new point from traversing in "typewriter space". At the end of every row
   * traversed, a carriage return occurs that returns the columns to 0 before
   * continuing the traversal.
   *
   * ## Examples
   *
   * Traversing 0 rows, 2 columns:
   * `new Point(10, 5).traverse(new Point(0, 2)) # => [10, 7]`
   *
   * Traversing 2 rows, 2 columns. Note the columns reset from 0 before adding:
   * `new Point(10, 5).traverse(new Point(2, 2)) # => [12, 2]`
   *
   * @param other - A {@link Point} providing the rows and columns to traverse by.
   * @returns {Point}
   */
  traverse(other) {
    let column;
    other = Point.fromObject(other);
    const row = this.row + other.row;
    if (other.row === 0) {
      column = this.column + other.column;
    } else {
      ({ column } = other);
    }

    return new Point(row, column);
  }

  traversalFrom(other) {
    other = Point.fromObject(other);
    if (this.row === other.row) {
      if (this.column === Infinity && other.column === Infinity) {
        return new Point(0, 0);
      } else {
        return new Point(0, this.column - other.column);
      }
    } else {
      return new Point(this.row - other.row, this.column);
    }
  }

  splitAt(column) {
    let rightColumn;
    if (this.row === 0) {
      rightColumn = this.column - column;
    } else {
      rightColumn = this.column;
    }

    return [new Point(0, column), new Point(this.row, rightColumn)];
  }

  /**
   * @category Comparison
   */

  /**
   * @public
   * @status public
   *
   * @param other - A {@link Point} or point-compatible `Array`.
   * @returns {Number} `-1` when this point precedes the argument, `0` when they are equal, or `1` when it follows.
   */
  compare(other) {
    other = Point.fromObject(other);
    if (this.row > other.row) {
      return 1;
    } else if (this.row < other.row) {
      return -1;
    } else {
      if (this.column > other.column) {
        return 1;
      } else if (this.column < other.column) {
        return -1;
      } else {
        return 0;
      }
    }
  }

  /**
   * @public
   * @status public
   *
   * @param other - A {@link Point} or point-compatible `Array`.
   * @returns {Boolean} indicating whether this point has the same row and column as the given {@link Point} or point-compatible `Array`.
   */
  isEqual(other) {
    if (!other) {
      return false;
    }
    other = Point.fromObject(other);
    return this.row === other.row && this.column === other.column;
  }

  /**
   * @public
   * @status public
   *
   * @param other - A {@link Point} or point-compatible `Array`.
   * @returns {Boolean} indicating whether this point precedes the given {@link Point} or point-compatible `Array`.
   */
  isLessThan(other) {
    return this.compare(other) < 0;
  }

  /**
   * @public
   * @status public
   *
   * @param other - A {@link Point} or point-compatible `Array`.
   * @returns {Boolean} indicating whether this point precedes or is equal to the given {@link Point} or point-compatible `Array`.
   */
  isLessThanOrEqual(other) {
    return this.compare(other) <= 0;
  }

  /**
   * @public
   * @status public
   *
   * @param other - A {@link Point} or point-compatible `Array`.
   * @returns {Boolean} indicating whether this point follows the given {@link Point} or point-compatible `Array`.
   */
  isGreaterThan(other) {
    return this.compare(other) > 0;
  }

  /**
   * @public
   * @status public
   *
   * @param other - A {@link Point} or point-compatible `Array`.
   * @returns {Boolean} indicating whether this point follows or is equal to the given {@link Point} or point-compatible `Array`.
   */
  isGreaterThanOrEqual(other) {
    return this.compare(other) >= 0;
  }

  isZero() {
    return this.row === 0 && this.column === 0;
  }

  isPositive() {
    if (this.row > 0) {
      return true;
    } else if (this.row < 0) {
      return false;
    } else {
      return this.column > 0;
    }
  }

  isNegative() {
    if (this.row < 0) {
      return true;
    } else if (this.row > 0) {
      return false;
    } else {
      return this.column < 0;
    }
  }

  /**
   * @category Conversion
   */

  /**
   * @public
   * @status public
   *
   * @returns {Array} array of this point's row and column.
   */
  toArray() {
    return [this.row, this.column];
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array} array of this point's row and column.
   */
  serialize() {
    return this.toArray();
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} string representation of the point.
   */
  toString() {
    return `(${this.row}, ${this.column})`;
  }
}

// ES5 classes differ from their predecessors in that you are not allowed to
// call them like ordinary functions. Hence we must write this wrapper function
// which delegates to `new Point` whether it was called with `new` or not.
function _Point(...args) {
  return new Point(...args);
}
_Point.displayName = "Point";
_Point.prototype = Point.prototype;
Object.assign(_Point.prototype, {
  row: null,
  column: null,
});
// Make the wrapper inherit the parent's static methods.
Object.setPrototypeOf(_Point, Point);

module.exports = _Point;
