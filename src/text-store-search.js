const { scorer, traceMatch, fold } = require("./completion-matcher");
// eslint-disable-next-line no-control-regex -- Complete ASCII range for tokenization.
const nonASCII = /[^\x00-\x7f]/;

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

async function findWords(text, query, extra = "", maxCount = Infinity, options = {}) {
  if (query.length > 80 || maxCount <= 0 || options.signal?.aborted) return [];
  await new Promise((resolve) => setImmediate(resolve));
  let deadline = performance.now() + 4;
  const words = new Map(),
    lower = fold(query);
  const rejected = new Set();
  const escaped = extra.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const unicodeExpression = new RegExp("[\\p{L}\\p{N}" + escaped + "]+", "gu");
  const asciiExpression = new RegExp("[a-zA-Z0-9" + escaped + "]+", "g");
  const canContainLF = extra.includes("\n");
  const compact = Boolean(options.compact);
  const position = options.position;
  let row = options.origin?.row ?? 0,
    column = options.origin?.column ?? 0,
    word = "",
    startRow = 0,
    startColumn = 0,
    nextLF = -1;
  const recordPosition = (entry) => {
    entry.occurrences++;
    if (position) {
      entry.distance = Math.min(entry.distance, Math.abs(startRow - position.row));
      if (
        startRow === position.row &&
        position.column >= startColumn &&
        position.column <= startColumn + word.length
      )
        entry.containsPosition = true;
    }
  };
  const finish = () => {
    if (word && word.length <= 80) {
      const existing = words.get(word);
      if (existing) {
        if (compact) recordPosition(existing);
        else existing.push({ row: startRow, column: startColumn });
      } else if (!rejected.has(word)) {
        let matched = 0,
          cursor = 0;
        const candidate = fold(word);
        for (; matched < lower.length; matched++) {
          const index = candidate.indexOf(lower[matched], cursor);
          if (index < 0) break;
          cursor = index + 1;
        }
        if (matched === lower.length) {
          const entry = compact
            ? {
                position: { row: startRow, column: startColumn },
                distance: Infinity,
                containsPosition: false,
                occurrences: 0,
              }
            : [{ row: startRow, column: startColumn }];
          if (compact) recordPosition(entry);
          words.set(word, entry);
        } else if (rejected.size < 2048) rejected.add(word);
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
    if (options.signal?.aborted) return [];
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      deadline = performance.now() + 4;
      if (options.signal?.aborted) return [];
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
  return rankWords(words, query, maxCount, options);
}

async function rankWords(words, query, maxCount, options = {}) {
  let deadline = performance.now() + 4;
  const compact = Boolean(options.compact);
  const score = scorer(query);
  const better = (a, b) => b.score - a.score || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0);
  const results = [];
  const limit = Math.min(words.size, Math.max(0, Math.trunc(maxCount)));
  if (!limit) return [];
  for (const word of words.keys()) {
    if (options.signal?.aborted) return [];
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      deadline = performance.now() + 4;
    }
    const value = score(word);
    // Most words in a large vocabulary cannot enter the bounded result heap.
    // Compare their scalar keys first; copying occurrence metadata for every
    // rejected word creates thousands of short-lived objects per keystroke.
    if (results.length === limit) {
      const worst = results[0];
      const order = worst.score - value || (word < worst.word ? -1 : word > worst.word ? 1 : 0);
      if (order >= 0) continue;
    }
    const entry = { word, score: value };
    if (results.length < limit) {
      let index = results.length;
      results.push(entry);
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (better(results[index], results[parent]) <= 0) break;
        [results[index], results[parent]] = [results[parent], results[index]];
        index = parent;
      }
    } else {
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
  if (options.signal?.aborted) return [];
  results.sort(better);
  return results.map(({ word }) => {
    const positions = words.get(word);
    const match = traceMatch(word, query);
    return compact ? { word, ...positions, ...match } : { word, positions, ...match };
  });
}

module.exports = { findWords, rankWords };
