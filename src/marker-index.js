// Interval treap with lazy suffix translation. An edit visits intersecting
// markers; markers strictly after it move through one subtree tag rather than
// one callback or allocation per marker. Coordinates are UTF-16 row/columns.
const compare = (a, b) => a.row - b.row || a.column - b.column;
const copy = (p) => ({ row: p.row, column: p.column });
const traverse = (a, b) => ({ row: a.row + b.row, column: b.row ? b.column : a.column + b.column });
const distance = (a, b) => ({
  row: a.row - b.row,
  column: a.row === b.row ? a.column - b.column : a.column,
});
const zero = (p) => p.row === 0 && p.column === 0;
const minimum = (a, b) => (compare(a, b) <= 0 ? a : b);
const maximum = (a, b) => (compare(a, b) >= 0 ? a : b);
const keyCompare = (a, b) => compare(a.start, b.start) || a.id - b.id;

function validate(point, query = false) {
  for (const value of [point?.row, point?.column]) {
    if (!(Number.isSafeInteger(value) && value >= 0) && !(query && value === Infinity))
      throw new RangeError("Marker coordinates must be nonnegative safe integers");
  }
}

function queryPoint(point) {
  if (
    typeof point?.row !== "number" ||
    typeof point?.column !== "number" ||
    Number.isNaN(point.row) ||
    Number.isNaN(point.column)
  )
    throw new RangeError("Invalid marker query position");
  // Read-only probes may step before the beginning of a line. Storage remains
  // strict; queries use the same lower-bound clipping as editor positions.
  return { row: Math.max(0, Math.trunc(point.row)), column: Math.max(0, Math.trunc(point.column)) };
}

function update(node) {
  node.minStart = node.left?.minStart ?? node.start;
  node.maxStart = node.right?.maxStart ?? node.start;
  node.minEnd = minimum(
    node.end,
    minimum(node.left?.minEnd ?? node.end, node.right?.minEnd ?? node.end),
  );
  node.maxEnd = maximum(
    node.end,
    maximum(node.left?.maxEnd ?? node.end, node.right?.maxEnd ?? node.end),
  );
  if (node.left) node.left.parent = node;
  if (node.right) node.right.parent = node;
  return node;
}

function translate(node, rows, columns) {
  if (!node || (rows === 0 && columns === 0)) return;
  const base = node.minStart.row;
  const shift = (p) => ({ row: p.row + rows, column: p.column + (p.row === base ? columns : 0) });
  node.start = shift(node.start);
  node.end = shift(node.end);
  node.minStart = shift(node.minStart);
  node.maxStart = shift(node.maxStart);
  node.minEnd = shift(node.minEnd);
  node.maxEnd = shift(node.maxEnd);
  node.lazyRows += rows;
  node.lazyColumns += columns;
}

function push(node) {
  if (!node || (!node.lazyRows && !node.lazyColumns)) return;
  const base = node.minStart.row - node.lazyRows;
  for (const child of [node.left, node.right]) {
    if (child) translate(child, node.lazyRows, child.minStart.row === base ? node.lazyColumns : 0);
  }
  node.lazyRows = node.lazyColumns = 0;
}

function merge(left, right) {
  if (!left) {
    if (right) right.parent = null;
    return right;
  }
  if (!right) {
    left.parent = null;
    return left;
  }
  if (left.priority < right.priority) {
    push(left);
    left.right = merge(left.right, right);
    left.parent = null;
    return update(left);
  }
  push(right);
  right.left = merge(left, right.left);
  right.parent = null;
  return update(right);
}

function split(node, accepts) {
  if (!node) return [null, null];
  push(node);
  if (accepts(node)) {
    const [left, right] = split(node.right, accepts);
    node.right = left;
    node.parent = null;
    return [update(node), right];
  }
  const [left, right] = split(node.left, accepts);
  node.left = right;
  node.parent = null;
  return [left, update(node)];
}

