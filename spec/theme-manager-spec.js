const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();

const { conditionPromise: waitForCondition } = require("./helpers/async-spec-helpers");

// The active theme pair is derived from `theme.mode` + `theme.light`/
// `theme.dark`. Set both pairs so the active pair is the given list regardless
// of the mode currently in effect.
function setActiveThemes(names) {
  lumine.config.set("theme.light", names);
  lumine.config.set("theme.dark", names);
}

describe("lumine.themes", () => {
  beforeEach(() => {
    jasmine.useRealClock();
    spyOn(lumine.window, "isSpecMode").and.returnValue(false);
    spyOn(console, "warn");
  });

  afterEach(async () => {
    await lumine.themes.deactivateThemes();
    try {
      temp.cleanupSync();
    } catch {
      // Temp cleanup is best-effort.
    }
  });

  describe("theme getters and setters", () => {
    beforeEach(() => {
      jasmine.snapshotDeprecations();
      lumine.packages.loadPackages();
    });

    afterEach(() => jasmine.restoreDeprecationsSnapshot());

    describe("getLoadedThemes", () =>
      it("gets all the loaded themes", () => {
        const themes = lumine.themes.getLoadedThemes();
        expect(themes.length).toBeGreaterThan(2);
      }));

    describe("getActiveThemes", () =>
      it("gets all the active themes", async function () {
        await lumine.themes.activateThemes();

        const names = lumine.config.get(lumine.themes.getActiveThemesKeyPath());
        expect(names.length).toBeGreaterThan(0);
        const themes = lumine.themes.getActiveThemes();
        expect(themes).toHaveLength(names.length);
      }));
  });

  describe("theme packs", () => {
    let registration;

    afterEach(() => registration?.dispose());

    it("registers immutable light/dark pairs and notifies observers", () => {
      const didChangeThemePacks = jasmine.createSpy();
      lumine.themes.onDidChangeThemePacks(didChangeThemePacks);
      const light = ["day-ui", "day-syntax"];
      const dark = ["night-ui", "night-syntax"];

      registration = lumine.themes.registerThemePack({ name: "Example", light, dark });
      light[0] = "changed-ui";

      expect(lumine.themes.getThemePacks()).toEqual([
        {
          name: "Example",
          light: ["day-ui", "day-syntax"],
          dark: ["night-ui", "night-syntax"],
        },
      ]);
      expect(didChangeThemePacks).toHaveBeenCalled();

      registration.dispose();
      registration = null;
      expect(lumine.themes.getThemePacks()).toEqual([]);
      expect(didChangeThemePacks.calls.count()).toBe(2);
    });

    it("sets and identifies the active pack", () => {
      registration = lumine.themes.registerThemePack({
        name: "Example",
        light: ["day-ui", "day-syntax"],
        dark: ["night-ui", "night-syntax"],
      });
      const [themePack] = lumine.themes.getThemePacks();

      lumine.themes.setThemePack(themePack);

      expect(lumine.config.get("theme.light")).toEqual(["day-ui", "day-syntax"]);
      expect(lumine.config.get("theme.dark")).toEqual(["night-ui", "night-syntax"]);
      expect(lumine.themes.isThemePackActive(themePack)).toBe(true);
      expect(lumine.themes.getActiveThemePack()).toBe(themePack);
    });

    it("rejects incomplete registrations", () => {
      expect(() => lumine.themes.registerThemePack()).toThrow();
      expect(() =>
        lumine.themes.registerThemePack({ name: "Example", light: [], dark: ["night-ui"] }),
      ).toThrow();
    });
  });

  describe("when the active theme pair contains invalid entries", () => {
    it("ignores them", () => {
      setActiveThemes([
        "theme-with-ui-variables",
        null,
        undefined,
        "",
        false,
        4,
        {},
        [],
        "theme-with-syntax-variables",
      ]);

      expect(lumine.themes.getEnabledThemeNames()).toEqual([
        "theme-with-syntax-variables",
        "theme-with-ui-variables",
      ]);
    });
  });

  describe("when the active theme pair contains only one theme", () => {
    it("runs the configured half alone without auto-completing the pair", () => {
      setActiveThemes(["theme-modern-ui"]);
      expect(lumine.themes.getEnabledThemeNames()).toEqual(["theme-modern-ui"]);
    });
  });

  describe("when the active theme pair changes", () => {
    it("add/removes stylesheets to reflect the new config value", async () => {
      jasmine.useRealClock();
      let didChangeActiveThemesHandler = jasmine.createSpy();
      lumine.themes.onDidChangeActiveThemes(didChangeActiveThemesHandler);
      spyOn(lumine.styles, "getUserStyleSheetPath").and.callFake(() => null);

      await lumine.themes.activateThemes();
      didChangeActiveThemesHandler.calls.reset();
      setActiveThemes([]);

      await waitForCondition(() => {
        return didChangeActiveThemesHandler.calls.count() === 1;
      });

      didChangeActiveThemesHandler.calls.reset();
      expect(document.querySelectorAll("style.theme")).toHaveLength(0);
      expect(document.querySelectorAll('style[priority="1"]')).toHaveLength(0);
      setActiveThemes(["theme-with-ui-variables"]);

      await waitForCondition(() => {
        return didChangeActiveThemesHandler.calls.count() === 1;
      });

      didChangeActiveThemesHandler.calls.reset();
      // The theme's two stylesheets.
      expect(document.querySelectorAll('style[priority="1"]')).toHaveLength(2);
      expect(
        document.querySelectorAll('style[priority="1"]')[0].getAttribute("source-path"),
      ).toMatch(/theme-with-ui-variables/);
      setActiveThemes(["theme-with-syntax-variables", "theme-with-ui-variables"]);

      await waitForCondition(() => {
        return didChangeActiveThemesHandler.calls.count() === 1;
      });

      didChangeActiveThemesHandler.calls.reset();
      // The ui theme's two stylesheets and the syntax theme's one; the first
      // configured theme is attached last so that it wins.
      expect(document.querySelectorAll('style[priority="1"]')).toHaveLength(3);
      expect(
        document.querySelectorAll('style[priority="1"]')[0].getAttribute("source-path"),
      ).toMatch(/theme-with-ui-variables/);
      expect(
        document.querySelectorAll('style[priority="1"]')[2].getAttribute("source-path"),
      ).toMatch(/theme-with-syntax-variables/);
      setActiveThemes([]);

      await waitForCondition(() => {
        return didChangeActiveThemesHandler.calls.count() === 1;
      });

      didChangeActiveThemesHandler.calls.reset();
      expect(document.querySelectorAll('style[priority="1"]')).toHaveLength(0);

      // theme-with-ui-variables has a styles directory, theme-with-index-at-root doesn't
      setActiveThemes(["theme-with-index-at-root", "theme-with-ui-variables"]);

      await waitForCondition(() => {
        return didChangeActiveThemesHandler.calls.count() === 1;
      });

      // One root stylesheet plus the ui theme's two.
      expect(document.querySelectorAll('style[priority="1"]')).toHaveLength(3);
    });

    it("adds theme-* classes to the workspace for each active theme", async () => {
      setActiveThemes(["theme-modern-ui", "theme-modern-syntax"]);

      let didChangeActiveThemesHandler = jasmine.createSpy();
      lumine.themes.onDidChangeActiveThemes(didChangeActiveThemesHandler);

      await lumine.themes.activateThemes();

      const workspaceElement = lumine.workspace.getElement();
      expect(workspaceElement).toHaveClass("theme-theme-modern-ui");

      lumine.themes.onDidChangeActiveThemes((didChangeActiveThemesHandler = jasmine.createSpy()));
      setActiveThemes(["theme-with-ui-variables", "theme-with-syntax-variables"]);

      await waitForCondition(() => {
        return didChangeActiveThemesHandler.calls.count() > 0;
      });

      // `theme-` twice as it prefixes the name with `theme-`
      expect(workspaceElement).toHaveClass("theme-theme-with-ui-variables");
      expect(workspaceElement).toHaveClass("theme-theme-with-syntax-variables");
      expect(workspaceElement).not.toHaveClass("theme-theme-modern-ui");
      expect(workspaceElement).not.toHaveClass("theme-theme-modern-syntax");
    });
  });

  describe("::updateAppearance(mutate)", () => {
    it("applies the mutation and notifies theme consumers", async () => {
      let didChangeActiveThemesHandler = jasmine.createSpy();
      lumine.themes.onDidChangeActiveThemes(didChangeActiveThemesHandler);

      let mutated = false;
      await lumine.themes.updateAppearance(() => {
        // The notification has to come *after* the document is mutated, or
        // consumers re-read the palette they already had.
        mutated = true;
        expect(didChangeActiveThemesHandler).not.toHaveBeenCalled();
      });

      expect(mutated).toBe(true);
      expect(didChangeActiveThemesHandler.calls.count()).toBe(1);
    });

    it("leaves the active themes alone", async () => {
      await lumine.themes.activateThemes();
      setActiveThemes(["theme-with-ui-variables"]);
      await waitForCondition(() => lumine.themes.getActiveThemeNames().length === 1);

      await lumine.themes.updateAppearance(() => {});

      expect(lumine.themes.getActiveThemeNames()).toEqual(["theme-with-ui-variables"]);
    });
  });

  describe("when the theme.mode config value changes", () => {
    let systemThemeQuery, systemThemeListeners;

    beforeEach(() => {
      jasmine.useRealClock();
      systemThemeListeners = [];
      systemThemeQuery = {
        matches: true,
        addEventListener(event, listener) {
          systemThemeListeners.push(listener);
        },
      };
      lumine.themes.systemThemeQuery = systemThemeQuery;
      lumine.config.set("theme.light", ["theme-modern-ui", "theme-modern-syntax"]);
      lumine.config.set("theme.dark", ["theme-with-ui-variables", "theme-with-syntax-variables"]);
    });

    async function waitForThemeChange(fn) {
      let didChangeActiveThemesHandler = jasmine.createSpy();
      lumine.themes.onDidChangeActiveThemes(didChangeActiveThemesHandler);
      fn();
      await waitForCondition(() => didChangeActiveThemesHandler.calls.count() === 1);
    }

    it("applies the pair matching the mode and follows the system preference", async () => {
      lumine.config.set("theme.mode", "system");
      await lumine.themes.activateThemes();

      // system + matches:true -> dark pair
      expect(lumine.themes.getActiveThemeNames()).toContain("theme-with-ui-variables");

      await waitForThemeChange(() => lumine.config.set("theme.mode", "light"));
      expect(lumine.themes.getActiveThemeNames()).toContain("theme-modern-ui");

      await waitForThemeChange(() => lumine.config.set("theme.mode", "dark"));
      expect(lumine.themes.getActiveThemeNames()).toContain("theme-with-ui-variables");

      // In system mode, an OS preference change switches the pair.
      systemThemeQuery.matches = false;
      await waitForThemeChange(() => lumine.config.set("theme.mode", "system"));
      expect(lumine.themes.getActiveThemeNames()).toContain("theme-modern-ui");

      await waitForThemeChange(() => {
        systemThemeQuery.matches = true;
        for (const listener of systemThemeListeners) listener();
      });
      expect(lumine.themes.getActiveThemeNames()).toContain("theme-with-ui-variables");
    });

    it("switches when the pair for the active mode changes", async () => {
      lumine.config.set("theme.mode", "dark");
      await lumine.themes.activateThemes();
      expect(lumine.themes.getActiveThemeNames()).toContain("theme-with-ui-variables");

      await waitForThemeChange(() =>
        lumine.config.set("theme.dark", ["theme-modern-ui", "theme-modern-syntax"]),
      );
      expect(lumine.themes.getActiveThemeNames()).toContain("theme-modern-ui");
    });

    it("ignores changes to the pair for the inactive mode", async () => {
      lumine.config.set("theme.mode", "dark");
      await lumine.themes.activateThemes();

      const handler = jasmine.createSpy();
      lumine.themes.onDidChangeActiveThemes(handler);
      // Changing the light pair while in dark mode does not switch.
      lumine.config.set("theme.light", ["theme-modern-ui", "theme-modern-syntax"]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("when a theme fails to load", () =>
    it("logs a warning", () => {
      console.warn.calls.reset();
      lumine.packages.activatePackage("a-theme-that-will-not-be-found").then(
        () => {},
        () => {},
      );
      expect(console.warn.calls.count()).toBe(1);
      expect(console.warn.calls.argsFor(0)[0]).toContain(
        "Could not resolve 'a-theme-that-will-not-be-found'",
      );
    }));

  describe("::requireStylesheet(path)", () => {
    beforeEach(() => jasmine.snapshotDeprecations());

    afterEach(() => jasmine.restoreDeprecationsSnapshot());

    it("synchronously loads css at the given path and installs a style tag for it in the head", () => {
      let styleElementAddedHandler;
      lumine.styles.onDidAddStyleElement(
        (styleElementAddedHandler = jasmine.createSpy("styleElementAddedHandler")),
      );

      const cssPath = getAbsolutePath(lumine.project.getDirectories()[0], "css.css");
      const lengthBefore = document.querySelectorAll("head style").length;

      lumine.themes.requireStylesheet(cssPath);
      expect(document.querySelectorAll("head style").length).toBe(lengthBefore + 1);

      expect(styleElementAddedHandler).toHaveBeenCalled();

      const element = document.querySelector('head style[source-path*="css.css"]');
      expect(element.getAttribute("source-path")).toEqualPath(cssPath);
      expect(element.textContent).toBe(fs.readFileSync(cssPath, "utf8"));

      // doesn't append twice
      styleElementAddedHandler.calls.reset();
      lumine.themes.requireStylesheet(cssPath);
      expect(document.querySelectorAll("head style").length).toBe(lengthBefore + 1);
      expect(styleElementAddedHandler).not.toHaveBeenCalled();

      document.querySelectorAll('head style[id*="css.css"]').forEach((styleElement) => {
        styleElement.remove();
      });
    });
    it("supports requiring a stylesheet without an explicit extension", () => {
      lumine.themes.requireStylesheet(path.join(__dirname, "fixtures", "css"));
      expect(
        document.querySelector('head style[source-path*="css.css"]').getAttribute("source-path"),
      ).toEqualPath(getAbsolutePath(lumine.project.getDirectories()[0], "css.css"));

      document.querySelector('head style[source-path*="css.css"]').remove();
    });

    it("returns a disposable allowing styles applied by the given path to be removed", () => {
      const cssPath = require.resolve("./fixtures/css.css");

      expect(getComputedStyle(document.body).fontWeight).not.toBe("700");
      const disposable = lumine.themes.requireStylesheet(cssPath);
      expect(getComputedStyle(document.body).fontWeight).toBe("700");

      let styleElementRemovedHandler;
      lumine.styles.onDidRemoveStyleElement(
        (styleElementRemovedHandler = jasmine.createSpy("styleElementRemovedHandler")),
      );

      disposable.dispose();

      expect(getComputedStyle(document.body).fontWeight).not.toBe("bold");

      expect(styleElementRemovedHandler).toHaveBeenCalled();
    });
  });

  describe("base style sheet loading", () => {
    beforeEach(async () => {
      jasmine.useRealClock();
      const workspaceElement = lumine.workspace.getElement();
      jasmine.attachToDOM(lumine.workspace.getElement());
      workspaceElement.appendChild(document.createElement("lumine-text-editor"));
      await lumine.themes.activateThemes();
    });

    it("loads the correct values from the theme's variables file", async () => {
      let didChangeActiveThemesHandler = jasmine.createSpy();
      lumine.themes.onDidChangeActiveThemes(didChangeActiveThemesHandler);
      setActiveThemes(["theme-with-ui-variables", "theme-with-syntax-variables"]);

      await waitForCondition(() => {
        return didChangeActiveThemesHandler.calls.count() > 0;
      });

      // an override loaded in the base css
      expect(getComputedStyle(lumine.workspace.getElement())["background-color"]).toBe(
        "rgb(0, 0, 255)",
      );

      // from within the theme itself
      expect(getComputedStyle(document.querySelector("lumine-text-editor")).paddingTop).toBe(
        "10px",
      );
      expect(getComputedStyle(document.querySelector("lumine-text-editor")).color).toBe(
        "rgb(255, 0, 0)",
      );
    });

    let userStylesheetPath;
    beforeEach(async () => {
      userStylesheetPath = path.join(temp.mkdirSync("lumine"), "styles.css");
      fs.writeFileSync(userStylesheetPath, "body {border-style: dotted !important;}");
      spyOn(lumine.styles, "getUserStyleSheetPath").and.returnValue(userStylesheetPath);
    });

    describe("when the user stylesheet changes", () => {
      beforeEach(() => jasmine.snapshotDeprecations());

      afterEach(() => jasmine.restoreDeprecationsSnapshot());

      it("reloads it", async () => {
        jasmine.useRealClock();

        await lumine.themes.activateThemes();
        let styleElementRemovedHandler = jasmine.createSpy("styleElementRemovedHandler");
        let styleElementUpdatedHandler = jasmine.createSpy("styleElementUpdatedHandler");
        lumine.styles.onDidRemoveStyleElement(styleElementRemovedHandler);
        lumine.styles.onDidUpdateStyleElement(styleElementUpdatedHandler);

        spyOn(lumine.themes, "loadUserStylesheet").and.callThrough();

        expect(getComputedStyle(document.body).borderStyle).toBe("dotted");

        fs.writeFileSync(userStylesheetPath, "body {border-style: dashed}");

        await waitForCondition(() => {
          return getComputedStyle(document.body).borderStyle === "dashed";
        });

        // The style element is updated in place rather than removed and
        // re-added, so the user styles never leave the DOM.
        expect(styleElementRemovedHandler).not.toHaveBeenCalled();
        expect(styleElementUpdatedHandler).toHaveBeenCalled();
        expect(styleElementUpdatedHandler.calls.argsFor(0)[0].textContent).toContain("dashed");

        fs.removeSync(userStylesheetPath);

        await waitForCondition(() => {
          return getComputedStyle(document.body).borderStyle === "none";
        });

        expect(styleElementRemovedHandler).toHaveBeenCalled();
      });
    });

    describe("when there is an error reading the stylesheet", () => {
      let addErrorHandler = null;
      beforeEach(async () => {
        addErrorHandler = jasmine.createSpy();
        await lumine.themes.loadUserStylesheet();
        spyOn(lumine.themes, "loadStylesheet").and.callFake(() => {
          throw new Error('EACCES permission denied "styles.css"');
        });
        lumine.notifications.onDidAddNotification(addErrorHandler);
      });

      it("creates an error notification and keeps the previous stylesheet", async () => {
        await lumine.themes.loadUserStylesheet();
        expect(addErrorHandler).toHaveBeenCalled();
        const note = addErrorHandler.calls.mostRecent().args[0];
        expect(note.getType()).toBe("error");
        expect(note.getMessage()).toContain("Error loading");
        const styleElement =
          lumine.styles.styleElementsBySourcePath[lumine.styles.getUserStyleSheetPath()];
        expect(styleElement).not.toBeUndefined();
        expect(styleElement.textContent).toContain("dotted");
      });
    });

    describe("when there is an error watching the user stylesheet", () => {
      let addErrorHandler = null;

      beforeEach(() => {
        addErrorHandler = jasmine.createSpy();
        const watcher = require("../src/path-watcher");
        spyOn(watcher, "watchPath").and.callFake(() => {
          throw new Error("Unable to watch path");
        });
        spyOn(lumine.themes, "loadStylesheet").and.returnValue("");
        lumine.notifications.onDidAddNotification(addErrorHandler);
      });

      it("creates an error notification", async () => {
        await lumine.themes.loadUserStylesheet();
        expect(addErrorHandler).toHaveBeenCalled();
        const note = addErrorHandler.calls.mostRecent()?.args[0];
        expect(note?.getType()).toBe("error");
        expect(note?.getMessage()).toContain("Unable to watch path");
      });
    });

    it("adds a notification when a theme's stylesheet cannot be read", () => {
      const addErrorHandler = jasmine.createSpy();
      lumine.notifications.onDidAddNotification(addErrorHandler);
      expect(() =>
        lumine.packages.activatePackage("theme-with-invalid-styles").then(
          () => {},
          () => {},
        ),
      ).not.toThrow();
      expect(addErrorHandler.calls.count()).toBe(1);
      expect(addErrorHandler.calls.argsFor(0)[0].message).toContain(
        "Failed to activate the theme-with-invalid-styles theme",
      );
    });
  });

  describe("when a non-existent theme is present in the config", () => {
    beforeEach(async () => {
      console.warn.calls.reset();
      lumine.packages.loadPackage("one-theme");
      lumine.themes.systemThemeQuery = { matches: true, addEventListener() {} };
      setActiveThemes(["non-existent-dark-ui", "non-existent-dark-syntax"]);

      await lumine.themes.activateThemes();
    });

    it("uses the bundled night UI and syntax themes and logs a warning", () => {
      const activeThemeNames = lumine.themes.getActiveThemeNames();
      expect(console.warn.calls.count()).toBe(2);
      expect(activeThemeNames.length).toBe(2);
      expect(activeThemeNames).toContain("one-night-ui");
      expect(activeThemeNames).toContain("one-night-syntax");
    });
  });

  describe("when in safe mode", () => {
    beforeEach(() => {
      lumine.packages.loadPackage("one-theme");
      lumine.themes.systemThemeQuery = { matches: true, addEventListener() {} };
    });

    describe("when the enabled UI and syntax themes are installed", () => {
      beforeEach(async () => {
        setActiveThemes(["one-day-ui", "one-night-syntax"]);

        await lumine.themes.activateThemes();
      });

      it("uses the enabled themes", () => {
        const activeThemeNames = lumine.themes.getActiveThemeNames();
        expect(activeThemeNames.length).toBe(2);
        expect(activeThemeNames).toContain("one-day-ui");
        expect(activeThemeNames).toContain("one-night-syntax");
      });
    });

    describe("when neither enabled theme is installed", () => {
      beforeEach(async () => {
        setActiveThemes(["installed-dark-ui", "installed-dark-syntax"]);

        await lumine.themes.activateThemes();
      });

      it("falls back to the bundled pair for the current mode", () => {
        const activeThemeNames = lumine.themes.getActiveThemeNames();
        expect(activeThemeNames.length).toBe(2);
        expect(activeThemeNames).toContain("one-night-ui");
        expect(activeThemeNames).toContain("one-night-syntax");
      });
    });

    describe("when only the enabled syntax theme is installed", () => {
      beforeEach(async () => {
        setActiveThemes(["installed-dark-ui", "one-day-syntax"]);

        await lumine.themes.activateThemes();
      });

      it("runs the syntax theme alone without auto-completing the pair", () => {
        const activeThemeNames = lumine.themes.getActiveThemeNames();
        expect(activeThemeNames).toEqual(["one-day-syntax"]);
      });
    });

    describe("when only the enabled UI theme is installed", () => {
      beforeEach(async () => {
        setActiveThemes(["one-day-ui", "installed-dark-syntax"]);

        await lumine.themes.activateThemes();
      });

      it("runs the UI theme alone without auto-completing the pair", () => {
        const activeThemeNames = lumine.themes.getActiveThemeNames();
        expect(activeThemeNames).toEqual(["one-day-ui"]);
      });
    });
  });

  describe("multi-theme packages", () => {
    it("registers theme packs declared in package.json for the container lifecycle", async () => {
      lumine.packages.loadPackage("multi-theme-package");

      let themePack = lumine.themes.getThemePacks().find(({ name }) => name === "Multi Alpha");
      expect(themePack.light).toEqual(["multi-alpha-ui", "multi-alpha-syntax"]);
      expect(themePack.dark).toEqual(["multi-alpha-ui", "multi-alpha-syntax"]);
      expect(
        lumine.packages.getLoadedPackage("multi-alpha-ui").metadata.themePacks,
      ).toBeUndefined();

      await lumine.packages.deactivatePackage("multi-theme-package");
      expect(
        lumine.themes.getThemePacks().find(({ name }) => name === "Multi Alpha"),
      ).toBeUndefined();

      await lumine.packages.activatePackage("multi-theme-package");
      themePack = lumine.themes.getThemePacks().find(({ name }) => name === "Multi Alpha");
      expect(themePack).toBeDefined();
    });

    it("registers each entry of the themes array as a loaded theme package", () => {
      lumine.packages.loadPackage("multi-theme-package");

      // The containing package loads as a normal package (so its main and
      // configSchema apply); the entries load as virtual theme packages.
      const container = lumine.packages.getLoadedPackage("multi-theme-package");
      expect(container).toBeDefined();
      expect(container.isTheme()).toBeFalsy();

      const uiTheme = lumine.packages.getLoadedPackage("multi-alpha-ui");
      const syntaxTheme = lumine.packages.getLoadedPackage("multi-alpha-syntax");
      expect(uiTheme).toBeDefined();
      expect(syntaxTheme).toBeDefined();
      expect(uiTheme.isTheme()).toBeTruthy();
      expect(syntaxTheme.isTheme()).toBeTruthy();
      expect(uiTheme.getType()).toBe("theme");
      expect(syntaxTheme.getType()).toBe("theme");
      expect(uiTheme.metadata.theme).toBe("ui");
      expect(syntaxTheme.metadata.theme).toBe("syntax");
    });

    it("loads extended styles before the theme's own override styles", () => {
      lumine.packages.loadPackage("multi-theme-package");

      const uiTheme = lumine.packages.getLoadedPackage("multi-alpha-ui");
      const stylesheetPaths = uiTheme.getStylesheetPaths();

      expect(stylesheetPaths.map((stylesheetPath) => path.basename(stylesheetPath))).toEqual([
        "base.css",
        "inherited.css",
        "variables.css",
        "base.css",
        "variables.css",
      ]);
      expect(stylesheetPaths[0]).toContain("multi-theme-base-package");
      expect(stylesheetPaths[3]).toContain("multi-theme-package");

      const variablesPaths = lumine.themes.getThemeVariablesPaths("multi-alpha-ui");
      expect(variablesPaths).toHaveLength(2);
      expect(variablesPaths[0]).toContain("multi-theme-base-package");
      expect(variablesPaths[1]).toContain("multi-theme-package");

      const syntaxTheme = lumine.packages.getLoadedPackage("multi-alpha-syntax");
      expect(
        syntaxTheme.getStylesheetPaths().map((stylesheetPath) => path.basename(stylesheetPath)),
      ).toEqual(["inherited.css", "index.css"]);
    });

    it("activates the provided themes like any other theme", async () => {
      lumine.packages.loadPackage("multi-theme-package");
      setActiveThemes(["multi-alpha-ui", "multi-alpha-syntax"]);

      await lumine.themes.activateThemes();

      const activeThemeNames = lumine.themes.getActiveThemeNames();
      expect(activeThemeNames).toContain("multi-alpha-ui");
      expect(activeThemeNames).toContain("multi-alpha-syntax");

      const workspaceElement = lumine.workspace.getElement();
      expect(workspaceElement).toHaveClass("theme-multi-alpha-ui");
      expect(workspaceElement).toHaveClass("theme-multi-alpha-syntax");
    });
  });

  describe("themes without a palette", () => {
    // The warning is said once per theme for the life of the window, and the
    // whole editor suite shares one, so an earlier spec activating this theme
    // would otherwise have spent it.
    beforeEach(() => {
      lumine.themes.themesWarnedForMissingVariables = null;
    });

    it("warns once that the theme defines none of the color custom properties", async () => {
      setActiveThemes(["theme-with-package-file", "theme-modern-syntax"]);
      await lumine.themes.activateThemes();

      const warnings = console.warn.calls
        .allArgs()
        .map(([message]) => String(message))
        .filter((message) => message.includes("theme-with-package-file"));
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("variables.css");
    });

    it("says nothing about a theme that ships one", async () => {
      setActiveThemes(["theme-modern-ui", "theme-modern-syntax"]);
      await lumine.themes.activateThemes();

      const warnings = console.warn.calls
        .allArgs()
        .map(([message]) => String(message))
        .filter((message) => message.includes("variables.css"));
      expect(warnings).toEqual([]);
    });
  });
});

function getAbsolutePath(directory, relativePath) {
  if (directory) {
    return directory.resolve(relativePath);
  }
}
