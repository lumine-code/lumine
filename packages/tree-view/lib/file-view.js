const { CompositeDisposable } = require("atom");

module.exports = class FileView {
  constructor(file) {
    this.file = file;
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(this.file.onDidDestroy(() => this.subscriptions.dispose()));

    this.element = document.createElement("li");
    this.element.setAttribute("is", "tree-view-file");
    this.element.draggable = true;
    this.element.classList.add("file", "entry", "list-item");

    // On the row, not on the name span: a context menu is resolved by walking
    // up from whatever was clicked, so anything the span carries is only
    // reachable when the pointer is over the text itself.
    this.element.dataset.name = this.file.name;
    this.element.dataset.path = this.file.path;

    this.fileName = document.createElement("span");
    this.element.appendChild(this.fileName);
    this.fileName.textContent = this.file.name;
    this.fileName.title = this.file.name;

    this.element.getPath = this.getPath.bind(this);
    this.element.isPathEqual = this.isPathEqual.bind(this);
    this.element.file = this.file;
    this.element.fileName = this.fileName;
    this.element.updateStatus = this.updateStatus.bind(this);

    this.updateIcon();
    this.subscriptions.add(this.file.onDidStatusChange(() => this.updateStatus()));
    this.updateStatus();
  }

  // The registry keeps the icon current on its own, so there is nothing to
  // subscribe to here. `setData` is off because the row owns `data-name`/
  // `data-path`; letting the span carry them too is what used to make
  // `[data-name$=".md"]` menu items miss every click beside the filename.
  updateIcon() {
    this.subscriptions.add(
      atom.icons.applyTo(
        this.fileName,
        {
          path: this.file.path,
          context: "tree-view",
          hints: { directory: false, symlink: this.file.symlink },
        },
        { classes: ["name"], setData: false },
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
    if (this.file.status != null) {
      this.element.classList.add(`status-${this.file.status}`);
    }
  }

  getPath() {
    return this.file.path;
  }

  isPathEqual(pathToCompare) {
    return this.file.isPathEqual(pathToCompare);
  }
};
