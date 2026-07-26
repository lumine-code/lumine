const C = require("./converters");
const { mergeHoverValues } = require("./hover-merge");

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
  // Every server serving the editor is asked, and their answers are stacked
  // into one tooltip: a type checker explains the type while a linter explains
  // the rule, and both are worth reading. Identical answers collapse.
  async hover(editor, point) {
    const all = await this.manager.activeSessionsForEditor(editor);
    const sessions = all.filter((session) => session.supports("textDocument/hover", editor));
    if (!sessions.length) return null;
    this.abortController?.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const results = await Promise.all(
      sessions.map(async (session) => {
        try {
          return await session.request(
            "textDocument/hover",
            {
              textDocument: { uri: C.pathToUri(editor.getPath()) },
              position: C.pointToPosition(point),
            },
            { signal },
          );
        } catch {
          return null;
        }
      }),
    );
    const values = [];
    const kinds = new Set();
    let range;
    for (const result of results) {
      const value = this.toValue(result?.contents, kinds);
      if (!value) continue;
      values.push(value);
      if (result.range && !range) range = C.rangeFromLsp(result.range);
    }
    // Overlap between servers is removed section by section, not answer by
    // answer: they repeat each other's signature line far more often than they
    // repeat a whole answer.
    const value = mergeHoverValues(values);
    if (!value) return null;
    // Markdown wins a mixed set: it is the richer renderer, and a lone
    // plaintext answer reads acceptably through it.
    const kind = kinds.has("markdown") || kinds.size === 0 ? "markdown" : "plaintext";
    return { range, contents: { kind, value } };
  }
  toValue(contents, kinds) {
    if (!contents) return null;
    if (Array.isArray(contents)) {
      kinds.add("markdown");
      return contents.map(toMarkdown).filter(Boolean).join("\n\n");
    }
    if (typeof contents === "string") {
      kinds.add("markdown");
      return contents;
    }
    if (contents.kind) {
      kinds.add(contents.kind);
      return contents.value;
    }
    kinds.add("markdown");
    return toMarkdown(contents);
  }
};
