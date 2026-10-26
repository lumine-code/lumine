const caches = new WeakMap();
const MAX_ENTRIES = 16;
const MAX_CAPTURES = 16000;
const MAX_BYTES = 2 * 1024 * 1024;
const CACHEABLE_OPTIONS = new Set([
  "startPosition",
  "endPosition",
  "startIndex",
  "endIndex",
  "maxStartDepth",
  "matchLimit",
]);

// Conservative JS retention estimate, not a heap measurement. Capture/node
// wrappers, array slots, names and property strings count; the shared query,
// language and WASM tree do not. Never read node.text to estimate a capture.
function estimateBytes(captures, key) {
  let bytes = 96 + key.length * 2 + captures.length * 8;
  const properties = new Set();
  for (const capture of captures) {
    bytes += 96 + (capture.node ? 128 : 0) + (capture.name?.length ?? 0) * 2;
    for (const name of ["setProperties", "assertedProperties", "refutedProperties"]) {
      const value = capture[name];
      if (!value || properties.has(value)) continue;
      properties.add(value);
      bytes += 48;
      for (const [key, entry] of Object.entries(value))
        bytes += 24 + key.length * 2 + (typeof entry === "string" ? entry.length * 2 : 8);
    }
  }
  return bytes;
}

// Cache raw captures, never resolved scopes: config and row-context predicates
// must still run for each consumer. A new tree or query cannot reuse old nodes.
function captureQuery(owner, query, tree, options = {}, execute) {
  if (!query || !tree) return [];
  if (Object.keys(options).some((key) => !CACHEABLE_OPTIONS.has(key)))
    return execute
      ? execute(query, tree.rootNode, options)
      : query.captures(tree.rootNode, options);
  let cache = caches.get(owner);
  if (!cache || cache.tree !== tree) {
    cache = { tree, entries: [], size: 0, estimatedBytes: 0, hits: 0, misses: 0 };
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
    cache.hits++;
    const [entry] = cache.entries.splice(index, 1);
    cache.entries.push(entry);
    return entry.captures;
  }
  cache.misses++;
  const captures = execute
    ? execute(query, tree.rootNode, options)
    : query.captures(tree.rootNode, options);
  if (captures === null || captures.length > MAX_CAPTURES || query.didExceedMatchLimit?.())
    return captures;
  const estimatedBytes = estimateBytes(captures, key);
  if (estimatedBytes > MAX_BYTES) return captures;
  while (
    cache.entries.length &&
    (cache.entries.length >= MAX_ENTRIES ||
      cache.size + captures.length > MAX_CAPTURES ||
      cache.estimatedBytes + estimatedBytes > MAX_BYTES)
  ) {
    const removed = cache.entries.shift();
    cache.size -= removed.captures.length;
    cache.estimatedBytes -= removed.estimatedBytes;
  }
  cache.entries.push({ query, key, captures: Object.freeze(captures), estimatedBytes });
  cache.size += captures.length;
  cache.estimatedBytes += estimatedBytes;
  return captures;
}

captureQuery.clear = (owner) => caches.delete(owner);
captureQuery.getStats = (owner) => {
  const cache = caches.get(owner);
  return {
    estimatedBytes: cache?.estimatedBytes ?? 0,
    maxBytes: MAX_BYTES,
    captures: cache?.size ?? 0,
    entries: cache?.entries.length ?? 0,
    hits: cache?.hits ?? 0,
    misses: cache?.misses ?? 0,
  };
};

module.exports = captureQuery;
