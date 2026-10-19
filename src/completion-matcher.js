// Shared JavaScript matching for buffer words and completion candidates.
const unicodeAlphanumeric = /^[\p{L}\p{N}]$/u;
const asciiAlphanumeric = (code) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

// Match indices address the original UTF-16 word. Full lowercase expansion
// (for example İ -> i + combining dot) must not shift those indices.
function fold(text) {
  const lower = text.toLowerCase();
  const folded =
    lower.length === text.length
      ? lower
      : Array.from(text, (character) => character.toLowerCase().slice(0, character.length)).join(
          "",
        );
  // Greek final sigma must match ordinary sigma while a prefix is being typed.
  // Lowercasing alone is contextual: ΟΣ -> ος but ΟΣΑ -> οσα.
  return folded.includes("ς") ? folded.replaceAll("ς", "σ") : folded;
}

function traceMatch(word, query) {
  const lower = fold(query),
    lowerWord = fold(word);
  const states = [{ matched: 0, score: 0, indices: [] }];
  for (let index = 0; index < word.length; index++) {
    const added = [];
    for (let cursor = 0; cursor < states.length;) {
      const state = states[cursor];
      if (state.matched < query.length) {
        if (lowerWord[index] === lower[state.matched]) {
          const boundary =
            index === 0 ||
            !unicodeAlphanumeric.test(word[index - 1]) ||
            (word[index - 1].toLowerCase() === word[index - 1] &&
              word[index - 1].toUpperCase() !== word[index - 1] &&
              word[index].toUpperCase() === word[index] &&
              word[index].toLowerCase() !== word[index]);
          added.push({
            matched: state.matched + 1,
            score:
              state.score +
              (boundary ? (word[index] === query[state.matched] ? 10 : 9) : 0) +
              (state.indices.length && state.indices.at(-1) === index - 1 ? 5 : 0),
            indices: [...state.indices, index],
          });
        }
        state.score -= index < 3 ? 3 : 1;
        if (states[cursor + 1]?.matched === state.matched) {
          states.splice(cursor, 1);
          continue;
        }
      }
      cursor++;
    }
    for (const state of added) {
      let index = states.findIndex((candidate) => candidate.matched >= state.matched);
      if (index < 0) index = states.length;
      if (states[index]?.matched === state.matched && state.score >= states[index].score)
        states[index] = state;
      else states.splice(index, 0, state);
    }
  }
  let best;
  for (const state of states)
    if (state.matched === query.length && (!best || state.score > best.score)) best = state;
  return { score: best.score, matchIndices: best.indices };
}

function scorer(query) {
  const size = query.length + 1,
    lowerQuery = fold(query);
  const best = new Float64Array(size),
    adjacent = new Float64Array(size);
  return (word, lowerWord) => {
    if (!query.length) return 0;
    lowerWord ??= fold(word);
    best.fill(-Infinity);
    adjacent.fill(-Infinity);
    best[0] = 0;
    const lastRelevant = lowerWord.lastIndexOf(lowerQuery.at(-1));
    for (let index = 0; index <= lastRelevant; index++) {
      const penalty = index < 3 ? 3 : 1;
      const previous = word.charCodeAt(index - 1),
        current = word.charCodeAt(index);
      const boundary =
        index === 0 ||
        (!asciiAlphanumeric(previous) &&
          (previous < 128 || !unicodeAlphanumeric.test(word[index - 1]))) ||
        (previous >= 97 && previous <= 122 && current >= 65 && current <= 90) ||
        ((previous >= 128 || current >= 128) &&
          word[index - 1].toLowerCase() === word[index - 1] &&
          word[index - 1].toUpperCase() !== word[index - 1] &&
          word[index].toUpperCase() === word[index] &&
          word[index].toLowerCase() !== word[index]);
      // Descending updates retain the preceding character's state at m - 1.
      // There is no need to copy and swap two additional DP rows per character.
      for (let matched = Math.min(query.length, index + 1); matched >= 1; matched--) {
        const skipped = best[matched] - (matched === query.length ? 0 : penalty);
        let taken = -Infinity;
        if (lowerWord[index] === lowerQuery[matched - 1]) {
          const consecutive = matched > 1 ? adjacent[matched - 1] + 5 : -Infinity;
          taken =
            Math.max(best[matched - 1], consecutive) +
            (boundary ? (word[index] === query[matched - 1] ? 10 : 9) : 0);
        }
        adjacent[matched] = taken;
        best[matched] = Math.max(skipped, taken);
      }
      best[0] -= penalty;
    }
    return best[query.length];
  };
}

/**
 * @public
 * @status extended
 *
 * Prepare one completion query. Results keep their score and lazily computed
 * UTF-16 match indices together. This scorer does not apply path bonuses.
 * Matches also expose exact, prefix, caseSensitivePrefix and
 * firstCharacterMatches flags using the same normalization as scoring.
 * Queries longer than 256 UTF-16 units produce no matches. Cached candidate
 * text is bounded to 2048 entries and 262144 UTF-16 units per query.
 *
 * @memberof lumine.tools.completionMatcher
 * @param {String} query - Typed text, matched case-insensitively.
 * @returns {Object} A query with match(text) and isRefinementOf(previousQuery).
 */
function createQuery(query) {
  if (typeof query !== "string") throw new TypeError("Completion query must be a string");
  const score = query.length <= 256 ? scorer(query) : () => -Infinity;
  const cache = new Map();
  let cachedUnits = 0;
  const folded = fold(query);
  const refinements = new Map();
  return {
    isRefinementOf(previousQuery) {
      if (refinements.has(previousQuery)) return refinements.get(previousQuery);
      // Validate the folded prefix too, so rejection reuse follows the same
      // normalization as matching rather than raw string length alone.
      const result = query.startsWith(previousQuery) && folded.startsWith(fold(previousQuery));
      if (refinements.size < 64) refinements.set(previousQuery, result);
      return result;
    },
    match(text) {
      if (typeof text !== "string") throw new TypeError("Completion candidate must be a string");
      if (cache.has(text)) return cache.get(text);
      const lowerText = fold(text);
      const value = score(text, lowerText);
      let indices;
      const result = Number.isFinite(value)
        ? Object.freeze({
            score: value,
            exact: lowerText === folded,
            prefix: lowerText.startsWith(folded),
            caseSensitivePrefix: text.startsWith(query),
            firstCharacterMatches: lowerText.codePointAt(0) === folded.codePointAt(0),
            get matchIndices() {
              return (indices ??= Object.freeze(query ? traceMatch(text, query).matchIndices : []));
            },
          })
        : null;
      if (cache.size < 2048 && cachedUnits + text.length <= 262144) {
        cache.set(text, result);
        cachedUnits += text.length;
      }
      return result;
    },
  };
}

module.exports = { createQuery, scorer, traceMatch, fold };
