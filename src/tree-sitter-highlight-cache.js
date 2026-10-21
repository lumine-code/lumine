const Point = require("./point");

const compare = (a, b) => a.row - b.row || a.column - b.column;
const copy = (p) => (Array.isArray(p) ? new Point(p[0], p[1]) : new Point(p.row, p.column));
const applyScopes = (scopes, event) => {
  for (const id of event.close) {
    const index = scopes.lastIndexOf(id);
    if (index !== -1) scopes.splice(index, 1);
  }
  scopes.push(...event.open);
};

function shift(point, edit, right = false) {
  const beforeStart = compare(point, edit.start);
  if (beforeStart < 0 || (beforeStart === 0 && !right)) return point;
  if (compare(point, edit.oldEnd) < 0) return right ? edit.newEnd : edit.start;
  return new Point(
    point.row + edit.newEnd.row - edit.oldEnd.row,
    point.row === edit.oldEnd.row
      ? point.column + edit.newEnd.column - edit.oldEnd.column
      : point.column,
  );
}

class ScopeIterator {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.index = 0;
  }
  getPosition() {
    return this.snapshot.events[this.index]?.position ?? Point.INFINITY;
  }
  getOpenScopeIds() {
    return this.snapshot.events[this.index]?.open ?? [];
  }
  getCloseScopeIds() {
    return this.snapshot.events[this.index]?.close ?? [];
  }
  moveToSuccessor() {
    return ++this.index < this.snapshot.events.length;
  }
}

