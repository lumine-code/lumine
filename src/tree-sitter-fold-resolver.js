const Point = require("./point");
const Range = require("./range");
const createTree = require("./rb-tree");
const { rangeIsBlank } = require("./text-source-helpers");
const { comparePoints, resolveNodePosition } = require("./tree-sitter-node-helpers");
const {
  runQuery,
  boundedQueryRange,
  withPredicateTextBudget,
  checkPredicateTextLength,
  QueryBudgetExceeded,
  DEFAULTS,
} = require("./tree-sitter-query-budget");

// How far a fold resolver reads around a single-row request when it has to
// build fresh boundary data anyway: querying only the asked-for row would
// make every scrolled-into row pay its own query, and the window costs no
// more than the row does once the query machinery is warm.
const FOLD_WINDOW_ROWS_BEHIND = 100;
const FOLD_WINDOW_ROWS_AHEAD = 300;
const FOLD_INDEX_BLOCK = 128;

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

function firstStartingAtOrAfter(entries, row) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].start.row < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lastBlockContainingPoint(levels, level, block, limit, point) {
  const end = levels[level][block];
  if (block * 2 ** level > limit || !end || end.isLessThan(point)) return -1;
  if (level === 0) return block;
  const right = lastBlockContainingPoint(levels, level - 1, 2 * block + 1, limit, point);
  return right < 0 ? lastBlockContainingPoint(levels, level - 1, 2 * block, limit, point) : right;
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
  static needsRangeCollection(error) {
    return (
      error instanceof QueryBudgetExceeded &&
      (error.reason === "fold-scan-needed" || error.reason === "range-limit")
    );
  }

  constructor(buffer, layer) {
    this.buffer = buffer;
    this.layer = layer;

    this.boundaries = null;
    this.boundariesRange = null;
    this.boundariesTree = null;
    this.boundariesEpoch = null;
    this.preparedRanges = null;
    this.dividedFoldEndsByStartNodeId = new Map();
    this.failedPrefills = new Set();
    this.failedPrefillsTree = null;
  }

  get queryBudget() {
    return this.layer.languageMode?.queryBudget ?? {};
  }

  resolveWithinBudget(callback) {
    const result = withPredicateTextBudget(callback, this.queryBudget);
    if (!result.complete) throw new QueryBudgetExceeded(result.reason);
    return result.value;
  }

  // Retrieve the first valid fold range for this row in this language layer —
  // that is, the first fold range that spans more than one row.
  getFoldRangeForRow(row, { localOnly = false } = {}) {
    const prepared = this.currentPreparedRanges();
    if (prepared) {
      const range = prepared[firstStartingAtOrAfter(prepared, row)];
      return range?.start.row === row ? range : null;
    }
    return this.resolveWithinBudget(() => this.computeFoldRangeForRow(row, localOnly));
  }

  computeFoldRangeForRow(row, localOnly) {
    if (!this.layer.tree || !this.layer.queries.foldsQuery) {
      return null;
    }
    let start = Point.fromObject({ row, column: 0 });
    let end = Point.fromObject({ row: row + 1, column: 0 });

    let tree = this.layer.getOrParseTree({ force: false });
    if (!tree) return null;
    // Search for folds that begin somewhere on the given row.
    let iterator = this.getOrCreateBoundariesIterator(tree.rootNode, start, end);

    // More than one fold can match for a given row, so we'll stop as soon as
    // we find the fold that starts earliest on the row. (The fold itself will
    // be “resolved” in such a way that it doesn't begin until the end of the
    // row, but we still consider the intrinsic range of the fold capture when
    // deciding which one to honor.)
    while (iterator.key) {
      checkPredicateTextLength(0);
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
        let range = this.resolveRangeForDividedFold(capture, localOnly);
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
    return this.resolveWithinBudget(() => this.computeAllFoldRanges());
  }

  computeAllFoldRanges() {
    if (!this.layer.getOrParseTree({ force: false }) || !this.layer.queries.foldsQuery) {
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
      checkPredicateTextLength(0);
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
    this.boundariesEpoch = null;
    this.preparedRanges = null;
    this.dividedFoldEndsByStartNodeId.clear();
    this.failedPrefills.clear();
    this.failedPrefillsTree = null;
  }

  canReuseBoundaries(start, end) {
    if (
      !this.boundariesRange ||
      this.boundariesTree !== this.layer.tree ||
      this.boundariesEpoch !== this.layer.languageMode?.getSyntaxRequestEpoch?.()
    ) {
      return false;
    }
    return this.boundariesRange.containsRange(new Range(start, end));
  }

  prefillFoldCache(range) {
    if (!this.layer.getOrParseTree({ force: false }) || !this.layer.queries.foldsQuery) {
      return;
    }
    if (this.failedPrefillsTree !== this.layer.tree) {
      this.failedPrefills.clear();
      this.failedPrefillsTree = this.layer.tree;
    }
    const key = `${range.start.row}:${range.start.column}:${range.end.row}:${range.end.column}`;
    if (this.failedPrefills.has(key)) return;
    try {
      this.getOrCreateBoundariesIterator(this.layer.tree.rootNode, range.start, range.end);
    } catch (error) {
      if (error.code !== "ERR_SYNTAX_QUERY_BUDGET") throw error;
      this.failedPrefills.add(key);
      if (this.failedPrefills.size > 16)
        this.failedPrefills.delete(this.failedPrefills.values().next().value);
    }
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
    const requestedStart = this.buffer.characterIndexForPosition(start);
    const requestedEnd = this.buffer.characterIndexForPosition(end);
    if (requestedEnd - requestedStart > (this.queryBudget.maxRangeLength ?? 1024 * 1024))
      throw new QueryBudgetExceeded("range-limit");
    if (requestedStart === requestedEnd) {
      queryStart = this.buffer.positionForCharacterIndex(requestedStart);
      queryEnd = queryStart;
    } else if (end.row - start.row <= 1) {
      queryStart = new Point(Math.max(0, start.row - FOLD_WINDOW_ROWS_BEHIND), 0);
      queryEnd = new Point(end.row + FOLD_WINDOW_ROWS_AHEAD, 0);
      const source = this.buffer.getTextSnapshot();
      const first = this.buffer.characterIndexForPosition(queryStart);
      const last = this.buffer.characterIndexForPosition(queryEnd);
      const width = Math.max(DEFAULTS.maxWindowLength, requestedEnd - requestedStart + 2);
      const window = boundedQueryRange(
        source,
        Math.max(first, requestedStart - Math.floor((width - (requestedEnd - requestedStart)) / 4)),
        last,
        width,
      );
      queryStart = this.buffer.positionForCharacterIndex(window.startIndex);
      queryEnd = this.buffer.positionForCharacterIndex(window.endIndex);
    }

    // Instead of keying off of a plain buffer position, this tree also
    // considers whether the boundary is a fold start or a fold end. If one
    // boundary ends at the same point that another one starts, the ending
    // boundary will be visited first.
    let boundaries = createTree(compareBoundaries);
    const queryResult =
      requestedStart === requestedEnd
        ? { complete: true, results: [] }
        : runQuery(
            this.layer.queries.foldsQuery,
            rootNode,
            {
              startPosition: queryStart,
              endPosition: queryEnd,
            },
            this.queryBudget,
          );
    if (!queryResult.complete) throw new QueryBudgetExceeded(queryResult.reason);
    const captures = queryResult.results;
    const invalidatedNodes = [];

    let resolved;
    try {
      resolved = withPredicateTextBudget(() => {
        for (let capture of captures) {
          checkPredicateTextLength(0);
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
            invalidatedNodes.push(capture.node);
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
        return this.indexDividedFoldPairs(boundaries);
      }, this.queryBudget);
    } finally {
      scopeResolver.reset();
    }
    if (!resolved.complete) throw new QueryBudgetExceeded(resolved.reason);

    this.boundaries = boundaries;
    this.dividedFoldEndsByStartNodeId = resolved.value;
    for (const node of invalidatedNodes) this.layer.foldNodesToInvalidateOnChange.add(node);
    // The widened range, so the neighbors this pass read for can reuse it.
    this.boundariesRange = new Range(queryStart, queryEnd);
    this.boundariesTree = this.layer.tree;
    this.boundariesEpoch = this.layer.languageMode?.getSyntaxRequestEpoch?.();

    return boundaries.ge(start);
  }

  indexDividedFoldPairs(boundaries) {
    const ends = new Map();
    const starts = [];
    const iterator = boundaries.begin;
    while (iterator.key) {
      checkPredicateTextLength(0);
      const capture = iterator.value;
      if (capture.name === "fold.start") {
        starts.push(capture);
      } else if (capture.name === "fold.end" && starts.length > 0) {
        const start = starts.pop();
        ends.set(start.node.id, capture);
      }
      iterator.next();
    }
    return ends;
  }

  // Given a `@fold.start` capture, queries the rest of the layer's extent to
  // find a matching `@fold.end`.
  resolveRangeForDividedFold(capture, localOnly = false) {
    let { name } = capture;
    if (name !== "fold.start") {
      return null;
    }

    let matchedEndCapture = this.dividedFoldEndsByStartNodeId.get(capture.node.id);
    if (!matchedEndCapture) {
      // The local gutter query usually contains both ends of a short block.
      // Its paired boundaries are already exact; widening to the whole layer
      // here repeats a document-wide query before every indentation request
      // sharing this worker can run. Only an unresolved end needs that scan.
      const extent = this.layer.getExtent();
      if (!this.canReuseBoundaries(extent.start, extent.end)) {
        if (localOnly) throw new QueryBudgetExceeded("fold-scan-needed");
        this.getOrCreateBoundariesIterator(this.layer.tree.rootNode, extent.start, extent.end);
      }
      matchedEndCapture = this.dividedFoldEndsByStartNodeId.get(capture.node.id);
    }

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

  currentPreparedRanges() {
    const prepared = this.preparedRanges;
    if (
      prepared?.tree &&
      prepared.tree === this.layer.tree &&
      prepared.query === this.layer.queries.foldsQuery &&
      prepared.epoch === this.layer.languageMode.getSyntaxRequestEpoch()
    )
      return prepared.ranges;
    return null;
  }

  beginRangeCollection() {
    return new FoldRangeCollector(this);
  }

  storePreparedRanges({ dependencies, ...result }) {
    for (const dependency of dependencies) this.layer.foldNodesToInvalidateOnChange.add(dependency);
    this.preparedRanges = result;
  }

  preparedRangeContainingPoint(point) {
    const ranges = this.currentPreparedRanges();
    if (!ranges?.length) return null;
    const limit = firstStartingAtOrAfter(ranges, point.row) - 1;
    if (limit < 0) return null;
    const finalBlock = Math.floor(limit / FOLD_INDEX_BLOCK);
    for (let i = limit; i >= finalBlock * FOLD_INDEX_BLOCK; i--) {
      if (ranges[i].containsPoint(point)) return ranges[i];
    }
    // Skip earlier blocks by their furthest end. A document-wide fold must
    // not make a lookup near EOF walk every smaller intervening fold.
    const { maxEnds } = this.preparedRanges;
    const block = lastBlockContainingPoint(maxEnds, maxEnds.length - 1, 0, finalBlock - 1, point);
    if (block >= 0) {
      for (let i = (block + 1) * FOLD_INDEX_BLOCK - 1; i >= block * FOLD_INDEX_BLOCK; i--) {
        if (ranges[i].containsPoint(point)) return ranges[i];
      }
    }
    return null;
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
    checkPredicateTextLength(0);
    if (position.column > (this.queryBudget.maxRangeLength ?? 1024 * 1024))
      throw new QueryBudgetExceeded("range-limit");
    const source = this.buffer.getTextSnapshot();
    const start = source.lineStart(position.row);
    return rangeIsBlank(source, start, start + position.column);
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
      if (error.code === "ERR_SYNTAX_QUERY_BUDGET") throw error;
      // If any of our assumptions are violated, fall back to an end point that we know can't fail: the end of the captured node itself.
      console.warn("Error resolving fold range:");
      console.warn(error.message);
      return new Range(start, node.range.end);
    }
  }
}

// Captures arrive in source order. Keep one boundary of each kind at a given
// position, then close before opening as in the local boundary tree. A divided
// fold can span any number of capture windows and can only claim its row once
// its closing boundary is known to produce a valid range.
class FoldRangeCollector {
  constructor(resolver) {
    this.resolver = resolver;
    this.extentStart = resolver.layer.getExtent().start;
    this.tree = resolver.layer.tree;
    this.query = resolver.layer.queries.foldsQuery;
    this.epoch = resolver.layer.languageMode.getSyntaxRequestEpoch();
    this.position = null;
    this.start = null;
    this.end = null;
    this.rows = [];
    this.open = [];
    this.dependencies = [];
  }

  add(capture) {
    const { layer } = this.resolver;
    if (layer.scopeResolver.shouldInvalidateFoldOnChange(capture)) {
      const { startPosition, endPosition } = capture.node;
      this.dependencies.push({ startPosition, endPosition });
    }
    if (!["fold", "fold.start", "fold.end"].includes(capture.name)) return;
    const position = capture.node.startPosition;
    if (this.position && comparePoints(this.position, position) !== 0) this.flush();
    this.position = position;
    if (capture.name === "fold.end") this.end ??= capture;
    else this.start ??= capture;
  }

  flush() {
    const { resolver, position, start, end } = this;
    if (end && this.open.length > 0) {
      const opening = this.open.pop();
      if (opening.entry) {
        const range = new Range(opening.start, resolver.resolvePositionForDividedFold(end));
        this.record(opening.entry, opening.column, range);
      }
    }
    if (start) {
      let entry;
      if (comparePoints(position, this.extentStart) >= 0) {
        entry = this.rows.at(-1);
        if (entry?.row !== position.row) {
          entry = { row: position.row, column: Infinity, range: null };
          this.rows.push(entry);
        }
      }
      if (start.name === "fold.start") {
        this.open.push({
          entry,
          column: position.column,
          start: new Point(position.row, Infinity),
        });
      } else if (entry) {
        this.record(entry, position.column, resolver.resolveRangeForSimpleFold(start));
      }
    }
    this.start = null;
    this.end = null;
  }

  record(entry, column, range) {
    if (column < entry.column && this.resolver.isValidFold(range)) {
      entry.column = column;
      entry.range = range;
    }
  }

  *finish() {
    this.flush();
    const ranges = [];
    const maxEnds = [[]];
    for (let i = 0; i < this.rows.length; i++) {
      const { range } = this.rows[i];
      if (range) {
        const block = Math.floor(ranges.length / FOLD_INDEX_BLOCK);
        maxEnds[0][block] = Point.max(maxEnds[0][block] ?? Point.ZERO, range.end);
        ranges.push(range);
      }
      if (i % 256 === 255) yield;
    }
    let ends = maxEnds[0];
    while (ends.length > 1) {
      const next = [];
      for (let i = 0; i < ends.length; i += 2) {
        next.push(Point.max(ends[i], ends[i + 1] ?? Point.ZERO));
        if (i % 512 === 510) yield;
      }
      maxEnds.push(next);
      ends = next;
    }
    return {
      tree: this.tree,
      query: this.query,
      epoch: this.epoch,
      ranges,
      maxEnds,
      dependencies: this.dependencies,
    };
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
