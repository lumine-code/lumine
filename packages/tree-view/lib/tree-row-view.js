const { CompositeDisposable } = require("atom");
const { repoForPath } = require("./helpers");

module.exports = class TreeRowView {
  constructor(treeView, kind, { sticky = false } = {}) {
    this.treeView = treeView;
    this.kind = kind;
    this.sticky = sticky;
    this.entry = null;
    this.subscriptions = new CompositeDisposable();

    this.element = document.createElement("li");
    this.header = document.createElement("div");
    this.name = document.createElement("span");
  }

  bind(entry) {
    this.unbind();
    this.entry = entry;
    entry.views.add(this);

    const element = this.element;
    element.className = "";
    element.removeAttribute("data-name");
    element.removeAttribute("data-path");
    element.style.cssText = "";
    element.treeEntry = entry;
    element.header = null;
    element.directoryName = null;
    element.fileName = null;
    element.getPath = () => entry.getPath();
    element.isPathEqual = (pathToCompare) => entry.isPathEqual(pathToCompare);
    element.expand = (recursive) => entry.expand(recursive);
    element.collapse = (recursive) => entry.collapse(recursive);
    element.toggleExpansion = (recursive) => entry.toggleExpansion(recursive);
    element.reload = () => entry.reload();
    element.updateStatus = () => this.sync();
    element.directory = entry.directory;
    element.file = entry.file;

    if (this.sticky) {
      element.classList.add(
        "tree-view-sticky-header",
        "entry",
        "directory",
        "list-nested-item",
        "expanded",
      );
      element.style.setProperty("--tree-view-depth", entry.depth);
    } else {
      element.classList.add("tree-view-row", "entry");
      element.style.height = `${entry.height}px`;
      element.style.setProperty("--tree-view-depth", entry.depth);
    }

    if (entry.special && !entry.specialRoot) {
      this.bindSpecialEntry(entry);
    } else if (this.kind === "directory") {
      this.bindDirectory(entry);
    } else {
      this.bindFile(entry);
    }

    if (entry.special) {
      element.classList.add("tree-view-special-entry");
      if (entry.entryClassName) element.classList.add(entry.entryClassName);
    }
    if (entry.specialRoot) {
      element.classList.add("tree-view-special-root");
      if (entry.rootClassName) element.classList.add(entry.rootClassName);
    }

    this.sync();
    return element;
  }

  bindDirectory(entry) {
    const { element, header, name } = this;
    header.replaceChildren(name);
    element.replaceChildren(header);
    element.classList.add("directory", "list-nested-item");
    if (!this.sticky) {
      element.setAttribute("is", entry.special ? "tree-view-special-entry" : "tree-view-directory");
    }
    header.className = this.sticky
      ? "tree-view-sticky-header-row header list-item"
      : "header list-item";
    name.className = "";
    name.replaceChildren();

    const displayName =
      entry.directory?.squashedNames != null ? entry.directory.squashedNames.join("") : entry.name;
    name.title = displayName;
    header.dataset.name = displayName;
    header.dataset.path = entry.getPath();

    if (entry.directory?.squashedNames != null) {
      const squashedName = document.createElement("span");
      squashedName.classList.add("squashed-dir");
      squashedName.textContent = entry.directory.squashedNames[0];
      name.appendChild(squashedName);
      name.appendChild(document.createTextNode(entry.directory.squashedNames[1]));
    } else {
      name.textContent = displayName;
    }

    if (entry.projectRoot || entry.specialRoot) {
      element.classList.add("project-root");
      header.classList.add("project-root-header");
    }

    if (entry.specialRoot) {
      name.classList.add("name", "icon");
      if (entry.iconClass) name.classList.add(entry.iconClass);
    } else {
      const hints = {
        directory: true,
        symlink: entry.directory?.symlink,
        submodule: entry.directory?.submodule,
      };
      if (!entry.directory?.symlink) {
        const repo = repoForPath(entry.getPath());
        hints.repositoryRoot = repo != null && repo.relativize(entry.getPath()) === "";
      }
      this.subscriptions.add(
        atom.icons.applyTo(
          name,
          { path: entry.getPath(), context: "tree-view", hints },
          { classes: ["name"], setData: false },
        ),
      );
    }

    element.header = header;
    element.directoryName = name;
    element.draggable = !entry.projectRoot && !entry.specialRoot;
    header.draggable = entry.projectRoot && !this.sticky;
  }

  bindFile(entry) {
    const { element, name } = this;
    element.replaceChildren(name);
    element.classList.add("file", "list-item");
    element.setAttribute("is", entry.special ? "tree-view-special-entry" : "tree-view-file");
    element.dataset.name = entry.name;
    element.dataset.path = entry.getPath();
    element.draggable = true;

    name.className = "";
    name.textContent = entry.name;
    name.title = entry.getPath();
    this.subscriptions.add(
      atom.icons.applyTo(
        name,
        {
          path: entry.getPath(),
          context: "tree-view",
          hints: { directory: false, symlink: entry.file?.symlink },
        },
        { classes: ["name"], setData: false },
      ),
    );

    element.fileName = name;
  }

  bindSpecialEntry(entry) {
    const { element, name } = this;
    element.replaceChildren(name);
    element.classList.add(entry.kind, "list-item");
    element.setAttribute("is", "tree-view-special-entry");
    element.dataset.name = entry.name;
    element.dataset.path = entry.getPath();
    element.draggable = true;

    name.className = "";
    name.textContent = entry.name;
    name.title = entry.getPath();
    this.subscriptions.add(
      atom.icons.applyTo(
        name,
        {
          path: entry.getPath(),
          context: "tree-view",
          hints: { directory: entry.kind === "directory" },
        },
        { classes: ["name"], setData: false },
      ),
    );

    if (entry.kind === "directory") {
      element.directoryName = name;
    } else {
      element.fileName = name;
    }
  }

  sync() {
    const { entry, element } = this;
    if (!entry) return;

    const expandable = this.kind === "directory" && !entry.special;
    element.classList.toggle("expanded", expandable && entry.isExpanded);
    element.classList.toggle("collapsed", expandable && !entry.isExpanded);
    element.classList.toggle("selected", this.treeView.selectedEntries.has(entry));
    element.classList.toggle("ignored-name", entry.item?.ignoredByName === true);
    element.classList.toggle("status-removed", entry.special && !entry.exists);
    element.isExpanded = entry.isExpanded;
    element.setAttribute("role", "treeitem");
    element.setAttribute("aria-level", entry.depth + 1);
    element.setAttribute(
      "aria-selected",
      this.treeView.selectedEntries.has(entry) ? "true" : "false",
    );
    if (expandable) {
      element.setAttribute("aria-expanded", entry.isExpanded ? "true" : "false");
    } else {
      element.removeAttribute("aria-expanded");
    }

    for (const className of Array.from(element.classList)) {
      if (className.startsWith("status-") && className !== "status-removed") {
        element.classList.remove(className);
      }
    }
    if (entry.item?.status != null) {
      element.classList.add(`status-${entry.item.status}`);
    }
  }

  unbind() {
    if (this.entry) {
      this.entry.views.delete(this);
      this.entry = null;
    }
    this.subscriptions.dispose();
    this.subscriptions = new CompositeDisposable();
    this.element.treeEntry = null;
  }

  destroy() {
    this.unbind();
    this.element.remove();
  }
};
