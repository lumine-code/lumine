const path = require("path");
const FileView = require("../lib/file-view");
const DirectoryView = require("../lib/directory-view");
const TreeEntry = require("../lib/tree-entry");
const TreeRowView = require("../lib/tree-row-view");
const { SpecialRootEntry } = require("../lib/special-root-view");

// `data-name`/`data-path` are the anchor packages register per-file context
// menus on. They belong on the row, because a context menu is resolved by
// walking up from whatever was clicked — anything the inner `.name` span
// carries is unreachable unless the pointer is over the text itself.
describe("tree-view entry attributes", () => {
  const noop = () => ({ dispose() {} });

  function fileView(name, filePath) {
    return new FileView({
      name,
      path: filePath,
      symlink: false,
      status: null,
      onDidDestroy: noop,
      onDidStatusChange: noop,
      isPathEqual: (other) => other === filePath,
    });
  }

  function directoryView(name, directoryPath, { squashedNames = null } = {}) {
    return new DirectoryView({
      name,
      path: directoryPath,
      squashedNames,
      symlink: false,
      submodule: false,
      isRoot: false,
      status: null,
      expansionState: { isExpanded: false },
      onDidDestroy: noop,
      onDidStatusChange: noop,
      onDidAddEntries: noop,
      isPathEqual: (other) => other === directoryPath,
    });
  }

  describe("a file row", () => {
    it("carries them on the `li`, not on the name span", () => {
      const view = fileView("README.md", path.join("/root", "README.md"));

      expect(view.element.dataset.name).toBe("README.md");
      expect(view.element.dataset.path).toBe(path.join("/root", "README.md"));
      expect(view.fileName.dataset.name).toBeUndefined();
      expect(view.fileName.dataset.path).toBeUndefined();
    });

    it("reports the path without reading it back out of the DOM", () => {
      const view = fileView("README.md", path.join("/root", "README.md"));
      view.fileName.remove();

      expect(view.element.getPath()).toBe(path.join("/root", "README.md"));
    });
  });

  describe("a directory row", () => {
    it("carries them on the header, not on the `li` that wraps the children", () => {
      const view = directoryView("src", path.join("/root", "src"));

      expect(view.header.dataset.name).toBe("src");
      expect(view.header.dataset.path).toBe(path.join("/root", "src"));
      // On the `li` they would also match right-clicks on every nested entry,
      // since the walk visits ancestors.
      expect(view.element.dataset.name).toBeUndefined();
      expect(view.element.dataset.path).toBeUndefined();
      expect(view.directoryName.dataset.name).toBeUndefined();
      expect(view.directoryName.dataset.path).toBeUndefined();
    });

    it("uses the joined name for a squashed directory", () => {
      const view = directoryView("a", path.join("/root", "a", "b"), {
        squashedNames: ["a/", "b"],
      });

      expect(view.header.dataset.name).toBe("a/b");
      expect(view.header.dataset.path).toBe(path.join("/root", "a", "b"));
    });
  });

  describe("a special-root entry", () => {
    it("carries them on the `li`, as a regular file row does", () => {
      const entry = new SpecialRootEntry(path.join("/root", "notes.md"), "recent");

      expect(entry.element.dataset.name).toBe("notes.md");
      expect(entry.element.dataset.path).toBe(path.join("/root", "notes.md"));
      expect(entry.fileName.dataset.name).toBeUndefined();
      expect(entry.fileName.dataset.path).toBeUndefined();
    });
  });

  describe("a logical row", () => {
    const treeView = {
      selectedEntries: new Set(),
      expandTreeEntry() {},
      collapseTreeEntry() {},
      reloadTreeEntry() {},
    };

    function item(name, entryPath) {
      return {
        name,
        path: entryPath,
        status: null,
        isPathEqual: (candidate) => candidate === entryPath,
      };
    }

    it("keeps file metadata on the mounted row", () => {
      const entryPath = path.join("/root", "README.md");
      const entry = new TreeEntry(treeView, {
        item: item("README.md", entryPath),
        kind: "file",
      });
      entry.depth = 2;
      entry.height = 24;
      const view = new TreeRowView(treeView, "file");

      view.bind(entry);

      expect(view.element.dataset.name).toBe("README.md");
      expect(view.element.dataset.path).toBe(entryPath);
      expect(view.name.dataset.name).toBeUndefined();
      expect(view.element.getAttribute("aria-level")).toBe("3");
      expect(view.element.treeEntry).toBe(entry);
      view.destroy();
    });

    it("renders a special directory as a leaf without a disclosure arrow", () => {
      const entryPath = path.join("/root", "notes");
      const entry = new TreeEntry(treeView, {
        item: item("notes", entryPath),
        kind: "directory",
        special: true,
      });
      entry.height = 24;
      const view = new TreeRowView(treeView, "directory");

      view.bind(entry);

      expect(view.element.matches(".directory.list-item")).toBe(true);
      expect(view.element.classList.contains("list-nested-item")).toBe(false);
      expect(view.element.getAttribute("is")).toBe("tree-view-special-entry");
      expect(view.element.hasAttribute("aria-expanded")).toBe(false);
      view.destroy();
    });
  });
});
