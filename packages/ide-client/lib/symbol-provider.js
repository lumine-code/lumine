const C = require("./converters");

const SYMBOL_CAPABILITIES = {
  workspace: {
    symbol: {
      dynamicRegistration: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
  },
  textDocument: {
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
  },
};

module.exports = class LspSymbolProvider {
  static capabilities = SYMBOL_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(SYMBOL_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.isExclusive = true;
  }
  async canProvideSymbols(meta) {
    return !!(await this.sessionFor(meta));
  }
  // One symbol source per editor: merging two servers' symbol lists would show
  // every symbol twice, so the first server that indexes them answers.
  async sessionFor(meta) {
    const sessions = await this.manager.activeSessionsForEditor(meta.editor);
    if (meta.type === "project")
      return sessions.find((session) => session.supports("workspace/symbol", meta.editor)) || null;
    return (
      sessions.find(
        (session) =>
          session.supports("textDocument/documentSymbol", meta.editor) ||
          session.supports("textDocument/definition", meta.editor) ||
          session.supports("textDocument/references", meta.editor),
      ) || null
    );
  }
  async getSymbols(meta) {
    const session = await this.sessionFor(meta);
    if (!session) return [];
    const options = { signal: meta.signal };
    if (meta.type === "project")
      return this.convert(
        await session.request("workspace/symbol", { query: meta.query || "" }, options),
      );
    if (meta.type === "reference")
      return this.locations(
        await session.request(
          "textDocument/references",
          this.positionParams(meta, { context: { includeDeclaration: true } }),
          options,
        ),
      );
    if (meta.type === "project-find" || meta.type === "declaration")
      return this.locations(
        await session.request("textDocument/definition", this.positionParams(meta), options),
      );
    return this.convert(
      await session.request(
        "textDocument/documentSymbol",
        { textDocument: { uri: C.pathToUri(meta.editor.getPath()) } },
        options,
      ),
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
