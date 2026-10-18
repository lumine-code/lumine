const caches = new WeakMap();
const MAX_ENTRIES = 16;
const MAX_CAPTURES = 16000;
const CACHEABLE_OPTIONS = new Set([
  "startPosition",
  "endPosition",
  "startIndex",
  "endIndex",
  "maxStartDepth",
  "matchLimit",
]);

// Cache raw captures, never resolved scopes: config and row-context predicates
// must still run for each consumer. A new tree or query cannot reuse old nodes.
function captureQuery(owner, query, tree, options = {}) {
  if (!query || !tree) return [];
  if (Object.keys(options).some((key) => !CACHEABLE_OPTIONS.has(key)))
    return query.captures(tree.rootNode, options);
  let cache = caches.get(owner);
  if (!cache || cache.tree !== tree) {
    cache = { tree, entries: [], size: 0 };
    caches.set(owner, cache);
  }
  const key = Object.keys(options)
    .sort()
    .map((name) => {
      const value = options[name];
      return `${name}:${value && typeof value === "object" ? `${value.row},${value.column}` : value}`;
    })
    .join(";");
  const index = cache.entries.findIndex((entry) => entry.query === query && entry.key === key);
  if (index !== -1) {
    const [entry] = cache.entries.splice(index, 1);
    cache.entries.push(entry);
    return entry.captures;
  }
  const captures = query.captures(tree.rootNode, options);
  if (captures.length > MAX_CAPTURES || query.didExceedMatchLimit?.()) return captures;
  while (
    cache.entries.length &&
    (cache.entries.length >= MAX_ENTRIES || cache.size + captures.length > MAX_CAPTURES)
  ) {
    cache.size -= cache.entries.shift().captures.length;
  }
  cache.entries.push({ query, key, captures: Object.freeze(captures) });
  cache.size += captures.length;
  return captures;
}

module.exports = captureQuery;
