const path = require("path");
const fs = require("fs");
const { Emitter, CompositeDisposable, Disposable } = require("atom");
const ServerSession = require("./server-session");
const C = require("./converters");

module.exports = class LanguageServerManager {
  constructor() {
    this.adapters = new Map();
    this.sessions = new Map();
    this.dynamicCapabilities = new Map();
    this.diagnostics = new Map();
    this.logs = new Map();
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
  }
  activate() {
    this.subscriptions.add(
      atom.workspace.observeTextEditors((editor) => this.attachEditor(editor)),
    );
    this.subscriptions.add(atom.project.onDidChangePaths(() => this.reconcileProjects()));
  }
  onDidChangeSession(fn) {
    return this.emitter.on("did-change-session", fn);
  }
  onDidPublishDiagnostics(fn) {
    return this.emitter.on("did-publish-diagnostics", fn);
  }
  onDidLog(fn) {
    return this.emitter.on("did-log", fn);
  }
  registerAdapter(adapter) {
    const faults = ["id", "displayName"].filter((key) => !adapter?.[key]);
    if (!Array.isArray(adapter?.grammarScopes) || !adapter.grammarScopes.length)
      faults.push("grammarScopes");
    if (typeof adapter?.resolveServer !== "function") faults.push("resolveServer");
    if (faults.length) throw new TypeError(`Invalid language-server adapter: ${faults.join(", ")}`);
    if (this.adapters.has(adapter.id))
      throw new Error(`Language-server adapter '${adapter.id}' is already registered`);
    this.adapters.set(adapter.id, adapter);
    this.emitter.emit("did-register-adapter", adapter);
    for (const editor of atom.workspace.getTextEditors()) this.attachEditor(editor);
    return new Disposable(() => this.unregisterAdapter(adapter));
  }
  async unregisterAdapter(adapter) {
    if (this.adapters.get(adapter.id) !== adapter) return;
    this.adapters.delete(adapter.id);
    await Promise.all(
      [...this.sessions]
        .filter(([key]) => key.startsWith(`${adapter.id}:`))
        .map(async ([key, session]) => {
          this.sessions.delete(key);
          await session.stop();
        }),
    );
  }
  adapterForEditor(editor) {
    const scope = editor.getGrammar()?.scopeName;
    const filePath = editor.getPath();
    return [...this.adapters.values()].find(
      (adapter) =>
        adapter.grammarScopes.includes(scope) &&
        (!adapter.documentSelector ||
          adapter.documentSelector.some(
            (filter) =>
              !filter.pattern || require("minimatch").minimatch(filePath || "", filter.pattern),
          )),
    );
  }
  rootForPath(filePath, adapter) {
    const roots = atom.project.getPaths();
    if (adapter.sessionScope === "workspace") return roots[0] || path.dirname(filePath);
    return (
      roots
        .filter((root) => filePath === root || filePath.startsWith(root + path.sep))
        .sort((a, b) => b.length - a.length)[0] || path.dirname(filePath)
    );
  }
  async attachEditor(editor) {
    const filePath = editor.getPath();
    if (!filePath) return;
    const adapter = this.adapterForEditor(editor);
    if (!adapter) return;
    const rootPath = this.rootForPath(filePath, adapter);
    const key = `${adapter.id}:${rootPath}`;
    try {
      let session = this.sessions.get(key);
      if (!session) {
        const launch = await adapter.resolveServer({
          rootPath,
          projectPaths: atom.project.getPaths(),
          configDirPath: atom.getConfigDirPath(),
          managedStoragePath: path.join(atom.getConfigDirPath(), "language-servers", adapter.id),
        });
        if (!launch) return;
        session = new ServerSession(this, adapter, rootPath, launch);
        this.sessions.set(key, session);
        session.ready = session.start();
      }
      await session.ready;
      await session.openEditor(editor);
    } catch (error) {
      this.log({ adapter, rootPath }, error.stack || error.message);
      atom.notifications.addError(`Unable to start ${adapter.displayName}`, {
        detail: error.message,
        dismissable: true,
      });
    }
  }
  sessionForEditor(editor) {
    const adapter = this.adapterForEditor(editor);
    if (!adapter || !editor.getPath()) return null;
    return (
      this.sessions.get(`${adapter.id}:${this.rootForPath(editor.getPath(), adapter)}`) || null
    );
  }
  didChangeSession(session, error) {
    this.emitter.emit("did-change-session", { session, state: session.state, error });
  }
  publishDiagnostics(session, params) {
    this.diagnostics.set(params.uri, { session, ...params });
    this.emitter.emit("did-publish-diagnostics", { session, ...params });
  }
  clearDiagnosticsForSession(session) {
    for (const [uri, entry] of this.diagnostics) {
      if (entry.session !== session) continue;
      this.diagnostics.delete(uri);
      this.emitter.emit("did-publish-diagnostics", {
        session,
        uri,
        diagnostics: [],
      });
    }
  }
  registerCapabilities(session, registrations = []) {
    const map = this.dynamicCapabilities.get(session) || new Map();
    for (const item of registrations) map.set(item.id, item);
    this.dynamicCapabilities.set(session, map);
  }
  unregisterCapabilities(session, registrations = []) {
    const map = this.dynamicCapabilities.get(session);
    for (const item of registrations || []) map?.delete(item.id);
  }
  trace(session, direction, message) {
    const level = atom.config.get("language-client.trace");
    if (level === "off") return;
    const copy =
      level === "verbose"
        ? message
        : { id: message.id, method: message.method, error: message.error };
    this.log(session, `${direction} ${JSON.stringify(copy)}`);
  }
  log(session, message) {
    const id = session.adapter?.id || "unknown";
    const entries = this.logs.get(id) || [];
    entries.push(`[${new Date().toISOString()}] ${String(message).trim()}`);
    if (entries.length > 2000) entries.shift();
    this.logs.set(id, entries);
    this.emitter.emit("did-log", { session, message });
  }
  getLog(adapterId) {
    return (this.logs.get(adapterId) || []).join("\n");
  }
  showMessage(type, message) {
    const methods = { 1: "addError", 2: "addWarning", 3: "addInfo", 4: "addInfo" };
    atom.notifications[methods[type] || "addInfo"](message);
  }
  async showMessageRequest(type, message, actions) {
    const buttons = actions.map((action) => action.title).concat("Cancel");
    const selected = await atom.confirm({
      type: type === 1 ? "error" : type === 2 ? "warning" : "info",
      message,
      buttons,
    });
    return selected < actions.length ? actions[selected] : null;
  }
  async showDocument({ uri, selection, external, takeFocus }) {
    try {
      if (external) {
        atom.openExternal(uri);
        return { success: true };
      }
      const filePath = C.uriToPath(uri);
      if (!filePath) return { success: false };
      const editor = await atom.workspace.open(filePath, { activateItem: takeFocus !== false });
      if (selection && editor?.setSelectedBufferRange)
        editor.setSelectedBufferRange(C.rangeFromLsp(selection), { autoscroll: true });
      return { success: true };
    } catch {
      return { success: false };
    }
  }
  async applyWorkspaceEdit(edit, label) {
    const documentChanges =
      edit.documentChanges ||
      Object.entries(edit.changes || {}).map(([uri, edits]) => ({ textDocument: { uri }, edits }));
    const destructive = documentChanges.some(
      (change) => change.kind === "delete" || change.kind === "rename",
    );
    if (destructive) {
      const choice = await atom.confirm({
        type: "warning",
        message: label || "The language server wants to rename or delete files",
        detailedMessage: "Review your version-control diff after applying this operation.",
        buttons: ["Apply", "Cancel"],
      });
      if (choice !== 0) return false;
    }
    try {
      for (const change of documentChanges) {
        if (change.kind === "create") {
          const target = C.uriToPath(change.uri);
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          if (!change.options?.ignoreIfExists || !fs.existsSync(target))
            await fs.promises.writeFile(target, "", {
              flag: change.options?.overwrite ? "w" : "wx",
            });
          continue;
        }
        if (change.kind === "rename") {
          await fs.promises.rename(C.uriToPath(change.oldUri), C.uriToPath(change.newUri));
          continue;
        }
        if (change.kind === "delete") {
          const target = C.uriToPath(change.uri);
          await fs.promises.rm(target, {
            recursive: !!change.options?.recursive,
            force: !!change.options?.ignoreIfNotExists,
          });
          continue;
        }
        const filePath = C.uriToPath(change.textDocument?.uri);
        if (!filePath) continue;
        const editor =
          atom.workspace.getTextEditors().find((item) => item.getPath() === filePath) ||
          (await atom.workspace.open(filePath, { activateItem: false, pending: true }));
        editor.transact(() =>
          [...change.edits]
            .sort(
              (a, b) =>
                b.range.start.line - a.range.start.line ||
                b.range.start.character - a.range.start.character,
            )
            .forEach((textEdit) =>
              editor.setTextInBufferRange(C.rangeFromLsp(textEdit.range), textEdit.newText),
            ),
        );
      }
      return true;
    } catch (error) {
      atom.notifications.addError("Language server edit failed", {
        detail: error.message,
        dismissable: true,
      });
      return false;
    }
  }
  scheduleRestart(session) {
    const limit = atom.config.get("language-client.restartLimit");
    if (session.restartCount >= limit) return;
    const delay = Math.min(1000 * 2 ** session.restartCount++, 30000);
    setTimeout(async () => {
      if (!this.sessions.has(`${session.adapter.id}:${session.rootPath}`)) return;
      try {
        await this.restart(session);
      } catch (error) {
        this.log(session, error.stack || error);
        this.scheduleRestart(session);
      }
    }, delay);
  }
  async restart(session) {
    const key = `${session.adapter.id}:${session.rootPath}`;
    await session.stop();
    const replacement = new ServerSession(
      this,
      session.adapter,
      session.rootPath,
      await session.adapter.resolveServer({
        rootPath: session.rootPath,
        projectPaths: atom.project.getPaths(),
        configDirPath: atom.getConfigDirPath(),
        managedStoragePath: path.join(
          atom.getConfigDirPath(),
          "language-servers",
          session.adapter.id,
        ),
      }),
    );
    this.sessions.set(key, replacement);
    replacement.ready = replacement.start();
    await replacement.ready;
    for (const editor of atom.workspace.getTextEditors()) await this.attachEditor(editor);
    return replacement;
  }
  async disconnect(session) {
    const key = `${session.adapter.id}:${session.rootPath}`;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    await session.stop();
  }
  reconcileProjects() {
    const roots = atom.project.getPaths();
    for (const [key, session] of this.sessions)
      if (session.adapter.sessionScope !== "workspace" && !roots.includes(session.rootPath)) {
        this.sessions.delete(key);
        session.stop();
      }
  }
  async deactivate() {
    this.subscriptions.dispose();
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    this.sessions.clear();
    this.emitter.dispose();
  }
};
