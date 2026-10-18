// Persistent ordered sequence of geometry changes. Both coordinate spaces are
// monotone. Suffix translations are lazy, so an edit near the start of a fully
// indexed document does not rewrite every following wrap/fold change.
const pointShift = (point, base, rows, columns) => ({
  row: point.row + rows,
  column: point.column + (point.row === base ? columns : 0),
});
const count = (node) => node?.count ?? 0;
const height = (node) => node?.height ?? 0;
const leaf = (value) => ({
  value,
  first: value,
  last: value,
  count: 1,
  height: 1,
  oldRows: 0,
  oldColumns: 0,
  newRows: 0,
  newColumns: 0,
});
function branch(left, right) {
  if (!left) return right;
  if (!right) return left;
  return {
    left,
    right,
    first: left.first,
    last: right.last,
    count: left.count + right.count,
    height: 1 + Math.max(left.height, right.height),
    oldRows: 0,
    oldColumns: 0,
    newRows: 0,
    newColumns: 0,
  };
}
function shifted(node, oldRows, oldColumns, newRows, newColumns) {
  if (!node || (!oldRows && !oldColumns && !newRows && !newColumns)) return node;
  const oldBase = node.first.oldStart.row,
    newBase = node.first.newStart.row;
  const move = (h) => ({
    ...h,
    oldStart: pointShift(h.oldStart, oldBase, oldRows, oldColumns),
    oldEnd: pointShift(h.oldEnd, oldBase, oldRows, oldColumns),
    newStart: pointShift(h.newStart, newBase, newRows, newColumns),
    newEnd: pointShift(h.newEnd, newBase, newRows, newColumns),
  });
  const result = {
    ...node,
    first: move(node.first),
    last: move(node.last),
    oldRows: node.oldRows + oldRows,
    oldColumns: node.oldColumns + oldColumns,
    newRows: node.newRows + newRows,
    newColumns: node.newColumns + newColumns,
  };
  if (node.value) result.value = result.first;
  return result;
}
function push(node) {
  if (!node?.left || (!node.oldRows && !node.oldColumns && !node.newRows && !node.newColumns))
    return;
  const oldBase = node.first.oldStart.row - node.oldRows,
    newBase = node.first.newStart.row - node.newRows;
  for (const key of ["left", "right"]) {
    const child = node[key];
    node[key] = shifted(
      child,
      node.oldRows,
      child.first.oldStart.row === oldBase ? node.oldColumns : 0,
      node.newRows,
      child.first.newStart.row === newBase ? node.newColumns : 0,
    );
  }
  // Resolving this cache preserves the node's logical value, including when
  // another immutable patch root shares it. Membership is never mutated here.
  node.oldRows = node.oldColumns = node.newRows = node.newColumns = 0;
}
function balance(left, right) {
  if (height(left) > height(right) + 1) {
    push(left);
    if (height(left.left) >= height(left.right))
      return branch(left.left, branch(left.right, right));
    push(left.right);
    return branch(branch(left.left, left.right.left), branch(left.right.right, right));
  }
  if (height(right) > height(left) + 1) {
    push(right);
    if (height(right.right) >= height(right.left))
      return branch(branch(left, right.left), right.right);
    push(right.left);
    return branch(branch(left, right.left.left), branch(right.left.right, right.right));
  }
  return branch(left, right);
}
function join(left, right) {
  if (!left || !right) return left ?? right;
  if (left.height > right.height + 1) {
    push(left);
    return balance(left.left, join(left.right, right));
  }
  if (right.height > left.height + 1) {
    push(right);
    return balance(join(left, right.left), right.right);
  }
  return branch(left, right);
}
function split(node, index) {
  if (!node) return [null, null];
  if (index <= 0) return [null, node];
  if (index >= node.count) return [node, null];
  push(node);
  if (index < node.left.count) {
    const [a, b] = split(node.left, index);
    return [a, join(b, node.right)];
  }
  const [a, b] = split(node.right, index - node.left.count);
  return [join(node.left, a), b];
}
function* walk(node, start = 0, end = count(node)) {
  if (!node || start >= end) return;
  if (node.value) {
    yield node.value;
    return;
  }
  push(node);
  if (start < node.left.count) yield* walk(node.left, start, Math.min(end, node.left.count));
  if (end > node.left.count)
    yield* walk(node.right, Math.max(0, start - node.left.count), end - node.left.count);
}
function build(values, start = 0, end = values.length) {
  if (start === end) return null;
  if (end - start === 1) return leaf(values[start]);
  const middle = Math.floor((start + end) / 2);
  return branch(build(values, start, middle), build(values, middle, end));
}

class ChangeTree {
  #root;
  constructor(values = []) {
    this.#root = build(values);
  }
  get length() {
    return count(this.#root);
  }
  copy() {
    const result = new ChangeTree();
    result.#root = this.#root;
    return result;
  }
  *[Symbol.iterator]() {
    yield* walk(this.#root);
  }
  at(index) {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let node = this.#root;
    while (!node.value) {
      push(node);
      if (index < node.left.count) node = node.left;
      else {
        index -= node.left.count;
        node = node.right;
      }
    }
    return node.value;
  }
  lowerBound(predicate) {
    let node = this.#root,
      offset = 0;
    if (!node) return 0;
    while (!node.value) {
      push(node);
      if (predicate(node.left.last)) node = node.left;
      else {
        offset += node.left.count;
        node = node.right;
      }
    }
    return offset + (predicate(node.value) ? 0 : 1);
  }
  slice(start = 0, end = this.length) {
    return Array.from(walk(this.#root, start, end));
  }
  map(callback) {
    return this.slice().map(callback);
  }
  splice(start, removed, ...inserted) {
    const [before, rest] = split(this.#root, start);
    const [, after] = split(rest, removed);
    this.#root = join(join(before, build(inserted)), after);
  }
  shiftSuffix(start, oldBefore, oldAfter, newBefore, newAfter) {
    const [before, after] = split(this.#root, start);
    const oldRows = oldBefore ? oldAfter.row - oldBefore.row : 0;
    const newRows = newBefore ? newAfter.row - newBefore.row : 0;
    const oldColumns =
      oldBefore && after?.first.oldStart.row === oldBefore.row
        ? oldAfter.column - oldBefore.column
        : 0;
    const newColumns =
      newBefore && after?.first.newStart.row === newBefore.row
        ? newAfter.column - newBefore.column
        : 0;
    this.#root = join(before, shifted(after, oldRows, oldColumns, newRows, newColumns));
  }
}

module.exports = ChangeTree;