// Presentation-only scope IDs and coordinates. No syntax nodes, source strings
// or stale query results escape through the document's semantic APIs.
class HighlightCache {
  constructor({ maxSnapshots = 16, maxEvents = 16000, maxEdits = 512 } = {}) {
    this.maxSnapshots = maxSnapshots;
    this.maxEvents = maxEvents;
    this.maxRecordEvents = Math.max(1, Math.floor(maxEvents / 2));
    this.maxEdits = maxEdits;
    this.clear();
  }
  clear() {
    this.snapshots = [];
    this.orderedSnapshots = null;
    this.scopeCheckpoints = new WeakMap();
    this.edits = [];
    this.sequence = 0;
  }
  edit({ oldRange, newRange }) {
    this.edits.push({
      sequence: ++this.sequence,
      start: copy(oldRange.start),
      oldEnd: copy(oldRange.end),
      newEnd: copy(newRange.end),
    });
    if (this.edits.length >= this.maxEdits) this.rebase();
  }
  rebase() {
    if (this.edits.length === 0) return;
    this.orderedSnapshots = null;
    for (const snapshot of this.snapshots) {
      for (const edit of this.edits) {
        if (edit.sequence <= snapshot.sequence) continue;
        if (snapshot.start.row > edit.oldEnd.row) {
          // The entire fragment moves by the same number of rows. Keep that
          // translation on the fragment instead of visiting every cold event
          // on each Enter. Reads translate only the events they consume.
          const delta = edit.newEnd.row - edit.oldEnd.row;
          if (delta === 0) continue;
          snapshot.start = shift(snapshot.start, edit);
          snapshot.end = shift(snapshot.end, edit, true);
          snapshot.rowOffset = (snapshot.rowOffset ?? 0) + delta;
          continue;
        }
        if (compare(snapshot.end, edit.start) < 0) continue;
        this.materialize(snapshot);
        snapshot.start = shift(snapshot.start, edit);
        snapshot.end = shift(snapshot.end, edit, true);
        let low = 0,
          high = snapshot.events.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compare(snapshot.events[middle].position, edit.start) < 0) low = middle + 1;
          else high = middle;
        }
        const sameRows = edit.oldEnd.row === edit.newEnd.row;
        for (let i = low; i < snapshot.events.length; i++) {
          const event = snapshot.events[i];
          if (sameRows && event.position.row > edit.oldEnd.row) break;
          event.position = shift(event.position, edit);
        }
      }
      snapshot.sequence = this.sequence;
    }
    this.edits.length = 0;
  }
  materialize(snapshot) {
    if (!snapshot.rowOffset) return;
    snapshot.events = snapshot.events.map((event) => ({
      ...event,
      position: new Point(event.position.row + snapshot.rowOffset, event.position.column),
    }));
    snapshot.rowOffset = 0;
  }
  replace(snapshots, stamp, keep = () => false) {
    this.rebase();
    this.orderedSnapshots = null;
    const retained = new Set();
    for (const snapshot of snapshots) {
      const remaining = [];
      for (const previous of this.snapshots) {
        if (
          compare(previous.end, snapshot.start) <= 0 ||
          compare(previous.start, snapshot.end) >= 0
        ) {
          remaining.push(previous);
          continue;
        }
        // Keep only the uncovered prefix/suffix. Overlapping whole windows
        // would otherwise accumulate for every narrow update or shifted row.
        this.materialize(previous);
        const fragments = [];
        if (compare(previous.start, snapshot.start) < 0)
          fragments.push({
            ...previous,
            end: copy(snapshot.start),
            events: previous.events.filter((event) => compare(event.position, snapshot.start) < 0),
          });
        if (compare(previous.end, snapshot.end) > 0) {
          const scopes = [...previous.scopes];
          let index = 0;
          while (
            index < previous.events.length &&
            compare(previous.events[index].position, snapshot.end) < 0
          )
            applyScopes(scopes, previous.events[index++]);
          fragments.push({
            ...previous,
            start: copy(snapshot.end),
            scopes,
            events: previous.events.slice(index),
          });
        }
        remaining.push(...fragments);
        if (retained.has(previous)) for (const fragment of fragments) retained.add(fragment);
      }
      this.snapshots = remaining;
      const replacement = { ...snapshot, sequence: this.sequence, stamp };
      this.snapshots.push(replacement);
      retained.add(replacement);
    }
    let events = this.snapshots.reduce((sum, snapshot) => sum + snapshot.events.length, 0);
    // The event allowance evicts old windows, never part of the current view.
    // A dense but bounded batch must not silently lose its highlighting.
    let evicted = false;
    while (this.snapshots.length > this.maxSnapshots || events > this.maxEvents) {
      const index = this.snapshots.findIndex(
        (snapshot) => !retained.has(snapshot) && !keep(snapshot),
      );
      if (index < 0) break;
      evicted = true;
      events -= this.removeSnapshot(index).events.length;
    }
    return evicted;
  }
  removeSnapshot(index) {
    this.orderedSnapshots = null;
    return this.snapshots.splice(index, 1)[0];
  }
  getOrderedSnapshots() {
    this.rebase();
    return (this.orderedSnapshots ??= [...this.snapshots].sort((a, b) =>
      compare(a.start, b.start),
    ));
  }
  covers(start, end, stamp = null) {
    let position = start;
    for (const snapshot of this.getOrderedSnapshots()) {
      if (
        stamp &&
        (snapshot.stamp?.revision !== stamp.revision ||
          snapshot.stamp?.generation !== stamp.generation ||
          (stamp.presentation !== undefined && snapshot.stamp?.presentation !== stamp.presentation))
      )
        continue;
      if (compare(snapshot.start, position) > 0) break;
      if (compare(snapshot.end, position) > 0) position = snapshot.end;
      if (compare(position, end) >= 0) return true;
    }
    return false;
  }
  uncoveredRanges(start, end, stamp = null) {
    const ranges = [];
    let position = start;
    for (const snapshot of this.getOrderedSnapshots()) {
      if (
        stamp &&
        (snapshot.stamp?.revision !== stamp.revision ||
          snapshot.stamp?.generation !== stamp.generation ||
          snapshot.stamp?.presentation !== stamp.presentation)
      )
        continue;
      if (compare(position, end) >= 0) break;
      if (compare(snapshot.end, position) <= 0 || compare(snapshot.start, snapshot.end) >= 0)
        continue;
      if (compare(snapshot.start, position) > 0)
        ranges.push([
          copy(position),
          copy(compare(snapshot.start, end) < 0 ? snapshot.start : end),
        ]);
      if (compare(snapshot.end, position) > 0) position = snapshot.end;
    }
    if (compare(position, end) < 0) ranges.push([copy(position), copy(end)]);
    return ranges;
  }
  record(iterator, buffer, { complete = false } = {}) {
    const cache = this;
    let snapshot, limit;
    function cover() {
      if (!snapshot) return;
      const position = iterator.getPosition();
      snapshot.end = copy(compare(position, limit) < 0 ? position : limit);
    }
    return {
      seek(start, endRow = buffer.getLastRow()) {
        const scopes = iterator.seek(start, endRow);
        limit = buffer.clipPosition([endRow + 1, 0]);
        snapshot = {
          sequence: cache.sequence,
          start: copy(start),
          end: copy(start),
          scopes: [...scopes],
          events: [],
        };
        cache.snapshots.push(snapshot);
        cache.orderedSnapshots = null;
        if (!complete && cache.snapshots.length > cache.maxSnapshots) cache.snapshots.shift();
        cover();
        return scopes;
      },
      getPosition: () => iterator.getPosition(),
      getOpenScopeIds: () => iterator.getOpenScopeIds(),
      getCloseScopeIds: () => iterator.getCloseScopeIds(),
      moveToSuccessor() {
        if (snapshot && compare(iterator.getPosition(), limit) <= 0) {
          snapshot.events.push({
            position: copy(iterator.getPosition()),
            open: [...iterator.getOpenScopeIds()],
            close: [...iterator.getCloseScopeIds()],
          });
          if (!complete && snapshot.events.length > cache.maxRecordEvents) {
            cache.snapshots = cache.snapshots.filter((item) => item !== snapshot);
            cache.orderedSnapshots = null;
            snapshot = null;
          }
          if (!complete) {
            let total = cache.snapshots.reduce((count, item) => count + item.events.length, 0);
            while (total > cache.maxEvents && cache.snapshots.length > 1)
              total -= cache.removeSnapshot(0).events.length;
          }
        }
        const result = iterator.moveToSuccessor();
        cover();
        return result;
      },
    };
  }
  scopesBefore(snapshot, position) {
    if (snapshot.rowOffset)
      position = new Point(position.row - snapshot.rowOffset, position.column);
    const events = snapshot.events;
    let low = 0,
      high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(events[middle].position, position) < 0) low = middle + 1;
      else high = middle;
    }
    // Row-by-row consumers (notably the minimap) must not replay a tile's
    // entire prefix for every row. Edits move boundaries, but preserve their
    // scope sequence; replaced/sliced snapshots get their own checkpoints.
    let saved = this.scopeCheckpoints.get(snapshot);
    if (!saved || saved.count !== events.length) {
      saved = { count: events.length, scopes: [[...snapshot.scopes]] };
      this.scopeCheckpoints.set(snapshot, saved);
    }
    const checkpoint = Math.floor(low / 64);
    if (saved.scopes.length <= checkpoint) {
      const scopes = [...saved.scopes.at(-1)];
      for (let i = (saved.scopes.length - 1) * 64; i < checkpoint * 64; i++) {
        applyScopes(scopes, events[i]);
        if ((i + 1) % 64 === 0) saved.scopes.push([...scopes]);
      }
    }
    const scopes = [...saved.scopes[checkpoint]];
    for (let i = checkpoint * 64; i < low; i++) applyScopes(scopes, events[i]);
    return { scopes, index: low };
  }

  read(start, end, fallback) {
    this.rebase();
    // Pick the newest covering paint at each boundary, so overlapping tiles
    // and narrow repaints cannot overwrite each other's newer styles.
    const events = [];
    let scopes = [...fallback];
    const transition = (position, next) => {
      let common = 0;
      while (common < scopes.length && common < next.length && scopes[common] === next[common])
        common++;
      const close = scopes.slice(common).reverse();
      const open = next.slice(common);
      if (close.length || open.length) events.push({ position, close, open });
      scopes = [...next];
    };
    let position = start;
    while (compare(position, end) < 0) {
      let selected = -1;
      for (let i = this.snapshots.length - 1; i >= 0; i--) {
        const item = this.snapshots[i];
        if (compare(item.start, position) <= 0 && compare(position, item.end) < 0) {
          selected = i;
          break;
        }
      }
      const snapshot = this.snapshots[selected];
      let limit = snapshot && compare(snapshot.end, end) < 0 ? snapshot.end : end;
      for (let i = selected + 1; i < this.snapshots.length; i++) {
        const candidate = this.snapshots[i];
        if (compare(candidate.start, candidate.end) >= 0) continue;
        if (compare(candidate.start, position) > 0 && compare(candidate.start, limit) < 0)
          limit = candidate.start;
      }
      if (snapshot) {
        let { scopes: initial, index } = this.scopesBefore(snapshot, position);
        transition(position, initial);
        const eventLimit = snapshot.rowOffset
          ? new Point(limit.row - snapshot.rowOffset, limit.column)
          : limit;
        while (
          index < snapshot.events.length &&
          compare(snapshot.events[index].position, eventLimit) < 0
        ) {
          let event = snapshot.events[index++];
          if (snapshot.rowOffset)
            event = {
              ...event,
              position: new Point(event.position.row + snapshot.rowOffset, event.position.column),
            };
          events.push(event);
          applyScopes(scopes, event);
        }
      } else transition(position, fallback);
      position = limit;
    }
    transition(end, []);
    return { scopes: [...fallback], iterator: new ScopeIterator({ events }) };
  }
}

module.exports = HighlightCache;
