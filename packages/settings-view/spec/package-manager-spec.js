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
    let [configDirPath, devPackagesPath, bundledPackagesPath] = [];

    beforeEach(function () {
      configDirPath = path.join(os.tmpdir(), "settings-view-config");
      devPackagesPath = path.join(configDirPath, "packages-dev");
      bundledPackagesPath = path.join(path.sep, "app", "packages");
      spyOn(atom, "getConfigDirPath").andReturn(configDirPath);
    });

    // A descriptor shaped like the ones PackageManager::scanAvailablePackages
    // produces: one per directory, carrying the tier it was found in.
    function descriptor(tier, directory, dirname, metadata = {}) {
      return {
        name: metadata.name || dirname,
        dirname,
        path: path.join(directory, dirname),
        tier,
        isBundled: tier === "bundled",
        metadata,
        nameSource: metadata.name ? "manifest" : "dirname",
        isWinner: true,
      };
    }

    function availablePackages(...packs) {
      spyOn(atom.packages, "getAvailablePackages").andReturn(packs);
    }

    it("files a package found in the bundled directory under core", function () {
      // Running in dev mode from a source checkout, every packages/ entry
      // reports isBundled: false; the directory it was found in still says
      // what it is.
      availablePackages(descriptor("bundled", bundledPackagesPath, "tree-view"));

      const packages = packageManager.getLocalPackages();
      expect(packages.core.map((p) => p.name)).toEqual(["tree-view"]);
      expect(packages.user.map((p) => p.name)).toEqual([]);
    });

    it("files a community package under user", function () {
      availablePackages(
        descriptor("community", path.join(configDirPath, "packages"), "some-community-package"),
      );

      const packages = packageManager.getLocalPackages();
      expect(packages.user.map((p) => p.name)).toEqual(["some-community-package"]);
      expect(packages.core).toEqual([]);
    });

    it("files a dev override of a bundled name under dev and keeps the shadowed bundled entry", function () {
      const shadowedBundled = descriptor("bundled", bundledPackagesPath, "tree-view");
      shadowedBundled.isWinner = false;
      shadowedBundled.shadowedBy = {
        name: "tree-view",
        dirname: "tree-view",
        path: path.join(devPackagesPath, "tree-view"),
        tier: "dev",
      };
      availablePackages(descriptor("dev", devPackagesPath, "tree-view"), shadowedBundled);

      const packages = packageManager.getLocalPackages();
      expect(packages.dev.map((p) => p.name)).toEqual(["tree-view"]);
      expect(packages.core.map((p) => p.name)).toEqual(["tree-view"]);
      expect(packages.core[0].isShadowed).toBe(true);
      expect(packages.core[0].shadowedBy.tier).toBe("dev");
    });

    it("files a git-sourced package under git", function () {
      availablePackages(
        descriptor("community", path.join(configDirPath, "packages"), "git-package", {
          name: "git-package",
          apmInstallSource: { type: "git" },
        }),
      );

      const packages = packageManager.getLocalPackages();
      expect(packages.git.map((p) => p.name)).toEqual(["git-package"]);
    });

    it("keeps a legacy Git install active but warns when its receipt has no origin", function () {
      availablePackages(
        descriptor("community", path.join(configDirPath, "packages"), "legacy-package", {
          name: "legacy-package",
          repository: "owner/legacy-package",
          apmInstallSource: { type: "git", source: "owner/legacy-package", sha: "abc123" },
        }),
      );

      const packages = packageManager.getLocalPackages();
      expect(packages.git[0].originWarning).toContain("missing or mismatched");
    });

    it("records the directory a package lives in, whatever the package is called", function () {
      availablePackages(
        descriptor("bundled", bundledPackagesPath, "tree-view"),
        descriptor("community", path.join(configDirPath, "packages"), "installed-as-other", {
          name: "some-community-package",
        }),
      );

      const packages = packageManager.getLocalPackages();
      expect(packages.core[0].directoryName).toBe("tree-view");
      expect(packages.user[0].name).toBe("some-community-package");
      expect(packages.user[0].directoryName).toBe("installed-as-other");
    });

    it("lists every directory providing one name, marking the copies that do not load", function () {
      const stale = descriptor("community", path.join(configDirPath, "packages"), "zz-old-copy", {
        name: "duplicated-package",
      });
      stale.isWinner = false;
      stale.shadowedBy = {
        name: "duplicated-package",
        dirname: "duplicated-package",
        path: path.join(configDirPath, "packages", "duplicated-package"),
        tier: "community",
      };
      availablePackages(
        descriptor("community", path.join(configDirPath, "packages"), "duplicated-package"),
        stale,
      );

      const packages = packageManager.getLocalPackages();
      expect(packages.user.map((pack) => pack.directoryName)).toEqual([
        "duplicated-package",
        "zz-old-copy",
      ]);
      expect(packages.user.map((pack) => pack.isShadowed)).toEqual([false, true]);
    });
  });

  describe("::getInstalled()", function () {
    beforeEach(function () {
      jasmine.useRealClock();
      const configDirPath = path.join(os.tmpdir(), "settings-view-config");
      spyOn(atom, "getConfigDirPath").andReturn(configDirPath);

      // More than one batch (BATCH_SIZE = 20) so the async path exercises its
      // yield-between-chunks loop rather than only the single-batch fast path.
      this.packs = [];
      for (let i = 0; i < 45; i++) {
        this.packs.push({
          name: `community-${i}`,
          dirname: `community-${i}`,
          path: path.join(configDirPath, "packages", `community-${i}`),
          tier: "community",
          isBundled: false,
          metadata: { name: `community-${i}` },
          isWinner: true,
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
    // Uninstalling removes one directory. Which directory that is comes from
    // the entry being uninstalled, never from the package's name — a name can
    // be provided by several directories.
    function installedAt(root, dirname) {
      const packagesDir = path.join(root, "packages");
      const packagePath = path.join(packagesDir, dirname);
      fs.makeTreeSync(packagePath);
      return packagePath;
    }

    function tempRoot(prefix) {
      return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    }

    it("removes the package from the core.disabledPackages list when no copy is left", function () {
      const root = tempRoot("lumine-uninstall-disabled-");
      const packagePath = installedAt(root, "something");
      atom.config.set("core.disabledPackages", ["something"]);
      spyOn(atom.packages, "getAvailablePackage").andReturn(undefined);

      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      waitsForPromise(() =>
        packageManager.uninstall({ name: "something", path: packagePath }, uninstallCallback),
      );

      runs(() => {
        expect(uninstallCallback).toHaveBeenCalled();
        expect(atom.config.get("core.disabledPackages")).not.toContain("something");
        expect(fs.existsSync(packagePath)).toBe(false);
        fs.removeSync(root);
      });
    });

    it("awaits async deactivation before unloading an active package", function () {
      // Reproduces the "Tried to unload active package" error: deactivation is
      // async, so unloading must wait for it to complete.
      const root = tempRoot("lumine-uninstall-active-");
      const packagePath = installedAt(root, "active-pkg");
      let deactivated = false;
      spyOn(atom.packages, "getLoadedPackage").andReturn({ name: "active-pkg", path: packagePath });
      spyOn(atom.packages, "isPackageActive").andCallFake(() => !deactivated);
      spyOn(atom.packages, "deactivatePackage").andCallFake(() =>
        Promise.resolve().then(() => {
          deactivated = true;
        }),
      );
      spyOn(atom.packages, "unloadPackage").andCallFake((name) => {
        if (atom.packages.isPackageActive(name)) {
          throw new Error(`Tried to unload active package '${name}'`);
        }
      });
      spyOn(atom.packages, "getAvailablePackage").andReturn(undefined);

      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      waitsForPromise(() =>
        packageManager.uninstall({ name: "active-pkg", path: packagePath }, uninstallCallback),
      );

      runs(() => {
        expect(atom.packages.deactivatePackage).toHaveBeenCalledWith("active-pkg");
        expect(atom.packages.unloadPackage).toHaveBeenCalledWith("active-pkg");
        expect(uninstallCallback).toHaveBeenCalled();
        expect(uninstallCallback.mostRecentCall.args[0]).toBeUndefined();
        fs.removeSync(root);
      });
    });

    it("leaves the loaded package alone when a shadowed copy is uninstalled", function () {
      const root = tempRoot("lumine-uninstall-shadowed-");
      const loadedPath = installedAt(root, "duplicated-package");
      const shadowedPath = installedAt(root, "zz-old-copy");
      spyOn(atom.packages, "getLoadedPackage").andReturn({
        name: "duplicated-package",
        path: loadedPath,
      });
      spyOn(atom.packages, "deactivatePackage");
      spyOn(atom.packages, "unloadPackage");
      spyOn(atom.packages, "reconcilePackage");
      spyOn(atom.packages, "getAvailablePackage").andReturn({
        name: "duplicated-package",
        path: loadedPath,
      });

      waitsForPromise(() =>
        packageManager.uninstall({ name: "duplicated-package", path: shadowedPath }),
      );

      runs(() => {
        expect(atom.packages.deactivatePackage).not.toHaveBeenCalled();
        expect(atom.packages.unloadPackage).not.toHaveBeenCalled();
        expect(atom.packages.reconcilePackage).not.toHaveBeenCalled();
        expect(fs.existsSync(shadowedPath)).toBe(false);
        expect(fs.existsSync(loadedPath)).toBe(true);
        fs.removeSync(root);
      });
    });

    it("loads whichever copy is left and preserves the disabled slot", function () {
      const root = tempRoot("lumine-uninstall-promote-");
      const packagePath = installedAt(root, "search-panel");
      const bundledPath = path.join(path.sep, "app", "packages", "search-panel");
      atom.config.set("core.disabledPackages", ["search-panel"]);
      spyOn(atom.packages, "getLoadedPackage").andReturn({
        name: "search-panel",
        path: packagePath,
      });
      spyOn(atom.packages, "isPackageActive").andReturn(false);
      spyOn(atom.packages, "unloadPackage");
      spyOn(atom.packages, "getAvailablePackage").andReturn({
        name: "search-panel",
        path: bundledPath,
        tier: "bundled",
      });
      spyOn(atom.packages, "reconcilePackage").andReturn(Promise.resolve(null));

      waitsForPromise(() => packageManager.uninstall({ name: "search-panel", path: packagePath }));
      runs(() => {
        expect(atom.packages.reconcilePackage).toHaveBeenCalledWith("search-panel", {
          activate: true,
        });
        expect(atom.config.get("core.disabledPackages")).toContain("search-panel");
        fs.removeSync(root);
      });
    });

    it("does not wait for the copy it loads to finish activating", function () {
      // A package that defers activation never resolves activatePackage until
      // its trigger fires; awaiting it would hang the uninstall.
      const root = tempRoot("lumine-uninstall-deferred-");
      const packagePath = installedAt(root, "deferred-bundled");
      spyOn(atom.packages, "getLoadedPackage").andReturn({
        name: "deferred-bundled",
        path: packagePath,
      });
      spyOn(atom.packages, "isPackageActive").andReturn(false);
      spyOn(atom.packages, "unloadPackage");
      spyOn(atom.packages, "getAvailablePackage").andReturn({
        name: "deferred-bundled",
        path: path.join(path.sep, "app", "packages", "deferred-bundled"),
      });
      // Never resolves — mimics a package that defers activation.
      spyOn(atom.packages, "reconcilePackage").andReturn(new Promise(() => {}));

      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      waitsForPromise(() =>
        packageManager.uninstall(
          { name: "deferred-bundled", path: packagePath },
          uninstallCallback,
        ),
      );

      runs(() => {
        expect(atom.packages.reconcilePackage).toHaveBeenCalled();
        // The uninstall completes even though activation never resolves.
        expect(uninstallCallback).toHaveBeenCalled();
        expect(uninstallCallback.mostRecentCall.args[0]).toBeUndefined();
        fs.removeSync(root);
      });
    });

    it("still completes the uninstall when loading the remaining copy fails", function () {
      const root = tempRoot("lumine-uninstall-throw-");
      const packagePath = installedAt(root, "broken-bundled");
      spyOn(atom.packages, "getLoadedPackage").andReturn({
        name: "broken-bundled",
        path: packagePath,
      });
      spyOn(atom.packages, "isPackageActive").andReturn(false);
      spyOn(atom.packages, "unloadPackage");
      spyOn(atom.packages, "getAvailablePackage").andReturn({
        name: "broken-bundled",
        path: path.join(path.sep, "app", "packages", "broken-bundled"),
      });
      // Built inside the fake, not ahead of it: a rejected promise created
      // before the call it answers is unhandled until the caller gets to it.
      spyOn(atom.packages, "reconcilePackage").andCallFake(() =>
        Promise.reject(new Error("cannot load bundled package")),
      );

      const uninstallCallback = jasmine.createSpy("uninstallCallback");
      waitsForPromise(() =>
        packageManager.uninstall({ name: "broken-bundled", path: packagePath }, uninstallCallback),
      );

      runs(() => {
        // The on-disk removal succeeded, so the uninstall reports success even
        // though the best-effort load of the remaining copy failed.
        expect(uninstallCallback).toHaveBeenCalled();
        expect(uninstallCallback.mostRecentCall.args[0]).toBeUndefined();
        fs.removeSync(root);
      });
    });

    it("removes only a user package symlink and preserves its source directory", function () {
      const root = tempRoot("lumine-uninstall-");
      const packagesDir = path.join(root, "packages");
      const sourceDir = path.join(root, "linked-package-source");
      const packagePath = path.join(packagesDir, "linked-package");
      const sourceFile = path.join(sourceDir, "keep.txt");
      fs.makeTreeSync(packagesDir);
      fs.makeTreeSync(sourceDir);
      fs.writeFileSync(sourceFile, "keep");
      fs.symlinkSync(sourceDir, packagePath, process.platform === "win32" ? "junction" : "dir");
      spyOn(atom.packages, "getAvailablePackage").andReturn(undefined);

      waitsForPromise(() =>
        packageManager.uninstall({ name: "linked-package", path: packagePath }),
      );

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
