const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Emitter } = require("@lumine-code/event-kit");
const RepositoryRegistry = require("../src/repository-registry");
const GitRepositoryProvider = require("../src/git-repository-provider");
const { deferred } = require("../src/file-watch-protocol");

describe("Repository filesystem lifecycle", () => {
  let directory;
  let rootPath;
  let project;
  let provider;
  let registry;

  beforeEach(() => {
    jasmine.useRealClock?.();
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-repository-lifecycle-")),
    );
    rootPath = path.join(directory, "project");
    fs.mkdirSync(rootPath);
    const emitter = new Emitter();
    project = {
      getBuffers: () => [],
      getDirectories: () => [{ getPath: () => rootPath }],
      onDidAddBuffer: (callback) => emitter.on("did-add-buffer", callback),
      onDidChangeFiles: (callback) => emitter.on("did-change-files", callback),
      repositoryForPathFromProviders: (filePath) => provider.repositoryForPath(filePath),
      repositoryForPathFromProvidersCached: (filePath) => provider.getRepositoryForPath(filePath),
      commitRepositoryForPath: (repository, filePath) =>
        provider.commitRepositoryForPath(repository, filePath),
      abandonRepositoryForPath: (repository, filePath) =>
        provider.abandonRepositoryForPath(repository, filePath),
      invalidateRepositoryPathCache() {},
      emitter,
    };
    const values = { "git.watchDiscovery": true, "git.watchDepth": 2, "git.scanDepth": 2 };
    registry = new RepositoryRegistry({ project, config: { get: (key) => values[key] } });
    provider = new GitRepositoryProvider({
      isRegistered: (repository) => registry.hasRepository(repository),
    });
    registry.setProjectRoots(project.getDirectories(), { scan: false });
  });

  afterEach(async () => {
    registry.destroy();
    await registry.fileChangeValidationTail;
    await new Promise((resolve) => setImmediate(resolve));
    provider.sweepUnregisteredRepositories();
    project.emitter.dispose();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function copyRepository(targetPath) {
    fs.cpSync(path.join(__dirname, "fixtures", "git", "working-dir"), targetPath, {
      recursive: true,
    });
    fs.renameSync(path.join(targetPath, "git.git"), path.join(targetPath, ".git"));
    return targetPath;
  }

  function gitInit(targetPath, { bare = false } = {}) {
    const result = spawnSync(
      "git",
      ["init", "--quiet", "--initial-branch=main", ...(bare ? ["--bare"] : []), targetPath],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(result.status).withContext(result.stderr).toBe(0);
  }

  for (const readyEntry of ["HEAD", "objects", "refs"]) {
    it(`discovers git init completed with ${readyEntry} after the .git directory's initial notification`, async () => {
      const workdir = path.join(rootPath, "initialized");
      fs.mkdirSync(path.join(workdir, ".git"), { recursive: true });
      await registry.handleProjectFileChanges([
        { action: "created", path: path.join(workdir, ".git") },
      ]);
      expect(registry.getForPath(workdir)).toBeNull();

      gitInit(workdir);
      await registry.handleProjectFileChanges([
        { action: "created", path: path.join(workdir, ".git", readyEntry) },
      ]);
      expect(path.normalize(registry.getForPath(workdir)?.getWorkingDirectory() || "")).toBe(
        workdir,
      );
    });

    it(`removes and rediscovers a repository whose ${readyEntry} is removed and restored`, async () => {
      const workdir = copyRepository(path.join(rootPath, "restored-metadata"));
      const original = await registry.resolveForPath(workdir);
      const metadata = path.join(workdir, ".git", readyEntry);
      const savedMetadata = path.join(directory, "saved-metadata");
      fs.renameSync(metadata, savedMetadata);
      await registry.handleProjectFileChanges([{ action: "deleted", path: metadata }]);
      expect(registry.getRepositories()).toEqual([]);
      expect(original.isDestroyed()).toBe(true);

      fs.renameSync(savedMetadata, metadata);
      await registry.handleProjectFileChanges([{ action: "created", path: metadata }]);
      const replacement = registry.getForPath(workdir);
      expect(replacement).not.toBeNull();
      expect(replacement).not.toBe(original);
      expect(replacement.getGitDirectoryIdentity()).toEqual(original.getGitDirectoryIdentity());
    });
  }

  it("discovers bare git init completed after the root-directory notification", async () => {
    const workdir = path.join(rootPath, "bare.git");
    fs.mkdirSync(workdir);
    await registry.handleProjectFileChanges([{ action: "created", path: workdir }]);
    expect(registry.getForPath(workdir)).toBeNull();
    gitInit(workdir, { bare: true });
    await registry.handleProjectFileChanges([
      { action: "created", path: path.join(workdir, "HEAD") },
    ]);
    const repository = registry.getForPath(workdir);
    expect(repository).not.toBeNull();
    expect(repository.getWorkingDirectory()).toBeNull();
    expect(path.normalize(repository.getPath())).toBe(workdir);
  });

  it("forgets registry ownership when .git is removed and registers its replacement", async () => {
    const workdir = copyRepository(path.join(rootPath, "reinitialized"));
    const original = await registry.resolveForPath(workdir);
    fs.rmSync(path.join(workdir, ".git"), { recursive: true });
    await registry.handleProjectFileChanges([
      { action: "deleted", path: path.join(workdir, ".git") },
    ]);
    expect(registry.getRepositories()).toEqual([]);
    expect(registry.hasRepository(original)).toBe(false);
    expect(original.isDestroyed()).toBe(true);

    gitInit(workdir);
    await registry.handleProjectFileChanges([
      { action: "created", path: path.join(workdir, ".git") },
    ]);
    const replacement = registry.getForPath(workdir);
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(original);
    expect(replacement.getGitDirectoryIdentity()).not.toEqual(original.getGitDirectoryIdentity());
  });

  it("does not resurrect a scan result whose .git disappeared while discovery was pending", async () => {
    const workdir = copyRepository(path.join(rootPath, "pending"));
    const started = deferred();
    const finish = deferred();
    const discover = project.repositoryForPathFromProviders;
    project.repositoryForPathFromProviders = async (filePath) => {
      const repository = await discover(filePath);
      if (filePath === workdir && repository) {
        started.resolve(repository);
        await finish.promise;
      }
      return repository;
    };
    const scan = registry.scanProjectRoots();
    const obsolete = await started.promise;
    try {
      fs.rmSync(path.join(workdir, ".git"), { recursive: true });
      await registry.handleProjectFileChanges([
        { action: "deleted", path: path.join(workdir, ".git") },
      ]);
    } finally {
      finish.resolve();
    }
    await scan;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.getRepositories()).toEqual([]);
    expect(obsolete.isDestroyed()).toBe(true);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
  });

  it("rejects a stale completed result waiting behind another scan candidate", async () => {
    const firstPath = copyRepository(path.join(rootPath, "a-first"));
    const laterPath = copyRepository(path.join(rootPath, "b-later"));
    const firstStarted = deferred();
    const laterStarted = deferred();
    const finish = deferred();
    const discover = project.repositoryForPathFromProviders;
    project.repositoryForPathFromProviders = async (filePath) => {
      const repository = await discover(filePath);
      if (filePath === firstPath && repository) {
        firstStarted.resolve(repository);
        await finish.promise;
      }
      if (filePath === laterPath && repository) laterStarted.resolve(repository);
      return repository;
    };
    const scan = registry.scanProjectRoots();
    const [first, obsolete] = await Promise.all([firstStarted.promise, laterStarted.promise]);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      fs.rmSync(path.join(laterPath, ".git"), { recursive: true });
      await registry.handleProjectFileChanges([
        { action: "deleted", path: path.join(laterPath, ".git") },
      ]);
    } finally {
      finish.resolve();
    }
    await scan;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.getRepositories()).toEqual([first]);
    expect(obsolete.isDestroyed()).toBe(true);
  });

  it("accepts a scan's fresh retry after a delayed .git creation hint", async () => {
    const workdir = copyRepository(path.join(rootPath, "delayed-creation"));
    const discovered = [];
    const discover = project.repositoryForPathFromProviders;
    project.repositoryForPathFromProviders = async (filePath) => {
      const repository = await discover(filePath);
      if (filePath === workdir && repository) {
        discovered.push(repository);
        if (discovered.length === 1) {
          registry.recordRepositoryDiscoveryChanges([
            { action: "created", path: path.join(workdir, ".git") },
          ]);
        }
      }
      return repository;
    };
    await registry.scanProjectRoots();
    expect(discovered.length).toBe(2);
    expect(discovered[0].isDestroyed()).toBe(true);
    expect(registry.getRepositories()).toEqual([discovered[1]]);
    expect(registry.getForPath(workdir)).toBe(discovered[1]);
  });

  it("does not retry an authoritative negative discovery after a topology hint", async () => {
    const workdir = copyRepository(path.join(rootPath, "negative-discovery"));
    const lookup = spyOn(project, "repositoryForPathFromProviders").and.callFake(async () => {
      registry.recordRepositoryDiscoveryChanges([
        { action: "created", path: path.join(workdir, ".git") },
      ]);
      return null;
    });
    expect(await registry.resolveForPath(workdir)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(registry.getRepositories()).toEqual([]);
  });

  it("does not retry a provider facade destroyed before its discovery returns", async () => {
    const workdir = copyRepository(path.join(rootPath, "destroyed-discovery"));
    const lookup = spyOn(project, "repositoryForPathFromProviders").and.callFake(
      async (filePath) => {
        const repository = await provider.repositoryForPath(filePath);
        registry.recordRepositoryDiscoveryChanges([
          { action: "created", path: path.join(workdir, ".git") },
        ]);
        repository.destroy();
        return repository;
      },
    );
    expect(await registry.resolveForPath(workdir)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(registry.getRepositories()).toEqual([]);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
  });

  it("rejects topology changed while the scan awaits its destination guard", async () => {
    const workdir = copyRepository(path.join(rootPath, "guard-race"));
    const started = deferred();
    const finish = deferred();
    const discovered = [];
    const discover = project.repositoryForPathFromProviders;
    project.repositoryForPathFromProviders = async (filePath) => {
      const repository = await discover(filePath);
      if (filePath === workdir && repository) discovered.push(repository);
      return repository;
    };
    let checks = 0;
    spyOn(registry, "isFileMoveDestinationAsync").and.callFake(async (filePath) => {
      if (filePath === workdir && ++checks === 2) {
        started.resolve();
        await finish.promise;
      }
      return false;
    });
    const scan = registry.scanProjectRoots();
    await started.promise;
    try {
      fs.rmSync(path.join(workdir, ".git"), { recursive: true });
      await registry.handleProjectFileChanges([
        { action: "deleted", path: path.join(workdir, ".git") },
      ]);
    } finally {
      finish.resolve();
    }
    await scan;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.getRepositories()).toEqual([]);
    expect(discovered.length).toBe(1);
    expect(discovered[0].isDestroyed()).toBe(true);
  });

  it("keeps discovery current through unrelated working-tree writes", async () => {
    const workdir = copyRepository(path.join(rootPath, "busy"));
    const started = deferred();
    const finish = deferred();
    const discover = project.repositoryForPathFromProviders;
    project.repositoryForPathFromProviders = async (filePath) => {
      const repository = await discover(filePath);
      if (filePath === workdir && repository) {
        started.resolve(repository);
        await finish.promise;
      }
      return repository;
    };
    const scan = registry.scanProjectRoots();
    const repository = await started.promise;
    try {
      fs.writeFileSync(path.join(workdir, "unrelated.txt"), "changed");
      await registry.handleProjectFileChanges([
        { action: "created", path: path.join(workdir, "unrelated.txt") },
        { action: "updated", path: path.join(workdir, "unrelated.txt") },
      ]);
    } finally {
      finish.resolve();
    }
    await scan;
    expect(registry.getRepositories()).toEqual([repository]);
    expect(repository.isDestroyed()).toBe(false);
  });

  it("keeps object bursts and existing HEAD writes out of filesystem rediscovery", async () => {
    const workdir = copyRepository(path.join(rootPath, "busy-metadata"));
    const repository = await registry.resolveForPath(workdir);
    const objects = path.join(workdir, ".git", "objects", "ab");
    fs.mkdirSync(objects, { recursive: true });
    const events = Array.from({ length: 1000 }, (_, index) => {
      const objectPath = path.join(objects, index.toString(16).padStart(38, "0"));
      fs.writeFileSync(objectPath, "object contents");
      return { action: "created", path: objectPath };
    });
    const discovery = spyOn(project, "repositoryForPathFromProviders").and.callThrough();
    const stat = spyOn(fs.promises, "stat").and.callThrough();
    const status = spyOn(repository, "scheduleStatusSnapshotRefresh").and.callThrough();
    const refs = spyOn(repository, "scheduleRefsSnapshotRefresh").and.callThrough();
    events.push({ action: "updated", path: path.join(workdir, ".git", "HEAD") });
    await registry.handleProjectFileChanges(events);
    expect(discovery).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
    expect(refs).toHaveBeenCalledTimes(1);
  });

  it("refreshes refs after a condensed update to the refs directory", async () => {
    const workdir = copyRepository(path.join(rootPath, "condensed-refs"));
    const repository = await registry.resolveForPath(workdir);
    const status = spyOn(repository, "scheduleStatusSnapshotRefresh").and.callThrough();
    const refs = spyOn(repository, "scheduleRefsSnapshotRefresh").and.callThrough();
    await registry.handleProjectFileChanges([
      { action: "updated", path: path.join(workdir, ".git", "refs") },
    ]);
    expect(status).toHaveBeenCalledTimes(1);
    expect(refs).toHaveBeenCalledTimes(1);
  });

  it("keeps copies distinct and does not correlate removal with an unrelated copy", async () => {
    const source = copyRepository(path.join(rootPath, "source"));
    const original = await registry.resolveForPath(source);
    const copiedPath = path.join(rootPath, "copy");
    fs.cpSync(source, copiedPath, { recursive: true });
    await registry.handleProjectFileChanges([{ action: "created", path: copiedPath }]);
    const copied = registry.getForPath(copiedPath);
    expect(copied).not.toBeNull();
    expect(copied).not.toBe(original);
    expect(copied.getGitDirectoryIdentity()).not.toEqual(original.getGitDirectoryIdentity());
    expect(registry.getRepositories().length).toBe(2);

    fs.rmSync(source, { recursive: true });
    await registry.handleProjectFileChanges([{ action: "deleted", path: source }]);
    expect(registry.getRepositories()).toEqual([copied]);
    expect(copied.isDestroyed()).toBe(false);
    expect(original.isDestroyed()).toBe(true);
  });

  it("replaces a moved repository within the project and removes one moved outside it", async () => {
    const source = copyRepository(path.join(rootPath, "source"));
    const original = await registry.resolveForPath(source);
    const movedPath = path.join(rootPath, "moved");
    fs.renameSync(source, movedPath);
    await registry.handleProjectFileChanges([
      { action: "deleted", path: source },
      { action: "created", path: movedPath },
    ]);
    const moved = registry.getForPath(movedPath);
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(original);
    expect(moved.getGitDirectoryIdentity()).toEqual(original.getGitDirectoryIdentity());
    expect(original.isDestroyed()).toBe(true);
    expect(registry.getForPath(source)).toBeNull();

    fs.renameSync(movedPath, path.join(directory, "outside"));
    await registry.handleProjectFileChanges([{ action: "deleted", path: movedPath }]);
    expect(registry.getRepositories()).toEqual([]);
    expect(moved.isDestroyed()).toBe(true);
  });

  it("discovers a repository moved into the project from an external directory", async () => {
    const outside = copyRepository(path.join(directory, "outside"));
    const destination = path.join(rootPath, "arrived");
    fs.renameSync(outside, destination);
    await registry.handleProjectFileChanges([{ action: "created", path: destination }]);
    expect(path.normalize(registry.getForPath(destination)?.getWorkingDirectory() || "")).toBe(
      destination,
    );
    expect(registry.getRepositories().length).toBe(1);
  });

  it("rejects a queued write after the repository is replaced without invoking its provider", async () => {
    const workdir = copyRepository(path.join(rootPath, "queued"));
    const repository = await registry.resolveForPath(workdir);
    const started = deferred();
    const finish = deferred();
    const writes = [];
    const create = jasmine.createSpy("create operation implementation").and.callFake(() => ({
      async commit(message) {
        writes.push(message);
        if (message === "first") {
          started.resolve();
          await finish.promise;
        }
        return message;
      },
      getOperationRefreshHint: () => "none",
    }));
    registry.addOperationProvider({ createRepositoryOperations: create });
    const first = registry.performOperation(repository, "commit", ["first"]);
    await started.promise;
    const queued = registry.performOperation(repository, "commit", ["queued"]).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      fs.rmSync(path.join(workdir, ".git"), { recursive: true });
      gitInit(workdir);
      await registry.handleProjectFileChanges([
        { action: "deleted", path: path.join(workdir, ".git") },
        { action: "created", path: path.join(workdir, ".git") },
      ]);
      expect(repository.isDestroyed()).toBe(true);
    } finally {
      finish.resolve();
    }
    await first;
    const outcome = await queued;
    expect(outcome.error?.code).toBe("ERR_GIT_REPOSITORY_DESTROYED");
    expect(writes).toEqual(["first"]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
