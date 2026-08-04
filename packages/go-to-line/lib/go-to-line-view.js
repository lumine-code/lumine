const { Point } = require("atom");

const HELP_MESSAGE =
  'Enter a <row> or <row>:<column> to go there, or <row>:<column>-<row>:<column> to select.\nExamples: "3" for row 3, "2:7" for row 2 and column 7, or "2:7-4:1" to select from row 2 column 7 to row 4 column 1';

class GoToLineView {
  constructor() {
    this.inputDialogView = atom.workspace.buildInputDialog({
      className: "go-to-line",
      infoMessage: HELP_MESSAGE,
      didChangeQuery: () => this.navigate({ keepOpen: true }),
      didConfirm: () => this.navigate(),
      didCancel: () => this.close(),
    });
    this.miniEditor = this.inputDialogView.refs.queryEditor;
    this.miniEditor.onWillInsertText((arg) => {
      if (arg.text.match(/[^-0-9:]/)) {
        arg.cancel();
      }
    });

    // Create the (hidden) modal panel eagerly so `panel` is available before the
    // first toggle, matching the previous constructor behavior.
    this.panel = this.inputDialogView.getPanel();

    atom.commands.add("atom-text-editor", "go-to-line:toggle", () => {
      this.toggle();
      return false;
    });
  }

  toggle() {
    this.inputDialogView.isVisible() ? this.close() : this.open();
  }

  open() {
    if (this.inputDialogView.isVisible() || !atom.workspace.getActiveTextEditor()) return;
    this.inputDialogView.show();
  }

  close() {
    if (!this.inputDialogView.isVisible()) return;
    this.inputDialogView.reset();
    this.inputDialogView.hide();
  }

  // Parse a `<row>` or `<row>:<column>` fragment into 0-based coordinates.
  // A missing row falls back to the current row; a missing column is returned
  // as -1 so the caller can decide how to resolve it.
  parseFragment(text, currentRow) {
    const [rowText = "", columnText = ""] = text.split(/:+/);
    const row = rowText.length > 0 ? parseInt(rowText, 10) - 1 : currentRow;
    const column = columnText.length > 0 ? parseInt(columnText, 10) - 1 : -1;
    return new Point(row, column);
  }

  navigate(options = {}) {
    const input = this.miniEditor.getText();
    const editor = atom.workspace.getActiveTextEditor();
    if (!options.keepOpen) {
      this.close();
    }
    if (!editor || !input.length) return;

    const currentRow = editor.getCursorBufferPosition().row;
    const dashIndex = input.indexOf("-");

    // `<start>-<end>` selects a range; `start` is the anchor and `end` is where
    // the cursor lands, so the selection follows the direction that was typed.
    if (dashIndex >= 0 && input.slice(dashIndex + 1).length > 0) {
      const anchor = this.parseFragment(input.slice(0, dashIndex), currentRow);
      const head = this.parseFragment(input.slice(dashIndex + 1), currentRow);
      const tail = new Point(anchor.row, Math.max(anchor.column, 0));
      const cursor = new Point(head.row, Math.max(head.column, 0));
      const reversed = cursor.isLessThan(tail);

      editor.unfoldBufferRow(tail.row);
      editor.unfoldBufferRow(cursor.row);
      editor.setSelectedBufferRange(reversed ? [cursor, tail] : [tail, cursor], { reversed });
      editor.scrollToBufferPosition(cursor, { center: true });
      return;
    }

    // A plain position (optionally the start of an incomplete range) moves the
    // cursor, matching the original behavior.
    const target = this.parseFragment(
      dashIndex >= 0 ? input.slice(0, dashIndex) : input,
      currentRow,
    );
    editor.setCursorBufferPosition(target);
    editor.unfoldBufferRow(target.row);
    if (target.column < 0) {
      editor.moveToFirstCharacterOfLine();
    }
    editor.scrollToBufferPosition(target, {
      center: true,
    });
  }
}

module.exports = {
  activate() {
    return new GoToLineView();
  },
};
