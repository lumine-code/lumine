// Parse boundaries subdivide existing ranges without changing which text belongs
// to the language. Sparse cuts prevent repeated edits from retaining tiny pieces.
const MINIMUM_BOUNDARY_DISTANCE = 1024;
const MAX_INDEX = 0x7fffffff;

const DOCUMENT_RANGE = Object.freeze({
  startIndex: 0,
  startPosition: Object.freeze({ row: 0, column: 0 }),
  endIndex: MAX_INDEX,
  endPosition: Object.freeze({ row: MAX_INDEX, column: MAX_INDEX }),
});

function splitIncludedRanges(
  includedRanges,
  boundaries,
  minimumDistance = MINIMUM_BOUNDARY_DISTANCE,
) {
  if (!boundaries.length || includedRanges?.length === 0) return includedRanges;
  const cuts = boundaries
    .filter(
      ({ index, position }) =>
        Number.isSafeInteger(index) &&
        index > 0 &&
        index < MAX_INDEX &&
        Number.isSafeInteger(position?.row) &&
        position.row >= 0 &&
        Number.isSafeInteger(position?.column) &&
        position.column >= 0,
    )
    .sort((left, right) => left.index - right.index);
  const ranges = includedRanges ?? [DOCUMENT_RANGE];
  const result = [];
  let cursor = 0;
  let changed = false;
  for (const range of ranges) {
    let startIndex = range.startIndex;
    let startPosition = range.startPosition;
    while (cursor < cuts.length && cuts[cursor].index <= startIndex) cursor++;
    while (cursor < cuts.length && cuts[cursor].index < range.endIndex) {
      const cut = cuts[cursor++];
      if (cut.index - startIndex < minimumDistance) continue;
      result.push({ startIndex, startPosition, endIndex: cut.index, endPosition: cut.position });
      startIndex = cut.index;
      startPosition = cut.position;
      changed = true;
    }
    result.push({
      startIndex,
      startPosition,
      endIndex: range.endIndex,
      endPosition: range.endPosition,
    });
  }
  return changed ? result : includedRanges;
}

function smallFragmentRegions(fragments) {
  const result = [];
  let first = null;
  let previous = null;
  let count = 0;
  for (const fragment of fragments) {
    const length = fragment.endIndex - fragment.startIndex;
    if (
      !Number.isSafeInteger(fragment.startIndex) ||
      !Number.isSafeInteger(fragment.endIndex) ||
      length <= 0 ||
      length >= MINIMUM_BOUNDARY_DISTANCE
    ) {
      first = previous = null;
      count = 0;
      continue;
    }
    if (
      !first ||
      previous.endIndex !== fragment.startIndex ||
      fragment.endIndex - first.startIndex > 4 * MINIMUM_BOUNDARY_DISTANCE
    ) {
      first = fragment;
      count = 0;
    }
    previous = fragment;
    if (++count === 64) {
      result.push({
        startIndex: first.startIndex,
        oldEndIndex: fragment.endIndex,
        newEndIndex: fragment.endIndex,
        startPosition: first.startPosition,
        oldEndPosition: fragment.endPosition,
        newEndPosition: fragment.endPosition,
      });
      if (result.length === 8) break;
      first = previous = null;
      count = 0;
    }
  }
  return result;
}

module.exports = { MINIMUM_BOUNDARY_DISTANCE, smallFragmentRegions, splitIncludedRanges };
