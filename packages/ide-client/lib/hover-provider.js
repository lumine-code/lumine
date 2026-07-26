const C = require("./converters");

const HOVER_CAPABILITIES = {
  textDocument: {
    hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
  },
};

// Normalizes the legacy MarkedString shapes into markdown.
const toMarkdown = (part) => {
  if (typeof part === "string") return part;
  if (part?.language) return `\`\`\`${part.language}\n${part.value}\n\`\`\``;
  return part?.value || "";
};

module.exports = class HoverProvider {
  static capabilities = HOVER_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(HOVER_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.priority = 2;
    this.abortController = null;
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  async hover(editor, point) {
    const session = await this.manager.activeSessionForEditor(editor);
    if (!session?.supports("textDocument/hover", editor)) return null;
    this.abortController?.abort();
    this.abortController = new AbortController();
    let result;
    try {
      result = await session.request(
        "textDocument/hover",
        {
          textDocument: { uri: C.pathToUri(editor.getPath()) },
          position: C.pointToPosition(point),
        },
        { signal: this.abortController.signal },
      );
    } catch {
      return null;
    }
    const contents = result?.contents;
    if (!contents) return null;
    let kind = "markdown";
    let value;
    if (Array.isArray(contents)) value = contents.map(toMarkdown).filter(Boolean).join("\n\n");
    else if (typeof contents === "string") value = contents;
    else if (contents.kind) ({ kind, value } = contents);
    else value = toMarkdown(contents);
    if (!value) return null;
    return {
      range: result.range ? C.rangeFromLsp(result.range) : undefined,
      contents: { kind, value },
    };
  }
};
