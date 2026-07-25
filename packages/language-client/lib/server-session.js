const ChildProcess = require("child_process");
const net = require("net");
const { Emitter, CompositeDisposable } = require("atom");
const JsonRpcConnection = require("./json-rpc-connection");
const IpcConnection = require("./ipc-connection");
const C = require("./converters");

const CLIENT_CAPABILITIES = {
  workspace: {
    applyEdit: true,
    workspaceFolders: true,
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      changeAnnotationSupport: { groupsOnLabel: true },
    },
    symbol: { dynamicRegistration: true, resolveSupport: { properties: ["location.range"] } },
    semanticTokens: { refreshSupport: true },
    codeLens: { refreshSupport: true },
    inlayHint: { refreshSupport: true },
    diagnostics: { refreshSupport: true },
    fileOperations: {
      dynamicRegistration: true,
      didCreate: true,
      didRename: true,
      didDelete: true,
      willCreate: true,
      willRename: true,
      willDelete: true,
    },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: true,
      willSave: true,
      willSaveWaitUntil: true,
      didSave: true,
    },
    completion: {
      dynamicRegistration: true,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
        resolveSupport: {
          properties: ["documentation", "detail", "additionalTextEdits", "command"],
        },
      },
    },
    hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
    signatureHelp: {
      dynamicRegistration: true,
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        activeParameterSupport: true,
      },
    },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    typeDefinition: { dynamicRegistration: true, linkSupport: true },
    implementation: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
    documentHighlight: { dynamicRegistration: true },
    documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
    codeAction: {
      dynamicRegistration: true,
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit", "command"] },
    },
    codeLens: { dynamicRegistration: true },
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    onTypeFormatting: { dynamicRegistration: true },
    rename: { dynamicRegistration: true, prepareSupport: true, honorsChangeAnnotations: true },
    foldingRange: { dynamicRegistration: true, lineFoldingOnly: false },
    selectionRange: { dynamicRegistration: true },
    linkedEditingRange: { dynamicRegistration: true },
    semanticTokens: {
      dynamicRegistration: true,
      requests: { range: true, full: { delta: true } },
      tokenTypes: [],
      tokenModifiers: [],
      formats: ["relative"],
      overlappingTokenSupport: true,
      multilineTokenSupport: true,
    },
    inlayHint: {
      dynamicRegistration: true,
      resolveSupport: {
        properties: ["tooltip", "textEdits", "label.tooltip", "label.location", "label.command"],
      },
    },
    callHierarchy: { dynamicRegistration: true },
    typeHierarchy: { dynamicRegistration: true },
    inlineValue: { dynamicRegistration: true },
    colorProvider: { dynamicRegistration: true },
    moniker: { dynamicRegistration: true },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
  },
  notebookDocument: {
    synchronization: { dynamicRegistration: true, executionSummarySupport: true },
  },
  window: {
    workDoneProgress: true,
    showMessage: { messageActionItem: { additionalPropertiesSupport: true } },
    showDocument: { support: true },
  },
  general: {
    positionEncodings: ["utf-16", "utf-8", "utf-32"],
    markdown: { parser: "markdown-it", version: "14" },
    staleRequestSupport: { cancel: true, retryOnContentModified: [] },
    regularExpressions: { engine: "ECMAScript", version: "2024" },
  },
};

