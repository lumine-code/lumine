const { isDeepStrictEqual } = require("node:util");
const Parser = require("./tree-sitter-parser");

// Reusable baselines, not a promise that every next-revision language has
// been discovered. Fresh parent reconciliation remains authoritative.
const MAX_LAYERS = 4096;
const MAX_RANGES = 16384;
const rootPolicy = (mode) => {
  const registration = mode.grammarRegistry?.rootLanguageRangesByBuffer.get(mode.buffer);
  return registration?.descriptor ?? registration?.provider ?? null;
};
const extent = (range, source) =>
  Object.freeze({
    startIndex: range.startIndex ?? source.offsetAt(range.start),
    endIndex: range.endIndex ?? source.offsetAt(range.end),
  });
const properties = (point) => point && Object.freeze({ ...point });
const sameProperties = (saved, current) => {
  if (!saved || !current) return saved === current;
  const keys = Object.keys(saved);
  return (
    keys.length === Object.keys(current).length && keys.every((key) => saved[key] === current[key])
  );
};

class SyntaxSnapshot {
  static capture(mode, { indentationOnly = false } = {}) {
    const revision = mode.buffer.getTextRevision();
    const root = mode.rootLanguageLayer;
    if (mode.destroyed || root?.backgroundTree?.revision !== revision) return null;
    const source = mode.buffer.getTextSnapshot();
    const entries = [];
    let scanned = 0,
      rangeCount = 0;
    const visit = (layer, parent) => {
      if (++scanned > MAX_LAYERS || rangeCount >= MAX_RANGES) return;
      if (
        layer.destroyed ||
        layer.backgroundTree?.revision !== revision ||
        layer.grammarGeneration !== layer.grammar.queryLoadGeneration ||
        (indentationOnly && parent && !mode.grammarCanAffectIndentation(layer.grammar))
      )
        return;
      const ranges = layer.lastIncludedRanges;
      if (ranges && ranges.length + rangeCount > MAX_RANGES) return;
      rangeCount += ranges?.length ?? 0;
      const entry = Object.freeze({
        parent,
        grammar: layer.grammar,
        generation: layer.grammar.queryLoadGeneration,
        injectionPoint: layer.injectionPoint,
        injectionProperties: properties(layer.injectionPoint),
        languageString: layer.marker?.languageString,
        owner: layer.marker ? extent(layer.marker.getRange(), source) : null,
        ranges: ranges && Object.freeze(ranges.map((range) => extent(range, source))),
        tree: layer.backgroundTree,
      });
      entries.push(entry);
      for (const marker of layer.childLayerMarkers) {
        if (scanned >= MAX_LAYERS || rangeCount >= MAX_RANGES) break;
        visit(marker.languageLayer, entry);
      }
    };
    visit(root, null);
    return entries.length
      ? new SyntaxSnapshot(source, rootPolicy(mode), Object.freeze(entries))
      : null;
  }

  constructor(source, policy, layers) {
    this.source = source;
    this.policy = policy && typeof policy === "object" ? structuredClone(policy) : policy;
    this.layers = layers;
    Object.freeze(this);
  }

  fork(buffer) {
    if (buffer.getTextSnapshot() !== this.source)
      throw new Error("A syntax snapshot must fork its own immutable source");
    return new SyntaxSnapshotRestore(this, buffer.getTextRevision());
  }
}

// Lazily map ownership through the exact document journal. Unused layers
// allocate neither buffer markers nor copied WASM tree handles.
class SyntaxSnapshotRestore {
  constructor(snapshot, revision) {
    this.snapshot = snapshot;
    this.revision = revision;
    this.claimed = new WeakMap();
    this.used = new Set();
    this.children = new Map();
    this.indexes = new Map();
    for (const entry of snapshot.layers) {
      let siblings = this.children.get(entry.parent);
      if (!siblings) this.children.set(entry.parent, (siblings = []));
      siblings.push(entry);
    }
  }

