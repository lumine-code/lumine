// Persistent piece tree. Buffers and their LF indexes are shared by immutable
// pieces; edits copy only the balanced search paths. Coordinates count UTF-16
// units, including CR and unpaired surrogates. Only LF advances a row.
const BUFFER_UNITS = 32768;
const MERGE_UNITS = 1024;
const { MAX_STRING_LENGTH } = require("node:buffer").constants;
const snapshotIdentities = new WeakMap();
const mapperOwners = new WeakMap();

function snapshotIdentity(node) {
  if (!node) return null;
  let identity = snapshotIdentities.get(node);
  if (!identity) snapshotIdentities.set(node, (identity = Object.freeze({})));
  return identity;
}

function upperBound(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function bufferFor(text) {
  const starts = [];
  const crlfs = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
    if (text.charCodeAt(index - 1) === 13) crlfs.push(index + 1);
  }
  const astrals = [];
  const bareCRs = [];
  for (const match of text.matchAll(/\r(?!\n)/g)) bareCRs.push(match.index + 1);
  const expression = /[\ud800-\udbff][\udc00-\udfff]/g;
  for (let match; (match = expression.exec(text));) astrals.push(match.index + 2);
  // These indexes address one backing buffer, not the whole document.
  // Keep the wider representation available if buffer sizing changes.
  const IndexArray = text.length <= 0xffff ? Uint16Array : Uint32Array;
  return {
    text,
    starts: IndexArray.from(starts),
    crlfs: IndexArray.from(crlfs),
    astrals: IndexArray.from(astrals),
    bareCRs: IndexArray.from(bareCRs),
  };
}

function piece(buffer, start = 0, end = buffer.text.length) {
  if (start === end) return null;
  const first = upperBound(buffer.starts, start);
  const last = upperBound(buffer.starts, end);
  return {
    buffer,
    start,
    end,
    first,
    last,
    length: end - start,
    breaks: last - first,
    crlfs: upperBound(buffer.crlfs, end) - upperBound(buffer.crlfs, start + 1),
    crs:
      upperBound(buffer.crlfs, end + 1) -
      upperBound(buffer.crlfs, start + 1) +
      upperBound(buffer.bareCRs, end) -
      upperBound(buffer.bareCRs, start),
    tail: last > first ? end - buffer.starts[last - 1] : end - start,
    height: 1,
    pieces: 1,
    firstUnit: buffer.text.charCodeAt(start),
    lastUnit: buffer.text.charCodeAt(end - 1),
    astral: upperBound(buffer.astrals, end) > upperBound(buffer.astrals, start + 1),
  };
}

function branch(left, right) {
  const length = left.length + right.length;
  if (!Number.isSafeInteger(length))
    throw new RangeError("Document length exceeds exact UTF-16 coordinates");
  return {
    left,
    right,
    length,
    breaks: left.breaks + right.breaks,
    crlfs: left.crlfs + right.crlfs + (left.lastUnit === 13 && right.firstUnit === 10 ? 1 : 0),
    crs: left.crs + right.crs,
    tail: right.breaks ? right.tail : left.tail + right.length,
    height: 1 + Math.max(left.height, right.height),
    pieces: left.pieces + right.pieces,
    firstUnit: left.firstUnit,
    lastUnit: right.lastUnit,
    astral:
      left.astral ||
      right.astral ||
      (left.lastUnit >= 0xd800 &&
        left.lastUnit <= 0xdbff &&
        right.firstUnit >= 0xdc00 &&
        right.firstUnit <= 0xdfff),
  };
}

