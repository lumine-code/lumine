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
    for (const snapshot of this.snapshots) {
      for (const edit of this.edits) {
        if (edit.sequence <= snapshot.sequence) continue;
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
  replace(snapshots, stamp, keep = () => false) {
    this.rebase();
    const retained = new Set();
    for (const snapshot of snapshots) {
      this.snapshots = this.snapshots.filter(
        (previous) =>
          compare(previous.start, snapshot.start) < 0 || compare(previous.end, snapshot.end) > 0,
      );
      const replacement = { ...snapshot, sequence: this.sequence, stamp };
      this.snapshots.push(replacement);
      retained.add(replacement);
    }
    let events = this.snapshots.reduce((sum, snapshot) => sum + snapshot.events.length, 0);
    // The event allowance evicts old windows, never part of the current view.
    // A dense but bounded batch must not silently lose its highlighting.
    while (this.snapshots.length > this.maxSnapshots || events > this.maxEvents) {
      const index = this.snapshots.findIndex(
        (snapshot) => !retained.has(snapshot) && !keep(snapshot),
      );
      if (index < 0) break;
      events -= this.snapshots.splice(index, 1)[0].events.length;
    }
  }
  covers(start, end) {
    this.rebase();
    let position = start;
    for (const snapshot of [...this.snapshots].sort((a, b) => compare(a.start, b.start))) {
      if (compare(snapshot.start, position) > 0) break;
      if (compare(snapshot.end, position) > 0) position = snapshot.end;
      if (compare(position, end) >= 0) return true;
    }
    return false;
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
            snapshot = null;
          }
          if (!complete) {
            let total = cache.snapshots.reduce((count, item) => count + item.events.length, 0);
            while (total > cache.maxEvents && cache.snapshots.length > 1)
              total -= cache.snapshots.shift().events.length;
          }
        }
        const result = iterator.moveToSuccessor();
        cover();
        return result;
      },
    };
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
        const initial = [...snapshot.scopes];
        let index = 0;
        while (
          index < snapshot.events.length &&
          compare(snapshot.events[index].position, position) < 0
        )
          applyScopes(initial, snapshot.events[index++]);
        transition(position, initial);
        while (
          index < snapshot.events.length &&
          compare(snapshot.events[index].position, limit) < 0
        ) {
          const event = snapshot.events[index++];
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
