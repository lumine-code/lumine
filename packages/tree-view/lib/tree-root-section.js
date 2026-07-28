const path = require("path");
const fs = require("./fs-compat");
const TreeEntry = require("./tree-entry");

module.exports = class TreeRootSection {
  constructor(treeView, config) {
    this.treeView = treeView;
    this.config = config;
    this.isExpanded = true;
    this.isVisible = true;
    this.entries = [];

    this.element = document.createElement("ol");
    this.element.classList.add(
      config.className,
      "tree-view-special",
      "list-tree",
      "has-collapsable-children",
    );
    const firstProjectRow = Array.from(this.treeView.list.children).find((child) =>
      child.classList.contains("tree-view-row"),
    );
    this.treeView.list.insertBefore(this.element, firstProjectRow ?? null);

    const syntheticPath = `special-root://${config.name.toLowerCase().replace(/\s+/g, "-")}`;
    const item = {
      name: config.name,
      path: syntheticPath,
      status: null,
      contains: () => false,
      isPathEqual: (pathToCompare) => pathToCompare === syntheticPath,
      getEntries: () => config.getEntries(),
    };
    this.root = new TreeEntry(treeView, {
      item,
      kind: "directory",
      specialRoot: true,
      section: this,
      name: config.name,
      rootClassName: `${config.className}-root`,
      iconClass: config.iconClass,
    });
    this.root.isExpanded = true;
    this.treeView.registerTreeEntry(this.root, { project: false });
    this.refresh();
  }

  expand() {
    if (this.isExpanded) return Promise.resolve();
    this.isExpanded = true;
    this.root.isExpanded = true;
    this.refresh();
    return Promise.resolve();
  }

  collapse() {
    if (!this.isExpanded) return;
    this.isExpanded = false;
    this.root.isExpanded = false;
    this.treeView.releaseSelectionInSection(this);
    this.treeView.rebuildVisibleRows();
  }

  toggleExpansion() {
    if (this.isExpanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  refresh() {
    for (const entry of this.entries) this.treeView.unregisterTreeEntry(entry);
    this.entries = [];
    this.root.children = this.entries;

    for (const filePath of this.config.getEntries()) {
      const isDirectory = fs.isDirectorySync(filePath);
      const name = path.basename(filePath);
      const item = {
        name,
        path: filePath,
        status: null,
        isPathEqual: (pathToCompare) =>
          filePath === pathToCompare || filePath === atom.project.resolve(pathToCompare),
        contains: () => false,
      };
      const entry = new TreeEntry(this.treeView, {
        item,
        kind: isDirectory ? "directory" : "file",
        parent: this.root,
        special: true,
        section: this,
        name,
        entryClassName: this.config.entryClassName,
        exists: fs.existsSync(filePath),
      });
      this.entries.push(entry);
      this.treeView.registerTreeEntry(entry, { project: false });
    }

    this.root.children = this.entries;
    this.treeView.rebuildVisibleRows();
  }

  toggleVisible() {
    this.isVisible = !this.isVisible;
    if (!this.isVisible) this.treeView.releaseSelectionInSection(this);
    this.treeView.rebuildVisibleRows();
  }

  isRenderable() {
    return this.isVisible && this.entries.length > 0;
  }

  destroy() {
    this.root.children = this.entries;
    this.treeView.unregisterTreeEntry(this.root);
    this.entries = [];
    this.element.remove();
  }
};