// Align persistent subtrees before comparing leaves. Edits retain almost all
// nodes, so a long unchanged prefix/suffix does not become a linear scan.
function commonLength(leftRoot, rightRoot, limit, reverse) {
  if (!limit || leftRoot === rightRoot) return limit;
  const left = [{ node: leftRoot, used: 0 }],
    right = [{ node: rightRoot, used: 0 }];
  let matched = 0;
  const expand = (stack) => {
    const { node } = stack.pop();
    stack.push({ node: reverse ? node.left : node.right, used: 0 });
    stack.push({ node: reverse ? node.right : node.left, used: 0 });
  };
  while (matched < limit) {
    const a = left.at(-1),
      b = right.at(-1);
    const count = Math.min(a.node.length - a.used, b.node.length - b.used, limit - matched);
    if (a.node === b.node && a.used === b.used) {
      matched += count;
    } else if (a.node.buffer && b.node.buffer) {
      const aStart = reverse ? a.node.end - a.used - count : a.node.start + a.used;
      const bStart = reverse ? b.node.end - b.used - count : b.node.start + b.used;
      if (a.node.buffer !== b.node.buffer || aStart !== bStart) {
        const aText = a.node.buffer.text.slice(aStart, aStart + count);
        const bText = b.node.buffer.text.slice(bStart, bStart + count);
        if (aText !== bText) {
          let same = 0;
          while (
            same < count &&
            aText.charCodeAt(reverse ? count - same - 1 : same) ===
              bText.charCodeAt(reverse ? count - same - 1 : same)
          )
            same++;
          return matched + same;
        }
      }
      matched += count;
    } else {
      if (!a.node.buffer && (b.node.buffer || a.node.length >= b.node.length)) expand(left);
      else expand(right);
      continue;
    }
    a.used += count;
    b.used += count;
    if (a.used === a.node.length) left.pop();
    if (b.used === b.node.length) right.pop();
  }
  return matched;
}

function balance(left, right) {
  if (left.height > right.height + 1) {
    if (left.left.height >= left.right.height) return branch(left.left, branch(left.right, right));
    return branch(branch(left.left, left.right.left), branch(left.right.right, right));
  }
  if (right.height > left.height + 1) {
    if (right.right.height >= right.left.height)
      return branch(branch(left, right.left), right.right);
    return branch(branch(left, right.left.left), branch(right.left.right, right.right));
  }
  return branch(left, right);
}

function join(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.buffer && right.buffer) {
    if (left.buffer === right.buffer && left.end === right.start)
      return piece(left.buffer, left.start, right.end);
    if (left.length + right.length <= MERGE_UNITS)
      return piece(
        bufferFor(
          left.buffer.text.slice(left.start, left.end) +
            right.buffer.text.slice(right.start, right.end),
        ),
      );
  }
  if (left.height > right.height + 1) return balance(left.left, join(left.right, right));
  if (right.height > left.height + 1) return balance(join(left, right.left), right.right);
  return branch(left, right);
}

function split(node, index) {
  if (!node) return [null, null];
  if (index === 0) return [null, node];
  if (index === node.length) return [node, null];
  if (node.buffer)
    return [
      piece(node.buffer, node.start, node.start + index),
      piece(node.buffer, node.start + index, node.end),
    ];
  if (index < node.left.length) {
    const [before, after] = split(node.left, index);
    return [before, join(after, node.right)];
  }
  const [before, after] = split(node.right, index - node.left.length);
  return [join(node.left, before), after];
}

function build(nodes, start = 0, end = nodes.length) {
  if (start === end) return null;
  if (end - start === 1) return nodes[start];
  const middle = Math.floor((start + end) / 2);
  return branch(build(nodes, start, middle), build(nodes, middle, end));
}

function* parts(node, start, end) {
  if (!node || start >= end) return;
  if (node.buffer) {
    yield node.buffer.text.slice(node.start + start, node.start + end);
    return;
  }
  if (start < node.left.length) yield* parts(node.left, start, Math.min(end, node.left.length));
  if (end > node.left.length)
    yield* parts(node.right, Math.max(0, start - node.left.length), end - node.left.length);
}

function collectParts(node, start, end, result) {
  if (!node || start >= end) return;
  if (node.buffer) {
    result.push(node.buffer.text.slice(node.start + start, node.start + end));
    return;
  }
  if (start < node.left.length)
    collectParts(node.left, start, Math.min(end, node.left.length), result);
  if (end > node.left.length)
    collectParts(node.right, Math.max(0, start - node.left.length), end - node.left.length, result);
}

