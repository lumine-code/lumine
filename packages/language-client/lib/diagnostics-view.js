const { CompositeDisposable } = require("atom");
const { fileURLToPath } = require("url");

module.exports = class DiagnosticsView {
  constructor(service) {
    this.service = service;
    this.byUri = new Map();
    this.layers = new Map();
    this.subscriptions = new CompositeDisposable();
    this.element = document.createElement("div");
    this.element.className = "language-client-problems native-key-bindings";
    this.element.tabIndex = -1;
    this.subscriptions.add(service.onDidPublishDiagnostics((event) => this.update(event)));
  }
  update({ uri, diagnostics = [] }) {
    this.byUri.set(uri, diagnostics);
    if (!this.externalProvider) this.decorate(uri, diagnostics);
    this.render();
  }
  setExternalProvider(enabled) {
    this.externalProvider = enabled;
    if (enabled) {
      for (const layer of this.layers.values()) layer.destroy();
      this.layers.clear();
    } else {
      for (const [uri, diagnostics] of this.byUri) this.decorate(uri, diagnostics);
    }
  }
  decorate(uri, diagnostics) {
    let filePath;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return;
    }
    for (const editor of atom.workspace
      .getTextEditors()
      .filter((item) => item.getPath() === filePath)) {
      this.layers.get(editor)?.destroy();
      const layer = editor.addMarkerLayer();
      this.layers.set(editor, layer);
      for (const diagnostic of diagnostics) {
        const marker = layer.markBufferRange(
          [
            [diagnostic.range.start.line, diagnostic.range.start.character],
            [diagnostic.range.end.line, diagnostic.range.end.character],
          ],
          { invalidate: "touch" },
        );
        editor.decorateMarker(marker, {
          type: "highlight",
          class: `language-client-diagnostic-${diagnostic.severity === 1 ? "error" : diagnostic.severity === 2 ? "warning" : "info"}`,
        });
      }
    }
  }
  render() {
    this.element.textContent = "";
    const table = document.createElement("table");
    for (const [uri, diagnostics] of this.byUri)
      for (const diagnostic of diagnostics) {
        const row = document.createElement("tr");
        const severity = document.createElement("td");
        severity.textContent =
          ["", "Error", "Warning", "Info", "Hint"][diagnostic.severity] || "Info";
        const message = document.createElement("td");
        message.textContent = diagnostic.message;
        const location = document.createElement("td");
        let filePath = uri;
        try {
          filePath = fileURLToPath(uri);
        } catch {
          /* Keep a non-file URI readable. */
        }
        location.textContent = `${filePath}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
        row.append(severity, message, location);
        row.addEventListener("dblclick", () =>
          atom.workspace.open(filePath, {
            initialLine: diagnostic.range.start.line,
            initialColumn: diagnostic.range.start.character,
          }),
        );
        table.appendChild(row);
      }
    if (!table.children.length) {
      const empty = document.createElement("span");
      empty.textContent = "No language-server problems";
      this.element.appendChild(empty);
    } else this.element.appendChild(table);
  }
  destroy() {
    this.subscriptions.dispose();
    for (const layer of this.layers.values()) layer.destroy();
    this.layers.clear();
  }
};
