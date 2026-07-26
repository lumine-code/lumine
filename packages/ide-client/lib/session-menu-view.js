const { SelectListView } = require("@lumine-code/select-list");

// Lists every language server the window is running — not only the one serving
// the active editor — so any session can be inspected or restarted from
// anywhere. Choosing a server opens the actions for it.
module.exports = class SessionMenuView {
  constructor(main) {
    this.main = main;
    this.selectList = new SelectListView({
      items: [],
      emptyMessage: "No language servers are running",
      filterKeyForItem: (item) => `${item.label} ${item.detail || ""}`,
      elementForItem: (item) => this.elementForItem(item),
      didConfirmSelection: (item) => {
        this.cancel();
        Promise.resolve(item.action()).catch((error) =>
          atom.notifications.addError("Language server action failed", {
            detail: error.message,
            dismissable: true,
          }),
        );
      },
      didCancelSelection: () => this.cancel(),
    });
    this.selectList.element.classList.add("ide-client-session-menu");
  }

  elementForItem(item) {
    const element = document.createElement("li");
    const primary = document.createElement("div");
    primary.className = "primary-line";
    primary.textContent = item.label;
    if (item.state) {
      const badge = document.createElement("span");
      badge.className = `ide-client-session-state status-${item.state}`;
      badge.textContent = item.state;
      primary.appendChild(badge);
    }
    element.appendChild(primary);
    if (item.detail) {
      const secondary = document.createElement("div");
      secondary.className = "secondary-line text-subtle";
      secondary.textContent = item.detail;
      element.appendChild(secondary);
    }
    return element;
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
    await this.selectList.update({ items });
    if (!this.panel) {
      this.previouslyFocusedElement = document.activeElement;
      this.panel = atom.workspace.addModalPanel({ item: this.selectList });
    }
    this.panel.show();
    this.selectList.focus();
    this.selectList.reset();
  }

  async toggle() {
    if (this.panel) return this.cancel();
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

  cancel() {
    this.panel?.destroy();
    this.panel = null;
    this.previouslyFocusedElement?.focus();
    this.previouslyFocusedElement = null;
  }

  destroy() {
    this.cancel();
    this.selectList.destroy();
  }
};
