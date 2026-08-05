const path = require("path");
const fs = require("@lumine-code/fs-plus");
const { globSync } = require("tinyglobby");
const Package = require("./package");

const STYLESHEET_EXTENSIONS = new Set([".css", ".less"]);

module.exports = class ThemePackage extends Package {
  // A theme provided by a multi-theme package (a `themes` array in
  // package.json) lives in one or more styles directories inside the owning
  // package. Package-qualified `extends` globs load first and this theme's
  // styles load afterward as overrides.
  constructor(options) {
    super(options);
    this.themeStyleExtensions = options.themeStyleExtensions ?? [];
    this.themeStylesDirectories = options.themeStylesDirectories ?? null;
  }

  getType() {
    return "theme";
  }

  getStyleSheetPriority() {
    return 1;
  }

  getStylesheetsPath() {
    if (this.themeStylesDirectories != null) {
      return this.themeStylesDirectories[this.themeStylesDirectories.length - 1];
    }
    return super.getStylesheetsPath();
  }

  getStylesheetPaths() {
    if (this.themeStylesDirectories != null) {
      const stylesheetPaths = this.getExtendedStylesheetPaths();
      for (const directory of this.themeStylesDirectories) {
        stylesheetPaths.push(...fs.listSync(directory, ["css", "less"]).sort());
      }
      return stylesheetPaths;
    }
    return super.getStylesheetPaths();
  }

  getStylesheetDirectories() {
    if (this.themeStylesDirectories != null) {
      const directories = this.themeStyleExtensions.map(({ watchDirectory }) => watchDirectory);
      return [...new Set([...directories, ...this.themeStylesDirectories])];
    }
    return [this.getStylesheetsPath()];
  }

  getExtendedStylesheetPaths() {
    const stylesheetPaths = [];
    const seenPaths = new Set();

    for (const { packagePath, pattern } of this.themeStyleExtensions) {
      const matches = globSync(pattern, {
        cwd: packagePath,
        absolute: true,
        onlyFiles: true,
      })
        .map((stylesheetPath) => path.normalize(stylesheetPath))
        .filter((stylesheetPath) =>
          STYLESHEET_EXTENSIONS.has(path.extname(stylesheetPath).toLowerCase()),
        )
        .sort();

      for (const stylesheetPath of matches) {
        if (seenPaths.has(stylesheetPath)) continue;
        seenPaths.add(stylesheetPath);
        stylesheetPaths.push(stylesheetPath);
      }
    }

    return stylesheetPaths;
  }

  // Use this theme in the mode currently in effect, replacing any existing
  // theme of the same type (ui/syntax) in that mode's pair.
  enable() {
    const keyPath = this.themeManager.getActiveThemesKeyPath();
    let themes = this.config.get(keyPath);
    themes = Array.isArray(themes) ? themes.slice() : [];
    themes = themes.filter(
      (name) => name !== this.name && this.themeManager.getThemeType(name) !== this.metadata.theme,
    );
    themes.unshift(this.name);
    this.config.set(keyPath, themes);
  }

  // Stop using this theme in either mode's pair.
  disable() {
    for (const keyPath of ["theme.light", "theme.dark"]) {
      const themes = this.config.get(keyPath);
      if (Array.isArray(themes) && themes.includes(this.name)) {
        this.config.set(
          keyPath,
          themes.filter((name) => name !== this.name),
        );
      }
    }
  }

  load() {
    this.loadTime = 0;
    this.configSchemaRegisteredOnLoad = this.registerConfigSchemaFromMetadata();
    return this;
  }

  activate() {
    if (this.activationPromise == null) {
      this.activationPromise = new Promise((resolve, reject) => {
        this.resolveActivationPromise = resolve;
        this.rejectActivationPromise = reject;
        this.measure("activateTime", () => {
          try {
            this.loadStylesheets();
            this.activateNow();
          } catch (error) {
            this.handleError(`Failed to activate the ${this.name} theme`, error);
          }
        });
      });
    }

    return this.activationPromise;
  }
};
