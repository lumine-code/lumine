const _ = require("@lumine-code/underscore-plus");
const { BufferedProcess, CompositeDisposable, Emitter } = require("atom");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const semver = require("semver");
const requireCore = require("./require-core");
const { cloneUrlForRepository, parsePackageSource, resolvePackageSource } =
  requireCore("package-source");
const PackageInstallationService = requireCore("package-installation-service");

const { packageCoordinate, packageOrigin, packageOriginKey } = require("./utils");

// The HTTP clients pull in `request` (~120ms to require), which dominates
// package activation. They are only needed when the user opens the Install or
// Updates tabs, so require them lazily inside their getters instead of eagerly.

// Whether a package tree carries a compiled native module. Once one of those is
// loaded, the process holds it until it exits, so the files underneath it can
// be replaced but the code cannot.
function containsNativeModule(packagePath) {
  const nodeModulesPath = path.join(packagePath, "node_modules");
  if (!fs.isDirectorySync(nodeModulesPath)) return false;
  const stack = [nodeModulesPath];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(directory, entry.name));
      } else if (entry.name.endsWith(".node")) {
        return true;
      }
    }
  }
  return false;
}

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

  getAvatarCache() {
    if (this.avatarCache != null) return this.avatarCache;
    const AvatarCache = require("./avatar-cache");
    return (this.avatarCache = new AvatarCache(this));
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
    // Answer for the copy that owns the name, the one whose settings, commands,
    // and version the rest of the UI is talking about.
    const candidates = this.getAllLocalPackages().filter((pack) => pack.name === packageName);
    const pack = candidates.find((candidate) => !candidate.isShadowed) || candidates[0];
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
    // A manifest that declares no engines.lumine range is incompatible: the
    // key is what marks a Lumine package, and install validation rejects a
    // manifest without it, so the card must not offer an install that would
    // only fail there.
    const engine = metadata.engines != null ? metadata.engines.lumine : undefined;
    if (typeof engine !== "string" || !semver.validRange(engine)) {
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
      // The directory this card stands for, never a directory derived from the
      // package's name: a name can be provided by more than one directory, and
      // uninstalling one of them must not touch the others. The path is used
      // as recorded — resolving it would canonicalize a symlink and delete a
      // linked package's source instead of the link.
      const packagePath = this.installedPackagePath(pack);
      if (!packagePath) {
        throw new Error(`Could not find where “${name}” is installed.`);
      }

      // Only the copy that actually loaded owns the loaded package for this
      // name; a shadowed copy is removed from disk and nothing else.
      const loadedPackage = atom.packages.getLoadedPackage(name);
      const removingLoadedPackage = loadedPackage != null && loadedPackage.path === packagePath;
      if (removingLoadedPackage) {
        if (atom.packages.isPackageActive(name)) {
          // Await async deactivation before unloading (see ::unload).
          await atom.packages.deactivatePackage(name);
        }
        atom.packages.unloadPackage(name);
      }

      if (fs.isDirectorySync(packagePath) || fs.isSymbolicLinkSync(packagePath)) {
        await this.removePackageDir(packagePath);
      }
      this.clearOutdatedCache();
      atom.packages.refreshPackageIndex();

      // Another directory may still provide this name — a bundled package that
      // was overridden, a dev checkout, a second copy. Its disabled preference
      // belongs to the name, so it survives as long as any copy does.
      const remainingCopy = atom.packages.getAvailablePackage(name);
      if (remainingCopy == null) {
        this.removePackageNameFromDisabledPackages(name);
      }

      // Signal completion as soon as the package is gone from disk. Loading
      // whichever copy takes over is best-effort and runs afterwards, so a
      // slow, deferred, or failing activation can never hang or fail an
      // uninstall that already succeeded (and left the UI spinner stuck until
      // a restart).
      if (typeof callback === "function") {
        callback();
      }
      const result = this.emitPackageEvent("uninstalled", pack);

      if (removingLoadedPackage && remainingCopy != null) {
        // Activation is fire-and-forget because a package that defers
        // activation only resolves activatePackage once its trigger fires.
        atom.packages.reconcilePackage(name, { activate: true }).catch(() => {
          // The remaining copy will load on the next restart.
        });
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

  // The directory a package occupies. A list entry knows its own directory —
  // one entry is one directory — while a catalog card knows only a name, which
  // resolves to whichever copy owns it.
  installedPackagePath(pack) {
    if (pack && pack.path) return pack.path;
    const name = pack && pack.name;
    if (!name) return null;
    const loadedPackage = atom.packages.getLoadedPackage(name);
    if (loadedPackage) return loadedPackage.path;
    return atom.packages.resolvePackagePath(name);
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
  // Removing a linked package removes the link, never the working copy it
  // points at — see PackageInstallationService.removePath.
  removePackageDir(dirPath) {
    return PackageInstallationService.removePath(dirPath);
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
      beforeSwap: async (name, target) => {
        const loadedPackage = atom.packages.getLoadedPackage(name);
        // Only the copy being replaced is unloaded. When the install lands in
        // a different directory than the one that loaded — a second copy of
        // the name — the running package is left alone.
        if (loadedPackage == null || loadedPackage.path !== target) return { replaced: false };
        const wasActive = atom.packages.isPackageActive(name);
        const hadNativeModules = containsNativeModule(target);
        await this.unload(name);
        return { replaced: true, wasActive, hadNativeModules };
      },
      afterSwap: async (name, metadata, state = {}) => {
        // Native modules stay loaded in the process for as long as it lives:
        // the old binding cannot be unmapped, so the new files would run
        // against it. Leave the swapped package for the next launch, which the
        // card's "Restart" prompt asks for.
        if (state.hadNativeModules) return;
        this.activateInstalledPackage(name, metadata);
      },
      afterRollback: async (name, { replaced, wasActive } = {}) => {
        if (!replaced) return;
        if (atom.packages.isPackageActive(name)) await atom.packages.deactivatePackage(name);
        if (atom.packages.isPackageLoaded(name)) atom.packages.unloadPackage(name);
        atom.packages.reconcilePackage(name, { activate: wasActive }).catch(() => {});
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
    atom.packages.refreshPackageIndex();
    atom.packages.loadPackage(name);
    if (!metadata.theme && !atom.packages.isPackageDisabled(name)) {
      atom.packages.activatePackage(name).catch(() => {});
    }
  }

  getDevPackagesPath() {
    const configDirPath = atom.getConfigDirPath ? atom.getConfigDirPath() : process.env.LUMINE_HOME;
    return path.join(configDirPath, "packages-dev");
  }

  // Buckets a single available package into dev/user/core/git on `packages`.
  // Shared by the synchronous getLocalPackages() and the chunked async
  // loadInstalledPackages() so both classify identically.
  //
  // One directory produces one entry. Several directories may provide the same
  // package name; only the first of them loads, and the rest are listed as
  // shadowed so the user can see what is on disk and act on it.
  classifyLocalPackage(packages, availablePackage, metadata) {
    metadata = metadata || availablePackage.metadata || {};
    const packageInfo = _.extend({}, metadata, {
      name: availablePackage.name,
      path: availablePackage.path,
      directoryName: availablePackage.dirname || path.basename(availablePackage.path || ""),
      tier: availablePackage.tier,
      nameSource: availablePackage.nameSource,
      // False for a bundled package while the editor runs from a source
      // checkout: it ships with Lumine, but the files being loaded are the
      // ones in the checkout.
      isBundled: availablePackage.isBundled,
      isShadowed: availablePackage.isWinner === false,
      shadowedBy: availablePackage.shadowedBy,
    });
    if (metadata.apmInstallSource && metadata.apmInstallSource.type === "git") {
      const installedOrigin = packageOriginKey(metadata.apmInstallSource.origin);
      const manifestOrigin = packageOriginKey(metadata.repository);
      if (!installedOrigin || !manifestOrigin || installedOrigin !== manifestOrigin) {
        packageInfo.originWarning =
          "This legacy installation has a missing or mismatched repository origin. It remains active, but its next update must pass strict origin validation.";
      }
    }

    // The tier a package's directory sits in decides where it is listed, and it
    // is what the loader ranks names by, so the two never disagree. A package
    // delivered through node_modules reports the bundled tier as well.
    const tier = availablePackage.tier;
    if (tier === "bundled") {
      packageInfo.packageKind = "builtin";
      packages.core.push(packageInfo);
    } else if (tier === "dev") {
      packages.dev.push(packageInfo);
    } else if (packageInfo.apmInstallSource && packageInfo.apmInstallSource.type === "git") {
      packages.git.push(packageInfo);
    } else {
      packages.user.push(packageInfo);
    }
  }

  getLocalPackages() {
    const packages = { dev: [], user: [], core: [], git: [] };

    for (const pack of atom.packages.getAvailablePackages({ includeShadowed: true })) {
      this.classifyLocalPackage(packages, pack, pack.metadata);
    }

    return packages;
  }

  // Asynchronous, chunked twin of getLocalPackages(). Yields to the event loop
  // between batches so enumerating a large install set — each uncached
  // package.json is read synchronously by loadPackageMetadata — never blocks the
  // renderer long enough to drop frames or freeze input. Returns the same shape.
  async loadInstalledPackages() {
    const packages = { dev: [], user: [], core: [], git: [] };
    const available = atom.packages.getAvailablePackages({ includeShadowed: true });
    const BATCH_SIZE = 20;

    for (let i = 0; i < available.length; i++) {
      const pack = available[i];
      this.classifyLocalPackage(packages, pack, pack.metadata);
      if ((i + 1) % BATCH_SIZE === 0 && i + 1 < available.length) {
        await new Promise((resolve) => setTimeout(resolve));
      }
    }

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
    const candidates = [].concat(packages.dev, packages.user, packages.git).filter((pack) => {
      return packageOrigin(pack) === normalizedOrigin;
    });
    // A repository installed into more than one directory is answered for by
    // the copy that loads.
    return candidates.find((pack) => !pack.isShadowed) || candidates[0] || null;
  }

  inspectPackageUpdate(pack, resolvedSha, selectedRef) {
    return this.getCatalogClient().inspectResolvedManifest(pack, resolvedSha, selectedRef);
  }

  async getGitPackageUpdates() {
    const updates = [];
    // Only the copy that owns a name can be updated in place: an update swaps
    // the directory the package loads from, and a shadowed copy loads from
    // nowhere. Checking one anyway would poll a remote for a package the user
    // is not running.
    const gitPackages = this.getLocalPackages().git.filter((pack) => !pack.isShadowed);

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
