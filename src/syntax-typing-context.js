const filters = require("./typing-indentation-rules");
const compare = (a, b) => a.row - b.row || a.column - b.column;
const contains = (range, point) =>
  compare(range.start, point) <= 0 && compare(point, range.end) < 0;

// The worker supplies ownership; a grammar-owned synchronous policy proves
// that an edit preserves it. Never infer a stable language from stale colors.
function capture(mode) {
  if (mode.publicationPending) return null;
  const root = mode.rootLanguageLayer;
  if (
    !root ||
    !root.grammar.contentEditPolicies?.size ||
    Object.keys(root.grammar.injectionPointsByType).length
  )
    return null;
  const rootRules = filters.forGrammar(root.grammar);
  if (!rootRules) return null;
  const contexts = [];
  let count = 0;
  for (const marker of root.childLayerMarkers) {
    if (contexts.length === 128) return null;
    const layer = marker.languageLayer;
    if (!layer || layer.destroyed) return null;
    count += layer.currentRangesLayer.getMarkerCount();
    if (count > 128) return null;
    contexts.push({
      owner: root.grammar.scopeName,
      // A target-owned content filter can change eligibility independently of
      // the parent's lexical policy. Keep that decision with the parser.
      policy: layer.grammar.injectionContentRegex
        ? null
        : (layer.injectionPoint.contentEditPolicy ?? null),
      rules: filters.forMode(mode, layer.grammar),
      ranges: layer.getCurrentRanges().map(({ start, end }) => ({
        start: { row: start.row, column: start.column },
        end: { row: end.row, column: end.column },
      })),
    });
  }
  return contexts.length ? { rootRules, contexts } : null;
}

function permits(snapshot, registry, range, newText, oldLine, { indentation = true } = {}) {
  if (!snapshot || range.start.row !== range.end.row || /[\r\n]/.test(newText)) return false;
  if (oldLine.length > 4096 || oldLine.length + newText.length > 4096) return false;
  const before = oldLine.slice(0, range.start.column);
  const oldText = oldLine.slice(range.start.column, range.end.column);
  const after = oldLine.slice(range.end.column);
  const nextLine = before + newText + after;
  if (indentation && filters.mayMatch(snapshot.rootRules, nextLine)) return false;
  const first = oldLine.search(/\S/);
  if (first < 0) return false;
  const firstPoint = { row: range.start.row, column: first };
  let matched = false;
  for (const context of snapshot.contexts) {
    if (
      context.ranges.some((part) =>
        [part.start, part.end].some(
          (point) => compare(range.start, point) <= 0 && compare(point, range.end) <= 0,
        ),
      )
    )
      return false;
    if (!context.ranges.some((part) => contains(part, firstPoint) || contains(part, range.start)))
      continue;
    // Keep boundary edits and edits spanning an excluded source hole on the
    // exact prepared path, even if a provider would accept their characters.
    if (
      !context.ranges.some(
        (part) =>
          contains(part, firstPoint) &&
          compare(part.start, range.start) < 0 &&
          compare(range.end, part.end) < 0,
      )
    )
      return false;
    if (indentation && filters.mayMatch(context.rules, nextLine)) return false;
    const grammar = registry.grammarForScopeName(context.owner);
    const file = grammar?.contentEditPolicies?.get(context.policy);
    if (!file) return false;
    try {
      const policy = require(file);
      if (typeof policy !== "function") return false;
      const accepted = policy(Object.freeze({ before, oldText, newText, after }));
      if (accepted?.then) Promise.resolve(accepted).catch(() => {});
      if (accepted !== true) return false;
    } catch {
      return false;
    }
    matched = true;
  }
  return matched;
}

function advance(snapshot, registry, change, buffer) {
  if (!snapshot) return null;
  const { oldRange, newRange } = change;
  if (oldRange.start.row !== oldRange.end.row || newRange.start.row !== newRange.end.row)
    return null;
  const row = oldRange.start.row;
  if (buffer.lineLengthForRow(row) > 4096 || oldRange.end.column - oldRange.start.column > 4096)
    return null;
  const line = buffer.lineForRow(row);
  const text = line.slice(newRange.start.column, newRange.end.column);
  const oldLine =
    line.slice(0, oldRange.start.column) + change.oldText + line.slice(newRange.end.column);
  if (!permits(snapshot, registry, oldRange, text, oldLine, { indentation: false })) return null;
  const delta = newRange.end.column - oldRange.end.column;
  for (const context of snapshot.contexts)
    for (const part of context.ranges)
      for (const point of [part.start, part.end])
        if (point.row === row && point.column >= oldRange.end.column) point.column += delta;
  return snapshot;
}

module.exports = { capture, permits, advance };
