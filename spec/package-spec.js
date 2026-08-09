const path = require("path");
const Package = require("../src/package");
const ThemePackage = require("../src/theme-package");
const { mockLocalStorage } = require("./helpers/mock-local-storage");

describe("Package", function () {
  const build = (constructor, packagePath) =>
    new constructor({
      path: packagePath,
      packageManager: lumine.packages,
      config: lumine.config,
      styleManager: lumine.styles,
      notificationManager: lumine.notifications,
      keymapManager: lumine.keymaps,
      commandRegistry: lumine.command,
      grammarRegistry: lumine.grammars,
      themeManager: lumine.themes,
      menuManager: lumine.menu,
      contextMenuManager: lumine.contextMenu,
      deserializerManager: lumine.deserializers,
      viewRegistry: lumine.views,
    });

  const buildPackage = (packagePath) => build(Package, packagePath);

  const buildThemePackage = (themePath) => build(ThemePackage, themePath);

  describe("::getCachedResourcePaths()", function () {
    it("resolves baked resource paths for bundled packages", function () {
      const packagePath = lumine.project.getDirectories()[0].resolve("packages/package-with-index");
      const pack = buildPackage(packagePath);
      pack.bundledPackage = true;
      lumine.packages.packagesCache[pack.name] = {
        grammarPaths: [path.join("grammars", "language.json")],
        settingsPaths: [],
      };

      expect(pack.getCachedResourcePaths("grammarPaths")).toEqual([
        path.join(packagePath, "grammars", "language.json"),
      ]);
      expect(pack.getCachedResourcePaths("settingsPaths")).toEqual([]);

      delete lumine.packages.packagesCache[pack.name];
    });

    it("returns null when no baked metadata exists", function () {
      const packagePath = lumine.project.getDirectories()[0].resolve("packages/package-with-index");
      const pack = buildPackage(packagePath);

      expect(pack.getCachedResourcePaths("grammarPaths")).toBeNull();
      expect(pack.getCachedResourcePaths("settingsPaths")).toBeNull();
    });
  });

  describe("when the package contains incompatible native modules", function () {
    beforeEach(function () {
      lumine.packages.devMode = false;
      mockLocalStorage();
    });

    afterEach(() => (lumine.packages.devMode = true));

    it("does not activate it", function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-incompatible-native-module");
      const pack = buildPackage(packagePath);
      expect(pack.isCompatible()).toBe(false);
      expect(pack.incompatibleModules[0].name).toBe("native-module");
      expect(pack.incompatibleModules[0].path).toBe(
        path.join(packagePath, "node_modules", "native-module"),
      );
    });

    it("detects the package as incompatible even if .node file is loaded conditionally", function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-incompatible-native-module-loaded-conditionally");
      const pack = buildPackage(packagePath);
      expect(pack.isCompatible()).toBe(false);
      expect(pack.incompatibleModules[0].name).toBe("native-module");
      expect(pack.incompatibleModules[0].path).toBe(
        path.join(packagePath, "node_modules", "native-module"),
      );
    });

    it("utilizes _lumineModuleCache if present to determine the package's native dependencies", function () {
      let packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-ignored-incompatible-native-module");
      let pack = buildPackage(packagePath);
      expect(pack.getNativeModuleDependencyPaths().length).toBe(1); // doesn't see the incompatible module
      expect(pack.isCompatible()).toBe(true);

      packagePath = lumine.project
        .getDirectories()?.[0]
        ?.resolve("packages/package-with-cached-incompatible-native-module");

      pack = buildPackage(packagePath);
      expect(pack.isCompatible()).toBe(false);
    });

    it("logs an error to the console describing the problem", function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-incompatible-native-module");

      spyOn(console, "warn");
      spyOn(lumine.notifications, "addFatalError");

      buildPackage(packagePath).activateNow();

      expect(lumine.notifications.addFatalError).not.toHaveBeenCalled();
      expect(console.warn.calls.count()).toBe(1);
      expect(console.warn.calls.mostRecent().args[0]).toContain(
        "it requires one or more incompatible native modules (native-module)",
      );
    });
  });

  describe("::activateNow()", function () {
    // A deserializer may need its own package active before initial package
    // activation has run, so it forces the issue by calling `activateNow()`
    // without `activate()` ever having prepared the package's resources.
    it("activates the package's resources when ::activate() has not run", function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-provided-services");
      const pack = buildPackage(packagePath);
      pack.load();

      expect(pack.activationDisposables).toBeUndefined();

      pack.activateNow();

      expect(pack.mainActivated).toBe(true);
      expect(pack.activationDisposables).not.toBeUndefined();

      let service;
      lumine.packages.serviceHub.consume("service-2", "^0.2.0", (value) => (service = value));
      expect(service).toBe("second-service");

      pack.deactivate();
    });
  });

  describe("::rebuild()", function () {
    beforeEach(function () {
      lumine.packages.devMode = false;
      mockLocalStorage();
    });

    afterEach(() => (lumine.packages.devMode = true));

    it("returns a promise resolving to the results of `apm rebuild`", async () => {
      const packagePath = lumine.project
        .getDirectories()?.[0]
        ?.resolve("packages/package-with-index");

      const pack = buildPackage(packagePath);
      const rebuildCallbacks = [];
      spyOn(pack, "runRebuildProcess").and.callFake((callback) => rebuildCallbacks.push(callback));

      const promise = pack.rebuild();
      rebuildCallbacks[0]({
        code: 0,
        stdout: "stdout output",
        stderr: "stderr output",
      });

      expect(await promise).toEqual({
        code: 0,
        stdout: "stdout output",
        stderr: "stderr output",
      });
    });

    it("persists build failures in local storage", function () {
      const packagePath = lumine.project
        .getDirectories()?.[0]
        ?.resolve("packages/package-with-index");
      const pack = buildPackage(packagePath);

      expect(pack.isCompatible()).toBe(true);
      expect(pack.getBuildFailureOutput()).toBeNull();

      const rebuildCallbacks = [];
      spyOn(pack, "runRebuildProcess").and.callFake((callback) => rebuildCallbacks.push(callback));

      pack.rebuild();
      rebuildCallbacks[0]({ code: 13, stderr: "It is broken" });

      expect(pack.getBuildFailureOutput()).toBe("It is broken");
      expect(pack.getIncompatibleNativeModules()).toEqual([]);
      expect(pack.isCompatible()).toBe(false);

      // A different package instance has the same failure output (simulates reload)
      const pack2 = buildPackage(packagePath);
      expect(pack2.getBuildFailureOutput()).toBe("It is broken");

      // Clears the build failure after a successful build
      pack.rebuild();
      rebuildCallbacks[1]({ code: 0, stdout: "It worked" });

      expect(pack.getBuildFailureOutput()).toBeNull();
      expect(pack2.getBuildFailureOutput()).toBeNull();
    });
  });

  describe("::getNativeModuleDependencyPaths()", function () {
    const resolveFixture = () =>
      lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-native-and-plain-dependencies");

    beforeEach(function () {
      lumine.packages.devMode = false;
      mockLocalStorage();
    });

    afterEach(() => (lumine.packages.devMode = true));

    it("reports only the dependencies that actually ship native code", function () {
      const packagePath = resolveFixture();
      const paths = buildPackage(packagePath).getNativeModuleDependencyPaths();

      expect(paths).toContain(path.join(packagePath, "node_modules", "native-module"));
      expect(paths).not.toContain(path.join(packagePath, "node_modules", "plain-module"));
    });

    it("finds native code inside a scoped dependency", function () {
      const packagePath = resolveFixture();
      const paths = buildPackage(packagePath).getNativeModuleDependencyPaths();

      expect(paths).toContain(
        path.join(packagePath, "node_modules", "@scope", "scoped-native-module"),
      );
    });

    it("reports every incompatible native module it finds, scoped or not", function () {
      const pack = buildPackage(resolveFixture());

      expect(pack.isCompatible()).toBe(false);
      expect(pack.incompatibleModules.map((module) => module.name).sort()).toEqual([
        "native-module",
        "scoped-native-module",
      ]);
    });
  });

  describe("::getIncompatibleNativeModules()", function () {
    const resolveFixture = () =>
      lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-native-and-plain-dependencies");

    beforeEach(function () {
      lumine.packages.devMode = false;
      mockLocalStorage();
    });

    afterEach(() => (lumine.packages.devMode = true));

    it("does not walk the dependency tree again for a later package instance", function () {
      const packagePath = resolveFixture();
      const first = buildPackage(packagePath);
      const expected = first.getIncompatibleNativeModules();
      expect(expected.length).toBe(2);

      // A fresh instance stands in for the next window opening the same package.
      const second = buildPackage(packagePath);
      spyOn(second, "getNativeModuleDependencyPathsMap").and.callThrough();

      expect(
        second
          .getIncompatibleNativeModules()
          .map((module) => module.name)
          .sort(),
      ).toEqual(["native-module", "scoped-native-module"]);
      expect(second.getNativeModuleDependencyPathsMap).not.toHaveBeenCalled();
    });

    it("walks the tree again when the memo was written for a different tree", function () {
      const packagePath = resolveFixture();
      const pack = buildPackage(packagePath);
      pack.getIncompatibleNativeModules();

      global.localStorage.setItem(
        pack.getIncompatibleNativeModulesStorageKey(),
        JSON.stringify({ signature: -1, incompatibleNativeModules: [] }),
      );

      const rescanned = buildPackage(packagePath);
      spyOn(rescanned, "getNativeModuleDependencyPathsMap").and.callThrough();

      expect(rescanned.getIncompatibleNativeModules().length).toBe(2);
      expect(rescanned.getNativeModuleDependencyPathsMap).toHaveBeenCalled();
    });

    it("walks the tree again when the memo is unreadable", function () {
      const packagePath = resolveFixture();
      const pack = buildPackage(packagePath);
      global.localStorage.setItem(pack.getIncompatibleNativeModulesStorageKey(), "not json");

      expect(pack.getIncompatibleNativeModules().length).toBe(2);
    });

    it("keys the memo on the ABI the answer was computed for", function () {
      const pack = buildPackage(resolveFixture());
      expect(pack.getIncompatibleNativeModulesStorageKey()).toContain(process.versions.modules);
    });

    it("discards the memo when the package is rebuilt", function () {
      const pack = buildPackage(resolveFixture());
      pack.getIncompatibleNativeModules();
      expect(
        global.localStorage.getItem(pack.getIncompatibleNativeModulesStorageKey()),
      ).not.toBeNull();

      const rebuildCallbacks = [];
      spyOn(pack, "runRebuildProcess").and.callFake((callback) => rebuildCallbacks.push(callback));
      pack.rebuild();
      rebuildCallbacks[0]({ code: 0, stdout: "It worked" });

      expect(global.localStorage.getItem(pack.getIncompatibleNativeModulesStorageKey())).toBeNull();
    });
  });

  describe("theme", function () {
    let editorElement, theme;

    beforeEach(function () {
      editorElement = document.createElement("lumine-text-editor");
      jasmine.attachToDOM(editorElement);
    });

    afterEach(async () => {
      if (theme != null) {
        await theme.deactivate();
      }
    });

    describe("when the theme contains a single style file", function () {
      it("loads and applies css", function () {
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("1234px");
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-index-css");
        theme = buildThemePackage(themePath);
        theme.activate();
        expect(getComputedStyle(editorElement).paddingTop).toBe("1234px");
      });

      it("loads and applies a stylesheet at the theme root", function () {
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("1234px");
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-index-at-root");
        theme = buildThemePackage(themePath);
        theme.activate();
        expect(getComputedStyle(editorElement).paddingTop).toBe("4321px");
      });
    });

    describe("when the theme contains a package.json file", () =>
      it("loads and applies stylesheets from package.json in the correct order", function () {
        expect(getComputedStyle(editorElement).paddingTop).not.toBe("101px");
        expect(getComputedStyle(editorElement).paddingRight).not.toBe("102px");
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("103px");

        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-package-file");
        theme = buildThemePackage(themePath);
        theme.activate();
        expect(getComputedStyle(editorElement).paddingTop).toBe("101px");
        expect(getComputedStyle(editorElement).paddingRight).toBe("102px");
        expect(getComputedStyle(editorElement).paddingBottom).toBe("103px");
      }));

    describe("when the theme does not contain a package.json file and is a directory", () =>
      it("loads all stylesheet files in the directory", function () {
        expect(getComputedStyle(editorElement).paddingTop).not.toBe("10px");
        expect(getComputedStyle(editorElement).paddingRight).not.toBe("20px");
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("30px");

        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-without-package-file");
        theme = buildThemePackage(themePath);
        theme.activate();
        expect(getComputedStyle(editorElement).paddingTop).toBe("10px");
        expect(getComputedStyle(editorElement).paddingRight).toBe("20px");
        expect(getComputedStyle(editorElement).paddingBottom).toBe("30px");
      }));

    describe("reloading a theme", function () {
      beforeEach(function () {
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-package-file");
        theme = buildThemePackage(themePath);
        theme.activate();
      });

      it("reloads without readding to the stylesheets list", function () {
        expect(theme.getStylesheetPaths().length).toBe(3);
        theme.reloadStylesheets();
        expect(theme.getStylesheetPaths().length).toBe(3);
      });
    });

    describe("events", function () {
      beforeEach(function () {
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-package-file");
        theme = buildThemePackage(themePath);
        theme.activate();
      });

      it("deactivated event fires on .deactivate()", async function () {
        let spy = jasmine.createSpy();
        theme.onDidDeactivate(spy);
        await theme.deactivate();
        expect(spy).toHaveBeenCalled();
      });
    });
  });

  describe(".loadMetadata()", function () {
    let [packagePath, metadata] = [];

    beforeEach(function () {
      packagePath = lumine.project
        .getDirectories()[0]
        ?.resolve("packages/package-with-different-directory-name");
      metadata = lumine.packages.loadPackageMetadata(packagePath, true);
    });

    it("uses the package name defined in package.json", () =>
      expect(metadata.name).toBe("package-with-a-totally-different-name"));
  });

  describe("the initialize() hook", function () {
    it("gets called when the package is activated", function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-deserializers");
      const pack = buildPackage(packagePath);
      pack.requireMainModule();
      const { mainModule } = pack;
      spyOn(mainModule, "initialize");
      expect(mainModule.initialize).not.toHaveBeenCalled();
      pack.activate();
      expect(mainModule.initialize).toHaveBeenCalled();
      expect(mainModule.initialize.calls.count()).toBe(1);
    });

    it("gets called when a deserializer is used", function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-deserializers");
      const pack = buildPackage(packagePath);
      pack.requireMainModule();
      const { mainModule } = pack;
      spyOn(mainModule, "initialize");
      pack.load();
      expect(mainModule.initialize).not.toHaveBeenCalled();
      lumine.deserializers.deserialize({ deserializer: "Deserializer1", a: "b" });
      expect(mainModule.initialize).toHaveBeenCalled();
    });
  });
});
