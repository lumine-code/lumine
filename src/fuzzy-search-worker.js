// Loaded inside a standard Chromium Web Worker by fuzzy-search-worker-client.
// The local require shim contains only the installed JS matcher and its tables.
const { Matcher } = require("./main");
let matcher;
const requests = new Map();

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  if (type === "cancel") {
    requests.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    let result;
    let transfer = [];
    if (type === "init") {
      matcher = new Matcher([], [], { ignoreDiacritics: data.ignoreDiacritics });
    } else if (type === "add") {
      matcher.addCandidates(
        data.values.map((_, i) => data.offset + i),
        data.values,
      );
    } else if (type === "scan") {
      const job = await matcher.scanAsync(data.query, data.options, { signal: controller.signal });
      const scores = job.raw.slice();
      result = { scores, ceiling: job.fz?.ceiling ?? null };
      transfer = [scores.buffer];
    } else if (type === "rank") {
      const options = { ...data.options };
      if (data.scores) options.scoreModifier = (_score, index) => data.scores[index];
      const ids = await matcher.matchIdsAsync(data.query, options, { signal: controller.signal });
      const order = Uint32Array.from(ids);
      const highlights = ids.slice(0, data.highlightCount).map((index) => ({
        id: index,
        indexes: matcher.getMatchIndexes(index, data.query, data.options),
      }));
      result = { order, highlights };
      transfer = [order.buffer];
    } else {
      throw new Error(`Unknown fuzzy worker request: ${type}`);
    }
    controller.signal.throwIfAborted();
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: { name: error.name, message: error.message } });
  } finally {
    requests.delete(id);
  }
};
