const _ = require("@lumine-code/underscore-plus");
const { BufferedProcess, CompositeDisposable, Emitter } = require("atom");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const semver = require("semver");
const {
  cloneUrlForRepository,
  parsePackageSource,
  resolvePackageSource,
} = require("../../../src/package-source"); // eslint-disable-line n/no-unpublished-require
const PackageInstallationService = require("../../../src/package-installation-service"); // eslint-disable-line n/no-unpublished-require

const { packageCoordinate, packageOrigin, packageOriginKey } = require("./utils");

// The HTTP clients pull in `request` (~120ms to require), which dominates
// package activation. They are only needed when the user opens the Install or
// Updates tabs, so require them lazily inside their getters instead of eagerly.

module.exports = class PackageManager {
  constructor() {
    // Millisecond expiry for cached loadOutdated, etc. values
    this.CACHE_EXPIRY = 1000 * 60 * 10;
    this.packagePromises = [];
    this.apmCache = {
      loadOutdated: {
        value: null,
        expiry: 0,
      },
    };

    this.emitter = new Emitter();
  }

  getClient() {
    if (this.client != null) return this.client;
    const Client = require("./atom-io-client");
    return (this.client = new Client(this));
  }

  getCatalogClient() {
    if (this.catalogClient != null) return this.catalogClient;
    const CommunityPackageCatalogClient = require("./community-package-catalog-client");
    return (this.catalogClient = new CommunityPackageCatalogClient({ packageManager: this }));
  }

  getPulsarClient() {
    if (this.pulsarClient != null) return this.pulsarClient;
    const PulsarPackageClient = require("./pulsar-package-client");
    return (this.pulsarClient = new PulsarPackageClient());
  }

  isPackageInstalled(packageName) {
    if (atom.packages.isPackageLoaded(packageName)) {
      return true;
    } else {
      return atom.packages.getAvailablePackageNames().indexOf(packageName) > -1;
    }
  }

  packageHasSettings(packageName) {
    const grammars = atom.grammars.getGrammars() != null ? atom.grammars.getGrammars() : [];
    for (let grammar of Array.from(grammars)) {
      if (grammar.path) {
        if (grammar.packageName === packageName) {
          return true;
        }
      }
    }

    const pack = atom.packages.getLoadedPackage(packageName);
    if (pack != null && !atom.packages.isPackageActive(packageName)) {
      pack.activateConfig();
    }
    const schema = atom.config.getSchema(packageName);
    return schema != null && schema.type !== "any";
  }

  loadInstalled(callback) {
    try {
      return callback(null, this.getLocalPackages());
    } catch (error) {
      return callback(error);
    }
  }

  loadFeatured(loadThemes, callback) {
    if (!callback) {
      callback = loadThemes;
    }

    return callback(null, []);
  }

  loadOutdated(clearCache, callback) {
    if (clearCache) {
      this.clearOutdatedCache();
      // Short circuit if we have cached data.
    } else if (this.apmCache.loadOutdated.value && this.apmCache.loadOutdated.expiry > Date.now()) {
      return callback(null, this.apmCache.loadOutdated.value);
    }

    this.getGitPackageUpdates().then((updatablePackages) => {
      this.apmCache.loadOutdated = {
        value: updatablePackages,
        expiry: Date.now() + this.CACHE_EXPIRY,
      };

      for (const pack of Array.from(updatablePackages)) {
        this.emitPackageEvent("update-available", pack);
      }

      return callback(null, updatablePackages);
    }, callback);
  }

  clearOutdatedCache() {
    return (this.apmCache.loadOutdated = {
      value: null,
      expiry: 0,
    });
  }

  loadPackage(packageName, callback) {
    const pack = this.getAllLocalPackages().find((pack) => pack.name === packageName);
    if (pack) {
      return callback(null, pack);
    } else {
      return callback(new Error(`Package '${packageName}' is not installed.`));
    }
  }

  loadCompatiblePackageVersion(packageName, callback) {
    return this.loadPackage(packageName, (error, pack) => callback(null, error ? {} : pack));
  }

  getInstalled() {
    // Enumerate off the render path in chunks so opening the Packages/Themes
    // panels stays smooth even with a large install set. The result is identical
    // to the synchronous getLocalPackages(); only the timing differs.
    return this.loadInstalledPackages();
  }

  getFeatured(loadThemes) {
    return new Promise((resolve, reject) => {
      return this.loadFeatured(!!loadThemes, function (error, result) {
        if (error) {
          return reject(error);
        } else {
          return resolve(result);
        }
      });
    });
  }

  getOutdated(clearCache) {
    if (clearCache == null) {
      clearCache = false;
    }
    return new Promise((resolve, reject) => {
      this.loadOutdated(clearCache, function (error, result) {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  }

  getPackage(packageName) {
    return this.packagePromises[packageName] != null
      ? this.packagePromises[packageName]
      : (this.packagePromises[packageName] = new Promise((resolve, reject) => {
          this.loadPackage(packageName, function (error, result) {
            if (error) {
              return reject(error);
            } else {
              return resolve(result);
            }
          });
        }));
  }

  satisfiesVersion(version, metadata) {
    const engine =
      (metadata.engines != null ? metadata.engines.atom : undefined) != null
        ? metadata.engines != null
          ? metadata.engines.atom
          : undefined
        : "*";
    if (!semver.validRange(engine)) {
      return false;
    }
    return semver.satisfies(version, engine);
  }

  normalizeVersion(version) {
    if (typeof version === "string") {
      [version] = Array.from(version.split("-"));
    }
    return version;
  }

  update(pack, newVersion, callback) {
    const { name, theme, apmInstallSource } = pack;

    const errorMessage = newVersion
      ? `Updating to \u201C${name}@${newVersion}\u201D failed.`
      : "Updating to latest sha failed.";
    const onError = (error) => {
      error.packageInstallError = !theme;
      this.emitPackageEvent("update-failed", pack, error);
      return typeof callback === "function" ? callback(error) : undefined;
    };

    if ((apmInstallSource != null ? apmInstallSource.type : undefined) !== "git") {
      const error = new Error("Only Git repository package updates are supported.");
      error.packageInstallError = !theme;
      return onError(error);
    }

    this.emitPackageEvent("updating", pack);
    const exactUpdate = _.extend({}, pack, {
      name: apmInstallSource.source,
      resolvedSha: pack.latestSha || pack.resolvedSha,
      selectedRef: pack.resolvedRef || pack.selectedRef || apmInstallSource.selector,
      updatePolicy: pack.updatePolicy || apmInstallSource.updatePolicy,
    });
    this.installGitHubPackage(exactUpdate).then(
      (updatedPack) => {
        this.clearOutdatedCache();
        if (typeof callback === "function") {
          callback();
        }
        return this.emitPackageEvent("updated", updatedPack);
      },
      (error) => {
        error.message = error.message || errorMessage;
        return onError(error);
      },
    );
  }

  async unload(name) {
    if (atom.packages.isPackageLoaded(name)) {
      if (atom.packages.isPackageActive(name)) {
        // Deactivation may be async; await it so unloadPackage() doesn't throw
        // "Tried to unload active package".
        await atom.packages.deactivatePackage(name);
      }
      return atom.packages.unloadPackage(name);
    }
  }

  install(pack, callback, options = {}) {
    const { name, version, theme } = pack;
    const nameWithVersion = version != null ? `${name}@${version}` : name;

    const errorMessage = `Installing \u201C${nameWithVersion}\u201D failed.`;
    const onError = (error) => {
      error.packageInstallError = !theme;
      this.emitPackageEvent("install-failed", pack, error);
      return typeof callback === "function" ? callback(error) : undefined;
    };

    this.emitPackageEvent("installing", pack);
    this.installGitHubPackage(pack, options).then(
      (installedPack) => {
        pack = _.extend({}, pack, installedPack);
        this.clearOutdatedCache();
        // Loading and activation happen exactly once, in installGitHubPackage's
        // afterSwap hook (see activateInstalledPackage). Doing them again here
        // would run the package's activate() a second time \u2014 the source of a
        // freshly-installed package appearing to run twice.
        if (typeof callback === "function") {
          callback();
        }
        return this.emitPackageEvent("installed", pack);
      },
      (error) => {
        error.message = error.message || errorMessage;
        return onError(error);
      },
    );
  }

  replace(pack, callback) {
    return this.install(pack, callback, { allowReplace: true });
  }

  async uninstall(pack, callback) {
    const { name } = pack;

    const errorMessage = `Uninstalling \u201C${name}\u201D failed.`;
    const onError = (error) => {
      this.emitPackageEvent("uninstall-failed", pack, error);
      return typeof callback === "function" ? callback(error) : undefined;
    };

    try {
      this.emitPackageEvent("uninstalling", pack);
      // resolvePackagePath() canonicalizes symlinks, which would make uninstall
      // remove a linked package's source instead of its entry in the user
      // packages directory.
      const packagePath = path.join(this.getAtomPackagesDirectory(), name);
      if (atom.packages.isPackageActive(name)) {
        // Await async deactivation before unloading (see ::unload).
        await atom.packages.deactivatePackage(name);
      }
      if (atom.packages.isPackageLoaded(name)) {
        atom.packages.unloadPackage(name);
      }
      if (fs.isDirectorySync(packagePath) || fs.isSymbolicLinkSync(packagePath)) {
        await this.removePackageDir(packagePath);
      }
      this.clearOutdatedCache();
      const restoresBundled = atom.packages.isBundledPackage(name);
      if (!restoresBundled) {
        this.removePackageNameFromDisabledPackages(name);
      }

      // Signal completion as soon as the package is gone from disk. The bundled
      // restore below is best-effort and runs afterwards, so a slow, deferred, or
      // failing activation can never hang or fail an uninstall that already
      // succeeded (and left the UI spinner stuck until a restart).
      if (typeof callback === "function") {
        callback();
      }
      const result = this.emitPackageEvent("uninstalled", pack);

      if (restoresBundled) {
        // Reveal the overridden bundled package again. The name's disabled
        // preference belongs to the slot and is preserved; activation is
        // fire-and-forget because a package that defers activation only resolves
        // activatePackage once its trigger fires.
        try {
          atom.packages.loadPackage(name);
          if (!atom.packages.isPackageDisabled(name)) {
            atom.packages.activatePackage(name).catch(() => {});
          }
        } catch {
          // The bundled package will load on the next restart.
        }
      }

      return result;
    } catch (error) {
      error.message = error.message || errorMessage;
      return onError(error);
    }
  }

  canUpgrade(installedPackage, availableVersion) {
    if (installedPackage == null) {
      return false;
    }

    const installedVersion = installedPackage.metadata.version;
    if (!semver.valid(installedVersion)) {
      return false;
    }
    if (!semver.valid(availableVersion)) {
      return false;
    }

    return semver.gt(availableVersion, installedVersion);
  }

  getPackageTitle({ name }) {
    return _.undasherize(_.uncamelcase(name));
  }

  getRepositoryUrl({ metadata }) {
    let left;
    const { repository } = metadata;
    let repoUrl =
      (left =
        (repository != null ? repository.url : undefined) != null
          ? repository != null
            ? repository.url
            : undefined
          : repository) != null
        ? left
        : "";
    if (repoUrl.match("git@github")) {
      const repoName = repoUrl.split(":")[1];
      repoUrl = `https://github.com/${repoName}`;
    }
    const url = repoUrl
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
      .replace(/^git\+/, "");
    // A bare owner/repo shorthand must become a full GitHub URL, otherwise
    // opening it externally is treated as a file path (opens Explorer).
    return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
  }

  getRepositoryBugUri({ metadata }) {
    let bugUri;
    const { bugs } = metadata;
    if (typeof bugs === "string") {
      bugUri = bugs;
    } else {
      let left;
      bugUri =
        (left =
          (bugs != null ? bugs.url : undefined) != null
            ? bugs != null
              ? bugs.url
              : undefined
            : bugs != null
              ? bugs.email
              : undefined) != null
          ? left
          : this.getRepositoryUrl({ metadata }) + "/issues/new";
      if (bugUri.includes("@")) {
        bugUri = "mailto:" + bugUri;
      }
    }
    return bugUri;
  }

  checkNativeBuildTools() {
    return Promise.all([
      this.runProcess(this.getGitCommand(), ["--version"]),
      this.runProcess(this.getNpmCommand(), ["--version"]),
    ]);
  }

  getAtomPackagesDirectory() {
    return path.join(process.env.LUMINE_HOME, "packages");
  }

  getGitCommand() {
    return "git";
  }

  getNpmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
  }

  runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeout = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        callback(value);
      };
      const processOptions = { ...options };
      const timeoutMs = processOptions.timeoutMs;
      delete processOptions.timeoutMs;
      const process = new BufferedProcess({
        command,
        args,
        options: processOptions,
        stdout(output) {
          stdout += output;
        },
        stderr(output) {
          stderr += output;
        },
        exit(code) {
          if (code === 0) {
            finish(resolve, { code, stdout, stderr });
          } else {
            const error = new Error(stderr || stdout || `${command} failed with exit code ${code}`);
            error.stdout = stdout;
            error.stderr = stderr;
            finish(reject, error);
          }
        },
      });

      process.onWillThrowError(({ error, handle }) => {
        handle();
        error.stdout = stdout;
        error.stderr = stderr || error.message;
        finish(reject, error);
      });
      if (timeoutMs && !settled) {
        timeout = setTimeout(() => {
          const error = new Error(`${command} timed out after ${timeoutMs}ms.`);
          error.stdout = stdout;
          error.stderr = stderr;
          finish(reject, error);
          try {
            process.kill();
          } catch {
            // The process exited between the timeout firing and cancellation.
          }
        }, timeoutMs);
      }
    });
  }

  getCloneUrl(source) {
    return cloneUrlForRepository(parsePackageSource(source).repository);
  }

  resolvePackageSource(source) {
    return resolvePackageSource(source, async (cloneUrl, options, patterns) => {
      const { stdout } = await this.runProcess(this.getGitCommand(), [
        "ls-remote",
        ...options,
        cloneUrl,
        ...patterns,
      ]);
      return stdout;
    });
  }

  // Removes a directory tree robustly and asynchronously. Async matters: a
  // synchronous remove of a deep node_modules tree blocks the renderer thread
  // and freezes the editor. Node's rm also retries on Windows' transient
  // ENOTEMPTY/EBUSY/EPERM (antivirus/indexer locks) and force-removes read-only
  // entries such as those under .git — fs-plus's bundled rimraf does neither.
  removePackageDir(dirPath) {
    return require("fs").promises.rm(dirPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }

  async installGitHubPackage(pack, options = {}) {
    const service = new PackageInstallationService({
      packagesDirectory: this.getAtomPackagesDirectory(),
      gitCommand: this.getGitCommand(),
      npmCommand: this.getNpmCommand(),
      run: this.runProcess.bind(this),
      capture: this.runProcess.bind(this),
      resolveSource: this.resolvePackageSource.bind(this),
      atomVersion: this.normalizeVersion(atom.getVersion()),
      beforeSwap: async (name) => {
        const wasActive = atom.packages.isPackageActive(name);
        await this.unload(name);
        return { wasActive };
      },
      afterSwap: async (name, metadata) => this.activateInstalledPackage(name, metadata),
      afterRollback: async (name, { wasActive } = {}) => {
        if (atom.packages.isPackageActive(name)) await atom.packages.deactivatePackage(name);
        if (atom.packages.isPackageLoaded(name)) atom.packages.unloadPackage(name);
        atom.packages.loadPackage(name);
        if (wasActive && !atom.packages.isPackageDisabled(name)) {
          atom.packages.activatePackage(name).catch(() => {});
        }
      },
    });
    const installed = await service.install(pack, options);
    return _.extend({}, pack, installed.metadata, {
      name: installed.packageName,
      installPath: installed.target,
      gitUrlInfo: pack.gitUrlInfo,
      apmInstallSource: installed.metadata.apmInstallSource,
    });
  }

  // Loads and (for a non-theme, non-disabled package) activates a freshly
  // installed package. Activation is fire-and-forget on purpose: a package that
  // defers activation (activationCommands/activationHooks) only resolves
  // activatePackage once its trigger fires, so awaiting it would hang the
  // install until then — leaving the swapped files unusable until a restart.
  activateInstalledPackage(name, metadata) {
    atom.packages.loadPackage(name);
    if (!metadata.theme && !atom.packages.isPackageDisabled(name)) {
      atom.packages.activatePackage(name).catch(() => {});
    }
  }

  getDevPackagesPath() {
    const configDirPath = atom.getConfigDirPath ? atom.getConfigDirPath() : process.env.LUMINE_HOME;
    return path.join(configDirPath, "dev", "packages");
  }

  // Buckets a single available package into dev/user/core/git on `packages`.
  // Shared by the synchronous getLocalPackages() and the chunked async
  // loadInstalledPackages() so both classify identically.
  classifyLocalPackage(packages, availablePackage, metadata, devPackagesPath) {
    metadata = metadata || {};
    const packageInfo = _.extend({}, metadata, {
      name: metadata.name || availablePackage.name,
      path: availablePackage.path,
    });
    if (metadata.apmInstallSource && metadata.apmInstallSource.type === "git") {
      const installedOrigin = packageOriginKey(metadata.apmInstallSource.origin);
      const manifestOrigin = packageOriginKey(metadata.repository);
      if (!installedOrigin || !manifestOrigin || installedOrigin !== manifestOrigin) {
        packageInfo.originWarning =
          "This legacy installation has a missing or mismatched repository origin. It remains active, but its next update must pass strict origin validation.";
      }
    }

    // Determine "bundled" from the package name rather than pack.isBundled.
    // The per-package flag is false for everything under packages/ when
    // running in dev mode from a source checkout, which would misfile every
    // bundled package as a community package. isBundledPackage() checks
    // packageDependencies membership and is mode-independent.
    const isBundled = atom.packages.isBundledPackage(availablePackage.name);

    // Record the install directory's own name so the UI can flag a package
    // whose folder does not match its package.json "name" — the folder IS the
    // install slot, so a mismatch breaks require, commands, config, and
    // activation. Bundled packages are curated and always match; skip them.
    if (!isBundled && availablePackage.path) {
      packageInfo.directoryName = path.basename(availablePackage.path);
    }

    // Order matters: a bundled package shadowed by a copy in dev/packages
    // must be filed under Development, so the dev-path check precedes the
    // bundled check.
    if (packageInfo.apmInstallSource && packageInfo.apmInstallSource.type === "git") {
      packages.git.push(packageInfo);
    } else if (availablePackage.path && availablePackage.path.startsWith(devPackagesPath)) {
      packages.dev.push(packageInfo);
    } else if (isBundled) {
      packages.core.push(packageInfo);
    } else {
      packages.user.push(packageInfo);
    }
  }

  // Adds a shadow entry for every bundled package that a same-named community
  // package is currently overriding, so the detail UI can still reach it.
  appendShadowedBundledDescriptors(packages) {
    if (typeof atom.packages.getBundledPackageDescriptors !== "function") return;
    const visibleNames = new Set(packages.core.map((pack) => pack.name));
    const communityNames = new Set(
      [...packages.dev, ...packages.user, ...packages.git].map((pack) => pack.name),
    );
    for (const descriptor of atom.packages.getBundledPackageDescriptors()) {
      if (!communityNames.has(descriptor.name) || visibleNames.has(descriptor.name)) continue;
      packages.core.push(
        _.extend({}, descriptor.metadata, descriptor, {
          isShadowed: true,
          packageKind: "builtin",
        }),
      );
      visibleNames.add(descriptor.name);
    }
  }

  getLocalPackages() {
    const packages = { dev: [], user: [], core: [], git: [] };
    const devPackagesPath = this.getDevPackagesPath();

    for (const pack of atom.packages.getAvailablePackages()) {
      const metadata = atom.packages.loadPackageMetadata(pack, true) || {};
      this.classifyLocalPackage(packages, pack, metadata, devPackagesPath);
    }

    this.appendShadowedBundledDescriptors(packages);
    return packages;
  }

  // Asynchronous, chunked twin of getLocalPackages(). Yields to the event loop
  // between batches so enumerating a large install set — each uncached
  // package.json is read synchronously by loadPackageMetadata — never blocks the
  // renderer long enough to drop frames or freeze input. Returns the same shape.
  async loadInstalledPackages() {
    const packages = { dev: [], user: [], core: [], git: [] };
    const devPackagesPath = this.getDevPackagesPath();
    const available = atom.packages.getAvailablePackages();
    const BATCH_SIZE = 20;

    for (let i = 0; i < available.length; i++) {
      const pack = available[i];
      const metadata = atom.packages.loadPackageMetadata(pack, true) || {};
      this.classifyLocalPackage(packages, pack, metadata, devPackagesPath);
      if ((i + 1) % BATCH_SIZE === 0 && i + 1 < available.length) {
        await new Promise((resolve) => setTimeout(resolve));
      }
    }

    this.appendShadowedBundledDescriptors(packages);
    return packages;
  }

  getAllLocalPackages() {
    const packages = this.getLocalPackages();
    return [].concat(packages.dev, packages.user, packages.core, packages.git);
  }

  findInstalledPackageByOrigin(originKey) {
    const normalizedOrigin = packageOriginKey(originKey);
    if (!normalizedOrigin) return null;

    const packages = this.getLocalPackages();
    return (
      [].concat(packages.dev, packages.user, packages.git).find((pack) => {
        return packageOrigin(pack) === normalizedOrigin;
      }) || null
    );
  }

  inspectPackageUpdate(pack, resolvedSha, selectedRef) {
    return this.getCatalogClient().inspectResolvedManifest(pack, resolvedSha, selectedRef);
  }

  async getGitPackageUpdates() {
    const updates = [];
    const gitPackages = this.getLocalPackages().git;

    for (const pack of gitPackages) {
      const source = pack.apmInstallSource && pack.apmInstallSource.source;
      const currentSha = pack.apmInstallSource && pack.apmInstallSource.sha;
      if (!source || !currentSha) {
        continue;
      }

      if (pack.apmInstallSource.updatePolicy === "pinned") {
        const selector = pack.apmInstallSource.selector;
        if (selector && selector.type === "tag") {
          try {
            const resolvedTag = await this.resolvePackageSource(source);
            if (resolvedTag.sha && resolvedTag.sha !== currentSha) {
              updates.push(
                _.extend({}, pack, {
                  suspiciousTagMove: { installedSha: currentSha, remoteSha: resolvedTag.sha },
                  originWarning: `Tag "${selector.value}" moved to a different commit. The installed commit remains pinned.`,
                }),
              );
            }
          } catch {
            // A failed audit of one pinned tag must not stop other receipts.
          }
        }
        continue;
      }

      try {
        const policy = pack.apmInstallSource.updatePolicy;
        // Default-branch and legacy receipts follow remote HEAD without ever
        // switching to a newly created release tag.
        const resolved =
          policy && policy !== "default-branch" ? await this.resolvePackageSource(source) : null;
        let latestSha;
        let latestVersion;
        if (resolved) {
          latestSha = resolved.sha;
          latestVersion = resolved.version;
        } else {
          const cloneUrl = this.getCloneUrl(source);
          const { stdout } = await this.runProcess(this.getGitCommand(), [
            "ls-remote",
            cloneUrl,
            "HEAD",
          ]);
          latestSha = stdout.trim().split(/\s+/)[0];
        }
        if (latestSha && latestSha !== currentSha) {
          const resolvedRef = resolved ? resolved.selector : pack.apmInstallSource.selector;
          const updateMetadata = await this.inspectPackageUpdate(pack, latestSha, resolvedRef);
          if (updateMetadata.name !== pack.name) {
            updates.push(
              _.extend({}, pack, {
                renamedPackage: {
                  from: pack.name,
                  to: updateMetadata.name,
                  sha: latestSha,
                },
                originWarning:
                  `Repository update changes the package name from "${pack.name}" to ` +
                  `"${updateMetadata.name}". This is not an update: uninstall ` +
                  `"${pack.name}" before installing "${updateMetadata.name}".`,
              }),
            );
            continue;
          }
          updates.push(
            _.extend({}, pack, {
              latestSha,
              latestVersion,
              resolvedRef,
            }),
          );
        }
      } catch {
        // A single unreachable repository must not prevent other update checks.
      }
    }

    return updates;
  }

  removePackageNameFromDisabledPackages(packageName) {
    return atom.config.removeAtKeyPath("core.disabledPackages", packageName);
  }

  // Emits the appropriate event for the given package.
  //
  // All events are either of the form `theme-foo` or `package-foo` depending on
  // whether the event is for a theme or a normal package. This method standardizes
  // the logic to determine if a package is a theme or not and formats the event
  // name appropriately.
  //
  // eventName - The event name suffix {String} of the event to emit.
  // pack - The package for which the event is being emitted.
  // error - Any error information to be included in the case of an error.
  emitPackageEvent(eventName, pack, error) {
    const theme =
      pack.theme != null ? pack.theme : pack.metadata != null ? pack.metadata.theme : undefined;
    eventName = theme ? `theme-${eventName}` : `package-${eventName}`;
    return this.emitter.emit(eventName, { pack, error, coordinate: packageCoordinate(pack) });
  }

  on(selectors, callback) {
    const subscriptions = new CompositeDisposable();
    for (let selector of Array.from(selectors.split(" "))) {
      subscriptions.add(this.emitter.on(selector, callback));
    }
    return subscriptions;
  }
};
