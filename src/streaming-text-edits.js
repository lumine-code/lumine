const { PieceTree } = require("./text-model");
const TextStore = require("./text-store");
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
// replacement. Large inputs retain compressed geometry, not replacement objects.
async function prepareTextEdits(buffer, source, edits, options, onReplacement, check) {
  // Parsing deliberately restarts beyond its bounded edit journal. Keep local
  // changes below that bound, while the compressed presentation map has no such
  // cutoff and continues to preserve all cached unchanged text.
  let journal = [],
    store = new TextStore(source, { wordIndex: false }),
    delta = 0;
  let deadline = performance.now() + 4;
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
          if (performance.now() >= deadline) {
            await new Promise((resolve) => setImmediate(resolve));
            deadline = performance.now() + 4;
          }
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
          const replacement = typeof text === "string" ? new PieceTree(text) : text;
          if (source.subtext(start, end).equals(replacement)) continue;
          if (journal) {
            if (journal.length === 128) {
              journal = null;
              store = null;
            } else {
              const current = store.getTextSnapshot();
              const prepared = store.prepareEditFromChange({
                newStart: current.positionAt(start + delta),
                oldStart: current.positionAt(start + delta),
                oldEnd: current.positionAt(end + delta),
                oldTextSource: current.subtext(start + delta, end + delta),
                newTextSource: replacement,
              });
              journal.push(buffer.changeEventForPreparedEdit(prepared.getChange(), "edit"));
              prepared.commit();
              prepared.dispose();
            }
          }
          delta += text.length - (end - start);
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
  const result = await buildReplacement(source, [session], "", {
    literalReplacement: true,
    transformReplacement: (_template, text) => text,
    onReplacement,
    identityFiltered: true,
  });
  return {
    ...result,
    syntaxChanges: journal,
  };
}

module.exports = { prepareTextEdits };
