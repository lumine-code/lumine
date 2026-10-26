const TextBuffer = require("./text-buffer");
const TreeSitterLanguageMode = require("./tree-sitter-language-mode");
const runtime = require("./tree-sitter-runtime");

const MAX_UNITS = 16 * 1024;
const CONTEXT_UNITS = 4 * 1024;
const CONTEXT_ROWS = 20;

function selectPreviewWindow(
  source,
  { startRow, endRow },
  { maxUnits = MAX_UNITS, contextUnits = CONTEXT_UNITS, contextRows = CONTEXT_ROWS } = {},
) {
  if (
    !Number.isSafeInteger(startRow) ||
    !Number.isSafeInteger(endRow) ||
    startRow < 0 ||
    endRow < startRow
  )
    throw new RangeError("Invalid syntax preview rows");
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 2 || maxUnits > MAX_UNITS)
    throw new RangeError("Invalid syntax preview size");
  if (
    !Number.isSafeInteger(contextUnits) ||
    contextUnits < 0 ||
    contextUnits > CONTEXT_UNITS ||
    !Number.isSafeInteger(contextRows) ||
    contextRows < 0 ||
    contextRows > CONTEXT_ROWS
  )
    throw new RangeError("Invalid syntax preview context");
  startRow = Math.min(startRow, source.lineCount - 1);
  endRow = Math.min(endRow, source.lineCount - 1);
  const requestedStartIndex = source.lineStart(startRow);
  const requestedEndIndex =
    endRow + 1 < source.lineCount ? source.lineStart(endRow + 1) : source.length;
  let firstRow = startRow;
  let sourceStartIndex = requestedStartIndex;
  const allowance = Math.min(contextUnits, Math.floor(maxUnits / 4));
  while (firstRow > 0 && startRow - firstRow < contextRows) {
    const previous = source.lineStart(firstRow - 1);
    if (requestedStartIndex - previous > allowance) break;
    sourceStartIndex = previous;
    firstRow--;
  }
  let sourceEndIndex = Math.min(requestedEndIndex, sourceStartIndex + maxUnits);
  if (sourceEndIndex < source.length) {
    const before = source.charCodeAt(sourceEndIndex - 1);
    const after = source.charCodeAt(sourceEndIndex);
    if (
      (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) ||
      (before === 13 && after === 10)
    )
      sourceEndIndex--;
  }
  return {
    text: source.slice(sourceStartIndex, sourceEndIndex),
    startRow: firstRow,
    startColumn: 0,
    sourceStartIndex,
    sourceEndIndex,
    requestedStart: { row: startRow, column: 0 },
    requestedEnd: source.positionAt(sourceEndIndex),
    requestedEndIndex,
    quality: "provisional",
    limited: sourceEndIndex < requestedEndIndex,
  };
}

function requiresRecovery(error) {
  for (let cause = error, depth = 0; cause && depth < 16; cause = cause.cause, depth++)
    if (
      cause instanceof WebAssembly.RuntimeError ||
      cause.failure?.fatal ||
      cause.failure?.recycle ||
      cause.code === "memory-pressure" ||
      cause.failure?.code === "memory-pressure"
    )
      return true;
  return false;
}

