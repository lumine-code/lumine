const GitRepository = require("./git-repository");
const {
  discoverRepositoryDescriptor,
  discoverRepositoryDescriptorAsync,
} = require("./git-repository-descriptor");

function toDirectoryPath(directory) {
  return typeof directory === "string" ? directory : directory.getPath();
}

// Provider that conforms to the project.repository-provider@1.0.0 service.
// Discovery and validation have one owner: git-repository-descriptor. The
// descriptor produced here is passed into GitRepository instead of making the
// facade repeat the same filesystem walk.
module.exports = class GitRepositoryProvider {
  constructor(project, config) {
    // Keys are canonical real paths that end in `.git`; values are the
    // corresponding GitRepository objects.
    this.project = project;
    this.config = config;
    this.pathToRepository = {};
  }

  // Returns a Promise resolving to the nearest GitRepository or null. The
  // asynchronous variant keeps filesystem traversal off the renderer turn.
  async repositoryForDirectory(directory) {
    return this.repositoryForDescriptor(
      await discoverRepositoryDescriptorAsync(toDirectoryPath(directory)),
    );
  }

  repositoryForDirectorySync(directory) {
    return this.repositoryForDescriptor(discoverRepositoryDescriptor(toDirectoryPath(directory)));
  }

  repositoryForGitDirectory(gitDirectory) {
    return this.repositoryForDescriptor(discoverRepositoryDescriptor(gitDirectory));
  }

  repositoryForDescriptor(descriptor) {
    if (!descriptor) return null;

    const key = descriptor.getPath();
    let repository = this.pathToRepository[key];
    if (!repository) {
      repository = GitRepository.open(key, {
        project: this.project,
        config: this.config,
        descriptor,
      });
      if (!repository) return null;

      repository.onDidDestroy(() => delete this.pathToRepository[key]);
      this.pathToRepository[key] = repository;
      // Snapshot loading stays lazy and subscriber-driven, avoiding a status
      // burst for every repository discovered during startup.
    }
    return repository;
  }
};
