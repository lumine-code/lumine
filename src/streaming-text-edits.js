const { PieceTree } = require("./text-model");
const Range = require("./range");
const { buildReplacement } = require("./document-search");
const { normalizeLineEndings } = require("./text-source-helpers");

function* synchronousBatches(edits) {
  let batch = [];
  for (const edit of edits) {
    if (Array.isArray(edit)) {
      if (batch.length) {
        yield batch;
        batch = [];
      }
      yield edit;
    } else {
      batch.push(edit);
      if (batch.length === 64) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length) yield batch;
}

// Adapt ordered edits to the same bounded builder and marker geometry used by
// replacement. An input can contain millions of edits without retaining them.
async function prepareTextEdits(buffer, source, edits, options, onReplacement, check) {
  const session = {
    check,
    async *batches() {
      let previousStart = -1;
      let previousEnd = 0;
      let batch = [];
      const input = edits[Symbol.asyncIterator] ? edits : synchronousBatches(edits);
      for await (const entry of input) {
        check();
        const entries = Array.isArray(entry) ? entry : [entry];
        if (entries.length > 1024)
          throw new RangeError("Text edit batches are limited to 1024 entries");
        for (const edit of entries) {
          check();
          const requested = Range.fromObject(edit.range);
          const range = buffer.clipRange(requested);
          if (!range.isEqual(requested))
            throw new RangeError("Text edit range is outside the source document");
          const start = source.offsetAt(range.start);
          const end = source.offsetAt(range.end);
          if (start < previousEnd || start <= previousStart)
            throw new RangeError("Streaming text edits must be ordered and disjoint");
          let text = edit.text;
          if (typeof text !== "string" && !(text instanceof PieceTree))
            throw new TypeError("Text edits require a string or immutable snapshot");
          if (options.normalizeLineEndings) {
            const ending =
              buffer.getPreferredLineEnding() ||
              buffer.lineEndingForRow(range.start.row) ||
              buffer.lineEndingForRow(range.start.row - 1);
            if (ending) text = normalizeLineEndings(text, ending);
          }
          previousStart = start;
          previousEnd = end;
          batch.push({ start, end, match: [text] });
          if (batch.length === 64) {
            yield batch;
            batch = [];
          }
        }
      }
      if (batch.length) yield batch;
    },
  };
  return buildReplacement(source, [session], "", {
    literalReplacement: true,
    transformReplacement: (_template, text) => text,
    onReplacement,
  });
}

module.exports = { prepareTextEdits };
