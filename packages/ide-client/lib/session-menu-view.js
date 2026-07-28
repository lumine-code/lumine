// Lists every language server the window is running — not only the one serving
// the active editor — so any session can be inspected or restarted from
// anywhere. Choosing a server enters the actions for it.
module.exports = class SessionMenuView {
  constructor(main) {
    this.main = main;
  }

  // What the server actually covers, named as such. A bare path cannot say
  // whether it is the project, one root among several, or the directory of a
  // loose file — and naming a server after the folder that happened to start
  // it is a lie for anything serving more than one.
  scopeOf(session) {
    const scope = this.main.manager.scopeFor(session);
    if (scope === "file") {
      // The folder is only the file's directory; the file is what was opened.
      const files = [...(session.documents?.values() || [])]
        .map((document) => document.editor?.getPath())
        .filter(Boolean);
      if (files.length)
        return { label: files.length > 1 ? `Files (${files.length})` : "File", files };
      return { label: "File", files: [...session.folders] };
    }
    const folders = this.main.manager.foldersFor(session);
    if (scope === "workspace") return { label: "Workspace", files: folders };
    return { label: folders.length > 1 ? `Roots (${folders.length})` : "Root", files: folders };
  }

  describeScope(session) {
    const { label, files } = this.scopeOf(session);
    const paths = files.length ? files : [session.rootPath];
    return `${label} · ${paths.join(", ")}`;
  }

  // The active editor's servers come first: they are the ones the user is
  // most likely acting on.
  serverItems(editor) {
    const serving = new Set(editor ? this.main.manager.sessionsForEditor(editor) : []);
    return this.main.manager
      .allSessions()
      .sort(
        (a, b) =>
          (serving.has(a) ? 0 : 1) - (serving.has(b) ? 0 : 1) ||
          a.adapter.displayName.localeCompare(b.adapter.displayName),
      )
      .map((session) => ({
        label: session.adapter.displayName,
        detail: this.describeScope(session),
        state: session.state,
        session,
      }));
  }

  // The state goes in the trailing block, so the states line up down the right
  // edge instead of each one trailing a name of a different length.
  renderer() {
    return {
      entry: (item) => ({ id: item.label, text: `${item.label} ${item.detail || ""}` }),
      row: (item) => ({
        label: item.label,
        detail: item.detail,
        badges: item.state
          ? [{ text: item.state, className: `ide-client-session-state status-${item.state}` }]
          : undefined,
      }),
    };
  }

  run(action) {
    return Promise.resolve(action()).catch((error) =>
      atom.notifications.addError("Language server action failed", {
        detail: error.message,
        dismissable: true,
      }),
    );
  }

  toggle() {
    return atom.modals.toggle({
      id: "ide-client.sessions",
      className: "ide-client-session-menu",
      placeholder: "Select a language server",
      emptyMessage: "No language servers are running",
      title: "Language servers",
      source: (req) => this.serverItems(req.session.target.editor),
      renderer: this.renderer(),
      // Confirming a server enters its actions. Going back is the stack's job,
      // so there is no "Back" row and no reopening the list by hand.
      confirm: ({ item }) => ({ push: this.actionsSpec(item.session) }),
    });
  }

  actionsSpec(session) {
    const items = [
      {
        label: "Restart",
        detail: `Restart ${session.adapter.displayName}`,
        action: () => this.main.manager.restart(session),
      },
      {
        label: "Stop",
        detail: `Stop ${session.adapter.displayName} for ${this.describeScope(session)}`,
        action: () => this.main.manager.disconnect(session),
      },
      {
        label: "Show Server Log",
        detail: session.adapter.displayName,
        action: () => this.main.showLogForAdapter(session.adapter.id),
      },
      {
        label: "Show Problems",
        detail: "Open the language-server diagnostics",
        action: () => this.main.showProblems(),
      },
    ];

    return {
      id: "ide-client.session-actions",
      className: "ide-client-session-menu",
      title: session.adapter.displayName,
      placeholder: "Select an action",
      source: items,
      renderer: this.renderer(),
      confirm: ({ item }) => {
        this.run(item.action);
      },
    };
  }

  destroy() {}
};
