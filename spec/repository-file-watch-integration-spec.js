// Real native batches pass through the application worker, project emitter and
// Git provider into the registry. Filesystem changes are never emitted by hand.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Emitter } = require("@lumine-code/event-kit");
const FileWatchService = require("../src/file-watch-service");
const GitRepositoryProvider = require("../src/git-repository-provider");
const RepositoryRegistry = require("../src/repository-registry");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(condition, message) {
  const deadline = Date.now() + 12000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await delay(10);
  }
}

describe("Native file watcher and Git registry integration", () => {
  let fixture;
  let rootPath;
  let service;
  let client;
  let project;
  let provider;
  let registry;
  let batches;
  let errors;

  beforeEach(async () => {
    jasmine.useRealClock?.();
    fixture = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-watcher-registry-")),
    );
    rootPath = path.join(fixture, "project");
    fs.mkdirSync(rootPath);
    service = new FileWatchService({ retryDelays: [20, 40, 80], stableDelay: 1000 });
    client = service.createClient("repository-registry-integration");
    const emitter = new Emitter();
    project = {
      getBuffers: () => [],
      getDirectories: () => [{ getPath: () => rootPath }],
      onDidAddBuffer: (callback) => emitter.on("did-add-buffer", callback),
      onDidChangeFiles: (callback) => emitter.on("did-change-files", callback),
      onDidInvalidateFiles: (callback) => emitter.on("did-invalidate-files", callback),
      repositoryForPathFromProviders: (filePath) => provider.repositoryForPath(filePath),
      repositoryForPathFromProvidersCached: (filePath) => provider.getRepositoryForPath(filePath),
      commitRepositoryForPath: (repository, filePath) =>
        provider.commitRepositoryForPath(repository, filePath),
      abandonRepositoryForPath: (repository, filePath) =>
        provider.abandonRepositoryForPath(repository, filePath),
      invalidateRepositoryPathCache() {},
      clearRepositoryPathCache() {},
      emitter,
    };
    const values = { "git.watchDiscovery": true, "git.watchDepth": 4, "git.scanDepth": 4 };
    registry = new RepositoryRegistry({ project, config: { get: (key) => values[key] } });
    provider = new GitRepositoryProvider({
      isRegistered: (repository) => registry.hasRepository(repository),
    });
    registry.setProjectRoots(project.getDirectories(), { scan: false });
    batches = [];
    errors = [];
    const root = client.watchDirectory(rootPath, { recursive: true });
    root.onDidChange((events) => {
      batches.push(events);
      emitter.emit("did-change-files", events);
    });
    root.onDidInvalidate(({ reason, generation }) =>
      emitter.emit("did-invalidate-files", { rootPaths: [rootPath], reason, generation }),
    );
    root.onDidError((error) => errors.push(error));
    await root.ready;
  });

  afterEach(async () => {
    await client.close();
    await registry.fileChangeValidationTail;
    await registry.fileWatchRecovery;
    registry.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    provider.sweepUnregisteredRepositories();
    project.emitter.dispose();
    if (service.worker) {
      const diagnostics = await service.requestWorker("diagnostics");
      expect(diagnostics.subscriptions).toBe(0);
      expect(diagnostics.sources).toEqual([]);
    }
    await service.close();
    expect(errors).toEqual([]);
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function gitInit(workdir) {
    const result = spawnSync("git", ["init", "--quiet", "--initial-branch=main", workdir], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status).withContext(result.stderr).toBe(0);
  }

  async function settled() {
    await until(async () => {
      const tail = registry.fileChangeValidationTail;
      await tail;
      await registry.fileWatchRecovery;
      await delay(50);
      return tail === registry.fileChangeValidationTail && !registry.fileWatchRecovery;
    }, "registry lifecycle queue becoming idle");
  }

  async function repositoryAt(workdir) {
    await until(() => registry.getForPath(workdir), `repository discovery at ${workdir}`);
    await settled();
    return registry.getForPath(workdir);
  }

  function hasRootEvent(action, filePath) {
    return batches.some((events) =>
      events.some((event) => event.action === action && event.path === filePath),
    );
  }

  function observeFile(filePath) {
    const handle = client.watchFile(filePath);
    const changes = [];
    handle.onDidChange((events) => changes.push(...events));
    handle.onDidError((error) => errors.push(error));
    return { handle, changes };
  }

  it("discovers git init that finishes after the native .git directory batch", async () => {
    const workdir = path.join(rootPath, "initialized");
    const marker = path.join(workdir, ".git");
    fs.mkdirSync(marker, { recursive: true });
    await until(() => hasRootEvent("created", marker), "empty .git creation batch");
    await settled();
    expect(registry.getForPath(workdir)).toBeNull();

    gitInit(workdir);
    const repository = await repositoryAt(workdir);
    expect(path.normalize(repository.getWorkingDirectory())).toBe(workdir);
    expect(registry.getRepositories()).toEqual([repository]);
  }, 20000);

  it("removes and recreates .git while an armed HEAD handle retains its fixed path", async () => {
    const workdir = path.join(rootPath, "reinitialized");
    gitInit(workdir);
    const original = await repositoryAt(workdir);
    const originalIdentity = original.getGitDirectoryIdentity();
    const marker = path.join(workdir, ".git");
    const head = observeFile(path.join(marker, "HEAD"));
    await head.handle.ready;

    fs.rmSync(marker, { recursive: true });
    await until(
      () =>
        registry.getForPath(workdir) === null &&
        head.changes.some((event) => event.action === "deleted"),
      "deleted metadata leaving the registry and fixed HEAD observer",
    );
    await settled();
    expect(original.isDestroyed()).toBe(true);
    expect(registry.hasRepository(original)).toBe(false);
    gitInit(workdir);
    const replacement = await repositoryAt(workdir);
    await until(
      () => head.changes.some((event) => event.action === "created"),
      "recreated HEAD at the requested filename",
    );
    expect(replacement).not.toBe(original);
    expect(replacement.getGitDirectoryIdentity()).not.toEqual(originalIdentity);
    expect(head.handle.path).toBe(path.join(marker, "HEAD"));
  }, 20000);

  it("renames a nested repository with native HEAD and working-file subscriptions armed", async () => {
    const originalPath = path.join(rootPath, "original");
    const destination = path.join(rootPath, "renamed");
    gitInit(originalPath);
    const libPath = path.join(originalPath, "lib", "live.txt");
    fs.mkdirSync(path.dirname(libPath));
    fs.writeFileSync(libPath, "before move");
    const original = await repositoryAt(originalPath);
    const identity = original.getGitDirectoryIdentity();
    const head = observeFile(path.join(originalPath, ".git", "HEAD"));
    const lib = observeFile(libPath);
    await Promise.all([head.handle.ready, lib.handle.ready]);
    const armed = await service.requestWorker("diagnostics");
    const rootSources = armed.sources.filter(
      (source) => source.path === rootPath || source.path.startsWith(rootPath + path.sep),
    );
    expect(rootSources.length).toBe(1);
    expect(rootSources[0].path).toBe(rootPath);
    expect(rootSources[0].recursive).toBe(true);
    expect(rootSources[0].subscribers).toBe(3);

    fs.renameSync(originalPath, destination);
    const moved = await repositoryAt(destination);
    await until(
      () =>
        head.changes.some((event) => event.action === "deleted") &&
        lib.changes.some((event) => event.action === "deleted"),
      "fixed document paths becoming missing after the repository rename",
    );
    expect(original.isDestroyed()).toBe(true);
    expect(moved).not.toBe(original);
    expect(moved.getGitDirectoryIdentity()).toEqual(identity);
    expect(registry.getForPath(originalPath)).toBeNull();
    expect(registry.getRepositories()).toEqual([moved]);
    expect(head.handle.path).toBe(path.join(originalPath, ".git", "HEAD"));
    expect(lib.handle.path).toBe(libPath);
  }, 20000);

  it("keeps copied repositories distinct and removes only the checkout moved outside the root", async () => {
    const originalPath = path.join(rootPath, "original");
    const copyPath = path.join(rootPath, "copied");
    gitInit(originalPath);
    const original = await repositoryAt(originalPath);
    fs.cpSync(originalPath, copyPath, { recursive: true });
    const copied = await repositoryAt(copyPath);
    expect(copied).not.toBe(original);
    expect(copied.getGitDirectoryIdentity()).not.toEqual(original.getGitDirectoryIdentity());
    expect(registry.getRepositories().length).toBe(2);

    const outside = path.join(fixture, "outside");
    fs.renameSync(originalPath, outside);
    await until(() => registry.getForPath(originalPath) === null, "checkout moved out of root");
    await settled();
    expect(original.isDestroyed()).toBe(true);
    expect(copied.isDestroyed()).toBe(false);
    expect(registry.getRepositories()).toEqual([copied]);
    expect(registry.getForPath(outside)).toBeNull();
  }, 20000);
});
