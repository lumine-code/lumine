const C = require("./converters");

const FORMAT_CAPABILITIES = {
  textDocument: {
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    onTypeFormatting: { dynamicRegistration: true },
  },
};

// One shared implementation behind the four code-format services. Every
// method resolves to an array of { oldRange, newText } edits.
module.exports = class CodeFormatProvider {
  static capabilities = FORMAT_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(FORMAT_CAPABILITIES);
  }
  providerFor(method) {
    const self = this;
    return {
      priority: 2,
      packageName: "ide-client",
      get grammarScopes() {
        return self.manager.allGrammarScopes();
      },
      ...method,
    };
  }
  rangeProvider() {
    return this.providerFor({ formatCode: (editor, range) => this.formatRange(editor, range) });
  }
  fileProvider() {
    return this.providerFor({ formatEntireFile: (editor) => this.formatFile(editor) });
  }
  onTypeProvider() {
    return this.providerFor({
      formatAtPosition: (editor, position, character) =>
        this.formatOnType(editor, position, character),
      keepCursorPosition: false,
    });
  }
  onSaveProvider() {
    return this.providerFor({ formatOnSave: (editor) => this.formatOnSave(editor) });
  }
  options(editor) {
    return { tabSize: editor.getTabLength(), insertSpaces: editor.getSoftTabs() };
  }
  edits(result) {
    return (result || []).map((edit) => ({
      oldRange: C.rangeFromLsp(edit.range),
      newText: edit.newText,
    }));
  }
  async formatRange(editor, range) {
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/rangeFormatting",
    );
    if (!session) return [];
    try {
      return this.edits(
        await session.request("textDocument/rangeFormatting", {
          textDocument: { uri: C.pathToUri(editor.getPath()) },
          range: C.rangeToLsp(range),
          options: this.options(editor),
        }),
      );
    } catch {
      return [];
    }
  }
  async formatFile(editor) {
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/formatting");
    if (!session) return [];
    try {
      return this.edits(
        await session.request("textDocument/formatting", {
          textDocument: { uri: C.pathToUri(editor.getPath()) },
          options: this.options(editor),
        }),
      );
    } catch {
      return [];
    }
  }
  async formatOnType(editor, position, character) {
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/onTypeFormatting",
    );
    if (!session) return [];
    const provider = session.capabilities.documentOnTypeFormattingProvider;
    const triggers = [
      provider?.firstTriggerCharacter,
      ...(provider?.moreTriggerCharacter || []),
    ].filter(Boolean);
    if (!triggers.includes(character)) return [];
    try {
      return this.edits(
        await session.request("textDocument/onTypeFormatting", {
          textDocument: { uri: C.pathToUri(editor.getPath()) },
          position: C.pointToPosition(position),
          ch: character,
          options: this.options(editor),
        }),
      );
    } catch {
      return [];
    }
  }
  // Prefers willSaveWaitUntil when the server implements it, else plain
  // document formatting.
  async formatOnSave(editor) {
    // A server that only answers willSaveWaitUntil still formats on save, so
    // prefer whichever session offers either path.
    const sessions = await this.manager.activeSessionsForEditor(editor);
    const session =
      sessions.find((candidate) => {
        const sync = candidate.capabilities.textDocumentSync;
        return typeof sync === "object" && sync?.willSaveWaitUntil;
      }) ||
      sessions.find((candidate) => candidate.supports("textDocument/formatting", editor)) ||
      null;
    if (!session) return [];
    const sync = session.capabilities.textDocumentSync;
    if (typeof sync === "object" && sync?.willSaveWaitUntil) {
      try {
        return this.edits(
          await session.request("textDocument/willSaveWaitUntil", {
            textDocument: { uri: C.pathToUri(editor.getPath()) },
            reason: 1,
          }),
        );
      } catch {
        return [];
      }
    }
    return this.formatFile(editor);
  }
};
