const C = require("./converters");

const REFERENCES_CAPABILITIES = {
  textDocument: { references: { dynamicRegistration: true } },
};

module.exports = class ReferencesProvider {
  static capabilities = REFERENCES_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(REFERENCES_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.abortController = null;
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  isEditorSupported(editor) {
    return !!this.manager.adapterForEditor(editor);
  }
  // Resolves to { symbolName, references: [{ path, range, name? }] }, null when
  // the session cannot serve references. Request failures reject.
  async findReferences(editor, point) {
    const session = await this.manager.activeSessionForEditor(editor);
    if (!session?.supports("textDocument/references", editor)) return null;
    this.abortController?.abort();
    this.abortController = new AbortController();
    const locations = await session.request(
      "textDocument/references",
      {
        textDocument: { uri: C.pathToUri(editor.getPath()) },
        position: C.pointToPosition(point),
        context: { includeDeclaration: true },
      },
      { signal: this.abortController.signal },
    );
    const references = (locations || [])
      .map((location) => ({
        path: C.uriToPath(location.uri),
        range: C.rangeFromLsp(location.range),
        name: null,
      }))
      .filter((reference) => reference.path);
    return { symbolName: this.symbolNameAt(editor, point), references };
  }
  symbolNameAt(editor, point) {
    const line = editor.getBuffer().lineForRow(point.row) || "";
    const before = /[\w$]+$/.exec(line.slice(0, point.column))?.[0] || "";
    const after = /^[\w$]+/.exec(line.slice(point.column))?.[0] || "";
    return before + after || null;
  }
};
