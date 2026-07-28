module.exports = class TreeEntry {
  constructor(
    treeView,
    {
      item,
      kind,
      parent = null,
      projectRoot = false,
      specialRoot = false,
      special = false,
      section = null,
      name = null,
      entryClassName = null,
      rootClassName = null,
      iconClass = null,
      exists = true,
    },
  ) {
    this.treeView = treeView;
    this.item = item;
    this.kind = kind;
    this.parent = parent;
    this.children = [];
    this.projectRoot = projectRoot;
    this.specialRoot = specialRoot;
    this.special = special;
    this.section = section;
    this.name = name ?? item?.name ?? "";
    this.entryClassName = entryClassName;
    this.rootClassName = rootClassName;
    this.iconClass = iconClass;
    this.exists = exists;
    this.isExpanded = false;
    this.views = new Set();
    this.subscriptions = null;
    this.index = -1;
    this.depth = parent ? parent.depth + 1 : 0;
    this.top = 0;
    this.height = 0;
    this.subtreeEndIndex = -1;
  }

  get directory() {
    return this.kind === "directory" ? this.item : null;
  }

  get file() {
    return this.kind === "file" ? this.item : null;
  }

  getPath() {
    return this.item?.path ?? "";
  }

  isPathEqual(pathToCompare) {
    return this.item?.isPathEqual?.(pathToCompare) ?? this.getPath() === pathToCompare;
  }

  contains(pathToCheck) {
    return this.directory?.contains?.(pathToCheck) ?? false;
  }

  expand(isRecursive = false) {
    return this.treeView.expandTreeEntry(this, isRecursive);
  }

  collapse(isRecursive = false) {
    return this.treeView.collapseTreeEntry(this, isRecursive);
  }

  toggleExpansion(isRecursive = false) {
    if (this.isExpanded) {
      return this.collapse(isRecursive);
    }
    return this.expand(isRecursive);
  }

  reload() {
    return this.treeView.reloadTreeEntry(this);
  }

  syncViews() {
    for (const view of this.views) view.sync();
  }
};
