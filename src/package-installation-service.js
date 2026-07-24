"use strict";

const fs = require("fs");
const path = require("path");
const CSON = require("@lumine-code/season");
const semver = require("semver");
const {
  cloneUrlForRepository,
  formatPackageSource,
  normalizeRepositoryOrigin,
  parsePackageSource,
  sanitizePackageSource,
} = require("./package-source");
const { validateCommunityPackageMetadata } = require("./package-validation");

class PackageInstallationService {
  constructor({
    packagesDirectory,
    gitCommand,
    npmCommand,
    run,
    capture,
    resolveSource,
    atomVersion,
    beforeSwap = async () => ({}),
    afterSwap = async () => {},
    afterRollback = async () => {},
  }) {
    this.packagesDirectory = packagesDirectory;
    this.gitCommand = gitCommand;
    this.npmCommand = npmCommand;
    this.run = run;
    this.capture = capture || run;
    this.resolveSource = resolveSource;
    this.atomVersion = atomVersion;
    this.beforeSwap = beforeSwap;
    this.afterSwap = afterSwap;
    this.afterRollback = afterRollback;
  }

  async install(pack, { allowReplace = false } = {}) {
    const requestedSource =
      pack.installSource ||
      (pack.apmInstallSource && pack.apmInstallSource.source) ||
      pack.repository ||
      pack.name;
    const parsed = parsePackageSource(requestedSource);
    let resolved;
    if (pack.resolvedSha) {
      if (!/^[0-9a-f]{40}$/i.test(pack.resolvedSha)) {
        throw new Error("The package card does not contain a complete resolved commit SHA.");
      }
      const selector = pack.selectedRef || parsed.selector;
      resolved = {
        repository: parsed.repository,
        source: formatPackageSource(
          parsed.repository,
          selector && selector.type !== "default" ? selector : null,
        ),
        cloneUrl: cloneUrlForRepository(parsed.repository),
        selector,
        fetchRef: pack.resolvedSha,
        sha: pack.resolvedSha.toLowerCase(),
        version:
          selector && (selector.type === "tag" || selector.type === "latest")
            ? semver.valid(selector.value)
            : null,
        updatePolicy: pack.updatePolicy || "pinned",
      };
    } else {
      resolved = await this.resolveSource(requestedSource);
    }

    await fs.promises.mkdir(this.packagesDirectory, { recursive: true });
    const stage = await fs.promises.mkdtemp(path.join(this.packagesDirectory, ".lumine-stage-"));
    let backup = null;
    let target = null;
    let packageName = null;
    let lifecycleState = {};
    let lifecycleStarted = false;
    let swapped = false;

    try {
      await this.run(this.gitCommand, ["init"], { cwd: stage });
      await this.run(this.gitCommand, ["remote", "add", "origin", resolved.cloneUrl], {
        cwd: stage,
      });
      await this.run(this.gitCommand, ["fetch", "--depth", "1", "origin", resolved.fetchRef], {
        cwd: stage,
      });
      await this.run(this.gitCommand, ["checkout", "--detach", "FETCH_HEAD"], { cwd: stage });
      const captured = await this.capture(this.gitCommand, ["rev-parse", "HEAD"], { cwd: stage });
      const sha = String(captured && captured.stdout != null ? captured.stdout : captured)
        .trim()
        .toLowerCase();
      if (resolved.sha && sha !== resolved.sha.toLowerCase()) {
        throw new Error(
          `Repository ref changed while installing ${requestedSource}; please try again.`,
        );
      }

      const metadataPath = CSON.resolve(path.join(stage, "package"));
      if (!metadataPath) {
        throw new Error(
          "The repository does not contain a package.json, package.jsonc, or package.cson file.",
        );
      }
      const originKey = normalizeRepositoryOrigin(resolved.repository);
      const semanticTag =
        resolved.selector &&
        (resolved.selector.type === "tag" || resolved.selector.type === "latest")
          ? resolved.selector.value
          : null;
      const metadata = validateCommunityPackageMetadata(CSON.readFileSync(metadataPath), {
        originKey,
        semanticTag,
        atomVersion: this.atomVersion,
      });
      packageName = metadata.name;
      this.assertSlots(packageName, originKey, allowReplace);

      metadata.apmInstallSource = {
        type: "git",
        origin: originKey,
        source: sanitizePackageSource(resolved.source),
        repository: parsePackageSource(sanitizePackageSource(resolved.repository)).repository,
        selector: resolved.selector,
        updatePolicy: resolved.updatePolicy,
        version: resolved.version,
        sha,
      };

      // npm only understands package.json. For JSONC/CSON packages, expose a
      // temporary equivalent after validation, then retain the original
      // manifest format as the authoritative installed file.
      const npmMetadataPath = path.join(stage, "package.json");
      const temporaryNpmManifest = path.resolve(metadataPath) !== path.resolve(npmMetadataPath);
      if (temporaryNpmManifest) {
        fs.writeFileSync(npmMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      }
      try {
        // No package-controlled process executes before all validation above.
        await this.run(this.npmCommand, ["install", "--omit=dev", "--legacy-peer-deps"], {
          cwd: stage,
        });
      } finally {
        if (temporaryNpmManifest) await this.remove(npmMetadataPath);
      }
      this.writeMetadata(metadataPath, metadata);
      await this.remove(path.join(stage, ".git"));

      target = path.join(this.packagesDirectory, packageName);
      lifecycleStarted = true;
      lifecycleState = (await this.beforeSwap(packageName)) || {};
      if (fs.existsSync(target)) {
        backup = path.join(
          this.packagesDirectory,
          `.lumine-backup-${packageName}-${process.pid}-${Date.now()}`,
        );
        await fs.promises.rename(target, backup);
      }
      await fs.promises.rename(stage, target);
      swapped = true;
      await this.afterSwap(packageName, metadata, lifecycleState);
      if (backup) {
        const completedBackup = backup;
        backup = null;
        await this.remove(completedBackup).catch(() => {});
      }
      return { metadata, packageName, target, originKey, resolvedSha: sha };
    } catch (error) {
      if (swapped && target) await this.remove(target).catch(() => {});
      if (backup && target && fs.existsSync(backup)) {
        await fs.promises.rename(backup, target).catch(() => {});
      }
      if (packageName && lifecycleStarted) {
        await this.afterRollback(packageName, lifecycleState).catch(() => {});
      }
      throw error;
    } finally {
      await this.remove(stage).catch(() => {});
      if (backup) await this.remove(backup).catch(() => {});
    }
  }

  assertSlots(packageName, candidateOrigin, allowReplace) {
    if (!fs.existsSync(this.packagesDirectory)) return;
    for (const entry of fs.readdirSync(this.packagesDirectory, { withFileTypes: true })) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".lumine-")) {
        continue;
      }
      const metadataPath = CSON.resolve(path.join(this.packagesDirectory, entry.name, "package"));
      if (!metadataPath) continue;
      let metadata;
      try {
        metadata = CSON.readFileSync(metadataPath);
      } catch {
        continue;
      }
      const installedOrigin = normalizeRepositoryOrigin(
        metadata.apmInstallSource && metadata.apmInstallSource.origin
          ? metadata.apmInstallSource.origin
          : metadata.repository,
      );
      if (installedOrigin === candidateOrigin && entry.name !== packageName) {
        throw new Error(
          `This repository is already installed in slot "${entry.name}". Remove it before installing a ref named "${packageName}".`,
        );
      }
      if (entry.name === packageName && installedOrigin !== candidateOrigin && !allowReplace) {
        throw new Error(
          `A different community package already occupies slot "${packageName}". Use Replace to continue.`,
        );
      }
    }
  }

  writeMetadata(metadataPath, metadata) {
    if (path.extname(metadataPath) === ".json") {
      fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    } else {
      CSON.writeFileSync(metadataPath, metadata);
    }
  }

  remove(target) {
    return fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

module.exports = PackageInstallationService;
