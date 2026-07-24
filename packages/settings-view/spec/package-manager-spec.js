const fs = require("@lumine-code/fs-plus");
const os = require("os");
const path = require("path");
const PackageManager = require("../lib/package-manager");

describe("PackageManager", function () {
  let [packageManager] = [];

  beforeEach(function () {
    packageManager = new PackageManager();
  });

  describe("::isPackageInstalled()", function () {
    it("returns false when a package is not installed", () =>
      expect(packageManager.isPackageInstalled("some-package")).toBe(false));

    it("returns true when a package is loaded", function () {
      spyOn(atom.packages, "isPackageLoaded").andReturn(true);
      expect(packageManager.isPackageInstalled("some-package")).toBe(true);
    });

    it("returns true when a package is disabled", function () {
      spyOn(atom.packages, "getAvailablePackageNames").andReturn(["some-package"]);
      expect(packageManager.isPackageInstalled("some-package")).toBe(true);
    });
  });

  describe("::getLocalPackages()", function () {
    let [configDirPath, devPackagesPath] = [];

    beforeEach(function () {
      configDirPath = path.join(os.tmpdir(), "settings-view-config");
      devPackagesPath = path.join(configDirPath, "dev", "packages");
      spyOn(atom, "getConfigDirPath").andReturn(configDirPath);
      spyOn(atom.packages, "loadPackageMetadata").andCallFake(
        (pack) => pack.metadata || { name: pack.name },
      );
    });

    function availablePackages(...packs) {
      spyOn(atom.packages, "getAvailablePackages").andReturn(packs);
    }

    it("files a bundled package under core even when its isBundled flag is false (dev mode from source)", function () {
      // Running in dev mode from a source checkout, every packages/ entry
      // reports isBundled: false, but isBundledPackage() still identifies it.
      availablePackages({
        name: "tree-view",
        path: path.join(path.sep, "app", "packages", "tree-view"),
        isBundled: false,
      });
      spyOn(atom.packages, "isBundledPackage").andCallFake((name) => name === "tree-view");

      const packages = packageManager.getLocalPackages();
      expect(packages.core.map((p) => p.name)).toEqual(["tree-view"]);
      expect(packages.user.map((p) => p.name)).toEqual([]);
    });

    it("files a community package under user", function () {
      availablePackages({
        name: "some-community-package",
        path: path.join(configDirPath, "packages", "some-community-package"),
        isBundled: false,
      });
      spyOn(atom.packages, "isBundledPackage").andReturn(false);

      const packages = packageManager.getLocalPackages();
      expect(packages.user.map((p) => p.name)).toEqual(["some-community-package"]);
      expect(packages.core).toEqual([]);
    });

    it("files a dev/packages override of a bundled name under dev, not core", function () {
      availablePackages({
        name: "tree-view",
        path: path.join(devPackagesPath, "tree-view"),
        isBundled: false,
      });
      spyOn(atom.packages, "isBundledPackage").andReturn(true);

      const packages = packageManager.getLocalPackages();
      expect(packages.dev.map((p) => p.name)).toEqual(["tree-view"]);
      expect(packages.core.map((p) => p.name)).toEqual(["tree-view"]);
      expect(packages.core[0].isShadowed).toBe(true);
    });

    it("files a git-sourced package under git", function () {
      availablePackages({
        name: "git-package",
        path: path.join(configDirPath, "packages", "git-package"),
        isBundled: false,
        metadata: { name: "git-package", apmInstallSource: { type: "git" } },
      });
      spyOn(atom.packages, "isBundledPackage").andReturn(false);

      const packages = packageManager.getLocalPackages();
      expect(packages.git.map((p) => p.name)).toEqual(["git-package"]);
    });

    it("keeps a legacy Git install active but warns when its receipt has no origin", function () {
      availablePackages({
        name: "legacy-package",
        path: path.join(configDirPath, "packages", "legacy-package"),
        metadata: {
          name: "legacy-package",
          repository: "owner/legacy-package",
          apmInstallSource: { type: "git", source: "owner/legacy-package", sha: "abc123" },
        },
      });
      spyOn(atom.packages, "isBundledPackage").andReturn(false);

      const packages = packageManager.getLocalPackages();
      expect(packages.git[0].originWarning).toContain("missing or mismatched");
    });

    it("records directoryName for community but not bundled packages", function () {
      availablePackages(
        {
          name: "tree-view",
          path: path.join(path.sep, "app", "packages", "tree-view"),
          isBundled: false,
        },
        {
          name: "some-community-package",
          path: path.join(configDirPath, "packages", "installed-as-other"),
          isBundled: false,
        },
      );
      spyOn(atom.packages, "isBundledPackage").andCallFake((name) => name === "tree-view");

      const packages = packageManager.getLocalPackages();
      expect(packages.core[0].directoryName).toBeUndefined();
      expect(packages.user[0].directoryName).toBe("installed-as-other");
    });

    it("keeps both cards when a community package shadows a virtual built-in theme", function () {
      availablePackages({
        name: "one-day-ui",
        path: path.join(configDirPath, "packages", "one-day-ui"),
        isBundled: false,
        metadata: {
          name: "one-day-ui",
          theme: "ui",
          repository: "owner/one-day-ui",
          apmInstallSource: { type: "git", origin: "github.com/owner/one-day-ui" },
        },
      });
      spyOn(atom.packages, "isBundledPackage").andReturn(false);
      spyOn(atom.packages, "getBundledPackageDescriptors").andReturn([
        {
          name: "one-day-ui",
          path: path.join(path.sep, "app", "packages", "one-theme"),
          metadata: { name: "one-day-ui", theme: "ui" },
          packageKind: "builtin",
          isBuiltinDescriptor: true,
          virtualTheme: true,
        },
      ]);

      const packages = packageManager.getLocalPackages();
      expect(packages.git.map((pack) => pack.name)).toEqual(["one-day-ui"]);
      expect(packages.core.map((pack) => pack.name)).toEqual(["one-day-ui"]);
      expect(packages.core[0].isShadowed).toBe(true);
    });
  });

  describe("::getInstalled()", function () {
    beforeEach(function () {
      jasmine.useRealClock();
      const configDirPath = path.join(os.tmpdir(), "settings-view-config");
      spyOn(atom, "getConfigDirPath").andReturn(configDirPath);
      spyOn(atom.packages, "loadPackageMetadata").andCallFake(
        (pack) => pack.metadata || { name: pack.name },
      );
      spyOn(atom.packages, "isBundledPackage").andReturn(false);
      spyOn(atom.packages, "getBundledPackageDescriptors").andReturn([]);

      // More than one batch (BATCH_SIZE = 20) so the async path exercises its
      // yield-between-chunks loop rather than only the single-batch fast path.
      this.packs = [];
      for (let i = 0; i < 45; i++) {
        this.packs.push({
          name: `community-${i}`,
          path: path.join(configDirPath, "packages", `community-${i}`),
          isBundled: false,
        });
      }
      spyOn(atom.packages, "getAvailablePackages").andReturn(this.packs);
    });

    it("resolves to the same structure the synchronous getLocalPackages() returns", function () {
      const sync = packageManager.getLocalPackages();
      waitsForPromise(() =>
        packageManager.getInstalled().then((installed) => {
          expect(installed).toEqual(sync);
          expect(installed.user.length).toBe(45);
        }),
      );
    });
  });

  describe("::getFeatured()", () =>
    it("does not query a package registry", function () {
      waitsForPromise(() =>
        packageManager.getFeatured().then((packages) => {
          expect(packages).toEqual([]);
        }),
      );
    }));

  describe("::findInstalledPackageByOrigin()", function () {
    it("finds a community install under its previous package name and ignores built-ins", function () {
      spyOn(packageManager, "getLocalPackages").andReturn({
        dev: [],
        user: [
          {
            name: "old-package-name",
            repository: "https://github.com/owner/repo",
          },
        ],
        git: [],
        core: [
          {
            name: "built-in",
            repository: "https://github.com/owner/builtin",
            packageKind: "builtin",
          },
        ],
      });

      expect(packageManager.findInstalledPackageByOrigin("github.com/owner/repo").name).toBe(
        "old-package-name",
      );
      expect(packageManager.findInstalledPackageByOrigin("github.com/owner/builtin")).toBe(null);
    });
  });

  describe("::install()", function () {
    it("fails for invalid repository names", function () {
      const installCallback = jasmine.createSpy("installCallback");
      packageManager.install({ name: "something" }, installCallback);

      waitsFor(() => installCallback.callCount === 1);

      runs(function () {
        const installError = installCallback.argsForCall[0][0];
        expect(installError.packageInstallError).toBe(true);
        expect(installError.message).toContain("owner/repo");
      });
    });

    it("installs GitHub packages with names different from the repo name", function () {
      const installCallback = jasmine.createSpy("installCallback");
      spyOn(packageManager, "emitPackageEvent").andCallThrough();
      // Activation happens once inside installGitHubPackage's afterSwap hook, not
      // in install(); a second activatePackage here would double-activate.
      spyOn(atom.packages, "activatePackage").andReturn(Promise.resolve());
      spyOn(packageManager, "installGitHubPackage").andReturn(
        Promise.resolve({
          name: "real-package-name",
          version: "1.0.0",
          apmInstallSource: { type: "git", source: "user/repo", sha: "abc123" },
        }),
      );

      packageManager.install({ name: "user/repo" }, installCallback);

      waitsFor(() => installCallback.callCount === 1);

      runs(function () {
        expect(installCallback.argsForCall[0].length).toBe(0);
        // install() does not activate (installGitHubPackage is stubbed here, so
        // its afterSwap never runs) — proving activation isn't done twice.
        expect(atom.packages.activatePackage).not.toHaveBeenCalled();
        const installed = packageManager.emitPackageEvent.calls
          .all()
          .find((call) => call.args[0] === "installed");
        expect(installed.args[1].name).toBe("real-package-name");
      });
    });

    it("emits an installed event with a copy of the pack including package metadata", function () {
      const installCallback = jasmine.createSpy("installCallback");
      const originalPackObject = { name: "user/repo", otherData: { will: "beCopied" } };
      spyOn(atom.packages, "activatePackage");
      spyOn(packageManager, "emitPackageEvent");
      spyOn(packageManager, "installGitHubPackage").andReturn(
        Promise.resolve({
          name: "real-package-name",
          moreInfo: "yep",
          apmInstallSource: { type: "git", source: "user/repo", sha: "abc123" },
        }),
      );

      packageManager.install(originalPackObject, installCallback);

      waitsFor(() => installCallback.callCount === 1);

      runs(function () {
        let installEmittedCount = 0;
        for (let call of packageManager.emitPackageEvent.calls.all()) {
          if (call.args[0] === "installed") {
            expect(call.args[1]).not.toEqual(originalPackObject);
            expect(call.args[1].moreInfo).toEqual("yep");
            expect(call.args[1].otherData).toBe(originalPackObject.otherData);
            installEmittedCount++;
          }
        }
        expect(installEmittedCount).toBe(1);
      });
    });
  });

  describe("::update()", function () {
    it("fails for non-GitHub packages", function () {
      const updateCallback = jasmine.createSpy("updateCallback");

      packageManager.update({ name: "foo" }, "1.0.0", updateCallback);

      waitsFor(() => updateCallback.callCount === 1);

      runs(function () {
        const updateError = updateCallback.argsForCall[0][0];
        expect(updateError.packageInstallError).toBe(true);
        expect(updateError.message).toContain("Only Git repository package updates");
      });
    });

    it("updates GitHub packages through the built-in installer", function () {
      const updateCallback = jasmine.createSpy("updateCallback");
      spyOn(packageManager, "installGitHubPackage").andReturn(
        Promise.resolve({
          name: "foo",
          apmInstallSource: { type: "git", source: "user/foo", sha: "def456" },
        }),
      );

      packageManager.update(
        {
          name: "foo",
          latestSha: "d".repeat(40),
          resolvedRef: { type: "branch", value: "main" },
          apmInstallSource: {
            type: "git",
            source: "user/foo#branch:main",
            selector: { type: "branch", value: "main" },
            updatePolicy: "branch",
            sha: "abc123",
          },
        },
        null,
        updateCallback,
      );

      waitsFor(() => updateCallback.callCount === 1);

      runs(function () {
        expect(updateCallback.argsForCall[0].length).toBe(0);
        expect(packageManager.installGitHubPackage).toHaveBeenCalledWith({
          name: "user/foo#branch:main",
          latestSha: "d".repeat(40),
          resolvedSha: "d".repeat(40),
          resolvedRef: { type: "branch", value: "main" },
          selectedRef: { type: "branch", value: "main" },
          updatePolicy: "branch",
          apmInstallSource: {
            type: "git",
            source: "user/foo#branch:main",
            selector: { type: "branch", value: "main" },
            updatePolicy: "branch",
            sha: "abc123",
          },
        });
      });
    });
  });

  describe("::uninstall()", function () {
    it("removes the package from the core.disabledPackages list", function () {
      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      atom.config.set("core.disabledPackages", ["something"]);

      waitsForPromise(() => packageManager.uninstall({ name: "something" }, uninstallCallback));

      runs(() => {
        expect(uninstallCallback).toHaveBeenCalled();
        expect(atom.config.get("core.disabledPackages")).not.toContain("something");
      });
    });

    it("awaits async deactivation before unloading an active package", function () {
      // Reproduces the "Tried to unload active package" error: deactivation is
      // async, so unloading must wait for it to complete.
      let deactivated = false;
      spyOn(atom.packages, "isPackageActive").andCallFake(() => !deactivated);
      spyOn(atom.packages, "deactivatePackage").andCallFake(() =>
        Promise.resolve().then(() => {
          deactivated = true;
        }),
      );
      spyOn(atom.packages, "isPackageLoaded").andReturn(true);
      spyOn(atom.packages, "unloadPackage").andCallFake((name) => {
        if (atom.packages.isPackageActive(name)) {
          throw new Error(`Tried to unload active package '${name}'`);
        }
      });
      spyOn(atom.packages, "resolvePackagePath").andReturn(null);

      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      waitsForPromise(() => packageManager.uninstall({ name: "active-pkg" }, uninstallCallback));

      runs(() => {
        expect(atom.packages.deactivatePackage).toHaveBeenCalledWith("active-pkg");
        expect(atom.packages.unloadPackage).toHaveBeenCalledWith("active-pkg");
        expect(uninstallCallback).toHaveBeenCalled();
        expect(uninstallCallback.mostRecentCall.args[0]).toBeUndefined();
      });
    });

    it("reveals a bundled package and preserves the disabled slot after removing an override", function () {
      const packagesDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lumine-override-uninstall-")),
      );
      fs.makeTreeSync(path.join(packagesDir, "search-panel"));
      atom.config.set("core.disabledPackages", ["search-panel"]);
      spyOn(packageManager, "getAtomPackagesDirectory").andReturn(packagesDir);
      spyOn(atom.packages, "isBundledPackage").andReturn(true);
      spyOn(atom.packages, "isPackageActive").andReturn(false);
      spyOn(atom.packages, "isPackageLoaded").andReturn(false);
      spyOn(atom.packages, "isPackageDisabled").andReturn(true);
      spyOn(atom.packages, "loadPackage");
      spyOn(atom.packages, "activatePackage");

      waitsForPromise(() => packageManager.uninstall({ name: "search-panel" }));
      runs(() => {
        expect(atom.packages.loadPackage).toHaveBeenCalledWith("search-panel");
        expect(atom.packages.activatePackage).not.toHaveBeenCalled();
        expect(atom.config.get("core.disabledPackages")).toContain("search-panel");
        fs.removeSync(packagesDir);
      });
    });

    it("does not wait for the restored bundled package to finish activating", function () {
      // A bundled package that defers activation never resolves activatePackage
      // until its trigger fires; awaiting it would hang the uninstall.
      const packagesDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lumine-override-activate-")),
      );
      fs.makeTreeSync(path.join(packagesDir, "deferred-bundled"));
      spyOn(packageManager, "getAtomPackagesDirectory").andReturn(packagesDir);
      spyOn(atom.packages, "isBundledPackage").andReturn(true);
      spyOn(atom.packages, "isPackageActive").andReturn(false);
      spyOn(atom.packages, "isPackageLoaded").andReturn(false);
      spyOn(atom.packages, "isPackageDisabled").andReturn(false);
      spyOn(atom.packages, "loadPackage");
      // Never resolves — mimics a package that defers activation.
      spyOn(atom.packages, "activatePackage").andReturn(new Promise(() => {}));

      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      waitsForPromise(() =>
        packageManager.uninstall({ name: "deferred-bundled" }, uninstallCallback),
      );

      runs(() => {
        expect(atom.packages.activatePackage).toHaveBeenCalledWith("deferred-bundled");
        // The uninstall completes even though activation never resolves.
        expect(uninstallCallback).toHaveBeenCalled();
        expect(uninstallCallback.mostRecentCall.args[0]).toBeUndefined();
        fs.removeSync(packagesDir);
      });
    });

    it("still completes the uninstall when restoring the bundled package throws", function () {
      const packagesDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lumine-override-throw-")),
      );
      fs.makeTreeSync(path.join(packagesDir, "broken-bundled"));
      spyOn(packageManager, "getAtomPackagesDirectory").andReturn(packagesDir);
      spyOn(atom.packages, "isBundledPackage").andReturn(true);
      spyOn(atom.packages, "isPackageActive").andReturn(false);
      spyOn(atom.packages, "isPackageLoaded").andReturn(false);
      spyOn(atom.packages, "isPackageDisabled").andReturn(false);
      spyOn(atom.packages, "loadPackage").andCallFake(() => {
        throw new Error("cannot load bundled package");
      });
      spyOn(atom.packages, "activatePackage");

      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      waitsForPromise(() =>
        packageManager.uninstall({ name: "broken-bundled" }, uninstallCallback),
      );

      runs(() => {
        // The on-disk removal succeeded, so the uninstall reports success even
        // though the best-effort bundled restore threw.
        expect(uninstallCallback).toHaveBeenCalled();
        expect(uninstallCallback.mostRecentCall.args[0]).toBeUndefined();
        expect(atom.packages.activatePackage).not.toHaveBeenCalled();
        fs.removeSync(packagesDir);
      });
    });

    it("removes only a user package symlink and preserves its source directory", function () {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-uninstall-")));
      const packagesDir = path.join(root, "packages");
      const sourceDir = path.join(root, "linked-package-source");
      const packagePath = path.join(packagesDir, "linked-package");
      const sourceFile = path.join(sourceDir, "keep.txt");
      fs.makeTreeSync(packagesDir);
      fs.makeTreeSync(sourceDir);
      fs.writeFileSync(sourceFile, "keep");
      fs.symlinkSync(sourceDir, packagePath, process.platform === "win32" ? "junction" : "dir");

      spyOn(packageManager, "getAtomPackagesDirectory").andReturn(packagesDir);
      // This is the dangerous value returned by core for a linked package.
      spyOn(atom.packages, "resolvePackagePath").andReturn(sourceDir);

      waitsForPromise(() => packageManager.uninstall({ name: "linked-package" }));

      runs(() => {
        const packageEntryExists = fs.existsSync(packagePath);
        const sourceFileExists = fs.existsSync(sourceFile);
        try {
          fs.unlinkSync(packagePath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        fs.removeSync(root);

        expect(packageEntryExists).toBe(false);
        expect(sourceFileExists).toBe(true);
      });
    });
  });

  describe("::removePackageDir()", function () {
    it("removes a directory tree asynchronously, including nested folders", function () {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-rm-")));
      fs.makeTreeSync(path.join(dir, "node_modules", "dep", "deep"));
      fs.writeFileSync(path.join(dir, "node_modules", "dep", "deep", "index.js"), "x");
      expect(fs.existsSync(dir)).toBe(true);

      waitsForPromise(() => packageManager.removePackageDir(dir));
      runs(() => expect(fs.existsSync(dir)).toBe(false));
    });

    it("resolves without error when the directory is already gone", function () {
      waitsForPromise(() =>
        packageManager.removePackageDir(path.join(os.tmpdir(), "lumine-not-there-xyz")),
      );
    });
  });

  describe("::installGitHubPackage()", function () {
    it("reinstalls an installed package from its recorded source, not the bare name", function () {
      spyOn(packageManager, "resolvePackageSource").andReturn(Promise.reject(new Error("stop")));
      const pack = {
        name: "hydrogen-next",
        apmInstallSource: { type: "git", source: "lumine-code/hydrogen-next" },
      };

      let rejected = false;
      waitsForPromise(() =>
        packageManager.installGitHubPackage(pack).catch(() => (rejected = true)),
      );

      runs(() => {
        expect(rejected).toBe(true);
        expect(packageManager.resolvePackageSource).toHaveBeenCalledWith(
          "lumine-code/hydrogen-next",
        );
      });
    });

    it("preserves an explicit version selector from installSource", function () {
      spyOn(packageManager, "resolvePackageSource").andReturn(Promise.reject(new Error("stop")));
      const pack = {
        name: "asiloisad/pulsar-invert-colors@0.4.0",
        installSource: "asiloisad/pulsar-invert-colors@0.4.0",
        repository: "asiloisad/pulsar-invert-colors",
      };

      let rejected = false;
      waitsForPromise(() =>
        packageManager.installGitHubPackage(pack).catch(() => (rejected = true)),
      );

      runs(() => {
        expect(rejected).toBe(true);
        // The pinned tag must survive; installing the bare repo would grab latest.
        expect(packageManager.resolvePackageSource).toHaveBeenCalledWith(
          "asiloisad/pulsar-invert-colors@0.4.0",
        );
      });
    });

    it("installs from the repository when no installSource is present, not the bare name", function () {
      spyOn(packageManager, "resolvePackageSource").andReturn(Promise.reject(new Error("stop")));
      // A catalog/registry pack that carries only name + repository (+ version).
      const pack = {
        name: "hydrogen-next",
        repository: "lumine-code/hydrogen-next",
        version: "4.14.1",
      };

      let rejected = false;
      waitsForPromise(() =>
        packageManager.installGitHubPackage(pack).catch(() => (rejected = true)),
      );

      runs(() => {
        expect(rejected).toBe(true);
        // The pinned-version attempt must target the repository, never "hydrogen-next".
        const source = packageManager.resolvePackageSource.mostRecentCall.args[0];
        expect(source).toContain("lumine-code/hydrogen-next");
      });
    });

    it("does not block install completion on a package that defers activation", function () {
      spyOn(atom.packages, "loadPackage");
      spyOn(atom.packages, "isPackageDisabled").andReturn(false);
      // A package with activationCommands/hooks never resolves activatePackage
      // until its trigger fires; the install must not await that.
      spyOn(atom.packages, "activatePackage").andReturn(new Promise(() => {}));

      const result = packageManager.activateInstalledPackage("deferred-package", { theme: false });

      expect(atom.packages.loadPackage).toHaveBeenCalledWith("deferred-package");
      expect(atom.packages.activatePackage).toHaveBeenCalledWith("deferred-package");
      // Returns synchronously — it must not await the (never-resolving) activation.
      expect(result).toBeUndefined();
    });
  });

  describe("::packageHasSettings", function () {
    it("returns true when the package has config", function () {
      atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
      expect(packageManager.packageHasSettings("package-with-config")).toBe(true);
    });

    it("returns false when the package does not have config and doesn't define language grammars", () =>
      expect(packageManager.packageHasSettings("random-package")).toBe(false));

    it("returns true when the package does not have config, but does define language grammars", function () {
      const packageName = "language-test";

      waitsForPromise(() =>
        atom.packages.activatePackage(path.join(__dirname, "fixtures", packageName)),
      );

      return runs(() => expect(packageManager.packageHasSettings(packageName)).toBe(true));
    });
  });

  describe("::loadOutdated", function () {
    it("caches results", function () {
      spyOn(packageManager, "getGitPackageUpdates").andReturn(Promise.resolve([{ name: "boop" }]));

      waitsForPromise(() => new Promise((resolve) => packageManager.loadOutdated(false, resolve)));

      runs(function () {
        expect(packageManager.apmCache.loadOutdated.value).toEqual([{ name: "boop" }]);
      });

      waitsForPromise(() => new Promise((resolve) => packageManager.loadOutdated(false, resolve)));

      runs(function () {
        expect(packageManager.getGitPackageUpdates.callCount).toBe(1);
      });
    });

    it("expires results if it is called with clearCache set to true", function () {
      packageManager.apmCache.loadOutdated = {
        value: ["hi"],
        expiry: Date.now() + 999999999,
      };
      spyOn(packageManager, "getGitPackageUpdates").andReturn(Promise.resolve([{ name: "boop" }]));

      waitsForPromise(() => new Promise((resolve) => packageManager.loadOutdated(true, resolve)));

      runs(function () {
        expect(packageManager.getGitPackageUpdates.callCount).toBe(1);
        expect(packageManager.apmCache.loadOutdated.value).toEqual([{ name: "boop" }]);
      });
    });
  });

  describe("::getGitPackageUpdates()", function () {
    it("finds a newer tag for packages installed with the default selector", function () {
      spyOn(packageManager, "getLocalPackages").andReturn({
        git: [
          {
            name: "sample",
            version: "1.0.0",
            apmInstallSource: {
              type: "git",
              source: "owner/sample",
              updatePolicy: "latest-tag",
              sha: "1111111111111111111111111111111111111111",
            },
          },
        ],
      });
      spyOn(packageManager, "resolvePackageSource").andReturn(
        Promise.resolve({
          sha: "2222222222222222222222222222222222222222",
          version: "2.0.0",
          selector: { type: "latest", value: "v2.0.0" },
        }),
      );
      spyOn(packageManager, "inspectPackageUpdate").andReturn(Promise.resolve({ name: "sample" }));

      waitsForPromise(() =>
        packageManager.getGitPackageUpdates().then((updates) => {
          expect(updates.length).toBe(1);
          expect(updates[0].latestSha).toBe("2222222222222222222222222222222222222222");
          expect(updates[0].latestVersion).toBe("2.0.0");
          expect(updates[0].resolvedRef).toEqual({ type: "latest", value: "v2.0.0" });
        }),
      );
    });

    it("does not offer an update when the new commit changes the package name", function () {
      spyOn(packageManager, "getLocalPackages").andReturn({
        git: [
          {
            name: "old-package-name",
            version: "1.0.0",
            apmInstallSource: {
              type: "git",
              source: "owner/sample",
              updatePolicy: "latest-tag",
              sha: "1111111111111111111111111111111111111111",
            },
          },
        ],
      });
      spyOn(packageManager, "resolvePackageSource").andReturn(
        Promise.resolve({
          sha: "2222222222222222222222222222222222222222",
          version: "2.0.0",
          selector: { type: "latest", value: "v2.0.0" },
        }),
      );
      spyOn(packageManager, "inspectPackageUpdate").andReturn(
        Promise.resolve({ name: "new-package-name" }),
      );

      waitsForPromise(() =>
        packageManager.getGitPackageUpdates().then((updates) => {
          expect(updates.length).toBe(1);
          expect(updates[0].renamedPackage).toEqual({
            from: "old-package-name",
            to: "new-package-name",
            sha: "2222222222222222222222222222222222222222",
          });
          expect(updates[0].latestSha).toBeUndefined();
          expect(updates[0].originWarning).toContain("not an update");
        }),
      );
    });

    it("does not check explicitly pinned tags or commits", function () {
      spyOn(packageManager, "getLocalPackages").andReturn({
        git: [
          {
            name: "sample",
            apmInstallSource: {
              type: "git",
              source: "owner/sample#tag:v1.0.0",
              updatePolicy: "pinned",
              sha: "1111111111111111111111111111111111111111",
            },
          },
        ],
      });
      spyOn(packageManager, "resolvePackageSource");

      waitsForPromise(() =>
        packageManager.getGitPackageUpdates().then((updates) => {
          expect(updates).toEqual([]);
          expect(packageManager.resolvePackageSource).not.toHaveBeenCalled();
        }),
      );
    });

    it("reports a moved pinned tag as suspicious without offering a new SHA", function () {
      spyOn(packageManager, "getLocalPackages").andReturn({
        git: [
          {
            name: "sample",
            apmInstallSource: {
              type: "git",
              source: "owner/sample#tag:v1.0.0",
              selector: { type: "tag", value: "v1.0.0" },
              updatePolicy: "pinned",
              sha: "1111111111111111111111111111111111111111",
            },
          },
        ],
      });
      spyOn(packageManager, "resolvePackageSource").andReturn(
        Promise.resolve({ sha: "2222222222222222222222222222222222222222" }),
      );

      waitsForPromise(() =>
        packageManager.getGitPackageUpdates().then((updates) => {
          expect(updates.length).toBe(1);
          expect(updates[0].suspiciousTagMove.remoteSha).toBe(
            "2222222222222222222222222222222222222222",
          );
          expect(updates[0].latestSha).toBeUndefined();
        }),
      );
    });
  });
});
