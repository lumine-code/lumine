const C = require("./converters");

const SIGNATURE_CAPABILITIES = {
  textDocument: {
    signatureHelp: {
      dynamicRegistration: true,
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        activeParameterSupport: true,
        parameterInformation: { labelOffsetSupport: true },
      },
    },
  },
};

module.exports = class SignatureProvider {
  static capabilities = SIGNATURE_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(SIGNATURE_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "language-client";
    this.priority = 2;
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  get triggerCharacters() {
    return this.collectCharacters("triggerCharacters");
  }
  get retriggerCharacters() {
    return this.collectCharacters("retriggerCharacters");
  }
  collectCharacters(key) {
    const characters = new Set();
    for (const session of this.manager.sessions.values()) {
      if (session.state !== "running") continue;
      for (const character of session.capabilities.signatureHelpProvider?.[key] || [])
        characters.add(character);
    }
    return characters;
  }
  // Returns the raw LSP SignatureHelp result; the consumer renders it.
  async getSignature(editor, point, context) {
    const session = await this.manager.activeSessionForEditor(editor);
    if (!session?.supports("textDocument/signatureHelp", editor)) return null;
    try {
      return await session.request("textDocument/signatureHelp", {
        textDocument: { uri: C.pathToUri(editor.getPath()) },
        position: C.pointToPosition(point),
        context: context ?? { triggerKind: 1, isRetrigger: false },
      });
    } catch {
      return null;
    }
  }
};
