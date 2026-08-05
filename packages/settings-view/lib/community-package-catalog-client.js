const fs = require("fs");
const dns = require("dns");
const os = require("os");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");
const CSON = require("@lumine-code/season");
const requireCore = require("./require-core");

const {
  assertSafeCatalogPackageSource,
  cloneUrlForRepository,
  listPackageRepositoryRefs,
  isPrivateAddress,
  normalizeRepositoryOrigin,
  parsePackageSource,
  resolvePackageSource,
} = requireCore("package-source");
const { validateCommunityPackageMetadata } = requireCore("package-validation");

const CACHE_SCHEMA_VERSION = 2;
const MAX_REPOSITORIES = 2000;
const GIT_CONCURRENCY = 8;
const HTTP_CONCURRENCY = 16;
const PER_HOST_CONCURRENCY = 4;
const REQUEST_TIMEOUT = 15000;
const GIT_REF_TIMEOUT = 30000;
const GIT_FETCH_TIMEOUT = 60000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_README_BYTES = 2 * 1024 * 1024;
const README_CACHE_ENTRIES = 50;
// GitHub raw paths are case-sensitive, so try the common casings/extensions.
const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.markdown",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "COPYING",
  "COPYING.md",
  "UNLICENSE",
];
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|unlicense)(?:\.|$)/i;

class TaskQueue {
  constructor(limit, perKeyLimit = limit) {
    this.limit = limit;
    this.perKeyLimit = perKeyLimit;
    this.active = 0;
    this.activeByKey = new Map();
    this.pending = [];
  }

  add(task, key = "default", signal = null) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, key, signal, resolve, reject });
      this.drain();
    });
  }

  drain() {
    if (this.active >= this.limit) return;
    const index = this.pending.findIndex(
      ({ key }) => (this.activeByKey.get(key) || 0) < this.perKeyLimit,
    );
    if (index === -1) return;
    const item = this.pending.splice(index, 1)[0];
    if (item.signal && item.signal.aborted) {
      item.reject(abortError());
      this.drain();
      return;
    }
    this.active++;
    this.activeByKey.set(item.key, (this.activeByKey.get(item.key) || 0) + 1);
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active--;
        const activeForKey = (this.activeByKey.get(item.key) || 1) - 1;
        if (activeForKey) this.activeByKey.set(item.key, activeForKey);
        else this.activeByKey.delete(item.key);
        this.drain();
      });
    this.drain();
  }
}

function abortError() {
  const error = new Error("Catalog Fetch was cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeCatalogSource(source) {
  const value = String(source || "")
    .trim()
    .replace(/\/+$/, "");
  if (!value) throw new Error("Enter a catalog repository or index.json URL.");

  if (/^file:\/\//i.test(value)) {
    const filePath = fileURLToPath(value);
    return pathToFileURL(filePath.endsWith(".json") ? filePath : path.join(filePath, "index.json"))
      .href;
  }
  if (path.isAbsolute(value)) {
    const filePath = value.endsWith(".json") ? value : path.join(value, "index.json");
    return pathToFileURL(filePath).href;
  }

  const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (
    shorthand &&
    shorthand[1] !== "." &&
    shorthand[1] !== ".." &&
    shorthand[2] !== "." &&
    shorthand[2] !== ".."
  ) {
    return `https://raw.githubusercontent.com/${shorthand[1]}/${shorthand[2]}/main/index.json`;
  }
  const github = value.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (github) {
    return `https://raw.githubusercontent.com/${github[1]}/${github[2]}/main/index.json`;
  }
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error("Catalog URLs must not contain credentials.");
    return value.endsWith(".json") ? value : `${value}/index.json`;
  }
  throw new Error("Catalog sources must be owner/repo, a public HTTPS URL, or a local file.");
}

function defaultCachePath() {
  try {
    const remote = require("@electron/remote");
    return path.join(remote.app.getPath("userData"), "Cache", "settings-view");
  } catch {
    return path.join(process.env.LUMINE_HOME || os.tmpdir(), "Cache", "settings-view");
  }
}

function hostForRepository(repository) {
  const originKey = normalizeRepositoryOrigin(repository);
  return originKey.split("/")[0] || "unknown";
}

function hostnameWithoutPort(host) {
  const bracketed = String(host).match(/^\[([^\]]+)\](?::\d+)?$/);
  return bracketed ? bracketed[1] : String(host).replace(/:\d+$/, "");
}

