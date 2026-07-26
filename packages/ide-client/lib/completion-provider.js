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
        resolveSupport: {
          properties: ["documentation", "detail", "additionalTextEdits", "command"],
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
    this.filterSuggestions = false;
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
      for (const item of items)
        mapped.push(this.toSuggestion(session, this.applyDefaults(item, defaults)));
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
  filterCached(cache, prefix) {
    const query = prefix.toLowerCase();
    // The cached edits were computed at the column the request was made from.
    // The user has typed since, so every replaced span has to grow by the same
    // number of characters; otherwise accepting `console` after typing `con`
    // replaces only `co` and leaves the tail behind as `consolen`.
    const growth = prefix.length - cache.prefix.length;
    return cache.items
      .filter((suggestion) => {
        const item = suggestion._lspItem;
        const haystack = (item.filterText ?? item.label).toLowerCase();
        return haystack.startsWith(query) || haystack.includes(query);
      })
      .map((suggestion) => this.reanchor(suggestion, growth));
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
    const suggestion = {
      displayText: item.label,
      text: item.insertText || item.label,
      type: C.completionKind(item.kind),
      leftLabel: item.detail,
      description:
        typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
      _lspItem: item,
      _lspSession: session,
    };
    if (item.insertTextFormat === 2) {
      suggestion.snippet = item.insertText || item.textEdit?.newText || item.label;
      delete suggestion.text;
    }
    const editRange = item.textEdit?.range || item.textEdit?.insert || item.textEdit?.replace;
    if (editRange)
      suggestion.textEdit = { range: C.rangeFromLsp(editRange), newText: item.textEdit.newText };
    suggestion.additionalTextEdits = item.additionalTextEdits?.map((edit) => ({
      range: C.rangeFromLsp(edit.range),
      newText: edit.newText,
    }));
    return suggestion;
  }
  async getSuggestionDetailsOnSelect(suggestion) {
    const provider = suggestion._lspSession?.capabilities.completionProvider;
    if (!provider?.resolveProvider) return suggestion;
    try {
      const item = await suggestion._lspSession.request(
        "completionItem/resolve",
        suggestion._lspItem,
      );
      return { ...suggestion, ...this.toSuggestion(suggestion._lspSession, item) };
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
