"use babel";

import repositoryForPath from "./helpers";

export default class DiffListView {
  destroy() {}

  async getDiffs(editor) {
    const repository = await repositoryForPath(editor.getPath());
    let diffs = repository
      ? await repository.getLineDiffsAsync(editor.getPath(), editor.getText())
      : [];
    if (!diffs) diffs = [];
    for (const diff of diffs) {
      const bufferRow = diff.newStart > 0 ? diff.newStart - 1 : diff.newStart;
      const lineText = editor.lineTextForBufferRow(bufferRow);
      diff.lineText = lineText ? lineText.trim() : "";
    }
    return diffs;
  }

  toggle() {
    if (!atom.workspace.getActiveTextEditor()) return null;

    return atom.modals.toggle({
      id: "git-diff.diffs",
      className: "diff-list-view",
      placeholder: "Jump to a diff",
      emptyMessage: "No diffs in file",
      // Reading the diff is async, so the list is a promise source rather than
      // work the caller has to finish before opening.
      source: (req) => this.getDiffs(req.session.target.editor),
      renderer: {
        entry: (diff) => ({ id: `${diff.newStart}:${diff.newLines}`, text: diff.lineText }),
        row: (diff) => ({
          label: diff.lineText,
          detail: `-${diff.oldStart},${diff.oldLines} +${diff.newStart},${diff.newLines}`,
        }),
      },
      confirm: ({ item, target }) => {
        const bufferRow = item.newStart > 0 ? item.newStart - 1 : item.newStart;
        target.editor.setCursorBufferPosition([bufferRow, 0], { autoscroll: true });
        target.editor.moveToFirstCharacterOfLine();
      },
    });
  }
}
