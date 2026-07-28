const fs = require("fs");
const path = require("path");

const Watcher = require("./watcher");

const STYLESHEET_EXTENSIONS = new Set([".css", ".less"]);

function isDirectory(directoryPath) {
  return fs.statSync(directoryPath, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// Entry types come straight from the directory read, so nothing is stat'ed
// individually: a stylesheet saved through a temporary file can disappear
// between the read and the stat, and that ENOENT used to crash the watcher.
function findStylesheets(directoryPath) {
  let entries;
  try {
    entries = fs.readdirSync(directoryPath, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }

  const stylesheetPaths = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!STYLESHEET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    stylesheetPaths.push(path.join(entry.parentPath, entry.name));
  }
  return stylesheetPaths;
}

module.exports = class PackageWatcher extends Watcher {
  static supportsPackage(pack, type) {
    if (pack.getType() === type && pack.getStylesheetPaths().length) return true;
    return false;
  }

  constructor(pack) {
    super();
    this.pack = pack;
    this.watch();
  }

  watch() {
    // Themes provided by a multi-theme package draw styles from several
    // directories (`extends` glob roots plus the theme's own directories).
    this.stylesheetsPaths = this.pack.getStylesheetDirectories?.() ?? [
      this.pack.getStylesheetsPath(),
    ];

    for (const stylesheetsPath of this.stylesheetsPaths) {
      if (!isDirectory(stylesheetsPath)) continue;
      this.watchDirectory(stylesheetsPath, () => this.handleDirectoryChange());
    }

    this.syncStylesheetWatchers();
  }

  syncStylesheetWatchers() {
    const stylesheetPaths = new Set(this.pack.getStylesheetPaths());
    for (const stylesheetsPath of this.stylesheetsPaths) {
      for (const stylesheetPath of findStylesheets(stylesheetsPath)) {
        stylesheetPaths.add(stylesheetPath);
      }
    }

    const watchedPaths = new Set(
      this.entities.filter((entity) => entity.isFile()).map((entity) => entity.getPath()),
    );
    for (const stylesheetPath of stylesheetPaths) {
      if (!watchedPaths.has(stylesheetPath)) this.watchFile(stylesheetPath);
    }
  }

  handleDirectoryChange() {
    this.syncStylesheetWatchers();
    this.queueReload(false);
  }

  loadStylesheet(pathName) {
    this.queueReload(path.basename(pathName).includes("variables"));
  }

  queueReload(globalsChanged) {
    this.globalsChanged ||= globalsChanged;
    this.scheduleReload(() => {
      if (this.globalsChanged) {
        this.globalsChanged = false;
        this.emitGlobalsChanged();
      } else {
        this.loadAllStylesheets();
      }
    });
  }

  loadAllStylesheets() {
    this.pack.reloadStylesheets();
  }
};
