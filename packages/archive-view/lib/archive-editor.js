const fs = require("fs");
const path = require("path");

const ArchiveEditorView = require("./archive-editor-view");

module.exports = {
  activate() {
    this.disposable = atom.workspace.addOpener((filePath = "") => {
      // Check that filePath exists before opening, in case a remote URI was given
      if (!isPathSupported(filePath)) return;
      let isFile = false;
      try {
        isFile = fs.statSync(filePath)?.isFile();
      } catch {
        /* not statable; treat as absent */
      }
      if (isFile) {
        return new ArchiveEditorView(filePath);
      }
    });
  },

  deactivate() {
    this.disposable.dispose();
    for (const item of atom.workspace.getPaneItems()) {
      if (item instanceof ArchiveEditorView) {
        item.destroy();
      }
    }
  },

  deserialize(params = {}) {
    let isFile = false;
    try {
      isFile = fs.statSync(params.path)?.isFile();
    } catch {
      /* not statable; treat as absent */
    }
    if (isFile) {
      return new ArchiveEditorView(params.path);
    } else {
      console.warn(
        `Can't build ArchiveEditorView for path "${params.path}"; file no longer exists`,
      );
    }
  },
};

function isPathSupported(filePath) {
  switch (path.extname(filePath)) {
    case ".egg":
    case ".epub":
    case ".jar":
    case ".love":
    case ".nupkg":
    case ".tar":
    case ".tgz":
    case ".war":
    case ".whl":
    case ".xpi":
    case ".zip":
      return true;
    case ".gz":
      return path.extname(path.basename(filePath, ".gz")) === ".tar";
    default:
      return false;
  }
}