function selectedRefFromIndex(record, index) {
  const requested = parsePackageSource(record.installSource).selector;
  if (requested.type === "latest") {
    if (index.latestStable) {
      return {
        selector: { type: "latest", value: index.latestStable.name },
        resolvedSha: index.latestStable.sha,
        semanticTag: index.latestStable.name,
        updatePolicy: "latest-tag",
      };
    }
    if (!index.headSha) throw new Error("Repository does not expose HEAD or a stable tag.");
    return {
      selector: { type: "default", value: index.defaultBranch || "HEAD" },
      resolvedSha: index.headSha,
      semanticTag: null,
      updatePolicy: "default-branch",
    };
  }
  if (requested.type === "tag") {
    const names = requested.value.startsWith("v")
      ? [requested.value]
      : [requested.value, `v${requested.value}`];
    const tag = index.tags.find((candidate) => names.includes(candidate.name));
    if (!tag) throw new Error(`Tag "${requested.value}" was not found.`);
    return {
      selector: { type: "tag", value: tag.name },
      resolvedSha: tag.sha,
      semanticTag: tag.name,
      updatePolicy: "pinned",
    };
  }
  if (requested.type === "commit" && /^[0-9a-f]{40}$/i.test(requested.value)) {
    return {
      selector: requested,
      resolvedSha: requested.value.toLowerCase(),
      semanticTag: null,
      updatePolicy: "pinned",
    };
  }
  return null;
}

