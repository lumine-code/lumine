const Point = require("./point");

const compare = (a, b) => a.row - b.row || a.column - b.column;
const copy = (p) => (Array.isArray(p) ? new Point(p[0], p[1]) : new Point(p.row, p.column));
const eventBytes = (event) => 128 + (event.open.length + event.close.length) * 8;
const snapshotBytes = (snapshot) =>
  192 +
  snapshot.scopes.length * 8 +
  snapshot.events.reduce((bytes, event) => bytes + eventBytes(event), 0);
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
  constructor({
    maxSnapshots = 16,
    maxEvents = 16000,
    maxEdits = 512,
    maxBytes = 8 * 1024 * 1024,
  } = {}) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0)
      throw new RangeError("maxBytes must be a non-negative finite number.");
    this.maxSnapshots = maxSnapshots;
    this.maxEvents = maxEvents;
    this.maxRecordEvents = Math.max(1, Math.floor(maxEvents / 2));
    this.maxEdits = maxEdits;
    this.maxBytes = maxBytes;
    this.maxCheckpointBytes = Math.floor(maxBytes / 4);
    this.clear();
  }
  clear() {
    this.snapshots = [];
    this.orderedSnapshots = null;
    this.scopeCheckpoints = new WeakMap();
    this.snapshotCosts = new WeakMap();
    this.protectedSnapshots = new WeakSet();
    this.snapshotBytes = 0;
    this.checkpointBytes = 0;
    this.editBytes = 0;
    this.eventCount = 0;
    this.edits = [];
    this.sequence = 0;
  }
  // Accounted JS payload, not measured heap usage. The estimate includes point,
  // event and array overhead, numeric scope slots, pending edits and optional
  // checkpoints. Shared scope IDs are numbers; no syntax tree is retained here.
  get estimatedBytes() {
    return this.snapshotBytes + this.checkpointBytes + this.editBytes;
  }
  getStats() {
    return {
      estimatedBytes: this.estimatedBytes,
      maxBytes: this.maxBytes,
      snapshots: this.snapshots.length,
      events: this.eventCount,
      checkpointBytes: this.checkpointBytes,
      editBytes: this.editBytes,
      overBudget: this.estimatedBytes > this.maxBytes,
    };
  }
  trackSnapshot(snapshot) {
    if (this.snapshotCosts.has(snapshot)) return;
    const cost = { bytes: snapshotBytes(snapshot), events: snapshot.events.length };
    this.snapshotCosts.set(snapshot, cost);
    this.snapshotBytes += cost.bytes;
    this.eventCount += cost.events;
  }
  adjustSnapshot(snapshot, bytes, events = 0) {
    const cost = this.snapshotCosts.get(snapshot);
    if (!cost) return;
    cost.bytes += bytes;
    cost.events += events;
    this.snapshotBytes += bytes;
    this.eventCount += events;
  }
  dropCheckpoints(snapshot) {
    const saved = this.scopeCheckpoints.get(snapshot);
    if (saved) this.checkpointBytes -= saved.bytes;
    this.scopeCheckpoints.delete(snapshot);
  }
  forgetSnapshot(snapshot) {
    const cost = this.snapshotCosts.get(snapshot);
    if (!cost) return;
    this.snapshotBytes -= cost.bytes;
    this.eventCount -= cost.events;
    this.snapshotCosts.delete(snapshot);
    this.dropCheckpoints(snapshot);
  }
  setSnapshots(snapshots) {
    const retained = new Set(snapshots);
    for (const snapshot of this.snapshots)
      if (!retained.has(snapshot)) this.forgetSnapshot(snapshot);
    for (const snapshot of snapshots) this.trackSnapshot(snapshot);
    this.snapshots = snapshots;
    this.orderedSnapshots = null;
  }
  evictColdSnapshots() {
    let evicted = false;
    while (
      this.snapshots.length > this.maxSnapshots ||
      this.eventCount > this.maxEvents ||
      this.estimatedBytes > this.maxBytes
    ) {
      const index = this.snapshots.findIndex((snapshot) => !this.protectedSnapshots.has(snapshot));
      if (index < 0) break;
      this.removeSnapshot(index);
      evicted = true;
    }
    return evicted;
  }
  edit({ oldRange, newRange, coordinateMap, skipPresentation }, { extendScopes } = {}) {
    if (skipPresentation) return;
    if (coordinateMap) {
      if (coordinateMap.maps) {
        for (const map of coordinateMap.maps) this.edit({ coordinateMap: map });
        return;
      }
      if (coordinateMap.transfers) {
        const snapshots = coordinateMap.transfers.flatMap(({ start, end, target }) =>
          this.captureRange(copy(start), copy(end), copy(target), []),
        );
        this.edit({ coordinateMap: coordinateMap.base });
        this.replace(snapshots, null, () => true);
        return;
      }
      this.rebase();
      this.sequence++;
      this.orderedSnapshots = null;
      for (const snapshot of this.snapshots) {
        this.materialize(snapshot);
        snapshot.start = copy(coordinateMap.mapPoint(snapshot.start));
        snapshot.end = copy(coordinateMap.mapPoint(snapshot.end, true));
        for (const event of snapshot.events)
          event.position = copy(coordinateMap.mapPoint(event.position));
        snapshot.sequence = this.sequence;
        this.dropCheckpoints(snapshot);
      }
      // Deleted fragments have no coverage. Keeping their collapsed events
      // would retain a new empty snapshot for every distinct source move.
      this.setSnapshots(
        this.snapshots.filter((snapshot) => compare(snapshot.start, snapshot.end) < 0),
      );
      return;
    }
    const edit = {
      sequence: ++this.sequence,
      start: copy(oldRange.start),
      oldEnd: copy(oldRange.end),
      newEnd: copy(newRange.end),
    };
    // An optional ordered stack describes retained presentation at an insertion
    // boundary. It does not infer syntax or change normal edit affinity.
    if (
      extendScopes?.length &&
      compare(edit.start, edit.oldEnd) === 0 &&
      edit.start.row === edit.newEnd.row &&
      edit.newEnd.column > edit.start.column &&
      (!newRange.start || compare(copy(newRange.start), edit.start) === 0)
    ) {
      edit.extendScopes = new Set(extendScopes);
      edit.extensionStack = [...extendScopes];
    }
    this.edits.push(edit);
    this.editBytes += 160 + (edit.extensionStack?.length ?? 0) * 48;
    if (this.edits.length >= this.maxEdits || this.estimatedBytes > this.maxBytes) this.rebase();
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
        // A following fragment may already contain the next token's scopes.
        // Keep only the retained prefix over the insertion and restore that
        // fragment's suffix with the other postponed boundary openings.
        const atStart = edit.extendScopes && compare(snapshot.start, edit.start) === 0;
        const sharesPrefix =
          atStart && edit.extensionStack.every((id, index) => snapshot.scopes[index] === id);
        const moveStart = atStart && !sharesPrefix;
        if (sharesPrefix && snapshot.scopes.length > edit.extensionStack.length) {
          const event = {
            position: copy(edit.start),
            close: [],
            open: snapshot.scopes.slice(edit.extensionStack.length),
          };
          snapshot.events.unshift(event);
          this.adjustSnapshot(
            snapshot,
            eventBytes(event) + (edit.extensionStack.length - snapshot.scopes.length) * 8,
            1,
          );
          snapshot.scopes = [...edit.extensionStack];
          this.dropCheckpoints(snapshot);
        }
        snapshot.start = shift(snapshot.start, edit, moveStart);
        snapshot.end = shift(snapshot.end, edit, true);
        let low = 0,
          high = snapshot.events.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compare(snapshot.events[middle].position, edit.start) < 0) low = middle + 1;
          else high = middle;
        }
        if (edit.extendScopes) low = this.extendBoundary(snapshot, low, edit);
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
    this.editBytes = 0;
    this.evictColdSnapshots();
  }
  extendBoundary(snapshot, start, edit) {
    if (compare(snapshot.start, edit.start) > 0) return start;
    let end = start;
    while (end < snapshot.events.length && compare(snapshot.events[end].position, edit.start) === 0)
      end++;
    if (end === start) {
      // A fragment can end without an explicit closing event. Do not extend
      // incidental inner scopes (such as TODO) beyond the selected context.
      const { scopes } = this.scopesBefore(snapshot, edit.start);
      if (!edit.extensionStack.every((id, index) => scopes[index] === id)) return start;
      const suffix = scopes.slice(edit.extensionStack.length);
      if (!suffix.length) return start;
      const inserted = [
        { position: copy(edit.start), close: [...suffix].reverse(), open: [] },
        { position: copy(edit.newEnd), close: [], open: suffix },
      ];
      snapshot.events.splice(start, 0, ...inserted);
      this.adjustSnapshot(
        snapshot,
        inserted.reduce((bytes, event) => bytes + eventBytes(event), 0),
        2,
      );
      this.dropCheckpoints(snapshot);
      return start + 2;
    }
    const left = [],
      right = [],
      opened = new Map();
    let removedBytes = 0;
    for (let index = start; index < end; index++) {
      const event = snapshot.events[index],
        closeLeft = [],
        closeRight = [];
      removedBytes += eventBytes(event);
      for (const id of event.close) {
        const count = opened.get(id) || 0;
        // An empty scope opened and closed at the same boundary must move as
        // one unit, otherwise its delayed opening would leak into later text.
        if (edit.extendScopes.has(id) || count) closeRight.push(id);
        else closeLeft.push(id);
        if (count) opened.set(id, count - 1);
      }
      for (const id of event.open) opened.set(id, (opened.get(id) || 0) + 1);
      if (closeLeft.length) left.push({ position: copy(edit.start), close: closeLeft, open: [] });
      if (closeRight.length || event.open.length)
        right.push({ position: copy(edit.newEnd), close: closeRight, open: [...event.open] });
    }
    snapshot.events.splice(start, end - start, ...left, ...right);
    this.adjustSnapshot(
      snapshot,
      [...left, ...right].reduce((bytes, event) => bytes + eventBytes(event), 0) - removedBytes,
      left.length + right.length - (end - start),
    );
    // Splitting/reordering boundaries changes scope prefixes even when the
    // number of events happens to remain identical.
    this.dropCheckpoints(snapshot);
    return start + left.length + right.length;
  }
  materialize(snapshot) {
    if (!snapshot.rowOffset) return;
    snapshot.events = snapshot.events.map((event) => ({
      ...event,
      position: new Point(event.position.row + snapshot.rowOffset, event.position.column),
    }));
    snapshot.rowOffset = 0;
  }
  copyRange(start, end, target, fallback, keep) {
    const snapshots = this.captureRange(start, end, target, fallback);
    if (!snapshots.length) return false;
    this.replace(snapshots, null, keep);
    return true;
  }
  captureRange(start, end, target, fallback) {
    if (compare(start, end) >= 0) return [];
    // Folded/offscreen source text may only be partially cached. Copy its
    // prepared fragments without claiming coverage for the gaps between them.
    const ranges = [];
    for (const snapshot of this.getOrderedSnapshots()) {
      const first = compare(snapshot.start, start) > 0 ? snapshot.start : start;
      const last = compare(snapshot.end, end) < 0 ? snapshot.end : end;
      if (compare(first, last) >= 0) continue;
      const previous = ranges.at(-1);
      if (previous && compare(first, previous[1]) <= 0) {
        if (compare(last, previous[1]) > 0) previous[1] = last;
      } else ranges.push([first, last]);
    }
    if (!ranges.length) return [];
    const translate = (position) => target.traverse(position.traversalFrom(start));
    const snapshots = ranges.map(([first, last]) => {
      const { scopes, iterator } = this.read(first, last, fallback);
      const events = [];
      while (compare(iterator.getPosition(), last) < 0) {
        events.push({
          position: translate(iterator.getPosition()),
          open: [...iterator.getOpenScopeIds()],
          close: [...iterator.getCloseScopeIds()],
        });
        iterator.moveToSuccessor();
      }
      return { start: translate(first), end: translate(last), scopes, events };
    });
    // This is retained paint, never evidence of current syntax. A worker
    // result must replace it even when the copied text has not changed.
    return snapshots;
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
      this.setSnapshots(remaining);
      const replacement = { ...snapshot, sequence: this.sequence, stamp };
      this.snapshots.push(replacement);
      this.trackSnapshot(replacement);
      retained.add(replacement);
    }
    // Retention allowances evict old windows, never the protected current view
    // or the newly delivered batch. If those alone exceed maxBytes, report the
    // excess rather than lose coverage and request the same tile indefinitely.
    this.protectedSnapshots = new WeakSet();
    for (const snapshot of this.snapshots)
      if (retained.has(snapshot) || keep(snapshot)) this.protectedSnapshots.add(snapshot);
    return this.evictColdSnapshots();
  }
  removeSnapshot(index) {
    this.orderedSnapshots = null;
    const snapshot = this.snapshots.splice(index, 1)[0];
    if (snapshot) this.forgetSnapshot(snapshot);
    return snapshot;
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
          quality: iterator.quality ?? (iterator.limitedReason ? "limited" : "exact"),
          reason: iterator.limitedReason ?? iterator.reason ?? null,
        };
        cache.snapshots.push(snapshot);
        cache.trackSnapshot(snapshot);
        if (complete) cache.protectedSnapshots.add(snapshot);
        else cache.protectedSnapshots = new WeakSet([snapshot]);
        cache.orderedSnapshots = null;
        if (!complete)
          while (
            cache.snapshots.length > 1 &&
            (cache.snapshots.length > cache.maxSnapshots || cache.estimatedBytes > cache.maxBytes)
          )
            cache.removeSnapshot(0);
        if (!complete && cache.snapshotCosts.get(snapshot).bytes > cache.maxBytes) {
          cache.removeSnapshot(cache.snapshots.indexOf(snapshot));
          snapshot = null;
        }
        cover();
        return scopes;
      },
      getPosition: () => iterator.getPosition(),
      get quality() {
        return (
          snapshot?.quality ?? iterator.quality ?? (iterator.limitedReason ? "limited" : "exact")
        );
      },
      get limitedReason() {
        return snapshot?.reason ?? iterator.limitedReason ?? null;
      },
      getOpenScopeIds: () => iterator.getOpenScopeIds(),
      getCloseScopeIds: () => iterator.getCloseScopeIds(),
      moveToSuccessor() {
        if (snapshot && !cache.snapshotCosts.has(snapshot)) snapshot = null;
        if (snapshot && compare(iterator.getPosition(), limit) <= 0) {
          const event = {
            position: copy(iterator.getPosition()),
            open: [...iterator.getOpenScopeIds()],
            close: [...iterator.getCloseScopeIds()],
          };
          snapshot.events.push(event);
          cache.adjustSnapshot(snapshot, eventBytes(event), 1);
          if (
            !complete &&
            (snapshot.events.length > cache.maxRecordEvents ||
              cache.snapshotCosts.get(snapshot)?.bytes > cache.maxBytes)
          ) {
            cache.removeSnapshot(cache.snapshots.indexOf(snapshot));
            snapshot = null;
          }
          if (!complete) {
            while (
              (cache.eventCount > cache.maxEvents || cache.estimatedBytes > cache.maxBytes) &&
              cache.snapshots.length > 1
            )
              cache.removeSnapshot(0);
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
      this.dropCheckpoints(snapshot);
      // The base stack is already owned/accounted by the snapshot. Later
      // checkpoints own copies, including a rolling tail when dense prefixes
      // have reached their allowance.
      const cached =
        this.checkpointBytes + 64 <= this.maxCheckpointBytes &&
        this.estimatedBytes + 64 <= this.maxBytes;
      saved = { count: events.length, scopes: [snapshot.scopes], bytes: 64, tail: null, cached };
      if (cached) {
        this.checkpointBytes += saved.bytes;
        this.scopeCheckpoints.set(snapshot, saved);
      }
    }
    const checkpoint = Math.floor(low / 64);
    let first = Math.min(checkpoint, saved.scopes.length - 1);
    let scopes = saved.scopes[first];
    if (saved.tail && saved.tail.index <= checkpoint && saved.tail.index > first) {
      first = saved.tail.index;
      scopes = saved.tail.scopes;
    }
    scopes = [...scopes];
    for (let i = first * 64; i < checkpoint * 64; i++) {
      applyScopes(scopes, events[i]);
      if ((i + 1) % 64 === 0 && saved.scopes.length === (i + 1) / 64) {
        const bytes = 32 + scopes.length * 8;
        if (
          saved.cached &&
          this.checkpointBytes + bytes <= this.maxCheckpointBytes / 2 &&
          this.estimatedBytes + bytes <= this.maxBytes
        ) {
          saved.scopes.push([...scopes]);
          saved.bytes += bytes;
          this.checkpointBytes += bytes;
        }
      }
    }
    if (checkpoint >= saved.scopes.length) {
      const bytes = 48 + scopes.length * 8;
      const delta = bytes - (saved.tail?.bytes ?? 0);
      if (
        saved.cached &&
        this.checkpointBytes + delta <= this.maxCheckpointBytes &&
        this.estimatedBytes + delta <= this.maxBytes
      ) {
        saved.tail = { index: checkpoint, scopes: [...scopes], bytes };
        saved.bytes += delta;
        this.checkpointBytes += delta;
      }
    }
    for (let i = checkpoint * 64; i < low; i++) applyScopes(scopes, events[i]);
    return { scopes, index: low };
  }

  insertionScopes(position, fallback = []) {
    position = copy(position);
    let context;
    let crossesFragments = false;
    if (position.column === 0) {
      this.rebase();
      // The selected tile already records scopes preceding its first event.
      // This also works for a cold tile starting inside a multiline string;
      // borrowing the previous row instead could extend a finished comment.
      const snapshot = this.snapshots.findLast(
        (item) => compare(item.start, position) <= 0 && compare(position, item.end) < 0,
      );
      if (!snapshot) return { left: [...fallback], continuous: [...fallback] };
      const { scopes } = this.scopesBefore(snapshot, position);
      context = this.read(position, position.translate([0, 1]), scopes);
    } else {
      const previous = position.translate([0, -1]);
      if (!this.covers(previous, position)) return null;
      const covering = (point) =>
        this.snapshots.findLast(
          (item) => compare(item.start, point) <= 0 && compare(point, item.end) < 0,
        );
      crossesFragments = covering(previous) !== covering(position);
      context = this.read(previous, position.translate([0, 1]), fallback);
    }
    const { scopes, iterator } = context;
    while (compare(iterator.getPosition(), position) < 0) {
      applyScopes(scopes, {
        close: iterator.getCloseScopeIds(),
        open: iterator.getOpenScopeIds(),
      });
      if (!iterator.moveToSuccessor()) break;
    }
    const left = [...scopes];
    let continuousLength = left.length;
    if (crossesFragments) {
      // read() merges equal scope IDs at tile boundaries. Equal names cannot
      // prove that adjacent tiles describe the same occurrence: a close/open
      // may have been clipped from the first tile's exclusive end boundary.
      continuousLength = 0;
      while (
        continuousLength < left.length &&
        continuousLength < fallback.length &&
        left[continuousLength] === fallback[continuousLength]
      )
        continuousLength++;
    }
    while (compare(iterator.getPosition(), position) === 0) {
      for (const id of iterator.getCloseScopeIds()) {
        const index = scopes.lastIndexOf(id);
        if (index !== -1) {
          continuousLength = Math.min(continuousLength, index);
          scopes.splice(index, 1);
        }
      }
      // A newly opened occurrence never restores continuity, even if it has
      // the same scope ID as the occurrence just closed at this boundary.
      scopes.push(...iterator.getOpenScopeIds());
      if (!iterator.moveToSuccessor()) break;
    }
    return { left, continuous: left.slice(0, continuousLength) };
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
