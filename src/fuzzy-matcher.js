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
 * @public
 * @status essential
 *
 * A reusable candidate set returned by {@link fuzzyMatcher.setCandidates}.
 * Query it with {@link #match}, or replace its candidates with
 * {@link #setCandidates}. The `ignoreDiacritics` flag is fixed when the matcher
 * is created.
 */
class Matcher {
  constructor(fuzzyMatcher) {
    this.fuzzyMatcher = fuzzyMatcher;
  }

  /**
   * @public
   * @status essential
   *
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
   */
  match(query, options = {}) {
    let { numThreads, algorithm } = options;
    numThreads ||= DEFAULT_NUM_THREADS;
    algorithm ||= "fuzzaldrin";
    return this.fuzzyMatcher.match(query, { ...options, numThreads, algorithm });
  }

  /**
   * @public
   * @status essential
   *
   * Replaces this matcher's candidates.
   *
   * @param {Array<String>} candidates - The new candidates.
   * @returns {Matcher} This matcher.
   */
  setCandidates(candidates) {
    return setCandidates(this, candidates);
  }
}

/**
 * @public
 * @status essential
 *
 * Fuzzy matching utilities used by autocomplete, file search and the command
 * palette. Available as `lumine.tools.fuzzyMatcher`.
 *
 * Use {@link .setCandidates} to create a reusable {@link Matcher} for an array
 * of candidates. {@link .match} and {@link .score} match one candidate without
 * creating a matcher yourself.
 *
 * @memberof lumine.tools
 */
const fuzzyMatcher = {
  /**
   * @public
   * @status essential
   *
   * Create a matcher for string candidates, or replace the candidates of an
   * existing {@link Matcher}. The replacement preserves its construction
   * options.
   *
   * ```js
   * const matcher = lumine.tools.fuzzyMatcher.setCandidates(['hello', 'world'])
   * matcher.match('he')
   * lumine.tools.fuzzyMatcher.setCandidates(matcher, ['hello', 'hope'])
   * ```
   *
   * @param {Matcher|Array<String>} matcherOrCandidates - An existing matcher or
   *   candidates for a new one.
   * @param {Array<String>|Object} [candidates] - Replacement candidates when the
   *   first argument is a matcher; construction options when it is an array.
   *   Set `ignoreDiacritics: true` in those options for accent-insensitive matching.
   * @param {Object} [_options] - Retained for compatibility; ignored.
   * @returns {Matcher} The created or updated matcher.
   */
  setCandidates: setCandidates,

  /**
   * @public
   * @status essential
   *
   * Score a single candidate against a query.
   *
   * @param {String} candidate - The candidate to match.
   * @param {String} query - The search query.
   * @param {Object} [opts] - The options accepted by {@link Matcher#match}, plus
   *   `ignoreDiacritics` for accent-insensitive matching.
   * @returns {Number} The score from 0 to 1, or 0 when there is no match.
   */
  score(candidate, query, opts = {}) {
    return this.match(candidate, query, opts)?.score || 0;
  },

  /**
   * @public
   * @status essential
   *
   * Match a single candidate against a query. Accent-insensitive matching
   * reports character indexes against the original candidate.
   *
   * @param {String} candidate - The candidate to match.
   * @param {String} query - The search query.
   * @param {Object} [opts] - The options accepted by {@link Matcher#match}, plus
   *   `ignoreDiacritics` for accent-insensitive matching.
   * @returns {Object|undefined} The match with `id`, `value`, `score` and optional
   *   character indexes, or `undefined` when there is no match.
   */
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
