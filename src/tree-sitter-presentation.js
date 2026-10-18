const Point = require("./point");
const Range = require("./range");
const HighlightCache = require("./tree-sitter-highlight-cache");

const TILE_ROWS = 64;

// Only scope IDs and positions cross the presentation boundary. Preparation
// owns query execution; a paint can only request work and read the last result.
class TreeSitterPresentation {
  constructor({ buffer, cache, capture, isCurrent, iterator, hasBudget, publish }) {
    Object.assign(this, { buffer, cache, capture, isCurrent, iterator, hasBudget, publish });
    this.tiles = new Map();
    this.requests = new Set();
    this.requestsByOwner = new WeakMap();
    this.defaultOwner = {};
    this.generation = 0;
    this.closed = false;
    this.promise = null;
    this.timer = null;
    this.request(0, 63, false);
  }

  request(startRow, endRow, schedule = true) {
    this.requestRanges(this.defaultOwner, [[startRow, endRow]], schedule);
  }

  requestRanges(owner, ranges, schedule = true) {
    if (this.closed) return;
    if (owner !== this.defaultOwner) {
      const initial = this.requestsByOwner.get(this.defaultOwner);
      if (initial) {
        this.requests.delete(initial);
        this.requestsByOwner.delete(this.defaultOwner);
      }
    }
    let request = this.requestsByOwner.get(owner);
    if (!request) {
      request = { owner: new WeakRef(owner), rows: new Set() };
      this.requestsByOwner.set(owner, request);
      this.requests.add(request);
    }
    request.rows.clear();
    const lastRow = this.buffer.getLastRow();
    for (let [startRow, endRow] of ranges) {
      startRow = Math.max(0, startRow - 16);
      endRow = Math.min(lastRow, endRow + 16);
      // The view excludes fold interiors. Retain all its visible fragments;
      // a cache allowance must never truncate a view with many small folds.
      const first = Math.floor(startRow / TILE_ROWS) * TILE_ROWS;
      for (let row = first; row <= endRow; row += TILE_ROWS) {
        request.rows.add(row);
        const tile = this.tiles.get(row) ?? { row, dirty: true };
        if (
          !tile.dirty &&
          !this.cache.covers(new Point(row, 0), this.buffer.clipPosition([row + TILE_ROWS, 0]))
        )
          tile.dirty = true;
        this.tiles.delete(row);
        this.tiles.set(row, tile);
      }
    }
    const wanted = new Set();
    for (const request of this.requests) {
      const owner = request.owner.deref();
      if (!owner || owner.destroyed) {
        this.requests.delete(request);
        continue;
      }
      for (const row of request.rows) wanted.add(row);
    }
    for (const row of this.tiles.keys()) if (!wanted.has(row)) this.tiles.delete(row);
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
    const requested = new Set(this.tiles.keys());
    const current = () =>
      !this.closed &&
      generation === this.generation &&
      this.isCurrent(stamp) &&
      requested.size === this.tiles.size &&
      [...requested].every((row) => this.tiles.has(row));
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
      this.cache.replace(
        staged.snapshots.reverse(),
        {
          revision: stamp.revision,
          generation: stamp.generation,
        },
        (snapshot) => this.tiles.has(snapshot.start.row),
      );
      for (const tile of tiles) {
        const currentTile = this.tiles.get(tile.row);
        if (currentTile) currentTile.dirty = false;
      }
      for (const range of ranges) this.publish(range);
    };
    let result;
    try {
      result = run();
    } catch (error) {
      result = Promise.reject(error);
    }
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
    this.requests.clear();
    this.requestsByOwner = new WeakMap();
  }
}

module.exports = TreeSitterPresentation;
