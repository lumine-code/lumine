const { QueryBudgetExceeded } = require("./tree-sitter-query-budget");

const PAGE_ROWS = 4096;
const MAX_RUNS = PAGE_ROWS / 2;

// Exact prior-row values without a Map entry or JS object for every row.
// Repeated values occupy runs; fragmented pages become 32 KiB numeric arrays.
// Arbitrary backward @match references require retaining information: worst
// case history is eight bytes per covered row, not constant total memory.
class IndentationLevels {
  constructor() {
    this.pages = [];
    this.lastRow = -1;
    this.allocatedBytes = 0;
    this.storedRows = 0;
    this.runs = 0;
    this.densePages = 0;
  }
  set(row, level) {
    if (!Number.isSafeInteger(row) || row <= this.lastRow || !Number.isFinite(level))
      throw new RangeError("Indentation history requires increasing rows and finite levels.");
    this.lastRow = row;
    this.storedRows++;
    const id = Math.floor(row / PAGE_ROWS);
    const offset = row % PAGE_ROWS;
    let page = this.pages.at(-1);
    if (page?.id !== id) {
      page = {
        id,
        count: 0,
        starts: new Uint16Array(8),
        ends: new Uint16Array(8),
        levels: new Float64Array(8),
      };
      this.pages.push(page);
      this.allocatedBytes += 96;
    }
    if (page.dense) {
      page.dense[offset] = level;
      return this;
    }
    const last = page.count - 1;
    if (last >= 0 && page.ends[last] === offset && page.levels[last] === level) {
      page.ends[last]++;
      return this;
    }
    if (page.count === MAX_RUNS) {
      const dense = new Float64Array(PAGE_ROWS).fill(NaN);
      for (let i = 0; i < page.count; i++) dense.fill(page.levels[i], page.starts[i], page.ends[i]);
      this.allocatedBytes += dense.byteLength - page.levels.length * 12;
      this.runs -= page.count;
      this.densePages++;
      page.dense = dense;
      page.starts = page.ends = page.levels = null;
      dense[offset] = level;
      return this;
    }
    if (page.count === page.levels.length) {
      const capacity = page.count * 2;
      const starts = new Uint16Array(capacity),
        ends = new Uint16Array(capacity),
        levels = new Float64Array(capacity);
      starts.set(page.starts);
      ends.set(page.ends);
      levels.set(page.levels);
      this.allocatedBytes += page.count * 12;
      page.starts = starts;
      page.ends = ends;
      page.levels = levels;
    }
    page.starts[page.count] = offset;
    page.ends[page.count] = offset + 1;
    page.levels[page.count++] = level;
    this.runs++;
    return this;
  }
  get(row) {
    if (!Number.isSafeInteger(row) || row < 0) return undefined;
    const id = Math.floor(row / PAGE_ROWS);
    let low = 0,
      high = this.pages.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.pages[middle].id < id) low = middle + 1;
      else high = middle;
    }
    const page = this.pages[low];
    if (page?.id !== id) return undefined;
    const offset = row % PAGE_ROWS;
    if (page.dense) return Number.isNaN(page.dense[offset]) ? undefined : page.dense[offset];
    low = 0;
    high = page.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (page.starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    const index = low - 1;
    return index >= 0 && page.ends[index] > offset ? page.levels[index] : undefined;
  }
  getStats() {
    return {
      pages: this.pages.length,
      runs: this.runs,
      densePages: this.densePages,
      allocatedBytes: this.allocatedBytes,
      storedRows: this.storedRows,
    };
  }
}

function abort() {
  return Object.assign(new Error("Indentation scan was cancelled or superseded."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function normalizedRanges(ranges, lastRow) {
  if (!Array.isArray(ranges))
    throw new TypeError("Indentation ranges must be an array of inclusive row pairs.");
  let previousEnd = -1;
  return ranges.map((range) => {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every(Number.isSafeInteger) ||
      range[0] < 0 ||
      range[1] < range[0] ||
      range[1] > lastRow ||
      range[0] <= previousEnd
    )
      throw new RangeError(
        "Indentation ranges must be ordered, non-overlapping inclusive row pairs within the document.",
      );
    previousEnd = range[1];
    return [range[0], range[1]];
  });
}

async function* scanSuggestedIndentation(resolver, ranges, tabLength, options = {}) {
  const { signal, batchSize = 256 } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 4096)
    throw new RangeError("Indentation batchSize must be between 1 and 4096.");
  if (!Number.isFinite(tabLength) || tabLength <= 0)
    throw new RangeError("Indentation tabLength must be a positive finite number.");
  ranges = normalizedRanges(ranges, resolver.buffer.getLastRow());
  if (ranges.length === 0) return;
  const mode = resolver.languageMode;
  const root = mode.rootLanguageLayer;
  const tree = root?.tree;
  const grammar = root?.grammar;
  const revision = resolver.buffer.getTextRevision();
  const epoch = mode.getSyntaxRequestEpoch?.();
  const generation = mode.getSyntaxGeneration?.();
  const grammarGeneration = root?.grammar?.queryLoadGeneration;
  const checkCurrent = () => {
    if (
      signal?.aborted ||
      mode.destroyed ||
      root?.destroyed ||
      mode.rootLanguageLayer !== root ||
      root?.tree !== tree ||
      root?.grammar !== grammar ||
      resolver.buffer.getTextRevision() !== revision ||
      mode.getSyntaxRequestEpoch?.() !== epoch ||
      mode.getSyntaxGeneration?.() !== generation ||
      root?.grammar?.queryLoadGeneration !== grammarGeneration ||
      options.isCurrent?.() === false
    )
      throw abort();
  };
  checkCurrent();
  if (!root || !tree || !root.ready) throw new QueryBudgetExceeded("indentation-unavailable");
  const history = new IndentationLevels();
  const indentationLevels = {
    get: (row) => history.get(row) ?? options.indentationLevels?.get(row),
    set(row, level) {
      const existing =
        options.indentationLevels?.get(row) ?? resolver.indentLevelForBufferRow(row, tabLength);
      if (level !== existing) history.set(row, level);
    },
  };
  function* rows() {
    for (const [start, end] of ranges) for (let row = start; row <= end; row++) yield row;
  }
  const iterator = resolver.iterateSuggestedIndentationRows(
    ranges[0][0],
    ranges.at(-1)[1],
    tabLength,
    {
      ...options,
      rows: rows(),
      indentationLevels,
      requireComplete: true,
      checkCurrent,
    },
  );
  let processedRows = 0;
  let batch = [];
  let lastYield = performance.now();
  try {
    while (true) {
      checkCurrent();
      const next = iterator.next();
      if (next.done) break;
      batch.push(next.value);
      processedRows++;
      if (batch.length === batchSize) {
        checkCurrent();
        yield batch;
        batch = [];
        checkCurrent();
        await new Promise((resolve) => setImmediate(resolve));
        lastYield = performance.now();
      } else if (performance.now() - lastYield >= 8) {
        // A costly row must not make a 256-row packet monopolize the worker.
        await new Promise((resolve) => setImmediate(resolve));
        checkCurrent();
        lastYield = performance.now();
      }
    }
    checkCurrent();
    if (batch.length) {
      yield batch;
      checkCurrent();
    }
  } finally {
    iterator.return();
    resolver.lastIndentationScanStats = { processedRows, ...history.getStats() };
  }
}

module.exports = { IndentationLevels, scanSuggestedIndentation };
