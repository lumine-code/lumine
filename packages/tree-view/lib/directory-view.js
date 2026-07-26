const { CompositeDisposable } = require("atom");
const { repoForPath } = require("./helpers");
const Directory = require("./directory");
const FileView = require("./file-view");

module.exports = class DirectoryView {
  constructor(directory) {
    this.directory = directory;
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(this.directory.onDidDestroy(() => this.subscriptions.dispose()));
    this.subscribeToDirectory();

    this.element = document.createElement("li");
    this.element.setAttribute("is", "tree-view-directory");
    this.element.classList.add("directory", "entry", "list-nested-item", "collapsed");

    this.header = document.createElement("div");
    this.header.classList.add("header", "list-item");

    this.directoryName = document.createElement("span");

    this.entries = document.createElement("ol");
    this.entries.classList.add("entries", "list-tree");

    // A squashed directory reads as the joined path, and that is what has to
    // land in `data-name` — the basename would be wrong for both the title and
    // any selector matching on it.
    const displayName =
      this.directory.squashedNames != null
        ? this.directory.squashedNames.join("")
        : this.directory.name;
    this.directoryName.title = displayName;

    if (this.directory.squashedNames != null) {
      const squashedDirectoryNameNode = document.createElement("span");
      squashedDirectoryNameNode.classList.add("squashed-dir");
      squashedDirectoryNameNode.textContent = this.directory.squashedNames[0];
      this.directoryName.appendChild(squashedDirectoryNameNode);
      this.directoryName.appendChild(document.createTextNode(this.directory.squashedNames[1]));
    } else {
      this.directoryName.textContent = this.directory.name;
    }

    // After the name is in place: an icon rendered as a child element would be
    // wiped by writing `textContent` over it.
    this.updateIcon(displayName);

    this.element.appendChild(this.header);
    this.header.appendChild(this.directoryName);
    this.element.appendChild(this.entries);

    if (this.directory.isRoot) {
      this.element.classList.add("project-root");
      this.header.classList.add("project-root-header");
    } else {
      this.element.draggable = true;
    }

    this.subscriptions.add(this.directory.onDidStatusChange(() => this.updateStatus()));
    this.updateStatus();

    if (this.directory.expansionState.isExpanded) {
      this.expand();
    }

    this.element.collapse = this.collapse.bind(this);
    this.element.expand = this.expand.bind(this);
    this.element.toggleExpansion = this.toggleExpansion.bind(this);
    this.element.reload = this.reload.bind(this);
    this.element.isExpanded = this.isExpanded;
    this.element.updateStatus = this.updateStatus.bind(this);
    this.element.isPathEqual = this.isPathEqual.bind(this);
    this.element.getPath = this.getPath.bind(this);
    this.element.directory = this.directory;
    this.element.header = this.header;
    this.element.entries = this.entries;
    this.element.directoryName = this.directoryName;
  }

  // Everything the registry needs to pick a folder glyph travels on the target.
  // The repository lookup is skipped for symlinks, which outrank it anyway.
  updateIcon(displayName) {
    const hints = {
      directory: true,
      symlink: this.directory.symlink,
      submodule: this.directory.submodule,
    };
    if (!this.directory.symlink) {
      const repo = repoForPath(this.directory.path);
      hints.repositoryRoot = repo != null && repo.relativize(this.directory.path) === "";
    }

    this.subscriptions.add(
      atom.icons.applyTo(
        this.directoryName,
        { path: this.directory.path, context: "tree-view", hints },
        { classes: ["name"], name: displayName },
      ),
    );
  }

  updateStatus() {
    this.element.classList.remove(
      "status-ignored",
      "status-modified",
      "status-added",
      "status-conflicted",
    );
    if (this.directory.status != null) {
      this.element.classList.add(`status-${this.directory.status}`);
    }
  }

  subscribeToDirectory() {
    this.subscriptions.add(
      this.directory.onDidAddEntries((addedEntries) => {
        if (!this.isExpanded) return;

        for (let entry of addedEntries) {
          const view = this.createViewForEntry(entry);

          const referenceNode = this.entries.children[entry.indexInParentDirectory];
          if (referenceNode) {
            this.entries.insertBefore(view.element, referenceNode);
          } else {
            this.entries.appendChild(view.element);
          }
        }
      }),
    );
  }

  getPath() {
    return this.directory.path;
  }

  isPathEqual(pathToCompare) {
    return this.directory.isPathEqual(pathToCompare);
  }

  createViewForEntry(entry) {
    const view = entry instanceof Directory ? new DirectoryView(entry) : new FileView(entry);

    const subscription = this.directory.onDidRemoveEntries((removedEntries) => {
      if (removedEntries.has(entry)) {
        view.element.remove();
        subscription.dispose();
      }
    });

    this.subscriptions.add(subscription);

    return view;
  }

  reload() {
    if (this.isExpanded) {
      this.directory.reload();
    }
  }

  toggleExpansion(isRecursive) {
    if (isRecursive == null) {
      isRecursive = false;
    }
    if (this.isExpanded) {
      this.collapse(isRecursive);
    } else {
      this.expand(isRecursive);
    }
  }

  async expand(isRecursive) {
    if (isRecursive == null) {
      isRecursive = false;
    }

    if (!this.isExpanded) {
      this.isExpanded = true;
      this.element.isExpanded = this.isExpanded;
      this.element.classList.add("expanded");
      this.element.classList.remove("collapsed");
      await this.directory.expand();
    }

    if (isRecursive) {
      for (let entry of this.entries.children) {
        if (entry.classList.contains("directory")) {
          await entry.expand(true);
        }
      }
    }
  }

  collapse(isRecursive) {
    if (isRecursive == null) isRecursive = false;
    this.isExpanded = false;
    this.element.isExpanded = false;

    if (isRecursive) {
      for (let entry of this.entries.children) {
        if (entry.isExpanded) {
          entry.collapse(true);
        }
      }
    }

    this.element.classList.remove("expanded");
    this.element.classList.add("collapsed");
    this.directory.collapse();
    this.entries.innerHTML = "";
  }
};
