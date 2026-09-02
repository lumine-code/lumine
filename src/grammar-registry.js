const _ = require("@lumine-code/underscore-plus");
const CSON = require("@lumine-code/season");
const { Disposable, CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const TreeSitterLanguageMode = require("./tree-sitter-language-mode");
const TreeSitterGrammar = require("./tree-sitter-grammar");
const NullLanguageMode = require("./null-language-mode");
const NullGrammar = require("./null-grammar");
const fs = require("@lumine-code/fs-plus");
const { Point, Range } = require("./text-buffer");

const PATH_SPLIT_REGEX = new RegExp("[/.]");

/**
 * @public
 * @status extended
 *
 * This class holds the grammars used for tokenizing.
 *
 * An instance of this class is always available as the `lumine.grammars` global.
 */
module.exports = class GrammarRegistry {
  constructor({ config } = {}) {
    this.config = config;
    this.subscriptions = new CompositeDisposable();
    this.emitter = new Emitter();
    this.clear();
  }

  clear() {
    this.treeSitterGrammarsById = {};
    this.treeSitterGrammarsByInjectionName = new Map();

    if (this.subscriptions) this.subscriptions.dispose();
    this.subscriptions = new CompositeDisposable();

    this.languageOverridesByBufferId = new Map();
    this.grammarScoresByBuffer = new Map();
    // Buffers already wired to release themselves, so a repeated assignment
    // does not stack subscriptions.
    this.releasedBuffers = new WeakSet();
  }

  serialize() {
    const languageOverridesByBufferId = {};
    this.languageOverridesByBufferId.forEach((languageId, bufferId) => {
      languageOverridesByBufferId[bufferId] = languageId;
    });
    return { languageOverridesByBufferId };
  }

  deserialize(params) {
    for (const bufferId in params.languageOverridesByBufferId || {}) {
      this.languageOverridesByBufferId.set(bufferId, params.languageOverridesByBufferId[bufferId]);
    }
  }

  /**
   * @public
   * @status extended
   *
   * set a {@link TextBuffer}'s language mode based on its path and content,
   * and continue to update its language mode as grammars are added or updated, or
   * the buffer's file path changes.
   *
   * @param buffer - The {@link TextBuffer} whose language mode will be maintained.
   * @returns {Disposable} that can be used to stop updating the buffer's language mode.
   */
  maintainLanguageMode(buffer) {
    this.grammarScoresByBuffer.set(buffer, null);

    // This method installs its own destroy handler below, so claim the buffer
    // before assigning: otherwise `assignLanguageMode` would register a second
    // one that deletes the same two entries.
    this.releasedBuffers.add(buffer);

    const languageOverride = this.languageOverridesByBufferId.get(buffer.id);
    if (languageOverride) {
      this.assignLanguageMode(buffer, languageOverride);
    } else {
      this.autoAssignLanguageMode(buffer);
    }

    const pathChangeSubscription = buffer.onDidChangePath(() => {
      this.grammarScoresByBuffer.delete(buffer);
      if (!this.languageOverridesByBufferId.has(buffer.id)) {
        this.autoAssignLanguageMode(buffer);
      }
    });

    const destroySubscription = buffer.onDidDestroy(() => {
      this.grammarScoresByBuffer.delete(buffer);
      this.languageOverridesByBufferId.delete(buffer.id);
      this.releasedBuffers.delete(buffer);
      this.subscriptions.remove(destroySubscription);
      this.subscriptions.remove(pathChangeSubscription);
    });

    this.subscriptions.add(pathChangeSubscription, destroySubscription);

    return new Disposable(() => {
      destroySubscription.dispose();
      pathChangeSubscription.dispose();
      this.subscriptions.remove(pathChangeSubscription);
      this.subscriptions.remove(destroySubscription);
      this.grammarScoresByBuffer.delete(buffer);
      this.languageOverridesByBufferId.delete(buffer.id);
      // No longer claimed: a later assignment must be free to register its own
      // one-shot release for a buffer that outlives being maintained.
      this.releasedBuffers.delete(buffer);
    });
  }

  /**
   * @public
   * @status extended
   *
   * Force a {@link TextBuffer} to use a different grammar than the
   * one that would otherwise be selected for it.
   *
   * @param buffer - The {@link TextBuffer} whose grammar will be set.
   * @param languageId - The `String` id of the desired language.
   * @returns {Boolean} that indicates whether the language was successfully found.
   */
  assignLanguageMode(buffer, languageId) {
    if (buffer.getBuffer) buffer = buffer.getBuffer();

    let grammar;
    if (languageId != null) {
      grammar = this.grammarForId(languageId);
      if (!grammar || !grammar.scopeName) return false;
      this.languageOverridesByBufferId.set(buffer.id, languageId);
    } else {
      this.languageOverridesByBufferId.set(buffer.id, null);
      grammar = NullGrammar;
    }

    this.grammarScoresByBuffer.set(buffer, null);
    this.releaseBufferOnDestroy(buffer);
    if (grammar !== buffer.getLanguageMode().grammar) {
      buffer.setLanguageMode(this.languageModeForGrammarAndBuffer(grammar, buffer));
    }

    return true;
  }

  /**
   * @public
   * @status extended
   *
   * Force a {@link TextBuffer} to use a different grammar than the
   * one that would otherwise be selected for it.
   *
   * @param buffer - The {@link TextBuffer} whose grammar will be set.
   * @param grammar - The desired {@link TreeSitterGrammar}, or the null grammar sentinel.
   * @returns {Boolean} that indicates whether the assignment was successful
   */
  assignGrammar(buffer, grammar) {
    if (!grammar) return false;
    if (buffer.getBuffer) buffer = buffer.getBuffer();
    this.languageOverridesByBufferId.set(buffer.id, grammar.scopeName || null);
    this.grammarScoresByBuffer.set(buffer, null);
    this.releaseBufferOnDestroy(buffer);
    if (grammar !== buffer.getLanguageMode().grammar) {
      buffer.setLanguageMode(this.languageModeForGrammarAndBuffer(grammar, buffer));
    }
    return true;
  }

  // `grammarScoresByBuffer` holds buffers strongly and cannot be a WeakMap —
  // it is iterated whenever grammars are added or removed. Buffers reaching it
  // through `maintainLanguageMode` are released when they are destroyed, but a
  // buffer assigned a grammar directly had nothing releasing it, so every
  // throwaway editor given a language mode — one per fenced code block that
  // `lumine.tools.markdown.applySyntaxHighlighting` renders — stayed alive for the
  // lifetime of the window.
  releaseBufferOnDestroy(buffer) {
    if (this.releasedBuffers.has(buffer)) return;
    this.releasedBuffers.add(buffer);
    const subscription = buffer.onDidDestroy(() => {
      this.grammarScoresByBuffer.delete(buffer);
      this.languageOverridesByBufferId.delete(buffer.id);
      this.releasedBuffers.delete(buffer);
      this.subscriptions.remove(subscription);
    });
    this.subscriptions.add(subscription);
  }

  /**
   * @public
   * @status extended
   *
   * Get the `languageId` that has been explicitly assigned to
   * the given buffer, if any.
   *
   * @returns {String} id of the language
   */
  getAssignedLanguageId(buffer) {
    return this.languageOverridesByBufferId.get(buffer.id);
  }

  /**
   * @public
   * @status extended
   *
   * Remove any language mode override that has been set for the
   * given {@link TextBuffer}. This will assign to the buffer the best language
   * mode available.
   *
   * @param buffer - The {@link TextBuffer}.
   */
  autoAssignLanguageMode(buffer) {
    const result = this.selectGrammarWithScore(
      buffer.getPath(),
      getGrammarSelectionContent(buffer),
    );
    this.languageOverridesByBufferId.delete(buffer.id);
    this.grammarScoresByBuffer.set(buffer, result.score);
    if (result.grammar !== buffer.getLanguageMode().grammar) {
      buffer.setLanguageMode(this.languageModeForGrammarAndBuffer(result.grammar, buffer));
    }
  }

  languageModeForGrammarAndBuffer(grammar, buffer) {
    if (grammar === NullGrammar) {
      return new NullLanguageMode({ grammar, buffer });
    }
    if (!(grammar instanceof TreeSitterGrammar)) {
      throw new TypeError("Language modes require a Tree-sitter grammar");
    }
    return new TreeSitterLanguageMode({
      grammar,
      buffer,
      config: this.config,
      grammars: this,
    });
  }

  /**
   * @public
   * @status extended
   *
   * Select a grammar for the given file path and file contents.
   *
   * This picks the best match by checking the file path and contents against
   * each grammar.
   *
   * @param filePath - A `String` file path.
   * @param fileContents - A `String` of text for the file path.
   * @returns {TreeSitterGrammar|Object} a Tree-sitter grammar or the null grammar sentinel.
   */
  selectGrammar(filePath, fileContents) {
    return this.selectGrammarWithScore(filePath, fileContents).grammar;
  }

  selectGrammarWithScore(filePath, fileContents) {
    let bestMatch = null;
    let highestScore = -Infinity;
    this.forEachGrammar((grammar) => {
      const score = this.getGrammarScore(grammar, filePath, fileContents);
      if (score > highestScore || bestMatch == null) {
        bestMatch = grammar;
        highestScore = score;
      }
    });
    return { grammar: bestMatch, score: highestScore };
  }

  /**
   * @public
   * @status extended
   *
   * Evaluates a grammar's fitness for use for a certain file.
   *
   * By analyzing the file's extension and contents — plus other criteria, like
   * the user's configuration — Lumine will assign a score to this grammar that
   * represents how suitable it is for the given file.
   *
   * Ultimately, whichever grammar scores highest for this file will be used
   * to highlight it.
   *
   * @param grammar - A given {@link TreeSitterGrammar}, or the null grammar sentinel.
   * @param filePath - A `String` path to the file.
   * @param contents - The `String` contents of the file.
   * @returns {Number}
   */
  getGrammarScore(grammar, filePath, contents) {
    if (contents == null && fs.isFileSync(filePath)) {
      contents = fs.readFileSync(filePath, "utf8");
    }

    // Initially identify matching grammars based on the filename and the first
    // line of the file.
    let score = this.getGrammarPathScore(grammar, filePath);
    if (this.grammarMatchesPrefix(grammar, contents)) score += 0.5;

    // If multiple grammars match by one of the above criteria, break ties.
    if (score > 0) {
      score += 0.1;

      // Prefer grammars with matching content regexes. Prefer a grammar with
      // no content regex over one with a non-matching content regex.
      //
      // There may be no contents to match against: the caller passed none and
      // the path is not a file on disk — an unsaved buffer, a remote path, or a
      // package calling `selectGrammar(path)`. Count that as a miss.
      if (grammar.contentRegex) {
        let contentMatch = false;
        if (typeof contents === "string") {
          grammar.contentRegex.lastIndex = 0;
          contentMatch = grammar.contentRegex.test(contents);
          grammar.contentRegex.lastIndex = 0;
        }
        if (contentMatch) {
          score += 0.05;
        } else {
          score -= 0.05;
        }
      }

      // Prefer grammars that the user has manually installed over bundled
      // grammars.
      if (!grammar.bundledPackage) score += 0.01;
    }

    return score;
  }

  getGrammarPathScore(grammar, filePath) {
    if (!filePath) return -1;
    if (process.platform === "win32") {
      filePath = filePath.replace(/\\/g, "/");
    }

    const pathComponents = filePath.toLowerCase().split(PATH_SPLIT_REGEX);
    let pathScore = 0;

    let customFileTypes;
    if (this.config.get("core.customFileTypes")) {
      customFileTypes = this.config.get("core.customFileTypes")[grammar.scopeName];
    }

    let { fileTypes } = grammar;
    if (customFileTypes) {
      fileTypes = fileTypes.concat(customFileTypes);
    }

    for (let i = 0; i < fileTypes.length; i++) {
      const fileType = fileTypes[i];
      const fileTypeComponents = fileType.toLowerCase().split(PATH_SPLIT_REGEX);
      const pathSuffix = pathComponents.slice(-fileTypeComponents.length);
      if (_.isEqual(pathSuffix, fileTypeComponents)) {
        pathScore = Math.max(pathScore, fileType.length);
        if (i >= grammar.fileTypes.length) {
          pathScore += 0.5;
        }
      }
    }

    return pathScore;
  }

  grammarMatchesPrefix(grammar, contents) {
    if (contents && grammar.firstLineRegex) {
      let escaped = false;
      let numberOfNewlinesInRegex = 0;
      for (let character of grammar.firstLineRegex.source) {
        switch (character) {
          case "\\":
            escaped = !escaped;
            break;
          case "n":
            if (escaped) {
              numberOfNewlinesInRegex++;
            }
            escaped = false;
            break;
          default:
            escaped = false;
        }
      }

      const prefix = contents
        .split("\n")
        .slice(0, numberOfNewlinesInRegex + 1)
        .join("\n");
      grammar.firstLineRegex.lastIndex = 0;
      const matches = grammar.firstLineRegex.test(prefix);
      grammar.firstLineRegex.lastIndex = 0;
      return matches;
    } else {
      return false;
    }
  }

  forEachGrammar(callback) {
    this.getGrammars().forEach(callback);
  }

  grammarForId(languageId) {
    if (!languageId) return null;
    if (languageId === NullGrammar.scopeName) return NullGrammar;
    const grammar = this.treeSitterGrammarsById[languageId];
    return grammar instanceof TreeSitterGrammar ? grammar : undefined;
  }

  grammarAddedOrUpdated(grammar) {
    if (grammar.scopeName && !grammar.id) grammar.id = grammar.scopeName;

    this.grammarScoresByBuffer.forEach((score, buffer) => {
      const languageMode = buffer.getLanguageMode();
      const languageOverride = this.languageOverridesByBufferId.get(buffer.id);
      const currentGrammar = languageMode.grammar;

      if (
        grammar === currentGrammar ||
        grammar.scopeName === currentGrammar?.scopeName ||
        grammar === this.grammarForId(languageOverride)
      ) {
        buffer.setLanguageMode(this.languageModeForGrammarAndBuffer(grammar, buffer));
        return;
      } else if (!languageOverride) {
        const score = this.getGrammarScore(
          grammar,
          buffer.getPath(),
          getGrammarSelectionContent(buffer),
        );
        const currentScore = this.grammarScoresByBuffer.get(buffer);
        if (currentScore == null || score > currentScore) {
          buffer.setLanguageMode(this.languageModeForGrammarAndBuffer(grammar, buffer));
          this.grammarScoresByBuffer.set(buffer, score);
          return;
        }
      }

      languageMode.updateInjectionsForGrammar?.(grammar);
    });
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a grammar is added to the registry.
   *
   * @param {Function} callback - to call when a grammar is added.
   * @param {TreeSitterGrammar} callback.grammar - that was added.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddGrammar(callback) {
    return this.emitter.on("did-add-grammar", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a grammar is updated due to a grammar
   * it depends on being added or removed from the registry.
   *
   * @param {Function} callback - to call when a grammar is updated.
   * @param {TreeSitterGrammar} callback.grammar - that was updated.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidUpdateGrammar(callback) {
    return this.emitter.on("did-update-grammar", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a grammar is removed from the
   * registry, which happens whenever the package that provides it deactivates.
   *
   * @param {Function} callback - to call when a grammar is removed.
   * @param {TreeSitterGrammar} callback.grammar - that was removed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidRemoveGrammar(callback) {
    return this.emitter.on("did-remove-grammar", callback);
  }

  /**
   * @public
   * @status public
   *
   * Specify a type of syntax node that may embed other languages.
   *
   * @param {String} grammarId - The id of the parent language.
   * @param {Object} injectionPoint - Injection behavior.
   * @param {String} injectionPoint.type - The syntax-node type that may embed other languages.
   * @param {Function} injectionPoint.language - Called with a matching syntax node and returns a language name declared by the target Tree-sitter grammar in `injectionNames`. Matching ignores surrounding whitespace and letter case.
   * @param {Function} injectionPoint.content - Called with a matching syntax node and returns the node or nodes containing embedded source. The nodes become visible buffer ranges for the injected parser.
   * @param injectionPoint.includeChildren - A `Boolean` that indicates whether the children (and, in fact, all descendants) of the nodes returned by `content` should be included in the injection's buffer range(s). Defaults to `false`.
   * @param injectionPoint.newlinesBetween - A `Boolean` that indicates whether each node returned from `content` should be separated by at least one newline character so that the parser understands them to be logically separated. Embedded languages like ERB and EJS need this. Defaults to `false`.
   * @param injectionPoint.languageScope - A `String` or `Function` that returns the desired scope name to apply to each of the injection's buffer ranges. Defaults to the injected grammar's own language scope — e.g., `source.js` for the JavaScript grammar. Set to `null` if the language scope should be omitted. If a `Function`, will be called with the grammar instance as an argument, and should return either a `String` or `null`.
   * @param injectionPoint.coverShallowerScopes - A `Boolean` that indicates whether this injection should prevent shallower layers (including the layer that created this injection) from adding scopes within any of this injection's buffer ranges. Useful for injecting languages into themselves — for instance, injecting Rust into Rust macro definitions.
   * @param injectionPoint.includeAdjacentWhitespace - A `Boolean` that indicates whether the injection's buffer range(s) should include whitespace that occurs between two adjacent ranges. Defaults to `false`. When `true`, if two consecutive injection buffer ranges are separated _only_ by whitespace, those ranges will be consolidated into one range along with that whitespace.
   * @returns {Disposable} A disposable that removes the injection point.
   */
  addInjectionPoint(grammarId, injectionPoint) {
    const table = this.treeSitterGrammarsById;
    const grammar = table[grammarId];
    if (grammar) {
      if (grammar.addInjectionPoint) {
        grammar.addInjectionPoint(injectionPoint);

        // This is a grammar that's already loaded — not just a stub. Editors
        // that already use this grammar will want to know that we added an
        // injection.
        this.emitter.emit("did-update-grammar", grammar);
      } else {
        grammar.injectionPoints.push(injectionPoint);
      }
    } else {
      table[grammarId] = { injectionPoints: [injectionPoint] };
    }

    return new Disposable(() => {
      const entry = table[grammarId];
      if (entry?.removeInjectionPoint) {
        const injectionPoints = entry.injectionPointsByType[injectionPoint.type];
        if (injectionPoints?.includes(injectionPoint)) {
          entry.removeInjectionPoint(injectionPoint);
        }
        return;
      }

      const injectionPoints = entry?.injectionPoints;
      const index = injectionPoints?.indexOf(injectionPoint) ?? -1;
      if (index === -1) return;
      injectionPoints.splice(index, 1);
      if (injectionPoints.length === 0 && table[grammarId] === entry) {
        delete table[grammarId];
      }
    });
  }

  get nullGrammar() {
    return NullGrammar;
  }

  get grammars() {
    return this.getGrammars();
  }

  grammarForScopeName(scopeName) {
    return this.grammarForId(scopeName);
  }

  addGrammar(grammar) {
    if (!(grammar instanceof TreeSitterGrammar)) {
      throw new TypeError("Only Tree-sitter grammars can be registered");
    }
    const existingParams = this.treeSitterGrammarsById[grammar.scopeName] || {};
    const replacedGrammar = existingParams instanceof TreeSitterGrammar ? existingParams : null;
    this.validateTreeSitterInjectionNames(grammar, replacedGrammar);
    if (replacedGrammar && replacedGrammar !== grammar) {
      this.unregisterTreeSitterInjectionNames(replacedGrammar);
    }
    if (grammar.scopeName) this.treeSitterGrammarsById[grammar.scopeName] = grammar;
    this.registerTreeSitterInjectionNames(grammar);
    if (existingParams.injectionPoints) {
      for (const injectionPoint of existingParams.injectionPoints) {
        grammar.addInjectionPoint(injectionPoint);
      }
    }
    this.grammarAddedOrUpdated(grammar);
    this.emitter.emit("did-add-grammar", grammar);
    return new Disposable(() => this.removeGrammar(grammar));
  }

  removeGrammar(grammar) {
    if (!(grammar instanceof TreeSitterGrammar)) return false;
    this.unregisterTreeSitterInjectionNames(grammar);
    if (this.treeSitterGrammarsById[grammar.scopeName] === grammar) {
      delete this.treeSitterGrammarsById[grammar.scopeName];
    }
    this.grammarScoresByBuffer.forEach((_score, buffer) => {
      const languageMode = buffer.getLanguageMode();
      if (languageMode.grammar === grammar) {
        if (this.languageOverridesByBufferId.has(buffer.id)) {
          this.grammarScoresByBuffer.set(buffer, null);
          buffer.setLanguageMode(
            this.languageModeForGrammarAndBuffer(
              this.grammarForId(this.languageOverridesByBufferId.get(buffer.id)) ?? NullGrammar,
              buffer,
            ),
          );
        } else {
          this.autoAssignLanguageMode(buffer);
        }
      } else {
        languageMode.repopulateInjections?.();
      }
    });
    this.emitter.emit("did-remove-grammar", grammar);
    return true;
  }

  removeGrammarForScopeName(scopeName) {
    const grammar = this.grammarForId(scopeName);
    return grammar instanceof TreeSitterGrammar ? this.removeGrammar(grammar) : false;
  }

  /**
   * @public
   * @status extended
   *
   * Read a grammar asynchronously and add it to the registry.
   *
   * @param grammarPath - A `String` absolute file path to a grammar file.
   * @param callback - A `Function` to call when loaded with the following arguments:
   * @param callback.error - An `Error`, may be null.
   * @param callback.grammar - A {@link TreeSitterGrammar} or null if an error occurred.
   */
  loadGrammar(grammarPath, callback) {
    this.readGrammar(grammarPath, (error, grammar) => {
      if (error) return callback(error);
      this.addGrammar(grammar);
      callback(null, grammar);
    });
  }

  /**
   * @public
   * @status extended
   *
   * Read a grammar synchronously and add it to this registry.
   *
   * @param grammarPath - A `String` absolute file path to a grammar file.
   * @returns {TreeSitterGrammar}
   */
  loadGrammarSync(grammarPath) {
    const grammar = this.readGrammarSync(grammarPath);
    this.addGrammar(grammar);
    return grammar;
  }

  /**
   * @public
   * @status extended
   *
   * Read a grammar asynchronously but don't add it to the registry.
   *
   * @param grammarPath - A `String` absolute file path to a grammar file.
   * @param callback - A `Function` to call when read with the following arguments:
   * @param callback.error - An `Error`, may be null.
   * @param callback.grammar - A {@link TreeSitterGrammar} or null if an error occurred.
   * @returns {undefined} undefined.
   */
  readGrammar(grammarPath, callback) {
    if (!callback) callback = () => {};
    CSON.readFile(grammarPath, (error, params = {}) => {
      if (error) return callback(error);
      try {
        callback(null, this.createGrammar(grammarPath, params));
      } catch (error) {
        callback(error);
      }
    });
  }

  /**
   * @public
   * @status extended
   *
   * Read a grammar synchronously but don't add it to the registry.
   *
   * @param grammarPath - A `String` absolute file path to a grammar file.
   * @returns {TreeSitterGrammar}
   */
  readGrammarSync(grammarPath) {
    return this.createGrammar(grammarPath, CSON.readFileSync(grammarPath) || {});
  }

  createGrammar(grammarPath, params) {
    if (params.type !== "tree-sitter") {
      throw new Error(`Grammar must declare type 'tree-sitter': ${grammarPath}`);
    }
    return new TreeSitterGrammar(this, grammarPath, params);
  }

  /**
   * @public
   * @status extended
   *
   * Get all the grammars in this registry.
   *
   * @returns {Array} non-empty `Array` containing the null grammar sentinel followed by registered {@link TreeSitterGrammar} instances.
   */
  getGrammars() {
    return [
      NullGrammar,
      ...Object.values(this.treeSitterGrammarsById).filter(
        (grammar) => grammar instanceof TreeSitterGrammar,
      ),
    ];
  }

  validateTreeSitterInjectionNames(grammar, replacedGrammar = null) {
    for (const name of grammar.injectionNames) {
      const existing = this.treeSitterGrammarsByInjectionName.get(name);
      if (existing && existing !== grammar && existing !== replacedGrammar) {
        throw new Error(
          `Tree-sitter injection name '${name}' is declared by both ` +
            `'${existing.scopeName}' and '${grammar.scopeName}'`,
        );
      }
    }
  }

  registerTreeSitterInjectionNames(grammar) {
    for (const name of grammar.injectionNames) {
      this.treeSitterGrammarsByInjectionName.set(name, grammar);
    }
  }

  unregisterTreeSitterInjectionNames(grammar) {
    for (const name of grammar.injectionNames) {
      if (this.treeSitterGrammarsByInjectionName.get(name) === grammar) {
        this.treeSitterGrammarsByInjectionName.delete(name);
      }
    }
  }

  // Match a language string produced by an injection point to one explicit
  // alias owned by a Tree-sitter grammar.
  treeSitterGrammarForLanguageString(languageString) {
    const normalizedName = normalizeInjectionName(languageString);
    if (!normalizedName) return null;
    return this.treeSitterGrammarsByInjectionName.get(normalizedName) ?? null;
  }
};

function normalizeInjectionName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function getGrammarSelectionContent(buffer) {
  return buffer.getTextInRange(Range(Point(0, 0), buffer.positionForCharacterIndex(1024)));
}
