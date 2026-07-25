const C = require("./converters");

const REFACTOR_CAPABILITIES = {
  textDocument: {
    rename: {
      dynamicRegistration: true,
      prepareSupport: true,
      prepareSupportDefaultBehavior: 1,
      honorsChangeAnnotations: false,
    },
  },
};

module.exports = class RefactorProvider {
  static capabilities = REFACTOR_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(REFACTOR_CAPABILITIES);
    this.priority = 2;
    this.packageName = "language-client";
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  // Resolves to Map<absolutePath, [{ oldRange, newText }]> for the consumer to
  // apply. When the edit contains resource operations (create/rename/delete)
  // the hub applies the whole edit itself and resolves to null so the consumer
  // does not double-apply.
  async rename(editor, position, newName) {
    const session = await this.manager.activeSessionForEditor(editor);
    if (!session?.supports("textDocument/rename", editor)) return null;
    const edit = await session.request("textDocument/rename", {
      textDocument: { uri: C.pathToUri(editor.getPath()) },
      position: C.pointToPosition(position),
      newName,
    });
    if (!edit) return null;
    if (this.hasResourceOperations(edit)) {
      await this.manager.applyWorkspaceEdit(edit, `Rename to ${newName}`);
      return null;
    }
    return this.toPathMap(edit);
  }
  hasResourceOperations(edit) {
    return (edit.documentChanges || []).some(
      (change) => change.kind === "create" || change.kind === "rename" || change.kind === "delete",
    );
  }
  toPathMap(edit) {
    const map = new Map();
    const add = (uri, edits) => {
      const filePath = C.uriToPath(uri);
      if (!filePath || !edits?.length) return;
      const list = map.get(filePath) || [];
      list.push(
        ...edits.map((textEdit) => ({
          oldRange: C.rangeFromLsp(textEdit.range),
          newText: textEdit.newText,
        })),
      );
      map.set(filePath, list);
    };
    for (const [uri, edits] of Object.entries(edit.changes || {})) add(uri, edits);
    for (const change of edit.documentChanges || [])
      if (change.textDocument) add(change.textDocument.uri, change.edits);
    return map;
  }
  async prepareRename(editor, position) {
    const session = await this.manager.activeSessionForEditor(editor);
    if (!session?.capabilities.renameProvider?.prepareProvider) return null;
    const result = await session.request("textDocument/prepareRename", {
      textDocument: { uri: C.pathToUri(editor.getPath()) },
      position: C.pointToPosition(position),
    });
    if (!result) return null;
    if (result.defaultBehavior) return { range: this.wordRangeAt(editor, position) };
    if (result.start) return { range: C.rangeFromLsp(result) };
    if (result.range)
      return { range: C.rangeFromLsp(result.range), placeholder: result.placeholder };
    return null;
  }
  wordRangeAt(editor, point) {
    const line = editor.getBuffer().lineForRow(point.row) || "";
    const before = /[\w$]+$/.exec(line.slice(0, point.column))?.[0] || "";
    const after = /^[\w$]+/.exec(line.slice(point.column))?.[0] || "";
    return [
      [point.row, point.column - before.length],
      [point.row, point.column + after.length],
    ];
  }
};
