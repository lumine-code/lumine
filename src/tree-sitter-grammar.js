const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const NativeTreeSitter = require("tree-sitter");
const { Language: WebLanguage, Parser: WebParser, Query: WebQuery } = require("web-tree-sitter");
const { CompositeDisposable, Disposable, Emitter } = require("@lumine-code/event-kit");
const { watchPath } = require("./path-watcher");
const { normalizeDelimiters } = require("./comment-utils.js");

// Load the runtime Wasm through Node's `fs` rather than letting the emscripten
// module `fetch` it. In Electron's renderer, `web-tree-sitter` takes its
// browser code path (process.type === "renderer"), and `fetch` of a `file://`
// URL is blocked on macOS and Linux, so the parser would never initialize.
const webTreeSitterWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
let parserInitPromise = null;

function initializeWebParser() {
  if (!parserInitPromise) {
    const pendingInitialization = fs.promises
      .readFile(webTreeSitterWasmPath)
      .then((wasmBinary) => WebParser.init({ wasmBinary }));
    const guardedInitialization = pendingInitialization.catch((error) => {
      if (parserInitPromise === guardedInitialization) {
        parserInitPromise = null;
      }
      throw error;
    });
    parserInitPromise = guardedInitialization;
  }
  return parserInitPromise;
}

// `QueryError.kind` values from `web-tree-sitter`. (The `QueryError` class
// itself is not exported, so we duck-type it and translate its `kind` here.)
const QUERY_ERROR_KIND_LABELS = {
  1: "syntax error",
  2: "unknown node type",
  3: "unknown field name",
  4: "bad capture name",
  5: "pattern structure error",
};

/**
 * @public
 * @status extended
 *
 * This class holds an instance of a Tree-sitter grammar.
 */
