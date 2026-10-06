const Point = require("./point");
const Range = require("./range");
const createTree = require("./rb-tree");
const { comparePoints, resolveNodePosition } = require("./tree-sitter-node-helpers");

// How far a fold resolver reads around a single-row request when it has to
// build fresh boundary data anyway: querying only the asked-for row would
// make every scrolled-into row pay its own query, and the window costs no
// more than the row does once the query machinery is warm.
const FOLD_WINDOW_ROWS_BEHIND = 100;
const FOLD_WINDOW_ROWS_AHEAD = 300;

// Acts like `comparePoints`, but treats starting and ending boundaries
// differently, making it so that ending boundaries are visited before starting
// boundaries.
function compareBoundaries(a, b) {
  if (!a.position) {
    a = { position: a, boundary: "end" };
  }
  if (!b.position) {
    b = { position: b, boundary: "end" };
  }
  let result = comparePoints(a.position, b.position);
  if (result !== 0) {
    return result;
  }
  if (a.boundary === b.boundary) {
    return 0;
  }
  return a.boundary === "end" ? -1 : 1;
}

// Responsible for deciding the ranges of folds on a given language layer.
//
// Understands two kinds of folds:
//
// * A “simple” fold is one with a capture name of `@fold` in a folds query. It
//   can be described with only one capture. It starts at the end of the row
//   that the captured node starts on, and ends at a configurable position
//   controlled by the `fold.endAt` adjustment (which defaults to
//   `lastChild.startPosition`).
//
//   Simple folds should be used whenever you're able to predict the end of a
//   fold range simply from holding a reference to its starting node.
//
// * A “divided” fold is one where the two ends of the fold must be described
//   in two separate query captures. It starts at the end of the row of a node
//   captured with the name of `@fold.start`, and it ends at the very next
//   `@fold.end` that it encounters in the document.
//
//   When determining the end of a fold that is marked with `@fold.start`,
//   Lumine will search the buffer for the next “balanced” occurrence of
//   `@fold.end`. For instance, when trying to find a match for a `@fold.start`
//   on row 9, Lumine might encounter another `@fold.start` on row 10,
//   and would then understand that the next `@fold.end` it sees will end
//   _that_ fold and not the one we're looking for. If Lumine _does not_ find a
//   matching `@fold.end`, the given line will not be considered to be
//   foldable.
//
//   Because they can trigger a buffer-wide search, divided folds are
//   not recommended to use unless they're truly needed. Use them only when the
//   structure of the syntax tree doesn't allow you to determine the end of the
//   fold without applying your own heuristic.
//
class FoldResolver {
  constructor(buffer, layer) {
    this.buffer = buffer;
    this.layer = layer;

    this.boundaries = null;
    this.boundariesRange = null;
    this.boundariesTree = null;
    this.dividedFoldEndsByStartNodeId = new Map();
  }

  // Retrieve the first valid fold range for this row in this language layer —
  // that is, the first fold range that spans more than one row.
  getFoldRangeForRow(row) {
    if (!this.layer.tree || !this.layer.queries.foldsQuery) {
      return null;
    }
    let start = Point.fromObject({ row, column: 0 });
    let end = Point.fromObject({ row: row + 1, column: 0 });

    let tree = this.layer.getOrParseTree({ force: false });
    // Search for folds that begin somewhere on the given row.
    let iterator = this.getOrCreateBoundariesIterator(tree.rootNode, start, end);

    // More than one fold can match for a given row, so we'll stop as soon as
    // we find the fold that starts earliest on the row. (The fold itself will
    // be “resolved” in such a way that it doesn't begin until the end of the
    // row, but we still consider the intrinsic range of the fold capture when
    // deciding which one to honor.)
    while (iterator.key) {
      if (comparePoints(iterator.key.position, end) >= 0) {
        break;
      }
      let capture = iterator.value;
      let { name } = capture;
      if (name === "fold") {
        let range = this.resolveRangeForSimpleFold(capture);
        if (this.isValidFold(range)) {
          return range;
        }
      } else if (name === "fold.start") {
        let range = this.resolveRangeForDividedFold(capture);
        if (this.isValidFold(range)) {
          return range;
        }
      }
      iterator.next();
    }

    return null;
  }

