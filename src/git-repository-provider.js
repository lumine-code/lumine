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

// Provider that conforms to the project.repository-provider@1.0.0 service.
// Discovery and validation have one owner: git-repository-descriptor. The
// descriptor produced here is passed into GitRepository instead of making the
// facade repeat the same filesystem walk.
module.exports = class GitRepositoryProvider {
  constructor({ isRegistered = () => true } = {}) {
    // Keys are canonical real paths that end in `.git`; values are the
    // corresponding GitRepository objects.
    this.pathToRepository = {};
    this.pendingDescriptorsByPath = new Map();
    this.isRegistered = isRegistered;
  }

  async repositoryForPath(filePath) {
    const descriptor = await discoverRepositoryDescriptorAsync(filePath);
    const repository = this.repositoryForDescriptor(descriptor);
    if (repository && descriptor) {
      if (this.pendingDescriptorsByPath.size >= MAX_PENDING_DESCRIPTORS) {
        this.pendingDescriptorsByPath.clear();
      }
      this.pendingDescriptorsByPath.set(normalizePath(filePath), { repository, descriptor });
    }
    return repository;
  }

  commitRepositoryForPath(repository, filePath) {
    const key = normalizePath(filePath);
    const pending = this.pendingDescriptorsByPath.get(key);
    if (!pending || pending.repository !== repository) return;
    this.pendingDescriptorsByPath.delete(key);
    repository.addWorkingDirectoryAlias?.(pending.descriptor.openedWorkingDirectory);
    for (const alias of pending.descriptor.getGitDirectoryAliases?.() || []) {
      repository.addGitDirectoryAlias?.(alias);
    }
  }

  abandonRepositoryForPath(repository, filePath) {
    const key = normalizePath(filePath);
    const pending = this.pendingDescriptorsByPath.get(key);
    if (pending?.repository !== repository) return false;
    this.pendingDescriptorsByPath.delete(key);
    return true;
  }

  sweepUnregisteredRepositories() {
    for (const repository of Object.values(this.pathToRepository)) {
      if (!this.isRegistered(repository) && !repository.isDestroyed()) repository.destroy();
    }
  }

  // Cache-only lookup used while project roots are being reconciled. It is
  // deliberately lexical and never performs filesystem discovery.
  getRepositoryForPath(filePath) {
    let best = null;
    let bestLength = -1;
    for (const repository of Object.values(this.pathToRepository)) {
      if (repository.isDestroyed()) continue;
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

    const key = descriptor.getPath();
    let repository = this.pathToRepository[key];
    if (!repository) {
      repository = new GitRepository(descriptor);
      // Aliases belong to the discovery request, not to repository identity.
      // The current consumer commits them after its generation/path guards;
      // stale discoveries must never mutate a cached repository.
      repository.removeWorkingDirectoryAlias?.(descriptor.openedWorkingDirectory);
      for (const alias of descriptor.getGitDirectoryAliases?.() || []) {
        if (normalizePath(alias) !== normalizePath(key)) {
          repository.removeGitDirectoryAlias?.(alias);
        }
      }

      repository.onDidDestroy(() => {
        delete this.pathToRepository[key];
        for (const [pathKey, pending] of this.pendingDescriptorsByPath) {
          if (pending.repository === repository) this.pendingDescriptorsByPath.delete(pathKey);
        }
      });
      this.pathToRepository[key] = repository;
      // Snapshot loading stays lazy and subscriber-driven, avoiding a status
      // burst for every repository discovered during startup.
    }
    return repository;
  }
};
