const SymbolsView = require("./symbols-view");

module.exports = class GoToView extends SymbolsView {
  constructor(stack, broker) {
    super(stack, broker);
  }

  toggle() {
    if (this.isVisible()) {
      this.cancel();
    } else {
      this.populate();
    }
  }

  detached() {
    this.abortController?.abort();
  }

  async populate() {
    let editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;

    let symbols = await this.generateSymbols(editor);

    if (symbols?.length === 0) {
      console.warn("symbols-view: no symbols found for the active editor");
      return;
    }

    if (symbols.length === 1) {
      if (this.openTag(symbols[0], { pending: true })) return;
    }

    // There must be multiple tags.
    await this.updateView({ items: symbols });
    this.attach();
  }

  shouldBePending() {
    return true;
  }

  async generateSymbols(editor, range = null) {
    this.abortController?.abort();
    this.abortController = new AbortController();

    let meta = {
      type: "project-find",
      editor,
      paths: atom.project.getPaths(),
    };

    if (range) {
      meta.range = range;
      meta.query = editor.getTextInBufferRange(range);
    }

    let signal = this.abortController.signal;

    let providers = await this.broker.select(meta);
    if (providers?.length === 0) {
      return [];
    }

    let allSymbols = await this.gatherSymbols(providers, signal, meta);

    if (signal.aborted) {
      return null;
    }

    return allSymbols;
  }
};
