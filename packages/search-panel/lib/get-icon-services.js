const { Emitter, CompositeDisposable } = require("atom");

// The fallback when no package provides `icons.class`. Core owns the
// octicon mapping so every consumer answers identically and shares its cache.
const DefaultFileIcons = {
  iconClassForPath: (filePath) => atom.ui.iconClassForPath(filePath),
};

let iconServices;
module.exports = function () {
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

  updateIcon(view, filePath) {
    if (this.elementIcons) {
      if (view.refs && view.refs.icon instanceof Element) {
        if (view.iconDisposable) {
          view.iconDisposable.dispose();
          this.elementIconDisposables.remove(view.iconDisposable);
        }
        view.iconDisposable = this.elementIcons(view.refs.icon, filePath);
        this.elementIconDisposables.add(view.iconDisposable);
      }
    } else {
      let iconClass = this.fileIcons.iconClassForPath(filePath, "search-panel") || "";
      if (Array.isArray(iconClass)) {
        iconClass = iconClass.join(" ");
      }
      view.refs.icon.className = iconClass + " icon";
    }
  }
}
