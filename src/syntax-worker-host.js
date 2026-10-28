const path = require("node:path");
const fs = require("node:fs");
const Config = require("./config");
const SelectorStore = require("@lumine-code/selector-store");
const GrammarRegistry = require("./grammar-registry");
const TreeSitterGrammar = require("./tree-sitter-grammar");
const TreeSitterLanguageMode = require("./tree-sitter-language-mode");
const TextBuffer = require("./text-buffer");
const runtime = require("./tree-sitter-runtime");
const { paintTile } = require("./syntax-paint-policy");
const SyntaxPreview = require("./syntax-preview");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const { contextFor, serialize } = require("./syntax-analysis-context");
const { PAINT_PACKET_EVENTS } = require("./syntax-worker-protocol");
const { Point, Range } = TextBuffer;

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
      initialSyntaxTree: session.initialSyntaxTree,
      initialSyntaxChanges: session.initialSyntaxChanges,
      indentationOnly: Boolean(session.parent),
    });
    session.initialSyntaxTree = null;
    session.initialSyntaxChanges = null;
    session.captureInitialChanges?.dispose();
    // The renderer owns presentation windows. Semantic work must not also
    // prepare an unused default viewport at the beginning of every document.
    mode.requestHighlighting(this, []);
    session.mode = mode;
    session.metadata = null;
    session.tabStyleReady = false;
    session.buffer.setLanguageMode(mode);
    session.subscriptions = new CompositeDisposable(
      mode.onDidChangeHighlighting((range) => {
        if (!mode.publicationPending) this.previews.release(session);
        if (range.start.row <= 1000) session.tabStyleReady = false;
        this.notify({
          event: "highlight",
          session: session.id,
          revision: session.revision,
          generation: session.generation,
          range: range.serialize(),
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
    this.sessions.get(session.parent)?.forks?.delete(id);
    session.captureInitialChanges?.dispose();
    session.rootRanges?.dispose();
    session.pendingEdit?.reject(aborted("Syntax document was closed"));
    this.previews.release(session);
    this.invalidate(session);
    session.buffer.destroy();
    if (runtime.releaseSession(id)) this.notify({ event: "recycle-requested" });
  }

  async dispatch(operation, data, { signal, emit } = {}) {
    try {
      return await runtime.run(this.contextFor(this.sessions.get(data.session), operation), () =>
        this.dispatchOperation(operation, data, { signal, emit }),
      );
    } catch (error) {
      if (error.code === "ERR_SYNTAX_QUERY_BUDGET") {
        const unavailable = aborted("Syntax query exceeded its resource budget");
        unavailable.code = error.code;
        unavailable.reason = error.reason;
        throw unavailable;
      }
      throw error;
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
    if (operation === "prepared-indent" && data.target != null) {
      const target = data.target;
      if (!Number.isSafeInteger(target) || this.sessions.has(target))
        throw new Error("Invalid speculative syntax session");
      try {
        await this.dispatch(
          "fork",
          { session: session.id, revision: data.revision, target },
          { signal },
        );
        await this.dispatch(
          "edit",
          { session: target, beforeRevision: 0, revision: 1, changes: data.changes },
          { signal },
        );
        await this.dispatch("initialize", { session: target }, { signal });
        const result = await this.dispatch(
          "prepared-indent",
          {
            session: target,
            revision: 1,
            ranges: data.ranges,
            tabLength: data.tabLength,
            options: data.options,
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
    if (data.revision !== undefined && data.revision !== revision) throw aborted();
    session.jobs.add(controller);
    const current = () => {
      combined.throwIfAborted();
      if (
        this.sessions.get(session.id) !== session ||
        session.revision !== revision ||
        session.generation !== generation ||
        session.mode !== mode
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
      let transaction;
      try {
        const settlement = mode.atGrammarSettlement();
        if (
          operation === "view" &&
          data.allowPreview &&
          mode.publicationPending &&
          data.ranges?.length
        ) {
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
        transaction ??= await waitFor(settlement, combined);
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
      if (operation === "fork") {
        if (!Number.isSafeInteger(data.target) || this.sessions.has(data.target))
          throw new Error("Invalid speculative syntax session");
        const copy = new TextBuffer({ text: buffer.getTextSnapshot() });
        copy.getPath = () => buffer.getPath();
        const fork = {
          id: data.target,
          parent: session.id,
          buffer: copy,
          scopeName: session.scopeName,
          revision: 0,
          generation: 0,
          initialized: false,
          jobs: new Set(),
          initialSyntaxChanges: [],
        };
        this.sessions.set(fork.id, fork);
        (session.forks ??= new Set()).add(fork.id);
        try {
          runtime.registerBuffer(copy, () => this.contextFor(fork));
          const policy = this.grammars.rootLanguageRangesByBuffer.get(buffer)?.descriptor;
          if (policy) fork.rootRanges = this.grammars.setRootLanguageRanges(copy, policy);
          const tree = mode.rootLanguageLayer?.backgroundTree;
          if (tree?.revision === buffer.getTextRevision())
            fork.initialSyntaxTree = require("./tree-sitter-parser").copySnapshot(
              tree,
              copy.getTextRevision(),
            );
          fork.captureInitialChanges = copy.onDidApplyChanges((batch) =>
            fork.initialSyntaxChanges.push(batch),
          );
          value = { id: fork.id };
        } catch (error) {
          this.closeSession(fork.id);
          throw error;
        }
      } else if (operation === "prepared-indent") {
        const { IndentationLevels } = require("./tree-sitter-indentation-stream");
        const history = new IndentationLevels();
        let previousEnd = -1,
          count = 0;
        for (const [start, end] of data.ranges) {
          if (start <= previousEnd) throw new RangeError("Overlapping paste indentation ranges");
          previousEnd = end;
          for await (const batch of mode.scanSuggestedIndentation([[start, end]], data.tabLength, {
            ...data.options,
            isPastedText: data.options?.isPastedText !== false,
            indentationLevels: history,
            signal: combined,
          })) {
            current();
            for (const [row, level] of batch) {
              const rowOptions = data.options?.rowOptions?.get(row) ?? data.options;
              if (level !== null)
                history.set(
                  row,
                  rowOptions?.preserveLeadingWhitespace
                    ? mode.indentResolver.indentLevelForBufferRow(
                        row,
                        data.tabLength,
                        rowOptions.insertedIndentLengths?.get(row) ?? 0,
                        Math.floor(level * data.tabLength),
                      )
                    : level,
                );
              count++;
            }
            await emit(batch);
          }
        }
        value = { count };
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
        );
      else if (operation === "builtin") {
        value = await this.builtin(mode, data.method, data.args);
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
      return { revision, generation, value: serialize(value), syntaxReady };
    } finally {
      session.jobs.delete(controller);
      controller.abort(aborted("Syntax analysis finished"));
    }
  }

  builtin(mode, method, args) {
    args = [...args];
    if (
      [
        "scopes",
        "syntaxScopes",
        "commentStringsForPosition",
        "getFoldableRangeContainingPoint",
        "token",
      ].includes(method)
    )
      args[0] = Point.fromObject(args[0]);
    if (method === "getRangeForSyntaxNodeContainingRange") args[0] = Range.fromObject(args[0]);
    if (method === "bufferRangeForScopeAtPosition") args[1] = Point.fromObject(args[1]);
    const allowed = new Set([
      "suggestedIndentForBufferRow",
      "suggestedIndentForBufferRows",
      "suggestedIndentForBufferRowsAtRows",
      "suggestedIndentForPastedRanges",
      "suggestedIndentForEditedBufferRow",
      "getFoldRangeForRow",
      "getFoldableRanges",
      "getFoldableRangesAtIndentLevel",
      "getFoldableRangeContainingPoint",
      "getRangeForSyntaxNodeContainingRange",
      "commentStringsForPosition",
      "isRowCommented",
      "validateGrammarQueries",
      "isFoldableAtRow",
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

  metadata(session) {
    const { mode, buffer } = session;
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
    };
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

  async view(session, ranges, emit, current, follow = false) {
    const { buffer, mode } = session;
    const tiles = [],
      names = new Map();
    const pending = ranges.map((range) => ({ range, origin: range }));
    while (pending.length) {
      current?.();
      const { range, origin } = pending.shift();
      const [first, last] = range;
      const tile = paintTile(buffer, first, last);
      if (!tile) continue;
      const { start, end, endRow } = tile;
      let iterator = mode.buildHighlightIterator({ presentation: true });
      let scopes = [
        ...runtime.run(this.contextFor(session, "paint-query"), () => iterator.seek(start, endRow)),
      ];
      if (iterator.limitedReason === "timeout") {
        // Cold queries or transient contention must not strand ordinary paint
        // in a cached fallback. Retry once after yielding, with a new iterator's
        // unchanged deadline. Structural/result limits are deliberately stable.
        await new Promise(setImmediate);
        current?.();
        iterator = mode.buildHighlightIterator({ presentation: true });
        scopes = [
          ...runtime.run(this.contextFor(session, "paint-query"), () =>
            iterator.seek(start, endRow),
          ),
        ];
      }
      const events = [],
        folds = [];
      for (const id of scopes) names.set(id, mode.scopeNameForScopeId(id));
      const quality = iterator.limitedReason ? "limited" : "exact";
      let header = { start, end, scopes, quality, reason: iterator.limitedReason };
      current?.();
      while (iterator.getPosition().row <= endRow) {
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
          current?.();
        }
      }
      if (quality === "exact") {
        for (let row = first; row <= endRow; row++) {
          try {
            folds.push([row, mode.getFoldRangeForRow(row, 4)]);
          } catch (error) {
            if (error.code !== "ERR_SYNTAX_QUERY_BUDGET") throw error;
            break;
          }
        }
      }
      if (emit) {
        const next = await emit(
          serialize({ ...header, kind: "end", events, folds, names: [...names] }),
        );
        names.clear();
        current?.();
        if (follow) {
          if (next?.range) {
            const same = next.range[0] === origin[0] && next.range[1] === origin[1];
            if (same && endRow < last) pending.unshift({ range: [endRow + 1, last], origin });
            else if (!same) pending.unshift({ range: next.range, origin: next.range });
          }
        } else if (endRow < last) pending.unshift({ range: [endRow + 1, last], origin });
      } else {
        tiles.push({ start, end, scopes, events, folds, quality, reason: iterator.limitedReason });
        if (endRow < last) pending.unshift({ range: [endRow + 1, last], origin });
      }
    }
    return emit ? this.metadata(session) : { tiles, scopes: [...names] };
  }

  async previewView(session, range, emit, current, signal) {
    if (!emit) return null;
    const [startRow, endRow] = range;
    const preview = await this.previews.get(
      session,
      { startRow, endRow },
      {
        signal,
        context: () => this.contextFor(session, "preview"),
      },
    );
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
    this.runtimeSubscription.dispose();
    this.previews.dispose();
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    for (const module of this.modules.splice(0)) module.dispose?.();
    for (const grammar of this.grammars.getGrammars()) grammar.destroy?.();
  }
}

module.exports = SyntaxWorkerHost;
