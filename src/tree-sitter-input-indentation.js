const { normalizedRanges } = require("./tree-sitter-indentation-stream");
const { inspectRows, indentSource } = require("./text-editor-comment-operations");
const { PieceTree } = require("./text-model");
const { QueryBudgetExceeded } = require("./tree-sitter-query-budget");

// Input planning has different semantics from reindenting existing structure:
// later decisions must observe both the text and syntax of earlier prefixes.
// This iterator owns no publication; its mode must belong to a private buffer.
async function* scanInputIndentation(
  mode,
  ranges,
  tabLength,
  options = {},
  { signal, isCurrent, settle = () => mode.atGrammarSettlement() } = {},
) {
  if (!mode.indentationOnly) throw new Error("Input indentation requires a private syntax mode");
  const { buffer } = mode;
  const check = () => {
    signal?.throwIfAborted();
    if (mode.destroyed || isCurrent?.() === false)
      throw Object.assign(new Error("Input indentation was superseded"), { name: "AbortError" });
  };
  const settled = async () => {
    const transaction = await settle();
    check();
    if (transaction.parseError || mode.lastTransactionParseError)
      throw new QueryBudgetExceeded("indentation-unavailable");
  };
  ranges = normalizedRanges(ranges, buffer.getLastRow());
  const total = ranges.reduce((count, [first, last]) => count + last - first + 1, 0);
  if (!total) return;
  const policy = {
    getSoftTabs: () => options.softTabs !== false,
    getTabLength: () => tabLength,
  };
  const changedRows = new Set();
  let processed = 0,
    batch = [],
    deadline = performance.now() + 4;
  check();
  await settled();
  for (const [first, last] of ranges) {
    for (let row = first; row <= last; row++) {
      check();
      let parameters = options;
      const rowOptions = options.rowOptions?.get(row);
      if (changedRows.has(row - 1) && rowOptions?.comparisonRowIndentCaptured) {
        // An insertion-time blank-line baseline is obsolete once that line's
        // own requested indentation has been applied. Explicit overrides stay.
        parameters = {
          ...options,
          comparisonRowIndents: undefined,
          rowOptions: new Map([[row, { ...rowOptions, comparisonRowIndent: undefined }]]),
        };
      }
      let entry;
      // Finish the revision-bound iterator before changing its source.
      for await (const packet of mode.scanSuggestedIndentation([[row, row]], tabLength, {
        ...parameters,
        isPastedText: false,
        signal,
        isCurrent: check,
      })) {
        if (packet.length !== 1 || packet[0][0] !== row || entry)
          throw new Error("Invalid prepared input indentation row");
        [entry] = packet;
      }
      check();
      if (!entry) throw new Error("Incomplete prepared input indentation row");
      batch.push(entry);
      const [, level] = entry;
      if (++processed < total && level !== null) {
        const source = buffer.getTextSnapshot();
        let info = inspectRows(source, tabLength, check)(row);
        if (info?.then) info = await info;
        check();
        const settings = rowOptions ?? options;
        const endColumn = settings.preserveLeadingWhitespace
          ? (settings.insertedIndentLengths?.get(row) ?? 0)
          : info.contentStart - info.start;
        if (
          !Number.isSafeInteger(endColumn) ||
          endColumn < 0 ||
          endColumn > info.contentStart - info.start
        )
          throw new RangeError("Inserted indentation must stay within the whitespace prefix");
        const text = indentSource(policy, level);
        const replacement = typeof text === "string" ? new PieceTree(text) : text;
        if (!source.subtext(info.start, info.start + endColumn).equals(replacement)) {
          check();
          buffer.setTextInRange(
            [
              [row, 0],
              [row, endColumn],
            ],
            replacement,
            {
              normalizeLineEndings: false,
            },
          );
          changedRows.add(row);
          await settled();
        }
      }
      if (batch.length === 256) {
        yield batch;
        batch = [];
      }
      if (performance.now() >= deadline) {
        await new Promise((resolve) => setImmediate(resolve));
        check();
        deadline = performance.now() + 4;
      }
    }
  }
  if (batch.length) yield batch;
}

module.exports = { scanInputIndentation };