module.exports = class CommunityPackageCatalogClient {
  constructor({
    fetchImpl = (...args) => fetch(...args),
    packageManager = null,
    storage = null,
    cachePath = null,
    now = Date.now,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    atomVersion = () => (global.atom && atom.getVersion ? atom.getVersion() : null),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.packageManager = packageManager;
    this.storage = storage;
    this.cachePath = cachePath || defaultCachePath();
    this.now = now;
    this.delay = delay;
    this.atomVersion = atomVersion;
    this.gitQueue = new TaskQueue(GIT_CONCURRENCY, PER_HOST_CONCURRENCY);
    this.httpQueue = new TaskQueue(HTTP_CONCURRENCY, PER_HOST_CONCURRENCY);
    this.dnsChecks = new Map();
  }

  async load(source, options = {}) {
    const result = await this.loadAll([source], options);
    return { schemaVersion: CACHE_SCHEMA_VERSION, packages: result.packages };
  }

  async loadAll(catalogSources, { refresh = false, cacheOnly = false, onProgress, onRecord } = {}) {
    const normalizedSources = catalogSources.map(normalizeCatalogSource);
    const cached = this.readCache();
    const cachedPackages = this.packagesForSources(cached, normalizedSources);
    const cachedSources = new Set((cached && cached.catalogSources) || []);
    const pendingSources = normalizedSources.filter((source) => !cachedSources.has(source));
    if (cacheOnly || (!refresh && cachedPackages.length)) {
      return {
        schemaVersion: CACHE_SCHEMA_VERSION,
        packages: cachedPackages,
        lastFetch: cached && cached.lastFetch,
        cached: true,
        pendingSources,
      };
    }

    this.cancel();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const catalogResults = await Promise.all(
      normalizedSources.map(async (url, index) => {
        try {
          const sources = await this.fetchCatalog(url, signal);
          return { url, configuredSource: catalogSources[index], sources };
        } catch (error) {
          return { url, configuredSource: catalogSources[index], error };
        }
      }),
    );

    const records = this.mergeCatalogs(catalogResults, cached);
    if (records.length > MAX_REPOSITORIES) {
      throw new Error(
        `Community catalogs contain ${records.length} unique repositories; the safety limit is ${MAX_REPOSITORIES}.`,
      );
    }

    const nextCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastFetch: this.now(),
      catalogSources: normalizedSources,
      manifests: cached && cached.manifests ? cached.manifests : {},
      readmes: cached && cached.readmes ? cached.readmes : {},
      packages: {},
      catalogErrors: catalogResults
        .filter((result) => result.error && result.error.name !== "AbortError")
        .map((result) => ({ source: result.configuredSource, message: result.error.message })),
    };
    let processed = 0;
    let errors = 0;
    const report = () => {
      if (onProgress) onProgress({ processed, total: records.length, errors });
    };
    report();

    await Promise.all(
      records.map(async (record) => {
        if (signal.aborted) return;
        let hydrated;
        try {
          hydrated = await this.hydrate(record, nextCache.manifests, signal);
        } catch (error) {
          if (signal.aborted || error.name === "AbortError") return;
          errors++;
          const previous = cached && cached.packages && cached.packages[record.originKey];
          hydrated = previous
            ? { ...previous, ...record, status: "stale", error: error.message }
            : {
                ...record,
                name: record.originKey.split("/").pop() || record.originKey,
                unverifiedName: true,
                status: "error",
                error: error.message,
              };
        }
        nextCache.packages[record.originKey] = hydrated;
        processed++;
        if (onRecord) onRecord(hydrated, { processed, total: records.length, errors });
        report();
      }),
    );

    if (!signal.aborted) {
      this.writeCache(nextCache);
    } else {
      // Preserve every previous record from the still-configured catalogs and
      // overlay only repositories that completed hydration. This keeps a
      // cancelled refresh coherent instead of truncating the on-disk index.
      const completed = nextCache.packages;
      nextCache.packages = Object.fromEntries(cachedPackages.map((pack) => [pack.originKey, pack]));
      Object.assign(nextCache.packages, completed);
      if (cached && cached.lastFetch) nextCache.lastFetch = cached.lastFetch;
      nextCache.cancelled = true;
      this.writeCache(nextCache);
    }
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      packages: Object.values(nextCache.packages),
      lastFetch: nextCache.lastFetch,
      errors: nextCache.catalogErrors,
      cancelled: signal.aborted,
    };
  }

  cancel() {
    if (this.controller) this.controller.abort();
    this.controller = null;
  }

  validate(value, source = null) {
    if (!Array.isArray(value)) {
      if (value && value.schemaVersion === 1 && Array.isArray(value.packages)) {
        throw new Error(
          "The old metadata catalog format is not supported; index.json must be a JSON array of Git sources.",
        );
      }
      throw new Error("Community package catalog must be a JSON array of Git sources.");
    }
    return value.map((entry, index) => {
      if (typeof entry !== "string") {
        throw new Error(
          `Community package catalog entry ${index + 1} must be a Git source string.`,
        );
      }
      const parsed = assertSafeCatalogPackageSource(entry);
      if (parsed.selector.type === "commit" && !/^[0-9a-f]{40}$/i.test(parsed.selector.value)) {
        throw new Error(
          `Community package catalog entry ${index + 1} must use a complete 40-character commit SHA.`,
        );
      }
      return {
        source: parsed.source,
        repository: parsed.repository,
        originKey: parsed.originKey,
        selector: parsed.selector,
        catalogSource: source,
      };
    });
  }

  async fetchCatalog(url, signal) {
    if (url.startsWith("file://")) {
      const body = await fs.promises.readFile(fileURLToPath(url), "utf8");
      if (Buffer.byteLength(body) > MAX_CATALOG_BYTES) throw new Error("Catalog is too large.");
      return this.validate(JSON.parse(body), url);
    }
    await this.assertPublicHostname(new URL(url).hostname);
    const host = new URL(url).hostname;
    const body = await this.httpQueue.add(
      () => this.requestText(url, { signal, maxBytes: MAX_CATALOG_BYTES }),
      host,
      signal,
    );
    return this.validate(JSON.parse(body), url);
  }

  mergeCatalogs(results, cached) {
    const byOrigin = new Map();
    for (const result of results) {
      const entries = result.error
        ? this.cachedEntriesForCatalog(cached, result.url)
        : result.sources;
      for (const entry of entries) {
        const existing = byOrigin.get(entry.originKey);
        if (!existing) {
          byOrigin.set(entry.originKey, {
            originKey: entry.originKey,
            repository: entry.repository,
            installSource: entry.source || entry.installSource,
            catalogSources: [result.url],
            catalogSelectors: [{ catalogSource: result.url, selector: entry.selector }],
            status: "pending",
            catalogError: result.error ? result.error.message : null,
          });
        } else {
          if (!result.error) existing.catalogError = null;
          if (!existing.catalogSources.includes(result.url))
            existing.catalogSources.push(result.url);
          existing.catalogSelectors.push({ catalogSource: result.url, selector: entry.selector });
          existing.selectorConflict = existing.catalogSelectors.some(
            ({ selector }) =>
              selector.type !== existing.catalogSelectors[0].selector.type ||
              selector.value !== existing.catalogSelectors[0].selector.value,
          );
        }
      }
    }
    return Array.from(byOrigin.values());
  }

  cachedEntriesForCatalog(cache, catalogSource) {
    if (!cache || !cache.packages) return [];
    return Object.values(cache.packages)
      .filter((pack) => (pack.catalogSources || []).includes(catalogSource))
      .map((pack) => ({
        ...pack,
        source: pack.installSource,
        selector: parsePackageSource(pack.installSource).selector,
      }));
  }

  async hydrate(record, manifests, signal) {
    const host = hostForRepository(record.repository);
    const index = await this.gitQueue.add(
      async () => {
        if (!record.manualSource) await this.assertPublicHostname(hostnameWithoutPort(host));
        return this.listRefs(record.installSource, false);
      },
      host,
      signal,
    );
    let selected = selectedRefFromIndex(record, index);
    if (!selected) {
      const resolved = await this.gitQueue.add(
        () => this.resolveSource(record.installSource),
        host,
        signal,
      );
      if (!resolved.sha) {
        throw new Error("The selected ref could not be resolved to a complete commit SHA.");
      }
      selected = {
        selector: resolved.selector,
        resolvedSha: resolved.sha,
        semanticTag: resolved.selector.type === "tag" ? resolved.selector.value : null,
        updatePolicy: resolved.updatePolicy,
      };
    }
    const cacheKey = `${record.originKey}@${selected.resolvedSha}`;
    let metadata = manifests[cacheKey];
    if (!metadata) {
      metadata = await this.fetchManifest(record, selected.resolvedSha, signal);
      manifests[cacheKey] = metadata;
    }
    const currentAtomVersion = this.atomVersion();
    const pack = validateCommunityPackageMetadata(metadata, {
      originKey: record.originKey,
      semanticTag: selected.semanticTag,
      atomVersion: typeof currentAtomVersion === "string" ? currentAtomVersion.split("-")[0] : null,
      // A version whose engines.lumine does not match is shown (with a disabled
      // Install) rather than dropped, so another ref can be selected.
      allowIncompatible: true,
    });
    return {
      ...record,
      ...pack,
      // README content is intentionally lazy and badges may load remote images.
      // Neither is trusted from a package manifest for the catalog card.
      readme: undefined,
      badges: [],
      repository: record.repository,
      installSource: record.installSource,
      refs: {
        defaultBranch: index.defaultBranch,
        headSha: index.headSha,
        latestStable: index.latestStable,
        tags: index.tags,
        branches: record.refs && record.refs.branches ? record.refs.branches : null,
      },
      selectedRef: selected.selector,
      updatePolicy: selected.updatePolicy,
      resolvedSha: selected.resolvedSha,
      status: record.catalogError ? "stale" : "ready",
      error: record.catalogError,
      hydratedAt: this.now(),
    };
  }

  async loadBranches(pack) {
    const host = hostForRepository(pack.repository);
    const refs = await this.gitQueue.add(() => this.listRefs(pack.installSource, true), host);
    const updated = { ...pack, refs: { ...pack.refs, branches: refs.branches } };
    this.updateCachedPackage(updated);
    return updated;
  }

  // The Git source to list refs from. An installed fork's package.json
  // `repository` may point upstream, so prefer the install receipt's origin.
  repositoryForPack(pack) {
    const install = pack.apmInstallSource;
    if (install && install.type === "git" && install.repository) return install.repository;
    return pack.installSource || pack.repository;
  }

  // Lists tags + default branch for a card that has no ref index yet (an
  // installed package). Used to populate the version selector on demand.
  async loadRefs(pack) {
    const source = this.repositoryForPack(pack);
    const host = hostForRepository(source);
    const index = await this.gitQueue.add(() => this.listRefs(source, false), host);
    return {
      ...pack,
      refs: {
        defaultBranch: index.defaultBranch,
        headSha: index.headSha,
        latestStable: index.latestStable,
        tags: index.tags,
        branches: null,
      },
    };
  }

  async hydrateSource(source, catalogSource = "external") {
    const parsed = assertSafeCatalogPackageSource(source);
    const cache = this.readCache() || { manifests: {} };
    return this.hydrate(
      {
        originKey: parsed.originKey,
        repository: parsed.repository,
        installSource: parsed.source,
        catalogSources: [catalogSource],
        catalogSelectors: [{ catalogSource, selector: parsed.selector }],
        status: "pending",
      },
      cache.manifests || {},
      null,
    );
  }

  async hydrateManualSource(source) {
    const parsed = parsePackageSource(source);
    cloneUrlForRepository(parsed.repository);
    const originKey = normalizeRepositoryOrigin(parsed.repository);
    if (!originKey) throw new Error("Invalid Git repository source.");
    const cache = this.readCache() || { manifests: {} };
    return this.hydrate(
      {
        originKey,
        repository: parsed.repository,
        installSource: parsed.source,
        catalogSources: ["manual"],
        catalogSelectors: [{ catalogSource: "manual", selector: parsed.selector }],
        status: "pending",
        manualSource: true,
      },
      cache.manifests || {},
      null,
    );
  }

  async loadReadme(pack) {
    if (!pack.originKey || !/^[0-9a-f]{40}$/i.test(pack.resolvedSha || "")) return null;
    const cache = this.readCache() || {
      schemaVersion: CACHE_SCHEMA_VERSION,
      manifests: {},
      readmes: {},
      packages: {},
      catalogSources: [],
    };
    cache.readmes ||= {};
    const key = `${pack.originKey}@${pack.resolvedSha}`;
    if (cache.readmes[key]) {
      cache.readmes[key].accessedAt = this.now();
      this.writeCache(cache);
      return cache.readmes[key];
    }

    let entry = null;
    if (pack.originKey.startsWith("github.com/") && !pack.manualSource) {
      const repoPath = pack.originKey.slice("github.com/".length);
      for (const filename of ["README.md", "README.markdown", "README.mdown", "README.txt"]) {
        const rawUrl = `https://raw.githubusercontent.com/${repoPath}/${pack.resolvedSha}/${filename}`;
        const body = await this.httpQueue.add(
          () =>
            this.requestText(rawUrl, {
              maxBytes: MAX_README_BYTES,
              allowNotFound: true,
            }),
          "raw.githubusercontent.com",
        );
        if (body != null) {
          entry = {
            body,
            source: `https://github.com/${repoPath}/blob/${pack.resolvedSha}/${filename}`,
            accessedAt: this.now(),
          };
          break;
        }
      }
    } else {
      entry = await this.gitQueue.add(
        () => this.fetchReadmeWithGit(pack),
        hostForRepository(pack.repository),
      );
    }
    if (!entry) return null;
    cache.readmes[key] = entry;
    const keys = Object.keys(cache.readmes).sort(
      (left, right) => cache.readmes[right].accessedAt - cache.readmes[left].accessedAt,
    );
    for (const expired of keys.slice(README_CACHE_ENTRIES)) delete cache.readmes[expired];
    this.writeCache(cache);
    return entry;
  }

  // Lazily fetches a package's LICENSE for the resolved commit, mirroring
  // `loadReadme`. Returns `{ body, source, filename, isMarkdown }` or null.
  async loadLicense(pack) {
    if (!pack.originKey || !/^[0-9a-f]{40}$/i.test(pack.resolvedSha || "")) return null;
    const cache = this.readCache() || {
      schemaVersion: CACHE_SCHEMA_VERSION,
      manifests: {},
      readmes: {},
      licenses: {},
      packages: {},
      catalogSources: [],
    };
    cache.licenses ||= {};
    const key = `${pack.originKey}@${pack.resolvedSha}`;
    if (cache.licenses[key]) {
      cache.licenses[key].accessedAt = this.now();
      this.writeCache(cache);
      return cache.licenses[key];
    }

    let entry = null;
    if (pack.originKey.startsWith("github.com/") && !pack.manualSource) {
      const repoPath = pack.originKey.slice("github.com/".length);
      for (const filename of LICENSE_FILENAMES) {
        const rawUrl = `https://raw.githubusercontent.com/${repoPath}/${pack.resolvedSha}/${filename}`;
        const body = await this.httpQueue.add(
          () =>
            this.requestText(rawUrl, {
              maxBytes: MAX_README_BYTES,
              allowNotFound: true,
            }),
          "raw.githubusercontent.com",
        );
        if (body != null) {
          entry = {
            body,
            source: `https://github.com/${repoPath}/blob/${pack.resolvedSha}/${filename}`,
            filename,
            isMarkdown: /\.(md|markdown)$/i.test(filename),
            accessedAt: this.now(),
          };
          break;
        }
      }
    } else {
      entry = await this.gitQueue.add(
        () => this.fetchLicenseWithGit(pack),
        hostForRepository(pack.repository),
      );
    }
    if (!entry) return null;
    cache.licenses[key] = entry;
    const keys = Object.keys(cache.licenses).sort(
      (left, right) => cache.licenses[right].accessedAt - cache.licenses[left].accessedAt,
    );
    for (const expired of keys.slice(README_CACHE_ENTRIES)) delete cache.licenses[expired];
    this.writeCache(cache);
    return entry;
  }

  async selectRef(pack, selector) {
    let source;
    if (selector.type === "latest") source = pack.repository;
    else if (selector.type === "default") {
      source = `${pack.repository}#branch:${selector.value}`;
    } else source = `${pack.repository}#${selector.type}:${selector.value}`;
    const record = { ...pack, installSource: source, status: "validating", error: null };
    const cache = this.readCache() || { manifests: {} };
    let hydrated = await this.hydrate(record, cache.manifests || {}, null);
    if (selector.type === "default") {
      hydrated = {
        ...hydrated,
        selectedRef: selector,
        updatePolicy: "default-branch",
      };
    }
    this.updateCachedPackage(hydrated, cache.manifests);
    return hydrated;
  }

  async inspectResolvedManifest(pack, resolvedSha, selectedRef) {
    if (!/^[0-9a-f]{40}$/i.test(resolvedSha || "")) {
      throw new Error("A complete resolved commit SHA is required to inspect an update.");
    }
    const install = pack.apmInstallSource || {};
    const source = install.repository || install.source || pack.repository;
    const parsed = parsePackageSource(source);
    const originKey =
      install.origin || pack.originKey || normalizeRepositoryOrigin(parsed.repository);
    if (!originKey) throw new Error("The installed package receipt has no valid origin.");

    const cache = this.readCache() || {
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastFetch: null,
      catalogSources: [],
      manifests: {},
      readmes: {},
      packages: {},
    };
    cache.manifests ||= {};
    const cacheKey = `${originKey}@${resolvedSha.toLowerCase()}`;
    let metadata = cache.manifests[cacheKey];
    if (!metadata) {
      // Receipts may point at private HTTPS or SSH repositories. Inspect them
      // through Git so the user's normal Git credentials apply; catalog
      // hydration remains restricted to public sources and raw adapters.
      metadata = await this.fetchManifest(
        { originKey, repository: parsed.repository, manualSource: true },
        resolvedSha,
        null,
      );
      cache.manifests[cacheKey] = metadata;
      this.writeCache(cache);
    }

    const semanticTag =
      selectedRef && (selectedRef.type === "tag" || selectedRef.type === "latest")
        ? selectedRef.value
        : null;
    const currentAtomVersion = this.atomVersion();
    return validateCommunityPackageMetadata(metadata, {
      originKey,
      semanticTag,
      atomVersion: typeof currentAtomVersion === "string" ? currentAtomVersion.split("-")[0] : null,
    });
  }

  listRefs(source, includeBranches) {
    if (!this.packageManager) throw new Error("Git ref resolver is unavailable.");
    return listPackageRepositoryRefs(
      source,
      async (cloneUrl, options, patterns) => {
        const { stdout } = await this.packageManager.runProcess(
          this.packageManager.getGitCommand(),
          ["ls-remote", ...options, cloneUrl, ...patterns],
          { timeoutMs: GIT_REF_TIMEOUT },
        );
        return stdout;
      },
      { includeBranches },
    );
  }

  resolveSource(source) {
    if (!this.packageManager) throw new Error("Git ref resolver is unavailable.");
    return resolvePackageSource(source, async (cloneUrl, options, patterns) => {
      const { stdout } = await this.packageManager.runProcess(
        this.packageManager.getGitCommand(),
        ["ls-remote", ...options, cloneUrl, ...patterns],
        { timeoutMs: GIT_REF_TIMEOUT },
      );
      return stdout;
    });
  }

  async fetchManifest(record, sha, signal) {
    if (record.originKey.startsWith("github.com/") && !record.manualSource) {
      const repoPath = record.originKey.slice("github.com/".length);
      let lastError;
      for (const filename of ["package.json", "package.jsonc", "package.cson"]) {
        const url = `https://raw.githubusercontent.com/${repoPath}/${sha}/${filename}`;
        try {
          const body = await this.httpQueue.add(
            () =>
              this.requestText(url, { signal, maxBytes: MAX_MANIFEST_BYTES, allowNotFound: true }),
            "raw.githubusercontent.com",
            signal,
          );
          if (body == null) continue;
          return CSON.parse(body);
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      throw new Error("Repository does not contain package.json, package.jsonc, or package.cson.");
    }
    return this.gitQueue.add(
      () => this.fetchManifestWithGit(record, sha),
      hostForRepository(record.repository),
      signal,
    );
  }

  async fetchManifestWithGit(record, sha) {
    if (!this.packageManager) throw new Error("Generic Git manifest fetch is unavailable.");
    const cloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lumine-catalog-"));
    try {
      const git = this.packageManager.getGitCommand();
      await this.packageManager.runProcess(git, ["init"], {
        cwd: cloneDir,
        timeoutMs: GIT_REF_TIMEOUT,
      });
      await this.packageManager.runProcess(
        git,
        ["remote", "add", "origin", cloneUrlForRepository(record.repository)],
        { cwd: cloneDir, timeoutMs: GIT_REF_TIMEOUT },
      );
      await this.packageManager.runProcess(git, ["fetch", "--depth", "1", "origin", sha], {
        cwd: cloneDir,
        timeoutMs: GIT_FETCH_TIMEOUT,
      });
      await this.packageManager.runProcess(git, ["checkout", "--detach", "FETCH_HEAD"], {
        cwd: cloneDir,
        timeoutMs: GIT_REF_TIMEOUT,
      });
      const metadataPath = CSON.resolve(path.join(cloneDir, "package"));
      if (!metadataPath) throw new Error("Repository does not contain a package manifest.");
      return CSON.readFileSync(metadataPath);
    } finally {
      await fs.promises.rm(cloneDir, { recursive: true, force: true });
    }
  }

  async fetchReadmeWithGit(pack) {
    if (!this.packageManager) return null;
    const cloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lumine-readme-"));
    try {
      const git = this.packageManager.getGitCommand();
      await this.packageManager.runProcess(git, ["init"], {
        cwd: cloneDir,
        timeoutMs: GIT_REF_TIMEOUT,
      });
      await this.packageManager.runProcess(
        git,
        ["remote", "add", "origin", cloneUrlForRepository(pack.repository)],
        { cwd: cloneDir, timeoutMs: GIT_REF_TIMEOUT },
      );
      await this.packageManager.runProcess(
        git,
        ["fetch", "--depth", "1", "origin", pack.resolvedSha],
        { cwd: cloneDir, timeoutMs: GIT_FETCH_TIMEOUT },
      );
      await this.packageManager.runProcess(git, ["checkout", "--detach", "FETCH_HEAD"], {
        cwd: cloneDir,
        timeoutMs: GIT_REF_TIMEOUT,
      });
      const filename = (await fs.promises.readdir(cloneDir)).find((name) =>
        /^readme(?:\.|$)/i.test(name),
      );
      if (!filename) return null;
      const filePath = path.join(cloneDir, filename);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_README_BYTES) return null;
      return {
        body: await fs.promises.readFile(filePath, "utf8"),
        source: pack.repository,
        accessedAt: this.now(),
      };
    } finally {
      await fs.promises.rm(cloneDir, { recursive: true, force: true });
    }
  }

  async fetchLicenseWithGit(pack) {
    if (!this.packageManager) return null;
    const cloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lumine-license-"));
    try {
      const git = this.packageManager.getGitCommand();
      await this.packageManager.runProcess(git, ["init"], {
        cwd: cloneDir,
        timeoutMs: GIT_REF_TIMEOUT,
      });
      await this.packageManager.runProcess(
        git,
        ["remote", "add", "origin", cloneUrlForRepository(pack.repository)],
        { cwd: cloneDir, timeoutMs: GIT_REF_TIMEOUT },
      );
      await this.packageManager.runProcess(
        git,
        ["fetch", "--depth", "1", "origin", pack.resolvedSha],
        { cwd: cloneDir, timeoutMs: GIT_FETCH_TIMEOUT },
      );
      await this.packageManager.runProcess(git, ["checkout", "--detach", "FETCH_HEAD"], {
        cwd: cloneDir,
        timeoutMs: GIT_REF_TIMEOUT,
      });
      const filename = (await fs.promises.readdir(cloneDir)).find((name) =>
        LICENSE_FILE_PATTERN.test(name),
      );
      if (!filename) return null;
      const filePath = path.join(cloneDir, filename);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_README_BYTES) return null;
      return {
        body: await fs.promises.readFile(filePath, "utf8"),
        source: pack.repository,
        filename,
        isMarkdown: /\.(md|markdown)$/i.test(filename),
        accessedAt: this.now(),
      };
    } finally {
      await fs.promises.rm(cloneDir, { recursive: true, force: true });
    }
  }

  async requestText(url, { signal = null, maxBytes, allowNotFound = false } = {}) {
    let attempt = 0;
    while (true) {
      if (signal && signal.aborted) throw abortError();
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT);
      const abortListener = () => timeoutController.abort();
      if (signal) signal.addEventListener("abort", abortListener, { once: true });
      try {
        const response = await this.fetchImpl(url, {
          signal: timeoutController.signal,
          headers: { "User-Agent": global.navigator ? navigator.userAgent : "Lumine" },
        });
        if (allowNotFound && response && response.status === 404) return null;
        if (!response || response.status < 200 || response.status >= 300) {
          const error = new Error(
            `Request failed with status ${response && response.status ? response.status : "unknown"}.`,
          );
          error.status = response && response.status;
          error.retryAfter = response && response.headers && response.headers.get("retry-after");
          throw error;
        }
        const length = Number(response.headers && response.headers.get("content-length"));
        if (length && length > maxBytes) throw new Error("Response exceeds the size limit.");
        const body = await response.text();
        if (Buffer.byteLength(body) > maxBytes) throw new Error("Response exceeds the size limit.");
        return body;
      } catch (error) {
        if (signal && signal.aborted) throw error;
        const retryable = !error.status || error.status === 429 || error.status >= 500;
        if (attempt >= 2 || !retryable) throw error;
        const retryAfterSeconds = Number(error.retryAfter);
        const retryAfterDate = Date.parse(error.retryAfter);
        const retryAfterDelay =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : Number.isFinite(retryAfterDate)
              ? retryAfterDate - this.now()
              : 0;
        const delayMs = retryAfterDelay > 0 ? Math.min(retryAfterDelay, 5000) : 250 * 2 ** attempt;
        attempt++;
        await this.delay(delayMs);
      } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", abortListener);
      }
    }
  }

  async assertPublicHostname(hostname) {
    const lookupHostname = String(hostname).replace(/^\[|\]$/g, "");
    if (isPrivateAddress(lookupHostname)) {
      throw new Error(`Refusing a private or local network host: ${lookupHostname}.`);
    }
    // Reserved documentation/test TLDs are commonly used with injected fetch
    // implementations and can never identify a real network destination.
    if (/\.(?:test|example|invalid)$/i.test(lookupHostname)) return;
    if (lookupHostname === "github.com" || lookupHostname === "raw.githubusercontent.com") return;
    if (!this.dnsChecks.has(lookupHostname)) {
      this.dnsChecks.set(
        lookupHostname,
        dns.promises.lookup(lookupHostname, { all: true }).then((addresses) => {
          if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
            throw new Error(
              `Refusing a host that resolves to a private network: ${lookupHostname}.`,
            );
          }
          return true;
        }),
      );
    }
    return this.dnsChecks.get(lookupHostname);
  }

  packagesForSources(cache, catalogSources) {
    if (!cache || !cache.packages) return [];
    const allowed = new Set(catalogSources);
    return Object.values(cache.packages).filter((pack) =>
      (pack.catalogSources || []).some((source) => allowed.has(source)),
    );
  }

  cacheFilePath() {
    return path.join(this.cachePath, "community-package-catalog-v2.json");
  }

  readCache() {
    try {
      const serialized = this.storage
        ? this.storage.getItem("settings-view:community-package-catalog-v2")
        : fs.readFileSync(this.cacheFilePath(), "utf8");
      if (!serialized) return null;
      const cache = JSON.parse(serialized);
      return cache.schemaVersion === CACHE_SCHEMA_VERSION ? cache : null;
    } catch {
      return null;
    }
  }

  writeCache(cache) {
    const serialized = JSON.stringify(cache);
    if (this.storage) {
      this.storage.setItem("settings-view:community-package-catalog-v2", serialized);
      return;
    }
    fs.mkdirSync(this.cachePath, { recursive: true });
    const target = this.cacheFilePath();
    const temporary = `${target}.${process.pid}.next`;
    fs.writeFileSync(temporary, serialized);
    fs.renameSync(temporary, target);
  }

  updateCachedPackage(pack, manifests = null) {
    const cache = this.readCache() || {
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastFetch: this.now(),
      catalogSources: [],
      manifests: {},
      readmes: {},
      packages: {},
    };
    cache.packages[pack.originKey] = pack;
    if (manifests) cache.manifests = manifests;
    this.writeCache(cache);
  }

  // Merges the results of an installed-package update check into the cached
  // catalog entries (matched by origin) so browse cards reflect the newer data
  // without a full catalog fetch. Writes only when something actually changed.
  mergeInstalledUpdates(packs) {
    const cache = this.readCache();
    if (!cache || !cache.packages) return;
    let changed = false;
    for (const pack of packs || []) {
      const originKey =
        pack.originKey || (pack.apmInstallSource && pack.apmInstallSource.origin) || null;
      const existing = originKey && cache.packages[originKey];
      if (!existing) continue;
      cache.packages[originKey] = {
        ...existing,
        latestSha: pack.latestSha,
        latestVersion: pack.latestVersion,
        resolvedRef: pack.resolvedRef,
        suspiciousTagMove: pack.suspiciousTagMove,
        originWarning: pack.originWarning,
        renamedPackage: pack.renamedPackage,
      };
      changed = true;
    }
    if (changed) this.writeCache(cache);
  }
};

module.exports.CACHE_SCHEMA_VERSION = CACHE_SCHEMA_VERSION;
module.exports.GIT_CONCURRENCY = GIT_CONCURRENCY;
module.exports.HTTP_CONCURRENCY = HTTP_CONCURRENCY;
module.exports.MAX_REPOSITORIES = MAX_REPOSITORIES;
module.exports.TaskQueue = TaskQueue;
module.exports.normalizeCatalogSource = normalizeCatalogSource;
