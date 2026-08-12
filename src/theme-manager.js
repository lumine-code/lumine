const path = require("path");
const _ = require("@lumine-code/underscore-plus");
const { Disposable, Emitter } = require("@lumine-code/event-kit");
const fs = require("@lumine-code/fs-plus");

// Keeping a reference to the entire object so that it can be mocked more
// easily in the specs.
const watcher = require("./path-watcher");

// The core stylesheets, in loading order (relative to static/). Plain CSS —
// all theming flows through the custom-property contract at runtime, so the
// base never recompiles on theme switches.
const BASE_STYLESHEETS = [
  "variables/base-variables.css",
  "icons/octicons.css",
  "icons/icons.css",
  "normalize.css",
  "scaffolding.css",
  "core-ui/cursors.css",
  "core-ui/theme-transition.css",
  "core-ui/panels.css",
  "core-ui/docks.css",
  "core-ui/panes.css",
  "core-ui/syntax.css",
  "core-ui/text-editor.css",
  "core-ui/workspace-view.css",
  "lumine-ui/styles/private/scaffolding.css",
  "lumine-ui/styles/private/alerts.css",
  "lumine-ui/styles/private/close.css",
  "lumine-ui/styles/private/code.css",
  "lumine-ui/styles/private/forms.css",
  "lumine-ui/styles/private/links.css",
  "lumine-ui/styles/private/navs.css",
  "lumine-ui/styles/private/sections.css",
  "lumine-ui/styles/private/tables.css",
  "lumine-ui/styles/private/utilities.css",
  "lumine-ui/styles/badges.css",
  "lumine-ui/styles/button-groups.css",
  "lumine-ui/styles/buttons.css",
  "lumine-ui/styles/git-status.css",
  "lumine-ui/styles/icons.css",
  "lumine-ui/styles/inputs.css",
  "lumine-ui/styles/layout.css",
  "lumine-ui/styles/lists.css",
  "lumine-ui/styles/loading.css",
  "lumine-ui/styles/messages.css",
  "lumine-ui/styles/modals.css",
  "lumine-ui/styles/panels.css",
  "lumine-ui/styles/select-list.css",
  "lumine-ui/styles/site-colors.css",
  "lumine-ui/styles/text.css",
  "lumine-ui/styles/tooltip.css",
];

// The accent override is a stylesheet rather than an inline style on `:root`
// so it stays inside the cascade the rest of theming uses: priority 1 sits
// above every theme stylesheet (0) and still below the user stylesheet (2), so
// a user's own `--accent-color` keeps winning. An inline style would have beaten
// both.
const ACCENT_STYLESHEET_PATH = "lumine://accent-color";
const ACCENT_STYLESHEET_PRIORITY = 1;
const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