function insert(root, node) {
  if (!root) return node;
  push(root);
  if (node.priority < root.priority) {
    [node.left, node.right] = split(root, (other) => keyCompare(other, node) < 0);
    return update(node);
  }
  if (keyCompare(node, root) < 0) root.left = insert(root.left, node);
  else root.right = insert(root.right, node);
  return update(root);
}

function remove(root, target) {
  if (!root) return null;
  push(root);
  if (root === target) return merge(root.left, root.right);
  if (keyCompare(target, root) < 0) root.left = remove(root.left, target);
  else root.right = remove(root.right, target);
  return update(root);
}

function visit(node, callback) {
  if (!node) return;
  push(node);
  visit(node.left, callback);
  callback(node);
  visit(node.right, callback);
}

function query(node, prune, matches, output) {
  if (!node || prune(node)) return;
  push(node);
  query(node.left, prune, matches, output);
  if (matches(node)) output.push(node);
  query(node.right, prune, matches, output);
}

function intersections(node, start, end) {
  const output = [];
  query(
    node,
    (n) => compare(n.maxEnd, start) < 0 || compare(n.minStart, end) > 0,
    (n) => compare(n.start, end) <= 0 && compare(n.end, start) >= 0,
    output,
  );
  return output;
}

function spliceMarker(marker, start, oldEnd, newEnd, insertion) {
  const a = marker.start,
    b = marker.end;
  const empty = compare(a, b) === 0;
  const begins = compare(start, a),
    ends = compare(oldEnd, b);
  const startsInside = marker.exclusive
    ? (begins < 0 || (!empty && begins === 0)) && compare(oldEnd, a) > 0
    : begins < 0 && compare(a, oldEnd) < 0;
  const endsInside = marker.exclusive
    ? compare(start, b) < 0 && (ends > 0 || (!empty && ends === 0))
    : compare(start, b) < 0 && compare(b, oldEnd) < 0;
  const inside =
    (compare(start, b) < 0 && compare(oldEnd, a) > 0) ||
    (!marker.exclusive && (!empty || insertion) && (begins === 0 || ends === 0));
  const flags =
    1 |
    (inside ? 2 : 0) |
    (startsInside || endsInside ? 4 : 0) |
    (startsInside && endsInside ? 8 : 0);
  const moveStart = begins < 0 || (marker.exclusive && (!empty || insertion) && begins === 0);
  const moveEnd = moveStart || compare(start, b) < 0 || (!marker.exclusive && ends === 0);
  const move = (point) =>
    compare(point, oldEnd) >= 0 ? traverse(newEnd, distance(point, oldEnd)) : copy(newEnd);
  if (moveStart) marker.start = move(a);
  if (moveEnd) marker.end = move(b);
  return flags;
}

class MarkerIndex {
  #root = null;
  #nodes = new Map();
  #seed;
  #readGeneration = 0;

  constructor(seed = 1) {
    this.#seed = seed >>> 0 || 1;
  }