function collectNodes(node, start, end, result) {
  if (!node || start >= end) return;
  if (start === 0 && end === node.length) {
    result.push(node);
    return;
  }
  if (node.buffer) {
    result.push(piece(node.buffer, node.start + start, node.start + end));
    return;
  }
  if (start < node.left.length)
    collectNodes(node.left, start, Math.min(end, node.left.length), result);
  if (end > node.left.length)
    collectNodes(node.right, Math.max(0, start - node.left.length), end - node.left.length, result);
}

function compactNodes(nodes) {
  const result = [],
    pending = [];
  let length = 0;
  const flush = () => {
    if (pending.length === 1) result.push(pending[0]);
    else if (pending.length)
      result.push(
        piece(
          bufferFor(pending.map((node) => node.buffer.text.slice(node.start, node.end)).join("")),
        ),
      );
    pending.length = 0;
    length = 0;
  };
  for (const node of nodes) {
    if (!node.buffer || node.length > MERGE_UNITS) {
      flush();
      result.push(node);
    } else {
      if (length + node.length > MERGE_UNITS) flush();
      pending.push(node);
      length += node.length;
    }
  }
  flush();
  return result;
}

function joinNodes(nodes, start = 0, end = nodes.length) {
  if (start === end) return null;
  if (end - start === 1) return nodes[start];
  const middle = Math.floor((start + end) / 2);
  return join(joinNodes(nodes, start, middle), joinNodes(nodes, middle, end));
}

function integer(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new RangeError(`${name} is outside the document`);
}

class PieceTree {
  #root;
  #lineNode = null;
  #lineNodeRow = 0;
  #lineNodeOffset = 0;

  constructor(text = "") {
    if (typeof text !== "string") throw new TypeError("Document text must be a string");
    const nodes = [];
    for (let offset = 0; offset < text.length; offset += BUFFER_UNITS)
      nodes.push(piece(bufferFor(text.slice(offset, offset + BUFFER_UNITS))));
    this.#root = build(nodes);
    Object.freeze(this);
  }

