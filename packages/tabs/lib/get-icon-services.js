const { Emitter, CompositeDisposable } = require("atom");

// The fallback when no package provides `icons.class`. Core owns the
// octicon mapping so every consumer answers identically and shares its cache.
// Tabs only want a default icon in the MRU switcher — a plain tab keeps its
// title unadorned unless a real icon provider is installed.
const DefaultFileIcons = {
  iconClassForPath(filePath, caller) {
    if (caller !== "tabs-mru-switcher") return "";
    if (typeof filePath !== "string") return "icon-file-text";
    return atom.ui.iconClassForPath(filePath);
  },
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

  updateMRUIcon(view) {
    if (this.elementIcons) {
      view.firstLineDiv.classList.add("icon");
      this.elementIconDisposables.add(this.elementIcons(view.firstLineDiv, view.itemPath));
    } else {
      let typeClasses = this.fileIcons.iconClassForPath(view.itemPath, "tabs-mru-switcher");
      if (typeClasses) {
        if (!Array.isArray(typeClasses)) typeClasses = typeClasses.split(/\s+/g);
        if (typeClasses) view.firstLineDiv.classList.add(...typeClasses);
      }
    }
  }

  updateTabIcon(view) {
    if (view.iconElement && !view.iconElement.disposed) return;
    if (view.iconName) {
      const names = !Array.isArray(view.iconName) ? view.iconName.split(/\s+/g) : view.iconName;
      view.itemTitle.classList.remove("icon", `icon-${names[0]}`, ...names);
    }
    if (typeof view.item.getIconName === "function") {
      view.iconName = view.item.getIconName();
    } else {
      view.iconName = null;
    }
    if (view.iconName) {
      return view.itemTitle.classList.add("icon", `icon-${view.iconName}`);
    } else if (view.path != null) {
      if (this.elementIcons) {
        view.itemTitle.classList.add("icon");
        view.iconElement = this.elementIcons(view.itemTitle, view.path, { isTabIcon: true });
        view.subscriptions.add(view.iconElement);
      } else {
        view.iconName = this.fileIcons.iconClassForPath(view.path, "tabs");
        if (view.iconName) {
          let names = view.iconName;
          if (!Array.isArray(names)) {
            names = names.toString().split(/\s+/g);
          }
          return view.itemTitle.classList.add("icon", ...names);
        }
      }
    }
  }
}
