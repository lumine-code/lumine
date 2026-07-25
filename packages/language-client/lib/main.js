const LanguageServerManager = require("./language-server-manager");
const CompletionProvider = require("./completion-provider");
const SymbolProvider = require("./symbol-provider");
const DiagnosticsView = require("./diagnostics-view");
const SessionMenuView = require("./session-menu-view");
const { toLinterMessages } = require("./linter-messages");
const { CompositeDisposable, Disposable } = require("atom");

module.exports = {
  activate() {
    this.manager = new LanguageServerManager();
    this.manager.activate();
    this.completionProvider = new CompletionProvider(this.manager);
    this.symbolProvider = new SymbolProvider(this.manager);
    this.uiSubscriptions = new CompositeDisposable();
    this.panel = null;
    this.statusElement = document.createElement("span");
    this.statusElement.className = "language-client-status inline-block";
    this.statusElement.textContent = "LSP: idle";
    this.statusElement.tabIndex = 0;
    this.statusElement.setAttribute("role", "button");
    this.statusElement.setAttribute("aria-label", "Language server actions");
    this.diagnosticsView = new DiagnosticsView(this.manager);
    this.sessionMenu = new SessionMenuView(this);
    this.statusElement.addEventListener("click", () => this.sessionMenu.toggle());
    this.statusElement.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.sessionMenu.toggle();
      }
    });
    this.uiSubscriptions.add(this.manager.onDidChangeSession(() => this.updateStatus()));
    this.uiSubscriptions.add(
      atom.workspace.observeActiveTextEditor((editor) => this.observeStatusEditor(editor)),
    );
    this.uiSubscriptions.add(
      atom.commands.add("atom-workspace", {
        "language-client:toggle-problems": () => this.toggleProblems(),
        "language-client:restart": () => this.restart(),
        "language-client:hover": () => this.hover(),
        "language-client:format": () => this.format(),
        "language-client:rename": () => this.rename(),
        "language-client:code-actions": () => this.codeActions(),
        "language-client:show-log": () => this.showLog(),
      }),
    );
  },
  async deactivate() {
    this.panel?.destroy();
    this.diagnosticsView?.destroy();
    this.sessionMenu?.destroy();
    this.indieSubscription?.dispose();
    this.disposeIndieDelegates();
    this.busyProvider?.dispose();
    this.busyProvider = null;
    this.statusEditorSubscriptions?.dispose();
    this.uiSubscriptions?.dispose();
    this.statusElement?.remove();
    await this.manager?.deactivate();
    this.manager = null;
  },
  provideLanguageServer() {
    return {
      registerAdapter: (adapter) => this.manager.registerAdapter(adapter),
      sessionForEditor: (editor) => this.manager.sessionForEditor(editor),
      activeSessionForEditor: (editor) => this.manager.activeSessionForEditor(editor),
      getSessions: () => [...this.manager.sessions.values()],
      onDidChangeSession: (fn) => this.manager.onDidChangeSession(fn),
      onDidPublishDiagnostics: (fn) => this.manager.onDidPublishDiagnostics(fn),
      onDidLog: (fn) => this.manager.onDidLog(fn),
      request: (editor, method, params, options) =>
        this.manager.sessionForEditor(editor)?.request(method, params, options),
      restart: (session) => this.manager.restart(session),
      stop: (session) => session.stop(),
      getLog: (adapterId) => this.manager.getLog(adapterId),
      applyWorkspaceEdit: (edit, label) => this.manager.applyWorkspaceEdit(edit, label),
      openNotebook: (session, notebook, cells) => session.openNotebook(notebook, cells),
      changeNotebook: (session, notebook, change) => session.changeNotebook(notebook, change),
      saveNotebook: (session, notebook) => session.saveNotebook(notebook),
      closeNotebook: (session, notebook, cells) => session.closeNotebook(notebook, cells),
    };
  },
  provideAutocomplete() {
    return this.completionProvider;
  },
  provideSymbols() {
    return this.symbolProvider;
  },
  consumeStatusBar(statusBar) {
    const tile = statusBar.addRightTile({ item: this.statusElement, priority: 500 });
    return { dispose: () => tile.destroy() };
  },
  consumeIndie(registerIndie) {
    this.indieSubscription?.dispose();
    this.disposeIndieDelegates();
    this.indieDelegates = new Map();
    this.diagnosticsView.setExternalProvider(true);
    const publish = ({ session, uri, diagnostics }) => {
      const batch = toLinterMessages(uri, diagnostics);
      if (!batch.filePath) return;
      const adapter = session?.adapter;
      const key = adapter?.id || "unknown";
      let delegate = this.indieDelegates.get(key);
      if (!delegate) {
        delegate = registerIndie({ name: adapter?.displayName || "Language Server" });
        this.indieDelegates.set(key, delegate);
      }
      delegate.setMessages(batch.filePath, batch.messages);
    };
    for (const entry of this.manager.diagnostics.values()) publish(entry);
    this.indieSubscription = this.manager.onDidPublishDiagnostics(publish);
    return {
      dispose: () => {
        this.indieSubscription?.dispose();
        this.indieSubscription = null;
        this.disposeIndieDelegates();
        this.diagnosticsView?.setExternalProvider(false);
      },
    };
  },
  disposeIndieDelegates() {
    for (const delegate of this.indieDelegates?.values() || []) delegate.dispose();
    this.indieDelegates = null;
  },
  consumeBusySignal(registry) {
    this.busyProvider?.dispose();
    this.busyProvider = registry.create();
    this.manager.setBusyProvider(this.busyProvider);
    return new Disposable(() => {
      if (!this.busyProvider) return;
      this.manager.setBusyProvider(null);
      this.busyProvider.dispose();
      this.busyProvider = null;
    });
  },
  observeStatusEditor(editor) {
    this.statusEditorSubscriptions?.dispose();
    this.statusEditorSubscriptions = new CompositeDisposable();
    if (editor) {
      this.statusEditorSubscriptions.add(
        editor.onDidChangeGrammar(() => this.updateStatus()),
        editor.onDidChangePath(() => this.updateStatus()),
        editor.onDidDestroy(() => this.updateStatus()),
      );
    }
    this.updateStatus();
  },
  updateStatus() {
    const editor = atom.workspace.getActiveTextEditor();
    const session = editor && this.manager.sessionForEditor(editor);
    const adapter = editor && this.manager.adapterForEditor(editor);
    if (!adapter) {
      this.statusElement.textContent = "LSP Idle";
      this.statusElement.className = "language-client-status inline-block status-idle";
    } else if (!session) {
      this.statusElement.textContent = `${adapter.displayName} starting...`;
      this.statusElement.className = "language-client-status inline-block status-starting";
    } else {
      this.statusElement.textContent = `${adapter.displayName}`;
      this.statusElement.className = `language-client-status inline-block status-${session.state}`;
    }
    const background = [...this.manager.sessions.values()].filter(
      (candidate) => candidate !== session && candidate.state === "running",
    );
    this.statusElement.title = background.length
      ? `${background.length} language server${background.length === 1 ? "" : "s"} running in the background`
      : "";
  },
  toggleProblems() {
    if (!this.panel)
      this.panel = atom.workspace.addBottomPanel({
        item: this.diagnosticsView.element,
        visible: false,
        priority: 200,
      });
    this.panel.isVisible() ? this.panel.hide() : this.panel.show();
  },
  showProblems() {
    if (this.indieDiagnostics) {
      atom.commands.dispatch(atom.views.getView(atom.workspace), "linter:toggle-panel");
      return;
    }
    if (!this.panel)
      this.panel = atom.workspace.addBottomPanel({
        item: this.diagnosticsView.element,
        visible: false,
        priority: 200,
      });
    this.panel.show();
  },
  active() {
    const editor = atom.workspace.getActiveTextEditor();
    return { editor, session: editor && this.manager.sessionForEditor(editor) };
  },
  async restart() {
    const { session } = this.active();
    if (session) await this.manager.restart(session);
  },
  params(editor) {
    const point = editor.getLastCursor().getBufferPosition();
    return {
      textDocument: { uri: require("url").pathToFileURL(editor.getPath()).href },
      position: { line: point.row, character: point.column },
    };
  },
  async hover() {
    const { editor, session } = this.active();
    if (!session?.capabilities.hoverProvider) return;
    const result = await session.request("textDocument/hover", this.params(editor));
    const value =
      typeof result?.contents === "string"
        ? result.contents
        : result?.contents?.value ||
          (Array.isArray(result?.contents)
            ? result.contents
                .map((part) => (typeof part === "string" ? part : part.value))
                .join("\n")
            : "");
    if (value)
      atom.notifications.addInfo("Language information", { description: value, dismissable: true });
  },
  async format() {
    const { editor, session } = this.active();
    if (!session?.capabilities.documentFormattingProvider) return;
    const uri = this.params(editor).textDocument.uri;
    const edits = await session.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: editor.getTabLength(), insertSpaces: !editor.getSoftTabs() },
    });
    if (edits?.length)
      await this.manager.applyWorkspaceEdit({ changes: { [uri]: edits } }, "Format document");
  },
  async rename() {
    const { editor, session } = this.active();
    if (!session?.capabilities.renameProvider) return;
    const newName = window.prompt("New symbol name");
    if (!newName) return;
    const edit = await session.request("textDocument/rename", { ...this.params(editor), newName });
    if (edit) await this.manager.applyWorkspaceEdit(edit, `Rename to ${newName}`);
  },
  async codeActions() {
    const { editor, session } = this.active();
    if (!session?.capabilities.codeActionProvider) return;
    const range = editor.getSelectedBufferRange();
    const actions = await session.request("textDocument/codeAction", {
      textDocument: this.params(editor).textDocument,
      range: {
        start: { line: range.start.row, character: range.start.column },
        end: { line: range.end.row, character: range.end.column },
      },
      context: { diagnostics: [] },
    });
    if (!actions?.length) return;
    const index = await atom.confirm({
      message: "Language server code actions",
      buttons: actions.map((a) => a.title).concat("Cancel"),
    });
    const action = actions[index];
    if (action?.edit) await this.manager.applyWorkspaceEdit(action.edit, action.title);
    if (action?.command)
      session.request(
        "workspace/executeCommand",
        action.command.command
          ? action.command
          : { command: action.command, arguments: action.arguments },
      );
  },
  async showLog() {
    const { session } = this.active();
    if (!session) return;
    return this.showLogForAdapter(session.adapter.id);
  },
  async showLogForAdapter(adapterId) {
    const editor = await atom.workspace.open();
    editor.setText(this.manager.getLog(adapterId));
    editor.setGrammar(atom.grammars.grammarForScopeName("text.plain.null-grammar"));
  },
};
