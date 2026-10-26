const path = require("node:path");
const { CompositeDisposable } = require("@lumine-code/event-kit");
const NullGrammar = require("./null-grammar");
module.exports = async function analyzeBufferSyntax(
  buffer,
  modulePath,
  method,
  params,
  { signal, onChunk, settle } = {},
) {
  if (!path.isAbsolute(modulePath))
    throw new TypeError("Syntax analysis module path must be absolute");
  if (buffer.isDestroyed() || signal?.aborted) return null;
  const mode = buffer.getLanguageMode();
  if (mode.grammar === NullGrammar || mode.syntaxAvailability?.available === false) return null;
  const revision = buffer.getTextRevision();
  const epoch = mode.getSyntaxRequestEpoch?.();
  const check = () => {
    combined.throwIfAborted();
    if (mode.getSyntaxRequestEpoch?.() !== epoch) {
      const error = new Error("Syntax configuration changed");
      error.name = "AbortError";
      controller.abort(error);
      throw error;
    }
  };
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const subscriptions = new CompositeDisposable(
    buffer.onDidApplyChanges(() => controller.abort()),
    buffer.onDidChangeLanguageMode(() => controller.abort()),
    buffer.onDidChangePath(() => controller.abort()),
    buffer.onDidDestroy(() => controller.abort()),
  );
  const accept = async (value) => {
    check();
    if (!onChunk) throw new Error("Syntax analysis stream requires a consumer");
    const response = await onChunk(value);
    check();
    return response;
  };
  try {
    if (settle) {
      if (!(await waitFor(settle(combined), combined))) return null;
    } else if (!mode.analyze) {
      const transaction = await waitFor(
        mode.atGrammarSettlement?.() ?? mode.atTransactionEnd?.() ?? mode.ready,
        combined,
      );
      if (transaction?.parseError) return null;
    }
    check();
    const { contextFor, serialize } = require("./syntax-analysis-context");
    let result;
    if (mode.analyze) {
      result = await mode.analyze(modulePath, method, params, {
        signal: combined,
        onChunk: accept,
        revision,
      });
    } else {
      const processor = require(modulePath)[method];
      if (typeof processor !== "function") throw new Error(`Unknown syntax analysis: ${method}`);
      result = await waitFor(
        processor(contextFor(mode, combined, revision), structuredClone(params), {
          signal: combined,
          emit: async (value, transfer = []) => {
            const response = await accept(structuredClone(serialize(value), { transfer }));
            await new Promise((resolve) => setImmediate(resolve));
            return structuredClone(serialize(response));
          },
        }),
        combined,
      );
      result = serialize(result);
    }
    check();
    return buffer.getTextRevision() === revision ? result : null;
  } catch (error) {
    if (combined.aborted || error.name === "AbortError" || mode.getSyntaxRequestEpoch?.() !== epoch)
      return null;
    throw error;
  } finally {
    subscriptions.dispose();
    controller.abort();
  }
};

function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      signal.removeEventListener("abort", abort);
      settle(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}