  isValidFold(range) {
    return range && range.end.row > range.start.row;
  }

  // Returns all valid fold ranges in this language layer.
  //
  // There are two rules about folds that we can't change:
  //
  // 1. A fold must collapse at least one line’s worth of content.
  // 2. The UI for expanding and collapsing folds envisions that each line can
  //    manage a maximum of _one_ fold.
  //
  // Hence a fold range is “valid” when it
  // * resolves to a range that spans more than one line;
  // * starts on a line that hasn't already been promised to an earlier fold.
  getAllFoldRanges() {
    if (!this.layer.tree || !this.layer.queries.foldsQuery) {
      return [];
    }
    let range = this.layer.getExtent();
    // We use a Tree-sitter query to find folds; then we arrange the folds in
    // buffer order. The first valid fold we find on a given line is included
    // in the list; any other folds on the line are ignored.
    let iterator = this.getOrCreateBoundariesIterator(
      this.layer.tree.rootNode,
      range.start,
      range.end,
    );

    let results = [];
    let lastValidFoldRange = null;
    while (iterator.key) {
      let capture = iterator.value;
      let { name } = capture;
      let range;
      if (name === "fold") {
        range = this.resolveRangeForSimpleFold(capture);
      } else if (name === "fold.start") {
        range = this.resolveRangeForDividedFold(capture);
      }
      if (this.isValidFold(range)) {
        // Recognize only the first fold for each row.
        if (lastValidFoldRange?.start?.row !== range.start.row) {
          results.push(range);
          lastValidFoldRange = range;
        }
      }
      iterator.next();
    }

    return results;
  }

  // Invalidates the fold resolver's cached boundary data in response to a
  // change in the document.
  reset() {
    this.boundaries = null;
    this.boundariesRange = null;
    this.boundariesTree = null;
    this.dividedFoldEndsByStartNodeId.clear();
  }

  canReuseBoundaries(start, end) {
    if (!this.boundariesRange || this.boundariesTree !== this.layer.tree) {
      return false;
    }
    return this.boundariesRange.containsRange(new Range(start, end));
  }

  prefillFoldCache(range) {
    if (!this.layer.tree || !this.layer.queries.foldsQuery) {
      return;
    }
    this.getOrCreateBoundariesIterator(this.layer.tree.rootNode, range.start, range.end);
  }

