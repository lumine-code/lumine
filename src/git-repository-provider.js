const GitRepository = require("./git-repository");
const path = require("path");
const { discoverRepositoryDescriptorAsync } = require("./git-repository-descriptor");

const MAX_PENDING_DESCRIPTORS = 4096;

function normalizePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contains(parentPath, childPath) {
  const parent = normalizePath(parentPath);
  const child = normalizePath(childPath);
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child === parent || child.startsWith(prefix);
}

function repositoryIdentity(gitDirectory, workingDirectory) {
  return `${normalizePath(gitDirectory)}\0${
    workingDirectory == null ? "<bare>" : normalizePath(workingDirectory)
  }`;
}

function filesystemIdentitiesMatch(current, expected) {
  return (
    !current ||
    !expected ||
    (current.device === expected.device && current.inode === expected.inode)
  );
}

function repositoryMatchesDescriptor(repository, descriptor) {
  return (
    filesystemIdentitiesMatch(
      repository.getGitDirectoryIdentity?.(),
      descriptor.getGitDirectoryIdentity?.(),
    ) &&
    filesystemIdentitiesMatch(
      repository.getWorkingDirectoryIdentity?.(),
      descriptor.getWorkingDirectoryIdentity?.(),
    )
  );
}

// Provider that conforms to the project.repository-provider@1.0.0 service.
// Discovery and validation have one owner: git-repository-descriptor. The
// descriptor produced here is passed into GitRepository instead of making the
// facade repeat the same filesystem walk.
module.exports = class GitRepositoryProvider {
  constructor({ isRegistered = () => true, maxPendingDescriptors = MAX_PENDING_DESCRIPTORS } = {}) {
    // Repository identity is the exact (git directory, working directory)
    // pair. A single Git directory may temporarily have both the old and new
    // worktree object while a move discovery passes the caller's generation
    // and path guards.
    this.pathToRepository = {};
    this.repositoriesByGitDirectory = new Map();
    this.repositoryState = new WeakMap();
    this.pendingDescriptorsByPath = new Map();
    this.isRegistered = isRegistered;
    this.maxPendingDescriptors = maxPendingDescriptors;
  }

  async repositoryForPath(filePath) {
    const descriptor = await discoverRepositoryDescriptorAsync(filePath);
    if (descriptor) {
      if (this.pendingDescriptorsByPath.size >= this.maxPendingDescriptors) {
        const abandonedRepositories = new Set(
          Array.from(this.pendingDescriptorsByPath.values(), ({ repository }) => repository),
        );
        this.pendingDescriptorsByPath.clear();
        for (const abandonedRepository of abandonedRepositories) {
          this.releaseAbandonedRepository(abandonedRepository);
        }
      }
    }
    const repository = this.repositoryForDescriptor(descriptor);
    if (repository && descriptor) {
      const key = normalizePath(filePath);
      const previous = this.pendingDescriptorsByPath.get(key);
      if (previous && previous.repository !== repository) {
        this.pendingDescriptorsByPath.delete(key);
        this.releaseAbandonedRepository(previous.repository);
      }
      this.pendingDescriptorsByPath.set(key, { repository, descriptor });
    }
    return repository;
  }

  commitRepositoryForPath(repository, filePath) {
    const key = normalizePath(filePath);
    const pending = this.pendingDescriptorsByPath.get(key);
    if (!pending || pending.repository !== repository) return;
    this.pendingDescriptorsByPath.delete(key);
    if (repository.isDestroyed()) return;
    repository.addWorkingDirectoryAlias?.(pending.descriptor.openedWorkingDirectory);
    for (const alias of pending.descriptor.getGitDirectoryAliases?.() || []) {
      repository.addGitDirectoryAlias?.(alias);
    }

    const state = this.repositoryState.get(repository);
    if (!state || state.committed) return;
    state.committed = true;

    // The new identity has now passed the registry's generation/path guards.
    // Only at this point may it supersede the previous worktree object for the
    // same Git directory.
    for (const staleRepository of Array.from(
      this.repositoriesByGitDirectory.get(state.gitDirectoryKey) || [],
    )) {
      const staleState = this.repositoryState.get(staleRepository);
      if (
        staleRepository !== repository &&
        staleState?.committed &&
        !staleRepository.isDestroyed()
      ) {
        staleRepository.destroy();
      }
    }
  }

  abandonRepositoryForPath(repository, filePath) {
    const key = normalizePath(filePath);
    const pending = this.pendingDescriptorsByPath.get(key);
    if (pending?.repository !== repository) return false;
    this.pendingDescriptorsByPath.delete(key);
    this.releaseAbandonedRepository(repository);
    return true;
  }

  releaseAbandonedRepository(repository) {
    const state = this.repositoryState.get(repository);
    if (!state || state.committed || repository.isDestroyed()) return;
    for (const pending of this.pendingDescriptorsByPath.values()) {
      if (pending.repository === repository) return;
    }
    if (!this.isRegistered(repository)) repository.destroy();
  }

  sweepUnregisteredRepositories() {
    const pendingRepositories = new Set(
      Array.from(this.pendingDescriptorsByPath.values(), ({ repository }) => repository),
    );
    for (const repository of Object.values(this.pathToRepository)) {
      if (
        !pendingRepositories.has(repository) &&
        !this.isRegistered(repository) &&
        !repository.isDestroyed()
      ) {
        repository.destroy();
      }
    }
  }

  // Cache-only lookup used while project roots are being reconciled. It is
  // deliberately lexical and never performs filesystem discovery.
  getRepositoryForPath(filePath) {
    let best = null;
    let bestLength = -1;
    for (const repository of Object.values(this.pathToRepository)) {
      if (repository.isDestroyed() || this.repositoryState.get(repository)?.committed !== true) {
        continue;
      }
      const directories = (
        repository.getWorkingDirectoryAliases?.() || [
          repository.getWorkingDirectory() || repository.getPath(),
          repository.openedWorkingDirectoryPath,
        ]
      ).filter(Boolean);
      for (const directory of directories) {
        if (directory.length > bestLength && contains(directory, filePath)) {
          best = repository;
          bestLength = directory.length;
        }
      }
    }
    return best;
  }

  repositoryForDescriptor(descriptor) {
    if (!descriptor) return null;

    const gitDirectory = descriptor.getPath();
    const workingDirectory = descriptor.getWorkingDirectory();
    const gitDirectoryKey = normalizePath(gitDirectory);
    const key = repositoryIdentity(gitDirectory, workingDirectory);
    let repository = this.pathToRepository[key];
    const previousAtKey =
      repository && !repositoryMatchesDescriptor(repository, descriptor) ? repository : null;
    if (!repository || previousAtKey) {
      repository = new GitRepository(descriptor);
      // Aliases belong to the discovery request, not to repository identity.
      // The current consumer commits them after its generation/path guards;
      // stale discoveries must never mutate a cached repository.
      repository.removeWorkingDirectoryAlias?.(descriptor.openedWorkingDirectory);
      for (const alias of descriptor.getGitDirectoryAliases?.() || []) {
        if (normalizePath(alias) !== normalizePath(gitDirectory)) {
          repository.removeGitDirectoryAlias?.(alias);
        }
      }

      let state = null;
      repository.onDidDestroy(() => {
        if (this.pathToRepository[key] === repository) {
          if (state?.previousAtKey && !state.previousAtKey.isDestroyed()) {
            this.pathToRepository[key] = state.previousAtKey;
          } else {
            delete this.pathToRepository[key];
          }
        }
        const repositories = this.repositoriesByGitDirectory.get(gitDirectoryKey);
        repositories?.delete(repository);
        if (repositories?.size === 0) {
          this.repositoriesByGitDirectory.delete(gitDirectoryKey);
        }
        for (const [pathKey, pending] of this.pendingDescriptorsByPath) {
          if (pending.repository === repository) this.pendingDescriptorsByPath.delete(pathKey);
        }
        this.repositoryState.delete(repository);
      });
      this.pathToRepository[key] = repository;
      let repositories = this.repositoriesByGitDirectory.get(gitDirectoryKey);
      if (!repositories) {
        repositories = new Set();
        this.repositoriesByGitDirectory.set(gitDirectoryKey, repositories);
      }
      repositories.add(repository);
      state = { key, gitDirectoryKey, committed: false, previousAtKey };
      this.repositoryState.set(repository, state);
      // Snapshot loading stays lazy and subscriber-driven, avoiding a status
      // burst for every repository discovered during startup.
    }
    return repository;
  }
};
