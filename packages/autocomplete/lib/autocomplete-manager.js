const { CompositeDisposable, Disposable, Point, Range } = require("atom");
const path = require("path");

const ProviderManager = require("./provider-manager");
const SuggestionList = require("./suggestion-list");
const { UnicodeLetters } = require("./unicode-helpers");
const getAdditionalWordCharacters = require("./get-additional-word-characters");

const MAX_LEGACY_PREFIX_LENGTH = 80;
const wordCharacterRegexCache = new Map();

const MARKER_LAYERS_FOR_EDITORS = new WeakMap();

function findOrCreateMarkerLayerForEditor(editor) {
  let layer = MARKER_LAYERS_FOR_EDITORS.get(editor);
  if (!layer) {
    layer = editor.addMarkerLayer();
    MARKER_LAYERS_FOR_EDITORS.set(editor, layer);
  }
  return layer;
}

function compareRanges(a, b) {
  let rangeA = Range.fromObject(a);
  let rangeB = Range.fromObject(b);
  return rangeA.compare(rangeB);
}

function sortTextEdits(textEdits) {
  return textEdits.sort((a, b) => compareRanges(a.range, b.range));
}

// Everything a suggestion shows beyond the text it inserts. Two suggestions
// that insert the same text are the same suggestion to a reader only if these
// match as well.
const shownFacetsOf = (suggestion) =>
  [
    suggestion.displayText,
    suggestion.displayTextDetail,
    suggestion.leftLabel,
    suggestion.leftLabelHTML,
    suggestion.rightLabel,
    suggestion.rightLabelHTML,
    suggestion.description,
    suggestion.descriptionMarkdown,
  ]
    .map((facet) => facet ?? "")
    .join("\0");

const describesItselfDistinctly = (suggestion, kept) => {
  const facets = shownFacetsOf(suggestion);
  // Nothing but the insertion itself: a bare word, safe to drop behind a
  // suggestion that inserts the same thing.
  if (!facets.replaceAll("\0", "")) return false;
  return facets !== shownFacetsOf(kept);
};

// LSP `InsertTextMode`: 1 leaves the inserted text exactly as the provider
// wrote it, 2 re-indents it to match the line it lands on.
const INSERT_TEXT_MODE_AS_IS = 1;
const INSERT_TEXT_MODE_ADJUST_INDENTATION = 2;

// How long confirming waits for a provider's in-flight detail request before
// inserting what it already has. Long enough for a warm language server to
// answer with its auto-import edits, short enough not to feel like lag.
const DETAILS_TIMEOUT_MS = 200;

// Why a provider is being asked for suggestions, numbered as LSP's
// `CompletionTriggerKind`. Autocomplete raises these two; the third,
// `3` — a re-request of a list the provider itself marked incomplete — is
// raised by the provider, which is the only side that knows about it.
const TRIGGER_INVOKED = 1;
const TRIGGER_CHARACTER = 2;

// How well a suggestion answers what the user typed. Ranking by tier first
// keeps a literal prefix match above a scattered subsequence one, which a
// single blended score cannot guarantee.
const MATCH_EXACT_PREFIX = 3;
const MATCH_PREFIX = 2;
const MATCH_SUBSEQUENCE = 1;

// What the typed prefix is matched against. `filterText` wins where a provider
// supplies one (the LSP field for exactly this), then the visible label, and
// only then the inserted text. Scoring the raw snippet body, as this used to,
// matched placeholder names like `${1:name}` rather than the snippet's prefix.
const matchTextFor = (suggestion) =>
  suggestion.filterText || suggestion.displayText || suggestion.text || suggestion.snippet || "";

const matchTierFor = (text, prefix) => {
  if (text.startsWith(prefix)) return MATCH_EXACT_PREFIX;
  if (text.toLowerCase().startsWith(prefix.toLowerCase())) return MATCH_PREFIX;
  return MATCH_SUBSEQUENCE;
};

// Tier, then the provider's own preference (`sortText`, which LSP servers use
// to express relevance), then match strength, then original order. The user's
// typing always outranks the server's opinion; the server decides among items
// that match it equally well.
const compareSuggestions = (a, b) => {
  if (a.matchTier !== b.matchTier) return b.matchTier - a.matchTier;
  if (a.sortText != null || b.sortText != null) {
    const left = a.sortText ?? "";
    const right = b.sortText ?? "";
    // Compared as opaque strings, per the LSP spec — not by locale.
    if (left !== right) return left < right ? -1 : 1;
  }
  if (a.score !== b.score) return b.score - a.score;
  return a.sortIndex - b.sortIndex;
};

// Deferred requires
let picomatch = null;

