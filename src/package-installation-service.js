"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const CSON = require("@lumine-code/season");
const semver = require("semver");
const tar = require("tar");
const {
  cloneUrlForRepository,
  formatPackageSource,
  normalizeRepositoryOrigin,
  parsePackageSource,
  sanitizePackageSource,
} = require("./package-source");
const { validateCommunityPackageMetadata } = require("./package-validation");

// The manifest forms the editor loads, most preferred first.
const MANIFEST_FILENAMES = ["package.json", "package.jsonc"];

function resolveManifestPath(directory) {
  for (const filename of MANIFEST_FILENAMES) {
    const candidate = path.join(directory, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

class PackageInstallationService {
  constructor({
    packagesDirectory,
    gitCommand,
    npmCommand,
    run,
    capture,
    resolveSource,
    atomVersion,
    fetchUrl = (url) => fetch(url, { redirect: "follow" }),
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
    this.fetchUrl = fetchUrl;
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
      const sha = await this.fetchPackageFiles(stage, resolved, requestedSource);

      const metadataPath = resolveManifestPath(stage);
      if (!metadataPath) {
        throw new Error("The repository does not contain a package.json or package.jsonc file.");
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
      const existingDirectory = this.assertSlots(packageName, originKey, allowReplace);

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

      // npm only understands package.json. For a JSONC manifest, expose a
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

      // Reinstalling or updating replaces the directory the package already
      // occupies, whatever it is called. Only a package that is not installed
      // yet gets a new directory, and that one is named after it.
      target = existingDirectory || path.join(this.packagesDirectory, packageName);
      lifecycleStarted = true;
      lifecycleState = (await this.beforeSwap(packageName, target)) || {};
      if (fs.existsSync(target)) {
        backup = path.join(
          this.packagesDirectory,
          `.lumine-backup-${packageName}-${process.pid}-${Date.now()}`,
        );
        await fs.promises.rename(target, backup);
      }
      await fs.promises.rename(stage, target);
      swapped = true;
      await this.afterSwap(packageName, metadata, lifecycleState, target);
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

  // Decide whether this install may proceed, and where it should land.
  //
  // A package is identified by the `name` in its manifest, so that is what the
  // installed directories are compared by — not what they happen to be called.
  //
  // Returns the directory of an installed copy of this package, which the
  // install replaces, or null when nothing is installed under this name.
  assertSlots(packageName, candidateOrigin, allowReplace) {
    if (!fs.existsSync(this.packagesDirectory)) return null;

    let existingDirectory = null;
    for (const entry of fs.readdirSync(this.packagesDirectory, { withFileTypes: true })) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".lumine-")) {
        continue;
      }
      const packagePath = path.join(this.packagesDirectory, entry.name);
      const metadataPath = resolveManifestPath(packagePath);
      if (!metadataPath) continue;
      let metadata;
      try {
        metadata = CSON.readFileSync(metadataPath);
      } catch {
        continue;
      }
      const installedName = metadata.name || entry.name;
      const installedOrigin = normalizeRepositoryOrigin(
        metadata.apmInstallSource && metadata.apmInstallSource.origin
          ? metadata.apmInstallSource.origin
          : metadata.repository,
      );

      if (installedOrigin === candidateOrigin && installedName !== packageName) {
        throw new Error(
          `This repository is already installed as "${installedName}" in ${entry.name}. Remove it before installing a ref named "${packageName}".`,
        );
      }
      if (installedName !== packageName) continue;

      if (installedOrigin !== candidateOrigin && !allowReplace) {
        throw new Error(
          `A different package named "${packageName}" is already installed in ${entry.name}. Use Replace to continue.`,
        );
      }
      // A directory named after the package wins over any other copy, so an
      // install replaces that one and leaves duplicates alone.
      if (existingDirectory == null || entry.name === packageName) {
        existingDirectory = packagePath;
      }
    }

    return existingDirectory;
  }

  // Fetch the package's files into `stage` and return the commit they are from.
  //
  // GitHub serves a commit's tree as a tarball, which needs no git binary and
  // no repository history. Everything else — and any ref that has not been
  // resolved to a commit — goes through a shallow fetch.
  async fetchPackageFiles(stage, resolved, requestedSource) {
    const tarballUrl = this.tarballUrl(resolved);
    if (tarballUrl) {
      await this.fetchTarball(tarballUrl, stage, resolved, requestedSource);
      return resolved.sha.toLowerCase();
    }

    await this.run(this.gitCommand, ["init"], { cwd: stage });
    await this.run(this.gitCommand, ["remote", "add", "origin", resolved.cloneUrl], { cwd: stage });
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
    await this.remove(path.join(stage, ".git"));
    return sha;
  }

  // The tarball address of a resolved commit, or null when the source cannot
  // be fetched that way. The commit — never the tag or branch that led to it —
  // addresses the archive, so a ref that moves mid-install cannot substitute
  // different code for the one that was resolved and shown to the user.
  tarballUrl(resolved) {
    if (!resolved.sha || !/^[0-9a-f]{40}$/i.test(resolved.sha)) return null;

    const origin = normalizeRepositoryOrigin(resolved.repository);
    const match = origin.match(/^github\.com\/([^/]+)\/([^/]+)$/);
    if (!match) return null;

    return `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${resolved.sha.toLowerCase()}`;
  }

  async fetchTarball(url, stage, resolved, requestedSource) {
    const archivePath = path.join(stage, ".lumine-archive.tar.gz");
    let response;
    try {
      response = await this.fetchUrl(url);
    } catch (error) {
      throw new Error(`Could not download ${requestedSource}: ${error.message}`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(
        `Could not download ${requestedSource}: the server answered ${response.status}.`,
      );
    }

    await fs.promises.writeFile(archivePath, Buffer.from(await response.arrayBuffer()));

    const archivedSha = await readArchivedCommit(archivePath);
    if (archivedSha && archivedSha !== resolved.sha.toLowerCase()) {
      throw new Error(
        `Repository ref changed while installing ${requestedSource}; please try again.`,
      );
    }

    // GitHub wraps the tree in a single directory named after the repository
    // and the ref, which is stripped; the archive holds no history to remove.
    await tar.x({
      file: archivePath,
      cwd: stage,
      strip: 1,
      // A package that ships a symlink still installs on a Windows without
      // developer mode, minus the link.
      onwarn: () => {},
    });
    await this.remove(archivePath);
  }

  // Delete the staging and backup directories an interrupted install left
  // behind. A backup holding a native module cannot be deleted while the
  // process that loaded it runs, so the sweep belongs at startup, before
  // anything has been loaded.
  static async sweep(packagesDirectory) {
    let entries;
    try {
      entries = await fs.promises.readdir(packagesDirectory, { withFileTypes: true });
    } catch {
      return [];
    }

    const swept = [];
    for (const entry of entries) {
      if (!/^\.lumine-(stage|backup)-/.test(entry.name)) continue;
      const target = path.join(packagesDirectory, entry.name);
      try {
        await PackageInstallationService.removePath(target);
        swept.push(target);
      } catch {
        // Still locked, or gone already. The next launch tries again.
      }
    }
    return swept;
  }

  // Written as JSON whichever of the two forms the manifest arrived in: JSONC
  // is JSON plus comments, and the install source's comments do not survive
  // the parse that produced this object anyway.
  writeMetadata(metadataPath, metadata) {
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }

  remove(target) {
    return PackageInstallationService.removePath(target);
  }

  // Delete a package directory, a file, or a link to one.
  //
  // A linked package is an entry pointing at a working copy somewhere else, and
  // that working copy is the user's. Removing the entry must remove the link
  // and never look through it, so a link is unlinked outright — a recursive
  // removal is only ever handed a real directory.
  static async removePath(target) {
    let stats;
    try {
      stats = await fs.promises.lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    if (stats.isSymbolicLink()) {
      try {
        await fs.promises.unlink(target);
      } catch (error) {
        // Windows refuses `unlink` on some directory reparse points; removing
        // the reparse point as a directory leaves what it points at alone.
        if (error.code !== "EPERM" && error.code !== "EISDIR") throw error;
        await fs.promises.rmdir(target);
      }
      return;
    }

    await fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

// The commit a GitHub archive was made from, which the archive states in its
// pax global header, or null when it does not say. Reading the first blocks is
// enough: the global header is the archive's first entry.
async function readArchivedCommit(archivePath) {
  let head;
  try {
    head = await readGunzipPrefix(archivePath, 4096);
  } catch {
    return null;
  }
  if (head.length < 512) return null;

  const TYPE_FLAG_OFFSET = 156;
  const SIZE_OFFSET = 124;
  const BLOCK_SIZE = 512;
  if (String.fromCharCode(head[TYPE_FLAG_OFFSET]) !== "g") return null;

  const size = parseInt(
    head
      .toString("ascii", SIZE_OFFSET, SIZE_OFFSET + 12)
      .replace(/\0.*$/, "")
      .trim(),
    8,
  );
  if (!Number.isFinite(size) || size <= 0) return null;

  const payload = head.toString("utf8", BLOCK_SIZE, BLOCK_SIZE + size);
  const match = payload.match(/\bcomment=([0-9a-f]{40})\b/i);
  return match ? match[1].toLowerCase() : null;
}

// The first `byteCount` decompressed bytes of a gzip file.
function readGunzipPrefix(filePath, byteCount) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const source = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    const finish = (error) => {
      source.destroy();
      gunzip.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, Math.min(total, byteCount)));
    };
    gunzip.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= byteCount) finish();
    });
    gunzip.on("end", () => finish());
    gunzip.on("error", finish);
    source.on("error", finish);
    source.pipe(gunzip);
  });
}

module.exports = PackageInstallationService;
