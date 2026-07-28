"use babel";

import { Point } from "atom";

const HELP_MESSAGE =
  'Enter a <row> or <row>:<column> to go there, or <row>:<column>-<row>:<column> to select.\nExamples: "3" for row 3, "2:7" for row 2 and column 7, or "2:7-4:1" to select from row 2 column 7 to row 4 column 1';

// Parse a `<row>` or `<row>:<column>` fragment into 0-based coordinates.
// A missing row falls back to the current row; a missing column is returned
// as -1 so the caller can decide how to resolve it.
function parseFragment(text, currentRow) {
  const [rowText = "", columnText = ""] = text.split(/:+/);
  const row = rowText.length > 0 ? parseInt(rowText, 10) - 1 : currentRow;
  const column = columnText.length > 0 ? parseInt(columnText, 10) - 1 : -1;
  return new Point(row, column);
}

export function navigate(editor, input) {
  if (!editor || !input.length) return;

  const currentRow = editor.getCursorBufferPosition().row;
  const dashIndex = input.indexOf("-");

  // `<start>-<end>` selects a range; `start` is the anchor and `end` is where
  // the cursor lands, so the selection follows the direction that was typed.
  if (dashIndex >= 0 && input.slice(dashIndex + 1).length > 0) {
    const anchor = parseFragment(input.slice(0, dashIndex), currentRow);
    const head = parseFragment(input.slice(dashIndex + 1), currentRow);
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
  const target = parseFragment(dashIndex >= 0 ? input.slice(0, dashIndex) : input, currentRow);
  editor.setCursorBufferPosition(target);
  editor.unfoldBufferRow(target.row);
  if (target.column < 0) {
    editor.moveToFirstCharacterOfLine();
  }
  editor.scrollToBufferPosition(target, { center: true });
}

export function toggle() {
  if (!atom.workspace.getActiveTextEditor()) return null;

  return atom.modals.toggle({
    id: "go-to-line.position",
    template: "input",
    className: "go-to-line",
    placeholder: "Row, or row:column",
    help: HELP_MESSAGE,
    // Rejected on insertion, so an unusable character never reaches the field.
    // The old view hooked `onWillInsertText` by hand to do this.
    accept: /^[-0-9:]*$/,
    // The editor follows the query as it is typed; confirming just leaves the
    // cursor where the last keystroke already put it.
    didChangeQuery: (query, session) => navigate(session.target.editor, query.raw),
    confirm: ({ query, target }) => navigate(target.editor, query.raw),
  });
}

export default {
  activate() {
    this.disposable = atom.commands.add("atom-text-editor", "go-to-line:toggle", () => {
      toggle();
      return false;
    });
  },

  deactivate() {
    if (this.disposable) this.disposable.dispose();
    this.disposable = null;
  },
};
