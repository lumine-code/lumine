const path = require("path");

module.exports = class BookmarksView {
  constructor(editorsBookmarks) {
    this.editorsBookmarks = editorsBookmarks;
  }

  destroy() {}

  getBookmarks() {
    const bookmarks = [];
    for (const { editor, markerLayer } of this.editorsBookmarks) {
      for (const marker of markerLayer.getMarkers()) {
        let filterText = `${marker.getStartBufferPosition().row}`;

        if (editor.getPath()) {
          filterText += ` ${editor.getPath()}`;
        }

        const bookmarkedLineText = editor.lineTextForBufferRow(marker.getStartBufferPosition().row);
        if (bookmarkedLineText) {
          filterText += ` ${bookmarkedLineText.trim()}`;
        }

        bookmarks.push({ marker, editor, filterText });
      }
    }
    return bookmarks;
  }

  show() {
    return atom.modals.open({
      id: "bookmarks.bookmarks",
      className: "bookmarks-view",
      placeholder: "Jump to a bookmark",
      emptyMessage: "No bookmarks found",
      source: this.getBookmarks(),
      renderer: {
        // A marker is unique per bookmark and survives the list rebuilding.
        entry: (bookmark) => ({ id: bookmark.marker, text: bookmark.filterText }),
        row: ({ marker, editor }) => {
          const startRow = marker.getStartBufferPosition().row;
          const endRow = marker.getEndBufferPosition().row;
          const bookmarkPath = editor.getPath() ? path.basename(editor.getPath()) : "untitled";
          let location = `${bookmarkPath}:${startRow + 1}`;
          if (startRow !== endRow) location += `-${endRow + 1}`;

          const lineText = editor.lineTextForBufferRow(startRow);
          return {
            className: "bookmark",
            label: location,
            detail: lineText ? { text: lineText.trim(), className: "line-text" } : undefined,
          };
        },
      },
      confirm: ({ item: { editor, marker } }) => {
        editor.setSelectedBufferRange(marker.getBufferRange(), { autoscroll: true });
        atom.workspace.paneForItem(editor).activate();
        atom.workspace.paneForItem(editor).activateItem(editor);
      },
    });
  }

  hide() {
    if (atom.modals.getActiveSession()) atom.modals.cancel("api");
  }
};
