"use strict";

const { CompositeDisposable, Disposable } = require("event-kit");
const TextEditor = require("./text-editor");

// The modal's mini query editor: one long-lived `TextEditor` reused by every
// view, plus the per-view policy layered on top of it (placeholder, `accept`
// filtering, password masking, autocomplete opt-in).

class ModalQueryEditor {
  constructor({ onDidChange }) {
    this.onDidChangeCallback = onDidChange;
    this.editor = new TextEditor({ mini: true });
    this.element = this.editor.element;
    this.element.classList.add("modals-query-editor");

    this.viewSubscriptions = new CompositeDisposable();
    this.subscriptions = new CompositeDisposable();
    this.composing = false;
    this.accept = null;
    this.silent = false;

    if (typeof atom !== "undefined" && atom.textEditors) {
      this.subscriptions.add(atom.textEditors.add(this.editor));
    }

    this.subscriptions.add(
      this.editor.onDidChange(() => {
        if (this.silent) return;
        this.onDidChangeCallback();
      }),
    );

    // `accept` is enforced on insertion rather than after the fact, so a
    // rejected character never flashes in the field. IME composition is exempt:
    // intermediate composition text is routinely "invalid" and rejecting it
    // breaks CJK input entirely.
    this.subscriptions.add(
      this.editor.onWillInsertText((event) => {
        if (!this.accept || this.composing) return;
        const current = this.editor.getText();
        const selection = this.editor.getSelectedBufferRange();
        const start = selection.start.column;
        const end = selection.end.column;
        const next = current.slice(0, start) + event.text + current.slice(end);
        if (!this.isAcceptable(next)) event.cancel();
      }),
    );

    const compositionStart = () => {
      this.composing = true;
    };
    const compositionEnd = () => {
      this.composing = false;
      if (this.accept && !this.isAcceptable(this.editor.getText())) {
        this.editor.undo();
      }
    };
    this.element.addEventListener("compositionstart", compositionStart, true);
    this.element.addEventListener("compositionend", compositionEnd, true);
    this.subscriptions.add(
      new Disposable(() => {
        this.element.removeEventListener("compositionstart", compositionStart, true);
        this.element.removeEventListener("compositionend", compositionEnd, true);
      }),
    );
  }

  isAcceptable(value) {
    if (!this.accept) return true;
    if (this.accept instanceof RegExp) return this.accept.test(value);
    return !!this.accept(value);
  }

  // Applies one view's policy. Called on mount and on every push/pop, so it
  // must fully replace the previous view's policy rather than layer onto it.
  applyView(spec) {
    this.viewSubscriptions.dispose();
    this.viewSubscriptions = new CompositeDisposable();

    this.accept = spec.accept ?? null;
    this.editor.setPlaceholderText(spec.placeholder ?? "");
    this.element.classList.toggle("password", !!spec.password);

    if (spec.autocomplete && spec.autocomplete.length && this.watchEditor) {
      this.viewSubscriptions.add(this.watchEditor(this.editor, spec.autocomplete));
    }
  }

  // Wired by the host when the `autocomplete.watch-editor` service is present.
  setAutocompleteWatcher(watchEditor) {
    this.watchEditor = watchEditor;
  }

  getText() {
    return this.editor.getText();
  }

  setText(text, { select = "none", silent = false } = {}) {
    const previous = this.silent;
    this.silent = silent;
    try {
      this.editor.setText(text ?? "");
      this.applySelection(select);
    } finally {
      this.silent = previous;
    }
  }

  applySelection(select) {
    if (select === "all") {
      this.editor.selectAll();
    } else if (Array.isArray(select)) {
      this.editor.setSelectedBufferRange([
        [0, select[0]],
        [0, select[1]],
      ]);
    } else if (select === "none") {
      this.editor.moveToEndOfLine();
    }
  }

  getSelection() {
    const range = this.editor.getSelectedBufferRange();
    return [range.start.column, range.end.column];
  }

  focus() {
    this.element.focus();
  }

  destroy() {
    this.viewSubscriptions.dispose();
    this.subscriptions.dispose();
    this.editor.destroy();
  }
}

module.exports = { ModalQueryEditor };
