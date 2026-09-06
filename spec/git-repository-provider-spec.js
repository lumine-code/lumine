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
        expect(Object.values(provider.pathToRepository)).toContain(result);
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
        expect(Object.values(provider.pathToRepository)).toContain(result);
        expect(result.getType()).toBe("git");
      });
    });

    describe("when specified a Directory with a commondir file for a worktree", () => {
      it("returns a Promise that resolves to a GitRepository", async () => {
        const root = temp.mkdirSync("provider-linked-worktree-");
        const commonDirectory = path.join(root, "master.git");
        const workingDirectory = path.join(root, "worktree");
        fs.copySync(path.join(__dirname, "fixtures", "git", "master.git"), commonDirectory);
        fs.mkdirSync(workingDirectory);
        const gitDirectory = path.join(commonDirectory, "worktrees", "worktree-dir");
        const markerPath = path.join(workingDirectory, ".git");
        fs.writeFileSync(markerPath, `gitdir: ${gitDirectory}\n`);
        fs.writeFileSync(path.join(gitDirectory, "gitdir"), `${markerPath}\n`);
        const directory = new ProjectDirectory(gitDirectory);
        const result = await provider.repositoryForPath(directory.getPath());
        expect(result).toEqual(jasmine.any(GitRepository));
        expect(result.getWorkingDirectory()).toBe(
          fs.realpathSync.native(workingDirectory).replace(/\\/g, "/"),
        );
        expect(Object.values(provider.pathToRepository)).toContain(result);
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

      expect(provider.getRepositoryForPath(path.join(rootPath, "objects", "nested"))).toBeNull();
      provider.commitRepositoryForPath(repository, rootPath);
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
      expect(repository.isDestroyed()).toBe(false);

      provider.sweepUnregisteredRepositories();

      expect(repository.isDestroyed()).toBe(true);
      expect(Object.values(provider.pathToRepository)).not.toContain(repository);
    });

    it("keys repositories by both Git directory and working directory", async () => {
      const gitDirectory = path.join(__dirname, "fixtures", "git", "master.git");
      const firstWorktree = temp.mkdirSync("provider-first-worktree-");
      const secondWorktree = temp.mkdirSync("provider-second-worktree-");
      fs.writeFileSync(path.join(firstWorktree, ".git"), `gitdir: ${gitDirectory}\n`);
      fs.writeFileSync(path.join(secondWorktree, ".git"), `gitdir: ${gitDirectory}\n`);

      const firstRepository = await provider.repositoryForPath(firstWorktree);
      provider.commitRepositoryForPath(firstRepository, firstWorktree);
      const destroyFirst = spyOn(firstRepository, "destroy").and.callThrough();

      const secondRepository = await provider.repositoryForPath(secondWorktree);

      expect(secondRepository).not.toBe(firstRepository);
      expect(firstRepository.isDestroyed()).toBe(false);
      expect(destroyFirst).not.toHaveBeenCalled();
      expect(provider.getRepositoryForPath(secondWorktree)).toBeNull();

      provider.commitRepositoryForPath(secondRepository, secondWorktree);

      expect(destroyFirst).toHaveBeenCalledTimes(1);
      expect(firstRepository.isDestroyed()).toBe(true);
      expect(secondRepository.isDestroyed()).toBe(false);
      expect(provider.getRepositoryForPath(secondWorktree)).toBe(secondRepository);
      expect(Object.values(provider.pathToRepository)).toEqual([secondRepository]);
    });

    it("keeps the committed worktree when a replacement discovery is abandoned", async () => {
      let registeredRepository = null;
      provider = new GitRepositoryProvider({
        isRegistered: (repository) => repository === registeredRepository,
      });
      const gitDirectory = path.join(__dirname, "fixtures", "git", "master.git");
      const firstWorktree = temp.mkdirSync("provider-current-worktree-");
      const staleWorktree = temp.mkdirSync("provider-stale-worktree-");
      fs.writeFileSync(path.join(firstWorktree, ".git"), `gitdir: ${gitDirectory}\n`);
      fs.writeFileSync(path.join(staleWorktree, ".git"), `gitdir: ${gitDirectory}\n`);

      const firstRepository = await provider.repositoryForPath(firstWorktree);
      provider.commitRepositoryForPath(firstRepository, firstWorktree);
      registeredRepository = firstRepository;
      const destroyFirst = spyOn(firstRepository, "destroy").and.callThrough();

      const abandonedRepository = await provider.repositoryForPath(staleWorktree);
      const destroyAbandoned = spyOn(abandonedRepository, "destroy").and.callThrough();
      expect(provider.abandonRepositoryForPath(abandonedRepository, staleWorktree)).toBe(true);

      expect(destroyFirst).not.toHaveBeenCalled();
      expect(firstRepository.isDestroyed()).toBe(false);
      expect(destroyAbandoned).toHaveBeenCalledTimes(1);
      expect(abandonedRepository.isDestroyed()).toBe(true);
      expect(Object.values(provider.pathToRepository)).toEqual([firstRepository]);
    });

    it("does not destroy a pending replacement when the current identity is recommitted", async () => {
      const gitDirectory = path.join(__dirname, "fixtures", "git", "master.git");
      const currentWorktree = temp.mkdirSync("provider-recommitted-worktree-");
      const replacementWorktree = temp.mkdirSync("provider-pending-worktree-");
      fs.writeFileSync(path.join(currentWorktree, ".git"), `gitdir: ${gitDirectory}\n`);
      fs.writeFileSync(path.join(replacementWorktree, ".git"), `gitdir: ${gitDirectory}\n`);

      const currentRepository = await provider.repositoryForPath(currentWorktree);
      provider.commitRepositoryForPath(currentRepository, currentWorktree);
      const pendingRepository = await provider.repositoryForPath(replacementWorktree);
      const destroyPending = spyOn(pendingRepository, "destroy").and.callThrough();

      expect(await provider.repositoryForPath(currentWorktree)).toBe(currentRepository);
      provider.commitRepositoryForPath(currentRepository, currentWorktree);

      expect(destroyPending).not.toHaveBeenCalled();
      expect(pendingRepository.isDestroyed()).toBe(false);

      provider.commitRepositoryForPath(pendingRepository, replacementWorktree);
      expect(currentRepository.isDestroyed()).toBe(true);
      expect(pendingRepository.isDestroyed()).toBe(false);
    });

    it("never returns the candidate evicted by the pending descriptor cap", async () => {
      provider = new GitRepositoryProvider({
        isRegistered: () => false,
        maxPendingDescriptors: 1,
      });
      const workingDirectory = copyWorkingRepository();
      const firstRepository = await provider.repositoryForPath(
        path.join(workingDirectory, "first.txt"),
      );

      const secondRepository = await provider.repositoryForPath(
        path.join(workingDirectory, "second.txt"),
      );

      expect(firstRepository.isDestroyed()).toBe(true);
      expect(secondRepository).not.toBe(firstRepository);
      expect(secondRepository.isDestroyed()).toBe(false);
      expect(Object.values(provider.pathToRepository)).toEqual([secondRepository]);
    });

    it("reuses an ordinary repository with the same exact identity", async () => {
      const workingDirectory = copyWorkingRepository();
      const firstRepository = await provider.repositoryForPath(workingDirectory);
      provider.commitRepositoryForPath(firstRepository, workingDirectory);

      const nestedPath = path.join(workingDirectory, "nested", "file.txt");
      const secondRepository = await provider.repositoryForPath(nestedPath);
      provider.commitRepositoryForPath(secondRepository, nestedPath);

      expect(secondRepository).toBe(firstRepository);
      expect(Object.values(provider.pathToRepository)).toEqual([firstRepository]);
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