// A preview shares immutable grammar assets, but cannot report errors or install
// the normal mode's broken-query fallback into another document's grammar.
function quietGrammars(registry, onError) {
  const facades = new WeakMap();
  const grammar = (original) => {
    if (!original) return original;
    let facade = facades.get(original);
    if (facade) return facade;
    const methods = new Map();
    facade = new Proxy(original, {
      get(target, name) {
        if (name === "reportQueryError" || name === "setQueryForTest") return onError;
        const value = Reflect.get(target, name, target);
        if (typeof value !== "function") return value;
        if (methods.get(name)?.value !== value)
          methods.set(name, { value, bound: value.bind(target) });
        return methods.get(name).bound;
      },
    });
    facades.set(original, facade);
    return facade;
  };
  const facade = new Proxy(registry, {
    get(target, name) {
      if (name === "treeSitterGrammarForLanguageString")
        return (...args) => grammar(target.treeSitterGrammarForLanguageString(...args));
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { registry: facade, grammar };
}

class SyntaxPreview {
  constructor({
    grammars,
    config,
    timeoutMs = 100,
    createMode = (options) => new TreeSitterLanguageMode(options),
    createBuffer = (text) => new TextBuffer({ text }),
    syntaxRuntime = runtime,
  }) {
    if (!grammars) throw new TypeError("Syntax previews require a grammar registry");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Invalid syntax preview timeout");
    this.grammars = grammars;
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.createMode = createMode;
    this.createBuffer = createBuffer;
    this.runtime = syntaxRuntime;
    this.entries = new Map();
    this.closed = false;
  }

  async get(session, range, { signal, context } = {}) {
    if (session.closed || session.mode?.publicationPending === false) this.release(session);
    if (
      this.closed ||
      signal?.aborted ||
      session.closed ||
      session.mode?.publicationPending === false
    )
      return null;
    // Root-range policies describe real document ownership. A policy cannot be
    // applied unchanged to local coordinates in an arbitrary source fragment.
    if (this.grammars.rootLanguageRangesByBuffer?.has(session.buffer)) {
      this.release(session);
      return null;
    }
    const revision = session.buffer.getTextRevision();
    const key = `${session.revision}:${session.generation}:${revision}:${range.startRow}:${range.endRow}`;
    let entry = this.entries.get(session.id);
    if (entry && (entry.key !== key || entry.sourceMode !== session.mode)) {
      this.release(session);
      entry = null;
    }
    if (!entry) {
      entry = {
        key,
        session,
        revision,
        sourceMode: session.mode,
        generation: session.generation,
        sourceRevision: session.revision,
        controller: new AbortController(),
        subscriptions: [],
        disposed: false,
        waiters: 0,
        queryFailed: false,
      };
      this.entries.set(session.id, entry);
      const invalidate = () => this.disposeEntry(entry);
      entry.subscriptions.push(
        session.buffer.onDidApplyChanges(invalidate),
        session.buffer.onDidDestroy(invalidate),
      );
      if (session.buffer.onDidChangeLanguageMode)
        entry.subscriptions.push(session.buffer.onDidChangeLanguageMode(invalidate));
      entry.timer = setTimeout(invalidate, this.timeoutMs);
      entry.promise = this.prepare(entry, range, context).finally(() => clearTimeout(entry.timer));
      // The cache owns preparation even when a requesting viewport is cancelled.
      entry.promise.catch(() => {});
    }
    entry.waiters++;
    try {
      return await this.wait(entry.promise, signal);
    } finally {
      entry.waiters--;
      if (signal?.aborted && entry.waiters === 0) this.disposeEntry(entry);
    }
  }

  current(entry) {
    return (
      !entry.disposed &&
      !entry.session.closed &&
      entry.session.revision === entry.sourceRevision &&
      entry.session.generation === entry.generation &&
      entry.session.mode === entry.sourceMode &&
      entry.session.mode?.publicationPending !== false &&
      entry.session.buffer.getTextRevision() === entry.revision
    );
  }

  async prepare(entry, range, context) {
    try {
      const session = entry.session;
      const window = selectPreviewWindow(session.buffer.getTextSnapshot(), range);
      const quiet = quietGrammars(this.grammars, () => {
        entry.queryFailed = true;
      });
      const grammar = session.mode?.grammar ?? this.grammars.grammarForScopeName(session.scopeName);
      if (!grammar || !this.current(entry)) {
        this.disposeEntry(entry);
        return null;
      }
      const buffer = (entry.buffer = this.createBuffer(window.text));
      this.runtime.registerBuffer(buffer, () => ({
        ...(typeof context === "function" ? context() : context),
        session: session.id,
        revision: entry.sourceRevision,
        scopeName: grammar.scopeName,
        bufferLength: session.buffer.getLength(),
        operation: "preview",
      }));
      const mode = (entry.mode = this.createMode({
        buffer,
        grammar: quiet.grammar(grammar),
        grammars: quiet.registry,
        config: this.config,
        parsePriority: -10,
        queryBudget: { presentationWindowLength: 2048 },
        reportFailure: () => {
          entry.queryFailed = true;
        },
        syncTimeoutMicros: 1000,
        maxIdleParsersPerLanguage: 0,
      }));
      // No display layer belongs to this private buffer. Its only presentation
      // request is the bounded caller window; exact session analyses never use it.
      mode.requestHighlighting(entry, [], false);
      buffer.setLanguageMode(mode);
      const readiness = Promise.resolve(mode.ready).then(() => mode.atGrammarSettlement());
      const transaction = await this.wait(readiness, entry.controller.signal);
      const parseError = transaction?.parseError ?? mode.lastTransactionParseError;
      const recoveryError = [transaction?.parseError, mode.lastTransactionParseError].find(
        requiresRecovery,
      );
      // A preview failure is optional only while the shared runtime remains
      // usable. Cooperative memory pressure needs the same recovery signal as
      // a hard WASM trap, even when settlement returns an error as data.
      if (recoveryError) throw recoveryError;
      if (parseError && this.runtime.failure) throw parseError;
      if (!transaction || parseError || entry.queryFailed || !this.current(entry)) {
        this.disposeEntry(entry);
        return null;
      }
      const { text: _text, ...coordinates } = window;
      return { ...coordinates, mode, buffer, dispose: () => this.disposeEntry(entry) };
    } catch (error) {
      this.disposeEntry(entry);
      if (this.runtime.failure || requiresRecovery(error)) throw error;
      return null;
    }
  }

  wait(promise, signal) {
    if (signal?.aborted) {
      Promise.resolve(promise).catch(() => {});
      return Promise.resolve(null);
    }
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => resolve(null);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(promise)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  disposeEntry(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    clearTimeout(entry.timer);
    entry.controller.abort();
    for (const subscription of entry.subscriptions) subscription.dispose();
    entry.subscriptions.length = 0;
    if (entry.mode && entry.buffer?.getLanguageMode() !== entry.mode) entry.mode.destroy();
    entry.buffer?.destroy();
    if (this.entries.get(entry.session.id) === entry) this.entries.delete(entry.session.id);
  }

  release(session) {
    const entry = this.entries.get(typeof session === "object" ? session.id : session);
    if (entry) this.disposeEntry(entry);
  }

  dispose() {
    this.closed = true;
    for (const entry of this.entries.values()) this.disposeEntry(entry);
  }
}

module.exports = SyntaxPreview;
module.exports.selectPreviewWindow = selectPreviewWindow;
