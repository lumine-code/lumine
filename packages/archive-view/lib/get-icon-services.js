const { Emitter, CompositeDisposable } = require("atom");
const path = require("path");

// The fallback when no package provides `icons.class`. Core owns the
// octicon mapping so every consumer answers identically and shares its cache.
const DefaultFileIcons = {
  iconClassForPath: (filePath) => atom.ui.iconClassForPath(filePath),
};

let iconServices;
module.exports = function getIconServices() {
  if (!iconServices) iconServices = new IconServices();
  return iconServices;
};

class IconServices {
  constructor() {
    this.emitter = new Emitter();
    this.elementIcons = null;
    this.elementIconDisposables = new CompositeDisposable();
    this.fileIcons = DefaultFileIcons;
    this.fileIconSubscription = null;
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  resetElementIcons() {
    this.setElementIcons(null);
  }

  resetFileIcons() {
    this.setFileIcons(DefaultFileIcons);
  }

  setElementIcons(service) {
    if (service !== this.elementIcons) {
      if (this.elementIconDisposables != null) {
        this.elementIconDisposables.dispose();
      }
      if (service) {
        this.elementIconDisposables = new CompositeDisposable();
      }
      this.elementIcons = service;
      return this.emitter.emit("did-change");
    }
  }

  setFileIcons(service) {
    if (service !== this.fileIcons) {
      if (this.fileIconSubscription) {
        this.fileIconSubscription.dispose();
        this.fileIconSubscription = null;
      }
      this.fileIcons = service;
      // A provider that can change its answers for paths it has already been
      // asked about — a different icon set, or a light/dark switch — says so
      // here. Without it, views keep the classes they were first given.
      if (service && typeof service.onDidChange === "function") {
        this.fileIconSubscription = service.onDidChange(() => this.emitter.emit("did-change"));
      }
      return this.emitter.emit("did-change");
    }
  }

  updateDirectoryIcon(view) {
    view.entrySpan.classList.add("directory", "icon", "icon-file-directory");
    if (this.elementIcons) {
      view.iconDisposable = this.elementIcons(view.entrySpan, view.entry.path, {
        isDirectory: true,
      });
    }
  }

  updateFileIcon(view) {
    const nameClasses = ["file", "icon"];
    if (this.elementIcons) {
      const fullPath = path.join(view.archivePath, view.entry.path);
      const disposable = this.elementIcons(view.name, fullPath);
      view.disposables.add(disposable);
      this.elementIconDisposables.add(disposable);
    } else {
      let typeClass = this.fileIcons.iconClassForPath(view.entry.path, "archive-view") || [];
      if (!Array.isArray(typeClass) && typeClass) {
        typeClass = typeClass.toString().split(/\s+/g);
      }
      nameClasses.push(...typeClass);
    }
    view.name.classList.add(...nameClasses);
  }
}