module.exports = class ServerSession {
  constructor(manager, adapter, rootPath, launch) {
    this.manager = manager;
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.launch = launch;
    this.documents = new Map();
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.state = "starting";
    this.capabilities = {};
    this.restartCount = 0;
  }
  onDidChangeState(fn) {
    return this.emitter.on("did-change-state", fn);
  }
  onNotification(fn) {
    return this.emitter.on("notification", fn);
  }
  setState(state, error) {
    this.state = state;
    this.emitter.emit("did-change-state", { session: this, state, error });
    this.manager.didChangeSession(this, error);
  }
  trace(direction, message) {
    this.manager.trace(this, direction, message);
  }
  async start() {
    const { command, args = [], cwd = this.rootPath, env = {}, transport = "stdio" } = this.launch;
    if (!command) throw new Error(`Adapter ${this.adapter.id} returned no server command`);
    const options = { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false };
    if (transport === "ipc") {
      this.process = ChildProcess.fork(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      this.connection = new IpcConnection(this.process, { trace: this.trace.bind(this) });
    } else if (transport === "socket") {
      this.process = ChildProcess.spawn(command, args, options);
      const socket = net.connect({ host: this.launch.host || "127.0.0.1", port: this.launch.port });
      await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
      this.connection = new JsonRpcConnection(socket, socket, { trace: this.trace.bind(this) });
    } else {
      this.process = ChildProcess.spawn(command, args, {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.connection = new JsonRpcConnection(this.process.stdout, this.process.stdin, {
        trace: this.trace.bind(this),
      });
    }
    this.process.stderr?.on("data", (chunk) => this.manager.log(this, chunk.toString()));
    this.process.once("exit", (code, signal) => this.onExit(code, signal));
    this.installClientHandlers();
    const rootUri = C.pathToUri(this.rootPath);
    const result = await this.connection.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "Lumine", version: atom.getVersion() },
      locale: navigator.language,
      rootUri,
      workspaceFolders: atom.project
        .getPaths()
        .map((p) => ({ uri: C.pathToUri(p), name: require("path").basename(p) })),
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: await this.adapter.getInitializationOptions?.({
        rootPath: this.rootPath,
        rootUri,
      }),
    });
    this.capabilities =
      this.adapter.transformServerCapabilities?.(result.capabilities) || result.capabilities || {};
    this.serverInfo = result.serverInfo;
    this.connection.notify("initialized", {});
    this.setState("running");
  }
  installClientHandlers() {
    this.connection.on("notification", (method, params) =>
      this.emitter.emit("notification", { session: this, method, params }),
    );
    this.connection.onNotification("textDocument/publishDiagnostics", (params) =>
      this.manager.publishDiagnostics(this, params),
    );
    this.connection.onNotification("window/logMessage", ({ message }) =>
      this.manager.log(this, message),
    );
    this.connection.onNotification("window/showMessage", ({ type, message }) =>
      this.manager.showMessage(type, message),
    );
    this.connection.onRequest("workspace/configuration", (params) =>
      Promise.all(
        params.items.map(
          (item) =>
            this.adapter.getWorkspaceConfiguration?.(item.section, item.scopeUri) ??
            atom.config.get(item.section),
        ),
      ),
    );
    this.connection.onRequest("workspace/applyEdit", async ({ edit, label }) => ({
      applied: await this.manager.applyWorkspaceEdit(edit, label),
    }));
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("client/registerCapability", (params) => {
      this.manager.registerCapabilities(this, params.registrations);
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", (params) => {
      this.manager.unregisterCapabilities(this, params.unregisterations || params.unregistrations);
      return null;
    });
    this.connection.onRequest("window/showMessageRequest", ({ type, message, actions = [] }) =>
      this.manager.showMessageRequest(type, message, actions),
    );
    this.connection.onRequest("window/showDocument", (params) => this.manager.showDocument(params));
  }
  async openEditor(editor) {
    const uri = C.pathToUri(editor.getPath());
    if (this.documents.has(uri)) return;
    const document = { editor, uri, version: 1, subscriptions: new CompositeDisposable() };
    this.documents.set(uri, document);
    this.connection.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.adapter.languageId || editor.getGrammar().name.toLowerCase(),
        version: 1,
        text: editor.getText(),
      },
    });
    document.subscriptions.add(
      editor.getBuffer().onDidChangeText((event) => this.changeDocument(document, event)),
    );
    document.subscriptions.add(
      editor.onDidSave(() =>
        this.connection.notify("textDocument/didSave", {
          textDocument: { uri },
          text: editor.getText(),
        }),
      ),
    );
    document.subscriptions.add(editor.onDidDestroy(() => this.closeDocument(uri)));
  }
  changeDocument(document, event) {
    const sync =
      typeof this.capabilities.textDocumentSync === "number"
        ? this.capabilities.textDocumentSync
        : this.capabilities.textDocumentSync?.change;
    const contentChanges =
      sync === 1
        ? [{ text: document.editor.getText() }]
        : event.changes.map((change) => ({
            range: C.rangeToLsp(change.oldRange),
            rangeLength: change.oldText?.length,
            text: change.newText,
          }));
    this.connection.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: ++document.version },
      contentChanges,
    });
  }
  closeDocument(uri) {
    const doc = this.documents.get(uri);
    if (!doc) return;
    doc.subscriptions.dispose();
    this.documents.delete(uri);
    this.connection.notify("textDocument/didClose", { textDocument: { uri } });
  }
  request(method, params, options) {
    if (this.state !== "running")
      return Promise.reject(new Error("Language server is not running"));
    return this.connection.request(method, params, options);
  }
  notify(method, params) {
    if (this.state === "running") this.connection.notify(method, params);
  }
  openNotebook(notebookDocument, cellTextDocuments = []) {
    this.notify("notebookDocument/didOpen", { notebookDocument, cellTextDocuments });
  }
  changeNotebook(notebookDocument, change) {
    this.notify("notebookDocument/didChange", { notebookDocument, change });
  }
  saveNotebook(notebookDocument) {
    this.notify("notebookDocument/didSave", { notebookDocument });
  }
  closeNotebook(notebookDocument, cellTextDocuments = []) {
    this.notify("notebookDocument/didClose", { notebookDocument, cellTextDocuments });
  }
  onExit(code, signal) {
    if (this.state === "stopping" || this.state === "stopped") return;
    this.setState("failed", new Error(`Server exited (${code ?? signal})`));
    this.manager.scheduleRestart(this);
  }
  async stop() {
    if (this.state === "stopped") return;
    const wasRunning = this.state === "running";
    this.setState("stopping");
    try {
      if (wasRunning) await this.connection.request("shutdown", null);
      this.connection?.notify("exit");
    } catch {
      /* The server may already be gone. */
    }
    this.connection?.dispose();
    this.process?.kill();
    for (const doc of this.documents.values()) doc.subscriptions.dispose();
    this.documents.clear();
    this.manager.clearDiagnosticsForSession(this);
    this.setState("stopped");
  }
};

module.exports.CLIENT_CAPABILITIES = CLIENT_CAPABILITIES;
