const { CompositeDisposable, TextBuffer } = require("atom");
const ProviderConfig = require("./provider-config");
const getAdditionalWordCharacters = require("./get-additional-word-characters");

module.exports = class SubsequenceProvider {
  constructor(options = {}) {
    this.defaults();

    this.subscriptions = new CompositeDisposable();
    this.watchedBuffers = new Map();
    this.documentBuffers = new Set();

    if (options.atomConfig) {
      this.atomConfig = options.atomConfig;
    }

    if (options.atomTextEditors) {
      this.atomTextEditors = options.atomTextEditors;
    }

    this.providerConfig = new ProviderConfig({
      atomConfig: this.atomConfig,
    });

    // make this.X available where X is the autocomplete.X setting
    const settings = [
      "autocomplete.enableExtendedUnicodeSupport", // TODO
      "autocomplete.minimumWordLength",
      "autocomplete.includeCompletionsFromAllBuffers",
      "autocomplete.useLocalityBonus",
      "autocomplete.strictMatching",
    ];
    settings.forEach((property) => {
      this.subscriptions.add(
        this.atomConfig.observe(property, (val) => {
          this[property.split(".")[1]] = val;
        }),
      );
    });

    // Watch every registered editor — pane items and the editors packages
    // register (notebook cells, panel inputs) alike — so their buffers can
    // serve as completion sources.
    this.subscriptions.add(
      this.atomTextEditors.observe((e) => {
        this.watchBuffer(e);
      }),
      this.atomTextEditors.onDidRemoveEditor((e) => {
        this.unwatchBuffer(e);
      }),
    );

    this.configSuggestionsBuffer = new TextBuffer();
  }

  inspect() {
    return `SubsequenceProvider {apiVersion: ${this.apiVersion}}`;
  }

  defaults() {
    this.atomConfig = atom.config;
    this.atomTextEditors = atom.textEditors;

    this.possibleWordCharacters = "/\\()\"':,.;<>~!@#$%^&*|+=[]{}`?_-…".split("");
    this.enableExtendedUnicodeSupport = false;
    this.maxSuggestions = 20;
    this.maxResultsPerBuffer = 20;
    this.maxSearchRowDelta = 3000;

    this.labels = ["workspace-center", "default", "subsequence-provider"];
    this.scopeSelector = "*";
    this.inclusionPriority = 0;
    this.suggestionPriority = 0;

    this.watchedBuffers = null;
    this.documentBuffers = null;
  }

  dispose() {
    return this.subscriptions.dispose();
  }

  watchBuffer(editor) {
    // Mini editors (search fields, one-line inputs) and background editors
    // (e.g. the JSON source backing a notebook) are not completion sources.
    if (editor.isMini() || this.atomTextEditors.roleFor(editor) === "background") {
      return;
    }
    const buffer = editor.getBuffer();

    if (!this.watchedBuffers.has(buffer)) {
      const bufferSubscriptions = new CompositeDisposable();
      bufferSubscriptions.add(
        buffer.onDidDestroy(() => {
          bufferSubscriptions.dispose();
          this.watchedBuffers.delete(buffer);
          this.documentBuffers.delete(buffer);
        }),
      );
    }

    this.watchedBuffers.set(buffer, editor);
    // Editors registered as documents are self-contained: they complete from
    // their own buffer. Fragments (notebook cells, watch expressions) and
    // unregistered editors complete from the whole pool instead.
    if (this.atomTextEditors.roleFor(editor) === "document") {
      this.documentBuffers.add(buffer);
    }
  }

  unwatchBuffer(editor) {
    const buffer = editor.getBuffer();
    if (this.watchedBuffers.get(buffer) !== editor) {
      return;
    }
    // Another registered editor may still expose this buffer (split panes);
    // keep the buffer as a source through it.
    const replacement = this.atomTextEditors
      .getEditors()
      .find(
        (other) =>
          other !== editor &&
          !other.isMini() &&
          this.atomTextEditors.roleFor(other) !== "background" &&
          other.getBuffer() === buffer,
      );
    if (replacement) {
      this.watchedBuffers.set(buffer, replacement);
      if (this.atomTextEditors.roleFor(replacement) === "document") {
        this.documentBuffers.add(buffer);
      } else {
        this.documentBuffers.delete(buffer);
      }
    } else {
      this.watchedBuffers.delete(buffer);
      this.documentBuffers.delete(buffer);
    }
  }

  // This is kind of a hack. We throw the config suggestions in a buffer, so
  // we can use .findWordsWithSubsequence on them.
  configSuggestionsToSubsequenceMatches(suggestions, prefix) {
    if (!suggestions || suggestions.length === 0) {
      return Promise.resolve([]);
    }

    const suggestionText = suggestions
      .map((sug) => sug.displayText || sug.snippet || sug.text)
      .join("\n");

    this.configSuggestionsBuffer.buffer.setText(suggestionText);

    return this.configSuggestionsBuffer
      .findWordsWithSubsequence(prefix, "(){}[] :;,$@%", this.maxResultsPerBuffer)
      .then((matches) => {
        // The findWordsWithSubsequence method will return `null`
        // if the async work was cancelled due to the buffer being
        // mutated since it was enqueued.
        if (matches) {
          for (let k = 0; k < matches.length; k++) {
            matches[k].configSuggestion = suggestions[matches[k].positions[0].row];
          }
        }
        return matches;
      });
  }

  clampedRange(maxDelta, cursorRow, maxRow) {
    const clampedMinRow = Math.max(0, cursorRow - maxDelta);
    const clampedMaxRow = Math.min(maxRow, cursorRow + maxDelta);
    const actualMinRowDelta = cursorRow - clampedMinRow;
    const actualMaxRowDelta = clampedMaxRow - cursorRow;

    return {
      start: {
        row: clampedMinRow - maxDelta + actualMaxRowDelta,
        column: 0,
      },
      end: {
        row: clampedMaxRow + maxDelta - actualMinRowDelta,
        column: 0,
      },
    };
  }

  bufferToSubsequenceMatches(prefix, additionalWordCharacters, currentEditor, buffer) {
    // Non-workspace editors (search fields, watch expressions) aren't tracked
    // in watchedBuffers; their own buffer is searched via the requesting editor.
    const editor =
      this.watchedBuffers.get(buffer) ??
      (buffer === currentEditor.getBuffer() ? currentEditor : null);
    if (!editor) {
      return Promise.resolve([]);
    }
    const position = editor.getCursorBufferPosition();
    const searchRange = this.clampedRange(
      this.maxSearchRowDelta,
      position.row,
      buffer.getEndPosition().row,
    );
    return buffer.findWordsWithSubsequenceInRange(
      prefix,
      additionalWordCharacters,
      this.maxResultsPerBuffer,
      searchRange,
    );
  }

  /*
  Section: Suggesting Completions
  */

  getSuggestions({ editor, bufferPosition: _bufferPosition, prefix, scopeDescriptor }) {
    if (!prefix) {
      return;
    }

    if (prefix.trim().length < this.minimumWordLength) {
      return;
    }

    // Get buffers to search for completions. Only a document editor is
    // self-contained; fragments (notebook cells, watch expressions), inputs
    // (search fields), and unregistered editors hold just a piece of what the
    // user works on, so they complete from all open sources as well.
    const currentEditorBuffer = editor.getBuffer();
    const searchAllBuffers =
      this.includeCompletionsFromAllBuffers || !this.documentBuffers.has(currentEditorBuffer);
    const bufferSet = new Set(searchAllBuffers ? this.watchedBuffers.keys() : []);
    bufferSet.add(currentEditorBuffer);
    const buffers = Array.from(bufferSet);

    const lastCursorPosition = editor.getLastCursor().getBufferPosition();

    const additionalWordCharacters = getAdditionalWordCharacters(scopeDescriptor);

    const configSuggestions = this.providerConfig.getSuggestionsForScopeDescriptor(scopeDescriptor);

    const configMatches = this.configSuggestionsToSubsequenceMatches(configSuggestions, prefix);

    const subsequenceMatchToType = (match) => {
      const matchEditor =
        this.watchedBuffers.get(match.buffer) ??
        (match.buffer === currentEditorBuffer ? editor : null);
      if (!matchEditor) return null;
      const scopeDescriptor = matchEditor.scopeDescriptorForBufferPosition(match.positions[0]);
      return this.providerConfig.scopeDescriptorToType(scopeDescriptor);
    };

    const matchToSuggestion = (match) => {
      return (
        match.configSuggestion || {
          text: match.word,
          type: subsequenceMatchToType(match),
          characterMatchIndices: match.matchIndices,
        }
      );
    };

    const bufferResultsToSuggestions = (matchesByBuffer) => {
      const relevantMatches = [];
      let matchedWords = new Set();
      let match;

      for (let k = 0; k < matchesByBuffer.length; k++) {
        // The findWordsWithSubsequence method will return `null`
        // if the async work was cancelled due to the buffer being
        // mutated since it was enqueued. We return `null` in this
        // case because `getSuggestions` will be called again anyway.
        if (!matchesByBuffer[k]) return null;

        const buffer = buffers[k];
        for (let l = 0; l < matchesByBuffer[k].length; l++) {
          match = matchesByBuffer[k][l];

          if (match.word === prefix) continue;
          if (matchedWords.has(match.word)) continue;
          if (this.strictMatching && match.word.indexOf(prefix) !== 0) continue;

          let matchIsUnderCursor = false;
          if (buffer === currentEditorBuffer && match.score > 0) {
            let closestDistance;
            for (const position of match.positions) {
              const distance = Math.abs(position.row - lastCursorPosition.row);
              if (closestDistance == null || distance < closestDistance) {
                closestDistance = distance;
              }

              if (
                distance === 0 &&
                lastCursorPosition.column >= position.column &&
                lastCursorPosition.column <= position.column + match.word.length
              ) {
                matchIsUnderCursor = true;
                break;
              }
            }

            if (this.useLocalityBonus) {
              match.score += Math.floor(11 / (1 + 0.04 * closestDistance));
            }
          }

          if (matchIsUnderCursor) continue;

          match.buffer = buffer;

          relevantMatches.push(match);
          matchedWords.add(match.word);
        }
      }

      return relevantMatches
        .sort(compareMatches)
        .slice(0, this.maxSuggestions)
        .map(matchToSuggestion);
    };

    return Promise.all(
      buffers
        .map(this.bufferToSubsequenceMatches.bind(this, prefix, additionalWordCharacters, editor))
        .concat(configMatches),
    ).then(bufferResultsToSuggestions);
  }
};

const compareMatches = (a, b) => {
  if (a.score - b.score === 0) {
    return a.word.length - b.word.length;
  }
  return b.score - a.score;
};
