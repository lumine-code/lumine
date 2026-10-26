const DEFAULTS = Object.freeze({
  timeoutMs: 25,
  matchLimit: 4096,
  maxResults: 16000,
  maxCaptures: 16000,
  maxPredicateTextLength: 65536,
  maxWindowLength: 16384,
});

let predicateTextBudget = null;

class QueryBudgetExceeded extends Error {
  constructor(reason) {
    super(`Syntax query exceeded its ${reason} budget.`);
    this.name = "QueryBudgetExceeded";
    this.code = "ERR_SYNTAX_QUERY_BUDGET";
    this.reason = reason;
  }
}

function limit(value, fallback, name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  value ??= fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}

function countLimit(value, fallback, name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  value = limit(value, fallback, name, minimum, maximum);
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer.`);
  return value;
}

// Called by the bounded Node.text accessor, also covering custom scope tests
// that inspect a parent or sibling rather than the originally captured node.
function checkPredicateTextLength(length) {
  if (!predicateTextBudget) return;
  if (length > predicateTextBudget.maxLength) throw new QueryBudgetExceeded("predicate-text-limit");
  predicateTextBudget.check();
}

// Synchronous only: a scope-resolver pass must finish before the context can be
// released. A caller discards the window if complete is false; no predicate is
// ever evaluated against a truncated prefix or assigned a guessed truth value.
function withPredicateTextBudget(callback, budget = {}) {
  const maxLength = countLimit(
    budget.maxPredicateTextLength,
    DEFAULTS.maxPredicateTextLength,
    "maxPredicateTextLength",
    0,
  );
  const now = budget.now ?? (() => performance.now());
  const deadline = now() + limit(budget.timeoutMs, DEFAULTS.timeoutMs, "timeoutMs", 0);
  const previous = predicateTextBudget;
  const check = () => {
    if (budget.signal?.aborted || budget.isCancelled?.())
      throw new QueryBudgetExceeded("cancelled");
    if (now() >= deadline) throw new QueryBudgetExceeded("timeout");
  };
  predicateTextBudget = { maxLength, check };
  try {
    check();
    const value = callback();
    if (value && typeof value.then === "function")
      throw new TypeError("Predicate text budgets require a synchronous callback.");
    check();
    return { value, complete: true, reason: null };
  } catch (error) {
    if (!(error instanceof QueryBudgetExceeded)) throw error;
    return { value: null, complete: false, reason: error.reason };
  } finally {
    predicateTextBudget = previous;
  }
}

// Query.captures/matches collect their raw results in WASM before JS receives
// them. matchLimit bounds in-progress matches, NOT returned captures. A caller
// must also bound its query window; this wrapper bounds traversal time and JS
// predicate/result work, but cannot impose a hard WASM allocation ceiling.
//
// Incomplete exact results are null. Only painting callers may explicitly opt
// into partial results, and must continue to propagate complete:false.
function runQuery(query, node, options = {}, budget = {}) {
  const method = budget.method ?? "captures";
  if (method !== "captures" && method !== "matches")
    throw new TypeError("The query method must be captures or matches.");
  const timeoutMs = limit(budget.timeoutMs, DEFAULTS.timeoutMs, "timeoutMs", 0);
  const maxResults = countLimit(budget.maxResults, DEFAULTS.maxResults, "maxResults");
  const maxCaptures = countLimit(budget.maxCaptures, DEFAULTS.maxCaptures, "maxCaptures");
  const maxPredicateTextLength = countLimit(
    budget.maxPredicateTextLength,
    DEFAULTS.maxPredicateTextLength,
    "maxPredicateTextLength",
    0,
  );
  const matchBudget = countLimit(budget.matchLimit, DEFAULTS.matchLimit, "matchLimit", 1, 65536);
  const matchLimit = Math.min(
    matchBudget,
    countLimit(options.matchLimit, matchBudget, "options.matchLimit", 1, 65536),
  );
  const now = budget.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  let reason = null;
  let deferredError = null;
  let acceptedResults = 0;
  let acceptedCaptures = 0;
  const stop = (value) => {
    reason ??= value;
    return true;
  };
  const stopped = () => {
    if (reason) return true;
    try {
      if (budget.signal?.aborted || budget.isCancelled?.()) return stop("cancelled");
      if (now() >= deadline) return stop("timeout");
    } catch (error) {
      deferredError ??= error;
      return stop("callback-error");
    }
    return false;
  };
  const progressCallback = (state) => {
    if (stopped()) return true;
    try {
      if (options.progressCallback?.(state)) return stop("cancelled");
    } catch (error) {
      deferredError ??= error;
      return stop("callback-error");
    }
    return false;
  };
  const originalPredicates = query.textPredicates;
  let rawResults = [];
  if (!stopped()) {
    // Narrow compatibility seam for pinned web-tree-sitter 0.27.1. Its query
    // methods do not free their raw WASM results when a JS predicate throws.
    // Defer such errors until the method has returned and released that memory.
    // Never evaluate a predicate on truncated text: omit the match and mark the
    // entire exact result incomplete instead. Tests exercise the real binding.
    if (Array.isArray(originalPredicates)) {
      query.textPredicates = originalPredicates.map((predicates) => [
        (captures) => {
          if (stopped()) return false;
          const captureCount = method === "captures" ? 1 : captures.length;
          // The Node.text accessor checks the active budget at the actual read,
          // rather than rejecting every large capture. A pattern may capture a
          // huge container but only test the text of its tiny key/identifier.
          try {
            if (!predicates.every((predicate) => predicate(captures))) return false;
          } catch (error) {
            if (error instanceof QueryBudgetExceeded) return !stop(error.reason);
            deferredError ??= error;
            return !stop("predicate-error");
          }
          if (stopped()) return false;
          if (acceptedResults >= maxResults) return !stop("result-limit");
          if (captureCount > maxCaptures - acceptedCaptures) return !stop("capture-limit");
          acceptedResults++;
          acceptedCaptures += captureCount;
          return true;
        },
      ]);
    }
    const previousTextBudget = predicateTextBudget;
    predicateTextBudget = {
      maxLength: maxPredicateTextLength,
      check() {
        if (stopped()) throw new QueryBudgetExceeded(reason);
      },
    };
    try {
      rawResults = query[method](node, { ...options, matchLimit, progressCallback });
      if (query.didExceedMatchLimit?.()) stop("match-limit");
      stopped();
    } finally {
      predicateTextBudget = previousTextBudget;
      if (Array.isArray(originalPredicates)) query.textPredicates = originalPredicates;
    }
  }
  if (deferredError) throw deferredError;

  // Also enforce output limits for alternate query implementations without the
  // web binding's predicate seam. A match is atomic; never trim its captures.
  const results = [];
  let captureCount = 0;
  for (const result of rawResults) {
    if (results.length >= maxResults) {
      stop("result-limit");
      break;
    }
    const count = method === "captures" ? 1 : result.captures.length;
    if (count > maxCaptures - captureCount) {
      stop("capture-limit");
      break;
    }
    results.push(result);
    captureCount += count;
  }
  return {
    results: reason && !budget.allowPartial ? null : results,
    complete: reason === null,
    reason,
    resultCount: results.length,
    captureCount,
  };
}

function isSplitPair(source, index) {
  if (index <= 0 || index >= source.length) return false;
  const pair = source.slice(index - 1, index + 1);
  const first = pair.charCodeAt(0);
  const second = pair.charCodeAt(1);
  return (
    (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ||
    (first === 13 && second === 10)
  );
}

// Bounds by UTF-16 length, not row count: one minified row can be gigabytes.
// source is a string or snapshot exposing length and slice(start,end). Only
// two-character boundary reads are needed, never a full line or document copy.
// The caller decides whether clipped painting is acceptable; exact consumers
// must not mistake a clipped range for a complete document query.
function boundedQueryRange(source, startIndex, endIndex, maxLength = DEFAULTS.maxWindowLength) {
  maxLength = countLimit(maxLength, DEFAULTS.maxWindowLength, "maxLength", 2);
  startIndex = Math.max(0, Math.min(source.length, Math.floor(startIndex)));
  endIndex = Math.max(startIndex, Math.min(source.length, Math.floor(endIndex)));
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex))
    throw new RangeError("Query range indices must be finite.");
  const requestedStart = startIndex;
  const requestedEnd = endIndex;
  if (startIndex === endIndex)
    return {
      startIndex,
      endIndex,
      complete: true,
      clipped: false,
      adjusted: false,
      empty: true,
    };
  if (isSplitPair(source, startIndex)) startIndex--;
  let end = Math.min(endIndex, startIndex + maxLength);
  if (isSplitPair(source, end)) {
    if (end + 1 <= startIndex + maxLength) end++;
    else end--;
  }
  return {
    startIndex,
    endIndex: end,
    complete: end >= requestedEnd,
    clipped: end < requestedEnd,
    adjusted: startIndex !== requestedStart || end !== requestedEnd,
    empty: startIndex === end,
  };
}

module.exports = {
  runQuery,
  boundedQueryRange,
  withPredicateTextBudget,
  checkPredicateTextLength,
  QueryBudgetExceeded,
  DEFAULTS,
};