  getOrCreateBoundariesIterator(rootNode, start, end) {
    if (!this.layer.tree || !this.layer.queries.foldsQuery) {
      return null;
    }
    if (this.canReuseBoundaries(start, end)) {
      return this.boundaries.ge(start);
    }

    let scopeResolver = this.layer.scopeResolver;
    scopeResolver.reset();

    // A fresh query pays the same machinery whether it reads one row or a few
    // hundred, and single-row requests arrive in runs — the gutter resolving
    // rows as they scroll in. Reading a window around the request lets those
    // neighbors reuse this pass instead of each running their own.
    let queryStart = start;
    let queryEnd = end;
    if (end.row - start.row <= 1) {
      queryStart = new Point(Math.max(0, start.row - FOLD_WINDOW_ROWS_BEHIND), 0);
      queryEnd = new Point(end.row + FOLD_WINDOW_ROWS_AHEAD, 0);
    }

    // Instead of keying off of a plain buffer position, this tree also
    // considers whether the boundary is a fold start or a fold end. If one
    // boundary ends at the same point that another one starts, the ending
    // boundary will be visited first.
    let boundaries = createTree(compareBoundaries);
    let captures = this.layer.queries.foldsQuery.captures(rootNode, {
      startPosition: queryStart,
      endPosition: queryEnd,
    });

    for (let capture of captures) {
      // NOTE: Currently, the first fold to match for a given starting position
      // is the only one considered. That's because we use a version of a
      // red-black tree in which we silently ignore any attempts to add a key
      // that is equivalent in value to that of a previously added key.
      //
      // Attempts to use `capture.final` and `capture.shy` won't harm anything,
      // but they'll be redundant. Other types of custom predicates, however,
      // should work just fine.
      let result = scopeResolver.store(capture, { boundaries: false });
      if (!result) {
        continue;
      }

      // Some folds are unusual enough that they can flip from valid to
      // invalid, or vice versa, based on edits to rows other than their
      // starting row. We need to keep track of these nodes so that we can
      // invalidate the fold cache properly when edits happen inside of them.
      if (scopeResolver.shouldInvalidateFoldOnChange(capture)) {
        this.layer.foldNodesToInvalidateOnChange.add(capture.node.id);
      }

      if (capture.node.startPosition.row < queryStart.row) {
        // This fold starts before the range we're interested in. We needed to
        // run these nodes through the scope resolver for various reasons, but
        // they're not relevant to our iterator.
        continue;
      }
      if (capture.name === "fold") {
        boundaries = boundaries.insert(
          {
            position: capture.node.startPosition,
            boundary: "start",
          },
          capture,
        );
      } else if (capture.name.startsWith("fold.")) {
        let key = this.keyForDividedFold(capture);
        boundaries = boundaries.insert(key, capture);
      }
    }

    scopeResolver.reset();

    this.boundaries = boundaries;
    this.indexDividedFoldPairs(boundaries);
    // The widened range, so the neighbors this pass read for can reuse it.
    this.boundariesRange = new Range(queryStart, queryEnd);
    this.boundariesTree = this.layer.tree;

    return boundaries.ge(start);
  }

  indexDividedFoldPairs(boundaries) {
    this.dividedFoldEndsByStartNodeId.clear();
    const starts = [];
    const iterator = boundaries.begin;
    while (iterator.key) {
      const capture = iterator.value;
      if (capture.name === "fold.start") {
        starts.push(capture);
      } else if (capture.name === "fold.end" && starts.length > 0) {
        const start = starts.pop();
        this.dividedFoldEndsByStartNodeId.set(start.node.id, capture);
      }
      iterator.next();
    }
  }

  // Given a `@fold.start` capture, queries the rest of the layer's extent to
  // find a matching `@fold.end`.
  resolveRangeForDividedFold(capture) {
    let { name } = capture;
    if (name !== "fold.start") {
      return null;
    }

    let extent = this.layer.getExtent();
    this.getOrCreateBoundariesIterator(this.layer.tree.rootNode, extent.start, extent.end);
    const matchedEndCapture = this.dividedFoldEndsByStartNodeId.get(capture.node.id);

    // There's no guarantee that a matching `@fold.end` will even appear, so if
    // it doesn't, then this row does not contain a valid fold.
    if (!matchedEndCapture) {
      return null;
    }

    return new Range(
      this.resolvePositionForDividedFold(capture),
      this.resolvePositionForDividedFold(matchedEndCapture),
    );
  }

  keyForDividedFold(capture) {
    let { name, node } = capture;
    if (name === "fold.start") {
      // Eventually we'll alter this position to occur at the end of the given
      // row, but we keep the original value around for a while because we want
      // to honor whichever fold technically happens “earliest” on a given row.
      return { position: node.startPosition, boundary: "start" };
    } else if (name === "fold.end") {
      return { position: node.startPosition, boundary: "end" };
    } else {
      return null;
    }
  }

  // Returns `true` if there is no non-whitespace content on this position's
  // row before this position's column.
  positionIsNotPrecededByTextOnLine(position) {
    let textForRow = this.buffer.lineForRow(position.row);
    let precedingText = textForRow.substring(0, position.column);
    return !/\S/.test(precedingText);
  }

