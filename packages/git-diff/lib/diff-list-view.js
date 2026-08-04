const repositoryForPath = require("./helpers");

module.exports = class DiffListView {
  constructor() {
    this.selectListView = atom.workspace.buildSelectList({
      className: "diff-list-view",
      crumb: "Diffs",
      emptyMessage: "No diffs in file",
      items: [],
      filterKeyForItem: (diff) => diff.lineText,
      elementForItem: (diff, { filterKey, highlight }) => ({
        primary: highlight(filterKey),
        secondary: `-${diff.oldStart},${diff.oldLines} +${diff.newStart},${diff.newLines}`,
      }),
      didConfirmSelection: (diff) => {
        this.selectListView.hide();
        const bufferRow = diff.newStart > 0 ? diff.newStart - 1 : diff.newStart;
        this.editor.setCursorBufferPosition([bufferRow, 0], {
          autoscroll: true,
        });
        this.editor.moveToFirstCharacterOfLine();
      },
      didCancelSelection: () => {
        this.selectListView.hide();
      },
    });
  }

  destroy() {
    return this.selectListView.destroy();
  }

  async toggle() {
    const editor = atom.workspace.getActiveTextEditor();
    if (this.selectListView.isVisible()) {
      this.selectListView.hide();
    } else if (editor) {
      this.editor = editor;
      const repository = await repositoryForPath(this.editor.getPath());
      let diffs = repository
        ? await repository.getLineDiffsAsync(this.editor.getPath(), this.editor.getText())
        : [];
      if (!diffs) diffs = [];
      for (let diff of diffs) {
        const bufferRow = diff.newStart > 0 ? diff.newStart - 1 : diff.newStart;
        const lineText = this.editor.lineTextForBufferRow(bufferRow);
        diff.lineText = lineText ? lineText.trim() : "";
      }

      this.selectListView.reset();
      await this.selectListView.update({ items: diffs });
      this.selectListView.show();
    }
  }
};
