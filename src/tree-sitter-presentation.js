const Point = require("./point");
const Range = require("./range");
const HighlightCache = require("./tree-sitter-highlight-cache");

const TILE_ROWS = 64;
const MAX_TILES = 16;

// Only scope IDs and positions cross the presentation boundary. Preparation
// owns query execution; a paint can only request work and read the last result.
class TreeSitterPresentation {
  constructor({ buffer, cache, capture, isCurrent, iterator, hasBudget, publish }) {
    Object.assign(this, { buffer, cache, capture, isCurrent, iterator, hasBudget, publish });
    this.tiles = new Map();
    this.generation = 0;
    this.closed = false;
    this.promise = null;
    this.timer = null;
    this.request(0, 63, false);
  }

  request(startRow, endRow, schedule = true) {
    const lastRow = this.buffer.getLastRow();
    startRow = Math.max(0, startRow - 16);
    endRow = Math.min(lastRow, endRow + 16);
    // A render request can span a large folded region. Bound retained work;
    // subsequent requests for its other visible fragments take priority.
    const first = Math.floor(startRow / TILE_ROWS) * TILE_ROWS;
    for (let row = first; row <= endRow && row < first + MAX_TILES * TILE_ROWS; row += TILE_ROWS) {
      const tile = this.tiles.get(row) ?? { row, dirty: true };
      if (
        !tile.dirty &&
        !this.cache.covers(new Point(row, 0), this.buffer.clipPosition([row + TILE_ROWS, 0]))
      )
        tile.dirty = true;
      this.tiles.delete(row);
      this.tiles.set(row, tile);
    }
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value);
    if (schedule && [...this.tiles.values()].some((tile) => tile.dirty)) this.schedule();
  }

  invalidate(range = null) {
    this.generation++;
    for (const tile of this.tiles.values()) {
      if (!range || (tile.row <= range.end.row && tile.row + TILE_ROWS > range.start.row))
        tile.dirty = true;
    }
  }

  edit({ oldRange, newRange }) {
    // Equal-height edits leave other tiles' coordinates intact. Parse changes
    // and invalidateOnChange captures can widen this conservative local range
    // before publication. Row shifts require rebuilding the requested windows.
    this.invalidate(
      oldRange.end.row === newRange.end.row
        ? new Range([Math.max(0, newRange.start.row - 1), 0], [newRange.end.row + 1, Infinity])
        : null,
    );
  }

  schedule() {
    if (this.closed || this.timer || this.promise) return;
    this.timer = setImmediate(() => {
      this.timer = null;
      this.flush();
    });
  }

  flush() {
    if (this.closed) return null;
    if (this.failedGeneration === this.generation) return null;
    if (this.promise) return this.promise;
    const tiles = [...this.tiles.values()].filter((tile) => tile.dirty).reverse();
    if (!tiles.length) return null;
    const stamp = this.capture();
    if (!stamp) return null;
    clearImmediate(this.timer);
    this.timer = null;
    const generation = this.generation;
    const staged = new HighlightCache({ maxEvents: this.cache.maxEvents });
    const ranges = [];
    let index = 0;
    const current = () => !this.closed && generation === this.generation && this.isCurrent(stamp);
    const run = (resumed = false) => {
      while (current() && index < tiles.length) {
        // Permit one tile after yielding even when the configured sync budget
        // is zero. Individual query calls cannot be interrupted safely.
        if (!resumed && !this.hasBudget())
          return new Promise((resolve) => setImmediate(resolve)).then(() => run(true));
        resumed = false;
        const tile = tiles[index++];
        if (tile.row > this.buffer.getLastRow()) continue;
        const endRow = Math.min(this.buffer.getLastRow(), tile.row + TILE_ROWS - 1);
        const iterator = staged.record(this.iterator(), this.buffer, { complete: true });
        iterator.seek(new Point(tile.row, 0), endRow);
        const end = this.buffer.clipPosition(new Point(endRow + 1, 0));
        while (iterator.getPosition().compare(end) <= 0) iterator.moveToSuccessor();
        ranges.push(new Range([tile.row, 0], end));
      }
      if (!current()) return;
      // Commit the requested fragments together. No partially prepared view
      // becomes visible, even if an edit, query reload or topology change won.
      this.cache.replace(staged.snapshots.reverse(), {
        revision: stamp.revision,
        generation: stamp.generation,
      });
      for (const tile of tiles) tile.dirty = false;
      for (const range of ranges) this.publish(range);
    };
    const result = run();
    if (!result?.then) return null;
    const promise = result
      .catch((error) => {
        this.failedGeneration = generation;
        throw error;
      })
      .finally(() => {
        if (this.promise === promise) this.promise = null;
        if (
          !this.closed &&
          this.failedGeneration !== this.generation &&
          [...this.tiles.values()].some((tile) => tile.dirty)
        )
          this.schedule();
      });
    this.promise = promise;
    // Scheduled work has no awaiting caller. Report failures without leaving
    // an unhandled rejection or pretending its incomplete result is current.
    promise.catch((error) => console.error("Tree-sitter presentation failed", error));
    return promise;
  }

  destroy() {
    this.closed = true;
    clearImmediate(this.timer);
    this.tiles.clear();
  }
}

module.exports = TreeSitterPresentation;
