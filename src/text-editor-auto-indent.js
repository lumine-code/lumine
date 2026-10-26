const { PieceTree } = require("./text-model");
const { inspectRows, indentSource } = require("./text-editor-comment-operations");

const pause = () => new Promise((resolve) => setImmediate(resolve));

function mergeRanges(ranges) {
  const result = [];
  for (const [start, end] of ranges) {
    const last = result.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

// Plain text inherits the preceding nonblank row *after* its planned edit.
// Remember only that row's virtual indentation, rather than an entry per line.
async function* scanPlainIndentation(buffer, ranges, tabLength, options = {}) {
  const source = buffer.getTextSnapshot();
  const revision = buffer.getTextRevision();
  const { batchSize = 256, signal } = options;
  if (!Number.isFinite(tabLength) || tabLength <= 0)
    throw new RangeError("Indentation tabLength must be positive and finite");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 4096)
    throw new RangeError("Indentation batchSize must be between 1 and 4096");
  const check = () => {
    if (
      signal?.aborted ||
      buffer.isDestroyed() ||
      buffer.getTextRevision() !== revision ||
      options.isCurrent?.() === false
    )
      throw Object.assign(new Error("Indentation scan cancelled"), { name: "AbortError" });
  };
  const inspect = inspectRows(source, tabLength, check);
  let previousEnd = -1,
    previousLevel = 0,
    deadline = performance.now() + 4,
    batch = [];
  for (const [start, end] of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= previousEnd ||
      end < start ||
      end >= source.lineCount
    )
      throw new RangeError("Indentation ranges must be ordered, disjoint buffer rows");
    // A gap can contain a more recent, unmodified nonblank predecessor.
    for (let row = start - 1; row > previousEnd; row--) {
      check();
      let info = inspect(row);
      if (info?.then) info = await info;
      if (!info.blank) {
        previousLevel = info.indentLevel;
        break;
      }
      if (performance.now() >= deadline) {
        await pause();
        deadline = performance.now() + 4;
      }
    }
    for (let row = start; row <= end; row++) {
      check();
      let info = inspect(row);
      if (info?.then) info = await info;
      const level = previousLevel;
      batch.push([row, level]);
      if (!info.blank) {
        const columns =
          options.softTabs === false
            ? Math.floor(level) * tabLength + Math.round((level % 1) * tabLength)
            : Math.floor(level * tabLength);
        if (options.preserveLeadingWhitespace) {
          const removed = options.insertedIndentLengths?.get(row) ?? 0;
          if (
            !Number.isSafeInteger(removed) ||
            removed < 0 ||
            removed > info.contentStart - info.start
          )
            throw new RangeError("Inserted indentation must stay within the whitespace prefix");
          let retainedInfo = info;
          if (removed) {
            retainedInfo = inspectRows(
              source.subtext(info.start + removed, info.end),
              tabLength,
              check,
            )(0);
            if (retainedInfo?.then) retainedInfo = await retainedInfo;
          }
          // Tabs in the retained prefix align to the new column, not to zero.
          const retained =
            retainedInfo.firstTab == null
              ? retainedInfo.indentColumns
              : retainedInfo.indentColumns +
                (retainedInfo.firstTab % tabLength) -
                ((columns + retainedInfo.firstTab) % tabLength);
          previousLevel = (columns + retained) / tabLength;
        } else previousLevel = columns / tabLength;
      }
      if (batch.length === batchSize) {
        yield batch;
        batch = [];
      }
      if (performance.now() >= deadline) {
        await pause();
        deadline = performance.now() + 4;
      }
    }
    previousEnd = end;
  }
  check();
  if (batch.length) yield batch;
}

async function equalPrefix(source, start, length, text, check) {
  if (length !== text.length) return false;
  if (!length) return true;
  const actual = source.subtext(start, start + length);
  const expected = typeof text === "string" ? new PieceTree(text) : text;
  const left = actual.reader(4096),
    right = expected.reader(4096);
  let deadline = performance.now() + 4;
  for (let offset = 0; offset < length;) {
    check();
    const a = left(offset),
      b = right(offset);
    const size = Math.min(a.length, b.length, length - offset);
    if (!size || a.slice(0, size) !== b.slice(0, size)) return false;
    offset += size;
    if (performance.now() >= deadline) {
      await pause();
      deadline = performance.now() + 4;
    }
  }
  return true;
}

