const { SelectListView } = require("@lumine-code/select-list");

module.exports = class SessionMenuView {
  constructor(main) {
    this.main = main;
    this.selectList = new SelectListView({
      items: [],
      filterKeyForItem: (item) => `${item.label} ${item.detail || ""}`,
      elementForItem: (item) => {
        const element = document.createElement("li");
        const label = document.createElement("div");
        label.className = "primary-line";
        label.textContent = item.label;
        element.appendChild(label);
        if (item.detail) {
          const detail = document.createElement("div");
          detail.className = "secondary-line text-subtle";
          detail.textContent = item.detail;
          element.appendChild(detail);
        }
        return element;
      },
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
    this.selectList.element.classList.add("language-client-session-menu");
  }

  async toggle() {
    if (this.panel) return this.cancel();
    const { editor, session } = this.main.active();
    const adapter = editor && this.main.manager.adapterForEditor(editor);
    if (!adapter) return;
    const items = [
      {
        label: "Reconnect",
        detail: session ? `Restart ${adapter.displayName}` : `Connect ${adapter.displayName}`,
        action: () =>
          session ? this.main.manager.restart(session) : this.main.manager.attachEditor(editor),
      },
    ];
    if (session && session.state !== "stopped") {
      items.push({
        label: "Disconnect",
        detail: `Stop ${adapter.displayName} for this project`,
        action: () => this.main.manager.disconnect(session),
      });
    }
    items.push(
      {
        label: "Show Server Log",
        detail: adapter.displayName,
        action: () => this.main.showLogForAdapter(adapter.id),
      },
      {
        label: "Show Problems",
        detail: "Open language-server diagnostics",
        action: () => this.main.showProblems(),
      },
    );
    await this.selectList.update({ items });
    this.previouslyFocusedElement = document.activeElement;
    this.panel = atom.workspace.addModalPanel({ item: this.selectList });
    this.selectList.focus();
    this.selectList.reset();
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
