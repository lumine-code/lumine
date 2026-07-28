const { CompositeDisposable, Emitter } = require("atom");
const path = require("path");
const { getFullExtension } = require("./helpers");

module.exports = class Dialog {
  constructor(param) {
    if (param == null) {
      param = {};
    }
    const { initialPath, select, iconClass, prompt, info, checkboxes } = param;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.initialValue = initialPath;

    // The prompt renders above the input as an icon label.
    this.promptText = document.createElement("label");
    this.promptText.classList.add("icon");
    if (iconClass) {
      this.promptText.classList.add(iconClass);
    }
    this.promptText.textContent = prompt;

    // Preselect the base name without its extension, so typing replaces the
    // name and leaves the extension alone.
    this.valueSelection = "all";
    if (select) {
      const extension = getFullExtension(initialPath);
      const baseName = path.basename(initialPath);
      const start = initialPath.length - baseName.length;
      const end =
        baseName === extension ? initialPath.length : initialPath.length - extension.length;
      this.valueSelection = [start, end];
    }

    this.spec = {
      id: this.constructor.viewId ?? "tree-view.dialog",
      template: "input",
      className: "tree-view-dialog",
      header: this.promptText,
      value: initialPath,
      valueSelection: this.valueSelection,
      checkboxes,
      // Where focus lands depends on the outcome: confirming returns to the
      // editor you were working in, cancelling returns to the tree.
      restoreFocus: () => this.focusTargetFor(),
      willOpen: (session) => {
        this.session = session;
        if (info) session.setStatus({ message: info, severity: "info" });
      },
      didChangeQuery: () => this.clearError(),
      didClose: () => {
        this.emitter.dispose();
        this.disposables.dispose();
        this.session = null;
      },
      confirm: ({ query }) => {
        this.errored = false;
        this.outcome = "confirm";
        this.inConfirm = true;
        try {
          this.onConfirm(query.raw);
        } finally {
          this.inConfirm = false;
        }
        // A subclass that reported a problem is asking to stay open so the
        // path can be corrected.
        return this.errored ? { keepOpen: true } : undefined;
      },
    };
  }

  attach() {
    return atom.modals.open(this.spec);
  }

  focusTargetFor() {
    if (this.outcome === "confirm") {
      const activePane = atom.workspace.getCenter().getActivePane();
      if (activePane && !activePane.isDestroyed()) activePane.activate();
      return null;
    }
    return document.querySelector(".tree-view");
  }

  // Both are routinely called from inside onConfirm, where the handler's own
  // return value already closes the dialog. There they only record where focus
  // should land; called from outside, they close it.
  close() {
    this.outcome = "confirm";
    if (!this.inConfirm && this.session) this.session.confirm();
  }

  cancel() {
    this.outcome = "cancel";
    if (!this.inConfirm && this.session) this.session.cancel("api");
  }

  clearError() {
    if (this.session) this.session.clearStatus();
  }

  showError(message) {
    this.errored = !!message;
    if (!this.session) return;
    if (!message) {
      this.session.clearStatus();
      return;
    }
    this.session.setStatus({ message, severity: "error" });
    const element = this.session.element;
    element.classList.add("error");
    window.setTimeout(() => element.classList.remove("error"), 300);
  }
};
