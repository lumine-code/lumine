const path = require("path");
const fs = require("@lumine-code/fs-plus");
const { Disposable } = require("@lumine-code/event-kit");
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

  const activatePackageObject = async (pack) => {
    // PackageManager loads resource metadata before invoking the direct
    // activation path. Keep this helper aligned with that lifecycle rather
    // than reaching into the removed intermediate activation phase.
    pack.load();
    if (pack instanceof ThemePackage) pack.loadStylesheets();
    await pack.activateMain({ signal: new AbortController().signal });
    return pack;
  };

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

  describe("a package root index", function () {
    it("skips asynchronous probes for resource directories known to be absent", async function () {
      const packagePath = lumine.project.getDirectories()[0].resolve("packages/package-with-index");
      const pack = buildPackage(packagePath);
      pack.packageRootEntries = new Set();
      spyOn(fs, "exists");

      await Promise.all([pack.loadGrammars(), pack.loadSettings()]);

      expect(fs.exists).not.toHaveBeenCalled();
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

    it("logs an error to the console describing the problem", async function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-incompatible-native-module");

      spyOn(console, "warn");
      spyOn(lumine.notifications, "addFatalError");

      await activatePackageObject(buildPackage(packagePath));

      expect(lumine.notifications.addFatalError).not.toHaveBeenCalled();
      expect(console.warn.calls.count()).toBe(1);
      expect(console.warn.calls.mostRecent().args[0]).toContain(
        "it requires one or more incompatible native modules (native-module)",
      );
    });
  });

  describe("::activateMain()", function () {
    it("does not count asynchronous resource loading as activation time", async function () {
      const packagePath = lumine.project.getDirectories()[0].resolve("packages/package-with-main");
      const pack = buildPackage(packagePath);
      pack.load();

      let resolveGrammar;
      spyOn(pack, "loadGrammars").and.returnValue(
        new Promise((resolve) => (resolveGrammar = resolve)),
      );

      const activation = pack.activateMain({
        generation: 1,
        signal: new AbortController().signal,
      });

      // A synchronous main module must finish its own timing before another
      // package gets a chance to run in the same initial activation batch.
      expect(Number.isFinite(pack.activateTime)).toBe(true);

      await Promise.resolve();
      await Promise.resolve();

      // The package activation prologue has completed while grammar discovery
      // is still pending, so its timing must already be available.
      expect(Number.isFinite(pack.activateTime)).toBe(true);

      resolveGrammar();
      await activation;
      await pack.deactivate();
    });

    it("activates the package's resources through the direct lifecycle", async function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-provided-services");
      const pack = buildPackage(packagePath);
      pack.load();

      expect(pack.activationDisposables).toBeUndefined();

      await activatePackageObject(pack);

      expect(pack.mainActivated).toBe(true);
      expect(pack.activationDisposables).not.toBeUndefined();

      let service;
      lumine.packages.serviceHub.consume("service-2", "^0.2.0", (value) => (service = value));
      expect(service).toBe("second-service");

      await pack.deactivate();
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
      it("loads and applies css", async function () {
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("1234px");
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-index-css");
        theme = buildThemePackage(themePath);
        await activatePackageObject(theme);
        expect(getComputedStyle(editorElement).paddingTop).toBe("1234px");
      });

      it("loads and applies a stylesheet at the theme root", async function () {
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("1234px");
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-index-at-root");
        theme = buildThemePackage(themePath);
        await activatePackageObject(theme);
        expect(getComputedStyle(editorElement).paddingTop).toBe("4321px");
      });
    });

    describe("when the theme contains a package.json file", () =>
      it("loads and applies stylesheets from package.json in the correct order", async function () {
        expect(getComputedStyle(editorElement).paddingTop).not.toBe("101px");
        expect(getComputedStyle(editorElement).paddingRight).not.toBe("102px");
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("103px");

        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-package-file");
        theme = buildThemePackage(themePath);
        await activatePackageObject(theme);
        expect(getComputedStyle(editorElement).paddingTop).toBe("101px");
        expect(getComputedStyle(editorElement).paddingRight).toBe("102px");
        expect(getComputedStyle(editorElement).paddingBottom).toBe("103px");
      }));

    describe("when the theme does not contain a package.json file and is a directory", () =>
      it("loads all stylesheet files in the directory", async function () {
        expect(getComputedStyle(editorElement).paddingTop).not.toBe("10px");
        expect(getComputedStyle(editorElement).paddingRight).not.toBe("20px");
        expect(getComputedStyle(editorElement).paddingBottom).not.toBe("30px");

        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-without-package-file");
        theme = buildThemePackage(themePath);
        await activatePackageObject(theme);
        expect(getComputedStyle(editorElement).paddingTop).toBe("10px");
        expect(getComputedStyle(editorElement).paddingRight).toBe("20px");
        expect(getComputedStyle(editorElement).paddingBottom).toBe("30px");
      }));

    describe("reloading a theme", function () {
      beforeEach(async function () {
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-package-file");
        theme = buildThemePackage(themePath);
        await activatePackageObject(theme);
      });

      it("reloads without readding to the stylesheets list", function () {
        expect(theme.getStylesheetPaths().length).toBe(3);
        theme.reloadStylesheets();
        expect(theme.getStylesheetPaths().length).toBe(3);
      });
    });

    describe("events", function () {
      beforeEach(async function () {
        const themePath = lumine.project
          .getDirectories()[0]
          ?.resolve("packages/theme-with-package-file");
        theme = buildThemePackage(themePath);
        await activatePackageObject(theme);
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

  describe("teardown failures", function () {
    it("attempts main, config, initialization and event cleanup after resource cleanup fails", async function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-view-providers");
      const pack = buildPackage(packagePath);
      pack.load();
      pack.requireMainModule();
      const resourceError = new Error("Resource cleanup failed");
      const keymapError = new Error("Keymap cleanup failed");
      const mainError = new Error("Main cleanup failed");
      const configError = new Error("Config cleanup failed");
      const initializationError = new Error("Initialization cleanup failed");
      const laterCleanup = jasmine.createSpy("laterCleanup");
      const deactivated = jasmine.createSpy("deactivated");
      spyOn(pack.mainModule, "initialize").and.callFake((_state, context) => {
        context.subscriptions.add(
          new Disposable(() => {
            throw initializationError;
          }),
          new Disposable(laterCleanup),
        );
      });
      spyOn(pack.mainModule, "deactivate").and.callFake(() => {
        expect(pack.activationDisposables).toBeNull();
        expect(pack.keymapDisposables).toBeNull();
        throw mainError;
      });
      pack.mainModule.deactivateConfig = jasmine
        .createSpy("deactivateConfig")
        .and.callFake(() => Promise.reject(configError));
      pack.activateMain({ signal: new AbortController().signal });
      await pack.resourceLoadPromise;
      pack.activationDisposables.add(
        new Disposable(() => {
          throw resourceError;
        }),
      );
      pack.keymapDisposables.add(
        new Disposable(() => {
          throw keymapError;
        }),
      );
      pack.onDidDeactivate(deactivated);

      let failure;
      try {
        await pack.deactivate();
      } catch (error) {
        failure = error;
      }

      expect(failure.errors).toEqual([
        resourceError,
        keymapError,
        mainError,
        configError,
        initializationError,
      ]);
      expect(failure.cause).toBe(resourceError);
      expect(pack.mainModule.deactivate).toHaveBeenCalledTimes(1);
      expect(pack.mainModule.deactivateConfig).toHaveBeenCalledTimes(1);
      expect(laterCleanup).toHaveBeenCalledTimes(1);
      expect(deactivated).toHaveBeenCalledTimes(1);
      expect(pack.mainInitialized).toBe(false);
      expect(pack.mainActivated).toBe(false);
      expect(pack.initializationDisposables).toBeNull();
      pack.unload();
    });

    it("removes view proxies, schema and module cache after a deserializer disposer fails", async function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-view-providers");
      const pack = buildPackage(packagePath);
      pack.load();
      pack.requireMainModule();
      pack.mainModule.config = { cleanupFlag: { type: "boolean", default: true } };
      pack.initializeIfNeeded();
      await pack.settingsPromise;
      const modulePath = require.resolve("./fixtures/packages/package-with-view-providers");
      const primary = new Error("Deserializer cleanup failed");
      const viewCleanup = jasmine.createSpy("viewCleanup");
      pack.deserializerDisposables.add(
        new Disposable(() => {
          expect(pack.deserializerDisposables).toBeNull();
          expect(pack.viewProviderDisposables).toBeNull();
          throw primary;
        }),
      );
      pack.viewProviderDisposables.add(new Disposable(viewCleanup));
      let failure;
      try {
        pack.unload();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBe(primary);
      expect(viewCleanup).toHaveBeenCalledTimes(1);
      expect(
        lumine.deserializers.deserialize({
          deserializer: "DeserializerFromPackageWithViewProviders",
        }),
      ).toBeUndefined();
      expect(() => lumine.views.getView({ worksWithViewProvider1: true })).toThrow();
      expect(Object.hasOwn(lumine.config.schema.properties, pack.name)).toBe(false);
      expect(require.cache[modulePath]).toBeUndefined();
      expect(pack.moduleCacheRegistered).toBe(false);
      expect(() => pack.unload()).not.toThrow();
    });
  });

  describe("the initialize() hook", function () {
    it("preserves the initialize failure while finishing every subscription cleanup", async function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-view-providers");
      const pack = buildPackage(packagePath);
      pack.load();
      pack.requireMainModule();
      const primary = Object.freeze(new Error("Initialization failed"));
      const cleanup = new Error("Initialization subscription failed");
      const lateHook = jasmine.createSpy("lateHook");
      const laterCleanup = jasmine.createSpy("laterCleanup");
      spyOn(pack.mainModule, "initialize").and.callFake((_state, context) => {
        context.subscriptions.add(
          new Disposable(() => {
            expect(pack.initializationDisposables).toBeNull();
            expect(pack.hooks).toBeNull();
            context.hooks.on("spec:after-failed-initialize", lateHook);
            throw cleanup;
          }),
          new Disposable(laterCleanup),
        );
        throw primary;
      });
      let failure;
      try {
        pack.initializeIfNeeded();
      } catch (error) {
        failure = error;
      }

      expect(failure.errors).toEqual([primary, cleanup]);
      expect(failure.cause).toBe(primary);
      expect(laterCleanup).toHaveBeenCalledTimes(1);
      expect(pack.mainInitialized).toBe(false);
      await lumine.packages.hooks.trigger("spec:after-failed-initialize");
      expect(lateHook).not.toHaveBeenCalled();
      pack.unload();
    });

    it("preserves an initialize failure if the error reporter also fails", function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-view-providers");
      const pack = buildPackage(packagePath);
      pack.load();
      pack.requireMainModule();
      const primary = Object.freeze(new Error("Initialization failed"));
      const reporting = new Error("Notification failed");
      spyOn(pack.mainModule, "initialize").and.callFake(() => {
        throw primary;
      });
      spyOn(pack, "handleError").and.callFake(() => {
        throw reporting;
      });
      let failure;
      try {
        pack.initializeForExternalUse("spec");
      } catch (error) {
        failure = error;
      }
      expect(failure.errors).toEqual([primary, reporting]);
      expect(failure.cause).toBe(primary);
      pack.unload();
    });

    it("gets called when the package is activated", async function () {
      const packagePath = lumine.project
        .getDirectories()[0]
        .resolve("packages/package-with-deserializers");
      const pack = buildPackage(packagePath);
      pack.requireMainModule();
      const { mainModule } = pack;
      spyOn(mainModule, "initialize");
      expect(mainModule.initialize).not.toHaveBeenCalled();
      await activatePackageObject(pack);
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
      mainModule.config = {
        restoredFlag: { type: "boolean", default: true },
      };
      pack.load();
      expect(mainModule.initialize).not.toHaveBeenCalled();
      lumine.deserializers.deserialize({ deserializer: "Deserializer1", a: "b" });
      expect(mainModule.initialize).toHaveBeenCalled();
      expect(lumine.config.get("package-with-deserializers.restoredFlag")).toBe(true);
      delete mainModule.config;
    });
  });
});