async function autoIndentRanges(editor, ranges, options = {}, selections = null) {
  if (!ranges.length) return;
  const buffer = editor.getBuffer(),
    mode = buffer.getLanguageMode();
  const source = buffer.getTextSnapshot(),
    expectedRevision = buffer.getTextRevision();
  const tabLength = editor.getTabLength(),
    softTabs = editor.getSoftTabs();
  const current = editor.captureTextMutationGuard(options, selections);
  const isCurrent = () =>
    current() &&
    buffer.getLanguageMode() === mode &&
    editor.getTabLength() === tabLength &&
    editor.getSoftTabs() === softTabs;
  const check = () => {
    if (options.signal?.aborted || !isCurrent())
      throw Object.assign(new Error("Indentation cancelled"), { name: "AbortError" });
  };
  check();
  if (mode.publicationPending && mode.atGrammarSettlement) await mode.atGrammarSettlement();
  check();
  if (typeof mode.scanSuggestedIndentation !== "function")
    throw Object.assign(new Error("The language mode does not support streamed indentation"), {
      code: "ERR_INDENTATION_STREAM_UNAVAILABLE",
    });
  const inspect = inspectRows(source, tabLength, check);
  const planned = mode.scanSuggestedIndentation(ranges, tabLength, {
    ...options,
    batchSize: 256,
    isCurrent,
    softTabs,
  });
  async function* edits() {
    let rangeIndex = 0,
      nextRow = ranges[0][0],
      deadline = performance.now() + 4;
    for await (const batch of planned) {
      check();
      if (!Array.isArray(batch) || batch.length > 4096)
        throw new TypeError("Invalid streamed indentation batch");
      const changes = [];
      for (const entry of batch) {
        if (!Array.isArray(entry) || entry.length !== 2)
          throw new TypeError("Invalid streamed indentation entry");
        const [row, level] = entry;
        if (
          !Number.isSafeInteger(row) ||
          row !== nextRow ||
          (level !== null &&
            (!Number.isFinite(level) ||
              level < 0 ||
              !Number.isSafeInteger(Math.ceil(level * tabLength))))
        )
          throw new RangeError("Indentation stream must cover every requested row in order");
        if (++nextRow > ranges[rangeIndex][1]) nextRow = ranges[++rangeIndex]?.[0];
        if (level !== null) {
          let info = inspect(row);
          if (info?.then) info = await info;
          const endColumn = options.preserveLeadingWhitespace
            ? (options.insertedIndentLengths?.get(row) ?? 0)
            : info.contentStart - info.start;
          if (
            !Number.isSafeInteger(endColumn) ||
            endColumn < 0 ||
            endColumn > info.contentStart - info.start
          )
            throw new RangeError("Inserted indentation must stay within the whitespace prefix");
          const text = indentSource(editor, level);
          if (!(await equalPrefix(source, info.start, endColumn, text, check)))
            changes.push({
              range: [
                [row, 0],
                [row, endColumn],
              ],
              text,
            });
        }
        if (performance.now() >= deadline) {
          await pause();
          check();
          deadline = performance.now() + 4;
        }
      }
      if (changes.length) yield changes;
    }
    if (rangeIndex !== ranges.length) throw new RangeError("Incomplete indentation stream");
  }
  let committedRevision;
  const changed = await buffer.applyTextEdits(edits(), {
    expectedRevision,
    isCurrent,
    signal: options.signal,
    didCommit: () => {
      committedRevision = buffer.getTextRevision();
    },
    withCommit: (publish) =>
      editor.withAutomaticIndentation(() => {
        publish();
        if (options.groupWithPrevious && buffer.getTextRevision() === committedRevision)
          buffer.groupLastChanges();
      }),
  });
  return { changed: Boolean(changed), revision: buffer.getTextRevision() };
}

module.exports = { mergeRanges, scanPlainIndentation, autoIndentRanges };
