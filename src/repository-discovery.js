const path = require("path");
const { Disposable } = require("@lumine-code/event-kit");
const GitRepositoryProvider = require("./git-repository-provider");

const MAX_REPOSITORY_PATH_CACHE = 4096;

function repositoryPathKey(filePath) {
  const resolvedPath = path.resolve(filePath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

// Owns discovery candidates and their cache until the registry accepts or
// abandons them. Project supplies roots and buffers; it holds no discovery state.
module.exports = class RepositoryDiscovery {
  constructor({ registry, isAvailable = () => true, providers } = {}) {
    this.repositoryRegistry = registry;
    this.isAvailable = isAvailable;
    this.repositoryPromisesByPath = new Map();
    this.repositoryLookupState = new WeakMap();
    this.repositoriesByCachedPath = new Map();
    this.repositoryPromiseKeysByRepository = new Map();
    this.repositoryCacheObservedRepositories = new WeakSet();
    this.repositoryProviderGeneration = 0;
    this.pendingRepositoryDiscoveryCount = 0;
    this.repositoryOrphanSweepScheduled = false;
    this.repositoryProviders = providers || [
      new GitRepositoryProvider({
        isRegistered: (repository) => registry.hasRepository(repository),
      }),
    ];
  }

  addProvider(provider) {
    if (typeof provider?.repositoryForPath !== "function") {
      throw new TypeError("Repository providers must implement repositoryForPath(path)");
    }
    this.repositoryProviders.unshift(provider);
    this.clearRepositoryPathCache({ invalidateProviders: true });
    return new Disposable(() => {
      const index = this.repositoryProviders.indexOf(provider);
      if (index < 0) return;
      this.repositoryProviders.splice(index, 1);
      this.clearRepositoryPathCache({ invalidateProviders: true });
      provider.sweepUnregisteredRepositories?.();
    });
  }

  repositoryForPathFromProviders(filePath, { refresh = false, joinPending = false } = {}) {
    if (!this.isAvailable()) return Promise.resolve(null);
    const pathKey = repositoryPathKey(filePath);
    const lookupState = (this.repositoryLookupState ||= new WeakMap());
    if (refresh) {
      const pending = this.repositoryPromisesByPath.get(pathKey);
      const state = lookupState.get(pending);
      // Background scans may share a current in-flight lookup. Explicit
      // refreshes keep their force semantics, including symlink retargeting
      // before the watcher has announced the changed repository metadata.
      if (
        joinPending &&
        state?.pending &&
        state.providerGeneration === this.repositoryProviderGeneration &&
        state.discoveryRevision === this.repositoryRegistry?.repositoryDiscoveryRevision
      )
        return pending;
      this.repositoryPromisesByPath.delete(pathKey);
      this.repositoriesByCachedPath.delete(pathKey);
    }
    let promise = this.repositoryPromisesByPath.get(pathKey);
    if (!promise) {
      if (this.repositoryPromisesByPath.size >= MAX_REPOSITORY_PATH_CACHE) {
        this.clearRepositoryPathCache();
      }
      const providerGeneration = this.repositoryProviderGeneration;
      const state = {
        pending: true,
        providerGeneration,
        discoveryRevision: this.repositoryRegistry?.repositoryDiscoveryRevision,
      };
      const providers = this.repositoryProviders.slice();
      const promises = providers.map(async (provider) => provider.repositoryForPath(filePath));
      let discoveryAccepted = false;
      let selectedProvider = -1;
      this.pendingRepositoryDiscoveryCount++;
      Promise.allSettled(promises).then((results) => {
        queueMicrotask(() => {
          try {
            for (let index = 0; index < results.length; index++) {
              if (
                (!discoveryAccepted || index !== selectedProvider) &&
                results[index].status === "fulfilled" &&
                results[index].value
              ) {
                providers[index].abandonRepositoryForPath?.(results[index].value, filePath);
              }
            }
          } finally {
            this.pendingRepositoryDiscoveryCount--;
            this.scheduleRepositoryOrphanSweep();
          }
        });
      });
      promise = Promise.all(promises)
        .then((repositories) => {
          if (providerGeneration !== this.repositoryProviderGeneration) {
            if (this.repositoryPromisesByPath.get(pathKey) === promise) {
              this.repositoryPromisesByPath.delete(pathKey);
              this.repositoriesByCachedPath.delete(pathKey);
            }
            return null;
          }
          discoveryAccepted = true;
          selectedProvider = repositories.findIndex((repo) => repo != null);
          const repo = repositories[selectedProvider] || null;

          // If no repository is found, remove the entry for the directory in
          // @repositoryPromisesByPath in case some other RepositoryProvider is
          // registered in the future that could supply a Repository for the
          // directory.
          if (repo == null && this.repositoryPromisesByPath.get(pathKey) === promise) {
            this.repositoryPromisesByPath.delete(pathKey);
            this.repositoriesByCachedPath.delete(pathKey);
          }

          if (repo && this.repositoryPromisesByPath.get(pathKey) === promise) {
            this.repositoriesByCachedPath.set(pathKey, repo);
          }
          if (repo?.onDidDestroy && this.repositoryPromisesByPath.get(pathKey) === promise) {
            let keys = this.repositoryPromiseKeysByRepository.get(repo);
            if (!keys) {
              keys = new Map();
              this.repositoryPromiseKeysByRepository.set(repo, keys);
            }
            if (!this.repositoryCacheObservedRepositories.has(repo)) {
              this.repositoryCacheObservedRepositories.add(repo);
              repo.onDidDestroy(() => {
                for (const [key, cachedPromise] of this.repositoryPromiseKeysByRepository.get(
                  repo,
                ) || []) {
                  if (this.repositoryPromisesByPath.get(key) === cachedPromise) {
                    this.repositoryPromisesByPath.delete(key);
                    this.repositoriesByCachedPath.delete(key);
                  }
                }
                this.repositoryPromiseKeysByRepository.delete(repo);
              });
            }
            keys.set(pathKey, promise);
          }

          return repo;
        })
        .catch((error) => {
          if (this.repositoryPromisesByPath.get(pathKey) === promise) {
            this.repositoryPromisesByPath.delete(pathKey);
            this.repositoriesByCachedPath.delete(pathKey);
          }
          throw error;
        })
        .finally(() => {
          state.pending = false;
        });
      lookupState.set(promise, state);
      this.repositoryPromisesByPath.set(pathKey, promise);
    }
    return promise;
  }

  repositoryForPathFromProvidersCached(filePath) {
    for (const provider of this.repositoryProviders) {
      const repository = provider.getRepositoryForPath?.(filePath);
      if (repository) return repository;
    }
    return null;
  }

  commitRepositoryForPath(repository, filePath) {
    for (const provider of this.repositoryProviders) {
      provider.commitRepositoryForPath?.(repository, filePath);
    }
  }

  abandonRepositoryForPath(repository, filePath) {
    let abandoned = false;
    for (const provider of this.repositoryProviders) {
      abandoned = provider.abandonRepositoryForPath?.(repository, filePath) === true || abandoned;
    }
    if (!abandoned) return;
    const pathKey = repositoryPathKey(filePath);
    this.repositoryPromisesByPath.delete(pathKey);
    this.repositoriesByCachedPath.delete(pathKey);
    for (const keys of this.repositoryPromiseKeysByRepository.values()) keys.delete(pathKey);
  }

  clearRepositoryPathCache({ invalidateProviders = false } = {}) {
    if (invalidateProviders) this.repositoryProviderGeneration++;
    this.repositoryPromisesByPath.clear();
    this.repositoriesByCachedPath.clear();
    for (const keys of this.repositoryPromiseKeysByRepository.values()) keys.clear();
    this.repositoryPromiseKeysByRepository.clear();
  }

  invalidateRepositoryPathCache(prefixes) {
    const normalizedPrefixes = (prefixes || []).filter(Boolean).map((prefix) => {
      const resolved = path.resolve(prefix);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    });
    if (normalizedPrefixes.length === 0) return;

    const invalidated = [];
    for (const cachePath of this.repositoryPromisesByPath.keys()) {
      const normalizedPath = process.platform === "win32" ? cachePath.toLowerCase() : cachePath;
      if (
        normalizedPrefixes.some(
          (prefix) =>
            normalizedPath === prefix ||
            normalizedPath.startsWith(prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`),
        )
      ) {
        const cachedRepository = this.repositoriesByCachedPath.get(cachePath);
        if (
          cachedRepository &&
          this.repositoryRegistry.getForPath(cachePath) === cachedRepository
        ) {
          continue;
        }
        this.repositoryPromisesByPath.delete(cachePath);
        this.repositoriesByCachedPath.delete(cachePath);
        invalidated.push(cachePath);
      }
    }
    if (invalidated.length === 0) return;
    for (const keys of this.repositoryPromiseKeysByRepository.values()) {
      for (const cachePath of invalidated) keys.delete(cachePath);
    }
  }

  scheduleRepositoryOrphanSweep() {
    if (this.repositoryOrphanSweepScheduled || this.pendingRepositoryDiscoveryCount > 0) return;
    this.repositoryOrphanSweepScheduled = true;
    setImmediate(() => {
      this.repositoryOrphanSweepScheduled = false;
      if (this.pendingRepositoryDiscoveryCount > 0) return;
      for (const provider of this.repositoryProviders) {
        provider.sweepUnregisteredRepositories?.();
      }
    });
  }
};