module.exports = class AutocompleteManager {
  constructor() {
    this.autosaveEnabled = false;
    this.backspaceTriggersAutocomplete = true;
    this.autoConfirmSingleSuggestionEnabled = true;
    this.bracketMatcherPairs = ["()", "[]", "{}", '""', "''", "``", "“”", "‘’", "«»", "‹›"];
    this.buffer = null;
    this.compositionInProgress = false;
    this.disposed = false;
    this.editor = null;
    this.editorLabels = null;
    this.editorSubscriptions = null;
    this.editorView = null;
    this.providerManager = null;
    this.ready = false;
    this.subscriptions = null;
    this.suggestionList = null;
    this.suppressForClasses = [];
    this.shouldDisplaySuggestions = false;
    // The character that opened the list on the last buffer change, when a
    // provider declared it as a trigger. Handed to `getSuggestions`.
    this.triggerCharacter = null;
    // Set while a commit character is being applied. The undo, the insertion
    // and the re-typed character it makes are our own edits, and must not be
    // read back as the user typing.
    this.confirmingCommitCharacter = false;
    this.prefixRegex = null;
    this.wordPrefixRegex = null;
    this.updateCurrentEditor = this.updateCurrentEditor.bind(this);
    this.handleCommands = this.handleCommands.bind(this);
    this.findSuggestions = this.findSuggestions.bind(this);
    this.getSuggestionsFromProviders = this.getSuggestionsFromProviders.bind(this);
    this.displaySuggestions = this.displaySuggestions.bind(this);
    this.hideSuggestionList = this.hideSuggestionList.bind(this);

    this.showOrHideSuggestionListForBufferChanges =
      this.showOrHideSuggestionListForBufferChanges.bind(this);
    this.providerManager = new ProviderManager();
    this.suggestionList = new SuggestionList();
    this.watchedEditors = new WeakSet();
    // In-flight `getSuggestionDetailsOnSelect` results, so confirming can wait
    // for the detail a provider is still fetching.
    this.pendingDetails = new WeakMap();
  }

  initialize() {
    this.subscriptions = new CompositeDisposable();

    this.providerManager.initialize();
    this.suggestionList.initialize();

    this.subscriptions.add(
      atom.config.observe(
        "autocomplete.enableExtendedUnicodeSupport",
        (enableExtendedUnicodeSupport) => {
          if (enableExtendedUnicodeSupport) {
            this.prefixRegex = new RegExp(
              `(['"~\`!@#\\$%^&*\\(\\)\\{\\}\\[\\]=+,/\\?>])?(([${UnicodeLetters}\\d_]+[${UnicodeLetters}\\d_-]*)|([.:;[{(< ]+))$`,
            );
            this.wordPrefixRegex = new RegExp(
              `^[${UnicodeLetters}\\d_]+[${UnicodeLetters}\\d_-]*$`,
            );
          } else {
            this.prefixRegex = /(\b|['"~`!@#$%^&*(){}[\]=+,/?>])((\w+[\w-]*)|([.:;[{(< ]+))$/;
            this.wordPrefixRegex = /^\w+[\w-]*$/;
          }
        },
      ),
    );
    this.subscriptions.add(this.providerManager);
    this.handleEvents();
    this.handleCommands();
    this.subscriptions.add(this.suggestionList); // We're adding this last so it is disposed after events
    this.ready = true;
  }

  setSnippetsManager(snippetsManager) {
    this.snippetsManager = snippetsManager;
  }

  updateCurrentEditor(currentEditor, labels) {
    if (currentEditor === this.editor) {
      return;
    }
    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;

    // Stop tracking editor + buffer
    this.editor = null;
    this.editorView = null;
    this.buffer = null;
    this.markerLayer = null;
    this.isCurrentFileBlackListedCache = null;

    if (!this.editorIsValid(currentEditor)) {
      return;
    }

    // Track the new editor, editorView, and buffer and set
    // the labels for its providers.
    this.editor = currentEditor;
    this.editorLabels = labels;
    this.editorView = atom.views.getView(this.editor);
    this.buffer = this.editor.getBuffer();
    this.markerLayer = findOrCreateMarkerLayerForEditor(this.editor);

    this.editorSubscriptions = new CompositeDisposable();

    // Subscribe to buffer events:
    this.editorSubscriptions.add(
      this.buffer.onDidSave((e) => {
        this.bufferSaved(e);
      }),
    );
    this.editorSubscriptions.add(
      this.buffer.onDidChangeText(this.showOrHideSuggestionListForBufferChanges),
    );

    // Watch IME Events To Allow IME To Function Without The Suggestion List Showing
    const compositionStart = () => {
      this.compositionInProgress = true;
    };
    const compositionEnd = () => {
      this.compositionInProgress = false;
    };

    this.editorView.addEventListener("compositionstart", compositionStart);
    this.editorView.addEventListener("compositionend", compositionEnd);
    this.editorSubscriptions.add(
      new Disposable(() => {
        if (this.editorView) {
          this.editorView.removeEventListener("compositionstart", compositionStart);
          this.editorView.removeEventListener("compositionend", compositionEnd);
        }
      }),
    );

    // Subscribe to editor events:
    // Close the overlay when the cursor moved without changing any text
    this.editorSubscriptions.add(
      this.editor.onDidChangeCursorPosition((e) => {
        this.cursorMoved(e);
      }),
    );
    return this.editorSubscriptions.add(
      this.editor.onDidChangePath(() => {
        this.isCurrentFileBlackListedCache = null;
      }),
    );
  }

  editorIsValid(editor) {
    return atom.workspace.isTextEditor(editor);
  }

  // Makes the autocomplete manager watch the `editor`.
  // When the watched `editor` is focused, it will provide autocompletions from
  // providers with the given `labels`.
  //
  // Returns a {Disposable} to stop watching the `editor`.
  watchEditor(editor, labels) {
    if (this.watchedEditors.has(editor)) return;

    let view = atom.views.getView(editor);

    if (view.hasFocus()) {
      this.updateCurrentEditor(editor, labels);
    }

    let focusListener = (_element) => this.updateCurrentEditor(editor, labels);
    view.addEventListener("focus", focusListener);
    let blurListener = (_element) => this.hideSuggestionList();
    view.addEventListener("blur", blurListener);

    let disposable = new Disposable(() => {
      view.removeEventListener("focus", focusListener);
      view.removeEventListener("blur", blurListener);
      if (this.editor === editor) {
        this.updateCurrentEditor(null);
      }
    });
    this.watchedEditors.add(editor);
    this.subscriptions.add(disposable);
    return new Disposable(() => {
      disposable.dispose();
      if (this.subscriptions != null) {
        this.subscriptions.remove(disposable);
      }
      this.watchedEditors.delete(editor);
    });
  }

  handleEvents() {
    this.subscriptions.add(
      atom.workspace.observeTextEditors((editor) => {
        const disposable = this.watchEditor(editor, ["workspace-center"]);
        editor.onDidDestroy(() => disposable.dispose());
      }),
    );

    // Watch config values
    this.subscriptions.add(
      atom.config.observe("autosave.enabled", (value) => {
        this.autosaveEnabled = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe("autocomplete.backspaceTriggersAutocomplete", (value) => {
        this.backspaceTriggersAutocomplete = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe("autocomplete.enableAutoActivation", (value) => {
        this.autoActivationEnabled = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe("autocomplete.enableAutoConfirmSingleSuggestion", (value) => {
        this.autoConfirmSingleSuggestionEnabled = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe("autocomplete.consumeSuffix", (value) => {
        this.consumeSuffix = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe("autocomplete.fileBlacklist", (value) => {
        if (value) {
          this.fileBlacklist = value.map((s) => {
            return s.trim();
          });
        }
        this.isCurrentFileBlackListedCache = null;
      }),
    );
    this.subscriptions.add(
      atom.config.observe("autocomplete.suppressActivationForEditorClasses", (value) => {
        this.suppressForClasses = [];
        for (let i = 0; i < value.length; i++) {
          const selector = value[i];
          const classes = selector
            .trim()
            .split(".")
            .filter((className) => className.trim())
            .map((className) => className.trim());
          if (classes.length) {
            this.suppressForClasses.push(classes);
          }
        }
      }),
    );

    // Handle events from suggestion list
    this.subscriptions.add(
      this.suggestionList.onDidConfirm((e) => {
        this.confirm(e);
      }),
    );
    this.subscriptions.add(this.suggestionList.onDidCancel(this.hideSuggestionList));
    this.subscriptions.add(
      this.suggestionList.onDidSelect((suggestion) => {
        this.getDetailsOnSelect(suggestion);
      }),
    );
  }

  handleCommands() {
    return this.subscriptions.add(
      atom.commands.add("atom-text-editor", {
        "autocomplete:activate": (event) => {
          this.shouldDisplaySuggestions = true;
          let activatedManually = true;
          if (
            event.detail &&
            event.detail.activatedManually !== null &&
            typeof event.detail.activatedManually !== "undefined"
          ) {
            activatedManually = event.detail.activatedManually;
          }
          this.findSuggestions(activatedManually);
        },
        "autocomplete:navigate-to-description-more-link": () => {
          let suggestionListView = atom.views.getView(this.editor);
          let descriptionContainer = suggestionListView.querySelector(".suggestion-description");
          if (descriptionContainer !== null && descriptionContainer.style.display === "block") {
            let descriptionMoreLink = descriptionContainer.querySelector(
              ".suggestion-description-more-link",
            );
            atom.openExternal(descriptionMoreLink.href);
          }
        },
      }),
    );
  }

  // Private: Finds suggestions for the current prefix, sets the list items,
  // positions the overlay and shows it
  findSuggestions(activatedManually) {
    if (this.disposed) {
      return;
    }
    if (this.providerManager == null || this.editor == null || this.buffer == null) {
      return;
    }
    if (this.isCurrentFileBlackListed()) {
      return;
    }
    const cursor = this.editor.getLastCursor();
    if (cursor == null) {
      return;
    }

    const bufferPosition = cursor.getBufferPosition();
    const scopeDescriptor = cursor.getScopeDescriptor();
    const prefix = this.getPrefix(this.editor, bufferPosition, scopeDescriptor); // Passed to providers with API version >= 4.0.0
    const legacyPrefix = this.getLegacyPrefix(this.editor, bufferPosition); // Passed to providers with API version < 4.0.0

    return this.getSuggestionsFromProviders({
      editor: this.editor,
      bufferPosition,
      scopeDescriptor,
      prefix,
      legacyPrefix,
      activatedManually,
    });
  }

  getSuggestionsFromProviders(options) {
    let suggestionsPromise;
    const providers = this.providerManager.applicableProviders(
      this.editorLabels,
      options.scopeDescriptor,
    );

    // Asking for the menu by hand is an invocation whatever was typed last.
    const triggerCharacter = options.activatedManually ? null : this.triggerCharacter;

    const providerPromises = [];
    providers.forEach((provider) => {
      const getSuggestions = provider.getSuggestions.bind(provider);
      const upgradedOptions = Object.assign({}, options);
      delete upgradedOptions.legacyPrefix;
      // Told rather than inferred: a provider used to have to re-read the
      // buffer to work out which of its trigger characters had fired.
      upgradedOptions.triggerKind = triggerCharacter ? TRIGGER_CHARACTER : TRIGGER_INVOKED;
      upgradedOptions.triggerCharacter = triggerCharacter;

      return providerPromises.push(
        Promise.resolve(getSuggestions(upgradedOptions)).then((providerSuggestions) => {
          if (providerSuggestions == null) {
            return;
          }

          let hasEmpty = false; // Optimization: only create another array when there are empty items
          for (let i = 0; i < providerSuggestions.length; i++) {
            const suggestion = providerSuggestions[i];
            if (!suggestion.snippet && !suggestion.text) {
              hasEmpty = true;
            }
            // Suggestions are mutable and are updated with a new replacement prefix. In order to
            // distinguish between suggestion that had original prefix and assigned one, we use
            // `isPrefixModified` flag. If it is `true`, we reset replacement prefix.
            if (suggestion.replacementPrefix == null || !!suggestion.isPrefixModified) {
              suggestion.replacementPrefix = options.prefix;
              suggestion.isPrefixModified = true;
            }
            suggestion.provider = provider;
          }

          if (hasEmpty) {
            const res = [];
            for (const s of providerSuggestions) {
              if (s.snippet || s.text) {
                res.push(s);
              }
            }
            providerSuggestions = res;
          }

          if (provider.filterSuggestions) {
            providerSuggestions = this.filterSuggestions(providerSuggestions, options);
          }
          return providerSuggestions;
        }),
      );
    });

    if (!providerPromises || !providerPromises.length) {
      return;
    }

    suggestionsPromise = Promise.all(providerPromises);
    this.currentSuggestionsPromise = suggestionsPromise;
    return this.currentSuggestionsPromise
      .then(this.mergeSuggestionsFromProviders)
      .then((suggestions) => {
        if (this.currentSuggestionsPromise !== suggestionsPromise) {
          return;
        }
        if (
          options.activatedManually &&
          this.shouldDisplaySuggestions &&
          this.autoConfirmSingleSuggestionEnabled &&
          suggestions.length === 1
        ) {
          // When there is one suggestion in manual mode, just confirm it. The
          // list is never shown, so `did-select` never fires — ask for the
          // detail explicitly or this path silently skips resolution.
          this.getDetailsOnSelect(suggestions[0]);
          return this.confirm(suggestions[0]);
        } else {
          return this.displaySuggestions(suggestions, options);
        }
      });
  }

  filterSuggestions(suggestions, { prefix }) {
    const results = [];

    // Legacy behavior: filtering used to include a "sanity check" that ensured
    // the first character of the suggestion matched the first character of the
    // input.
    //
    // The original intent of this decision is not known, but it aged poorly,
    // especially as autocompletion suggestions got more sophisticated and grew
    // the ability to trigger arbitrary text edits instead of just adding
    // characters to what had been typed.
    //
    // We envision this will eventually go away altogether, but as an
    // intermediate step, we've turned it into an option that is `false` by
    // default.
    let firstCharacterMustMatch = atom.config.get("autocomplete.firstCharacterMustMatch");

    // Scored in batches rather than one call per suggestion: `score()` builds a
    // fresh native matcher every time, which on the ~1000-item list a language
    // server returns for a global scope costs about 4 ms of every keystroke
    // against 0.6 ms for the batch API. Suggestions are grouped by the prefix
    // they are matched against, since a provider may give each its own.
    const groups = new Map();
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      // Ties fall back to the order the provider supplied them in.
      suggestion.sortIndex = i;
      suggestion.score = 0;
      suggestion.matchTier = MATCH_SUBSEQUENCE;

      const suggestionPrefix =
        suggestion.replacementPrefix != null ? suggestion.replacementPrefix : prefix;
      const prefixIsEmpty = !suggestionPrefix || suggestionPrefix === " ";

      // Nothing typed yet, so nothing to rank by: keep the provider's order.
      // `ranges` replaces arbitrary spans of the buffer, so the typed prefix
      // says nothing about whether the suggestion applies. A `textEdit` is
      // different — it replaces the word being typed, so the prefix is exactly
      // the right thing to filter on, and exempting it (as this used to) meant
      // an LSP list was never filtered at all.
      if (prefixIsEmpty || suggestion.ranges) {
        results.push(suggestion);
        continue;
      }

      const group = groups.get(suggestionPrefix);
      if (group) group.push(suggestion);
      else groups.set(suggestionPrefix, [suggestion]);
    }

    for (const [suggestionPrefix, group] of groups) {
      const texts = group.map(matchTextFor);
      // `match` returns only the candidates that scored above zero, each
      // carrying the index of the candidate it came from.
      const matches = atom.tools.fuzzyMatcher.setCandidates(texts).match(suggestionPrefix);
      for (const match of matches) {
        const text = texts[match.id];
        if (
          firstCharacterMustMatch &&
          text[0]?.toLowerCase() !== suggestionPrefix[0].toLowerCase()
        ) {
          continue;
        }
        const suggestion = group[match.id];
        suggestion.score = match.score;
        suggestion.matchTier = matchTierFor(text, suggestionPrefix);
        results.push(suggestion);
      }
    }

    results.sort(compareSuggestions);
    return results;
  }

  // providerSuggestions - array of arrays of suggestions provided by all called providers
  mergeSuggestionsFromProviders(providerSuggestions) {
    return providerSuggestions.reduce((suggestions, providerSuggestions) => {
      if (providerSuggestions && providerSuggestions.length) {
        suggestions = suggestions.concat(providerSuggestions);
      }

      return suggestions;
    }, []);
  }

  displaySuggestions(suggestions, options) {
    switch (atom.config.get("autocomplete.similarSuggestionRemoval")) {
      case "textOrSnippet": {
        suggestions = this.removeRedundantSuggestions(suggestions);
        break;
      }
    }

    if (this.shouldDisplaySuggestions && suggestions.length) {
      return this.showSuggestionList(suggestions, options);
    } else {
      return this.hideSuggestionList();
    }
  }

  // Drops a suggestion that inserts the same text as one already in the list
  // and tells the user nothing the first one does not — a buffer word standing
  // behind a real completion of the same name.
  //
  // Matching on the inserted text alone is not enough: the same symbol
  // auto-imported from two different modules inserts identical text and
  // differs only in its label and the import it brings. Collapsing those would
  // silently pick a module for the user, so anything that describes itself
  // differently is kept.
  removeRedundantSuggestions(suggestions) {
    const keptByText = new Map();
    const result = [];
    for (const suggestion of suggestions) {
      const key = `${suggestion.text ?? ""}\0${suggestion.snippet ?? ""}`;
      const kept = keptByText.get(key);
      if (kept && !describesItselfDistinctly(suggestion, kept)) {
        continue;
      }
      if (!kept) {
        keptByText.set(key, suggestion);
      }
      result.push(suggestion);
    }
    return result;
  }

  getPrefix(editor, position, scopeDescriptor) {
    const wordCharacterRegex = this.getWordCharacterRegex(scopeDescriptor);
    const line = editor.getBuffer().getTextInRange([[position.row, 0], position]);

    let startColumn = position.column;
    while (startColumn > 0) {
      let prevChar = line[startColumn - 1];
      if (wordCharacterRegex.test(prevChar)) {
        startColumn--;
      } else {
        break;
      }
    }
    return line.slice(startColumn);
  }

  getWordCharacterRegex(scopeDescriptor) {
    const additionalWordChars = getAdditionalWordCharacters(scopeDescriptor);
    let regex = wordCharacterRegexCache.get(additionalWordChars);

    if (!regex) {
      regex = new RegExp(`[${UnicodeLetters}${additionalWordChars.replace("]", "\\]")}\\d]`);
      wordCharacterRegexCache.set(additionalWordChars, regex);
    }
    return regex;
  }

  getLegacyPrefix(editor, bufferPosition) {
    const { row, column } = bufferPosition;
    const line = editor.getTextInRange(
      new Range(new Point(row, Math.max(0, column - MAX_LEGACY_PREFIX_LENGTH)), bufferPosition),
    );
    const prefix = this.prefixRegex.exec(line);
    if (!prefix || !prefix[2] || prefix[2].length === MAX_LEGACY_PREFIX_LENGTH) return "";
    return prefix[2];
  }

  // Private: Gets called when the user successfully confirms a suggestion
  //
  // match - An {Object} representing the confirmed suggestion
  confirm(suggestion) {
    if (this.editor == null || suggestion == null || !!this.disposed) {
      return;
    }

    const triggerPosition = this.editor.getLastCursor().getBufferPosition();
    const pending = this.pendingDetails.get(suggestion);

    // Stay synchronous unless a provider actually has detail in flight. Most
    // providers implement no `getSuggestionDetailsOnSelect` at all, and
    // deferring their insertion by a microtask changes observable behavior for
    // no benefit.
    if (!pending) {
      return this.insertSuggestion(suggestion, triggerPosition);
    }

    // Wait for the detail *before* hiding the list. `hideSuggestionList`
    // empties the model, after which a late `replaceItem` is dropped on the
    // floor — so resolving afterwards would silently discard the very edits
    // (auto-imports) we are waiting for.
    return this.awaitDetails(suggestion, pending).then((resolved) => {
      if (this.editor == null || !!this.disposed) {
        return;
      }
      this.insertSuggestion(resolved, triggerPosition);
    });
  }

  insertSuggestion(resolved, triggerPosition) {
    const selections = this.editor.getSelections();
    if (selections && selections.length) {
      for (const s of selections) {
        if (s && s.clear) {
          s.clear();
        }
      }
    }

    this.hideSuggestionList();

    this.replaceTextWithMatch(resolved);

    if (resolved.provider && resolved.provider.onDidInsertSuggestion) {
      resolved.provider.onDidInsertSuggestion({
        editor: this.editor,
        suggestion: resolved,
        triggerPosition,
      });
    }
  }

  // Resolves to the detailed suggestion when the provider answers in time, and
  // to the original otherwise: a slow provider may delay insertion briefly but
  // must never block it.
  awaitDetails(suggestion, pending) {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(suggestion), DETAILS_TIMEOUT_MS);
    });
    return Promise.race([pending, deadline]).then((result) => {
      if (timer) {
        clearTimeout(timer);
      }
      return result || suggestion;
    });
  }

  getDetailsOnSelect(suggestion) {
    if (
      suggestion != null &&
      suggestion.provider &&
      suggestion.provider.getSuggestionDetailsOnSelect
    ) {
      const pending = Promise.resolve(suggestion.provider.getSuggestionDetailsOnSelect(suggestion))
        .then((detailedSuggestion) => {
          this.suggestionList.replaceItem(suggestion, detailedSuggestion);
          return detailedSuggestion || suggestion;
        })
        // A provider failing to resolve detail must not prevent insertion.
        .catch(() => suggestion);
      this.pendingDetails.set(suggestion, pending);
      return pending;
    }
  }

  showSuggestionList(suggestions, options) {
    if (this.disposed) {
      return;
    }
    this.suggestionList.changeItems(suggestions);
    return this.suggestionList.show(this.editor, options);
  }

  hideSuggestionList() {
    if (this.disposed) {
      return;
    }
    this.suggestionList.changeItems(null);
    this.suggestionList.hide();
    this.shouldDisplaySuggestions = false;
  }

  requestHideSuggestionList(_command) {
    if (this.hideTimeout == null) {
      this.hideTimeout = setTimeout(() => {
        this.hideSuggestionList();
        this.hideTimeout = null;
      }, 0);
    }
    this.shouldDisplaySuggestions = false;
  }

  cancelHideSuggestionListRequest() {
    clearTimeout(this.hideTimeout);
    this.hideTimeout = null;
  }

  // Private: Applies a `TextEdit` to the given editor.
  applyTextEdit(textEdit, isSnippet = false, insertTextMode = undefined) {
    if (this.editor === null) return;
    let range = Range.fromObject(textEdit.range ?? textEdit.oldRange);
    if (isSnippet && this.snippetsManager) {
      // Snippet expansion drives the cursor through its tab stops, so it only
      // makes sense at one place: the other cursors keep what they had.
      let selection = this.editor.getLastSelection();
      let cursor = selection.cursor;
      selection.setBufferRange(range);
      this.snippetsManager.insertSnippet(textEdit.newText, this.editor, cursor, {
        adjustIndentation: insertTextMode !== INSERT_TEXT_MODE_AS_IS,
      });
    } else {
      for (const editRange of this.textEditRangesForCursors(range)) {
        const inserted = this.editor.setTextInBufferRange(editRange, textEdit.newText);
        // Plain text carries no tab stops, so nothing re-indents it unless
        // asked. Only worth doing for an edit that spans lines.
        if (
          insertTextMode === INSERT_TEXT_MODE_ADJUST_INDENTATION &&
          inserted.start.row !== inserted.end.row
        ) {
          this.editor.autoIndentBufferRows(inserted.start.row + 1, inserted.end.row);
        }
      }
    }
  }

  // A completion's edit range covers the word being typed and ends at the
  // cursor it was requested for, so the same span — the same number of
  // characters either side — is what every other cursor wants replaced.
  // Without this an edit landed once and the other cursors kept their prefix.
  textEditRangesForCursors(range) {
    const cursors = this.editor.getCursors();
    if (cursors.length < 2) return [range];

    const origin = this.editor.getLastCursor().getBufferPosition();
    // Only cursors on the same row as the edit can be offset this way; a
    // multi-row edit is not a prefix replacement and is left alone.
    if (range.start.row !== origin.row || range.end.row !== origin.row) return [range];

    const before = origin.column - range.start.column;
    const after = range.end.column - origin.column;
    return (
      cursors
        .map((cursor) => cursor.getBufferPosition())
        // Later rows first, so an earlier edit cannot shift a range still to be
        // applied. Cursors sharing a row are handled right-to-left for the same
        // reason.
        .sort((a, b) => b.compare(a))
        .map((position) =>
          Range.fromObject([
            [position.row, Math.max(0, position.column - before)],
            [position.row, position.column + after],
          ]),
        )
    );
  }

  // Private: Replaces the current prefix with the given match.
  //
  // match - The match to replace the current prefix with
  replaceTextWithMatch(suggestion) {
    if (this.editor == null) {
      return;
    }

    const cursors = this.editor.getCursors();
    if (cursors == null) {
      return;
    }

    return this.editor.transact(() => {
      // Guard against any stray display markers somehow still being on the
      // layer.
      this.markerLayer.clear();

      let additionalTextEditMarkers = null;
      if (suggestion.additionalTextEdits) {
        let textEdits = sortTextEdits(Array.from(suggestion.additionalTextEdits));
        additionalTextEditMarkers = [];

        // We could apply all the `TextEdit`s at once, but we'd have to find a
        // way to express the default insertion strategy (with consideration of
        // prefix) as a `TextEdit`, since `additionalTextEdits` is valid no
        // matter the insertion strategy.
        //
        // So we won't do that; we'll apply the main edit first. But that means
        // we must now guard against their buffer ranges changing after the
        // edit, so we'll track any change in their buffer ranges with display
        // markers.
        for (let textEdit of textEdits) {
          let range = Range.fromObject(textEdit.range ?? textEdit.oldRange);
          let marker = this.markerLayer.markBufferRange(range);
          additionalTextEditMarkers.push([marker, textEdit]);
        }
      }

      if (suggestion.textEdit) {
        // Suggestion wants to apply a `TextEdit` in order to insert itself.
        // This occurs instead of the default text insertion strategy. Sort
        // them in buffer order, then apply them in reverse order (so that no
        // buffer position is affected by any other edits).
        //
        // In LSP, the format of the inserted text can be either plain text or
        // snippet; the format is indicated on the suggestion itself. We
        // already have a `snippet` property that we can reuse for this purpose
        // in a way that's rather backward-compatible. If `snippet` is truthy,
        // we'll assume ourselves to be in snippet mode.
        this.applyTextEdit(suggestion.textEdit, !!suggestion.snippet, suggestion.insertTextMode);
      } else if (suggestion.ranges) {
        // Suggestion wants to insert the default text over one or more
        // specific ranges. This occurs instead of the default text insertion
        // strategy. The same text is inserted into each range. Sort the ranges
        // in buffer order, then apply the edits in reverse order (so that
        // no buffer position is affected by any other edits).
        let ranges = Array.from(suggestion.ranges).sort(compareRanges);
        for (let i = ranges.length - 1; i >= 0; i--) {
          const range = Range.fromObject(ranges[i]);
          this.editor.setTextInBufferRange(range, suggestion.text ?? suggestion.snippet);
        }
      } else {
        // Default text insertion strategy: insert the text or snippet,
        // possibly correcting for characters that might already have been
        // typed.
        for (let i = 0; i < cursors.length; i++) {
          const cursor = cursors[i];
          const endPosition = cursor.getBufferPosition();
          const beginningPosition = [
            endPosition.row,
            endPosition.column - suggestion.replacementPrefix.length,
          ];

          if (
            this.editor.getTextInBufferRange([beginningPosition, endPosition]) ===
            suggestion.replacementPrefix
          ) {
            const suffix = this.consumeSuffix
              ? this.getSuffix(this.editor, endPosition, suggestion)
              : "";
            if (suffix.length) {
              cursor.moveRight(suffix.length);
            }
            cursor.selection.selectLeft(suggestion.replacementPrefix.length + suffix.length);

            if (suggestion.snippet != null && this.snippetsManager != null) {
              this.snippetsManager.insertSnippet(suggestion.snippet, this.editor, cursor);
            } else {
              cursor.selection.insertText(
                suggestion.text != null ? suggestion.text : suggestion.snippet,
                {
                  autoIndentNewline: this.editor.shouldAutoIndent(),
                  autoDecreaseIndent: this.editor.shouldAutoIndent(),
                },
              );
            }
          }
        }
      }

      // Alongside any of these insertion strategies, a suggestion can specify
      // additional text edits that should be made. These are typically
      // optional.
      //
      // One example might be auto-inserting an import/include statement when a
      // suggestion from a specific library is inserted (and the library is not
      // already included into the buffer).
      //
      // The buffer positions we originally received might be inaccurate now,
      // because we've changed the buffer since we received these suggestions.
      // That's why we marked the buffer ranges before we made this edit.
      if (additionalTextEditMarkers) {
        for (let i = additionalTextEditMarkers.length - 1; i >= 0; i--) {
          let [marker, textEdit] = additionalTextEditMarkers[i];

          // Now that a suggestion can contain any number of arbitrary text
          // edits, there are some basic sanity rules expected from
          // autocompletion providers. As the LSP spec says: "Edits must not
          // overlap (including the same insert position) with the main edit
          // nor with themselves."
          //
          // Hence this could only happen if the provider were behaving
          // incorrectly, but we'll check for it anyway.
          if (!marker.isValid()) continue;

          let newTextEdit = {
            newText: textEdit.newText,
            range: marker.getBufferRange(),
          };
          // Unlike the main text inserted by the suggestion, additional text
          // edits are applied non-interactively. Hence it only makes sense to
          // apply them as plain text rather than snippets.
          this.applyTextEdit(newTextEdit, false);
        }
        // We're done with these markers. We only needed them for a moment so
        // we could track any content shifts.
        this.markerLayer.clear();
      }
    });
  }

  getSuffix(editor, bufferPosition, suggestion) {
    // This just chews through the suggestion and tries to match the suggestion
    // substring with the lineText starting at the cursor. There is probably a
    // more efficient way to do this.
    let suffix = suggestion.snippet != null ? suggestion.snippet : suggestion.text;
    const endPosition = [bufferPosition.row, bufferPosition.column + suffix.length];
    const endOfLineText = editor.getTextInBufferRange([bufferPosition, endPosition]);
    // Scoped, like every other read of this setting: what counts as a word
    // character is the language's business, and reading the global value here
    // let the prefix and the suffix disagree about the same character.
    const nonWordCharacters = new Set(
      atom.config
        .get("language.nonWordCharacters", {
          scope: editor.scopeDescriptorForBufferPosition(bufferPosition),
        })
        .split(""),
    );
    while (suffix) {
      if (endOfLineText.startsWith(suffix) && !nonWordCharacters.has(suffix[0])) {
        break;
      }
      suffix = suffix.slice(1);
    }
    return suffix;
  }

  // Private: Checks whether the current file is blacklisted.
  //
  // Returns {Boolean} that defines whether the current file is blacklisted
  isCurrentFileBlackListed() {
    // Glob matching is slow. Not necessary to do this computation on every request for suggestions
    let left;
    if (this.isCurrentFileBlackListedCache != null) {
      return this.isCurrentFileBlackListedCache;
    }

    if (this.fileBlacklist == null || this.fileBlacklist.length === 0) {
      this.isCurrentFileBlackListedCache = false;
      return this.isCurrentFileBlackListedCache;
    }

    if (picomatch == null) {
      picomatch = require("picomatch");
    }
    const fileName = path.basename((left = this.buffer.getPath()) != null ? left : "");
    for (let i = 0; i < this.fileBlacklist.length; i++) {
      const blacklistGlob = this.fileBlacklist[i];
      if (picomatch.isMatch(fileName, blacklistGlob)) {
        this.isCurrentFileBlackListedCache = true;
        return this.isCurrentFileBlackListedCache;
      }
    }

    this.isCurrentFileBlackListedCache = false;
    return this.isCurrentFileBlackListedCache;
  }

  // Private: Gets called when the content has been modified
  requestNewSuggestions() {
    let delay = atom.config.get("autocomplete.autoActivationDelay");

    if (this.delayTimeout != null) {
      clearTimeout(this.delayTimeout);
    }

    if (delay) {
      this.delayTimeout = setTimeout(this.findSuggestions, delay);
    } else {
      this.findSuggestions();
    }

    this.shouldDisplaySuggestions = true;
  }

  cancelNewSuggestionsRequest() {
    if (this.delayTimeout != null) {
      clearTimeout(this.delayTimeout);
    }
    this.shouldDisplaySuggestions = false;
  }

  // Private: Gets called when the cursor has moved. Cancels the autocompletion if
  // the text has not been changed.
  //
  // data - An {Object} containing information on why the cursor has been moved
  cursorMoved({ textChanged }) {
    // The delay is a workaround for the backspace case. The way atom implements
    // backspace is to select left 1 char, then delete. This results in a
    // cursorMoved event with textChanged == false. So we delay, and if the
    // bufferChanged handler decides to show suggestions, it will cancel the
    // hideSuggestionList request. If there is no bufferChanged event,
    // suggestionList will be hidden.
    if (!textChanged) this.requestHideSuggestionList();
  }

  // Private: Gets called when the user saves the document. Cancels the
  // autocompletion.
  bufferSaved() {
    if (!this.autosaveEnabled) {
      return this.hideSuggestionList();
    }
  }

  showOrHideSuggestionListForBufferChanges({ changes }) {
    if (this.disposed) return;
    // Our own edits, not the user's.
    if (this.confirmingCommitCharacter) return;

    const lastCursorPosition = this.editor.getLastCursor().getBufferPosition();
    const changeOccurredNearLastCursor = changes.some(({ newRange }) => {
      return newRange.containsPoint(lastCursorPosition);
    });
    if (!changeOccurredNearLastCursor) return;

    const insertedCharacter = this.insertedCharacterForChanges(changes);

    const commitSuggestion = this.suggestionForCommitCharacter(insertedCharacter);
    if (commitSuggestion) {
      this.triggerCharacter = null;
      this.confirmWithCommitCharacter(commitSuggestion, insertedCharacter, changes[0].newRange);
      return;
    }

    this.triggerCharacter = this.isTriggerCharacter(insertedCharacter) ? insertedCharacter : null;

    // A declared trigger character opens the list on its own terms, so a
    // language server still answers `.` when suggestions on keystroke are off.
    let shouldActivate = this.triggerCharacter != null;
    if (
      !shouldActivate &&
      (this.autoActivationEnabled ||
        (this.suggestionList.isActive() && !this.compositionInProgress))
    ) {
      shouldActivate = changes.some(({ oldText, newText }) => {
        if (this.autoActivationEnabled || this.suggestionList.isActive()) {
          if (newText.length > 0) {
            // Activate on space, a non-whitespace character, or a bracket-matcher pair.
            if (
              newText === " " ||
              newText.trim().length === 1 ||
              (newText.length === 2 && this.bracketMatcherPairs.includes(newText))
            )
              return true;
          } else if (
            oldText.length > 0 &&
            (this.backspaceTriggersAutocomplete || this.suggestionList.isActive())
          ) {
            // Suggestion list must be either active or backspaceTriggersAutocomplete must be true for activation to occur.
            // Activate on removal of a space, a non-whitespace character, or a bracket-matcher pair.
            if (
              oldText === " " ||
              oldText.trim().length === 1 ||
              (oldText.length === 2 && this.bracketMatcherPairs.includes(oldText))
            )
              return true;
          }
        }
      });
    }

    // A suppressed editor stays quiet however the activation was reached.
    if (shouldActivate && this.shouldSuppressActivationForEditorClasses()) shouldActivate = false;

    if (shouldActivate) {
      this.cancelHideSuggestionListRequest();
      this.requestNewSuggestions();
    } else {
      this.cancelNewSuggestionsRequest();
      this.hideSuggestionList();
    }
  }

  // Private: The single character the user just typed, or `null` when the
  // change was anything else — a paste, a deletion, several cursors at once.
  //
  // A bracket matcher answers an opening bracket by inserting the whole pair in
  // one edit, so a two-character pair counts as the character that opened it.
  insertedCharacterForChanges(changes) {
    if (this.compositionInProgress) return null;
    if (changes.length !== 1) return null;
    const { oldText, newText } = changes[0];
    if (oldText.length > 0) return null;
    if (newText.length === 1) return newText;
    if (newText.length === 2 && this.bracketMatcherPairs.includes(newText)) return newText[0];
    return null;
  }

  // Private: Whether a provider that applies at the cursor has declared
  // `character` as one that should open the suggestion list.
  //
  // Asked on every keystroke rather than cached: providers are registered and
  // disposed as packages activate, and a language server only advertises its
  // trigger characters once it is running.
  isTriggerCharacter(character) {
    if (!character || this.providerManager == null || this.editor == null) return false;
    const cursor = this.editor.getLastCursor();
    if (cursor == null) return false;
    const providers = this.providerManager.applicableProviders(
      this.editorLabels,
      cursor.getScopeDescriptor(),
    );
    // `?.has?.()` rather than `.has()`: the contract asks for a `Set`, and a
    // provider that hands over something else must not break every keystroke.
    return providers.some((provider) => provider.triggerCharacters?.has?.(character) === true);
  }

  // Private: The highlighted suggestion when `character` is one it listed as a
  // commit character, and `null` otherwise — including when the feature is off,
  // when no list is showing, and when the suggestion lists no such character.
  suggestionForCommitCharacter(character) {
    if (!character) return null;
    if (!atom.config.get("autocomplete.commitCharacters")) return null;
    if (!this.suggestionList || !this.suggestionList.isActive()) return null;
    const suggestion = this.suggestionList.suggestionListElement.getSelectedItem();
    const characters = suggestion && suggestion.commitCharacters;
    if (!characters || !characters.includes(character)) return null;
    return suggestion;
  }

  // Private: Accepts `suggestion` because the user typed one of its commit
  // characters: take the character back out, insert the suggestion, then type
  // the character again.
  //
  // The three edits are one undo step. `editor.transact()` cannot express it —
  // `confirm` goes asynchronous whenever a provider still has detail in flight,
  // which is exactly the case for a language server — so this brackets them
  // with a checkpoint instead. That is what `transact` does internally, and it
  // survives the await; `replaceTextWithMatch` transacts within it and nests.
  async confirmWithCommitCharacter(suggestion, character, range) {
    const editor = this.editor;
    const checkpoint = editor.createCheckpoint();
    this.confirmingCommitCharacter = true;
    try {
      editor.setTextInBufferRange(range, "");
      await this.confirm(suggestion);
      this.confirmingCommitCharacter = false;
      // Typed outside the guard, so the character lands like any other
      // keystroke: one that is also a trigger character opens the next list.
      if (!this.disposed && this.editor === editor) editor.insertText(character);
    } finally {
      this.confirmingCommitCharacter = false;
      if (!editor.isDestroyed()) editor.groupChangesSinceCheckpoint(checkpoint);
    }
  }

  shouldSuppressActivationForEditorClasses() {
    for (let i = 0; i < this.suppressForClasses.length; i++) {
      const classNames = this.suppressForClasses[i];
      let containsCount = 0;
      for (let j = 0; j < classNames.length; j++) {
        const className = classNames[j];
        if (this.editorView.classList.contains(className)) {
          containsCount += 1;
        }
      }
      if (containsCount === classNames.length) {
        return true;
      }
    }
    return false;
  }

  // Public: Clean up, stop listening to events
  dispose() {
    this.hideSuggestionList();
    this.disposed = true;
    this.ready = false;
    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    this.subscriptions = null;
    this.suggestionList = null;
    this.providerManager = null;
  }
};
