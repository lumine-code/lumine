// Client capabilities advertised to language servers. The base covers only what
// the protocol core itself implements; feature modules contribute fragments for
// the requests they issue, so no capability is advertised without an
// implementation behind it. Fragments must be registered before a session
// starts — they are merged once, at initialize time.

exports.baseCapabilities = () => ({
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
    },
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    executeCommand: {},
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: true,
      didSave: true,
    },
    publishDiagnostics: {
      relatedInformation: true,
      tagSupport: { valueSet: [1, 2] },
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    // Consumed by the call-hierarchy companion package through the
    // ide-client request API; external packages cannot contribute
    // fragments, so the hub advertises this one on their behalf.
    callHierarchy: { dynamicRegistration: true },
  },
  notebookDocument: {
    synchronization: { dynamicRegistration: false, executionSummarySupport: true },
  },
  window: {
    workDoneProgress: true,
    showMessage: { messageActionItem: { additionalPropertiesSupport: true } },
    showDocument: { support: true },
  },
  general: {
    positionEncodings: ["utf-16"],
    staleRequestSupport: { cancel: true, retryOnContentModified: [] },
    markdown: { parser: "markdown-it", version: "14" },
    regularExpressions: { engine: "ECMAScript", version: "ES2024" },
  },
});

exports.mergeCapabilities = (target, ...fragments) => {
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment || {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key]))
          target[key] = {};
        exports.mergeCapabilities(target[key], value);
      } else {
        target[key] = value;
      }
    }
  }
  return target;
};

// Maps a request method to the server-capability field that enables it, for
// session.supports() checks when no dynamic registration governs the method.
exports.STATIC_CAPABILITIES = {
  "textDocument/completion": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/declaration": "declarationProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/typeDefinition": "typeDefinitionProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/documentHighlight": "documentHighlightProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "workspace/symbol": "workspaceSymbolProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/codeLens": "codeLensProvider",
  "textDocument/formatting": "documentFormattingProvider",
  "textDocument/rangeFormatting": "documentRangeFormattingProvider",
  "textDocument/onTypeFormatting": "documentOnTypeFormattingProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/foldingRange": "foldingRangeProvider",
  "textDocument/selectionRange": "selectionRangeProvider",
  "textDocument/inlayHint": "inlayHintProvider",
  "textDocument/semanticTokens": "semanticTokensProvider",
  "textDocument/prepareCallHierarchy": "callHierarchyProvider",
  "textDocument/linkedEditingRange": "linkedEditingRangeProvider",
};
