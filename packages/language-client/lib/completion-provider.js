const C = require("./converters");

module.exports = class CompletionProvider {
  constructor(manager) {
    this.manager = manager;
    this.selector = ".source";
    this.disableForSelector = ".comment";
    this.inclusionPriority = 2;
    this.suggestionPriority = 2;
    this.excludeLowerPriority = false;
    this.filterSuggestions = false;
  }
  async getSuggestions({ editor, bufferPosition, activatedManually }) {
    const session = this.manager.sessionForEditor(editor);
    if (!session?.capabilities.completionProvider) return [];
    const result = await session.request("textDocument/completion", {
      textDocument: { uri: C.pathToUri(editor.getPath()) },
      position: C.pointToPosition(bufferPosition),
      context: { triggerKind: activatedManually ? 1 : 1 },
    });
    const items = Array.isArray(result) ? result : result?.items || [];
    return items.map((item) => this.toSuggestion(session, item));
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
    const editRange = item.textEdit?.range || item.textEdit?.replace || item.textEdit?.insert;
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
    const item = await suggestion._lspSession.request(
      "completionItem/resolve",
      suggestion._lspItem,
    );
    return { ...suggestion, ...this.toSuggestion(suggestion._lspSession, item) };
  }
};
