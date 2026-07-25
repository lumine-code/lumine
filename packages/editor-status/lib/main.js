const { Disposable } = require("atom");
const FileInfoView = require("./file-info-view");
const EditorPositionView = require("./editor-position-view");

module.exports = {
  consumeStatusBar(statusBar) {
    this.fileInfo = new FileInfoView();
    // See the priority convention in packages/status-bar/README.md.
    this.fileInfoTile = statusBar.addLeftTile({ item: this.fileInfo.element, priority: 310 });

    this.editorPosition = new EditorPositionView();
    this.editorPositionTile = statusBar.addLeftTile({
      item: this.editorPosition.element,
      priority: 510,
    });

    return new Disposable(() => this.teardown());
  },

  deactivate() {
    this.teardown();
  },

  teardown() {
    this.fileInfoTile?.destroy();
    this.fileInfoTile = null;
    this.fileInfo?.destroy();
    this.fileInfo = null;

    this.editorPositionTile?.destroy();
    this.editorPositionTile = null;
    this.editorPosition?.destroy();
    this.editorPosition = null;
  },
};
