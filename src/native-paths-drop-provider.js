const fs = require("@lumine-code/fs-plus");
const { webUtils } = require("electron");
const { uniqueStrings } = require("./workspace-drop-protocol");

function getPathForFile(file) {
  try {
    const filePath = webUtils?.getPathForFile?.(file);
    if (filePath) return filePath;
  } catch {
    // Test doubles and older embedders may still expose File#path.
  }
  return file?.path || "";
}

module.exports = class NativePathsDropProvider {
  constructor(manager) {
    this.manager = manager;
  }

  propose({ offer, native }) {
    const serializedPaths = offer?.kind === "paths";
    const treeFiles = offer?.kind === "tree-entries" && offer.files;
    if (!serializedPaths && !treeFiles && !native.hasFileItems) return null;
    return {
      effect: "copy",
      allowedLocations: ["center"],
      allowSplit:
        serializedPaths || treeFiles
          ? offer.files
          : !(native.known && native.hasDirectories && !native.hasFiles),
    };
  }

  async prepareDrop({ descriptor, dataTransfer }) {
    let paths;
    if (descriptor?.kind === "paths" || descriptor?.kind === "tree-entries") {
      const items =
        descriptor.kind === "tree-entries"
          ? (descriptor.items || []).filter((item) => item?.type === "file")
          : descriptor.items || [];
      paths = items.map((item) => (typeof item === "string" ? item : item?.path));
    } else {
      // FileList is available only while the drop event is being dispatched.
      // Copy every path before yielding to the asynchronous stat calls below.
      paths = Array.from(dataTransfer?.files || []).map(getPathForFile);
    }

    paths = uniqueStrings(paths);
    if (paths.length === 0) return null;

    const classified = await Promise.all(
      paths.map(async (filePath) => {
        try {
          const stats = await fs.promises.stat(filePath);
          return { path: filePath, directory: stats.isDirectory() };
        } catch {
          // Preserve the editor's existing missing-file behavior.
          return { path: filePath, directory: false };
        }
      }),
    );
    const filePaths = classified.filter((entry) => !entry.directory).map((entry) => entry.path);
    const directoryPaths = classified.filter((entry) => entry.directory).map((entry) => entry.path);
    return { filePaths, directoryPaths, allowSplit: filePaths.length > 0 };
  }

  async perform(context, prepared) {
    const { filePaths, directoryPaths } = prepared;
    let pane = context.pane;
    const openedItems = [];

    if (filePaths.length > 0) {
      pane = context.resolvePane({ allowSplit: prepared.allowSplit });
      let index = context.index == null ? pane.getActiveItemIndex() + 1 : context.index;
      for (const filePath of filePaths) {
        const item = await this.manager.workspace.open(filePath, {
          pane,
          activateItem: false,
          activatePane: false,
          pending: false,
        });
        if (!item) continue;
        const openedPane = this.manager.workspace.paneForItem(item);
        if (!openedPane) continue;
        if (openedPane !== pane) {
          index = Math.max(0, Math.min(index, pane.getItems().length));
          openedPane.moveItemToPane(item, pane, index);
        } else {
          const openedIndex = pane.getItems().indexOf(item);
          index = Math.max(0, Math.min(index, pane.getItems().length));
          if (openedIndex < index) index--;
          if (openedIndex !== index) pane.moveItem(item, index);
        }
        openedItems.push(item);
        index = pane.getItems().indexOf(item) + 1;
      }
    }

    if (directoryPaths.length > 0) {
      await this.manager.applicationDelegate.open({ pathsToOpen: directoryPaths, here: true });
    }

    if (filePaths.length > 0 && openedItems.length === 0) {
      throw new Error("None of the dropped files could be opened");
    }

    const lastItem = openedItems.at(-1);
    if (lastItem) pane.activateItem(lastItem);
    if (openedItems.length > 0) pane.activate();
    return { pane, openedItems, filePaths, directoryPaths };
  }
};
