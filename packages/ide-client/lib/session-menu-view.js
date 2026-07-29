// The state chip is a plain `.badge`, so its shape and colors come from the UI
// theme rather than from this package. `stopped` maps to no variant on purpose:
// the neutral pill is what an idle server should read as.
const STATE_BADGES = {
  running: "badge-success",
  starting: "badge-warning",
  stopping: "badge-warning",
  failed: "badge-error",
};

// Lists every language server the window is running — not only the one serving
// the active editor — so any session can be inspected or restarted from
// anywhere. Choosing a server steps into its actions: the breadcrumb trail
// names the server, and going back returns to a freshly rendered server list.
module.exports = class SessionMenuView {
  constructor(main) {
    this.main = main;
    // Each step is its own list with its own modal panel; the modal flow
    // chains them, and the base view's focus and cancel behavior only works
    // in a panel it built itself.
    this.serverList = atom.workspace.buildSelectList({
      className: "ide-client-session-menu",
      crumb: "Servers",
      items: [],
      emptyMessage: "No language servers are running",
      filterKeyForItem: (item) => `${item.label} ${item.detail || ""}`,
      elementForItem: (item) => this.elementForItem(item),
      // Runs on every show — including a back navigation from the actions
      // list — so the rows always carry current server states.
      willShow: () => this.serverList.update({ items: this.serverItems() }),
      didConfirmSelection: (item) => this.showActions(item.session),
      didCancelSelection: () => this.serverList.hide(),
    });
    this.actionsList = atom.workspace.buildSelectList({
      className: "ide-client-session-menu",
      items: [],
      filterKeyForItem: (item) => `${item.label} ${item.detail || ""}`,
      elementForItem: (item) => this.elementForItem(item),
      didConfirmSelection: (item) => {
        // Acting on a server completes the flow, so this hide ends the trail.
        this.actionsList.hide();
        Promise.resolve(item.action()).catch((error) =>
          atom.notifications.addError("Language server action failed", {
            detail: error.message,
            dismissable: true,
          }),
        );
      },
      didCancelSelection: () => this.actionsList.hide(),
    });
  }

  // The state goes in the trailing block, so the states line up down the right
  // edge instead of each one trailing a name of a different length.
  elementForItem(item) {
    return {
      primary: item.label,
      secondary: item.detail,
      trailing: [
        item.state && {
          text: item.state,
          className: `ide-client-session-state badge ${STATE_BADGES[item.state] ?? ""}`.trim(),
        },
      ],
    };
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
  serverItems() {
    const editor = atom.workspace.getActiveTextEditor();
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

  actionItems(session) {
    return [
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
  }

  // The actions list shows itself as a flow step: the visible server list
  // becomes the trail root, and Shift-Escape or a crumb click returns to it.
  async showActions(session) {
    this.actionsList.reset();
    await this.actionsList.update({ items: this.actionItems(session) });
    this.actionsList.show({ crumb: session.adapter.displayName });
  }

  async toggle() {
    if (this.serverList.isVisible()) return this.serverList.hide();
    if (this.actionsList.isVisible()) return this.actionsList.hide();
    this.serverList.reset();
    this.serverList.show();
  }

  destroy() {
    this.serverList.destroy();
    this.actionsList.destroy();
  }
};
