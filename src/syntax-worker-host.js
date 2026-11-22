const path = require("node:path");
const fs = require("node:fs");
const Config = require("./config");
const SelectorStore = require("@lumine-code/selector-store");
const GrammarRegistry = require("./grammar-registry");
const TreeSitterGrammar = require("./tree-sitter-grammar");
const TreeSitterLanguageMode = require("./tree-sitter-language-mode");
const FoldResolver = require("./tree-sitter-fold-resolver");
const TextBuffer = require("./text-buffer");
const runtime = require("./tree-sitter-runtime");
const { paintTile } = require("./syntax-paint-policy");
const { windowTile, rangeKey } = require("./syntax-paint-window");
const SyntaxPreview = require("./syntax-preview");
const { points: analyzePoints } = require("./syntax-analysis-operations");
const { createInputSnapshot, isWhitespaceInsertion } = require("./tree-sitter-input-snapshot");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const { contextFor, serialize } = require("./syntax-analysis-context");
const {
  PAINT_PACKET_EVENTS,
  INLINE_INDENT_ROWS,
  canInlineIndentation,
  canPrepareInputIndentation,
} = require("./syntax-worker-protocol");
const { Point, Range } = TextBuffer;
const INPUT_PARSE_PRIORITY = -100;
const OPTIONAL_PAINT_BUDGET_MS = 8;
const PAINT_SCAN_SLICE_MS = 4;
const MAX_SCOPED_POINTS = 256;
const FOLD_BUILTINS = new Set([
  "getFoldRangeForRow",
  "getFoldableRanges",
  "getFoldableRangesAtIndentLevel",
  "getFoldableRangeContainingPoint",
  "isFoldableAtRow",
]);

function aborted(message = "Syntax snapshot is obsolete") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function waitFor(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? aborted());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

class SyntaxWorkerHost {
  constructor({ notify = () => {} } = {}) {
    this.notify = notify;
    this.runtimeSubscription = runtime.onDidFail((failure) => {
      this.notify({ event: "runtime-failure", failure });
    });
    this.config = new Config();
    this.sessions = new Map();
    this.modules = [];
    this.watches = new Map();
    this.nextWatch = 0;
    this.environmentVersion = 0;
    this.environmentReady = Promise.resolve();
    this.grammars = new GrammarRegistry({
      config: this.config,
      fileWatchClient: {
        watchFile: (file) => this.watchFile(file),
      },
    });
    this.previews = new SyntaxPreview({ grammars: this.grammars, config: this.config });
    globalThis.lumine = {
      config: this.config,
      grammars: this.grammars,
      window: { isDevMode: () => this.devMode, isSpecMode: () => this.specMode },
      workspace: {
        getFocusedWindow: () => null,
        getWindows: () => [],
        getActiveTextEditor: () => ({
          getBuffer: () => this.sessions.get(this.activeSession)?.buffer,
        }),
      },
      notifications: {
        addError: (message, options) =>
          this.notify({ event: "notification", level: "error", message, options }),
        addSuccess: (message, options) =>
          this.notify({ event: "notification", level: "success", message, options }),
        beep: () => {},
      },
    };
  }

  watchFile(file) {
    const id = ++this.nextWatch;
    const emitter = new Emitter();
    let resolve, reject;
    const ready = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    const watch = { emitter, resolve, reject };
    this.watches.set(id, watch);
    this.notify({ event: "watch", id, file });
    return {
      ready,
      onDidChange: (callback) => emitter.on("change", callback),
      onDidInvalidate: (callback) => emitter.on("invalidate", callback),
      onDidError: (callback) => emitter.on("error", callback),
      dispose: () => {
        if (!this.watches.delete(id)) return;
        resolve();
        emitter.dispose();
        this.notify({ event: "unwatch", id });
      },
    };
  }

  control(message) {
    const watch = this.watches.get(message.watch);
    if (message.operation === "watch-ready") watch?.resolve();
    else if (message.operation === "watch-error") {
      const error = new Error(message.message);
      watch?.reject(error);
      watch?.emitter.emit("error", error);
    } else if (message.operation === "watch-event") {
      for (const session of this.sessions.values()) this.abortJobs(session);
      watch?.emitter.emit(message.kind, message.events);
    } else if (message.operation === "unload-module") {
      for (const session of this.sessions.values()) this.abortJobs(session);
      this.clearPackageModules(message.path);
    } else if (message.operation === "focus") this.activeSession = message.session;
    else if (message.operation === "release") this.closeSession(message.session);
  }

  clearPackageModules(root) {
    if (typeof root !== "string" || !path.isAbsolute(root))
      throw new TypeError("Invalid syntax package path");
    try {
      root = fs.realpathSync(root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      root = path.resolve(root);
    }
    if (
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      path.resolve(root) === path.resolve(__dirname, "..")
    )
      throw new TypeError("Invalid syntax package path");
    const removed = new Set();
    for (const file of Object.keys(require.cache)) {
      const relative = path.relative(root, file);
      if (
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative) &&
        !relative.split(path.sep).includes("node_modules")
      ) {
        removed.add(require.cache[file]);
        delete require.cache[file];
      }
    }
    for (const module of Object.values(require.cache))
      module.children = module.children.filter((child) => !removed.has(child));
  }

  updateConfiguration(configuration) {
    this.config.schema = configuration.schema;
    this.config.defaultSettings = configuration.values;
    const store = new SelectorStore();
    for (const entry of configuration.scoped)
      store.addProperties(
        entry.source,
        { [entry.selector]: entry.properties },
        { priority: entry.priority },
      );
    this.config.scopedSettingsStore = store;
    this.config.resolvedScopedSettingsStore = null;
    this.config.emitChangeEvent({ keyPath: null, scopeSelector: null, source: "syntax-worker" });
  }

  async updateEnvironment(data) {
    this.environmentVersion = data.version;
    this.devMode = data.devMode;
    this.specMode = data.specMode;
    for (const session of this.sessions.values()) this.invalidate(session);
    for (const module of this.modules.splice(0)) module.dispose?.();
    for (const grammar of this.grammars.getGrammars()) {
      this.grammars.removeGrammar(grammar);
      grammar.destroy?.();
    }
    this.updateConfiguration(data.configuration);
    for (const { file, definition } of data.grammars) {
      const grammar = new TreeSitterGrammar(this.grammars, file, definition);
      grammar.subscriptions.add(
        grammar.onDidChangeQuery(({ filePath, queryType }) =>
          this.notify({
            event: "query-changed",
            scopeName: grammar.scopeName,
            filePath,
            queryType,
          }),
        ),
      );
      this.grammars.addGrammar(grammar);
    }
    for (const descriptor of data.modules ?? []) {
      this.modules.push(
        this.grammars.registerSyntaxModule(descriptor.path, {
          method: descriptor.method,
          args: descriptor.args ?? [],
        }),
      );
    }
    for (const session of this.sessions.values())
      if (session.initialized) this.installMode(session);
    return data.version;
  }

  invalidate(session) {
    this.abortJobs(session);
    session.subscriptions?.dispose();
  }

