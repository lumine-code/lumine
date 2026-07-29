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
    this.packageName = "ide-client";
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  // Resolves to one of:
  //   null                                  this provider cannot rename here,
  //                                         so the consumer may try another
  //   { outcome: "edits", edits }            Map<absolutePath, [{ oldRange,
  //                                         newText }]> for the consumer to apply
  //   { outcome: "applied", paths }          the edit needed file create/rename/
  //                                         delete operations, so the hub applied
  //                                         all of it; the consumer only reports
  //   { outcome: "aborted" }                 applying was declined or failed;
  //                                         the consumer stops without reporting
  // Passing `dryRun` computes the edits without ever applying them, so a
  // consumer can preview a rename. Every call is a server round trip, so
  // callers must debounce previews rather than issue one per keystroke.
  async rename(editor, position, newName, { dryRun = false } = {}) {
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/rename");
    if (!session) return null;
    const edit = await session.request("textDocument/rename", {
      textDocument: { uri: C.pathToUri(editor.getPath()) },
      position: C.pointToPosition(position),
      newName,
    });
    if (!edit) return null;
    const edits = this.toPathMap(edit, session);
    if (!this.hasResourceOperations(edit)) return { outcome: "edits", edits };
    if (dryRun) return { outcome: "edits", edits, resourceOperations: true };
    const applied = await this.manager.applyWorkspaceEdit(edit, `Rename to ${newName}`, session);
    return applied ? { outcome: "applied", paths: [...edits.keys()] } : { outcome: "aborted" };
  }
  hasResourceOperations(edit) {
    return (edit.documentChanges || []).some(
      (change) => change.kind === "create" || change.kind === "rename" || change.kind === "delete",
    );
  }
  toPathMap(edit, session) {
    const map = new Map();
    const add = (uri, edits) => {
      const filePath = C.uriToPath(uri);
      if (!filePath || !edits?.length) return;
      const list = map.get(filePath) || [];
      const editor = atom.workspace
        .getTextEditors()
        .find((candidate) => candidate.getPath() === filePath);
      list.push(
        ...edits.map((textEdit) => ({
          oldRange: C.rangeFromLsp(textEdit.range),
          newText:
            (editor && session?.restoreDocumentText?.(textEdit.newText, editor, uri)) ??
            textEdit.newText,
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
    const sessions = await this.manager.activeSessionsForEditor(editor);
    const session = sessions.find(
      (candidate) => candidate.capabilities.renameProvider?.prepareProvider,
    );
    if (!session) return null;
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
