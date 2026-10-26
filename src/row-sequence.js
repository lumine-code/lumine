// Persistent, height-balanced rope of bounded row blocks. Empty runs have a
// count but no backing array. Splicing rows never moves the unchanged suffix;
// copies share immutable nodes until the next mutation.
const BLOCK_SIZE = 256;

class RowSequence {
  constructor(values = 0) {
    this.root = typeof values === "number" ? empty(values) : fromValues(values);
    this.resolve = null;
  }

  get length() {
    return size(this.root);
  }

  set length(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid row count");
    if (length < this.length) this.root = split(this.root, length)[0];
    else if (length > this.length) this.root = join(this.root, empty(length - this.length));
  }

  get(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    let node = this.root;
    let offset = index;
    while (node.left) {
      if (offset < node.left.count) node = node.left;
      else {
        offset -= node.left.count;
        node = node.right;
      }
    }
    const value = node.values?.[offset];
    return value === undefined && this.resolve ? this.resolve(index) : value;
  }

  set(index, value) {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("Invalid row index");
    if (index >= this.length) this.length = index + 1;
    this.spliceRows(index, 1, [value]);
  }

  spliceRows(start, removedCount, inserted = 0) {
    start = Math.max(0, Math.min(this.length, start));
    removedCount = Math.max(0, Math.min(this.length - start, removedCount));
    const [before, rest] = split(this.root, start);
    const after = split(rest, removedCount)[1];
    const middle = typeof inserted === "number" ? empty(inserted) : fromValues(inserted);
    this.root = join(join(before, middle), after);
  }

  copy() {
    const copy = new RowSequence();
    copy.root = this.root;
    return copy;
  }

  at(index) {
    return this.get(index < 0 ? this.length + index : index);
  }

  slice(start = 0, end = this.length) {
    if (start < 0) start = Math.max(0, this.length + start);
    if (end < 0) end = Math.max(0, this.length + end);
    end = Math.min(this.length, end);
    const result = [];
    for (let index = start; index < end; index++) result.push(this.get(index));
    return result;
  }

  // Only known numeric values contribute. Unknown widths remain unknown until
  // a caller explicitly measures them; viewport width queries stay bounded.
  get maximum() {
    return this.root?.maximum ?? 0;
  }

  get maximumIndex() {
    let node = this.root;
    let offset = 0;
    if (!node || node.maximum <= 0) return 0;
    const maximum = node.maximum;
    while (node.left) {
      if (node.left.maximum === maximum) node = node.left;
      else {
        offset += node.left.count;
        node = node.right;
      }
    }
    return offset + node.values.indexOf(maximum);
  }

  get storedCount() {
    return this.root?.storedCount ?? 0;
  }
}

function size(node) {
  return node?.count ?? 0;
}
function height(node) {
  return node?.height ?? 0;
}
function empty(count) {
  return count > 0 ? { count, height: 1, maximum: 0, storedCount: 0, values: null } : null;
}
function leaf(values) {
  if (values.length === 0) return null;
  let maximum = 0;
  let storedCount = 0;
  for (const value of values) {
    if (value !== undefined) storedCount++;
    if (typeof value === "number" && value > maximum) maximum = value;
  }
  return { count: values.length, height: 1, maximum, storedCount, values };
}
function branch(left, right) {
  if (!left) return right;
  if (!right) return left;
  return {
    left,
    right,
    count: left.count + right.count,
    height: Math.max(left.height, right.height) + 1,
    maximum: Math.max(left.maximum, right.maximum),
    storedCount: left.storedCount + right.storedCount,
  };
}
function balance(left, right) {
  if (height(left) > height(right) + 1) {
    if (height(left.left) >= height(left.right)) {
      return branch(left.left, branch(left.right, right));
    }
    return branch(branch(left.left, left.right.left), branch(left.right.right, right));
  }
  if (height(right) > height(left) + 1) {
    if (height(right.right) >= height(right.left)) {
      return branch(branch(left, right.left), right.right);
    }
    return branch(branch(left, right.left.left), branch(right.left.right, right.right));
  }
  return branch(left, right);
}
function join(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (!left.left && !right.left) {
    if (!left.values && !right.values) return empty(left.count + right.count);
    if (left.count + right.count <= BLOCK_SIZE) {
      return leaf([
        ...(left.values ?? new Array(left.count)),
        ...(right.values ?? new Array(right.count)),
      ]);
    }
  }
  if (height(left) > height(right) + 1) return balance(left.left, join(left.right, right));
  if (height(right) > height(left) + 1) return balance(join(left, right.left), right.right);
  return branch(left, right);
}
function split(node, index) {
  if (!node || index <= 0) return [null, node];
  if (index >= node.count) return [node, null];
  if (!node.left) {
    return node.values
      ? [leaf(node.values.slice(0, index)), leaf(node.values.slice(index))]
      : [empty(index), empty(node.count - index)];
  }
  if (index < node.left.count) {
    const [before, after] = split(node.left, index);
    return [before, join(after, node.right)];
  }
  const [before, after] = split(node.right, index - node.left.count);
  return [join(node.left, before), after];
}
function fromValues(values, start = 0, end = values.length) {
  if (end - start <= BLOCK_SIZE) {
    const chunk = values.slice(start, end);
    return leaf(Array.isArray(chunk) ? chunk : Array.from(chunk));
  }
  const middle =
    start + Math.max(BLOCK_SIZE, Math.floor((end - start) / (2 * BLOCK_SIZE)) * BLOCK_SIZE);
  return branch(fromValues(values, start, middle), fromValues(values, middle, end));
}

module.exports = RowSequence;
