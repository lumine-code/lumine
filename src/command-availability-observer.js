const { CompositeDisposable } = require("@lumine-code/event-kit");

// Observe model signals; querying command state never constructs views, reads
// files, parses a document, or asks a package to initialize its runtime.
module.exports = class CommandAvailabilityObserver {
  constructor(workspace) {
    this.workspace = workspace;
    this.disposables = new CompositeDisposable();
    this.editors = new Map();
    this.items = new Map();
    this.containers = new Map();
    this.disposed = false;
    const invalidate = () => this.invalidate();
    this.disposables.add(
      workspace.textEditorRegistry.observe((editor) => this.observeEditor(editor)),
      workspace.textEditorRegistry.onDidRemoveEditor((editor) => this.removeEditor(editor)),
      workspace.observeWindows((presentation) => {
        const container = presentation.getEditorContainer();
        this.observeContainer(container);
        const subscription = presentation.onDidDestroy(() => {
          this.containers.get(container)?.dispose();
          this.containers.delete(container);
          this.disposables.remove(subscription);
          subscription.dispose();
          invalidate();
        });
        this.disposables.add(subscription);
      }),
      workspace.project.onDidChangePaths(invalidate),
    );
    for (const dock of [
      workspace.getLeftDock(),
      workspace.getRightDock(),
      workspace.getBottomDock(),
    ]) {
      this.observeContainer(dock.paneContainer);
    }
  }

  invalidate() {
    if (this.disposed || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.disposed) this.workspace.commandRegistry.invalidateAvailability();
    });
  }

  observeEditor(editor) {
    if (this.editors.has(editor) || this.workspace.textEditorRegistry.roleFor(editor) === "input")
      return;
    const subscriptions = new CompositeDisposable();
    this.editors.set(editor, subscriptions);
    for (const method of [
      "onDidChangePath",
      "onDidChangeGrammar",
      "onDidChangeReadOnly",
      "onDidChangeFileState",
      "onDidChangeCursorPosition",
      "onDidChangeSelectionRange",
    ])
      subscriptions.add(editor[method](() => this.invalidate()));
    this.invalidate();
  }

  removeEditor(editor) {
    this.editors.get(editor)?.dispose();
    this.editors.delete(editor);
    this.invalidate();
  }

  observeItem(item) {
    if (!item || this.items.has(item)) return;
    const subscriptions = new CompositeDisposable();
    this.items.set(item, subscriptions);
    for (const method of ["onDidChangeURI", "onDidChangeFileState"]) {
      if (typeof item[method] === "function")
        subscriptions.add(item[method](() => this.invalidate()));
    }
    if (typeof item.onDidDestroy === "function")
      subscriptions.add(item.onDidDestroy(() => this.removeItem(item)));
  }

  removeItem(item) {
    this.items.get(item)?.dispose();
    this.items.delete(item);
    this.invalidate();
  }

  observeContainer(container) {
    if (!container || this.containers.has(container)) return;
    const invalidate = () => this.invalidate();
    const subscriptions = new CompositeDisposable();
    for (const [method, callback] of [
      ["observePaneItems", (item) => this.observeItem(item)],
      ["onDidDestroyPaneItem", ({ item }) => this.removeItem(item)],
      ...[
        "onDidChangeActivePaneItem",
        "onDidChangeActivePane",
        "observeActiveFileTextEditor",
        "observeActiveEmbeddedTextEditor",
        "onDidAddPane",
        "onDidDestroyPane",
      ].map((method) => [method, invalidate]),
    ]) {
      if (typeof container[method] === "function") subscriptions.add(container[method](callback));
    }
    this.containers.set(container, subscriptions);
    this.invalidate();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposables.dispose();
    for (const map of [this.editors, this.items, this.containers]) {
      for (const subscription of map.values()) subscription.dispose();
      map.clear();
    }
  }
};