  resolvePositionForDividedFold(capture) {
    let { name, node, setProperties: props } = capture;
    if (name === "fold.start") {
      return new Point(node.startPosition.row, Infinity);
    } else if (name === "fold.end") {
      // `@fold.end` can have adjustments applied to it just like `@fold`.
      let defaultOptions = { "fold.endAt": "startPosition" };
      let options = { ...defaultOptions, ...props };
      let end = node.startPosition;
      let originalEnd = end;
      for (let key in options) {
        if (!this.capturePropertyIsFoldAdjustment(key)) {
          continue;
        }
        let value = options[key];
        end = this.applyFoldAdjustment(key, end, node, value, props, this.layer);
      }
      // There's an implicit behavior that we apply for ease of use, but we
      // should skip it if any `#set!` predicates were used to tweak the end
      // location.
      let positionDidMove = originalEnd.row !== end.row || originalEnd.column !== end.column;
      if (!positionDidMove && (end.column === 0 || this.positionIsNotPrecededByTextOnLine(end))) {
        // If the fold ends at the start of the line, adjust it so that it
        // actually ends at the end of the previous line. This behavior is
        // implied in the existing specs.
        return new Point(end.row - 1, Infinity);
      } else {
        return Point.fromObject(end, true);
      }
    } else {
      return null;
    }
  }

  normalizeFoldProperty(prop) {
    if (prop.startsWith("fold.")) {
      prop = prop.replace(/^fold./, "");
    }
    return prop;
  }

  capturePropertyIsFoldAdjustment(prop) {
    prop = this.normalizeFoldProperty(prop);
    return prop in FoldResolver.ADJUSTMENTS;
  }

  applyFoldAdjustment(prop, ...args) {
    prop = this.normalizeFoldProperty(prop);
    return FoldResolver.ADJUSTMENTS[prop](...args);
  }

  resolveRangeForSimpleFold(capture) {
    let { node, setProperties: props } = capture;
    if (node.type === "ERROR") {
      return null;
    }
    let start = new Point(node.startPosition.row, Infinity);
    let end = node.endPosition;

    let defaultOptions = { "fold.endAt": "lastChild.startPosition" };
    let options = { ...defaultOptions, ...props };

    try {
      for (let key in options) {
        if (!this.capturePropertyIsFoldAdjustment(key)) {
          continue;
        }
        let value = options[key];
        end = this.applyFoldAdjustment(key, end, node, value, props, this.layer);
      }
      if (!end) {
        return null;
      }

      end = Point.fromObject(end, true);
      end = this.buffer.clipPosition(end);

      if (end.row <= start.row) {
        return null;
      }
      return new Range(start, end);
    } catch (error) {
      // If any of our assumptions are violated, fall back to an end point that we know can't fail: the end of the captured node itself.
      console.warn("Error resolving fold range:");
      console.warn(error.message);
      return new Range(start, node.range.end);
    }
  }
}

FoldResolver.ADJUSTMENTS = {
  // Use a node position descriptor to describe where the fold should end.
  // Overrides the default descriptor of `lastChild.startPosition`.
  endAt(end, node, value) {
    end = resolveNodePosition(node, value);
    return end;
  },

  // Adjust the end point by a fixed number of characters in either direction.
  // Will cross rows if necessary.
  offsetEnd(end, _node, value, _props, layer) {
    let { languageMode } = layer;
    value = Number(value);
    if (isNaN(value)) {
      return end;
    }
    return languageMode.adjustPositionByOffset(end, value);
  },

  // Adjust the column of the fold's end point. Use `0` to end the fold at the
  // start of the line.
  adjustEndColumn(end, _node, value, _props, layer) {
    let column = Number(value);
    if (isNaN(column)) {
      return end;
    }
    let newEnd = Point.fromObject({ column, row: end.row });
    return layer.buffer.clipPosition(newEnd);
  },

  // Adjust the end point to be immediately before the current line begins.
  // Useful if the end line also contains the start of a fold and thus should
  // stay on a separate screen line.
  adjustToEndOfPreviousRow(end) {
    return new Point(end.row - 1, Infinity);
  },
};

module.exports = FoldResolver;