  abortJobs(session) {
    for (const id of session.forks ?? []) this.closeSession(id);
    session.generation++;
    session.metadataDirty = true;
    session.tabStyleReady = false;
    for (const controller of session.jobs) controller.abort(aborted());
    this.notify({ event: "invalidate", session: session.id, generation: session.generation });
  }

  installMode(session) {
    return runtime.run(this.contextFor(session, "initialize"), () =>
      this.installModeCurrent(session),
    );
  }

  installModeCurrent(session) {
    const grammar = this.grammars.grammarForScopeName(session.scopeName);
    if (!grammar || grammar.type !== "tree-sitter")
      throw new Error(`Unavailable grammar: ${session.scopeName}`);
    const mode = new TreeSitterLanguageMode({
      buffer: session.buffer,
      grammar,
      config: this.config,
      grammars: this.grammars,
      reportFailure: (error) => {
        if (this.sessions.get(session.id) === session && session.mode === mode)
          this.failSession(session, error);
      },
      initialSyntaxSnapshot: session.initialSyntaxSnapshot,
      initialSyntaxChanges: session.initialSyntaxChanges,
      parsePriority: session.purpose === "input" ? INPUT_PARSE_PRIORITY : undefined,
      indentationOnly: Boolean(session.parent),
      indentationRanges: session.indentationRanges,
      editedIndentationRows: session.editedIndentationRows,
      scopedPresentation: !session.parent,
    });
    session.initialSyntaxSnapshot = null;
    session.initialSyntaxChanges = null;
    session.captureInitialChanges?.dispose();
    // The renderer owns presentation windows. Semantic work must not also
    // prepare an unused default viewport at the beginning of every document.
    mode.requestHighlighting(this, []);
    session.mode = mode;
    session.metadata = null;
    session.scopedPaint = null;
    session.tabStyleReady = false;
    session.buffer.setLanguageMode(mode);
    session.subscriptions = new CompositeDisposable(
      mode.onDidChangeHighlighting((range) => {
        if (!mode.publicationPending) this.previews.release(session);
        if (range.start.row <= 1000) session.tabStyleReady = false;
        const scoped = session.scopedPaint;
        this.notify({
          event: "highlight",
          session: session.id,
          revision: session.revision,
          generation: session.generation,
          range: range.serialize(),
          reconciled:
            mode.publishingHighlightRanges &&
            scoped?.revision === session.revision &&
            scoped?.generation === session.generation &&
            scoped.epoch === mode.getSyntaxRequestEpoch(),
        });
      }),
      mode.onDidTokenize(() =>
        this.notify({ event: "tokenize", session: session.id, generation: session.generation }),
      ),
      mode.onDidUseInjectionGrammar((grammar) => {
        session.metadataDirty = true;
        this.notify({
          event: "injection",
          session: session.id,
          scopeName: grammar.scopeName,
        });
      }),
    );
    void mode.ready.catch((error) => {
      if (this.sessions.get(session.id) === session && session.mode === mode)
        this.failSession(session, error);
    });
  }

  contextFor(session, operation) {
    return (
      session && {
        session: session.id,
        scopeName: session.scopeName,
        revision: session.revision,
        bufferLength: session.buffer.getLength(),
        operation,
      }
    );
  }

  failSession(session, error) {
    if (runtime.failure) {
      runtime.observe(error, this.contextFor(session, "parse"));
      return;
    }
    if (session.failure || error.name === "AbortError") return;
    session.failure = true;
    session.failureError = error;
    this.notify({
      event: "failure",
      session: session.id,
      failure: {
        ...this.contextFor(session, "parse"),
        code: error.code === "ERR_SYNTAX_QUERY_BUDGET" ? "query-budget" : "analysis-failure",
        reason: error.reason,
        fatal: false,
        message: error.message,
        stack: error.stack,
        ...error.failure,
      },
    });
    this.closeSession(session.id);
  }

  closeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.releaseInputPriority?.();
    session.releaseInputPriority = null;
    this.sessions.get(session.parent)?.forks?.delete(id);
    session.captureInitialChanges?.dispose();
    session.inputSnapshot?.destroy();
    session.inputBaseline = null;
    session.inputChanges = null;
    session.forkBase = null;
    session.initialSyntaxSnapshot?.close();
    session.pendingEdit?.reject(aborted("Syntax document was closed"));
    this.previews.release(session);
    this.invalidate(session);
    session.buffer.destroy();
    // Removing a root policy from a live mode schedules an unrestricted parse.
    // End the candidate's syntax lifetime before releasing that registration.
    session.rootRanges?.dispose();
    if (runtime.releaseSession(id)) this.notify({ event: "recycle-requested" });
  }

  async dispatch(operation, data, { signal, emit } = {}) {
    const session = this.sessions.get(data.session);
    try {
      const run = () =>
        runtime.run(this.contextFor(this.sessions.get(data.session), operation), () =>
          this.dispatchOperation(operation, data, { signal, emit }),
        );
      return await (operation === "input-indent" ? this.withInputPriority(run) : run());
    } catch (error) {
      if (session?.parent && session.failureError && !signal?.aborted)
        throw Object.assign(
          new Error("Unable to prepare input indentation", {
            cause: session.failureError,
          }),
          {
            code: "ERR_SYNTAX_INPUT",
            reason:
              session.failureError.failure?.code ?? session.failureError.code ?? "analysis-failure",
          },
        );
      if (error.code === "ERR_SYNTAX_QUERY_BUDGET") {
        if (
          operation === "builtin" &&
          FOLD_BUILTINS.has(data.method) &&
          error.reason !== "cancelled"
        )
          throw error;
        const unavailable = aborted("Syntax query exceeded its resource budget");
        unavailable.code = error.code;
        unavailable.reason = error.reason;
        throw unavailable;
      }
      throw error;
    }
  }

  acquireInputPriority() {
    if (this.closed) throw aborted("Syntax worker was closed");
    if (!this.inputBarrier) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      this.inputBarrier = { promise, resolve, count: 0 };
    }
    const barrier = this.inputBarrier;
    clearImmediate(barrier.wake);
    barrier.wake = null;
    barrier.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--barrier.count === 0 && this.inputBarrier === barrier) {
        // Deliver the input reply before waking optional presentation. A new
        // input may join this barrier before the next task; do not release it.
        barrier.wake = setImmediate(() => {
          if (barrier.count || this.inputBarrier !== barrier) return;
          this.inputBarrier = null;
          barrier.resolve();
        });
      }
    };
  }

  async withInputPriority(callback) {
    const release = this.acquireInputPriority();
    try {
      return await callback();
    } finally {
      release();
    }
  }

  waitForInput(current, signal) {
    if (this.closed) throw aborted("Syntax worker was closed");
    current?.();
    const barrier = this.inputBarrier;
    if (!barrier) return null;
    return waitFor(barrier.promise, signal).then(() => this.waitForInput(current, signal));
  }

  async yieldForInput(current, signal) {
    await new Promise(setImmediate);
    const input = this.waitForInput(current, signal);
    if (input) await input;
    current?.();
  }

  async settleInputBaseline(session, signal) {
    const parent = this.sessions.get(session.parent);
    const { source, draftRevision, mode, revision, generation, epoch } = session.forkBase;
    const current = () => {
      if (
        !parent ||
        this.sessions.get(session.id) !== session ||
        parent.mode !== mode ||
        parent.revision !== revision ||
        parent.generation !== generation ||
        mode.getSyntaxRequestEpoch() !== epoch ||
        parent.buffer.getTextSnapshot() !== source
      )
        throw aborted();
    };
    current();
    if (
      !mode.publicationPending &&
      session.inputBaseline?.complete &&
      session.inputBaseline.epoch === epoch
    ) {
      if (mode.lastTransactionParseError) throw mode.lastTransactionParseError;
      return mode;
    }

    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    session.jobs.add(controller);
    const release =
      session.purpose === "input" ? mode.acquireInputParsePriority(INPUT_PARSE_PRIORITY) : null;
    try {
      const transaction = await waitFor(mode.atGrammarSettlement(), combined);
      combined.throwIfAborted();
      current();
      if (transaction.parseError || mode.lastTransactionParseError)
        throw transaction.parseError ?? mode.lastTransactionParseError;
      const baseline = mode.captureSyntaxSnapshot({ indentationOnly: true });
      session.inputBaseline = baseline;
      session.initialSyntaxSnapshot?.close();
      session.initialSyntaxSnapshot = baseline?.restore(source, draftRevision);
      return mode;
    } finally {
      release?.();
      session.jobs.delete(controller);
    }
  }

  async dispatchOperation(operation, data, { signal, emit } = {}) {
    if (operation === "environment") {
      this.environmentReady = this.environmentReady
        .catch(() => {})
        .then(() => this.updateEnvironment(data));
      return waitFor(this.environmentReady, signal);
    }
    await waitFor(this.environmentReady, signal);
    signal?.throwIfAborted();
    if (operation === "configure") {
      for (const session of this.sessions.values()) this.abortJobs(session);
      this.updateConfiguration(data.configuration);
      return data.version;
    }
    if (operation === "open") {
      if (this.sessions.has(data.session)) throw new Error("Duplicate syntax session");
      const buffer = new TextBuffer({ text: "" });
      buffer.getPath = () => data.path;
      const session = {
        id: data.session,
        buffer,
        scopeName: data.scopeName,
        revision: data.revision,
        generation: 0,
        initialized: false,
        jobs: new Set(),
      };
      this.sessions.set(data.session, session);
      runtime.registerBuffer(buffer, () => this.contextFor(session));
      if (data.rootRanges)
        session.rootRanges = this.grammars.setRootLanguageRanges(buffer, data.rootRanges);
      return { revision: session.revision, generation: session.generation };
    }
    const session = this.sessions.get(data.session);
    if (!session) throw aborted("Syntax document was closed");
    if (
      operation === "input-indent" &&
      (!data.inline ||
        !data.ranges?.length ||
        !canInlineIndentation(data.ranges) ||
        (data.target != null && !canPrepareInputIndentation(data.changes, data.ranges)))
    )
      throw new RangeError("Interactive indentation exceeds its request budget");
    if ((operation === "prepared-indent" || operation === "input-indent") && data.target != null) {
      const target = data.target;
      if (!Number.isSafeInteger(target) || this.sessions.has(target))
        throw new Error("Invalid speculative syntax session");
      try {
        await this.dispatch(
          "fork",
          {
            session: session.id,
            revision: data.revision,
            target,
            purpose:
              operation === "input-indent" || data.options?.isPastedText === false
                ? "input"
                : undefined,
          },
          { signal },
        );
        const candidate = this.sessions.get(target);
        if (!candidate) throw aborted("Syntax candidate was closed");
        await this.dispatch(
          "edit",
          { session: target, beforeRevision: 0, revision: 1, changes: data.changes },
          { signal },
        );
        await this.dispatch(
          "initialize",
          { session: target, indentationRanges: data.ranges, indentationOptions: data.options },
          { signal },
        );
        const result = await this.dispatch(
          operation,
          {
            session: target,
            revision: 1,
            ranges: data.ranges,
            tabLength: data.tabLength,
            options: data.options,
            inline: data.inline,
          },
          { signal, emit },
        );
        return { ...result, revision: data.revision, generation: session.generation };
      } finally {
        this.closeSession(target);
      }
    }
    const { buffer } = session;
    if (operation === "edit-begin") {
      for (const id of session.forks ?? []) this.closeSession(id);
      if (
        session.pendingEdit ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < session.revision ||
        data.beforeRevision !== session.revision ||
        !Number.isSafeInteger(data.count) ||
        data.count < 0
      )
        throw new Error("Invalid syntax edit transaction");
      let resolve, reject;
      const ready = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      ready.catch(() => {});
      session.pendingEdit = {
        revision: data.revision,
        count: data.count,
        changes: [],
        ready,
        resolve,
        reject,
        text: null,
      };
      for (const controller of session.jobs) controller.abort(aborted());
      return;
    }
    if (operation.startsWith("edit-") && session.pendingEdit) {
      const edit = session.pendingEdit;
      if (operation === "edit-chunk") {
        if (
          edit.text ||
          !Array.isArray(data.changes) ||
          data.changes.length > 128 ||
          edit.changes.length + data.changes.length > edit.count
        )
          throw new Error("Invalid syntax edit packet");
        let units = 0;
        for (const change of data.changes) {
          if (typeof change.text !== "string") throw new TypeError("Syntax edits require text");
          units += change.text.length;
        }
        if (units > 64 * 1024) throw new Error("Syntax edit packet is too large");
        for (const change of data.changes) edit.changes.push(change);
        return;
      }
      if (operation === "edit-text-begin") {
        if (
          edit.text ||
          edit.changes.length >= edit.count ||
          !Number.isSafeInteger(data.length) ||
          data.length < 0
        )
          throw new Error("Invalid syntax text transfer");
        edit.text = {
          startIndex: data.startIndex,
          oldEndIndex: data.oldEndIndex,
          length: data.length,
          units: 0,
          source: new (require("./text-model").PieceTree)(),
        };
        return;
      }
      if (operation === "edit-text-chunk") {
        if (
          !edit.text ||
          typeof data.text !== "string" ||
          data.text.length > 64 * 1024 ||
          edit.text.units + data.text.length > edit.text.length
        )
          throw new Error("Invalid syntax text packet");
        edit.text.source = edit.text.source.replace(
          edit.text.source.length,
          edit.text.source.length,
          data.text,
        );
        edit.text.units += data.text.length;
        return;
      }
      if (operation === "edit-text-end") {
        if (!edit.text || edit.text.units !== edit.text.length)
          throw new Error("Incomplete syntax text transfer");
        edit.changes.push({
          startIndex: edit.text.startIndex,
          oldEndIndex: edit.text.oldEndIndex,
          text: edit.text.source,
        });
        edit.text = null;
        return;
      }
      if (operation === "edit-commit") {
        if (edit.text || edit.changes.length !== edit.count)
          throw new Error("Incomplete syntax edit transaction");
        session.revision = edit.revision;
        session.tabStyleReady = false;
        try {
          this.applyChanges(buffer, edit.changes);
        } catch (error) {
          this.closeSession(session.id);
          throw error;
        }
        session.pendingEdit = null;
        edit.resolve();
        return;
      }
    }
    if (operation.startsWith("edit-")) throw new Error("Invalid syntax edit transaction state");
    if (operation === "path") {
      buffer.getPath = () => data.path;
      this.abortJobs(session);
      return;
    }
    if (operation === "root-ranges") {
      this.abortJobs(session);
      const previous = session.rootRanges;
      session.rootRanges = data.descriptor
        ? this.grammars.setRootLanguageRanges(buffer, data.descriptor)
        : null;
      previous?.dispose();
      return;
    }
    if (operation === "append") {
      if (session.initialized) throw new Error("Syntax document is already initialized");
      const end = buffer.getLength();
      this.applyChanges(buffer, [{ startIndex: end, oldEndIndex: end, text: data.text }]);
      return;
    }
    if (operation === "initialize") {
      if (session.initialized) throw new Error("Syntax document is already initialized");
      session.initialized = true;
      const changes =
        session.parent && data.indentationOptions?.isPastedText === false
          ? session.initialSyntaxChanges.flatMap((batch) => batch.changes)
          : null;
      let snapshot;
      if (changes && isWhitespaceInsertion(changes)) {
        const mode = await this.settleInputBaseline(session, signal);
        signal?.throwIfAborted();
        if (
          this.sessions.get(session.id) !== session ||
          mode.getSyntaxRequestEpoch() !== session.forkBase.epoch
        )
          throw aborted();
        session.inputChanges = changes;
        snapshot = createInputSnapshot(mode, buffer, changes, {
          signal,
          snapshot: session.inputBaseline,
        });
      }
      session.forkBase = null;
      if (snapshot) {
        session.inputSnapshot = snapshot;
        session.mode = snapshot;
        session.captureInitialChanges?.dispose();
        session.initialSyntaxSnapshot?.close();
        session.initialSyntaxSnapshot = null;
        session.initialSyntaxChanges = null;
        return;
      }
      // A parsed ownership proof must discover the complete relevant forest.
      // Token-changing operations retain the ordinary local-context discovery.
      const validateInputOwnership = session.inputChanges && session.inputBaseline?.complete;
      if (session.parent && data.indentationRanges?.length && !validateInputOwnership) {
        const contexts = [];
        let deadline = performance.now() + 4;
        let previousEnd = -1;
        for (const [start, last] of data.indentationRanges) {
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(last) ||
            start <= previousEnd ||
            last < start ||
            last > buffer.getLastRow()
          )
            throw new RangeError("Invalid indentation context");
          let first = Math.max(0, start - 1);
          while (first > previousEnd && first > 0 && buffer.isRowBlank(first)) {
            first--;
            if (performance.now() >= deadline) {
              await new Promise((resolve) => setImmediate(resolve));
              signal?.throwIfAborted();
              if (this.sessions.get(session.id) !== session) throw aborted();
              deadline = performance.now() + 4;
            }
          }
          const context = new Range([first, 0], buffer.clipPosition([last + 1, 0]));
          const previous = contexts.at(-1);
          if (previous?.intersectsWith(context))
            contexts[contexts.length - 1] = previous.union(context);
          else contexts.push(context);
          previousEnd = last;
          if (performance.now() >= deadline) {
            await new Promise((resolve) => setImmediate(resolve));
            signal?.throwIfAborted();
            if (this.sessions.get(session.id) !== session) throw aborted();
            deadline = performance.now() + 4;
          }
        }
        session.indentationRanges = contexts;
        const editedRows = [];
        for (const [start, last] of data.indentationRanges) {
          if (last - start + 1 + editedRows.length > INLINE_INDENT_ROWS) break;
          for (let row = start; row <= last; row++) editedRows.push(row);
        }
        if (
          editedRows.length ===
            data.indentationRanges.reduce((count, [first, last]) => count + last - first + 1, 0) &&
          editedRows.every((row) => data.indentationOptions?.rowOptions?.get(row)?.edited)
        )
          session.editedIndentationRows = editedRows;
      }
      this.installMode(session);
      return;
    }
    if (operation === "edit") {
      for (const id of session.forks ?? []) this.closeSession(id);
      if (session.pendingEdit) throw new Error("Syntax edit transaction is already open");
      if (!Number.isSafeInteger(data.revision) || data.revision < session.revision)
        throw new Error("Invalid syntax revision");
      if (data.beforeRevision !== session.revision) throw new Error("Syntax revision mismatch");
      for (const controller of session.jobs) controller.abort(aborted());
      session.revision = data.revision;
      if (data.changes.some((change) => !change.range || change.range[0][0] <= 1000))
        session.tabStyleReady = false;
      try {
        this.applyChanges(buffer, data.changes);
      } catch (error) {
        this.closeSession(session.id);
        throw error;
      }
      return { revision: session.revision, generation: session.generation };
    }
    if (operation === "close") {
      this.closeSession(data.session);
      return;
    }
    if (session.pendingEdit) await waitFor(session.pendingEdit.ready, signal);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const revision = session.revision,
      generation = session.generation,
      mode = session.mode;
    const useQueryEpoch = operation === "view" || operation === "points";
    const queryEpoch = useQueryEpoch ? mode?.getSyntaxRequestEpoch?.() : null;
    if (data.revision !== undefined && data.revision !== revision) throw aborted();
    session.jobs.add(controller);
    const current = () => {
      combined.throwIfAborted();
      if (
        this.sessions.get(session.id) !== session ||
        session.revision !== revision ||
        session.generation !== generation ||
        session.mode !== mode ||
        (useQueryEpoch && mode?.getSyntaxRequestEpoch?.() !== queryEpoch)
      )
        throw aborted();
    };
    if (emit) {
      const deliver = emit;
      emit = (...args) => {
        current();
        // Session invalidation must release a paused stream even if its
        // consumer has not acknowledged the last packet yet.
        return waitFor(deliver(...args), combined);
      };
    }
    try {
      if (!session.initialized) throw new Error("Syntax document is not initialized");
      if (operation === "points") {
        const value = await this.pointQueries(session, data, { signal: combined, emit, current });
        current();
        return { revision, generation, value, syntaxReady: !mode.publicationPending };
      }
      // Retain available syntax baselines without waiting for parent parsing.
      // Fresh reconciliation validates the complete embedded-language graph.
      if (operation === "fork") {
        if (!Number.isSafeInteger(data.target) || this.sessions.has(data.target))
          throw new Error("Invalid speculative syntax session");
        if (data.purpose !== undefined && data.purpose !== "input")
          throw new TypeError("Invalid speculative syntax purpose");
        const source = buffer.getTextSnapshot();
        const copy = new TextBuffer({ text: source });
        copy.getPath = () => buffer.getPath();
        const fork = {
          id: data.target,
          parent: session.id,
          buffer: copy,
          scopeName: session.scopeName,
          revision: 0,
          generation: 0,
          initialized: false,
          purpose: data.purpose,
          forkBase: {
            source,
            draftRevision: copy.getTextRevision(),
            mode,
            revision,
            generation,
            epoch: mode.getSyntaxRequestEpoch(),
          },
          jobs: new Set(),
          initialSyntaxChanges: [],
        };
        this.sessions.set(fork.id, fork);
        (session.forks ??= new Set()).add(fork.id);
        try {
          // Input intent survives transport boundaries. A streamed operation
          // owns this lease through initialization and every acknowledged
          // packet, until its private session is released or invalidated.
          if (fork.purpose === "input") fork.releaseInputPriority = this.acquireInputPriority();
          runtime.registerBuffer(copy, () => this.contextFor(fork));
          const policy = this.grammars.rootLanguageRangesByBuffer.get(buffer)?.descriptor;
          if (policy) fork.rootRanges = this.grammars.setRootLanguageRanges(copy, policy);
          fork.inputBaseline = mode.captureSyntaxSnapshot({ indentationOnly: true });
          fork.initialSyntaxSnapshot = fork.inputBaseline?.fork(copy);
          fork.captureInitialChanges = copy.onDidApplyChanges((batch) =>
            fork.initialSyntaxChanges.push(batch),
          );
          return { revision, generation, value: { id: fork.id } };
        } catch (error) {
          this.closeSession(fork.id);
          throw error;
        }
      }
      let transaction;
      try {
        const first =
          operation === "view" &&
          data.allowPreview &&
          Array.isArray(data.ranges?.[0]) &&
          mode.publicationPending
            ? paintTile(buffer, ...data.ranges[0])
            : null;
        const settlement =
          operation !== "view"
            ? mode.atGrammarSettlement()
            : first && this.waitForViewSyntax(session, new Range(first.start, first.end), combined);
        if (first) {
          // Give the exact small-edit path its ordinary fast turn before
          // spending anything on a private, explicitly provisional preview.
          let timer;
          const fast = await Promise.race([
            settlement.then((value) => ({ value })),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), 4);
            }),
          ]).finally(() => clearTimeout(timer));
          current();
          if (!fast) {
            void settlement.then(
              (value) => {
                if (
                  value?.parseError &&
                  this.sessions.get(session.id) === session &&
                  session.mode === mode
                )
                  this.failSession(session, value.parseError);
              },
              (error) => {
                if (this.sessions.get(session.id) === session && session.mode === mode)
                  this.failSession(session, error);
              },
            );
            const preview = await this.previewView(
              session,
              data.ranges[0],
              emit,
              current,
              combined,
            );
            if (preview) return { revision, generation, value: preview, syntaxReady: false };
          } else transaction = fast.value;
        }
        transaction ??= settlement ? await waitFor(settlement, combined) : {};
        this.previews.release(session);
      } catch (error) {
        this.failSession(session, error);
        throw error;
      }
      current();
      const syntaxReady = !(transaction.parseError || mode.lastTransactionParseError);
      if (!syntaxReady) {
        this.failSession(session, transaction.parseError ?? mode.lastTransactionParseError);
        throw aborted("Syntax analysis is unavailable");
      }
      let value;
      if (operation === "prepared-indent" || operation === "input-indent") {
        if (
          session.parent &&
          !session.inputSnapshot &&
          session.inputChanges &&
          session.inputBaseline?.complete &&
          data.options?.isPastedText === false
        ) {
          const parent = this.sessions.get(session.parent);
          if (!parent) throw aborted();
          mode.ensureQueriesForLayersSync("indentsQuery");
          session.inputSnapshot = createInputSnapshot(parent.mode, buffer, session.inputChanges, {
            snapshot: session.inputBaseline,
            ownershipSnapshot: mode.captureSyntaxSnapshot({ indentationOnly: true }),
            signal: combined,
            isCurrent: current,
          });
        }
        const indentationMode = session.inputSnapshot ?? mode;
        const { IndentationLevels } = require("./tree-sitter-indentation-stream");
        const history = new IndentationLevels();
        const levels = data.inline && canInlineIndentation(data.ranges) ? [] : null;
        const scan = async function* () {
          if (data.options?.isPastedText === false) {
            yield* indentationMode.scanSuggestedIndentation(data.ranges, data.tabLength, {
              ...data.options,
              indentationLevels: history,
              signal: combined,
              isCurrent: current,
            });
            return;
          }
          for (const [start, end] of data.ranges)
            yield* indentationMode.scanSuggestedIndentation([[start, end]], data.tabLength, {
              ...data.options,
              isPastedText: data.options?.isPastedText !== false,
              indentationLevels: history,
              signal: combined,
              isCurrent: current,
            });
        };
        let previousEnd = -1,
          count = 0;
        for (const [start, end] of data.ranges) {
          if (start <= previousEnd) throw new RangeError("Overlapping paste indentation ranges");
          previousEnd = end;
        }
        for await (const batch of scan()) {
          current();
          for (const [row, level] of batch) {
            const rowOptions = data.options?.rowOptions?.get(row) ?? data.options;
            if (level !== null)
              history.set(
                row,
                rowOptions?.preserveLeadingWhitespace
                  ? indentationMode.indentResolver.indentLevelForBufferRow(
                      row,
                      data.tabLength,
                      rowOptions.insertedIndentLengths?.get(row) ?? 0,
                      Math.floor(level * data.tabLength),
                    )
                  : level,
              );
            count++;
          }
          if (levels) {
            if (levels.length + batch.length > INLINE_INDENT_ROWS)
              throw new RangeError("Inline indentation result exceeds its row budget");
            levels.push(...batch);
          } else await emit(batch);
        }
        value = levels ? { count, levels } : { count };
      } else if (operation === "settle") {
        mode.ensureQueriesForLayersSync("indentsQuery");
        const error = transaction.parseError ?? mode.lastTransactionParseError;
        value = {
          ...this.metadata(session),
          range: transaction.range,
          parseError: error ? { name: error.name, message: error.message } : null,
        };
      } else if (operation === "view")
        value = await this.view(
          session,
          data.ranges,
          data.stream ? emit : null,
          current,
          data.follow,
          data.presentation,
          combined,
          data.optional,
        );
      else if (operation === "builtin") {
        if (FOLD_BUILTINS.has(data.method)) {
          const input = this.waitForInput(current, combined);
          if (input) await input;
          value = await this.foldBuiltin(mode, data.method, data.args, {
            signal: combined,
            yieldTurn: () => this.yieldForInput(current, combined),
          });
        } else value = await this.builtin(mode, data.method, data.args);
        if (data.stream && (Array.isArray(value) || value instanceof Map)) {
          const kind = value instanceof Map ? "map" : "array";
          const count = value.size ?? value.length;
          let packet = [];
          for (const entry of value) {
            packet.push(serialize(entry));
            if (packet.length === 256) {
              current();
              await emit({ kind, values: packet });
              current();
              packet = [];
            }
          }
          if (packet.length) {
            current();
            await emit({ kind, values: packet });
          }
          value = { stream: kind, count };
        }
      } else if (operation === "indent") {
        let count = 0;
        for await (const batch of mode.scanSuggestedIndentation(data.ranges, data.tabLength, {
          ...data.options,
          signal: combined,
        })) {
          current();
          await emit(batch);
          current();
          count += batch.length;
        }
        value = { count };
      } else if (operation === "analyze") {
        if (!path.isAbsolute(data.module))
          throw new Error("Syntax analysis requires an absolute module path");
        const processor = require(data.module)[data.method];
        if (typeof processor !== "function")
          throw new Error(`Unknown syntax analysis: ${data.method}`);
        value = await waitFor(
          processor(contextFor(mode, combined, revision), data.params, {
            signal: combined,
            emit: async (packet, transfer = []) => {
              current();
              const response = await emit(serialize(packet), transfer);
              current();
              return response;
            },
          }),
          combined,
        );
      } else throw new Error(`Unknown syntax operation: ${operation}`);
      current();
      return {
        revision,
        generation,
        value: serialize(value),
        syntaxReady: syntaxReady && (operation !== "view" || !mode.publicationPending),
      };
    } finally {
      session.jobs.delete(controller);
      controller.abort(aborted("Syntax analysis finished"));
    }
  }

  async pointQueries(session, { kind, positions }, { signal, emit, current }) {
    if (
      (kind !== "scopes" && kind !== "comments") ||
      !(positions instanceof Float64Array) ||
      positions.length % 2 !== 0 ||
      positions.some(Number.isNaN) ||
      !emit
    )
      throw new TypeError("Invalid batched syntax point query");

    const { mode } = session;
    let ranges = null;
    if (!mode.hasExternalInjectionContent && positions.length <= MAX_SCOPED_POINTS * 2) {
      ranges = mode.publicationPending ? mode.pointQueryRanges(kind, positions) : [];
    }
    try {
      const settlement = ranges
        ? mode.waitForHighlightRanges(ranges, signal)
        : mode.atGrammarSettlement();
      const { parseError } = await waitFor(settlement, signal);
      const error = parseError ?? mode.lastTransactionParseError;
      if (error) throw error;
    } catch (error) {
      this.failSession(session, error);
      throw error;
    }

    const input = this.waitForInput(current, signal);
    if (input) await input;
    current();
    const exact = { allowPending: true };
    return analyzePoints(
      {
        Point,
        scopeDescriptorForBufferPosition: (point) => mode.scopeDescriptorForPosition(point, exact),
        getCommentStringsForBufferPosition: (point) => mode.commentStringsForPosition(point, exact),
      },
      { kind, positions },
      {
        signal,
        emit: async (packet, transfer) => {
          await emit(serialize(packet), transfer);
          current();
        },
      },
    );
  }

  builtin(mode, method, args) {
    args = [...args];
    if (["scopes", "syntaxScopes", "commentStringsForPosition", "token"].includes(method))
      args[0] = Point.fromObject(args[0]);
    if (method === "getRangeForSyntaxNodeContainingRange") args[0] = Range.fromObject(args[0]);
    if (method === "bufferRangeForScopeAtPosition") args[1] = Point.fromObject(args[1]);
    const allowed = new Set([
      "suggestedIndentForBufferRow",
      "suggestedIndentForBufferRows",
      "suggestedIndentForBufferRowsAtRows",
      "suggestedIndentForPastedRanges",
      "suggestedIndentForEditedBufferRow",
      "getRangeForSyntaxNodeContainingRange",
      "commentStringsForPosition",
      "isRowCommented",
      "validateGrammarQueries",
      "bufferRangeForScopeAtPosition",
    ]);
    if (method === "scopes") return mode.scopeDescriptorForPosition(args[0]).scopes;
    if (method === "syntaxScopes") return mode.syntaxTreeScopeDescriptorForPosition(args[0]).scopes;
    if (method === "token") {
      const token = mode.tokenForPosition(args[0]);
      return { value: token.value, scopes: token.scopes };
    }
    if (method === "comments")
      return new Map(
        args[0].map((row) => [row, mode.commentStringsForPosition(new Point(row, 0))]),
      );
    if (method === "syntaxSelections")
      return args[0].map((range) =>
        mode.getRangeForSyntaxNodeContainingRange(Range.fromObject(range)),
      );
    if (!allowed.has(method)) throw new Error(`Unknown syntax operation: ${method}`);
    return mode[method](...args);
  }

  async foldBuiltin(mode, method, [argument], options) {
    switch (method) {
      case "getFoldRangeForRow":
        return mode.getWorkerFoldRangeForRow(argument, options);
      case "getFoldableRanges":
        return mode.getWorkerFoldableRanges(options);
      case "getFoldableRangesAtIndentLevel":
        return mode.getWorkerFoldableRangesAtIndentLevel(argument, options);
      case "getFoldableRangeContainingPoint":
        return mode.getWorkerFoldableRangeContainingPoint(Point.fromObject(argument), options);
      case "isFoldableAtRow":
        return Boolean(await mode.getWorkerFoldRangeForRow(argument, options));
    }
  }

  metadata(session) {
    const { mode, buffer } = session;
    if (mode.publicationPending) return { syntaxReady: false };
    const count = mode.injectionsMarkerLayer.getMarkerCount();
    if (!session.metadata || session.metadataDirty || session.metadata.count !== count) {
      const grammars = new Set(),
        queries = new Set();
      for (const layer of mode.getAllLanguageLayers()) {
        if (!layer) continue;
        grammars.add(layer.grammar.scopeName);
        for (const type of Object.keys(layer.grammar.queryPaths ?? {}))
          if (type.endsWith("Query")) queries.add(type);
      }
      session.metadata = { count, grammars: [...grammars], queries: [...queries] };
      session.metadataDirty = false;
    }
    if (!session.tabStyleReady) {
      session.softTabs = undefined;
      const source = buffer.getTextSnapshot();
      for (let row = 0, end = Math.min(1000, buffer.getLastRow()); row <= end; row++) {
        const first = source.slice(source.lineStart(row), source.lineStart(row) + 1);
        if (first !== " " && first !== "\t") continue;
        try {
          if (mode.isRowCommented(row)) continue;
        } catch (error) {
          if (error.code !== "ERR_SYNTAX_QUERY_BUDGET") throw error;
          break;
        }
        session.softTabs = first === " ";
        break;
      }
      session.tabStyleReady = true;
    }
    return {
      queries: session.metadata.queries,
      grammars: session.metadata.grammars,
      softTabs: session.softTabs,
      syntaxReady: !mode.publicationPending,
      typingIndentationRules: require("./typing-indentation-rules").forMode(mode),
      typingContext: require("./syntax-typing-context").capture(mode),
      typingContextRevision: session.revision,
      usesSyntaxIndentation: require("./typing-indentation-rules").usesSyntaxIndentation(mode),
    };
  }

  async waitForViewSyntax(session, range, signal, optional = false) {
    const { mode } = session;
    try {
      const transaction = await waitFor(
        mode.waitForHighlightRange
          ? mode.waitForHighlightRange(range, signal, optional)
          : mode.atGrammarSettlement(),
        signal,
      );
      const error = transaction.parseError ?? mode.lastTransactionParseError;
      if (error) throw error;
      if (mode.publicationPending && !optional) {
        const scoped = session.scopedPaint;
        if (scoped?.revision !== session.revision || scoped?.generation !== session.generation) {
          session.scopedPaint = {
            revision: session.revision,
            generation: session.generation,
            epoch: mode.getSyntaxRequestEpoch(),
          };
        }
      }
      return transaction;
    } catch (error) {
      this.failSession(session, error);
      throw error;
    }
  }

  applyChanges(buffer, changes) {
    const source = buffer.getTextSnapshot();
    let delta = 0,
      previousEnd = -1,
      previousStart = -1;
    const independent = [];
    for (const change of changes) {
      if (!Number.isSafeInteger(change.startIndex) || !Number.isSafeInteger(change.oldEndIndex))
        break;
      const start = change.startIndex - delta,
        end = change.oldEndIndex - delta;
      if (start < previousEnd || start <= previousStart || end < start || end > source.length)
        break;
      independent.push({
        range: new Range(source.positionAt(start), source.positionAt(end)),
        text: change.text,
      });
      previousStart = start;
      previousEnd = end;
      delta += change.text.length - (end - start);
    }
    buffer.transact(() => {
      if (
        independent.length === changes.length &&
        changes.length >= 128 &&
        buffer.tryApplyIndependentEdits(independent, false, "syntax-sync")
      )
        return;
      for (const change of changes) {
        const text = buffer.getTextSnapshot();
        const start = change.startIndex ?? text.offsetAt(Point.fromObject(change.range[0]));
        const end = change.oldEndIndex ?? text.offsetAt(Point.fromObject(change.range[1]));
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end < start ||
          end > text.length
        )
          throw new RangeError("Invalid syntax edit offsets");
        const oldStart = text.positionAt(start),
          oldEnd = text.positionAt(end);
        buffer.emitWillChangeEvent();
        buffer.applyChange(
          buffer.buffer.prepareEditFromChange({
            oldStart,
            oldEnd,
            newStart: oldStart,
            oldTextSource: text.subtext(start, end),
            newText: change.text,
          }),
          { origin: "syntax-sync" },
        );
      }
    });
  }

  async preparePaintTile(session, tile, optional, current, signal) {
    const { buffer, mode } = session;
    const options = { presentation: true };
    if (mode.waitForHighlightRange) {
      await this.waitForViewSyntax(session, new Range(tile.start, tile.end), signal, optional);
      const input = this.waitForInput(current, signal);
      if (input) await input;
      options.allowPending = true;
    }
    if (tile.window) options.endPosition = tile.end;
    if (optional) options.timeBudgetMs = OPTIONAL_PAINT_BUDGET_MS;
    for (let retries = 0; ; retries++) {
      const iterator = mode.buildHighlightIterator(options);
      const scopes = runtime.run(this.contextFor(session, "paint-query"), () =>
        iterator.seek(tile.start, tile.endRow),
      );
      if (iterator.limitedReason !== "timeout" || (!optional && retries > 0))
        return { tile, iterator, scopes: [...scopes] };
      if (optional) {
        // Refine optional work on row boundaries against the same full tree.
        // Leave a stubborn range uncovered for the foreground budget.
        if (tile.window || tile.start.row === tile.endRow) return null;
        const middle = Math.floor((tile.start.row + tile.endRow) / 2);
        tile = paintTile(buffer, tile.start.row, middle);
      }
      await this.yieldForInput(current, signal);
    }
  }

  async view(
    session,
    ranges,
    emit,
    current,
    follow = false,
    presentation,
    signal,
    optional = false,
  ) {
    const { buffer, mode } = session;
    const tiles = [],
      names = new Map();
    const pending = ranges.map((range) => ({ range, origin: range, optional }));
    const deferredFolds = new Map();
    let optionalPaintPaused = false;
    while (pending.length) {
      const input = this.waitForInput(current, signal);
      if (input) await input;
      const work = pending.shift();
      const { range, origin, optional } = work;
      const isWindow = !Array.isArray(range);
      const tile = isWindow ? windowTile(buffer, range) : paintTile(buffer, ...range);
      if (!tile) continue;
      const prepared = await this.preparePaintTile(session, tile, optional, current, signal);
      current?.();
      if (!prepared) {
        optionalPaintPaused = true;
        break;
      }
      const {
        iterator,
        scopes,
        tile: { start, end, endRow },
      } = prepared;
      const first = start.row;
      const last = isWindow ? endRow : range[1];
      const events = [],
        folds = [];
      for (const id of scopes) names.set(id, mode.scopeNameForScopeId(id));
      const quality = iterator.limitedReason ? "limited" : "exact";
      const window = isWindow;
      let header = { start, end, scopes, quality, reason: iterator.limitedReason, window };
      let scanDeadline;
      let scanned = 0;
      while (iterator.getPosition().compare(end) < 0) {
        scanDeadline ??= performance.now() + PAINT_SCAN_SLICE_MS;
        const open = [...iterator.getOpenScopeIds()],
          close = [...iterator.getCloseScopeIds()];
        events.push({ position: iterator.getPosition(), open, close });
        for (const id of [...open, ...close]) names.set(id, mode.scopeNameForScopeId(id));
        iterator.moveToSuccessor();
        if (emit && events.length >= PAINT_PACKET_EVENTS) {
          await emit(serialize({ ...header, kind: "events", events, names: [...names] }));
          header = null;
          events.length = 0;
          names.clear();
          const input = this.waitForInput(current, signal);
          if (input) await input;
          current?.();
          scanDeadline = performance.now() + PAINT_SCAN_SLICE_MS;
        } else if ((++scanned & 63) === 0 && performance.now() >= scanDeadline) {
          await this.yieldForInput(current, signal);
          scanDeadline = performance.now() + PAINT_SCAN_SLICE_MS;
        }
      }
      // Publish the complete color tile before folds. Fold lookup can compile
      // a query and visit ancestors; it must not delay the text's first paint.
      // Compute it while the existing color acknowledgement is in flight, so
      // the split adds no second acknowledgement round trip.
      const acknowledgement = emit?.(
        serialize({ ...header, kind: "end", events, folds: [], names: [...names] }),
      );
      if (acknowledgement) void Promise.resolve(acknowledgement).catch(() => {});
      if (quality === "exact" && mode.publicationPending) {
        if (emit) for (let row = first; row <= endRow; row++) deferredFolds.set(row, folds);
      } else if (quality === "exact") {
        let deadline = performance.now() + 4;
        for (let row = first; row <= endRow; row++) {
          try {
            folds.push([row, mode.getFoldRangeForRow(row, 4, { localOnly: true })]);
            deferredFolds.delete(row);
          } catch (error) {
            if (error.code !== "ERR_SYNTAX_QUERY_BUDGET") throw error;
            if (FoldResolver.needsRangeCollection(error)) deferredFolds.set(row, folds);
            else break;
          }
          if (row < endRow && performance.now() >= deadline) {
            await this.yieldForInput(current, signal);
            deadline = performance.now() + 4;
          }
        }
      }
      if (emit) {
        current?.();
        this.publishPaintFolds(session, presentation, folds);
        const next = await acknowledgement;
        names.clear();
        current?.();
        if (follow) {
          if (next?.range) {
            const same = rangeKey(next.range) === rangeKey(origin);
            if (same && endRow < last)
              pending.unshift({
                ...work,
                range: [endRow + 1, last],
                optional: Boolean(next.optional),
              });
            else if (!same)
              pending.unshift({
                range: next.range,
                origin: next.range,
                optional: Boolean(next.optional),
              });
          }
        } else if (endRow < last) pending.unshift({ ...work, range: [endRow + 1, last] });
      } else {
        tiles.push({
          start,
          end,
          scopes,
          events,
          folds,
          quality,
          reason: iterator.limitedReason,
          window,
        });
        if (endRow < last) pending.unshift({ ...work, range: [endRow + 1, last] });
      }
    }
    if (deferredFolds.size) {
      current?.();
      if (emit) this.scheduleDeferredPaintFolds(session, presentation, deferredFolds);
      else await this.resolveDeferredPaintFolds(mode, deferredFolds, current, signal);
    }
    const value = emit ? this.metadata(session) : { tiles, scopes: [...names] };
    return optionalPaintPaused ? { ...value, optionalPaintPaused: true } : value;
  }

  publishPaintFolds(session, presentation, folds, deferred = false) {
    if (!folds.length) return;
    this.notify(
      serialize({
        event: "paint-folds",
        session: session.id,
        revision: session.revision,
        generation: session.generation,
        presentation,
        folds,
        deferred,
      }),
    );
  }

  scheduleDeferredPaintFolds(session, presentation, rows) {
    const { mode, generation, revision } = session;
    const epoch = mode.getSyntaxRequestEpoch?.();
    const previous = session.deferredPaintFolds;
    if (
      previous &&
      previous.presentation === presentation &&
      previous.epoch === epoch &&
      !previous.controller.signal.aborted
    ) {
      for (const [row, folds] of rows) previous.rows.set(row, folds);
      return;
    }
    previous?.controller.abort(aborted());
    const controller = new AbortController();
    const { signal } = controller;
    const job = { presentation, epoch, controller, rows };
    session.deferredPaintFolds = job;
    session.jobs.add(controller);
    const current = () => {
      signal.throwIfAborted();
      if (
        session.generation !== generation ||
        session.revision !== revision ||
        session.mode !== mode ||
        mode.getSyntaxRequestEpoch?.() !== epoch
      )
        throw aborted();
    };
    const publish = (folds) => {
      current();
      this.publishPaintFolds(session, presentation, folds, true);
    };
    // The paint RPC can return before this lookup finishes, so a new viewport
    // can paint immediately. Edits cancel this work with the other session jobs.
    void runtime
      .run(this.contextFor(session, "paint-folds"), () =>
        this.resolveDeferredPaintFolds(mode, rows, current, signal, publish),
      )
      .catch((error) => this.failSession(session, error))
      .finally(() => {
        session.jobs.delete(controller);
        if (session.deferredPaintFolds === job) session.deferredPaintFolds = null;
      });
  }

  async resolveDeferredPaintFolds(mode, rows, current, signal, publish) {
    const options = { signal, yieldTurn: () => this.yieldForInput(current, signal) };
    if (mode.publicationPending) {
      const { parseError } = await waitFor(mode.atGrammarSettlement(), signal);
      if (parseError) throw parseError;
    }
    await options.yieldTurn();
    const results = [];
    for (const [row, folds] of rows) {
      try {
        const fold = await mode.getWorkerFoldRangeForRow(row, options);
        const target = publish ? results : folds;
        target.push([row, fold]);
      } catch (error) {
        if (error.code !== "ERR_SYNTAX_QUERY_BUDGET") throw error;
        // An exact fold that still exceeds a budget stays unavailable. The
        // local folds and text tiles have already been published.
        break;
      }
      if (publish && results.length === 256) {
        publish(results);
        results.length = 0;
        await options.yieldTurn();
      }
    }
    publish?.(results);
  }

  async previewView(session, range, emit, current, signal) {
    if (!emit) return null;
    const pendingInput = this.waitForInput(current, signal);
    if (pendingInput) await pendingInput;
    const [startRow, endRow] = range;
    const preview = await this.previews.get(
      session,
      { startRow, endRow },
      {
        signal,
        context: () => this.contextFor(session, "preview"),
      },
    );
    const input = this.waitForInput(current, signal);
    if (input) await input;
    current();
    if (!preview || !session.mode.publicationPending) return null;
    try {
      const localStart = new Point(startRow - preview.startRow, 0);
      const localEndRow = Math.min(endRow - preview.startRow, preview.buffer.getLastRow());
      const iterator = preview.mode.buildHighlightIterator({ presentation: true });
      const scopes = [
        ...runtime.run(this.contextFor(session, "preview-paint"), () =>
          iterator.seek(localStart, localEndRow),
        ),
      ];
      // A bounded query can stop inside the preview's source window. Its
      // missing captures are unknown, not evidence that the suffix is plain
      // text. Wait for the real document instead of caching that false paint.
      if (iterator.limitedReason) return null;
      const names = new Map(scopes.map((id) => [id, preview.mode.scopeNameForScopeId(id)]));
      const end = Point.fromObject(preview.requestedEnd);
      let header = {
        start: Point.fromObject(preview.requestedStart),
        end,
        scopes,
        quality: "provisional",
        reason: iterator.limitedReason ?? (preview.limited ? "source-window" : null),
      };
      const events = [];
      while (iterator.getPosition().row <= localEndRow) {
        const position = iterator.getPosition().translate([preview.startRow, 0]);
        if (position.compare(end) > 0) break;
        const open = [...iterator.getOpenScopeIds()],
          close = [...iterator.getCloseScopeIds()];
        events.push({ position, open, close });
        for (const id of [...open, ...close]) names.set(id, preview.mode.scopeNameForScopeId(id));
        iterator.moveToSuccessor();
        if (events.length >= PAINT_PACKET_EVENTS) {
          await emit(serialize({ ...header, kind: "events", events, names: [...names] }));
          header = null;
          events.length = 0;
          names.clear();
          const input = this.waitForInput(current, signal);
          if (input) await input;
          current();
          if (!session.mode.publicationPending)
            throw aborted("Exact syntax superseded the preview");
        }
      }
      current();
      if (!session.mode.publicationPending) return null;
      await emit(serialize({ ...header, kind: "end", events, folds: [], names: [...names] }));
      current();
      if (!session.mode.publicationPending) return null;
      return { queries: [], grammars: [session.scopeName], syntaxReady: false };
    } catch (error) {
      if (
        runtime.failure ||
        error instanceof WebAssembly.RuntimeError ||
        error.name === "AbortError"
      )
        throw error;
      // Provisional presentation is optional. Its failure cannot disable the
      // real document or replace a valid grammar/query with a fallback.
      this.previews.release(session);
      return null;
    }
  }

  close() {
    this.closed = true;
    if (this.inputBarrier) {
      clearImmediate(this.inputBarrier.wake);
      this.inputBarrier.resolve();
      this.inputBarrier = null;
    }
    this.runtimeSubscription.dispose();
    this.previews.dispose();
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    for (const module of this.modules.splice(0)) module.dispose?.();
    for (const grammar of this.grammars.getGrammars()) grammar.destroy?.();
  }
}

module.exports = SyntaxWorkerHost;
