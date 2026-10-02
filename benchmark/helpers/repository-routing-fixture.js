const path = require("path");
const { Emitter } = require("@lumine-code/event-kit");
const RepositoryRegistry = require("../../src/repository-registry");

class RoutingRepository {
  constructor(workingDirectory, gitDirectory, commonDirectory = gitDirectory) {
    this.workingDirectory = workingDirectory;
    this.gitDirectory = gitDirectory;
    this.commonDirectory = commonDirectory;
    this.workingDirectoryAliases = [workingDirectory || gitDirectory];
    this.gitDirectoryAliases = [gitDirectory];
    this.destroyed = false;
    this.emitter = new Emitter();
  }

  getWorkingDirectory() {
    return this.workingDirectory;
  }

  getPath() {
    return this.gitDirectory;
  }

  getCommonDirectory() {
    return this.commonDirectory;
  }

  getWorkingDirectoryAliases() {
    return this.workingDirectoryAliases;
  }

  getGitDirectoryAliases() {
    return this.gitDirectoryAliases;
  }

  isDestroyed() {
    return this.destroyed;
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

function createRoutingFixture(repositoryCount) {
  const registry = new RepositoryRegistry({});
  const root = path.resolve("repository-routing-fixture");
  const repositories = [];
  for (let index = 0; index < repositoryCount; index++) {
    const workingDirectory = path.join(root, `repository-${index}`);
    const main = index % 8 === 7 ? repositories[index - 1] : null;
    const commonDirectory = main?.getPath();
    const gitDirectory = main
      ? path.join(commonDirectory, "worktrees", `linked-${index}`)
      : path.join(workingDirectory, ".git");
    const repository = new RoutingRepository(workingDirectory, gitDirectory, commonDirectory);
    repositories.push(repository);
    registry.register(repository, { emit: false });
  }
  return { registry, repositories, root };
}

function routingEvents(repositories, count, kind) {
  return Array.from({ length: count }, (_, index) => {
    const repository = repositories[index % repositories.length];
    const directory = Math.floor(index / repositories.length);
    const base =
      kind === "metadata"
        ? path.join(repository.getPath(), "refs", "heads")
        : path.join(repository.getWorkingDirectory(), "generated");
    return {
      action: "updated",
      path: path.join(base, `directory-${directory}`, `file-${index}`),
    };
  });
}

function countRoutingWork(registry, callback) {
  const metrics = { entryVisits: 0, ownerLookups: 0, metadataDomains: 0 };
  const entries = registry.entriesById.values;
  registry.entriesById.values = function* () {
    for (const entry of entries.call(this)) {
      metrics.entryVisits++;
      yield entry;
    }
  };
  const maps = [registry.routingDirectoryOwners, registry.gitDirectoryOwners];
  const gets = maps.map((map) => map.get);
  for (let index = 0; index < maps.length; index++) {
    maps[index].get = function (key) {
      metrics.ownerLookups++;
      return gets[index].call(this, key);
    };
  }
  const metadataDomains = registry.metadataDomainAliases;
  registry.metadataDomainAliases = function (entry) {
    metrics.metadataDomains++;
    return metadataDomains.call(this, entry);
  };
  const metadataIndex = registry.metadataRoutingIndex;
  if (metadataIndex) {
    registry.metadataRoutingIndex = function () {
      const index = metadataIndex.call(this);
      const get = index.get;
      index.get = function (key) {
        metrics.ownerLookups++;
        return get.call(this, key);
      };
      return index;
    };
  }
  try {
    return { ...callback(), metrics };
  } finally {
    registry.entriesById.values = entries;
    registry.metadataDomainAliases = metadataDomains;
    if (metadataIndex) registry.metadataRoutingIndex = metadataIndex;
    for (let index = 0; index < maps.length; index++) maps[index].get = gets[index];
  }
}

module.exports = { RoutingRepository, createRoutingFixture, routingEvents, countRoutingWork };
