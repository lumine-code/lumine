const C = require("./converters");

const OUTLINE_CAPABILITIES = {
  textDocument: {
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
  },
};

module.exports = class OutlineProvider {
  static capabilities = OUTLINE_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(OUTLINE_CAPABILITIES);
    this.name = "Language Server";
    this.priority = 2;
    this.updateOnEdit = true;
    this.abortController = null;
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  async getOutline(editor) {
    // One outline per editor: two servers' symbol trees cannot be interleaved
    // sensibly, so the first server that indexes documents wins.
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/documentSymbol",
    );
    if (!session) return null;
    this.abortController?.abort();
    this.abortController = new AbortController();
    let result;
    try {
      result = await session.request(
        "textDocument/documentSymbol",
        { textDocument: { uri: C.pathToUri(editor.getPath()) } },
        { signal: this.abortController.signal },
      );
    } catch {
      return null;
    }
    if (!Array.isArray(result) || !result.length) return { outlineTrees: [] };
    const outlineTrees = result[0].selectionRange
      ? result.map((item) => this.fromDocumentSymbol(item))
      : this.fromSymbolInformation(result);
    return { outlineTrees };
  }
  fromDocumentSymbol(item) {
    return {
      kind: C.symbolKind(item.kind),
      plainText: item.name,
      representativeName: item.name,
      startPosition: C.positionToPoint(item.selectionRange.start),
      endPosition: item.range ? C.positionToPoint(item.range.end) : undefined,
      children: (item.children || []).map((child) => this.fromDocumentSymbol(child)),
    };
  }
  // Flat SymbolInformation lists get one level of nesting by containerName;
  // a child attaches to the most recent symbol whose name matches.
  fromSymbolInformation(items) {
    const nodes = items.map((item) => ({
      node: {
        kind: C.symbolKind(item.kind),
        plainText: item.name,
        representativeName: item.name,
        startPosition: C.positionToPoint(item.location.range.start),
        children: [],
      },
      containerName: item.containerName,
    }));
    const roots = [];
    const byName = new Map();
    for (const { node, containerName } of nodes) {
      const parent = containerName && byName.get(containerName);
      (parent ? parent.children : roots).push(node);
      byName.set(node.plainText, node);
    }
    return roots;
  }
};
