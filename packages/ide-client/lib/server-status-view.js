const { CompositeDisposable, Disposable } = require("atom");

// The status-bar item for the language servers this window is running: how many
// are up and how many have failed. Naming them is the session menu's job, which
// a click opens.
module.exports = class ServerStatusView {
  constructor({ manager, onDidClick }) {
    this.manager = manager;
    this.onDidClick = onDidClick;
    this.subscriptions = new CompositeDisposable();

    this.element = document.createElement("div");
    this.element.classList.add("ide-client-server-status", "inline-block");

    this.icon = document.createElement("span");
    this.icon.classList.add("icon", "icon-radio-tower");
    this.element.appendChild(this.icon);

    this.label = document.createElement("span");
    this.label.classList.add("ide-client-server-label");
    this.element.appendChild(this.label);

    this.failed = document.createElement("span");
    this.failed.classList.add("ide-client-server-failed", "icon", "icon-alert");
    this.element.appendChild(this.failed);

    // One plain line per server. The tooltip re-appends its item node every
    // time it opens, so the content is mutated in place rather than the tooltip
    // being disposed and added again on each update.
    this.tooltipContent = document.createElement("div");
    this.tooltipContent.classList.add("ide-client-server-tooltip");
    this.tooltip = atom.tooltips.add(this.element, { item: this.tooltipContent });

    const clickHandler = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.onDidClick?.();
    };
    this.element.addEventListener("click", clickHandler);
    this.subscriptions.add(
      new Disposable(() => this.element.removeEventListener("click", clickHandler)),
    );

    // Sessions appearing and disappearing are not signalled apart from their
    // state changes, so every event recomputes the whole list from the manager
    // instead of trying to diff it.
    this.subscriptions.add(
      this.manager.onDidChangeSession(() => this.update()),
      atom.config.observe("ide-client.statusBar.enabled", (enabled) => {
        this.enabled = enabled !== false;
        this.update();
      }),
    );
  }

  // A restart reports stopping, stopped, and running within one tick; batching
  // collapses that burst into a single write.
  update() {
    this.updateSubscription?.dispose();
    this.updateSubscription = atom.views.updateDocument(() => {
      this.updateSubscription = null;
      this.render(this.manager.allSessions());
    });
  }

  render(sessions) {
    const failed = sessions.filter((session) => session.state === "failed");
    const starting = sessions.filter((session) => session.state === "starting");

    this.label.textContent = `IDE (${sessions.length})`;
    this.failed.textContent = failed.length ? `${failed.length}` : "";
    this.failed.hidden = failed.length === 0;
    this.element.classList.toggle("has-failed", failed.length > 0);
    this.element.classList.toggle("has-starting", starting.length > 0);

    this.tooltipContent.textContent = "";
    for (const session of sessions) {
      const line = document.createElement("div");
      line.textContent = `${session.adapter.displayName} (${session.state})`;
      this.tooltipContent.appendChild(line);
    }

    // `.inline-block` supplies a display from the base stylesheet, which
    // outranks the hidden attribute, so visibility goes through the style
    // attribute instead.
    this.element.style.display = this.enabled && sessions.length ? "" : "none";
  }

  destroy() {
    this.updateSubscription?.dispose();
    this.updateSubscription = null;
    this.subscriptions.dispose();
    this.tooltip?.dispose();
    this.tooltip = null;
    this.element.remove();
  }
};
