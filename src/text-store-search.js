// Preserve Superstring's completion scoring with reusable numeric arrays.
// Reconstruct match paths only for the words returned to the caller.
const unicodeAlphanumeric = /^[\p{L}\p{N}]$/u;
// eslint-disable-next-line no-control-regex -- The fast path tests the complete ASCII range.
const nonASCII = /[^\x00-\x7f]/;
const asciiAlphanumeric = (code) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

// Match indices address the original UTF-16 word. Full lowercase expansion
// (for example İ -> i + combining dot) must not shift those indices.
function fold(text) {
  const lower = text.toLowerCase();
  return lower.length === text.length
    ? lower
    : Array.from(text, (character) => character.toLowerCase().slice(0, character.length)).join("");
}

function* wordChunks(text) {
  let pending = "";
  for (const part of text.chunks()) {
    let chunk = pending + part;
    pending = "";
    const last = chunk.charCodeAt(chunk.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      pending = chunk.slice(-1);
      chunk = chunk.slice(0, -1);
    }
    if (chunk) yield chunk;
  }
  if (pending) yield pending;
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
  return (word) => {
    if (!query.length) return 0;
    best.fill(-Infinity);
    adjacent.fill(-Infinity);
    best[0] = 0;
    const lowerWord = fold(word);
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

async function findWords(text, query, extra = "", maxCount = Infinity) {
  if (query.length > 80 || maxCount <= 0) return [];
  await new Promise((resolve) => setImmediate(resolve));
  let deadline = performance.now() + 4;
  const words = new Map(),
    lower = fold(query);
  const rejected = new Set();
  const escaped = extra.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const unicodeExpression = new RegExp("[\\p{L}\\p{N}" + escaped + "]+", "gu");
  const asciiExpression = new RegExp("[a-zA-Z0-9" + escaped + "]+", "g");
  const canContainLF = extra.includes("\n");
  let row = 0,
    column = 0,
    word = "",
    startRow = 0,
    startColumn = 0,
    nextLF = -1;
  const finish = () => {
    if (word && word.length <= 80) {
      const existing = words.get(word);
      if (existing) existing.push({ row: startRow, column: startColumn });
      else if (!rejected.has(word)) {
        let matched = 0,
          cursor = 0;
        const candidate = fold(word);
        for (; matched < lower.length; matched++) {
          const index = candidate.indexOf(lower[matched], cursor);
          if (index < 0) break;
          cursor = index + 1;
        }
        if (matched === lower.length) words.set(word, [{ row: startRow, column: startColumn }]);
        else if (rejected.size < 2048) rejected.add(word);
      }
    }
    word = "";
  };
  const advance = (chunk, begin, end) => {
    let last = begin,
      lines = 0;
    while (nextLF >= 0 && nextLF < end) {
      lines++;
      last = nextLF + 1;
      nextLF = chunk.indexOf("\n", last);
    }
    row += lines;
    column = lines ? end - last : column + end - begin;
  };
  for (const chunk of wordChunks(text)) {
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      deadline = performance.now() + 4;
    }
    const expression = nonASCII.test(chunk) ? unicodeExpression : asciiExpression;
    // Each LF is located once, even when many words share one very long line.
    nextLF = chunk.indexOf("\n");
    expression.lastIndex = 0;
    let cursor = 0;
    for (let match; (match = expression.exec(chunk));) {
      if (match.index > cursor) {
        finish();
        advance(chunk, cursor, match.index);
      }
      if (!word) {
        startRow = row;
        startColumn = column;
      }
      if (word.length <= 80) word += match[0].slice(0, 81 - word.length);
      cursor = match.index + match[0].length;
      if (canContainLF) advance(chunk, match.index, cursor);
      else column += match[0].length;
    }
    if (cursor < chunk.length) {
      finish();
      advance(chunk, cursor, chunk.length);
    }
  }
  finish();
  const score = scorer(query);
  const better = (a, b) => b.score - a.score || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0);
  const results = [];
  const limit = Math.min(words.size, Math.max(0, Math.trunc(maxCount)));
  for (const [word, positions] of words) {
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      deadline = performance.now() + 4;
    }
    const entry = { word, positions, score: score(word) };
    if (results.length < limit) {
      let index = results.length;
      results.push(entry);
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (better(results[index], results[parent]) <= 0) break;
        [results[index], results[parent]] = [results[parent], results[index]];
        index = parent;
      }
    } else if (limit && better(entry, results[0]) < 0) {
      results[0] = entry;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1,
          right = left + 1;
        if (left >= results.length) break;
        const child =
          right < results.length && better(results[right], results[left]) > 0 ? right : left;
        if (better(results[index], results[child]) >= 0) break;
        [results[index], results[child]] = [results[child], results[index]];
        index = child;
      }
    }
  }
  results.sort(better);
  return results.map((result) => ({ ...result, ...traceMatch(result.word, query) }));
}

module.exports = { findWords };
