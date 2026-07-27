const path = require("path");
const fs = require("fs");
const picomatch = require("picomatch");
const { Emitter, CompositeDisposable, Disposable } = require("atom");
const ServerSession = require("./server-session");
const C = require("./converters");
const { baseCapabilities, mergeCapabilities } = require("./capabilities");
const { languageIdForEditor } = require("./language-ids");

// Grace period before a session with no documents left is reclaimed.
const IDLE_SHUTDOWN_MS = 1000;

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
    // Pending checks for sessions whose last document just closed.
    this.idleChecks = new Map();
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
    const owned = new Set(
      this.allSessions().filter((session) => session.adapter.id === adapter.id),
    );
    await Promise.all(
      [...owned].map(async (session) => {
        this.forget(session);
        await session.stop();
      }),
    );
  }
  // Every adapter that serves this editor. More than one is normal and
  // intended: a type checker and a linter/formatter commonly cover the same
  // grammar, and both run.
  adaptersForEditor(editor) {
    const scope = editor.getGrammar()?.scopeName;
    const filePath = editor.getPath();
    return [...this.adapters.values()].filter(
      (adapter) =>
        adapter.grammarScopes.includes(scope) &&
        (!adapter.documentSelector ||
          adapter.documentSelector.some(
            (filter) => !filter.pattern || this.globMatches(filter.pattern, filePath || ""),
          )),
    );
  }
  adapterForEditor(editor) {
    return this.adaptersForEditor(editor)[0];
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
  // A project-root session is identified by the root it serves. A
  // workspace-scoped one serves the whole window, so its identity must not
  // move when `roots[0]` does: it keeps whichever root it started with as its
  // `rootUri` and hears about the rest through `didChangeWorkspaceFolders`.
  keyFor(adapter, rootPath) {
    return adapter.sessionScope === "workspace" ? `${adapter.id}:` : `${adapter.id}:${rootPath}`;
  }
  // A session that adopted folders is reachable under one key per folder, so
  // anything walking the sessions themselves has to go through here.
  allSessions() {
    return [...new Set(this.sessions.values())];
  }
  // The project folders a session answers for. A workspace-scoped one answers
  // for all of them and only happens to have started at the first, so its own
  // `rootPath` says nothing about its reach.
  foldersFor(session) {
    if (session.adapter.sessionScope !== "workspace") return [...session.folders];
    const roots = atom.project.getPaths();
    return roots.length ? roots : [session.rootPath];
  }
  // What a session covers: the window as a whole, one or more project roots,
  // or the directory of a file opened outside the project.
  scopeFor(session) {
    if (session.adapter.sessionScope === "workspace") return "workspace";
    const roots = atom.project.getPaths();
    return [...session.folders].some((folder) => roots.includes(folder)) ? "root" : "file";
  }
  keysFor(session) {
    return [...this.sessions].filter(([, value]) => value === session).map(([key]) => key);
  }
  forget(session) {
    for (const key of this.keysFor(session)) this.sessions.delete(key);
  }
  folderOf(rootPath) {
    return { uri: C.pathToUri(rootPath), name: path.basename(rootPath) };
  }
  // Whether a running server can take on a project folder it was not started
  // with. `supported` alone only means it read the list at initialize; adding
  // one afterwards needs the change notification as well.
  acceptsFolders(session) {
    const folders = session.capabilities.workspace?.workspaceFolders;
    return !!folders?.supported && !!folders.changeNotifications;
  }
  // A server that declares multi-root support does not need a second process
  // for a second project folder — it is told about the folder instead. The
  // capabilities say which servers those are, so no adapter has to declare it.
  async adoptFolder(adapter, rootPath, key) {
    if (adapter.sessionScope === "workspace") return null;
    for (const session of this.allSessions()) {
      if (session.adapter !== adapter || session.folders.has(rootPath)) continue;
      try {
        await session.ready;
      } catch {
        continue;
      }
      // Another attach for the same root won the race while we were waiting.
      if (this.sessions.has(key)) return this.sessions.get(key);
      if (session.state !== "running" || !this.acceptsFolders(session)) continue;
      session.folders.add(rootPath);
      this.sessions.set(key, session);
      session.notify("workspace/didChangeWorkspaceFolders", {
        event: { added: [this.folderOf(rootPath)], removed: [] },
      });
      this.didChangeSession(session);
      return session;
    }
    return null;
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
    for (const session of this.allSessions()) session.detachEditor(editor);
    return this.attachEditor(editor);
  }
  async attachEditor(editor) {
    const filePath = editor.getPath();
    if (!filePath) return;
    await Promise.all(
      this.adaptersForEditor(editor).map((adapter) => this.attachAdapter(adapter, editor)),
    );
  }
  async attachAdapter(adapter, editor) {
    const filePath = editor.getPath();
    const rootPath = this.rootForPath(filePath, adapter);
    const key = this.keyFor(adapter, rootPath);
    let session = this.sessions.get(key) || (await this.adoptFolder(adapter, rootPath, key));
    if (!session) {
      let launch;
      try {
        launch = await adapter.resolveServer(this.adapterContext(adapter, rootPath));
      } catch (error) {
        return this.reportStartFailure(adapter, rootPath, error);
      }
      if (!launch) return;
      // Another attach for the same adapter and root won the race while we
      // were resolving; retry against the session it created.
      if (this.sessions.has(key)) return this.attachAdapter(adapter, editor);
      session = new ServerSession(this, adapter, rootPath, launch);
      this.sessions.set(key, session);
      // The session exists now; state changes alone never say so, and it stays
      // "starting" until the handshake finishes.
      this.didChangeSession(session);
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
  // Every session serving this editor, in adapter registration order.
  sessionsForEditor(editor) {
    const filePath = editor.getPath();
    if (!filePath) return [];
    return this.adaptersForEditor(editor)
      .map((adapter) =>
        this.sessions.get(this.keyFor(adapter, this.rootForPath(filePath, adapter))),
      )
      .filter(Boolean);
  }
  sessionForEditor(editor) {
    return this.sessionsForEditor(editor)[0] || null;
  }
  // Resolves once each session for this editor finished starting, keeping only
  // the ones that are running.
  async activeSessionsForEditor(editor) {
    const sessions = await Promise.all(
      this.sessionsForEditor(editor).map(async (session) => {
        try {
          await session.ready;
        } catch {
          return null;
        }
        return session.state === "running" ? session : null;
      }),
    );
    return sessions.filter(Boolean);
  }
  // The first running session that can serve `method` for this editor. Used by
  // the features where several answers cannot sensibly be combined — a single
  // rename, one formatting result, one outline.
  async activeSessionForFeature(editor, method) {
    const sessions = await this.activeSessionsForEditor(editor);
    return sessions.find((session) => session.supports(method, editor)) || null;
  }
  async activeSessionForEditor(editor) {
    return (await this.activeSessionsForEditor(editor))[0] || null;
  }
  didChangeSession(session, error) {
    this.emitter.emit("did-change-session", { session, state: session.state, error });
  }
  // Diagnostics are stored per session as well as per document: several
  // servers commonly report on the same file, and one must not erase another.
  publishDiagnostics(session, params) {
    const byUri = this.diagnostics.get(session) || new Map();
    byUri.set(params.uri, { session, ...params });
    this.diagnostics.set(session, byUri);
    this.emitter.emit("did-publish-diagnostics", { session, ...params });
  }
  diagnosticsFor(session, uri) {
    return this.diagnostics.get(session)?.get(uri)?.diagnostics || [];
  }
  allDiagnostics() {
    return [...this.diagnostics.values()].flatMap((byUri) => [...byUri.values()]);
  }
  clearDiagnosticsForSession(session) {
    const byUri = this.diagnostics.get(session);
    if (!byUri) return;
    this.diagnostics.delete(session);
    for (const uri of byUri.keys())
      this.emitter.emit("did-publish-diagnostics", { session, uri, diagnostics: [] });
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
        picomatch.isMatch(normalized, globPattern, { dot: true }) ||
        picomatch.isMatch(normalized, `**/${globPattern}`, { dot: true })
      );
    }
    const base = C.uriToPath(globPattern.baseUri?.uri || globPattern.baseUri);
    if (!base) return false;
    const relative = path.relative(base, filePath);
    // An absolute result means the two paths share no root at all — a different
    // Windows drive or UNC server — which `..` does not express.
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return picomatch.isMatch(relative.replaceAll("\\", "/"), globPattern.pattern, { dot: true });
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
    // Only a workspace-scoped session answers for the project as a whole. The
    // others hear about exactly the folders they take on or lose, from
    // `adoptFolder` and `reconcileProjects`.
    if (added.length || removed.length) {
      for (const session of this.allSessions()) {
        if (
          session.state === "running" &&
          session.adapter.sessionScope === "workspace" &&
          session.capabilities.workspace?.workspaceFolders?.changeNotifications
        )
          session.notify("workspace/didChangeWorkspaceFolders", { event: { added, removed } });
      }
    }
    this.reconcileProjects();
    this.rerouteEditorsToTheirRoots();
  }
  // Which session serves an editor follows from its root, so adding or
  // removing a project folder can move it. A file that gained a root belongs
  // to that root's session now rather than the one keyed to its own directory,
  // and a file whose root was just removed has had its server stopped from
  // under it by `reconcileProjects` and needs another.
  rerouteEditorsToTheirRoots() {
    for (const editor of atom.workspace.getTextEditors()) {
      const filePath = editor.getPath();
      if (!filePath) continue;
      const uri = C.pathToUri(filePath);
      const wanted = new Set(this.sessionsForEditor(editor));
      const attached = this.allSessions().filter((session) => session.documents.has(uri));
      if (attached.length !== wanted.size || attached.some((session) => !wanted.has(session))) {
        this.reattachEditor(editor);
      } else if (!attached.length) {
        this.attachEditor(editor);
      }
    }
  }
  pushSettingsForAdapter(adapter) {
    for (const session of this.allSessions())
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
      if (!this.keysFor(session).length) return;
      try {
        await this.restart(session);
      } catch (error) {
        this.log(session, error.stack || error);
        this.scheduleRestart(session);
      }
    }, delay);
  }
  async restart(session) {
    const keys = this.keysFor(session);
    await session.stop();
    const replacement = new ServerSession(
      this,
      session.adapter,
      session.rootPath,
      await session.adapter.resolveServer(this.adapterContext(session.adapter, session.rootPath)),
    );
    // The replacement inherits the folders, so every editor the old session
    // served finds it under the same key.
    replacement.folders = new Set(session.folders);
    for (const key of keys) this.sessions.set(key, replacement);
    this.didChangeSession(replacement);
    replacement.ready = replacement.start();
    replacement.ready.catch(() => {});
    await replacement.ready;
    for (const editor of atom.workspace.getTextEditors()) await this.attachEditor(editor);
    return replacement;
  }
  async disconnect(session) {
    this.forget(session);
    await session.stop();
  }
  // A session outlives the editors it serves on purpose: reopening a file in a
  // project should not pay for another server start. That only holds while
  // something can still reach it — a session rooted at a project path waits for
  // the next editor there. One rooted at a lone file's directory, opened with
  // no project, can never be reached again once that editor is gone, so it is
  // shut down instead of idling for the life of the window.
  didCloseDocument(session) {
    if (this.idleChecks.has(session)) return;
    const timer = setTimeout(() => {
      this.idleChecks.delete(session);
      this.stopIfUnreachable(session);
      // Long enough that closing an editor to immediately reopen it — a save
      // under a new name, a grammar change — does not restart the server.
    }, IDLE_SHUTDOWN_MS);
    this.idleChecks.set(session, timer);
  }
  stopIfUnreachable(session) {
    if (session.state === "stopped" || session.state === "stopping") return;
    if (session.documents.size > 0) return;
    const roots = atom.project.getPaths();
    // A workspace-scoped session answers for every root, so it stays warm as
    // long as the window has one, whatever its own `rootPath` says. Any other
    // session waits for the next editor under a folder it still answers for.
    if (
      session.adapter.sessionScope === "workspace"
        ? roots.length
        : [...session.folders].some((folder) => roots.includes(folder))
    )
      return;
    const stillServesAnEditor = atom.workspace
      .getTextEditors()
      .some((editor) => this.sessionsForEditor(editor).includes(session));
    if (stillServesAnEditor) return;
    this.disconnect(session);
  }
  cancelIdleChecks() {
    for (const timer of this.idleChecks.values()) clearTimeout(timer);
    this.idleChecks.clear();
  }
  // A folder that left the project takes its key with it. A session that held
  // more than one survives on the folders it has left; one that held only the
  // departed folder has nothing to answer for and stops.
  reconcileProjects() {
    const roots = atom.project.getPaths();
    for (const session of this.allSessions()) {
      if (session.adapter.sessionScope === "workspace") continue;
      const gone = [...session.folders].filter((folder) => !roots.includes(folder));
      if (!gone.length) continue;
      if (gone.length === session.folders.size) {
        this.forget(session);
        session.stop();
        continue;
      }
      for (const folder of gone) {
        session.folders.delete(folder);
        this.sessions.delete(this.keyFor(session.adapter, folder));
      }
      if (!session.folders.has(session.rootPath)) [session.rootPath] = session.folders;
      session.notify("workspace/didChangeWorkspaceFolders", {
        event: { added: [], removed: gone.map((folder) => this.folderOf(folder)) },
      });
    }
  }
  async deactivate() {
    this.cancelIdleChecks();
    this.subscriptions.dispose();
    for (const subs of this.editorSubscriptions.values()) subs.dispose();
    this.editorSubscriptions.clear();
    for (const subs of this.adapterSubscriptions.values()) subs.dispose();
    this.adapterSubscriptions.clear();
    await Promise.all(this.allSessions().map((session) => session.stop()));
    this.sessions.clear();
    this.emitter.dispose();
  }
};
