const LanguageServerManager = require("./language-server-manager");
const CompletionProvider = require("./completion-provider");
const SymbolProvider = require("./symbol-provider");
const HoverProvider = require("./hover-provider");
const SignatureProvider = require("./signature-provider");
const OutlineProvider = require("./outline-provider");
const CodeFormatProvider = require("./code-format-provider");
const ReferencesProvider = require("./references-provider");
const RefactorProvider = require("./refactor-provider");
const IntentionsProvider = require("./intentions-provider");
const ViewportTracker = require("./viewport-tracker");
const CodeLens = require("./code-lens");
const SemanticTokens = require("./semantic-tokens");
const InlayHints = require("./inlay-hints");
const SessionMenuView = require("./session-menu-view");
const CustomServers = require("./custom-servers");
const { toLinterMessages } = require("./linter-messages");
const { CompositeDisposable, Disposable } = require("atom");

module.exports = {
  activate() {
    this.manager = new LanguageServerManager();
    this.completionProvider = new CompletionProvider(this.manager);
    this.symbolProvider = new SymbolProvider(this.manager);
    this.hoverProvider = new HoverProvider(this.manager);
    this.signatureProvider = new SignatureProvider(this.manager);
    this.outlineProvider = new OutlineProvider(this.manager);
    this.codeFormatProvider = new CodeFormatProvider(this.manager);
    this.referencesProvider = new ReferencesProvider(this.manager);
    this.refactorProvider = new RefactorProvider(this.manager);
    this.intentionsProvider = new IntentionsProvider(this.manager);
    // Constructed before activate() so their capability fragments are merged
    // into the initialize handshake of every session.
    this.viewportTracker = new ViewportTracker();
    this.codeLens = new CodeLens(this.manager, this.viewportTracker);
    this.semanticTokens = new SemanticTokens(this.manager, this.viewportTracker);
    this.inlayHints = new InlayHints(this.manager, this.viewportTracker);
    this.manager.activate();
    this.customServers = new CustomServers(this.manager);
    this.customServers.activate();
    this.uiSubscriptions = new CompositeDisposable();
    this.sessionMenu = new SessionMenuView(this);
    // Running servers are long-lived, so they belong in the busy-signal
    // background zone rather than in a status item of their own.
    this.uiSubscriptions.add(this.manager.onDidChangeSession(() => this.publishSessions()));
    this.uiSubscriptions.add(
      atom.commands.add("atom-workspace", {
        "ide-client:servers": () => this.sessionMenu.toggle(),
        "ide-client:toggle-problems": () => this.showProblems(),
        "ide-client:restart": () => this.restart(),
        "ide-client:format": () => this.format(),
        "ide-client:show-log": () => this.showLog(),
        "ide-client:open-custom-servers-file": () => this.customServers.openFile(),
      }),
    );
  },
  async deactivate() {
    this.codeLens?.dispose();
    this.codeLens = null;
    this.semanticTokens?.dispose();
    this.semanticTokens = null;
    this.inlayHints?.dispose();
    this.inlayHints = null;
    this.viewportTracker?.dispose();
    this.viewportTracker = null;
    this.customServers?.dispose();
    this.customServers = null;
    this.sessionMenu?.destroy();
    this.indieSubscription?.dispose();
    this.disposeIndieDelegates();
    this.busyProvider?.dispose();
    this.busyProvider = null;
    this.backgroundProvider?.dispose();
    this.backgroundProvider = null;
    this.uiSubscriptions?.dispose();
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
  provideSymbol() {
    return this.symbolProvider;
  },
  provideHover() {
    return this.hoverProvider;
  },
  provideHoverSignature() {
    return this.signatureProvider;
  },
  provideOutline() {
    return this.outlineProvider;
  },
  provideCodeFormatRange() {
    return this.codeFormatProvider.rangeProvider();
  },
  provideCodeFormatFile() {
    return this.codeFormatProvider.fileProvider();
  },
  provideCodeFormatOnType() {
    return this.codeFormatProvider.onTypeProvider();
  },
  provideCodeFormatOnSave() {
    return this.codeFormatProvider.onSaveProvider();
  },
  provideFindReferences() {
    return this.referencesProvider;
  },
  provideRefactor() {
    return this.refactorProvider;
  },
  provideIntentionsList() {
    return this.intentionsProvider;
  },
  consumeBusySignalBackgroundRegistry(registry) {
    this.backgroundProvider?.dispose();
    this.backgroundProvider = registry.create();
    this.publishSessions();
    return new Disposable(() => {
      this.backgroundProvider?.dispose();
      this.backgroundProvider = null;
    });
  },
  // Mirrors the live sessions into the background zone: one entry per server
  // and project root, upserted as its state changes.
  publishSessions() {
    if (!this.backgroundProvider) return;
    const live = new Set();
    for (const [key, session] of this.manager.sessions) {
      live.add(key);
      this.backgroundProvider.set(`ide-client:${key}`, {
        title: session.adapter.displayName,
        detail: session.rootPath,
        status: session.state,
      });
    }
    for (const key of this.publishedSessions || [])
      if (!live.has(key)) this.backgroundProvider.remove(`ide-client:${key}`);
    this.publishedSessions = live;
  },
  consumeIndie(registerIndie) {
    this.indieSubscription?.dispose();
    this.disposeIndieDelegates();
    this.indieDelegates = new Map();
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
    for (const entry of this.manager.allDiagnostics()) publish(entry);
    this.indieSubscription = this.manager.onDidPublishDiagnostics(publish);
    return {
      dispose: () => {
        this.indieSubscription?.dispose();
        this.indieSubscription = null;
        this.disposeIndieDelegates();
      },
    };
  },
  disposeIndieDelegates() {
    for (const delegate of this.indieDelegates?.values() || []) delegate.dispose();
    this.indieDelegates = null;
  },
  consumeBusySignalRegistry(registry) {
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
  // Diagnostics render through the linter package; this only opens its panel.
  showProblems() {
    if (this.indieDelegates) {
      atom.commands.dispatch(atom.views.getView(atom.workspace), "linter:toggle-panel");
    } else {
      atom.notifications.addInfo("Install the linter package to browse language-server problems.");
    }
  },
  active() {
    const editor = atom.workspace.getActiveTextEditor();
    return { editor, session: editor && this.manager.sessionForEditor(editor) };
  },
  // Restarts every server serving the active editor, since more than one can
  // be attached to it.
  async restart() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;
    const sessions = this.manager.sessionsForEditor(editor);
    await Promise.all(sessions.map((session) => this.manager.restart(session)));
  },
  async format() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;
    const edits = await this.codeFormatProvider.formatFile(editor);
    if (!edits.length) return;
    editor.transact(() => {
      for (const edit of [...edits].sort(
        (a, b) => b.oldRange[0][0] - a.oldRange[0][0] || b.oldRange[0][1] - a.oldRange[0][1],
      ))
        editor.setTextInBufferRange(edit.oldRange, edit.newText);
    });
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