  claim(mode, layer, ranges) {
    const snapshot = this.snapshot;
    if (!snapshot || !isDeepStrictEqual(snapshot.policy, rootPolicy(mode))) return null;
    const parent = layer.marker?.parentLanguageLayer;
    const previousParent = parent ? this.claimed.get(parent) : null;
    if (parent && !previousParent) return null;
    const capture = mode.document.capture({ revision: this.revision });
    if (!capture.previous) return null;
    const owner = layer.marker && extent(layer.marker.getRange(), capture.text);
    if (this.indexRevision !== capture.revision) {
      this.indexRevision = capture.revision;
      this.indexes.clear();
    }
    let index = this.indexes.get(previousParent);
    if (!index) {
      index = new Map();
      for (const entry of this.children.get(previousParent) ?? []) {
        const mapped = {
          entry,
          ranges: entry.ranges && entry.ranges.map((range) => mapRange(range, capture.edits)),
        };
        const owners = entry.owner ? mapRange(entry.owner, capture.edits) : [null];
        for (const savedOwner of owners) {
          const key = rangeKey(savedOwner);
          let bucket = index.get(key);
          if (!bucket) index.set(key, (bucket = []));
          bucket.push(mapped);
        }
      }
      this.indexes.set(previousParent, index);
    }
    const matches = (saved, current) => {
      if (!saved || !current) return saved === current;
      return (
        saved.length === current.length &&
        saved.every((variants, i) =>
          variants.some((range) => rangeKey(range) === rangeKey(current[i])),
        )
      );
    };
    let found;
    for (const { entry, ranges: savedRanges } of index.get(rangeKey(owner)) ?? []) {
      if (
        this.used.has(entry) ||
        entry.grammar !== layer.grammar ||
        entry.generation !== layer.grammar.queryLoadGeneration ||
        entry.injectionPoint !== layer.injectionPoint ||
        !sameProperties(entry.injectionProperties, layer.injectionPoint) ||
        entry.languageString !== layer.marker?.languageString ||
        !matches(savedRanges, ranges)
      )
        continue;
      // Deleted/merged owners may collapse onto one range. Never choose an
      // arbitrary same-language tree when identity is ambiguous.
      if (found) return null;
      found = entry;
    }
    if (!found) return null;
    if (found.tree.language !== layer.grammar.getLanguageSync()) return null;
    const tree = Parser.copySnapshot(found.tree, this.revision);
    this.claimed.set(layer, found);
    this.used.add(found);
    return tree;
  }

  close() {
    this.snapshot = null;
    this.children.clear();
    this.indexes.clear();
    this.used.clear();
    this.claimed = new WeakMap();
  }
}

const rangeKey = (range) => (range ? `${range.startIndex}:${range.endIndex}` : "root");

function mapRange(saved, edits) {
  if (saved.endIndex <= saved.startIndex) return [];
  let starts = [saved.startIndex, saved.startIndex];
  let ends = [saved.endIndex, saved.endIndex];
  for (const edit of edits) {
    // Replacing the entire old owner does not establish the new owner's
    // identity, even if its grammar and extent happen to be identical.
    if (
      edit.oldEndIndex > edit.startIndex &&
      edit.startIndex <= Math.min(...starts) &&
      edit.oldEndIndex >= Math.max(...ends)
    )
      return [];
    starts = starts.map((offset, i) => mapOffset(offset, edit, Boolean(i)));
    ends = ends.map((offset, i) => mapOffset(offset, edit, Boolean(i)));
  }
  const variants = new Map();
  for (const startIndex of starts)
    for (const endIndex of ends) {
      if (endIndex <= startIndex) continue;
      const range = { startIndex, endIndex };
      variants.set(rangeKey(range), range);
    }
  return [...variants.values()];
}

function mapOffset(offset, edit, right) {
  const { startIndex, oldEndIndex, newEndIndex } = edit;
  if (oldEndIndex > startIndex && offset === startIndex) return startIndex;
  if (offset < startIndex || (offset === startIndex && !right)) return offset;
  if (oldEndIndex > startIndex && offset === oldEndIndex) return newEndIndex;
  if (offset <= oldEndIndex) return right ? newEndIndex : startIndex;
  return offset + newEndIndex - oldEndIndex;
}

module.exports = SyntaxSnapshot;
