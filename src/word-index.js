const { fold } = require("./completion-matcher");
const { rankWords } = require("./text-store-search");
// eslint-disable-next-line no-control-regex -- ASCII fast path, same token grammar as scanning.
const nonASCII = /[^\x00-\x7f]/;
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
const BLOCK_ROWS = 128;
const MAX_BLOCKS = 64;
const MAX_UNITS = 2 * 1024 * 1024;
const MAX_OCCURRENCES = 100000;

// A bounded, demand-built index of whole-row blocks. Edits never tokenize text:
// they evict intersecting blocks and translate untouched blocks by the row delta.
// Queries own a snapshot of block coordinates, so an overlapping edit cannot
// change the meaning of an already running request.
class WordIndex {
  blocks = [];
  generation = 0;
  extra = null;

  clear() {
    this.blocks = [];
    this.generation++;
  }

  invalidate(startRow, oldEndRow, newEndRow) {
    this.generation++;
    if (this.blocks.length === 0) return;
    const delta = newEndRow - oldEndRow;
    this.blocks = this.blocks.flatMap((block) => {
      if (block.end <= startRow) return [block];
      if (block.start > oldEndRow)
        return [{ ...block, start: block.start + delta, end: block.end + delta }];
      return [];
    });
  }

  invalidateBatch(changes) {
    this.generation++;
    if (this.blocks.length === 0) return;
    // Draft changes are ordered from the end of the original document. Walk
    // the old coordinates once instead of visiting every block per edit.
    let cursor = changes.length - 1,
      delta = 0;
    const retained = [];
    for (const block of this.blocks.slice().sort((a, b) => a.start - b.start)) {
      while (cursor >= 0 && changes[cursor].oldRange.end.row < block.start) {
        const change = changes[cursor--];
        delta += change.newRange.end.row - change.oldRange.end.row;
      }
      if (cursor >= 0 && changes[cursor].oldRange.start.row < block.end) continue;
      retained.push(
        delta ? { ...block, start: block.start + delta, end: block.end + delta } : block,
      );
    }
    this.blocks = retained;
  }

  async find(text, start, end, query, extra, maxCount, options) {
    if (query.length > 80 || maxCount <= 0 || options.signal?.aborted) return [];
    if (this.extra !== extra) {
      this.clear();
      this.extra = extra;
    }
    const generation = this.generation;
    const cached = this.blocks.slice().sort((a, b) => a.start - b.start);
    const plan = [];
    let row = start,
      cursor = 0;
    while (row < end) {
      while (cursor < cached.length && cached[cursor].end <= row) cursor++;
      const block = cached[cursor];
      if (block && block.start <= row) {
        plan.push({ block, start: row, end: Math.min(end, block.end) });
        row = Math.min(end, block.end);
      } else {
        const next = Math.min(end, row + BLOCK_ROWS, block?.start ?? end);
        plan.push({ start: row, end: next });
        row = next;
      }
    }
    await yieldTurn();
    let deadline = performance.now() + 4;
    const escaped = extra.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    const ascii = new RegExp("[a-zA-Z0-9" + escaped + "]+", "g");
    const unicode = new RegExp("[\\p{L}\\p{N}" + escaped + "]+", "gu");
    const words = new Map();
    const lower = fold(query);
    const eligibility = new Map();
    for (const item of plan) {
      if (options.signal?.aborted) return [];
      let block = item.block;
      if (!block) {
        block = { start: item.start, end: item.end, words: new Map(), units: 0, occurrences: 0 };
        let relativeRow = 0;
        for (const line of text.lines(item.start, item.end)) {
          const expression = nonASCII.test(line) ? unicode : ascii;
          expression.lastIndex = 0;
          block.units += line.length + 1;
          for (let match; (match = expression.exec(line));) {
            const word = match[0];
            if (word.length > 80) continue;
            let positions = block.words.get(word);
            if (!positions) block.words.set(word, (positions = []));
            positions.push(relativeRow, match.index);
            block.occurrences++;
            if ((block.occurrences & 2047) === 0 && performance.now() >= deadline) {
              await yieldTurn();
              deadline = performance.now() + 4;
              if (options.signal?.aborted) return [];
            }
          }
          relativeRow++;
          if (performance.now() >= deadline) {
            await yieldTurn();
            deadline = performance.now() + 4;
            if (options.signal?.aborted) return [];
          }
        }
        if (generation === this.generation && !options.signal?.aborted) this.retain(block);
      }
      for (const [word, positions] of block.words) {
        if (performance.now() >= deadline) {
          await yieldTurn();
          deadline = performance.now() + 4;
          if (options.signal?.aborted) return [];
        }
        let accepted = eligibility.get(word);
        if (accepted === undefined) {
          const candidate = fold(word);
          let offset = 0;
          accepted = true;
          for (let i = 0; i < lower.length; i++) {
            const index = candidate.indexOf(lower[i], offset);
            if (index < 0) {
              accepted = false;
              break;
            }
            offset = index + 1;
          }
          if (eligibility.size < 4096) eligibility.set(word, accepted);
        }
        if (!accepted) continue;
        const first = lowerBound(positions, item.start - block.start, 0);
        const last = lowerBound(positions, item.end - block.start, 0);
        if (first === last) continue;
        let entry = words.get(word);
        if (!entry) {
          entry = {
            position: { row: block.start + positions[first * 2], column: positions[first * 2 + 1] },
            occurrences: 0,
            distance: Infinity,
            containsPosition: false,
          };
          words.set(word, entry);
        }
        entry.occurrences += last - first;
        const position = options.position;
        if (position) {
          const index = Math.max(
            first,
            Math.min(last, lowerBound(positions, position.row - block.start, position.column + 1)),
          );
          for (const neighbor of [index - 1, index]) {
            if (neighbor < first || neighbor >= last) continue;
            const wordRow = block.start + positions[neighbor * 2];
            const column = positions[neighbor * 2 + 1];
            entry.distance = Math.min(entry.distance, Math.abs(wordRow - position.row));
            if (
              wordRow === position.row &&
              position.column >= column &&
              position.column <= column + word.length
            )
              entry.containsPosition = true;
          }
        }
      }
    }
    return rankWords(words, query, maxCount, { ...options, compact: true });
  }

  retain(block) {
    if (block.units > MAX_UNITS || block.occurrences > MAX_OCCURRENCES) return;
    // Another request may have populated this same region while we yielded.
    this.blocks = this.blocks.filter(
      (other) => other.end <= block.start || other.start >= block.end,
    );
    this.blocks.push(block);
    let units = 0,
      occurrences = 0;
    let keep = this.blocks.length;
    while (keep > 0) {
      const candidate = this.blocks[keep - 1];
      if (
        this.blocks.length - keep >= MAX_BLOCKS ||
        units + candidate.units > MAX_UNITS ||
        occurrences + candidate.occurrences > MAX_OCCURRENCES
      )
        break;
      units += candidate.units;
      occurrences += candidate.occurrences;
      keep--;
    }
    if (keep) this.blocks.splice(0, keep);
  }
}

function lowerBound(positions, row, column) {
  let low = 0,
    high = positions.length / 2;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const r = positions[middle * 2],
      c = positions[middle * 2 + 1];
    if (r < row || (r === row && c < column)) low = middle + 1;
    else high = middle;
  }
  return low;
}

module.exports = WordIndex;
