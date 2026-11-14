const path = require("node:path");
const PieceTree = require("./piece-tree");
const Point = require("./point");
const Patch = require("./text-patch");
const { usesSyntaxIndentation } = require("./typing-indentation-rules");

const MAX_CONTEXT = 4096;

function normalizeInputEditPolicy(grammarPath, value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim())
    throw new TypeError("An input edit policy requires a module path");
  return path.resolve(path.dirname(grammarPath), value);
}

// A policy proves ownership stability, not the indentation itself. A grammar
// without possible indenting injections needs no such proof; the existing
// topology and proposed source remain the input to its indentation query.
function needsOwnershipProof(grammar, mode) {
  const affectsIndentation = (language) => {
    if (typeof language !== "string" || !language) return true;
    const child = mode.grammarForLanguageString(language);
    return Boolean(
      child &&
      usesSyntaxIndentation({
        grammar: child,
        grammarForLanguageString: mode.grammarForLanguageString.bind(mode),
      }),
    );
  };
  for (const points of Object.values(grammar.injectionPointsByType ?? {}))
    for (const point of points) if (affectsIndentation(point.language)) return true;
  if (
    grammar.queryPaths?.injectionsQuery ||
    grammar.injectionsQuery ||
    grammar.queryCache?.has("injectionsQuery")
  ) {
    const descriptors = grammar.queryCache?.get("injectionsQuery")?.injectionDescriptors;
    if (!descriptors) return true;
    for (const { languageName } of descriptors.values())
      if (affectsIndentation(languageName)) return true;
  }
  return false;
}

// Included ranges can have holes. Index members, rather than their extent,
// so unrelated cells do not impose policies on this input operation.
function containingLayers(layers) {
  const roots = layers.filter((layer) => !layer.parent);
  const ranges = layers.flatMap((layer) =>
    (layer.ranges ?? []).map((range) => ({ ...range, layer })),
  );
  ranges.sort((a, b) => a.startIndex - b.startIndex);
  const build = (first, last) => {
    if (first === last) return null;
    const middle = (first + last) >>> 1;
    const entry = ranges[middle];
    const left = build(first, middle);
    const right = build(middle + 1, last);
    return {
      ...entry,
      left,
      right,
      maximum: Math.max(entry.endIndex, left?.maximum ?? -1, right?.maximum ?? -1),
    };
  };
  const root = build(0, ranges.length);
  return (index) => {
    const active = new Set(roots);
    let boundary = false;
    const visit = (entry) => {
      if (!entry || entry.maximum < index) return;
      visit(entry.left);
      if (entry.startIndex > index) return;
      if (entry.endIndex >= index) {
        if (entry.layer.parent && (entry.startIndex === index || entry.endIndex === index))
          boundary = true;
        active.add(entry.layer);
      }
      visit(entry.right);
    };
    visit(root);
    if (boundary) return null;
    for (const layer of active) if (layer.parent && !active.has(layer.parent)) return null;
    return active;
  };
}

function boundedLine(source, row) {
  const start = source.lineStart(row);
  let end = row + 1 < source.lineCount ? source.lineStart(row + 1) - 1 : source.length;
  if (end > start && source.slice(end - 1, end) === "\r") end--;
  return end - start <= MAX_CONTEXT ? { start, end, text: source.slice(start, end) } : null;
}

function policyContext(source, index, newText) {
  if (newText.length > MAX_CONTEXT) return null;
  const { row, column } = source.positionAt(index);
  const line = boundedLine(source, row);
  const previous = row ? boundedLine(source, row - 1) : { text: "" };
  if (!line || !previous || index > line.end) return null;
  return Object.freeze({
    before: line.text.slice(0, column),
    oldText: "",
    newText: typeof newText === "string" ? newText : newText.slice(0, newText.length),
    after: line.text.slice(column),
    previousLine: previous.text,
    row,
    column,
  });
}

function accepts(policy, context) {
  try {
    const result = policy(context);
    if (result?.then) {
      Promise.resolve(result).catch(() => {});
      return false;
    }
    return result === true;
  } catch {
    return false;
  }
}

function allowsInputProjection(mode, snapshot, changes, check = () => {}) {
  // Arbitrary root-range providers have no ownership stability contract.
  if (!snapshot || snapshot.policy != null || !Array.isArray(changes)) return false;
  const findLayers = containingLayers(snapshot.layers);
  const proof = new Map();
  const policies = new Map();
  const patch = new Patch();
  let source = snapshot.source;
  for (const change of changes) {
    check();
    const { startIndex, oldEndIndex } = change;
    const text = change.newTextSource ?? change.newText ?? change.text;
    if (
      !Number.isSafeInteger(startIndex) ||
      oldEndIndex !== startIndex ||
      startIndex < 0 ||
      startIndex > source.length ||
      text == null ||
      !Number.isSafeInteger(text.length) ||
      typeof text.slice !== "function"
    )
      return false;
    for (let offset = 0; offset < text.length; offset += MAX_CONTEXT) {
      check();
      if (/[^ \t\r\n]/.test(text.slice(offset, offset + MAX_CONTEXT))) return false;
    }
    const point = Point.fromObject(source.positionAt(startIndex));
    const previous = patch.changeForNewPosition(point);
    let originalPoint = point;
    if (previous) {
      if (point.compare(previous.newStart) === 0) originalPoint = previous.oldStart;
      else if (point.compare(previous.newEnd) < 0) return false;
      else
        originalPoint = Point.fromObject(previous.oldEnd).traverse(
          point.traversalFrom(previous.newEnd),
        );
    }
    const originalIndex = snapshot.source.offsetAt(originalPoint);
    const active = findLayers(originalIndex);
    if (!active) return false;
    let context;
    for (const { grammar } of active) {
      check();
      if (!proof.has(grammar)) proof.set(grammar, needsOwnershipProof(grammar, mode));
      if (!proof.get(grammar)) continue;
      context ??= policyContext(source, startIndex, text);
      if (!context || !grammar.inputEditPolicy) return false;
      if (!policies.has(grammar)) {
        try {
          const policy = require(grammar.inputEditPolicy);
          policies.set(grammar, typeof policy === "function" ? policy : null);
        } catch {
          policies.set(grammar, null);
        }
      }
      const policy = policies.get(grammar);
      if (!policy || !accepts(policy, context)) return false;
    }
    const inserted = typeof text === "string" ? new PieceTree(text) : text;
    patch.splice(point, Point.ZERO, inserted.positionAt(inserted.length));
    source = source.replace(startIndex, oldEndIndex, text);
  }
  return true;
}

module.exports = { allowsInputProjection, normalizeInputEditPolicy };
