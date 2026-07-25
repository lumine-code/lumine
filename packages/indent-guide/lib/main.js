const { CompositeDisposable, Point } = require("atom");
const { createElementsForGuides, styleGuide } = require("./element");
const { getGuides } = require("./guides");

// Cached regex for whitespace-only line detection
const WHITESPACE_REGEX = /^\s*$/;

/**
 * Indent Guide Package
 * Renders indentation guides with active line highlighting.
 */
module.exports = {
  /**
   * Activates the package and sets up indent guide rendering for all editors.
   */
  activate() {
    this.disposables = new CompositeDisposable(
      atom.config.observe("indent-guide.cursorAwareActive", (value) => {
        this.cursorAwareActive = value;
      }),
      atom.commands.add("atom-workspace", {
        "indent-guide:toggle-cursor-aware-active": () => {
          this.cursorAwareActive = !this.cursorAwareActive;
          this.updateAllEditors();
        },
      }),
      atom.workspace.observeTextEditors((editor) => {
        if (!editor) {
          return;
        }
        const editorElement = atom.views.getView(editor);
        if (!editorElement) {
          return;
        }
        this.handleEvents(editor, editorElement);
      }),
    );
  },

  /**
   * Deactivates the package and removes all indent guides.
   */
  deactivate() {
    this.disposables.dispose();
    atom.workspace.getTextEditors().forEach((editor) => {
      if (editor.component && editor.component.updateSyncAfterMeasuringContent_) {
        editor.component.updateSyncAfterMeasuringContent =
          editor.component.updateSyncAfterMeasuringContent_;
        delete editor.component.updateSyncAfterMeasuringContent_;
      }
      const view = atom.views.getView(editor);
      if (!view) {
        return;
      }
      for (let e of view.querySelectorAll(".indent-guide-layer")) {
        e.remove();
      }
      for (let e of view.querySelectorAll(".indent-guide")) {
        e.remove();
      }
    });
  },

  /**
   * Creates a Point with safe NaN handling.
   * @param {number} x - The row value
   * @param {number} y - The column value
   * @returns {Point} A new Point with the coordinates
   */
  createPoint(x, y) {
    x = isNaN(x) ? 0 : x;
    y = isNaN(y) ? 0 : y;
    return new Point(x, y);
  },

  updateAllEditors() {
    atom.workspace.getTextEditors().forEach((editor) => {
      const editorElement = atom.views.getView(editor);
      if (editorElement) {
        this.updateGuide(editor, editorElement);
      }
    });
  },

  /**
   * Updates the indent guides for the visible portion of an editor.
   * @param {TextEditor} editor - The text editor
   * @param {Element} editorElement - The editor's DOM element
   */
  updateGuide(editor, editorElement) {
    if (!editorElement.component || !editorElement.component.visible) {
      return;
    }
    const visibleScreenRange = editorElement.getVisibleRowRange();
    if (visibleScreenRange === null) {
      return;
    }

    const visibleRange = visibleScreenRange.map(
      (row) => editor.bufferPositionForScreenPosition(this.createPoint(row, 0)).row,
    );
    const tabLength = editor.getTabLength();
    const cursorPositions = editor.getCursorBufferPositions().map((point) => ({
      row: point.row,
      level: this.cursorAwareActive ? Math.floor(point.column / tabLength) : Infinity,
    }));

    const getIndent = (row) => {
      if (WHITESPACE_REGEX.test(editor.lineTextForBufferRow(row))) {
        return null;
      } else {
        return editor.indentationForBufferRow(row);
      }
    };
    const guides = getGuides(
      visibleRange[0],
      visibleRange[1] + 1,
      editor.getLastBufferRow(),
      cursorPositions,
      getIndent,
    );
    return createElementsForGuides(
      editorElement,
      guides.map(
        (g) => (el) =>
          styleGuide(
            el,
            g.point.translate(this.createPoint(visibleRange[0], 0)),
            g.length,
            g.stack,
            g.active,
            editor,
          ),
      ),
    );
  },

  /**
   * Sets up event handling to update guides when the editor content changes.
   * @param {TextEditor} editor - The text editor
   * @param {Element} editorElement - The editor's DOM element
   */
  handleEvents(editor, editorElement) {
    if (!editor.component || !editor.component.updateSyncAfterMeasuringContent) {
      return;
    }
    editor.component.updateSyncAfterMeasuringContent_ =
      editor.component.updateSyncAfterMeasuringContent;
    editor.component.updateSyncAfterMeasuringContent = () => {
      this.updateGuide(editor, editorElement);
      if (editor.component.updateSyncAfterMeasuringContent_) {
        editor.component.updateSyncAfterMeasuringContent_();
      }
    };
  },
};
