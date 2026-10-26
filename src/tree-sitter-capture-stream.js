const Point = require("./point");
const ScopeResolver = require("./scope-resolver");
const {
  runQuery,
  boundedQueryRange,
  withPredicateTextBudget,
  QueryBudgetExceeded,
} = require("./tree-sitter-query-budget");

function cancelled() {
  const error = new Error("Syntax capture scan was cancelled");
  error.name = "AbortError";
  return error;
}

async function wait(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw cancelled();
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(cancelled());
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// Exact captures arrive in bounded batches, grouped by a stable layer index
// within this scan. Consumers must finish iteration before publishing a result:
// cancellation or a changed revision invalidates even previously yielded data.
async function* scanQueryCaptures(mode, queryType, { signal, batchSize = 256 } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 4096)
    throw new RangeError("Capture batch size must be an integer between 1 and 4096");
  const revision = mode.buffer.getTextRevision();
  const assertLive = () => {
    if (mode.destroyed || signal?.aborted || mode.buffer.getTextRevision() !== revision)
      throw cancelled();
  };
  let layers;
  for (;;) {
    assertLive();
    const transaction = await wait(mode.atGrammarSettlement(), signal);
    assertLive();
    if (transaction.parseError) throw cancelled();
    layers = mode.getAllLanguageLayers();
    await wait(Promise.all(layers.map((layer) => layer?.ensureQuery?.(queryType))), signal);
    assertLive();
    const currentLayers = mode.getAllLanguageLayers();
    if (
      layers.length !== currentLayers.length ||
      layers.some((layer, index) => layer !== currentLayers[index])
    )
      continue;
    const pending = layers.some(
      (layer) =>
        layer?.queryReloadPromise?.then ||
        layer?.injectionPopulationDrainPromise?.then ||
        layer?.queryLoadPromises?.size,
    );
    if (!mode.resolveNextTransaction && !pending) {
      if (mode.lastTransactionParseError) throw cancelled();
      break;
    }
  }

  // Query loading can legitimately restart at a newer configuration before
  // the scan begins. Once any captures are observed, that epoch is immutable.
  const epoch = mode.getSyntaxRequestEpoch?.();
  const snapshots = layers.map((layer) => ({
    layer,
    tree: layer?.tree,
    query: layer?.queries?.[queryType],
    injectionPointVersion: layer?.injectionPointVersion,
  }));
  const isCurrent = () =>
    mode.buffer.getTextRevision() === revision &&
    mode.getSyntaxRequestEpoch?.() === epoch &&
    mode.queryCaptureSnapshotIsCurrent(snapshots, queryType, signal);
  const assertCurrent = () => {
    if (!isCurrent()) throw cancelled();
  };
  const requireComplete = (result) => {
    assertCurrent();
    if (!result.complete) {
      if (result.reason === "cancelled") throw cancelled();
      throw new QueryBudgetExceeded(result.reason);
    }
  };
  const yieldTask = () => wait(mode._yieldForQueryCaptureScan(), signal);
  const source = mode.document?.capture().text ?? mode.buffer.getTextSnapshot();
  for (let layerId = 0; layerId < snapshots.length; layerId++) {
    const { layer, tree, query } = snapshots[layerId];
    if (!query || !tree) continue;
    assertCurrent();
    const extent = layer.getExtent();
    const endIndex = mode.buffer.characterIndexForPosition(extent.end);
    let startIndex = mode.buffer.characterIndexForPosition(extent.start);
    let firstChunk = true;
    let batch = [];
    const chunkRows = Math.max(1, Math.floor(mode.queryCaptureChunkRows ?? 200));
    const chunkUnits = Math.max(
      2,
      Math.min(8192, Math.floor(mode.queryCaptureChunkCodeUnits ?? 8192)),
    );
    const resolver = new ScopeResolver(layer, layer.scopeResolver.idForScope);
    const budget = { signal, isCancelled: () => !isCurrent() };
    try {
      while (startIndex < endIndex) {
        assertCurrent();
        const start = mode.buffer.positionForCharacterIndex(startIndex);
        const endRow = Math.min(extent.end.row, start.row + chunkRows);
        const rowEnd = endRow === extent.end.row ? extent.end : new Point(endRow, 0);
        const rowEndIndex = mode.buffer.characterIndexForPosition(rowEnd);
        const window = boundedQueryRange(
          source,
          startIndex,
          rowEndIndex > startIndex ? Math.min(endIndex, rowEndIndex) : endIndex,
          chunkUnits,
        );
        const end = mode.buffer.positionForCharacterIndex(window.endIndex);
        const queried = runQuery(
          query,
          tree.rootNode,
          { startPosition: start, endPosition: end },
          budget,
        );
        requireComplete(queried);
        const captures = queried.results;
        for (let offset = 0; offset < captures.length;) {
          // Scope predicates may inspect node text too. Keep their budget active
          // only during the synchronous pass, never across a consumer's yield.
          const filtered = withPredicateTextBudget(() => {
            const limit = Math.min(captures.length, offset + batchSize);
            while (offset < limit && batch.length < batchSize) {
              const capture = captures[offset];
              captures[offset++] = null;
              // A capture enclosing several query windows belongs to its first
              // window. Do not deduplicate genuine repeated captures/patterns.
              if (!firstChunk && capture.node.startIndex < startIndex) continue;
              if (window.endIndex < endIndex && capture.node.startIndex >= window.endIndex)
                continue;
              if (resolver.store(capture, { boundaries: false })) batch.push(capture);
            }
          }, budget);
          requireComplete(filtered);
          if (batch.length === batchSize) {
            yield { grammar: layer.grammar, captures: batch, layerId, last: false };
            batch = [];
            assertCurrent();
          }
          if (offset < captures.length) {
            await yieldTask();
            assertCurrent();
          }
        }
        startIndex = window.endIndex;
        firstChunk = false;
        if (startIndex < endIndex) {
          await yieldTask();
          assertCurrent();
        }
      }
      assertCurrent();
      yield { grammar: layer.grammar, captures: batch, layerId, last: true };
      assertCurrent();
    } finally {
      resolver.destroy();
    }
  }
  assertCurrent();
}

module.exports = scanQueryCaptures;
