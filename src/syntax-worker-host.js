const path = require("node:path");
const fs = require("node:fs");
const Config = require("./config");
const SelectorStore = require("@lumine-code/selector-store");
const GrammarRegistry = require("./grammar-registry");
const TreeSitterGrammar = require("./tree-sitter-grammar");
const TreeSitterLanguageMode = require("./tree-sitter-language-mode");
const TextBuffer = require("./text-buffer");
const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const { contextFor, serialize } = require("./syntax-analysis-context");
const { PAINT_TILE_ROWS, PAINT_PACKET_EVENTS } = require("./syntax-worker-protocol");
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
    session.generation++;
    session.metadataDirty = true;
    session.tabStyleReady = false;
    for (const controller of session.jobs) controller.abort(aborted());
    this.notify({ event: "invalidate", session: session.id, generation: session.generation });
  }

  installMode(session) {
    const grammar = this.grammars.grammarForScopeName(session.scopeName);
    if (!grammar || grammar.type !== "tree-sitter")
      throw new Error(`Unavailable grammar: ${session.scopeName}`);
    const mode = new TreeSitterLanguageMode({
      buffer: session.buffer,
      grammar,
      config: this.config,
      grammars: this.grammars,
    });
    // The renderer owns presentation windows. Semantic work must not also
    // prepare an unused default viewport at the beginning of every document.
    mode.requestHighlighting(this, []);
    session.mode = mode;
    session.metadata = null;
    session.tabStyleReady = false;
    session.buffer.setLanguageMode(mode);
    session.subscriptions = new CompositeDisposable(
      mode.onDidChangeHighlighting((range) => {
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
        this.notify({ event: "failure", session: session.id, message: error.message });
    });
  }

  closeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.pendingEdit?.reject(aborted("Syntax document was closed"));
    this.invalidate(session);
    session.buffer.destroy();
  }

  async dispatch(operation, data, { signal, emit } = {}) {
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
      if (data.rootRanges)
        session.rootRanges = this.grammars.setRootLanguageRanges(buffer, data.rootRanges);
      return { revision: session.revision, generation: session.generation };
    }
    const session = this.sessions.get(data.session);
    if (!session) throw aborted("Syntax document was closed");
    const { buffer } = session;
    if (operation === "edit-begin") {
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
          chunks: [],
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
        edit.text.chunks.push(data.text);
        edit.text.units += data.text.length;
        return;
      }
      if (operation === "edit-text-end") {
        if (!edit.text || edit.text.units !== edit.text.length)
          throw new Error("Incomplete syntax text transfer");
        edit.changes.push({
          startIndex: edit.text.startIndex,
          oldEndIndex: edit.text.oldEndIndex,
          text: edit.text.chunks.join(""),
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
    try {
      if (!session.initialized) throw new Error("Syntax document is not initialized");
      const transaction = await waitFor(mode.atGrammarSettlement(), combined);
      current();
      const syntaxReady = !(transaction.parseError || mode.lastTransactionParseError);
      if (operation !== "settle" && !syntaxReady) {
        if (operation === "analyze") return { revision, generation, value: null, syntaxReady };
        throw Object.assign(new Error("Syntax is unavailable after a parser failure"), {
          name: "SyntaxUnavailableError",
        });
      }
      let value;
      if (operation === "settle") {
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
      const lineForRow = buffer.getTextSnapshot().lineReader();
      for (let row = 0, end = Math.min(1000, buffer.getLastRow()); row <= end; row++) {
        const first = lineForRow(row)[0];
        if (first !== " " && first !== "\t") continue;
        if (mode.isRowCommented(row)) continue;
        session.softTabs = first === " ";
        break;
      }
      session.tabStyleReady = true;
    }
    return {
      queries: session.metadata.queries,
      grammars: session.metadata.grammars,
      softTabs: session.softTabs,
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
    const pending = [...ranges];
    while (pending.length) {
      const [first, last] = pending.shift();
      for (let firstRow = first; firstRow <= last; firstRow += PAINT_TILE_ROWS) {
        current?.();
        const start = buffer.clipPosition([firstRow, 0]);
        const endRow = Math.min(firstRow + PAINT_TILE_ROWS - 1, last, buffer.getLastRow());
        const end = buffer.clipPosition([endRow + 1, 0]);
        const iterator = mode.buildHighlightIterator();
        const scopes = [...iterator.seek(start, endRow)];
        const events = [],
          folds = [];
        for (const id of scopes) names.set(id, mode.scopeNameForScopeId(id));
        let header = { start, end, scopes };
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
        for (let row = firstRow; row <= endRow; row++)
          folds.push([row, mode.getFoldRangeForRow(row, 4)]);
        if (emit) {
          const next = await emit(
            serialize({ ...header, kind: "end", events, folds, names: [...names] }),
          );
          names.clear();
          current?.();
          // The renderer selects the next missing tile after publishing this
          // one. A moving viewport never queues behind an obsolete window.
          if (follow && next?.range) pending.push(next.range);
        } else tiles.push({ start, end, scopes, events, folds });
      }
    }
    return emit ? this.metadata(session) : { tiles, scopes: [...names] };
  }

  close() {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    for (const module of this.modules.splice(0)) module.dispose?.();
    for (const grammar of this.grammars.getGrammars()) grammar.destroy?.();
  }
}

module.exports = SyntaxWorkerHost;
