const { SelectListView, createTwoLineItem } = require("@lumine-code/select-list");

// Lists every language server the window is running — not only the one serving
// the active editor — so any session can be inspected or restarted from
// anywhere. Choosing a server opens the actions for it.
module.exports = class SessionMenuView {
  constructor(main) {
    this.main = main;
    // The list manages its own modal panel. Hosting one by hand leaves the base
    // view's panel unbuilt, and its focusout handler bails on a list it thinks
    // is not visible — which is what stopped a click outside from closing this.
    this.selectList = new SelectListView({
      className: "ide-client-session-menu",
      items: [],
      emptyMessage: "No language servers are running",
      filterKeyForItem: (item) => `${item.label} ${item.detail || ""}`,
      elementForItem: (item) => this.elementForItem(item),
      didConfirmSelection: (item) => {
        this.selectList.hide();
        Promise.resolve(item.action()).catch((error) =>
          atom.notifications.addError("Language server action failed", {
            detail: error.message,
            dismissable: true,
          }),
        );
      },
      didCancelSelection: () => this.selectList.hide(),
    });
  }

  // The state goes in the trailing block, so the states line up down the right
  // edge instead of each one trailing a name of a different length.
  elementForItem(item) {
    return createTwoLineItem({
      primary: item.label,
      secondary: item.detail,
      trailing: [
        item.state && {
          text: item.state,
          className: `ide-client-session-state status-${item.state}`,
        },
      ],
    });
  }

  // The active editor's servers come first: they are the ones the user is
  // most likely acting on.
  serverItems() {
    const editor = atom.workspace.getActiveTextEditor();
    const serving = new Set(editor ? this.main.manager.sessionsForEditor(editor) : []);
    return [...this.main.manager.sessions.values()]
      .sort(
        (a, b) =>
          (serving.has(a) ? 0 : 1) - (serving.has(b) ? 0 : 1) ||
          a.adapter.displayName.localeCompare(b.adapter.displayName),
      )
      .map((session) => ({
        label: session.adapter.displayName,
        detail: session.rootPath,
        state: session.state,
        action: () => this.showActions(session),
      }));
  }

  async show(items) {
    this.selectList.reset();
    await this.selectList.update({ items });
    this.selectList.show();
  }

  async toggle() {
    if (this.selectList.isVisible()) return this.selectList.hide();
    return this.show(this.serverItems());
  }

  async showActions(session) {
    return this.show([
      {
        label: "Restart",
        detail: `Restart ${session.adapter.displayName}`,
        action: () => this.main.manager.restart(session),
      },
      {
        label: "Stop",
        detail: `Stop ${session.adapter.displayName} for ${session.rootPath}`,
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
      {
        label: "Back",
        detail: "Return to the list of language servers",
        // Confirming closed the panel, so this reopens rather than toggles.
        action: () => this.show(this.serverItems()),
      },
    ]);
  }

  destroy() {
    this.selectList.destroy();
  }
};