// Only the fills and the text that sits on them. `--accent-only-text-color` is
// accent-as-text-on-the-theme's-background, where the theme has already tuned
// contrast and an arbitrary system color can fail it, so it stays theme-owned.
// The two text colors reuse the contrast formula from base-variables.css rather
// than assuming white — a system accent can be any lightness at all.
function buildAccentStylesheet(accentColor) {
  return `\
:root {
  --accent-color: ${accentColor};
  --accent-bg-color: ${accentColor};
  --accent-text-color: lch(from var(--accent-color) calc((49.44 - l) * infinity) 0 0);
  --accent-bg-text-color: lch(from var(--accent-bg-color) calc((49.44 - l) * infinity) 0 0);
}
`;
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @public
 * @status extended
 *
 * Handles loading and activating available themes.
 *
 * An instance of this class is always available as the `lumine.themes` global.
 */
module.exports = class ThemeManager {
  constructor({
    packageManager,
    config,
    styleManager,
    notificationManager,
    viewRegistry,
    applicationDelegate,
  }) {
    this.packageManager = packageManager;
    this.config = config;
    this.styleManager = styleManager;
    this.notificationManager = notificationManager;
    this.viewRegistry = viewRegistry;
    this.applicationDelegate = applicationDelegate;
    this.emitter = new Emitter();
    this.styleSheetDisposablesBySourcePath = {};
    this.initialLoadComplete = false;
    this.themeSwitchPromise = Promise.resolve();
    this.themePacks = new Set();
    this.packageManager.registerPackageActivator(this, ["theme"]);

    this.reloadStylesheet = _.debounce(() => {
      this.loadUserStylesheet();
    }, 20);
  }

  initialize({ resourcePath, configDirPath, safeMode }) {
    this.resourcePath = resourcePath;
    this.configDirPath = configDirPath;
    this.safeMode = safeMode;
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status essential
   *
   * Invoke `callback` when style sheet changes associated with
   * updating the list of active themes have completed.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActiveThemes(callback) {
    return this.emitter.on("did-change-active-themes", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` when a theme pack is registered or removed.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeThemePacks(callback) {
    return this.emitter.on("did-change-theme-packs", callback);
  }

  /**
   * @category Accessing Available Themes
   */

  getAvailableNames() {
    // TODO: Maybe should change to list all the available themes out there?
    return this.getLoadedNames();
  }

  /**
   * @public
   * @status public
   *
   * Register a named light/dark theme pack.
   *
   * A pack groups the complete theme stacks for both appearance modes.
   *
   * @param {Object} themePack - The theme pack.
   * @param {String} themePack.name - Its user-facing name.
   * @param {Array<String>} themePack.light - Theme packages for light mode.
   * @param {Array<String>} themePack.dark - Theme packages for dark mode.
   * @returns {Disposable} that removes the pack.
   */
  registerThemePack({ name, light, dark } = {}) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError("A theme pack must have a non-empty name.");
    }

    const normalizePair = (pair, mode) => {
      if (
        !Array.isArray(pair) ||
        pair.length === 0 ||
        pair.some((themeName) => typeof themeName !== "string" || themeName.length === 0)
      ) {
        throw new TypeError(`The '${mode}' side of a theme pack must be a non-empty name array.`);
      }
      return Object.freeze(pair.slice());
    };

    const themePack = Object.freeze({
      name: name.trim(),
      light: normalizePair(light, "light"),
      dark: normalizePair(dark, "dark"),
    });

    this.themePacks.add(themePack);
    this.emitter.emit("did-change-theme-packs", this.getThemePacks());

    return new Disposable(() => {
      if (!this.themePacks.delete(themePack)) return;
      this.emitter.emit("did-change-theme-packs", this.getThemePacks());
    });
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array<Object>} registered theme packs sorted by their user-facing names.
   */
  getThemePacks() {
    return Array.from(this.themePacks).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} whether both configured mode pairs match `themePack`.
   */
  isThemePackActive(themePack) {
    if (!themePack) return false;
    const pairsMatch = (keyPath, expected) => {
      const actual = this.config.get(keyPath);
      return (
        Array.isArray(actual) &&
        Array.isArray(expected) &&
        actual.length === expected.length &&
        actual.every((themeName, index) => themeName === expected[index])
      );
    };
    return pairsMatch("theme.light", themePack.light) && pairsMatch("theme.dark", themePack.dark);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Object|undefined} registered pack matching both configured mode pairs.
   */
  getActiveThemePack() {
    return this.getThemePacks().find((themePack) => this.isThemePackActive(themePack)) ?? null;
  }

  /**
   * @public
   * @status public
   *
   * Configure both appearance modes from `themePack`.
   */
  setThemePack(themePack) {
    if (!themePack || !Array.isArray(themePack.light) || !Array.isArray(themePack.dark)) {
      throw new TypeError("A theme pack must provide light and dark theme arrays.");
    }
    if (this.isThemePackActive(themePack)) return false;

    this.config.transact(() => {
      this.config.set("theme.light", themePack.light.slice());
      this.config.set("theme.dark", themePack.dark.slice());
    });
    return true;
  }

  /**
   * @category Accessing Loaded Themes
   */

  /**
   * @public
   * @status public
   *
   * @returns {Array} of `Strings` of all the loaded theme names.
   */
  getLoadedThemeNames() {
    return this.getLoadedThemes().map((theme) => theme.name);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array} of all the loaded themes.
   */
  getLoadedThemes() {
    return this.packageManager.getLoadedPackages().filter((pack) => pack.isTheme());
  }

  /**
   * @category Accessing Active Themes
   */

  /**
   * @public
   * @status public
   *
   * @returns {Array} of `Strings` of all the active theme names.
   */
  getActiveThemeNames() {
    return this.getActiveThemes().map((theme) => theme.name);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array} of all the active themes.
   */
  getActiveThemes() {
    return this.packageManager.getActivePackages().filter((pack) => pack.isTheme());
  }

  activatePackages() {
    return this.activateThemes();
  }

  /**
   * @category Managing Enabled Themes
   */

  // The config key holding the theme pair for the mode currently in effect.
  getActiveThemesKeyPath() {
    return this.isDarkThemeMode() ? "theme.dark" : "theme.light";
  }

  warnForNonExistentThemes() {
    let themeNames = this.config.get(this.getActiveThemesKeyPath()) || [];
    if (!Array.isArray(themeNames)) {
      themeNames = [themeNames];
    }
    for (let themeName of themeNames) {
      if (!themeName || typeof themeName !== "string" || !this.isThemeInstalled(themeName)) {
        console.warn(`Enabled theme '${themeName}' is not installed.`);
      }
    }
  }

  // A theme states its palette as CSS custom properties in variables.css.
  // One that ships none was written against the Less variable contract, which
  // the editor no longer compiles: it will load, and the parts of the window
  // it does not restyle itself keep the previous theme's colors. Said once per
  // theme so a switch back and forth is not noisy.
  warnForThemeWithoutVariables(themeName) {
    this.themesWarnedForMissingVariables ??= new Set();
    if (this.themesWarnedForMissingVariables.has(themeName)) return;
    if (this.getThemeVariablesPaths(themeName).length > 0) return;
    this.themesWarnedForMissingVariables.add(themeName);
    console.warn(
      `Theme '${themeName}' ships no variables.css, so it defines none of the color ` +
        `custom properties the editor and its packages read.`,
    );
  }

  // A theme is installed when it is already loaded (which covers themes
  // provided by multi-theme packages) or when its name resolves to a package
  // on disk.
  isThemeInstalled(themeName) {
    return (
      this.packageManager.getLoadedPackage(themeName) != null ||
      this.packageManager.resolvePackagePath(themeName) != null
    );
  }

  /**
   * @public
   * @status public
   *
   * Get the enabled theme names from the config.
   *
   * @returns {Array} array of theme names in the order that they should be activated.
   */
  getEnabledThemeNames() {
    let themeNames = this.config.get(this.getActiveThemesKeyPath()) || [];
    if (!Array.isArray(themeNames)) {
      themeNames = [themeNames];
    }
    themeNames = themeNames.filter(
      (themeName) => typeof themeName === "string" && this.isThemeInstalled(themeName),
    );

    // Nothing usable configured: fall back to the bundled pair matching the
    // current mode. A configured half pair (only a ui or only a syntax theme)
    // runs alone on top of the base-variables fallbacks.
    if (themeNames.length === 0) {
      themeNames = this.isDarkThemeMode()
        ? ["one-night-ui", "one-night-syntax"]
        : ["one-day-ui", "one-day-syntax"];
      themeNames = themeNames.filter((name) => this.isThemeInstalled(name));
    }

    // Reverse so the first (top) theme is loaded after the others. We want
    // the first/top theme to override later themes in the stack.
    return themeNames.reverse();
  }

  // Returns the `theme` field of the named theme's metadata ("ui" or
  // "syntax"), or null when the theme can't be found.
  getThemeType(themeName) {
    const loadedPackage = this.packageManager.getLoadedPackage(themeName);
    if (loadedPackage) {
      return loadedPackage.metadata.theme || null;
    }
    const packagePath = this.packageManager.resolvePackagePath(themeName);
    if (!packagePath) return null;
    const metadata = this.packageManager.loadPackageMetadata(packagePath, true);
    return metadata?.theme || null;
  }

  /**
   * @category Private
   */

  // The styles directory of the named theme, or null.
  getThemeStylesPath(themeName) {
    const loadedPackage = this.packageManager.getLoadedPackage(themeName);
    if (loadedPackage != null) {
      return loadedPackage.getStylesheetsPath();
    }
    const packagePath = this.packageManager.resolvePackagePath(themeName);
    if (!packagePath) return null;
    const deprecatedPath = path.join(packagePath, "stylesheets");
    if (fs.isDirectorySync(deprecatedPath)) return deprecatedPath;
    return path.join(packagePath, "styles");
  }

  // A theme defines its palette as CSS custom properties in one or more
  // variables.css files in its resolved stylesheet chain. Returns those paths
  // in cascade order, or an empty array for a theme that defines none.
  getThemeVariablesPaths(themeName) {
    const loadedPackage = this.packageManager.getLoadedPackage(themeName);
    if (loadedPackage) {
      return loadedPackage
        .getStylesheetPaths()
        .filter((stylesheetPath) => path.basename(stylesheetPath) === "variables.css");
    }

    const stylesPath = this.getThemeStylesPath(themeName);
    if (!stylesPath) return [];
    const variablesPath = path.join(stylesPath, "variables.css");
    return fs.isFileSync(variablesPath) ? [variablesPath] : [];
  }

  // Resolve and apply the stylesheet specified by the path.
  //
  // * `stylesheetPath` A `String` path to the stylesheet that can be an absolute
  //   path or a relative path that will be resolved against the load path.
  //
  // Returns a `Disposable` on which `.dispose()` can be called to remove the
  // required stylesheet.
  requireStylesheet(stylesheetPath, priority) {
    let fullPath = this.resolveStylesheet(stylesheetPath);
    if (fullPath) {
      const content = this.loadStylesheet(fullPath);
      return this.applyStylesheet(fullPath, content, priority);
    } else {
      throw new Error(`Could not find a file at path '${stylesheetPath}'`);
    }
  }

  async unwatchUserStylesheet() {
    this.userStylesheetSubscription?.dispose();
    this.userStylesheetSubscription = null;

    // Pause a moment for file-watcher cleanup.
    await wait(10);
  }

  removeUserStylesheet() {
    this.userStyleSheetDisposable?.dispose();
    this.userStyleSheetDisposable = null;
  }

  async loadUserStylesheet() {
    await this.watchUserStylesheet();
    this.applyUserStylesheet(this.readUserStylesheet());
  }

  async watchUserStylesheet() {
    await this.unwatchUserStylesheet();

    const userStylesheetPath = this.styleManager.getUserStyleSheetPath();
    if (!fs.isFileSync(userStylesheetPath)) {
      return;
    }

    try {
      // A single-file `watchPath` is served non-recursively by the Node
      // watcher, which reports the file's real path. Resolve symlinks up front
      // so our subscription and the reported paths line up.
      let realStylesheetPath = fs.realpathSync(userStylesheetPath);

      this.userStylesheetSubscription = await watcher.watchPath(realStylesheetPath, {}, () => {
        this.reloadStylesheet();
      });
    } catch {
      let message = `
Unable to watch path: \`${path.basename(userStylesheetPath)}\`. Make sure
you have permissions to \`${userStylesheetPath}\`.
`;
      if (process.platform === "linux") {
        message = `${message}

On Linux the per-user inotify watch limit is often too low. See [this document][watches] for more info.
[watches]:https://lumine-code.github.io/docs.html#troubleshooting/common-issues
`;
      }
      this.notificationManager.addError(message, { dismissable: true });
    }
  }

  readUserStylesheet() {
    const sourcePath = this.styleManager.getUserStyleSheetPath();
    if (!fs.isFileSync(sourcePath)) {
      return { sourcePath, exists: false, contents: null };
    }

    try {
      return { sourcePath, exists: true, contents: this.loadStylesheet(sourcePath) };
    } catch (error) {
      // Unreadable — say so and keep the previous styles applied, rather than
      // leaving the window silently stuck on them.
      this.notificationManager.addError(`Error loading \`${path.basename(sourcePath)}\``, {
        detail: error.message,
        dismissable: true,
      });
      return { sourcePath, exists: true, contents: null };
    }
  }

  applyUserStylesheet({ sourcePath, exists, contents }) {
    if (!exists) {
      this.removeUserStylesheet();
      return;
    }
    if (contents == null) return;

    // `addStyleSheet` updates the existing style element in place when the
    // source path matches, so the user styles never leave the DOM. Drop the
    // old disposable without disposing it — disposing would remove the
    // reused element.
    this.userStyleSheetDisposable = this.styleManager.addStyleSheet(contents, {
      sourcePath,
      priority: 2,
    });
  }

  loadBaseStylesheets() {
    this.reloadBaseStylesheets();
  }

  getBaseStylesheetPath() {
    return path.join(this.resourcePath, "static", "lumine.css");
  }

  // The absolute paths of the files the base stylesheet is built from
  // (used by dev-live-reload to watch them).
  getBaseStylesheetFilePaths() {
    const staticPath = path.join(this.resourcePath, "static");
    return BASE_STYLESHEETS.map((relativePath) => path.join(staticPath, relativePath));
  }

  buildBaseStylesheet() {
    const staticPath = path.join(this.resourcePath, "static");
    return BASE_STYLESHEETS.map(
      (relativePath) =>
        `/* --- ${relativePath} --- */\n` +
        fs.readFileSync(path.join(staticPath, relativePath), "utf8"),
    ).join("\n");
  }

  reloadBaseStylesheets() {
    this.applyStylesheet(this.getBaseStylesheetPath(), this.buildBaseStylesheet(), -2);
  }

  stylesheetElementForId(id) {
    const escapedId = id.replace(/\\/g, "\\\\");
    return document.head.querySelector(`lumine-styles style[source-path="${escapedId}"]`);
  }

  resolveStylesheet(stylesheetPath) {
    if (path.extname(stylesheetPath).length > 0) {
      return fs.resolveOnLoadPath(stylesheetPath);
    } else {
      return fs.resolveOnLoadPath(stylesheetPath, ["css"]);
    }
  }

  loadStylesheet(stylesheetPath) {
    return fs.readFileSync(stylesheetPath, "utf8");
  }

  removeStylesheet(stylesheetPath) {
    if (this.styleSheetDisposablesBySourcePath[stylesheetPath] != null) {
      this.styleSheetDisposablesBySourcePath[stylesheetPath].dispose();
    }
  }

  applyStylesheet(path, text, priority) {
    this.styleSheetDisposablesBySourcePath[path] = this.styleManager.addStyleSheet(text, {
      priority,
      sourcePath: path,
    });

    return this.styleSheetDisposablesBySourcePath[path];
  }

  // Track the operating system's accent color so `theme.accentSource: system`
  // can hand it to the theme variables. The main process pushes changes; the
  // starting value has to be asked for, and only when it is actually wanted —
  // under the default `theme` source nothing here ever crosses IPC.
  observeSystemAccentColor() {
    this.config.onDidChange("theme.accentSource", () => this.refreshSystemAccentColor());
    this.applicationDelegate?.onDidChangeAccentColor?.((accentColor) => {
      this.systemAccentColor = accentColor;
      this.applyAccentColor();
    });
    return this.refreshSystemAccentColor();
  }

  async refreshSystemAccentColor() {
    if (this.config.get("theme.accentSource") === "system") {
      try {
        this.systemAccentColor = await this.applicationDelegate?.invokeApp?.("getAccentColor");
      } catch (error) {
        // A platform that cannot answer is not a failure worth a notification:
        // the theme's own accent is a perfectly good result.
        console.warn(`Could not read the system accent color: ${error?.message ?? error}`);
        this.systemAccentColor = null;
      }
    }
    this.applyAccentColor();
  }

  applyAccentColor() {
    const accentColor =
      this.config.get("theme.accentSource") === "system" ? this.systemAccentColor : null;

    // The value is normalized in the main process, so a string that does not
    // match here did not come from there — never interpolate it into CSS.
    if (typeof accentColor !== "string" || !ACCENT_COLOR_PATTERN.test(accentColor)) {
      this.removeStylesheet(ACCENT_STYLESHEET_PATH);
      return;
    }

    this.applyStylesheet(
      ACCENT_STYLESHEET_PATH,
      buildAccentStylesheet(accentColor),
      ACCENT_STYLESHEET_PRIORITY,
    );
  }

  activateThemes() {
    return new Promise((resolve) => {
      // Created lazily so specs can install a fake before activation.
      if (this.systemThemeQuery == null) {
        this.systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
      }

      // Serialize switches so a rapid re-toggle can't interleave with the
      // previous switch's package bookkeeping. The active pair is derived from
      // `theme.mode` + `theme.light`/`theme.dark`, so we switch whenever any of
      // those (or the system preference, under `mode: system`) changes.
      const queueSwitch = (onSettled) => {
        this.themeSwitchPromise = this.themeSwitchPromise
          .then(() => this.switchThemes())
          .then(
            () => onSettled?.(),
            (error) => {
              console.error(`Failed to switch themes: ${error?.stack ?? error}`);
              onSettled?.();
            },
          );
      };

      // The initial activation resolves the returned promise.
      queueSwitch(resolve);

      this.config.onDidChange("theme.mode", () => queueSwitch());
      this.config.onDidChange("theme.light", () => {
        if (!this.isDarkThemeMode()) queueSwitch();
      });
      this.config.onDidChange("theme.dark", () => {
        if (this.isDarkThemeMode()) queueSwitch();
      });
      this.systemThemeQuery.addEventListener("change", () => {
        if (this.config.get("theme.mode") === "system") queueSwitch();
      });

      // Independent of the theme pair: the accent override rides above whichever
      // themes are active, so it neither waits for nor blocks a switch.
      this.observeSystemAccentColor();
    });
  }

  // Whether the dark theme pair should be in effect for the current mode.
  isDarkThemeMode() {
    const mode = this.config.get("theme.mode");
    return mode === "dark" || (mode !== "light" && Boolean(this.systemThemeQuery?.matches));
  }

  async switchThemes() {
    this.warnForNonExistentThemes();

    // The old themes' style sheets stay in the DOM while the new themes load
    // and compile, so the window never paints unstyled.
    const oldThemes = this.getActiveThemes();
    const enabledThemeNames = this.getEnabledThemeNames();

    const newThemes = [];
    for (const themeName of enabledThemeNames) {
      if (!this.isThemeInstalled(themeName)) {
        console.warn(`Failed to activate theme '${themeName}' because it isn't installed.`);
        continue;
      }
      const pack = this.packageManager.loadPackage(themeName);
      if (pack == null) continue;
      this.warnForThemeWithoutVariables(themeName);
      // Theme packages read their style sheets on activation, not on load, so
      // read here — before the swap — so the whole window can restyle at once.
      try {
        pack.loadStylesheets();
      } catch (error) {
        pack.handleError(`Failed to load the ${pack.name} theme stylesheets`, error);
      }
      newThemes.push(pack);
    }

    // The user stylesheet and the active packages' style sheets are read now
    // too, so the whole window can restyle in a single frame.
    const userStylesheet = this.readUserStylesheet();

    const activePackages = this.packageManager
      .getActivePackages()
      .filter((pack) => pack.getType() !== "theme" && typeof pack.loadStylesheets === "function");
    for (const pack of activePackages) {
      try {
        pack.loadStylesheets();
      } catch (error) {
        pack.handleError(`Failed to reload the ${pack.name} package stylesheets`, error);
      }
    }

    // Apply all the precompiled styles in one synchronous block; the browser
    // cannot paint a frame in the middle of it.
    const applyStyles = () => {
      this.removeActiveThemeClasses(oldThemes);
      for (const pack of oldThemes) pack.deactivateStylesheets();
      for (const pack of newThemes) pack.activateStylesheets();
      this.addActiveThemeClasses(newThemes);
      this.applyUserStylesheet(userStylesheet);
      for (const pack of activePackages) {
        pack.deactivateStylesheets();
        pack.activateStylesheets();
      }
    };

    await this.applyWithCrossFade(applyStyles);

    // Complete the package lifecycle switch. Themes present in both sets stay
    // active; their recompiled styles were already re-attached above, and
    // `activatePackage` skips re-attaching because `stylesheetsActivated` is
    // set.
    const newThemeNames = new Set(newThemes.map((pack) => pack.name));
    const themesToDeactivate = oldThemes.filter((pack) => !newThemeNames.has(pack.name));
    await Promise.all(
      themesToDeactivate.map((pack) => this.packageManager.deactivatePackage(pack.name)),
    );
    // Re-register sequentially so the active-package order — which
    // `getActiveThemes` reflects — matches the enabled order. Continuing
    // themes are dropped from the registry first (their style sheets stay
    // attached) and re-added at the right position.
    for (const pack of newThemes) {
      delete this.packageManager.activePackages[pack.name];
    }
    for (const pack of newThemes) {
      await this.packageManager.activatePackage(pack.name);
    }

    await this.watchUserStylesheet();
    this.initialLoadComplete = true;
    this.emitter.emit("did-change-active-themes");
  }

  // Run `apply` inside a View Transition so the window cross-fades from its
  // old rendering to its new one; the compositor snapshots the old rendering
  // before `apply` mutates the page.
  //
  // Never in spec mode: the spec harness fakes `setTimeout`, freezing the
  // escape timer below, and a pending transition suppresses rendering —
  // animation-frame callbacks stop for every spec that runs after the switch.
  async applyWithCrossFade(apply) {
    if (
      !this.initialLoadComplete ||
      document.hidden ||
      typeof document.startViewTransition !== "function" ||
      (typeof lumine !== "undefined" && lumine.window.isSpecMode())
    ) {
      apply();
      return;
    }

    const transition = document.startViewTransition(apply);
    // A skipped transition rejects `ready` and `finished`; that's expected,
    // not an error.
    transition.ready.catch(() => {});
    transition.finished.catch(() => {});
    // Hidden, occluded, or otherwise render-throttled windows may never get
    // the rendering opportunity the transition callback waits for; force the
    // swap through rather than stalling the switch. Skipping still invokes the
    // update callback.
    const timer = setTimeout(() => transition.skipTransition(), 100);
    try {
      await transition.updateCallbackDone;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @public
   * @status public
   *
   * Apply an appearance change that restyles the window without
   * changing which themes are active — a theme package toggling a variant
   * attribute on the document root, say.
   *
   * Mutating the document directly would leave anything that caches resolved
   * colors — every package that paints to a canvas — showing the old palette
   * until something unrelated made it redraw. This runs the mutation inside
   * the same cross-fade a theme switch uses and notifies those consumers from
   * within it, so they repaint as part of the same transition.
   *
   * @param {Function} mutate - applying the change to the document.
   * @returns {Promise} that resolves once the change has been applied.
   */
  updateAppearance(mutate) {
    return this.applyWithCrossFade(() => {
      mutate();
      this.emitter.emit("did-change-active-themes");
    });
  }

  deactivateThemes() {
    this.removeActiveThemeClasses();
    this.unwatchUserStylesheet();
    this.removeUserStylesheet();
    const results = this.getActiveThemes().map((pack) =>
      this.packageManager.deactivatePackage(pack.name),
    );
    return Promise.all(results.filter((r) => r != null && typeof r.then === "function"));
  }

  isInitialLoadComplete() {
    return this.initialLoadComplete;
  }

  addActiveThemeClasses(themes = this.getActiveThemes()) {
    const workspaceElement = this.viewRegistry.getView(this.workspace);
    if (workspaceElement) {
      for (const pack of themes) {
        workspaceElement.classList.add(`theme-${pack.name}`);
      }
    }
  }

  removeActiveThemeClasses(themes = this.getActiveThemes()) {
    const workspaceElement = this.viewRegistry.getView(this.workspace);
    for (const pack of themes) {
      workspaceElement.classList.remove(`theme-${pack.name}`);
    }
  }
};
