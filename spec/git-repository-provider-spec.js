const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const ProjectDirectory = require("../src/project-directory");
const GitRepository = require("../src/git-repository");
const GitRepositoryProvider = require("../src/git-repository-provider");

describe("GitRepositoryProvider", () => {
  let provider;

  beforeEach(() => {
    provider = new GitRepositoryProvider();
  });

  afterEach(() => {
    if (provider) {
      Object.keys(provider.pathToRepository).forEach((key) => {
        provider.pathToRepository[key].destroy();
      });
    }
  });

  function copyWorkingRepository() {
    const workingDirectory = temp.mkdirSync("provider-working-repository-");
    fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
    fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
    return workingDirectory;
  }

  describe(".repositoryForPath(filePath)", () => {
    describe("when specified a Directory with a Git repository", () => {
      it("resolves with a GitRepository", async () => {
        const directory = new ProjectDirectory(
          path.join(__dirname, "fixtures", "git", "master.git"),
        );
        const result = await provider.repositoryForPath(directory.getPath());
        expect(result).toEqual(jasmine.any(GitRepository));
        expect(provider.pathToRepository[result.getPath()]).toBeTruthy();
        expect(result.getType()).toBe("git");
      });

      it("does not eagerly refresh status at open time", async () => {
        // The provider no longer forces a status pass when a repository is
        // discovered; consumers drive refreshes by subscribing to the Git
        // snapshot. This keeps startup off the per-repo status burst.
        const refreshStatusSnapshot = spyOn(
          GitRepository.prototype,
          "refreshStatusSnapshot",
        ).and.callThrough();
        const directory = new ProjectDirectory(
          path.join(__dirname, "fixtures", "git", "master.git"),
        );
        const result = await provider.repositoryForPath(directory.getPath());
        expect(result).toEqual(jasmine.any(GitRepository));
        expect(refreshStatusSnapshot).not.toHaveBeenCalled();
      });

      it("resolves with the same GitRepository for different Directory objects in the same repo", async () => {
        const firstRepo = await provider.repositoryForPath(
          path.join(__dirname, "fixtures", "git", "master.git"),
        );
        const secondRepo = await provider.repositoryForPath(
          path.join(__dirname, "fixtures", "git", "master.git", "objects"),
        );

        expect(firstRepo).toEqual(jasmine.any(GitRepository));
        expect(firstRepo).toBe(secondRepo);
      });
    });

    describe("when specified a Directory without a Git repository", () => {
      it("resolves with null", async () => {
        const directory = new ProjectDirectory(temp.mkdirSync("dir"));
        const repo = await provider.repositoryForPath(directory.getPath());
        expect(repo).toBe(null);
      });
    });

    describe("when specified a Directory with an invalid Git repository", () => {
      it("resolves with null", async () => {
        const dirPath = temp.mkdirSync("dir");
        fs.writeFileSync(path.join(dirPath, ".git", "objects"), "");
        fs.writeFileSync(path.join(dirPath, ".git", "HEAD"), "");
        fs.writeFileSync(path.join(dirPath, ".git", "refs"), "");

        const directory = new ProjectDirectory(dirPath);
        const repo = await provider.repositoryForPath(directory.getPath());
        expect(repo).toBe(null);
      });
    });

    describe("when specified a Directory with a valid gitfile-linked repository", () => {
      it("returns a Promise that resolves to a GitRepository", async () => {
        const gitDirPath = path.join(__dirname, "fixtures", "git", "master.git");
        const workDirPath = temp.mkdirSync("git-workdir");
        fs.writeFileSync(path.join(workDirPath, ".git"), `gitdir: ${gitDirPath}\n`);

        const directory = new ProjectDirectory(workDirPath);
        const result = await provider.repositoryForPath(directory.getPath());
        expect(result).toEqual(jasmine.any(GitRepository));
        expect(provider.pathToRepository[result.getPath()]).toBeTruthy();
        expect(result.getType()).toBe("git");
      });
    });

    describe("when specified a Directory with a commondir file for a worktree", () => {
      it("returns a Promise that resolves to a GitRepository", async () => {
        const directory = new ProjectDirectory(
          path.join(__dirname, "fixtures", "git", "master.git", "worktrees", "worktree-dir"),
        );
        const result = await provider.repositoryForPath(directory.getPath());
        expect(result).toEqual(jasmine.any(GitRepository));
        expect(provider.pathToRepository[result.getPath()]).toBeTruthy();
        expect(result.getType()).toBe("git");
      });
    });

    describe("when specified a plain directory path string with no repository", () => {
      it("returns a Promise that resolves to null", async () => {
        const repo = await provider.repositoryForPath(temp.mkdirSync("dir"));
        expect(repo).toBe(null);
      });
    });

    it("answers cache-only containment lookups without filesystem access", async () => {
      const rootPath = path.join(__dirname, "fixtures", "git", "master.git");
      const repository = await provider.repositoryForPath(rootPath);
      const outsidePath = temp.mkdirSync("outside-repository");
      const realpathSync = spyOn(fs.realpathSync, "native").and.callThrough();

      expect(provider.getRepositoryForPath(path.join(rootPath, "objects", "nested"))).toBe(
        repository,
      );
      expect(provider.getRepositoryForPath(outsidePath)).toBeNull();
      expect(realpathSync).not.toHaveBeenCalled();
    });

    it("releases a discovered repository that no registry claims", async () => {
      provider = new GitRepositoryProvider({ isRegistered: () => false });
      const repository = await provider.repositoryForPath(
        path.join(__dirname, "fixtures", "git", "master.git"),
      );
      const repositoryPath = repository.getPath();
      expect(repository.isDestroyed()).toBe(false);

      provider.sweepUnregisteredRepositories();

      expect(repository.isDestroyed()).toBe(true);
      expect(provider.pathToRepository[repositoryPath]).toBeUndefined();
    });

    it("accumulates aliases discovered after the repository was cached", async () => {
      const workingDirectory = copyWorkingRepository();
      const repository = await provider.repositoryForPath(workingDirectory);
      const aliasParent = temp.mkdirSync("provider-alias-parent-");
      const aliasPath = path.join(aliasParent, "repository-link");
      fs.symlinkSync(
        workingDirectory,
        aliasPath,
        process.platform === "win32" ? "junction" : "dir",
      );

      const throughAlias = await provider.repositoryForPath(path.join(aliasPath, "a.txt"));
      expect(repository.relativize(path.join(aliasPath, "a.txt"))).toBe(
        path.resolve(aliasPath, "a.txt").replace(/\\/g, "/"),
      );
      provider.abandonRepositoryForPath(throughAlias, path.join(aliasPath, "a.txt"));
      provider.commitRepositoryForPath(throughAlias, path.join(aliasPath, "a.txt"));
      expect(repository.relativize(path.join(aliasPath, "a.txt"))).toBe(
        path.resolve(aliasPath, "a.txt").replace(/\\/g, "/"),
      );

      const rediscovered = await provider.repositoryForPath(path.join(aliasPath, "a.txt"));
      provider.commitRepositoryForPath(rediscovered, path.join(aliasPath, "a.txt"));

      expect(rediscovered).toBe(repository);
      expect(repository.relativize(path.join(aliasPath, "a.txt"))).toBe("a.txt");
      expect(
        repository
          .getWorkingDirectoryAliases()
          .some((alias) => path.resolve(alias) === path.resolve(aliasPath)),
      ).toBe(true);
      expect(
        repository
          .getGitDirectoryAliases()
          .some((alias) => path.resolve(alias) === path.resolve(path.join(aliasPath, ".git"))),
      ).toBe(true);
    });
  });
});
