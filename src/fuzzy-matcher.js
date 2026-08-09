const os = require("os");
const fuzzyNative = require("@lumine-code/fuzzy-native");

// Leave headroom for the renderer; the native module only fans out across
// threads for candidate sets of 10000 or more anyway.
const DEFAULT_NUM_THREADS = Math.max(1, Math.min(8, os.availableParallelism() - 1));

// Cached single-candidate matchers for the one-shot match()/score() helpers,
// keyed by the construction-time ignoreDiacritics flag, so per-row highlight
// loops don't allocate a fresh native Matcher on every call.
const singleCandidateMatchers = new Map();

/*
  # Name: setCandidates
  # Type: ClassMethod

  Sets the candidates for a new matcher, or sets the candidates for an existing
  matcher. Returns a {Matcher} that can be used to query for candidates.

  * `matcherOrCandidates` - either a {Matcher} returned from a previous call
    from `setCandidates`, or an array of string candidates to be filtered
  * `candidates` - an array of string candidates to be filtered
  * `options` - only used when creating a new {Matcher} (i.e. when
    `matcherOrCandidates` is an array). Supports `ignoreDiacritics` (Boolean)
    to enable accent-insensitive matching. Fixed at construction time.

  ## Examples
  ```js
  const matcher = lumine.tools.fuzzyMatcher.setCandidates(["hello", "world"])
  matcher.match('he') // => will return [{value: "hello", score: <number>}]
  lumine.tools.fuzzyMatcher.setCandidates(matcher, ["hello", "hope"])
  matcher.match('he') // => will now return "hope" too, but it'll be at
                     // second position with a lower score
  ```
*/
function setCandidates(matcherOrCandidates, candidates, _options) {
  if (Array.isArray(candidates)) {
    // Reuse an existing {Matcher}. Construction-time options (e.g.
    // `ignoreDiacritics`) already live on it and don't need re-passing.
    matcherOrCandidates.fuzzyMatcher.setCandidates(
      [...Array(candidates.length).keys()],
      candidates,
    );
    return matcherOrCandidates;
  } else {
    // Create a new {Matcher}. Here `candidates` (the second arg) is actually
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

/*
  # Name: Matcher
  # Type: Class

  The result from a call to {fuzzyMatcher.setCandidates}.
*/
class Matcher {
  constructor(fuzzyMatcher) {
    this.fuzzyMatcher = fuzzyMatcher;
  }

  /*
    # Name: match
    # Type: InstanceMethod

    Matches the current candidates to a query. Query must be a string

    * `query` A string query to filter the pre-defined candidates
    * `options` Key/map to customize the details of the search. All keys are
      optional, meaning they all have defaults
      * `algorithm` Either "fuzzaldrin" or "command-t". Defaults to "fuzzaldrin"
        (the **opposite** of @lumine-code/fuzzy-native), a native port of the
        fuzzaldrin-plus scorer: acronym and consecutive-run bonuses,
        basename-aware path scoring, and " _-:/\" as optional query
        characters. "command-t" is the path-tuned alternative
      * `maxResults` The number of results to return. Defaults to `Infinity`,
        meaning that it'll return _all results_ that did match. Note
        that this has no effect on filtering speed
      * `recordMatchIndexes` If `true`, also returns `matchIndexes`, an array
        of numbers where each number is the index (0-based) of the character
        that was matched. Defaults to `false`
      * `numThreads` The number of threads to filter. Defaults to most of the
        machine's cores, capped at 8
      * `maxGap` (only "command-t") The number of maximum "character gap" between
        consecutive letters. A smaller gap means a faster result. Defaults to
        Infinite
      * `usePathScoring` (only "fuzzaldrin") Whether to blend basename and
        full-path scores by directory depth. Defaults to `true`
      * `useExtensionBonus` (only "fuzzaldrin") Whether to award a bonus for
        matching the file extension (query "mf.h" prefers "myFile.h" over
        "myFile.html"). Defaults to `false`

    Returns: an object containing:

    * `id` The index of the candidate
    * `value` The original (string) value of the filtered candidate
    * `score` A number in the range 0 to 1. Higher scores are more relevant.
      0 denotes "no match" and will never be returned.
    * `matchIndexes` (optional) Will be returned only if `recordMatchIndexes`
      is set to true. An array of character indexes in `value`, for highlight
      rendering. With "command-t" there is one index per `query` character;
      with "fuzzaldrin" the array can be shorter (optional characters may go
      unmatched) or longer (full-path and basename alignments merge). This
      can be expensive to calculate.
  */
  match(query, options = {}) {
    let { numThreads, algorithm } = options;
    numThreads ||= DEFAULT_NUM_THREADS;
    algorithm ||= "fuzzaldrin";
    return this.fuzzyMatcher.match(query, { ...options, numThreads, algorithm });
  }

  /*
    # Name: setCandidates
    # Type: InstanceMethod

    Exactly the same as {setCandidates}, passing this {Matcher} as the first parameter
  */
  setCandidates(candidates) {
    return setCandidates(this, candidates);
  }
}

/*
  Essential: The {fuzzyMatcher} API, the same used in the autocomplete,
  fuzzy file search, command palette, etc.
  An instance of this API is available via the `lumine.tools.fuzzyMatcher` global.

  This API have two parts - the filtering of an array of candidates, and the
  scoring. Scoring is done via the {fuzzyMatcher.score}, and filtering is
  done by returning a new {Matcher} using the {fuzzyMatcher.setCandidates}
  method, then calling {Matcher#match}. You can _also use_ the
  {fuzzyMatcher.match} to match a single candidate - it uses the same API and
  options as {Matcher#match}.
*/
const fuzzyMatcher = {
  setCandidates: setCandidates,

  // Same as {setCandidates} passing a single candidate, and returning only
  // the score. It can return `0` if there's no match. Accepts the same
  // options as {Matcher#match} plus `ignoreDiacritics`.
  score(candidate, query, opts = {}) {
    return this.match(candidate, query, opts)?.score || 0;
  },

  // The same as {setCandidates} with a single candidate. Returns just the
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
