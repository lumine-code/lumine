const ChildProcess = require("child_process");
const net = require("net");
const { Emitter, CompositeDisposable } = require("atom");
const RpcConnection = require("./rpc-connection");
const C = require("./converters");
const { STATIC_CAPABILITIES } = require("./capabilities");
const { languageIdForEditor } = require("./language-ids");

// How long a server gets to exit on its own after `exit` before it is killed.
const EXIT_GRACE_MS = 1000;

// Methods an aborted request abandons quietly, without `$/cancelRequest`.
// `$/cancelRequest` is advisory, and for these two it buys nothing: a server
// supersedes find-all-references on its own as soon as the replacement lands,
// and a command is a mutation that nobody gains from stopping half way.
//
// It also costs. Pyright answers both by first awaiting
// `window/workDoneProgress/create`; a cancellation arriving during that round
// trip leaves its `CancelAfter` holding a cancellation source it never read the
// token of, and the handler's next call to `cancel()` throws
// `this._token.cancel is not a function` — for every later request of that
// method, until the server is restarted. The policy lives here rather than at
// the call sites because every request but `initialize` and `shutdown` passes
// through, including the `request` this package hands to other packages.
const ABANDON_QUIETLY = new Set(["textDocument/references", "workspace/executeCommand"]);

module.exports = class ServerSession {
  constructor(manager, adapter, rootPath, launch) {
    this.manager = manager;
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.launch = launch;
    // Every project folder this session answers for. More than one only when
    // the server declared multi-root support and adopted the rest.
    this.folders = new Set([rootPath]);
    this.documents = new Map();
    this.progressTitles = new Map();
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.state = "starting";
    this.capabilities = {};
    this.restartCount = 0;
  }
  onDidChangeState(fn) {
    return this.emitter.on("did-change-state", fn);
  }
  // Notifications this client registers no handler of its own for. The ones it
  // does handle reach their consumers through the manager instead.
  onNotification(fn) {
    return this.emitter.on("notification", fn);
  }
  setState(state, error) {
    this.state = state;
    this.emitter.emit("did-change-state", { session: this, state, error });
    this.manager.didChangeSession(this, error);
  }
  // Everything the connection has to say about itself — traffic traces, write
  // failures, handler faults — lands in this server's log buffer.
  logger() {
    const log = (message) => this.manager.log(this, message);
    return { error: log, warn: log, info: log, log };
  }
  applyTrace() {
    this.connection?.setTrace(atom.config.get("ide-client.trace"));
  }
  async start() {
    const { command, args = [], cwd = this.rootPath, env = {}, transport = "stdio" } = this.launch;
    if (!command) throw new Error(`Adapter ${this.adapter.id} returned no server command`);
    const options = { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false };
    const rpc = { logger: this.logger() };
    if (transport === "ipc") {
      this.process = ChildProcess.fork(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      this.connection = RpcConnection.ipc(this.process, rpc);
    } else if (transport === "socket") {
      this.process = ChildProcess.spawn(command, args, options);
      const socket = net.connect({ host: this.launch.host || "127.0.0.1", port: this.launch.port });
      await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
      this.connection = RpcConnection.socket(socket, rpc);
    } else {
      this.process = ChildProcess.spawn(command, args, {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.connection = RpcConnection.stdio(this.process, rpc);
    }
    this.process.stderr?.on("data", (chunk) => this.manager.log(this, chunk.toString()));
    this.process.once("exit", (code, signal) => this.onExit(code, signal));
    this.installClientHandlers();
    this.applyTrace();
    this.connection.listen();
    const rootUri = C.pathToUri(this.rootPath);
    const result = await this.connection.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "Lumine", version: atom.getVersion() },
      locale: navigator.language,
      rootUri,
      workspaceFolders: atom.project
        .getPaths()
        .map((p) => ({ uri: C.pathToUri(p), name: require("path").basename(p) })),
      capabilities: this.manager.buildClientCapabilities(),
      initializationOptions: await this.adapter.getInitializationOptions?.({
        rootPath: this.rootPath,
        rootUri,
      }),
    });
    this.capabilities =
      this.adapter.transformServerCapabilities?.(result.capabilities) || result.capabilities || {};
    const encoding = this.capabilities.positionEncoding;
    if (encoding && encoding !== "utf-16")
      throw new Error(
        `${this.adapter.displayName} chose unsupported position encoding '${encoding}'`,
      );
    this.serverInfo = result.serverInfo;
    this.connection.notify("initialized", {});
    this.pushSettings();
    this.setState("running");
  }
  async pushSettings() {
    const settings =
      (await this.adapter.getSettings?.()) ??
      (await this.adapter.getWorkspaceConfiguration?.(undefined)) ??
      {};
    if (this.connection) this.connection.notify("workspace/didChangeConfiguration", { settings });
  }
  transformDocumentText(text, editor, uri) {
    return this.adapter.transformDocumentText?.(text, { editor, uri }) ?? text;
  }
  restoreDocumentText(text, editor, uri) {
    return this.adapter.restoreDocumentText?.(text, { editor, uri }) ?? text;
  }
  // True when the session can serve the given request method for the editor.
  // Dynamic registrations take precedence over the static server capability.
  supports(method, editor) {
    const dynamic = this.manager.dynamicSupport(this, method, editor);
    if (dynamic !== undefined) return dynamic;
    const field = STATIC_CAPABILITIES[method];
    return field ? !!this.capabilities[field] : true;
  }
  installClientHandlers() {
    this.connection.onError((error) => this.manager.log(this, error.stack || error.message));
    this.connection.onOtherNotification((method, params) =>
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
    this.connection.onNotification("$/progress", (params) =>
      this.manager.handleProgress(this, params),
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
      applied: await this.manager.applyWorkspaceEdit(edit, label, this),
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
    // Server-initiated refresh requests: acknowledge with null and let the
    // manager route them to the feature modules that hold the stale data.
    for (const [method, kind] of [
      ["workspace/codeLens/refresh", "codeLens"],
      ["workspace/semanticTokens/refresh", "semanticTokens"],
      ["workspace/inlayHint/refresh", "inlayHint"],
    ]) {
      this.connection.onRequest(method, () => {
        this.manager.requestRefresh(this, kind);
        return null;
      });
    }
  }
  async openEditor(editor) {
    const uri = C.pathToUri(editor.getPath());
    if (this.documents.has(uri)) return;
    const document = { editor, uri, version: 1, subscriptions: new CompositeDisposable() };
    this.documents.set(uri, document);
    this.connection.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageIdForEditor(this.adapter, editor),
        version: 1,
        text: this.transformDocumentText(editor.getText(), editor, uri),
      },
    });
    document.subscriptions.add(
      editor.getBuffer().onDidChangeText((event) => this.changeDocument(document, event)),
    );
    document.subscriptions.add(
      editor.onDidSave(() =>
        this.connection.notify("textDocument/didSave", {
          textDocument: { uri },
          text: this.transformDocumentText(editor.getText(), editor, uri),
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
      sync === 1 || this.adapter.transformDocumentText
        ? [
            {
              text: this.transformDocumentText(
                document.editor.getText(),
                document.editor,
                document.uri,
              ),
            },
          ]
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
  detachEditor(editor) {
    for (const [uri, document] of this.documents)
      if (document.editor === editor) this.closeDocument(uri);
  }
  closeDocument(uri) {
    const doc = this.documents.get(uri);
    if (!doc) return;
    doc.subscriptions.dispose();
    this.documents.delete(uri);
    this.connection.notify("textDocument/didClose", { textDocument: { uri } });
    if (!this.documents.size) this.manager.didCloseDocument(this);
  }
  // An explicit `cancelOnServer` still wins, for a caller that knows better.
  request(method, params, options) {
    if (this.state !== "running")
      return Promise.reject(new Error("Language server is not running"));
    return this.connection.request(method, params, {
      cancelOnServer: !ABANDON_QUIETLY.has(method),
      ...options,
    });
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
    this.manager.clearProgress(this);
    if (this.state === "stopping" || this.state === "stopped") return;
    this.setState("failed", new Error(`Server exited (${code ?? signal})`));
    this.manager.scheduleRestart(this);
  }
  // `exit` asks the server to leave on its own. Killing it in the same tick
  // breaks its stdin before it has read the frame, so wait for it to go and
  // only insist once it is clear it will not.
  awaitExit() {
    const child = this.process;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    child.stdin?.end();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, EXIT_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  async stop() {
    if (this.state === "stopped") return;
    const wasRunning = this.state === "running";
    this.setState("stopping");
    try {
      if (wasRunning) await this.connection.request("shutdown");
    } catch {
      /* The server may already be gone. */
    }
    // Awaited so the frame is on the wire before the process is taken down.
    await this.connection?.notify("exit");
    await this.awaitExit();
    this.connection?.dispose();
    for (const doc of this.documents.values()) doc.subscriptions.dispose();
    this.documents.clear();
    this.manager.clearDiagnosticsForSession(this);
    this.manager.clearProgress(this);
    this.setState("stopped");
  }
};