  #priority() {
    let x = this.#seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (this.#seed = x >>> 0);
  }

  #node(id) {
    const node = this.#nodes.get(id);
    if (!node) throw new RangeError(`Unknown marker ${id}`);
    const ancestors = [];
    // A resolved ancestor has already passed every pending suffix shift to
    // this path. Distinct reads share that work until coordinates change.
    for (
      let current = node;
      current && current.readGeneration !== this.#readGeneration;
      current = current.parent
    )
      ancestors.push(current);
    for (let index = ancestors.length - 1; index >= 0; index--) {
      const ancestor = ancestors[index];
      push(ancestor);
      ancestor.readGeneration = this.#readGeneration;
    }
    return node;
  }

  #invalidateReadGeneration() {
    if (this.#readGeneration === Number.MAX_SAFE_INTEGER) {
      for (const node of this.#nodes.values()) node.readGeneration = -1;
      this.#readGeneration = 0;
    } else {
      this.#readGeneration++;
    }
  }

  insert(id, start, end) {
    if (!Number.isSafeInteger(id) || id < 0 || id > 0xffffffff)
      throw new RangeError("Invalid marker id");
    if (this.#nodes.has(id)) throw new Error(`Duplicate marker ${id}`);
    validate(start);
    validate(end);
    if (compare(start, end) > 0) throw new RangeError("Marker end precedes start");
    this.#invalidateReadGeneration();
    const node = update({
      id,
      start: copy(start),
      end: copy(end),
      exclusive: false,
      priority: this.#priority(),
      left: null,
      right: null,
      parent: null,
      lazyRows: 0,
      lazyColumns: 0,
      readGeneration: -1,
    });
    this.#nodes.set(id, node);
    this.#root = insert(this.#root, node);
    this.#root.parent = null;
  }

  remove(id) {
    if (!this.#nodes.has(id)) return;
    this.#invalidateReadGeneration();
    const node = this.#node(id);
    this.#root = remove(this.#root, node);
    if (this.#root) this.#root.parent = null;
    this.#nodes.delete(id);
  }

  has(id) {
    return this.#nodes.has(id);
  }
  setExclusive(id, exclusive) {
    this.#node(id).exclusive = Boolean(exclusive);
  }
  getStart(id) {
    return copy(this.#node(id).start);
  }
  getEnd(id) {
    return copy(this.#node(id).end);
  }
  getRange(id) {
    const node = this.#node(id);
    return { start: copy(node.start), end: copy(node.end) };
  }
  compare(a, b) {
    const first = this.#node(a),
      second = this.#node(b);
    return Math.sign(compare(first.start, second.start) || compare(second.end, first.end));
  }

  getRanges(ids) {
    const result = new Float64Array(ids.length * 4);
    const bulk = ids.length * 2 >= this.#nodes.size;
    if (bulk) visit(this.#root, () => {});
    for (let index = 0; index < ids.length; index++) {
      const node = bulk ? this.#nodes.get(ids[index]) : this.#node(ids[index]);
      if (!node) throw new RangeError(`Unknown marker ${ids[index]}`);
      result.set([node.start.row, node.start.column, node.end.row, node.end.column], index * 4);
    }
    return result;
  }

  dump() {
    const result = {};
    visit(this.#root, (node) => {
      result[node.id] = { start: copy(node.start), end: copy(node.end) };
    });
    return result;
  }

  #find(start, end, kind) {
    start = queryPoint(start);
    end = queryPoint(end);
    validate(start, true);
    validate(end, true);
    const result = [];
    const before = (a, b) => compare(a, b) < 0;
    const within = (p) => !before(p, start) && !before(end, p);
    query(
      this.#root,
      (n) => {
        if (kind === "start") return before(n.maxStart, start) || before(end, n.minStart);
        if (kind === "end") return before(n.maxEnd, start) || before(end, n.minEnd);
        return before(n.maxEnd, start) || before(end, n.minStart);
      },
      (n) => {
        if (kind === "start") return within(n.start);
        if (kind === "end") return within(n.end);
        if (kind === "contains") return !before(start, n.start) && !before(n.end, end);
        if (kind === "contained") return within(n.start) && within(n.end);
        return !before(end, n.start) && !before(n.end, start);
      },
      result,
    );
    return new Set(result.map((node) => node.id).sort((a, b) => a - b));
  }

  findIntersecting(start, end) {
    return this.#find(start, end, "intersects");
  }
  findContaining(start, end = start) {
    return this.#find(start, end, "contains");
  }
  findContainedIn(start, end) {
    return this.#find(start, end, "contained");
  }
  findStartingIn(start, end) {
    return this.#find(start, end, "start");
  }

  // Internal locality probe. Unordered ids avoid sorting an implementation
  // detail; null asks the caller to scan its own map when the result is dense.
  findStartingInLimited(start, end, limit) {
    start = queryPoint(start);
    end = queryPoint(end);
    validate(start, true);
    validate(end, true);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid result limit");
    if (
      this.#root &&
      this.#nodes.size > limit &&
      compare(this.#root.minStart, start) >= 0 &&
      compare(this.#root.maxStart, end) <= 0
    )
      return null;
    const ids = [];
    const visit = (node) => {
      if (!node || compare(node.maxStart, start) < 0 || compare(node.minStart, end) > 0)
        return true;
      push(node);
      if (!visit(node.left)) return false;
      if (compare(node.start, start) >= 0 && compare(node.start, end) <= 0) {
        if (ids.length === limit) return false;
        ids.push(node.id);
      }
      return visit(node.right);
    };
    return visit(this.#root) ? ids : null;
  }
  findEndingIn(start, end) {
    return this.#find(start, end, "end");
  }
  findStartingAt(point) {
    return this.findStartingIn(point, point);
  }
  findEndingAt(point) {
    return this.findEndingIn(point, point);
  }

  findBoundariesAfter(start, maxCount) {
    start = queryPoint(start);
    const nodes = intersections(this.#root, start, { row: Infinity, column: Infinity });
    const containingStart = nodes
      .filter((node) => compare(node.start, start) < 0 && compare(node.end, start) >= 0)
      .sort((a, b) => compare(a.start, b.start) || compare(b.end, a.end) || a.id - b.id)
      .map((node) => node.id);
    const points = new Map();
    for (const node of nodes) {
      for (const [position, side] of [
        [node.start, "starting"],
        [node.end, "ending"],
      ]) {
        if (compare(position, start) < 0) continue;
        const key = `${position.row}:${position.column}`;
        let boundary = points.get(key);
        if (!boundary) {
          boundary = { position: copy(position), starting: new Set(), ending: new Set() };
          points.set(key, boundary);
        }
        boundary[side].add(node.id);
      }
    }
    const boundaries = [...points.values()]
      .sort((a, b) => compare(a.position, b.position))
      .slice(0, maxCount);
    for (const boundary of boundaries) {
      boundary.starting = new Set([...boundary.starting].sort((a, b) => a - b));
      boundary.ending = new Set([...boundary.ending].sort((a, b) => a - b));
    }
    return { containingStart, boundaries };
  }

  #applySplice(start, oldExtent, newExtent) {
    validate(start);
    validate(oldExtent);
    validate(newExtent);
    if (zero(oldExtent) && zero(newExtent)) return null;
    // Null flags can still mean that an untouched suffix moved lazily.
    this.#invalidateReadGeneration();
    const oldEnd = traverse(start, oldExtent),
      newEnd = traverse(start, newExtent);
    const [before, after] = split(this.#root, (node) => compare(node.start, oldEnd) <= 0);
    const touched = intersections(before, start, oldEnd);
    let updated = before;
    // Detach first, while every search key still describes the old state.
    for (const node of touched) updated = remove(updated, node);
    const flags = [];
    for (const node of touched) {
      node.left = node.right = node.parent = null;
      node.lazyRows = node.lazyColumns = 0;
      flags.push([node.id, spliceMarker(node, start, oldEnd, newEnd, zero(oldExtent))]);
      updated = insert(updated, update(node));
    }
    if (after)
      translate(
        after,
        newEnd.row - oldEnd.row,
        after.minStart.row === oldEnd.row ? newEnd.column - oldEnd.column : 0,
      );
    this.#root = merge(updated, after);
    if (!flags.length) return null;
    flags.sort((a, b) => a[0] - b[0]);
    return Uint32Array.from(flags.flat());
  }

  splice(start, oldExtent, newExtent) {
    const result = { touch: new Set(), inside: new Set(), overlap: new Set(), surround: new Set() };
    const values = this.#applySplice(start, oldExtent, newExtent);
    const names = Object.keys(result);
    for (let index = 0; values && index < values.length; index += 2)
      for (let bit = 0; bit < names.length; bit++)
        if (values[index + 1] & (1 << bit)) result[names[bit]].add(values[index]);
    return result;
  }

  splicePacked(start, oldExtent, newExtent) {
    return this.#applySplice(start, oldExtent, newExtent);
  }
}

module.exports = MarkerIndex;