  static #fromRoot(root) {
    const result = new PieceTree();
    result.#root = root;
    return result;
  }

  // Internal persistence protocol. Identities are opaque, immutable nodes;
  // callers memoize them without retaining old roots. A postorder traversal
  // visits only paths absent from the caller's WeakMap.
  *snapshotNodes(known) {
    function* visit(node) {
      if (!node || known.has(snapshotIdentity(node))) return;
      if (node.buffer) {
        yield {
          identity: snapshotIdentity(node),
          text: node.buffer.text.slice(node.start, node.end),
        };
      } else {
        yield* visit(node.left);
        yield* visit(node.right);
        yield {
          identity: snapshotIdentity(node),
          left: snapshotIdentity(node.left),
          right: snapshotIdentity(node.right),
        };
      }
    }
    yield* visit(this.#root);
    return snapshotIdentity(this.#root);
  }

  // Rebuild verified persistence nodes without concatenating their text or
  // changing their topology, so later saves can reuse the imported identities.
  static fromSnapshotNode(text, left, right) {
    if (typeof text === "string") {
      if (text.length === 0 || text.length > BUFFER_UNITS)
        throw new Error("Invalid snapshot text node");
      return PieceTree.#fromRoot(piece(bufferFor(text)));
    }
    if (
      !(left instanceof PieceTree) ||
      !(right instanceof PieceTree) ||
      !left.length ||
      !right.length ||
      Math.abs(left.#root.height - right.#root.height) > 1 ||
      !Number.isSafeInteger(left.length + right.length)
    )
      throw new Error("Invalid snapshot branch");
    return PieceTree.#fromRoot(branch(left.#root, right.#root));
  }

  rememberSnapshotIdentity(known, value) {
    if (this.#root) known.set(snapshotIdentity(this.#root), value);
  }

  async mapChunks(mapper, { cache = new WeakMap(), signal, isCurrent } = {}) {
    if (typeof mapper !== "function" || !(cache instanceof WeakMap))
      throw new TypeError("Chunk mapping requires a function and a WeakMap cache");
    const owner = mapperOwners.get(cache);
    if (owner && owner !== mapper)
      throw new TypeError("A chunk mapping cache belongs to one mapper");
    mapperOwners.set(cache, mapper);
    const check = () => {
      if (signal?.aborted || isCurrent?.() === false)
        throw Object.assign(new Error("Text mapping was cancelled"), { name: "AbortError" });
    };
    check();
    const iterator = this.snapshotNodes(cache);
    let deadline = performance.now() + 4;
    for (let step = iterator.next(); ; step = iterator.next()) {
      if (step.done) {
        check();
        const result = step.value ? cache.get(step.value) : new PieceTree();
        if (!(result instanceof PieceTree)) throw new TypeError("Invalid text mapping cache");
        return result;
      }
      const node = step.value;
      let mapped;
      if (node.text !== undefined) {
        const value = mapper(node.text);
        if (typeof value !== "string" && !(value instanceof PieceTree))
          throw new TypeError("A text chunk mapper must return a string or snapshot synchronously");
        mapped = value instanceof PieceTree ? value : new PieceTree(value);
      } else {
        const left = cache.get(node.left),
          right = cache.get(node.right);
        if (!(left instanceof PieceTree) || !(right instanceof PieceTree))
          throw new TypeError("Invalid text mapping cache");
        mapped = left.replace(left.length, left.length, right);
      }
      cache.set(node.identity, mapped);
      check();
      if (performance.now() >= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        check();
        deadline = performance.now() + 4;
      }
    }
  }

  serializeSnapshot(deferred = false) {
    if (deferred) return this;
    return {
      type: "LumineText",
      version: 1,
      length: this.length,
      chunks: Array.from(this.chunks()),
    };
  }

  static deserializeSnapshot(value) {
    if (value instanceof PieceTree) return value;
    if (value?.type !== "LumineText" || value.version !== 1 || !Array.isArray(value.chunks))
      throw new Error("Invalid segmented text snapshot");
    let result = new PieceTree();
    for (const chunk of value.chunks) {
      if (typeof chunk !== "string" || chunk.length > BUFFER_UNITS)
        throw new Error("Invalid text snapshot chunk");
      result = result.replace(result.length, result.length, chunk);
    }
    if (!Number.isSafeInteger(value.length) || result.length !== value.length)
      throw new Error("Text snapshot length mismatch");
    return result;
  }

  get length() {
    return this.#root?.length ?? 0;
  }

  canMaterialize(maxLength = Infinity) {
    if (typeof maxLength !== "number" || Number.isNaN(maxLength) || maxLength < 0)
      throw new RangeError("Text materialization budget must be a non-negative number");
    return this.length <= Math.min(maxLength, MAX_STRING_LENGTH);
  }
  get lineCount() {
    return (this.#root?.breaks ?? 0) + 1;
  }

  getLineEndings() {
    const endings = new Set();
    if (this.#root?.breaks > this.#root?.crlfs) endings.add("\n");
    if (this.#root?.crlfs) endings.add("\r\n");
    return endings;
  }

  get hasAstral() {
    return this.#root?.astral ?? false;
  }

  get hasLoneCarriageReturn() {
    return (this.#root?.crs ?? 0) > (this.#root?.crlfs ?? 0);
  }

  replace(start, end, text) {
    integer(start, "Start", this.length);
    integer(end, "End", this.length);
    if (end < start) throw new RangeError("End precedes start");
    const inserted = text instanceof PieceTree ? text : new PieceTree(text);
    if (start === end && inserted.length === 0) return this;
    const [before, rest] = split(this.#root, start);
    const [, after] = split(rest, end - start);
    return PieceTree.#fromRoot(join(join(before, inserted.#root), after));
  }

  replaceAll(edits) {
    if (!edits.length) return this;
    const planned = edits
      .map(({ start, end, text }) => ({
        start,
        end,
        text: text instanceof PieceTree ? text : new PieceTree(text),
      }))
      .sort((a, b) => a.start - b.start);
    let previous;
    for (const edit of planned) {
      integer(edit.start, "Start", this.length);
      integer(edit.end, "End", this.length);
      if (
        edit.end < edit.start ||
        (previous && (edit.start < previous.end || edit.start === previous.start))
      )
        throw new RangeError("Batch edits overlap or have reversed bounds");
      previous = edit;
    }
    const nodes = [];
    let offset = 0;
    for (const { start, end, text } of planned) {
      collectNodes(this.#root, offset, start, nodes);
      if (text.#root) nodes.push(text.#root);
      offset = end;
    }
    collectNodes(this.#root, offset, this.length, nodes);
    // Dense batches index each small output block once, instead of repeatedly
    // re-indexing a growing prefix for every inserted fragment.
    return PieceTree.#fromRoot(joinNodes(compactNodes(nodes)));
  }

  subtext(start, end = this.length) {
    integer(start, "Start", this.length);
    integer(end, "End", this.length);
    if (end < start) throw new RangeError("End precedes start");
    if (start === 0 && end === this.length) return this;
    const [, rest] = split(this.#root, start);
    return PieceTree.#fromRoot(split(rest, end - start)[0]);
  }

  // String-compatible bounds for parser and node-text callbacks. This is an
  // explicit materialization of just this range, never a cached full string.
  slice(start = 0, end = this.length) {
    start = Math.trunc(start) || 0;
    end = Math.trunc(end) || 0;
    start = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
    end = end < 0 ? Math.max(0, this.length + end) : Math.min(end, this.length);
    if (start >= end) return "";
    if (end - start > MAX_STRING_LENGTH) {
      throw Object.assign(
        new RangeError(
          `Cannot materialize ${end - start} UTF-16 units as one string (limit ${MAX_STRING_LENGTH}). Read chunks or a smaller range.`,
        ),
        { code: "ERR_TEXT_MATERIALIZATION_LIMIT", length: end - start, limit: MAX_STRING_LENGTH },
      );
    }
    let node = this.#root;
    while (!node.buffer) {
      if (end <= node.left.length) node = node.left;
      else if (start >= node.left.length) {
        start -= node.left.length;
        end -= node.left.length;
        node = node.right;
      } else {
        const result = [];
        collectParts(node, start, end, result);
        return result.join("");
      }
    }
    return node.buffer.text.slice(node.start + start, node.start + end);
  }

  *chunks() {
    yield* parts(this.#root, 0, this.length);
  }
  *lines(startRow = 0, endRow = this.lineCount) {
    integer(startRow, "Start row", this.lineCount);
    integer(endRow, "End row", this.lineCount);
    if (endRow < startRow) throw new RangeError("End row precedes start row");
    if (startRow === endRow) return;
    const start = this.lineStart(startRow);
    const end = endRow === this.lineCount ? this.length : this.lineStart(endRow);
    let pending = "";
    for (const chunk of parts(this.#root, start, end)) {
      let offset = 0;
      for (let lf = chunk.indexOf("\n"); lf >= 0; lf = chunk.indexOf("\n", offset)) {
        const line = pending + chunk.slice(offset, lf);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        pending = "";
        offset = lf + 1;
      }
      pending += chunk.slice(offset);
    }
    if (endRow === this.lineCount) yield pending;
  }
  lineReader() {
    let row = -2,
      value,
      iterator;
    return (requested) => {
      if (!Number.isInteger(requested) || requested < 0 || requested >= this.lineCount)
        return undefined;
      if (requested === row) return value;
      if (requested !== row + 1) iterator = this.lines(requested);
      row = requested;
      value = iterator.next().value;
      return value;
    };
  }
  toString() {
    return this.slice();
  }

  equals(other) {
    if (!(other instanceof PieceTree) || other.length !== this.length) return false;
    return this.commonPrefixLength(other) === this.length;
  }

  commonPrefixLength(other, limit = Math.min(this.length, other?.length ?? 0)) {
    if (!(other instanceof PieceTree)) throw new TypeError("Expected an immutable text snapshot");
    integer(limit, "Comparison length", Math.min(this.length, other.length));
    return commonLength(this.#root, other.#root, limit, false);
  }

  commonSuffixLength(other, limit = Math.min(this.length, other?.length ?? 0)) {
    if (!(other instanceof PieceTree)) throw new TypeError("Expected an immutable text snapshot");
    integer(limit, "Comparison length", Math.min(this.length, other.length));
    return commonLength(this.#root, other.#root, limit, true);
  }

  charCodeAt(index) {
    index = Math.trunc(index) || 0;
    if (index < 0 || index >= this.length) return NaN;
    let node = this.#root;
    while (!node.buffer) {
      if (index < node.left.length) node = node.left;
      else {
        index -= node.left.length;
        node = node.right;
      }
    }
    return node.buffer.text.charCodeAt(node.start + index);
  }

  positionAt(index) {
    integer(index, "Offset", this.length);
    let node = this.#root;
    let row = 0;
    let column = 0;
    if (!node) return { row, column };
    while (!node.buffer) {
      if (index < node.left.length) node = node.left;
      else {
        const left = node.left;
        row += left.breaks;
        column = left.breaks ? left.tail : column + left.length;
        index -= left.length;
        node = node.right;
      }
    }
    const last = upperBound(node.buffer.starts, node.start + index);
    row += last - node.first;
    column = last > node.first ? node.start + index - node.buffer.starts[last - 1] : column + index;
    return { row, column };
  }

  lineStart(row) {
    integer(row, "Row", this.lineCount - 1);
    if (row === 0) return 0;
    const cached = this.#lineNode;
    if (cached && row > this.#lineNodeRow && row <= this.#lineNodeRow + cached.breaks) {
      return (
        this.#lineNodeOffset +
        cached.buffer.starts[cached.first + row - this.#lineNodeRow - 1] -
        cached.start
      );
    }
    const requestedRow = row;
    let node = this.#root;
    let offset = 0;
    while (!node.buffer) {
      if (row <= node.left.breaks) node = node.left;
      else {
        row -= node.left.breaks;
        offset += node.left.length;
        node = node.right;
      }
    }
    // Each immutable snapshot owns its cursor. Revisions can share leaves,
    // but never their absolute row/offset coordinates.
    this.#lineNode = node;
    this.#lineNodeRow = requestedRow - row;
    this.#lineNodeOffset = offset;
    return offset + node.buffer.starts[node.first + row - 1] - node.start;
  }

  offsetAt({ row, column }) {
    const start = this.lineStart(row);
    const end = row + 1 < this.lineCount ? this.lineStart(row + 1) - 1 : this.length;
    integer(column, "Column", end - start);
    return start + column;
  }

  // A private cursor per consumer avoids repeated tree searches for adjacent
  // parser reads. Return one piece at a time, bounded by the requested units.
  reader(maxUnits = 4096) {
    integer(maxUnits, "Read size", Number.MAX_SAFE_INTEGER);
    if (maxUnits === 0) throw new RangeError("Read size must be positive");
    let cached = null;
    let start = 0;
    return (index) => {
      integer(index, "Offset", Number.MAX_SAFE_INTEGER);
      // Parser included ranges may end beyond EOF after an edit.
      if (index >= this.length) return "";
      if (!cached || index < start || index >= start + cached.length) {
        cached = this.#root;
        start = 0;
        while (!cached.buffer) {
          if (index < start + cached.left.length) cached = cached.left;
          else {
            start += cached.left.length;
            cached = cached.right;
          }
        }
      }
      const offset = cached.start + index - start;
      return cached.buffer.text.slice(offset, Math.min(cached.end, offset + maxUnits));
    };
  }

  // Structural diagnostics for differential tests and benchmark reports.
  inspect() {
    const visit = (node) => {
      if (!node) return;
      if (node.buffer) {
        if (node.length !== node.end - node.start || node.length === 0)
          throw new Error("Invalid document piece");
      } else {
        visit(node.left);
        visit(node.right);
        const expected = branch(node.left, node.right);
        for (const key of ["length", "breaks", "crlfs", "tail", "height", "pieces"])
          if (node[key] !== expected[key]) throw new Error(`Invalid ${key} summary`);
        if (Math.abs(node.left.height - node.right.height) > 1)
          throw new Error("Unbalanced document tree");
      }
    };
    visit(this.#root);
    return {
      length: this.length,
      lines: this.lineCount,
      height: this.#root?.height ?? 0,
      pieces: this.#root?.pieces ?? 0,
    };
  }
}

module.exports = PieceTree;
