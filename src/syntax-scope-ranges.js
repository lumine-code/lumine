const Point = require("./point");
const Range = require("./range");
const { boundedQueryRange, QueryBudgetExceeded } = require("./tree-sitter-query-budget");

// Walk bounded query windows instead of resolving a scope at every character.
// Only the analysis owner can consume this iterator; an edit cancels it before
// it can advance any iterator backed by an obsolete tree.
module.exports = function* scopeRanges(mode, requested, signal) {
  const buffer = mode.buffer;
  const range = buffer.clipRange(Range.fromObject(requested));
  const revision = buffer.getTextRevision();
  const epoch = mode.getSyntaxRequestEpoch?.();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (
      mode.destroyed ||
      mode.publicationPending ||
      buffer.getTextRevision() !== revision ||
      mode.getSyntaxRequestEpoch?.() !== epoch
    ) {
      const error = new Error("Syntax scope scan was cancelled");
      error.name = "AbortError";
      throw error;
    }
  };
  assertCurrent();
  if (typeof mode.scopeNameForScopeId !== "function") {
    if (!range.isEmpty()) yield { range, scopes: mode.rootScopeDescriptor.getScopesArray() };
    assertCurrent();
    return;
  }
  const source = mode.document?.capture().text ?? buffer.getTextSnapshot();
  const requestedEndIndex = buffer.characterIndexForPosition(range.end);
  let start = range.start;
  while (start.isLessThan(range.end)) {
    assertCurrent();
    const lastRow = Math.min(start.row + 63, range.end.row);
    const rowEnd = lastRow === range.end.row ? range.end : buffer.clipPosition([lastRow + 1, 0]);
    const rowEndIndex = buffer.characterIndexForPosition(rowEnd);
    const window = boundedQueryRange(
      source,
      buffer.characterIndexForPosition(start),
      rowEndIndex,
      8192,
    );
    const end = buffer.positionForCharacterIndex(
      Math.min(window.endIndex, requestedEndIndex, rowEndIndex),
    );
    const queryStart = buffer.positionForCharacterIndex(window.startIndex);
    const queryEnd = buffer.positionForCharacterIndex(window.endIndex);
    const iterator = mode.buildHighlightIterator({ endPosition: queryEnd });
    const active = [...iterator.seek(queryStart, queryEnd.row)];
    if (iterator.limitedReason) throw new QueryBudgetExceeded(iterator.limitedReason);
    if (iterator.quality && iterator.quality !== "exact")
      throw new QueryBudgetExceeded("inexact-scopes");
    let position = start;
    while (position.isLessThan(end)) {
      assertCurrent();
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
  assertCurrent();
};
