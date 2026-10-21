const Point = require("./point");
const Range = require("./range");

// Walk bounded query windows instead of resolving a scope at every character.
// Only the analysis owner can consume this iterator; an edit cancels it before
// it can advance any iterator backed by an obsolete tree.
module.exports = function* scopeRanges(mode, requested, signal) {
  const buffer = mode.buffer;
  const range = buffer.clipRange(Range.fromObject(requested));
  if (typeof mode.scopeNameForScopeId !== "function") {
    if (!range.isEmpty()) yield { range, scopes: mode.rootScopeDescriptor.getScopesArray() };
    return;
  }
  let start = range.start;
  while (start.isLessThan(range.end)) {
    signal?.throwIfAborted();
    const lastRow = Math.min(start.row + 63, range.end.row);
    const end = lastRow === range.end.row ? range.end : buffer.clipPosition([lastRow + 1, 0]);
    const iterator = mode.buildHighlightIterator();
    const active = [...iterator.seek(start, lastRow)];
    let position = start;
    while (position.isLessThan(end)) {
      signal?.throwIfAborted();
      while (iterator.getPosition().compare(position) <= 0) {
        for (const id of iterator.getCloseScopeIds()) {
          const index = active.lastIndexOf(id);
          if (index >= 0) active.splice(index, 1);
        }
        active.push(...iterator.getOpenScopeIds());
        iterator.moveToSuccessor();
      }
      const boundary = iterator.getPosition();
      const next = boundary.isLessThan(end) ? Point.fromObject(boundary) : end;
      if (!position.isLessThan(next)) break;
      const scopes = active.map((id) => mode.scopeNameForScopeId(id));
      if (
        (!mode.rootLanguageLayer?.rootRangesRestricted ||
          mode.rootLanguageLayer.containsPoint(position)) &&
        scopes[0] !== mode.grammar.scopeName
      )
        scopes.unshift(mode.grammar.scopeName);
      yield { range: new Range(position, next), scopes };
      position = next;
    }
    start = end;
  }
};