module.exports = class TreeSitterGrammar {
  // Cache each loaded language — or its in-flight load — at the WASM or native module path.
  static LANGUAGE_CACHE = new Map();

  static async loadLanguage(grammarPath) {
    // We should load each language a maximum of once.
    //
    // This cache makes certain trade-offs. Without it, two different grammars
    // within the same package can point to the same WASM file and each have
    // its own distinct “copy” of the language. Using the cache avoids this
    // waste, but makes it unsafe for us to assume we can delete a language
    // from this cache if its grammar is deactivated.
    //
    // So that's the main downside: out of an abundance of caution, we don't
    // ever prune this cache, even if the grammar that originally loaded a
    // language is deactivated. But deactivation of a grammar after
    // instantiation is an uncommon occurrence outside of the test suite, so we
    // can live with this for now.
    if (this.LANGUAGE_CACHE.has(grammarPath)) {
      return this.LANGUAGE_CACHE.get(grammarPath);
    }
    // Read the grammar Wasm ourselves and hand `Language.load` the bytes; a bare
    // path would make it `fetch` a `file://` URL, which fails in Electron's
    // renderer on macOS and Linux. Include the read in the shared promise so
    // simultaneous consumers neither block the renderer nor duplicate I/O.
    let loadPromise = Promise.resolve()
      .then(() =>
        typeof grammarPath === "string" ? fs.promises.readFile(grammarPath) : grammarPath,
      )
      .then((input) => WebLanguage.load(input))
      .then(
        (language) => {
          this.LANGUAGE_CACHE.set(grammarPath, language);
          return language;
        },
        (error) => {
          // A transient load failure must not poison every later attempt.
          if (this.LANGUAGE_CACHE.get(grammarPath) === loadPromise) {
            this.LANGUAGE_CACHE.delete(grammarPath);
          }
          throw error;
        },
      );
    // Cache before awaiting so constructors created in the same turn share the
    // in-flight WebAssembly compilation rather than racing duplicate loads.
    this.LANGUAGE_CACHE.set(grammarPath, loadPromise);
    return loadPromise;
  }

  constructor(registry, grammarPath, params) {
    this.registry = registry;
    this.name = params.name;
    this.type = "tree-sitter";
    this.scopeName = params.scopeName;

    this.contentRegex = buildRegex(params.contentRegex);
    this.firstLineRegex = buildRegex(params.firstLineRegex);
    this.injectionNames = normalizeInjectionNames(params.injectionNames, grammarPath);
    this.injectionPointsByType = {};

    if (!params.treeSitter || typeof params.treeSitter !== "object") {
      throw new Error(`Tree-sitter grammar ${grammarPath} is missing its treeSitter configuration`);
    }

    this.grammarFilePath = grammarPath;
    this.queryPaths = params.treeSitter;
    this.languageSegment = params.treeSitter.languageSegment ?? null;
    this.treeSitterRuntime = params.treeSitter.runtime ?? "wasm";
    const dirName = path.dirname(grammarPath);

    if (this.treeSitterRuntime === "node") {
      if (typeof params.treeSitter.languageModule !== "string") {
        throw new Error(
          `Node Tree-sitter grammar ${grammarPath} must specify treeSitter.languageModule`,
        );
      }
      this.Parser = NativeTreeSitter;
      this.Query = NativeTreeSitter.Query;
      this.languageModule = params.treeSitter.languageModule;
      this.requireFromGrammar = createRequire(grammarPath);
      this.languageModulePath = this.requireFromGrammar.resolve(this.languageModule);
      this.treeSitterGrammarPath = null;
    } else if (this.treeSitterRuntime === "wasm") {
      if (typeof params.treeSitter.grammar !== "string") {
        throw new Error(`WASM Tree-sitter grammar ${grammarPath} must specify treeSitter.grammar`);
      }
      this.Parser = WebParser;
      this.Query = WebQuery;
      this.treeSitterGrammarPath = path.join(dirName, params.treeSitter.grammar);
    } else {
      throw new Error(
        `Unsupported Tree-sitter runtime '${this.treeSitterRuntime}' in ${grammarPath}`,
      );
    }

    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();

    this.queryCache = new Map();
    this.internalQueryCache = new Map();
    this.querySourceMaps = new Map();
    this.promisesForQueryFiles = new Map();
    this.promisesForQueries = new Map();
    this.reportedQueryErrors = new Set();

    this.fileTypes = params.fileTypes || [];

    this.nextScopeId = 256 + 1;
    this.classNamesById = new Map();
    this.scopeNamesById = new Map();
    this.idsByScope = Object.create(null);

    this.commentStrings = {
      commentStartString: params.comments && params.comments.start,
      commentEndString: params.comments && params.comments.end,
    };

    this.commentMetadata = params.comments;

    this.shouldObserveQueryFiles = lumine.window.isDevMode() && !lumine.window.isSpecMode();
    for (const injectionPoint of params.injectionPoints ?? []) {
      this.addInjectionPoint(injectionPoint);
    }
  }

  // Though _text is unused here, some packages (eg semanticolor) use it to
  // customize scopes on the fly.
  idForScope(scopeName, _text) {
    if (!scopeName) {
      return undefined;
    }
    let id = this.idsByScope[scopeName];
    if (!id) {
      id = this.nextScopeId += 2;
      const className = scopeName
        .split(".")
        .map((s) => `syntax--${s}`)
        .join(" ");
      this.idsByScope[scopeName] = id;
      this.classNamesById.set(id, className);
      this.scopeNamesById.set(id, scopeName);
    }
    return id;
  }

  /**
   * @public
   * @status extended
   *
   * Retrieve all known comment delimiters for this grammar.
   *
   * Some grammars may have different delimiters for different parts of a file
   * (such as JSX within JavaScript). In these cases, you might want to call
   * {@link TextEditor#getCommentDelimitersForBufferPosition} with a `{Point}` in the
   * buffer.
   *
   *
   * * `line`: If present, a `String` representing a line comment delimiter.
   *   (If `undefined`, there is no known line comment delimiter for the given
   *   buffer position.)
   * * `block`: If present, a two-item `Array` containing `Strings`
   *   representing the starting and ending block comment delimiters. (If
   *   `undefined`, there are no known block comment delimiters for the given
   *   buffer position.)
   *
   * @returns {Object} with the following properties:
   */
  getCommentDelimiters() {
    // Prefer the config system. It's a better place for this data to live.
    let commentDelimiters = lumine.config.get("editor.commentDelimiters", {
      scope: [this.scopeName],
    });
    if (commentDelimiters) return commentDelimiters;

    // Failing that, try to extract useful information from this metadata.
    if (this.commentMetadata) {
      return normalizeDelimiters(this.commentMetadata);
    }

    // If even that doesn't exist, we can fall back onto the older config
    // settings.
    let start = lumine.config.get("editor.commentStart", { scope: [this.scopeName] });
    let end = lumine.config.get("editor.commentEnd", { scope: [this.scopeName] });

    return normalizeDelimiters({ start, end });
  }

  classNameForScopeId(id) {
    return this.classNamesById.get(id);
  }

  scopeNameForScopeId(id) {
    return this.scopeNamesById.get(id);
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the Tree-sitter `Language` instance associated with
   * this grammar _if_ it has already been loaded.
   *
   * Language instances cannot be retrieved synchronously, so this will return
   * `undefined` if the instance has not yet been loaded. In that case, going
   * async will be unavoidable, and you’ll need to call {@link #getLanguage}.
   */
  getLanguageSync() {
    return this._language;
  }

  loadNativeLanguage() {
    let cacheKey = `node:${this.languageModulePath}`;
    if (TreeSitterGrammar.LANGUAGE_CACHE.has(cacheKey)) {
      return TreeSitterGrammar.LANGUAGE_CACHE.get(cacheKey);
    }

    let languageModule = this.requireFromGrammar(this.languageModulePath);
    if (languageModule?.default?.language && !languageModule.language) {
      languageModule = languageModule.default;
    }
    if (!languageModule?.language) {
      throw new Error(
        `Node Tree-sitter module '${this.languageModule}' does not export a language handle`,
      );
    }

    // node-tree-sitter uses `nodeTypeInfo`, when present, to synthesize a
    // JavaScript subclass per node type with `new Function`. The renderer's
    // CSP deliberately forbids dynamic code generation, and the editor only
    // relies on the shared SyntaxNode API, so expose just the native handle.
    let language = { language: languageModule.language };
    TreeSitterGrammar.LANGUAGE_CACHE.set(cacheKey, language);
    return language;
  }

  createParser(language = this._language) {
    let parser = new this.Parser();
    parser.setLanguage(language);
    return parser;
  }

  _createQuery(language, queryContents) {
    return new this.Query(language, queryContents);
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the Tree-sitter language instance associated with this
   * grammar.
   *
   * @returns {Promise} that will resolve with a Tree-sitter `Language` instance. Once it resolves, the grammar is ready to perform parsing and to execute query captures.
   */
  async getLanguage() {
    if (this.treeSitterRuntime === "wasm") {
      await initializeWebParser();
    }
    if (!this._language) {
      try {
        this._language =
          this.treeSitterRuntime === "node"
            ? this.loadNativeLanguage()
            : await TreeSitterGrammar.loadLanguage(this.treeSitterGrammarPath);
      } catch (err) {
        console.error(`Error loading grammar for ${this.scopeName}; original error follows`);
        console.error(err);
        throw err;
      }
    }

    if (!this._queryFilesLoaded) {
      await this.loadQueryFiles(this.grammarFilePath, this.queryPaths);
    }
    return this._language;
  }

  async loadQueryFiles(grammarPath, queryPaths) {
    if (this._loadQueryFilesPromise) {
      return this._loadQueryFilesPromise;
    }

    let promises = [];
    let dirName = path.dirname(grammarPath);

    for (let [key, name] of Object.entries(queryPaths)) {
      if (!key.endsWith("Query")) {
        continue;
      }

      // Every `fooQuery` path can contain either a single file name or an
      // array of file names. If the latter, each is concatenated together in
      // order.
      let paths = Array.isArray(name) ? name : [name];
      let filePaths = paths.map((p) => path.join(dirName, p));

      promises.push(this.loadQueryFile(filePaths, key));

      if (this.shouldObserveQueryFiles && !this._queryFilesLoaded) {
        this.observeQueryFile(filePaths, key);
      }
    }

    const loadPromise = Promise.all(promises).then(() => {
      this._queryFilesLoaded = true;
      this.emitter.emit("did-load-query-files", this);
    });
    this._loadQueryFilesPromise = loadPromise;

    try {
      return await loadPromise;
    } finally {
      if (this._loadQueryFilesPromise === loadPromise) {
        this._loadQueryFilesPromise = null;
      }
    }
  }

  loadQueryFile(paths, queryType) {
    let key = `${paths.join(",")}/${queryType}`;

    let existingPromise = this.promisesForQueryFiles.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    let readFilePromises = paths.map((path) => {
      return fs.promises.readFile(path, "utf-8").then((contents) => {
        return { contents, path };
      });
    });

    let promise = Promise.all(readFilePromises)
      .then((allResults) => {
        let output = "";
        let sourceMap = [];
        for (let result of allResults) {
          let { contents, path } = result;
          if (contents === "") {
            // An empty file should still count as “present” when assessing whether
            // a grammar has a particular query. So we'll set the contents to a
            // comment instead.
            contents = "; (empty)";
          }
          if (contents.includes("._LANG_")) {
            // The `_LANG_` token indicates places where the last segment of a
            // scope name will vary based on which grammar includes it. It
            // assumes that the grammar author will define a segment (like
            // `ts.tsx`) under the `treeSitter.languageSegment` setting in the
            // grammar file.
            if (this.languageSegment) {
              contents = contents.replace(/\._LANG_/g, `.${this.languageSegment}`);
            } else {
              console.warn(
                `Warning: query file at ${path} includes _LANG_ tokens, but grammar does not specify a "treeSitter.languageSegment" setting.`,
              );
            }
          }
          // Remember which span of the concatenated source came from which
          // file so that query compilation errors — whose offsets refer to the
          // concatenated string — can be traced back to a file and line.
          let start = output.length + 1;
          output += `\n${contents}`;
          sourceMap.push({ filePath: path, start, end: output.length });
        }
        this.querySourceMaps.set(queryType, sourceMap);
        if (this[queryType] !== output) {
          this[queryType] = output;
          this.queryCache.delete(queryType);
          // The source changed, so any previously reported errors for this
          // query type are stale; allow them to be reported afresh.
          for (let reportedKey of this.reportedQueryErrors) {
            if (reportedKey.startsWith(`${queryType}:`)) {
              this.reportedQueryErrors.delete(reportedKey);
            }
          }
        }
      })
      .finally(() => {
        this.promisesForQueryFiles.delete(key);
      });

    this.promisesForQueryFiles.set(key, promise);
    return promise;
  }

  getQuerySync(queryType) {
    let language = this.getLanguageSync();
    if (!language) {
      return null;
    }
    let query = this.queryCache.get(queryType);
    if (!query) {
      try {
        query = this._createQuery(language, this[queryType]);
      } catch (error) {
        error.queryDescriptor ??= this.describeQueryError(error, queryType);
        throw error;
      }
      this.queryCache.set(queryType, query);
    }
    return query;
  }

  // Describes a query compilation error in terms useful to a grammar author.
  //
  // The source handed to the Tree-sitter `Query` constructor is a
  // concatenation of one or more `.scm` files (after `._LANG_` substitution),
  // so the raw character offset carried by a `QueryError` doesn't identify a
  // file or line on its own. This maps it back through the source map recorded
  // at load time.
  //
  // Returns an `Object` with `scopeName`, `queryType`, and `message`
  // properties, plus — when the error is a Tree-sitter `QueryError` —
  // `filePath`, `line` (1-based, within that file), `lineText`, `kindLabel`,
  // and `word` (the unknown node type, field name, or capture name, if any).
  // Column information is deliberately omitted: `._LANG_` substitution shifts
  // columns, so only line numbers are reliable.
  describeQueryError(error, queryType) {
    let descriptor = {
      scopeName: this.scopeName,
      queryType,
      message: error.message,
      filePath: null,
      line: null,
      lineText: null,
      word: null,
      kindLabel: null,
      candidateFiles: null,
    };
    // The mapping is best-effort; a failure here must never mask the original
    // compilation error.
    try {
      let source = this[queryType];
      let sourceMap = this.querySourceMaps.get(queryType);
      // `web-tree-sitter` does not export its `QueryError` class, so
      // duck-type it. `index` is a character offset into the compiled source.
      let isQueryError = error.name === "QueryError" && typeof error.index === "number";
      if (isQueryError && typeof source === "string") {
        descriptor.kindLabel = QUERY_ERROR_KIND_LABELS[error.kind] ?? null;
        descriptor.word = error.info?.word || null;

        let entry = null;
        if (sourceMap) {
          for (let candidate of sourceMap) {
            if (candidate.start <= error.index) entry = candidate;
          }
        }
        let fileStart = 0;
        if (entry) {
          descriptor.filePath = entry.filePath;
          fileStart = entry.start;
        }
        let line = 1;
        for (let i = fileStart; i < error.index; i++) {
          if (source.charCodeAt(i) === 10) line++;
        }
        descriptor.line = line;

        let lineStart = source.lastIndexOf("\n", Math.max(0, error.index - 1)) + 1;
        let lineEnd = source.indexOf("\n", error.index);
        if (lineEnd === -1) lineEnd = source.length;
        descriptor.lineText = source.slice(lineStart, lineEnd).trim() || null;
      } else if (sourceMap) {
        // Predicate errors (bad `#match?` regex, wrong argument counts) are
        // plain `Error`s with no offset; the best we can do is name the files
        // the query came from.
        descriptor.candidateFiles = sourceMap.map((mapEntry) => mapEntry.filePath);
      }
    } catch {
      // Fall through with whatever fields were filled in.
    }
    return descriptor;
  }

  // Renders a descriptor from {@link #describeQueryError} as a human-readable
  // multi-line string.
  static formatQueryErrorDescriptor(descriptor) {
    let parts = [`Error compiling ${descriptor.queryType} for grammar ${descriptor.scopeName}`];
    if (descriptor.filePath) {
      let location =
        descriptor.line != null ? `${descriptor.filePath}:${descriptor.line}` : descriptor.filePath;
      parts.push(`at ${location}`);
    } else if (descriptor.candidateFiles?.length > 0) {
      parts.push(`in one of: ${descriptor.candidateFiles.join(", ")}`);
    }
    if (descriptor.kindLabel) {
      parts.push(
        descriptor.word ? `${descriptor.kindLabel}: '${descriptor.word}'` : descriptor.kindLabel,
      );
    } else {
      parts.push(descriptor.message);
    }
    if (descriptor.lineText) {
      parts.push(`> ${descriptor.lineText}`);
    }
    return parts.join("\n");
  }

  // Reports a query compilation error to the console — and, in dev mode, as a
  // notification — at most once per distinct error. The dedupe re-arms when
  // the query's source changes, so a fixed-then-rebroken query reports again.
  reportQueryError(error, queryType) {
    let dedupeKey = `${queryType}:${error.message}`;
    if (this.reportedQueryErrors.has(dedupeKey)) {
      return;
    }
    this.reportedQueryErrors.add(dedupeKey);

    let descriptor = error.queryDescriptor ?? this.describeQueryError(error, queryType);
    let formatted = TreeSitterGrammar.formatQueryErrorDescriptor(descriptor);
    console.error(formatted, error);
    if (lumine.window.isDevMode() && !lumine.window.isSpecMode()) {
      lumine.notifications.addError(`Tree-sitter query error in ${this.scopeName}`, {
        detail: formatted,
        dismissable: true,
      });
    }
  }

  /**
   * @public
   * @status extended
   *
   * Given a kind of query, retrieves a Tree-sitter `Query` object
   * in async fashion.
   *
   * @param queryType - A `String` describing the query type: typically one of `highlightsQuery`, `foldsQuery`, `tagsQuery`, or `indentsQuery`, but could be any other custom type.
   * @returns {Promise} that resolves to a Tree-sitter `Query` object.
   */
  getQuery(queryType) {
    // Async, but designed so that multiple near-simultaneous calls to
    // `getQuery` from multiple buffers will not cause multiple calls to
    // `language.query`, since it's a major bottleneck. Instead they all
    // receive the same unsettled promise.
    // let inDevMode = lumine.window.isDevMode();
    let query = this.queryCache.get(queryType);
    if (query) {
      return Promise.resolve(query);
    }

    let promise = this.promisesForQueries.get(queryType);
    if (promise) {
      return promise;
    }

    promise = new Promise((resolve, reject) => {
      this.getLanguage().then((language) => {
        // let timeTag = `${this.scopeName} ${queryType} load time`;
        try {
          // if (inDevMode) { console.time(timeTag); }
          query = this._createQuery(language, this[queryType]);

          // if (inDevMode) { console.timeEnd(timeTag); }
          this.queryCache.set(queryType, query);
          resolve(query);
        } catch (error) {
          // if (inDevMode) { console.timeEnd(timeTag); }
          error.queryDescriptor ??= this.describeQueryError(error, queryType);
          reject(error);
        }
        // Propagate a failed language load; otherwise this promise never
        // settles and callers await it forever.
      }, reject);
    }).finally(() => {
      this.promisesForQueries.delete(queryType);
    });

    this.promisesForQueries.set(queryType, promise);
    return promise;
  }

  /**
   * @public
   * @status extended
   *
   * Creates an arbitrary query from this grammar. Package authors
   * and end users can use queries for whatever purposes they like.
   *
   * @param queryContents - A `String` representing the entire contents of a query file. Can contain any number of queries.
   * @returns {Promise} that will resolve to a Tree-sitter `Query` object.
   */
  async createQuery(queryContents) {
    let language = await this.getLanguage();
    return this._createQuery(language, queryContents);
  }

  /**
   * @public
   * @status extended
   *
   * Creates an arbitrary query from this grammar. Package authors
   * and end users can use queries for whatever purposes they like.
   *
   * Synchronous; use only when you can be certain that the tree-sitter
   * language has already loaded.
   *
   * @param queryContents - A `String` representing the entire contents of a query file. Can contain any number of queries.
   * @returns {Object} Tree-sitter `Query` object.
   */
  createQuerySync(queryContents) {
    if (!this._language) {
      throw new Error(`Language not loaded!`);
    }
    return this._createQuery(this._language, queryContents);
  }

  // Internal queries are derived from runtime state rather than query files.
  // They are immutable and shared by every language layer using this grammar,
  // so compiling a given source more than once only wastes time and Wasm
  // memory. Callers must not delete the returned query; the grammar owns it.
  _getOrCreateInternalQuerySync(queryContents) {
    let query = this.internalQueryCache.get(queryContents);
    if (!query) {
      query = this.createQuerySync(queryContents);
      this.internalQueryCache.set(queryContents, query);
    }
    return query;
  }

  // Used by the specs to override a particular query for testing.
  async setQueryForTest(queryType, contents) {
    await this.getLanguage();
    this.queryCache.delete(queryType);
    // The programmatic source no longer corresponds to any file on disk.
    this.querySourceMaps.delete(queryType);
    this[queryType] = contents;
    let query = await this.getQuery(queryType);
    this.emitter.emit("did-change-query", { filePath: "", queryType });
    return query;
  }

  // Observe a particular query file on disk so that it can immediately be
  // re-applied when it changes. Occurs only in dev mode.
  observeQueryFile(filePaths, queryType) {
    for (let filePath of filePaths) {
      const onChange = () => {
        let existingQuery = this[queryType];
        // When any one of the file paths changes, we have to re-concatenate
        // the whole set.
        this.loadQueryFile(filePaths, queryType).then(async () => {
          // Sanity-check the language for errors before we let the buffers know
          // about this change.
          try {
            await this.getQuery(queryType);
          } catch (error) {
            lumine.notifications.beep();
            this.reportQueryError(error, queryType);
            this[queryType] = existingQuery;
            this.queryCache.delete(queryType);
            return;
          }
          this.emitter.emit("did-change-query", { filePath, queryType });
        });
      };
      const watcherPromise = watchPath(filePath, { recursive: false }, () => onChange());
      // A watch that fails to arm (or a watcher-worker death mid-arm) reports
      // through the watcher's own channels; without this, the rejection would
      // surface as unhandled and be attributed to unrelated work.
      watcherPromise.catch(() => {});
      this.subscriptions.add(
        new Disposable(() =>
          watcherPromise.then(
            (watcher) => watcher.dispose(),
            () => {},
          ),
        ),
      );
    }
  }

  /**
   * @public
   * @status extended
   *
   * Calls `callback` when any of this grammar's queries change.
   *
   * A grammar's queries typically will not change after initial load. When
   * they do, it may mean:
   *
   * - The user is editing query files in dev mode; Lumine will automatically
   *   reload queries in dev mode after changes.
   * - An installed package is altering a query file via an API like
   *   `setQueryForTest`.
   *
   * @param {Function} callback
   * @param {Object} callback.data
   * @param {String} callback.data.filePath - The path to the query file on disk.
   * @param {String} callback.data.queryType - The type of query file, as denoted by its configuration key in the grammar file. Usually one of `highlightsQuery`, `indentsQuery`, `foldsQuery`, or `tagsQuery`.
   */
  onDidChangeQuery(callback) {
    return this.emitter.on("did-change-query", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls `callback` when any of this grammar's queries change.
   *
   * Alias of {@link #onDidChangeQuery}.
   */
  onDidChangeQueryFile(callback) {
    return this.onDidChangeQuery(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls `callback` when this grammar first loads its query files.
   *
   * Since a grammar may not load immediately on startup, this method makes it
   * easier to hook into the query life cycle in order to modify or augment a
   * grammar's default queries.
   *
   * * callback A function with the following argument:
   *   * grammar The {@link TreeSitterGrammar} whose queries have loaded.
   */
  onDidLoadQueryFiles(callback) {
    return this.emitter.on("did-load-query-files", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls `callback` when an injection point is added to this
   * grammar.
   *
   * * callback A function with the following argument:
   *   * injectionPoint The injection point added to the grammar. See
   *     {@link TreeSitterGrammar#addInjectionPoint}.
   */
  onDidAddInjectionPoint(callback) {
    return this.emitter.on("did-add-injection-point", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls `callback` when an injection point is removed from this
   * grammar.
   *
   * * callback A function with the following argument:
   *   * injectionPoint The injection point removed from this grammar. See
   *     {@link TreeSitterGrammar#addInjectionPoint}.
   */
  onDidRemoveInjectionPoint(callback) {
    return this.emitter.on("did-remove-injection-point", callback);
  }

  activate() {
    this.registration = this.registry.addGrammar(this);
  }

  deactivate() {
    this.registration?.dispose();
    this.subscriptions?.dispose();
    // A new query object gets instantiated for each kind of query every time a
    // grammar activates. WASM queries need explicit cleanup; native queries
    // are garbage-collected and do not expose `delete`.
    for (let value of this.queryCache.values()) {
      value.delete?.();
    }
    this.queryCache.clear();
    for (let value of this.internalQueryCache.values()) {
      value.delete?.();
    }
    this.internalQueryCache.clear();
    this._language = null;
  }

  /**
   * @public
   * @status extended
   *
   * Define a set of rules for when this grammar should delegate to a
   * different grammar for certain regions of a buffer. Examples:
   *
   * * embedding one language inside another (e.g., JavaScript in HTML)
   * * tokenizing certain structures with greater detail (e.g., regular
   *   expressions in most languages)
   * * highlighting non-standard augmentations to a language (e.g., JSDoc
   *   comments in JavaScript)
   *
   * You should typically not call this method directly; instead, call
   * {@link GrammarRegistry#addInjectionPoint} and pass a given grammar’s root
   * language scope as the first argument.
   *
   * NOTE: Packages will call {@link #addInjectionPoint} with a given scope name,
   * and that call will be delegated to any Tree-sitter grammar matching that
   * scope name.
   *
   * @param injectionPoint - The options for the injection point:
   * @param injectionPoint.type - A `String` describing the type of node to inject into.
   * @param injectionPoint.language - A `Function` that should return a short, unambiguous language name declared by the target grammar in `injectionNames`. Matching ignores surrounding whitespace and letter case. Receives one parameter:
   * @param injectionPoint.language.node - A Tree-sitter node.
   * @param injectionPoint.content - A `Function` that should return the node (or nodes) that will actually be injected into. Usually this will be the same node that was given, but could also be a specific child or descendant of that node.
   * @param {Boolean} [injectionPoint.includeChildren] - controlling whether the injection range should include the ranges of the content node’s children. Defaults to `false`, meaning that the range of each of this node's children will be "subtracted" from the injection range, and the remainder will be parsed as if those ranges of the buffer do not exist.
   * @param {Boolean} [injectionPoint.includeAdjacentWhitespace] - controlling whether the injection range should include whitespace that occurs between content nodes. Defaults to `false`. When `true`, if two injection ranges are separated from one another by only whitespace, that whitespace will be added to the injection range, and the ranges will be consolidated.
   * @param {Boolean} [injectionPoint.newlinesBetween] - controlling whether the injection range should include any newline characters that may exist in between injection ranges. Defaults to `false`. Grammars like ERB and EJS need this so that they do not interpret two different embedded code sections on different lines as occurring on the same line.
   * @param {Boolean} [injectionPoint.coverShallowerScopes] - controlling whether the injection should prevent the parent grammar (and any of its ancestors) from applying scope boundaries within its injection range(s). Defaults to `false`.
   * @param [injectionPoint.languageScope] - A value that determines what scope, if any, is added to the injection as its “base” scope name. Can be a `String`, `null`, or a `Function` that returns either of these values. The base language scope that should be used by this injection. Defaults to the grammar's own `scopeName` property. Set this to a string to override the default scope name, or `null` to omit a base scope name altogether. Set this to a function if the scope name to be applied varies based on the grammar; the function will be called with a grammar instance as its only argument.
   */
  addInjectionPoint(injectionPoint) {
    let { type } = injectionPoint;
    let injectionPoints = this.injectionPointsByType[type];
    if (!injectionPoints) {
      injectionPoints = this.injectionPointsByType[type] = [];
    }
    injectionPoints.push(injectionPoint);
    this.emitter.emit("did-add-injection-point", injectionPoint);
  }

  removeInjectionPoint(injectionPoint) {
    const injectionPoints = this.injectionPointsByType[injectionPoint.type];
    if (injectionPoints) {
      const index = injectionPoints.indexOf(injectionPoint);
      if (index !== -1) injectionPoints.splice(index, 1);
      if (injectionPoints.length === 0) {
        delete this.injectionPointsByType[injectionPoint.type];
      }
    }
    this.emitter.emit("did-remove-injection-point", injectionPoint);
  }

  inspect() {
    return `TreeSitterGrammar {scopeName: ${this.scopeName}}`;
  }
};

function buildRegex(value) {
  // Allow multiple alternatives to be specified via an array, for
  // readability of the grammar file
  if (Array.isArray(value)) value = value.map((_) => `(${_})`).join("|");
  if (typeof value === "string") return new RegExp(value);
  return null;
}

function normalizeInjectionNames(value, grammarPath) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new Error(`Tree-sitter grammar ${grammarPath} must specify injectionNames as an array`);
  }

  let names = new Set();
  for (const name of value) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(
        `Tree-sitter grammar ${grammarPath} contains an invalid injectionNames entry`,
      );
    }
    names.add(name.trim().toLowerCase());
  }
  return Object.freeze(Array.from(names));
}
