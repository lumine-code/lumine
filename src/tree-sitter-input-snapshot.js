const IndentResolver = require("./tree-sitter-indent-resolver");
const ScopeResolver = require("./scope-resolver");
const Range = require("./range");
const captureQuery = require("./tree-sitter-query-cache");
const { TextPatch: Patch, TextChangeMap, PieceTree } = require("./text-model");
const projectInputTree = require("./tree-sitter-input-node");
const { allowsInputProjection } = require("./tree-sitter-input-policy");
const matchInputOwnership = require("./tree-sitter-input-ownership");

function aborted() {
  return Object.assign(new Error("Input indentation was superseded"), { name: "AbortError" });
}

// Only a whitespace insertion can preserve the pre-input token topology.
// Coordinates in the journal describe each successive intermediate source.
function whitespaceInsertions(changes, check = () => {}) {
  if (!Array.isArray(changes)) return null;
  const edits = [];
  for (const change of changes) {
    check();
    const { startIndex, oldEndIndex } = change;
    const text = change.newTextSource ?? change.newText ?? change.text;
    if (
      !Number.isSafeInteger(startIndex) ||
      oldEndIndex !== startIndex ||
      startIndex < 0 ||
      text == null ||
      !Number.isSafeInteger(text.length) ||
      typeof text.slice !== "function"
    )
      return null;
    for (let offset = 0; offset < text.length; offset += 4096) {
      check();
      if (/[^ \t\r\n]/.test(text.slice(offset, offset + 4096))) return null;
    }
    edits.push({ startIndex, oldEndIndex, newText: text });
  }
  return edits;
}

function isWhitespaceInsertion(changes) {
  return whitespaceInsertions(changes) !== null;
}

// Index disjoint injection members as intervals too: an extent would assign
// their holes to the embedded language. Subtree maxima prune unrelated cells.
function rangeIndex(layers) {
  const entries = layers.flatMap((layer, order) =>
    layer.getCurrentRanges().map((range) => ({ layer, order, range })),
  );
  entries.sort((a, b) => a.range.start.compare(b.range.start));
  const build = (first, last) => {
    if (first === last) return null;
    const middle = (first + last) >>> 1;
    const entry = entries[middle];
    const left = build(first, middle);
    const right = build(middle + 1, last);
    let end = entry.range.end;
    for (const child of [left, right]) if (child?.end.compare(end) > 0) end = child.end;
    return { ...entry, end, left, right };
  };
  const root = build(0, entries.length);
  return (point, where) => {
    let result = null;
    const visit = (node) => {
      if (!node || node.end.compare(point) < 0) return;
      visit(node.left);
      if (node.range.start.compare(point) > 0) return;
      if (
        node.range.end.compare(point) >= 0 &&
        (!result || node.order < result.order) &&
        where(node.layer)
      )
        result = node;
      visit(node.right);
    };
    visit(root);
    return result?.layer ?? null;
  };
}

