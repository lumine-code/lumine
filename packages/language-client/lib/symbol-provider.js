const C = require("./converters");
module.exports = class LspSymbolProvider {
  constructor(manager) {
    this.manager = manager;
    this.name = "Language Server";
    this.packageName = "language-client";
    this.isExclusive = true;
  }
  canProvideSymbols(meta) {
    const session = this.manager.sessionForEditor(meta.editor);
    if (!session) return false;
    if (meta.type === "project") return !!session.capabilities.workspaceSymbolProvider;
    return (
      !!session.capabilities.documentSymbolProvider ||
      !!session.capabilities.definitionProvider ||
      !!session.capabilities.referencesProvider
    );
  }
  async getSymbols(meta) {
    const session = this.manager.sessionForEditor(meta.editor);
    if (!session) return [];
    if (meta.type === "project")
      return this.convert(await session.request("workspace/symbol", { query: meta.query || "" }));
    if (meta.type === "reference")
      return this.locations(
        await session.request(
          "textDocument/references",
          this.positionParams(meta, { context: { includeDeclaration: true } }),
        ),
      );
    if (meta.type === "project-find" || meta.type === "declaration")
      return this.locations(
        await session.request("textDocument/definition", this.positionParams(meta)),
      );
    return this.convert(
      await session.request("textDocument/documentSymbol", {
        textDocument: { uri: C.pathToUri(meta.editor.getPath()) },
      }),
      meta.editor.getPath(),
    );
  }
  positionParams(meta, extra = {}) {
    const point = meta.range?.start || meta.editor.getLastCursor().getBufferPosition();
    return {
      textDocument: { uri: C.pathToUri(meta.editor.getPath()) },
      position: C.pointToPosition(point),
      ...extra,
    };
  }
  locations(items) {
    return (Array.isArray(items) ? items : items ? [items] : []).map((item) => {
      const location = item.targetUri
        ? { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange }
        : item;
      return {
        name: C.uriToPath(location.uri)?.split(/[\\/]/).pop() || "Result",
        path: C.uriToPath(location.uri),
        position: C.positionToPoint(location.range.start),
      };
    });
  }
  convert(items, defaultPath) {
    const output = [];
    const visit = (item, containerName) => {
      const location = item.location || {
        uri: defaultPath && C.pathToUri(defaultPath),
        range: item.selectionRange || item.range,
      };
      output.push({
        name: item.name,
        tag: C.symbolKind(item.kind),
        path: C.uriToPath(location.uri),
        position: C.positionToPoint(location.range.start),
        context: item.containerName || containerName,
      });
      item.children?.forEach((child) => visit(child, item.name));
    };
    (items || []).forEach((item) => visit(item));
    return output;
  }
};
