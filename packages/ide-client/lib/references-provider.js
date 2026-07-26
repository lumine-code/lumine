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
    const all = await this.manager.activeSessionsForEditor(editor);
    const sessions = all.filter((session) => session.supports("textDocument/references", editor));
    if (!sessions.length) return null;
    this.abortController?.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    // Servers that both index the file report overlapping locations, so the
    // merged list is deduplicated by position.
    const seen = new Set();
    const references = [];
    const responses = await Promise.all(
      sessions.map((session) =>
        session.request(
          "textDocument/references",
          {
            textDocument: { uri: C.pathToUri(editor.getPath()) },
            position: C.pointToPosition(point),
            context: { includeDeclaration: true },
          },
          { signal },
        ),
      ),
    );
    for (const location of responses.flat()) {
      if (!location) continue;
      const path = C.uriToPath(location.uri);
      if (!path) continue;
      const range = C.rangeFromLsp(location.range);
      const key = `${path}:${range[0][0]}:${range[0][1]}:${range[1][0]}:${range[1][1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ path, range, name: null });
    }
    return { symbolName: this.symbolNameAt(editor, point), references };
  }
  symbolNameAt(editor, point) {
    const line = editor.getBuffer().lineForRow(point.row) || "";
    const before = /[\w$]+$/.exec(line.slice(0, point.column))?.[0] || "";
    const after = /^[\w$]+/.exec(line.slice(point.column))?.[0] || "";
    return before + after || null;
  }
};