// A typing snapshot preserves the syntax relationships that existed before
// Enter. Lazy node values project their geometry and text into the complete
// draft without parsing the temporarily unindented source. It is private to
// this plan: no projected node can escape through normal syntax publication.
function createInputSnapshot(
  mode,
  draftBuffer,
  changes,
  {
    signal,
    isCurrent,
    snapshot = mode.captureSyntaxSnapshot({ indentationOnly: true }),
    ownershipSnapshot,
  } = {},
) {
  if (!snapshot?.complete) return null;
  const revision = draftBuffer.getTextRevision();
  const sourceRevision = mode.buffer.getTextRevision();
  const epoch = mode.getSyntaxRequestEpoch();
  if (snapshot.epoch !== null && snapshot.epoch !== epoch) return null;
  const stamps = new Map();
  for (const entry of [...snapshot.layers, ...(ownershipSnapshot?.layers ?? [])]) {
    if (stamps.has(entry.grammar) && stamps.get(entry.grammar) !== entry.generation) return null;
    stamps.set(entry.grammar, entry.generation);
  }
  const generations = [...stamps];
  let closed = false,
    building = true;
  const check = () => {
    // Initialization and scanning can be separate RPCs. The former's signal
    // expires after its reply; each scan owns its own cancellation signal.
    if (building) signal?.throwIfAborted();
    if (
      closed ||
      mode.destroyed ||
      draftBuffer.isDestroyed() ||
      mode.buffer.getTextRevision() !== sourceRevision ||
      draftBuffer.getTextRevision() !== revision ||
      mode.getSyntaxRequestEpoch() !== epoch ||
      isCurrent?.() === false ||
      generations.some(([grammar, generation]) => grammar.queryLoadGeneration !== generation)
    )
      throw aborted();
  };
  check();
  const text = draftBuffer.getTextSnapshot();
  const edits = whitespaceInsertions(changes, check);
  if (!edits) return null;
  let replay = snapshot.source;
  const patch = new Patch();
  for (const edit of edits) {
    check();
    if (edit.startIndex > replay.length) return null;
    const inserted = typeof edit.newText === "string" ? new PieceTree(edit.newText) : edit.newText;
    patch.splice(
      replay.positionAt(edit.startIndex),
      { row: 0, column: 0 },
      inserted.positionAt(inserted.length),
    );
    replay = replay.replace(edit.startIndex, edit.oldEndIndex, edit.newText);
  }
  if (!replay.equals(text)) return null;
  const map = new TextChangeMap(snapshot.source);
  for (const change of patch.getChanges()) {
    map.add(
      snapshot.source.offsetAt(change.oldStart),
      snapshot.source.offsetAt(change.oldEnd),
      text.offsetAt(change.newEnd) - text.offsetAt(change.newStart),
    );
  }
  map.finish(text);
  const inverse = map.invert();
  const originalOwnership = allowsInputProjection(mode, snapshot, changes, check);
  const matches = originalOwnership
    ? null
    : matchInputOwnership(snapshot, ownershipSnapshot, text, map, check);
  if (!originalOwnership && !matches) return null;
  const routing = originalOwnership ? snapshot : ownershipSnapshot;
  const identity = new TextChangeMap(text).finish(text);
  mode.ensureQueriesForLayersSync("indentsQuery");
  check();
  const layers = [];
  const projectedTrees = [];
  let projection;
  const close = () => {
    if (closed) return;
    closed = true;
    if (projection) projection.destroyed = true;
    for (const layer of layers) {
      captureQuery.clear(layer);
      layer.scopeResolver?.destroy();
      if (layer.scopeResolver) layer.scopeResolver.buffer = null;
      layer.tree = null;
      layer.buffer = null;
      layer.languageMode = null;
      layer.destroyed = true;
    }
    projection?.indentResolver.emitter.dispose();
    if (projection) {
      projection.buffer = null;
      projection.indentResolver.buffer = null;
    }
    for (const tree of projectedTrees) tree.close();
    projectedTrees.length = 0;
    snapshot = null;
    ownershipSnapshot = null;
    mode = null;
    draftBuffer = null;
    signal = null;
    isCurrent = null;
  };
  projection = {
    buffer: draftBuffer,
    config: mode.config,
    queryBudget: mode.queryBudget,
    indentationOnly: true,
    destroyed: false,
    lastTransactionParseError: null,
    document: { capture: () => ({ text }) },
    getSyntaxRequestEpoch: () => epoch,
    getSyntaxGeneration: () => 0,
    atGrammarSettlement: async () => {
      check();
      return {};
    },
    getAllLanguageLayers: () => layers,
    close,
    destroy: close,
  };
  projection.indentResolver = new IndentResolver(draftBuffer, projection);
  projection.scanSuggestedIndentation = async function* (ranges, tabLength, options = {}) {
    check();
    const current = options.isCurrent;
    yield* projection.indentResolver.scanSuggestedIndentation(ranges, tabLength, {
      ...options,
      isCurrent: () => {
        check();
        return current?.() !== false;
      },
    });
  };
  const entries = new Map();
  try {
    for (const entry of routing.layers) {
      check();
      const { grammar } = entry;
      const previous = originalOwnership ? entry : matches.get(entry);
      const query =
        typeof entry.grammar.indentsQuery === "string"
          ? entry.grammar.getQuerySync("indentsQuery")
          : null;
      const projected = projectInputTree(
        (previous ?? entry).tree,
        query,
        previous ? snapshot.source : text,
        text,
        previous ? map : identity,
        previous ? inverse : identity,
        check,
      );
      projectedTrees.push(projected);
      const { tree } = projected;
      const parent = entries.get(entry.parent);
      const ranges = entry.ranges
        ? entry.ranges.map(
            (range) =>
              new Range(
                originalOwnership
                  ? map.mapPoint(snapshot.source.positionAt(range.startIndex))
                  : text.positionAt(range.startIndex),
                originalOwnership
                  ? map.mapPoint(snapshot.source.positionAt(range.endIndex), true)
                  : text.positionAt(range.endIndex),
              ),
          )
        : [draftBuffer.getRange()];
      if (!ranges.length) {
        close();
        return null;
      }
      const extent = new Range(ranges[0].start, ranges.at(-1).end);
      const layer = {
        grammar: entry.grammar,
        depth: parent ? parent.depth + 1 : 0,
        buffer: draftBuffer,
        languageMode: projection,
        ready: true,
        destroyed: false,
        tree,
        treeIsDirty: false,
        queries: { indentsQuery: projected.query },
        getOrParseTree: () => tree,
        getCurrentRanges: () => ranges,
        getExtent: () => extent,
        containsPoint(point, exclusive = false) {
          let first = 0,
            last = ranges.length;
          while (first < last) {
            const middle = (first + last) >>> 1;
            if (ranges[middle].start.compare(point) <= 0) first = middle + 1;
            else last = middle;
          }
          return ranges[first - 1]?.containsPoint(point, exclusive) ?? false;
        },
        inspect: () => `[InputIndentation ${grammar.scopeName}]`,
      };
      layers.push(layer);
      layer.scopeResolver = new ScopeResolver(layer);
      entries.set(entry, layer);
      if (!entry.parent) projection.rootLanguageLayer = layer;
    }
    layers.sort((a, b) => b.depth - a.depth || a.getExtent().compare(b.getExtent()));
    const layerAtPoint = rangeIndex(layers);
    projection.controllingLayerAtPoint = (point, where = () => true) => layerAtPoint(point, where);
    check();
    building = false;
    return projection;
  } catch (error) {
    close();
    throw error;
  }
}

module.exports = { createInputSnapshot, isWhitespaceInsertion };
