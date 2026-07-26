const C = require("./converters");

const COMPLETION_CAPABILITIES = {
  textDocument: {
    completion: {
      dynamicRegistration: true,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        resolveSupport: {
          properties: ["documentation", "detail", "additionalTextEdits", "command", "labelDetails"],
        },
      },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
      completionList: { itemDefaults: ["editRange", "insertTextFormat", "data"] },
    },
  },
};

module.exports = class CompletionProvider {
  static capabilities = COMPLETION_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(COMPLETION_CAPABILITIES);
    this.scopeSelector = ".source, .text";
    this.inclusionPriority = 2;
    this.suggestionPriority = 2;
    this.excludeLowerPriority = false;
    // Let autocomplete score and rank: a server sends the whole visible scope
    // and expects the client to narrow it, and its ranking understands
    // subsequence matches that a prefix test cannot.
    this.filterSuggestions = true;
    this.cache = null;
    this.abortController = null;
  }
  // Completions from every server serving the editor are merged: a type
  // checker and a linter each contribute their own, and the user wants both.
  async getSuggestions({ editor, bufferPosition, prefix, activatedManually }) {
    const all = await this.manager.activeSessionsForEditor(editor);
    const sessions = all.filter((session) => session.supports("textDocument/completion", editor));
    if (!sessions.length) return [];
    const wordStart = bufferPosition.column - (prefix?.length || 0);
    const cache = this.cache;
    if (
      cache &&
      !activatedManually &&
      cache.editor === editor &&
      this.sameSessions(cache.sessions, sessions) &&
      cache.row === bufferPosition.row &&
      cache.wordStart === wordStart &&
      !cache.isIncomplete &&
      prefix.startsWith(cache.prefix)
    ) {
      return this.filterCached(cache, prefix);
    }
    const lastCharacter = editor.getTextInBufferRange([
      [bufferPosition.row, Math.max(0, bufferPosition.column - 1)],
      bufferPosition,
    ]);
    this.abortController?.abort();
    const controller = (this.abortController = new AbortController());
    const { signal } = controller;
    const responses = await Promise.all(
      sessions.map(async (session) => {
        const provider = session.capabilities.completionProvider || {};
        let context;
        if (!activatedManually && (provider.triggerCharacters || []).includes(lastCharacter))
          context = { triggerKind: 2, triggerCharacter: lastCharacter };
        else if (cache?.isIncomplete && cache.editor === editor && cache.row === bufferPosition.row)
          context = { triggerKind: 3 };
        else context = { triggerKind: 1 };
        try {
          const result = await session.request(
            "textDocument/completion",
            {
              textDocument: { uri: C.pathToUri(editor.getPath()) },
              position: C.pointToPosition(bufferPosition),
              context,
            },
            { signal },
          );
          return { session, result };
        } catch {
          // One server failing must not discard the others' suggestions.
          return null;
        }
      }),
    );
    // A superseded request must not publish a cache: its empty result would be
    // recorded as a complete answer, and every later keystroke of the word
    // would then filter that emptiness instead of asking the server again.
    if (signal.aborted) return [];
    // Likewise when every server errored: caching "no completions here" would
    // suppress the next request for the rest of the word.
    const answered = responses.filter(Boolean);
    if (!answered.length) return [];
    const mapped = [];
    let isIncomplete = false;
    for (const response of answered) {
      const { session, result } = response;
      const items = Array.isArray(result) ? result : result?.items || [];
      const defaults = Array.isArray(result) ? null : result?.itemDefaults;
      if (!Array.isArray(result) && result?.isIncomplete) isIncomplete = true;
      for (const item of items) {
        const suggestion = this.toSuggestion(session, this.applyDefaults(item, defaults));
        // The server's own relevance ordering, which autocomplete uses to break
        // ties between items that match the typed prefix equally well.
        suggestion.sortText = item.sortText ?? item.label;
        mapped.push(suggestion);
      }
    }
    mapped.sort((a, b) =>
      (a._lspItem.sortText ?? a._lspItem.label).localeCompare(
        b._lspItem.sortText ?? b._lspItem.label,
      ),
    );
    this.cache = {
      editor,
      sessions,
      row: bufferPosition.row,
      wordStart,
      prefix: prefix || "",
      isIncomplete,
      items: mapped,
    };
    return mapped;
  }
  sameSessions(a, b) {
    return a.length === b.length && a.every((session, index) => session === b[index]);
  }
  // Narrowing is autocomplete's job now, so this only re-anchors. Filtering
  // here as well would reject subsequence matches (`sfn` for `setFontName`)
  // before the scorer ever saw them.
  filterCached(cache, prefix) {
    // The cached edits were computed at the column the request was made from.
    // The user has typed since, so every replaced span has to grow by the same
    // number of characters; otherwise accepting `console` after typing `con`
    // replaces only `co` and leaves the tail behind as `consolen`.
    const growth = prefix.length - cache.prefix.length;
    return cache.items.map((suggestion) => this.reanchor(suggestion, growth));
  }
  // Returns a copy whose edit range ends `growth` characters later. The cached
  // suggestion itself is left alone so a later, shorter prefix re-anchors from
  // the original range rather than compounding.
  reanchor(suggestion, growth) {
    if (!growth || !suggestion.textEdit) return suggestion;
    const [start, end] = suggestion.textEdit.range;
    return {
      ...suggestion,
      textEdit: {
        range: [start, [end[0], end[1] + growth]],
        newText: suggestion.textEdit.newText,
      },
    };
  }
  applyDefaults(item, defaults) {
    if (!defaults) return item;
    const merged = { ...item };
    if (merged.insertTextFormat == null && defaults.insertTextFormat != null)
      merged.insertTextFormat = defaults.insertTextFormat;
    if (merged.data == null && defaults.data != null) merged.data = defaults.data;
    if (!merged.textEdit && defaults.editRange) {
      const newText = merged.textEditText ?? merged.insertText ?? merged.label;
      merged.textEdit = defaults.editRange.start
        ? { range: defaults.editRange, newText }
        : { insert: defaults.editRange.insert, replace: defaults.editRange.replace, newText };
    }
    return merged;
  }
  toSuggestion(session, item) {
    const documentation = item.documentation;
    const documentationText =
      typeof documentation === "string" ? documentation : documentation?.value;
    const suggestion = {
      displayText: item.label,
      // `labelDetails.detail` is a signature glued to the label; `.description`
      // is the source module, which reads like every other right label.
      displayTextDetail: item.labelDetails?.detail,
      text: item.insertText || item.label,
      type: C.completionKind(item.kind),
      leftLabel: item.detail,
      rightLabel: item.labelDetails?.description,
      description: documentationText,
      _lspItem: item,
      _lspSession: session,
    };
    // The plain `description` stays set alongside it: anything reading the
    // suggestion as text still gets the source, and the popup falls back to it
    // if the markdown ever fails to render.
    if (documentation?.kind === "markdown" && documentationText)
      suggestion.descriptionMarkdown = documentationText;
    if (item.insertTextFormat === 2) {
      suggestion.snippet = item.insertText || item.textEdit?.newText || item.label;
      delete suggestion.text;
    }
    // An InsertReplaceEdit offers two ranges: `insert` stops at the cursor,
    // `replace` covers the whole identifier being edited. Honour the user's
    // consume-suffix preference rather than always taking the shorter one,
    // which duplicated the tail (`console` + accept → `consolesole`).
    const edit = item.textEdit;
    const editRange =
      edit?.range ||
      (atom.config.get("autocomplete.consumeSuffix")
        ? edit?.replace || edit?.insert
        : edit?.insert) ||
      edit?.replace;
    if (editRange)
      suggestion.textEdit = { range: C.rangeFromLsp(editRange), newText: edit.newText };
    suggestion.additionalTextEdits = item.additionalTextEdits?.map((edit) => ({
      range: C.rangeFromLsp(edit.range),
      newText: edit.newText,
    }));
    return suggestion;
  }
  async getSuggestionDetailsOnSelect(suggestion) {
    const provider = suggestion._lspSession?.capabilities.completionProvider;
    if (!provider?.resolveProvider || suggestion._resolved) return suggestion;
    try {
      const item = await suggestion._lspSession.request(
        "completionItem/resolve",
        suggestion._lspItem,
      );
      const detailed = {
        ...suggestion,
        ...this.toSuggestion(suggestion._lspSession, item),
        _resolved: true,
      };
      // Swap the resolved item into the cache: the next keystroke filters the
      // cached list, and without this it would hand back the unresolved object
      // and re-request detail that has already been fetched.
      const index = this.cache?.items.indexOf(suggestion);
      if (index != null && index >= 0) this.cache.items[index] = detailed;
      return detailed;
    } catch {
      return suggestion;
    }
  }
  onDidInsertSuggestion({ suggestion }) {
    const command = suggestion._lspItem?.command;
    if (!command) return;
    suggestion._lspSession
      ?.request("workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments,
      })
      .catch(() => {});
  }
};
