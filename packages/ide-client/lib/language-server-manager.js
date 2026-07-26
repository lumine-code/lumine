const path = require("path");
const fs = require("fs");
const { minimatch } = require("minimatch");
const { Emitter, CompositeDisposable, Disposable } = require("atom");
const ServerSession = require("./server-session");
const C = require("./converters");
const { baseCapabilities, mergeCapabilities } = require("./capabilities");
const { languageIdForEditor } = require("./language-ids");

module.exports = class LanguageServerManager {
  constructor() {
    this.adapters = new Map();
    this.adapterSubscriptions = new Map();
    this.sessions = new Map();
    this.dynamicCapabilities = new Map();
    this.capabilityFragments = [];
    this.diagnostics = new Map();
    this.logs = new Map();
    this.editorSubscriptions = new Map();
    this.busyProvider = null;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
  }
  activate() {
    this.knownRoots = atom.project.getPaths();
    this.subscriptions.add(
      atom.workspace.observeTextEditors((editor) => {
        this.watchEditor(editor);
        this.attachEditor(editor);
      }),
      atom.project.onDidChangePaths(() => this.projectPathsChanged()),
      atom.project.onDidChangeFiles((events) => this.routeFileEvents(events)),
    );
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
  // fn({session, kind: "codeLens" | "semanticTokens" | "inlayHint"}) — fired
  // when a server asks the client to re-fetch that feature's data.
  onDidRequestRefresh(fn) {
    return this.emitter.on("did-request-refresh", fn);
  }
  requestRefresh(session, kind) {
    this.emitter.emit("did-request-refresh", { session, kind });
  }
  // Feature modules contribute client-capability fragments before any session
  // starts; the merged result is sent with every initialize request.
  addCapabilityFragment(fragment) {
    if (fragment) this.capabilityFragments.push(fragment);
  }
  buildClientCapabilities() {
    return mergeCapabilities(baseCapabilities(), ...this.capabilityFragments);
  }
  setBusyProvider(provider) {
    this.busyProvider = provider;
  }
  allGrammarScopes() {
    const scopes = new Set();
    for (const adapter of this.adapters.values())
      for (const scope of adapter.grammarScopes) scopes.add(scope);
    return [...scopes];
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
    if (adapter.settingsKeyPaths?.length) {
      const subs = new CompositeDisposable();
      for (const keyPath of adapter.settingsKeyPaths)
        subs.add(atom.config.onDidChange(keyPath, () => this.pushSettingsForAdapter(adapter)));
      this.adapterSubscriptions.set(adapter.id, subs);
    }
    this.emitter.emit("did-register-adapter", adapter);
    for (const editor of atom.workspace.getTextEditors()) this.attachEditor(editor);
    return new Disposable(() => this.unregisterAdapter(adapter));
  }
  async unregisterAdapter(adapter) {
    if (this.adapters.get(adapter.id) !== adapter) return;
    this.adapters.delete(adapter.id);
    this.adapterSubscriptions.get(adapter.id)?.dispose();
    this.adapterSubscriptions.delete(adapter.id);
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
            (filter) => !filter.pattern || this.globMatches(filter.pattern, filePath || ""),
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
  adapterContext(adapter, rootPath) {
    return {
      rootPath,
      projectPaths: atom.project.getPaths(),
      configDirPath: atom.getConfigDirPath(),
      managedStoragePath: path.join(atom.getConfigDirPath(), "language-servers", adapter.id),
    };
  }
  watchEditor(editor) {
    if (this.editorSubscriptions.has(editor)) return;
    const subs = new CompositeDisposable(
      editor.onDidChangeGrammar(() => this.reattachEditor(editor)),
      editor.onDidChangePath(() => this.reattachEditor(editor)),
      editor.onDidDestroy(() => {
        subs.dispose();
        this.editorSubscriptions.delete(editor);
      }),
    );
    this.editorSubscriptions.set(editor, subs);
  }
  reattachEditor(editor) {
    for (const session of this.sessions.values()) session.detachEditor(editor);
    return this.attachEditor(editor);
  }
  async attachEditor(editor) {
    const filePath = editor.getPath();
    if (!filePath) return;
    const adapter = this.adapterForEditor(editor);
    if (!adapter) return;
    const rootPath = this.rootForPath(filePath, adapter);
    const key = `${adapter.id}:${rootPath}`;
    let session = this.sessions.get(key);
    if (!session) {
      let launch;
      try {
        launch = await adapter.resolveServer(this.adapterContext(adapter, rootPath));
      } catch (error) {
        return this.reportStartFailure(adapter, rootPath, error);
      }
      if (!launch) return;
      if (this.sessions.has(key)) return this.attachEditor(editor);
      session = new ServerSession(this, adapter, rootPath, launch);
      this.sessions.set(key, session);
      session.ready = session.start();
      session.ready.catch(() => {});
    }
    try {
      await session.ready;
      if (this.sessions.get(key) !== session) return;
      await session.openEditor(editor);
    } catch (error) {
      if (this.sessions.get(key) === session) {
        this.sessions.delete(key);
        session.stop();
      }
      this.reportStartFailure(adapter, rootPath, error);
    }
  }
  reportStartFailure(adapter, rootPath, error) {
    this.log({ adapter, rootPath }, error.stack || error.message);
    atom.notifications.addError(`Unable to start ${adapter.displayName}`, {
      detail: error.message,
      dismissable: true,
    });
  }
  sessionForEditor(editor) {
    const adapter = this.adapterForEditor(editor);
    if (!adapter || !editor.getPath()) return null;
    return (
      this.sessions.get(`${adapter.id}:${this.rootForPath(editor.getPath(), adapter)}`) || null
    );
  }
  // Resolves once the session for this editor finished starting; null when
  // there is no adapter, the server failed, or it is not running yet.
  async activeSessionForEditor(editor) {
    const session = this.sessionForEditor(editor);
    if (!session) return null;
    try {
      await session.ready;
    } catch {
      return null;
    }
    return session.state === "running" ? session : null;
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
  // Returns true/false when dynamic registrations govern the method for this
  // editor, undefined when none do (static capability applies).
  dynamicSupport(session, method, editor) {
    const registrations = this.dynamicCapabilities.get(session);
    if (!registrations) return undefined;
    let found;
    for (const item of registrations.values()) {
      if (item.method !== method) continue;
      found = false;
      const selector = item.registerOptions?.documentSelector;
      if (!selector || this.selectorMatches(selector, session, editor)) return true;
    }
    return found;
  }
  selectorMatches(selector, session, editor) {
    if (!editor) return true;
    const filePath = editor.getPath() || "";
    const languageId = languageIdForEditor(session.adapter, editor);
    return selector.some((filter) => {
      if (typeof filter === "string") return filter === languageId;
      if (filter.scheme && filter.scheme !== "file") return false;
      if (filter.language && filter.language !== languageId) return false;
      if (filter.pattern && !this.globMatches(filter.pattern, filePath)) return false;
      return !!(filter.language || filter.pattern || filter.scheme);
    });
  }
  globMatches(globPattern, filePath) {
    if (!globPattern || !filePath) return false;
    const normalized = filePath.replaceAll("\\", "/");
    if (typeof globPattern === "string") {
      return (
        minimatch(normalized, globPattern, { dot: true }) ||
        minimatch(normalized, `**/${globPattern}`, { dot: true })
      );
    }
    const base = C.uriToPath(globPattern.baseUri?.uri || globPattern.baseUri);
    if (!base) return false;
    const relative = path.relative(base, filePath);
    if (!relative || relative.startsWith("..")) return false;
    return minimatch(relative.replaceAll("\\", "/"), globPattern.pattern, { dot: true });
  }
  // Watched-file events are limited to paths under the project roots â€” that is
  // the scope of atom.project.onDidChangeFiles.
  routeFileEvents(events) {
    for (const [session, registrations] of this.dynamicCapabilities) {
      if (session.state !== "running") continue;
      const watchers = [];
      for (const item of registrations.values())
        if (item.method === "workspace/didChangeWatchedFiles")
          watchers.push(...(item.registerOptions?.watchers || []));
      if (!watchers.length) continue;
      const changes = [];
      const push = (filePath, type) => {
        const kindBit = type === 1 ? 1 : type === 2 ? 2 : 4;
        const matched = watchers.some(
          (watcher) =>
            ((watcher.kind ?? 7) & kindBit) !== 0 &&
            this.globMatches(watcher.globPattern, filePath),
        );
        if (matched) changes.push({ uri: C.pathToUri(filePath), type });
      };
      for (const event of events) {
        if (event.action === "created") push(event.path, 1);
        else if (event.action === "modified") push(event.path, 2);
        else if (event.action === "deleted") push(event.path, 3);
        else if (event.action === "renamed") {
          if (event.oldPath) push(event.oldPath, 3);
          push(event.path, 1);
        }
      }
      if (changes.length) session.notify("workspace/didChangeWatchedFiles", { changes });
    }
  }
  projectPathsChanged() {
    const roots = atom.project.getPaths();
    const toFolder = (root) => ({ uri: C.pathToUri(root), name: path.basename(root) });
    const added = roots.filter((root) => !this.knownRoots.includes(root)).map(toFolder);
    const removed = this.knownRoots.filter((root) => !roots.includes(root)).map(toFolder);
    this.knownRoots = roots;
    if (added.length || removed.length) {
      for (const session of this.sessions.values()) {
        if (
          session.state === "running" &&
          session.capabilities.workspace?.workspaceFolders?.changeNotifications
        )
          session.notify("workspace/didChangeWorkspaceFolders", { event: { added, removed } });
      }
    }
    this.reconcileProjects();
  }
  pushSettingsForAdapter(adapter) {
    for (const session of this.sessions.values())
      if (session.adapter === adapter && session.state === "running") session.pushSettings();
  }
  handleProgress(session, { token, value }) {
    if (!value) return;
    const titles = session.progressTitles;
    if (value.kind === "begin") {
      const base = `${session.adapter.displayName}: ${value.title}`;
      titles.set(token, { base, current: base });
      this.busyProvider?.add(base);
    } else if (value.kind === "report") {
      const entry = titles.get(token);
      if (!entry || !value.message) return;
      const next = `${entry.base} (${value.message})`;
      this.busyProvider?.changeTitle(next, entry.current);
      entry.current = next;
    } else if (value.kind === "end") {
      const entry = titles.get(token);
      if (!entry) return;
      titles.delete(token);
      this.busyProvider?.remove(entry.current);
    }
    this.log(session, `progress ${value.kind}: ${value.title || value.message || token}`);
  }
  clearProgress(session) {
    for (const entry of session.progressTitles.values()) this.busyProvider?.remove(entry.current);
    session.progressTitles.clear();
  }
  trace(session, direction, message) {
    const level = atom.config.get("ide-client.trace");
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
    const limit = atom.config.get("ide-client.restartLimit");
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
      await session.adapter.resolveServer(this.adapterContext(session.adapter, session.rootPath)),
    );
    this.sessions.set(key, replacement);
    replacement.ready = replacement.start();
    replacement.ready.catch(() => {});
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
    for (const subs of this.editorSubscriptions.values()) subs.dispose();
    this.editorSubscriptions.clear();
    for (const subs of this.adapterSubscriptions.values()) subs.dispose();
    this.adapterSubscriptions.clear();
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    this.sessions.clear();
    this.emitter.dispose();
  }
};
