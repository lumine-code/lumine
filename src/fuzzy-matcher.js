const os = require("os");
const fuzzyNative = require("@lumine-code/fuzzy-native");

// Leave headroom for the renderer; the native module only fans out across
// threads for candidate sets of 10000 or more anyway.
const DEFAULT_NUM_THREADS = Math.max(1, Math.min(8, os.availableParallelism() - 1));

// Cached single-candidate matchers for the one-shot match()/score() helpers,
// keyed by the construction-time ignoreDiacritics flag, so per-row highlight
// loops don't allocate a fresh native Matcher on every call.
const singleCandidateMatchers = new Map();

/**
 * Sets the candidates for a new matcher, or sets the candidates for an existing
 * matcher. Returns a `Matcher` that can be used to query for candidates.
 *
 * ## Examples
 * ```js
 * const matcher = lumine.tools.fuzzyMatcher.setCandidates(["hello", "world"])
 * matcher.match('he') // => will return [{value: "hello", score: <number>}]
 * lumine.tools.fuzzyMatcher.setCandidates(matcher, ["hello", "hope"])
 * matcher.match('he') // => will now return "hope" too, but it'll be at
 *                    // second position with a lower score
 * ```
 *
 * @param {Matcher|Array<String>} matcherOrCandidates - Either a `Matcher`
 *   returned from a previous call to `setCandidates`, or an array of string
 *   candidates to be filtered.
 * @param {Array<String>|Object} [candidates] - Candidates for an existing
 *   matcher, or options for a new matcher. The `ignoreDiacritics` option enables
 *   accent-insensitive matching and is fixed at construction time.
 * @param {Object} [_options] - Retained for compatibility.
 * @returns {Matcher} A matcher that can query the candidates.
 * @private
 */
function setCandidates(matcherOrCandidates, candidates, _options) {
  if (Array.isArray(candidates)) {
    // Reuse an existing `Matcher`. Construction-time options (e.g.
    // `ignoreDiacritics`) already live on it and don't need re-passing.
    matcherOrCandidates.fuzzyMatcher.setCandidates(
      [...Array(candidates.length).keys()],
      candidates,
    );
    return matcherOrCandidates;
  } else {
    // Create a new `Matcher`. Here `candidates` (the second arg) is actually
    // the options object, if any.
    const opts = candidates || {};
    return new Matcher(
      new fuzzyNative.Matcher(
        [...Array(matcherOrCandidates.length).keys()],
        matcherOrCandidates,
        opts,
      ),
    );
  }
}

/**
 * The result from a call to `fuzzyMatcher.setCandidates`.
 *
 * @private
 */
class Matcher {
  constructor(fuzzyMatcher) {
    this.fuzzyMatcher = fuzzyMatcher;
  }

  /**
   * Matches the current candidates to a string query.
   *
   * Each returned object contains the candidate `id`, its original `value`, and
   * a `score` from 0 to 1. When `recordMatchIndexes` is enabled, it also contains
   * the character indexes used for highlighting.
   *
   * @param {String} query - The query used to filter the candidates.
   * @param {Object} [options] - Search options.
   * @param {"fuzzaldrin"|"command-t"} [options.algorithm="fuzzaldrin"] - The
   *   scoring algorithm. `fuzzaldrin` uses acronym, consecutive-run,
   *   basename-aware path scoring, and optional query characters. `command-t`
   *   is the path-tuned alternative.
   * @param {Number} [options.maxResults=Infinity] - The maximum number of
   *   results. This does not affect filtering speed.
   * @param {Boolean} [options.recordMatchIndexes=false] - Include character
   *   indexes for highlighting.
   * @param {Number} [options.numThreads] - Worker threads to use. Defaults to
   *   most available cores, capped at 8.
   * @param {Number} [options.maxGap=Infinity] - With `command-t`, the maximum
   *   gap between consecutive letters.
   * @param {Boolean} [options.usePathScoring=true] - With `fuzzaldrin`, blend
   *   basename and full-path scores by directory depth.
   * @param {Boolean} [options.useExtensionBonus=false] - With `fuzzaldrin`,
   *   prefer matching file extensions.
   * @returns {Array<Object>} Matching candidates ordered by relevance.
   * @private
   */
  match(query, options = {}) {
    let { numThreads, algorithm } = options;
    numThreads ||= DEFAULT_NUM_THREADS;
    algorithm ||= "fuzzaldrin";
    return this.fuzzyMatcher.match(query, { ...options, numThreads, algorithm });
  }

  /**
   * Replaces this matcher's candidates.
   *
   * @param {Array<String>} candidates - The new candidates.
   * @returns {Matcher} This matcher.
   * @private
   */
  setCandidates(candidates) {
    return setCandidates(this, candidates);
  }
}

/**
 * The `fuzzyMatcher` API, the same used in the autocomplete,
 *   fuzzy file search, command palette, etc.
 *   An instance of this API is available via the `lumine.tools.fuzzyMatcher` global.
 *
 *   This API have two parts - the filtering of an array of candidates, and the
 *   scoring. Scoring is done via `fuzzyMatcher.score`, and filtering is done
 *   by returning a new `Matcher` using `fuzzyMatcher.setCandidates`, then
 *   calling `Matcher#match`. You can _also use_ `fuzzyMatcher.match` to match
 *   a single candidate; it uses the same API and options as `Matcher#match`.
 *
 * @public
 * @api-status Essential
 */
const fuzzyMatcher = {
  setCandidates: setCandidates,

  // Same as `setCandidates` passing a single candidate, and returning only
  // the score. It can return `0` if there's no match. Accepts the same
  // options as `Matcher#match` plus `ignoreDiacritics`.
  score(candidate, query, opts = {}) {
    return this.match(candidate, query, opts)?.score || 0;
  },

  // The same as `setCandidates` with a single candidate. Returns just the
  // match, if there's one (can return `undefined`).
  //
  // Accepts `ignoreDiacritics` in `opts` to fold accents before matching
  // (e.g. "cafe" matches "café"); indexes are reported against the original.
  match(candidate, query, opts = {}) {
    const key = !!opts.ignoreDiacritics;
    let matcher = singleCandidateMatchers.get(key);
    if (matcher) {
      matcher.setCandidates([candidate]);
    } else {
      matcher = setCandidates([candidate], { ignoreDiacritics: key });
      singleCandidateMatchers.set(key, matcher);
    }
    return matcher.match(query, opts)[0];
  },
};

module.exports = fuzzyMatcher;
