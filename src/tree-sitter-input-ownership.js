const { isDeepStrictEqual } = require("node:util");

// A declined grammar policy requires discovery, not different indentation
// semantics. One settled draft forest can prove that the projected original
// owners still govern the same source. Compare language ownership only:
// the raw draft's temporarily unindented statement AST is not authoritative.
function matchInputOwnership(snapshot, discovered, target, map, check) {
  if (
    !snapshot.complete ||
    !discovered?.complete ||
    !discovered.source.equals(target) ||
    !isDeepStrictEqual(snapshot.policy, discovered.policy)
  )
    return null;
  const grammarIds = new Map();
  const grammarId = (grammar) => {
    if (!grammarIds.has(grammar)) grammarIds.set(grammar, grammarIds.size);
    return grammarIds.get(grammar);
  };
  const projectedOffset = (offset, right) =>
    target.offsetAt(map.mapPoint(snapshot.source.positionAt(offset), right));
  const variants = (offset) => [
    ...new Set([projectedOffset(offset, false), projectedOffset(offset, true)]),
  ];
  const key = (entry, owner = entry.owner) => {
    return JSON.stringify([
      grammarId(entry.grammar),
      entry.generation,
      entry.languageString,
      owner && [owner.startIndex, owner.endIndex],
    ]);
  };
  const ownerKeys = (entry) => {
    if (!entry.owner) return [key(entry)];
    const keys = [];
    for (const startIndex of variants(entry.owner.startIndex))
      for (const endIndex of variants(entry.owner.endIndex))
        keys.push(key(entry, { startIndex, endIndex }));
    return keys;
  };
  const sameRanges = (previous, current) => {
    if (!previous || !current) return previous === current;
    return (
      previous.length === current.length &&
      previous.every(
        (range, index) =>
          variants(range.startIndex).includes(current[index].startIndex) &&
          variants(range.endIndex).includes(current[index].endIndex),
      )
    );
  };
  const children = new Map();
  for (const entry of discovered.layers) {
    check();
    let siblings = children.get(entry.parent);
    if (!siblings) children.set(entry.parent, (siblings = new Map()));
    const identity = key(entry);
    let bucket = siblings.get(identity);
    if (!bucket) siblings.set(identity, (bucket = []));
    bucket.push(entry);
  }
  const matched = new Map();
  const claimed = new Map();
  const ambiguous = new Set();
  for (const entry of snapshot.layers) {
    check();
    const parent = entry.parent ? matched.get(entry.parent) : null;
    if (entry.parent && !parent) continue;
    const candidates = new Set(
      ownerKeys(entry).flatMap((identity) => children.get(parent)?.get(identity) ?? []),
    );
    const matches = [];
    for (const candidate of candidates) {
      if (
        entry.languageString !== candidate.languageString ||
        entry.injectionPoint !== candidate.injectionPoint ||
        !isDeepStrictEqual(entry.injectionProperties, candidate.injectionProperties) ||
        !sameRanges(entry.ranges, candidate.ranges)
      )
        continue;
      matches.push(candidate);
    }
    if (matches.length !== 1) continue;
    const [match] = matches;
    if (ambiguous.has(match)) continue;
    if (claimed.has(match)) {
      matched.delete(claimed.get(match));
      claimed.delete(match);
      ambiguous.add(match);
      continue;
    }
    matched.set(entry, match);
    claimed.set(match, entry);
  }
  // A later sibling can expose an ambiguous owner. Prune its descendants too
  // instead of retaining a match through a parent whose identity was revoked.
  const result = new Map();
  for (const entry of discovered.layers) {
    check();
    const previous = claimed.get(entry);
    if (previous && (!entry.parent || result.get(entry.parent) === previous.parent))
      result.set(entry, previous);
  }
  return result;
}

module.exports = matchInputOwnership;
