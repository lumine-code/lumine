const fs = require("fs");
const os = require("os");
const path = require("path");
const { Emitter } = require("@lumine-code/event-kit");
const RepositoryDiscovery = require("../src/repository-discovery");
const RepositoryRegistry = require("../src/repository-registry");
const { deferred } = require("../src/file-watch-protocol");

describe("Repository scan discovery ownership", () => {
  let directory, rootPath, emitter, project, registry, discovery, provider, notifications;
  let started, finish;

  beforeEach(() => {
    jasmine.useRealClock?.();
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-scan-lifecycle-")),
    );
    rootPath = path.join(directory, "project");
    fs.cpSync(path.join(__dirname, "fixtures", "git", "working-dir"), rootPath, {
      recursive: true,
    });
    fs.renameSync(path.join(rootPath, "git.git"), path.join(rootPath, ".git"));
    emitter = new Emitter();
    notifications = { addWarning: jasmine.createSpy("addWarning") };
    registry = new RepositoryRegistry({
      config: { get: (key) => (key === "git.scanDepth" ? 0 : undefined) },
      notificationManager: notifications,
    });
    discovery = new RepositoryDiscovery({ registry });
    provider = discovery.repositoryProviders[0];
    project = {
      getBuffers: () => [],
      getDirectories: () => [{ getPath: () => rootPath }],
      onDidAddBuffer: (callback) => emitter.on("did-add-buffer", callback),
      onDidChangeFiles: (callback) => emitter.on("did-change-files", callback),
      repositoryForPathFromProviders: (...args) =>
        discovery.repositoryForPathFromProviders(...args),
      repositoryForPathFromProvidersCached: (...args) =>
        discovery.repositoryForPathFromProvidersCached(...args),
      commitRepositoryForPath: (...args) => discovery.commitRepositoryForPath(...args),
      abandonRepositoryForPath: (...args) => discovery.abandonRepositoryForPath(...args),
      invalidateRepositoryPathCache: (...args) => discovery.invalidateRepositoryPathCache(...args),
    };
    registry.attachProject(project);
    started = deferred();
    finish = deferred();
    const discover = provider.repositoryForPath.bind(provider);
    spyOn(provider, "repositoryForPath").and.callFake(async (filePath) => {
      const repository = await discover(filePath);
      started.resolve(repository);
      await finish.promise;
      return repository;
    });
  });

  afterEach(async () => {
    finish.resolve();
    registry.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    discovery.clearRepositoryPathCache({ invalidateProviders: true });
    provider.sweepUnregisteredRepositories();
    emitter.dispose();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("keeps the current startup scan's repository when an older scan abandons their shared lookup", async () => {
    const scans = [];
    const scanProjectRoots = registry.scanProjectRoots.bind(registry);
    spyOn(registry, "scanProjectRoots").and.callFake((...args) => {
      const scan = scanProjectRoots(...args);
      scans.push(scan);
      return scan;
    });
    const secondLookup = deferred();
    let lookups = 0;
    const lookup = project.repositoryForPathFromProviders;
    spyOn(project, "repositoryForPathFromProviders").and.callFake((...args) => {
      const result = lookup(...args);
      if (++lookups === 2) secondLookup.resolve();
      return result;
    });

    registry.setProjectRoots(project.getDirectories());
    const repository = await started.promise;
    registry.setProjectRoots(project.getDirectories());
    await secondLookup.promise;
    finish.resolve();
    const results = await Promise.allSettled(scans);
    await new Promise((resolve) => setImmediate(resolve));

    expect(provider.repositoryForPath).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(notifications.addWarning).not.toHaveBeenCalled();
    expect(registry.getForPath(rootPath)).toBe(repository);
    expect(repository.isDestroyed()).toBe(false);
  });

  it("lets one joined caller abandon a discovery while another caller commits it", async () => {
    const firstLookup = project.repositoryForPathFromProviders(rootPath, { refresh: true });
    await started.promise;
    const secondLookup = project.repositoryForPathFromProviders(rootPath, {
      refresh: true,
      joinPending: true,
    });
    finish.resolve();
    const [first, second] = await Promise.all([firstLookup, secondLookup]);

    expect(first).toBe(second);
    project.abandonRepositoryForPath(first, rootPath);
    expect(second.isDestroyed()).toBe(false);
    project.commitRepositoryForPath(second, rootPath);
    registry.register(second);

    expect(registry.getForPath(rootPath)).toBe(second);
    expect(provider.getRepositoryForPath(rootPath)).toBe(second);
  });

  it("releases an unregistered discovery after every joined caller abandons it", async () => {
    const firstLookup = project.repositoryForPathFromProviders(rootPath, { refresh: true });
    await started.promise;
    const secondLookup = project.repositoryForPathFromProviders(rootPath, {
      refresh: true,
      joinPending: true,
    });
    finish.resolve();
    const [first, second] = await Promise.all([firstLookup, secondLookup]);
    const destroyed = jasmine.createSpy("destroyed");
    second.onDidDestroy(destroyed);

    project.abandonRepositoryForPath(first, rootPath);
    expect(second.isDestroyed()).toBe(false);
    project.abandonRepositoryForPath(second, rootPath);

    expect(second.isDestroyed()).toBe(true);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
    expect(discovery.repositoryPromisesByPath.size).toBe(0);
  });

  it("keeps a settled candidate alive for a later caller using the exact-path cache", async () => {
    const firstLookup = project.repositoryForPathFromProviders(rootPath, { refresh: true });
    await started.promise;
    finish.resolve();
    const first = await firstLookup;
    const second = await project.repositoryForPathFromProviders(rootPath);

    project.abandonRepositoryForPath(first, rootPath);
    expect(second.isDestroyed()).toBe(false);
    project.commitRepositoryForPath(second, rootPath);
    registry.register(second);

    expect(provider.repositoryForPath).toHaveBeenCalledTimes(1);
    expect(registry.getForPath(rootPath)).toBe(second);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
  });

  it("settles every provider claim when independent lookups resolve to the same candidate", async () => {
    const firstLookup = project.repositoryForPathFromProviders(rootPath, { refresh: true });
    await started.promise;
    const secondLookup = project.repositoryForPathFromProviders(rootPath, { refresh: true });
    finish.resolve();
    const [first, second] = await Promise.all([firstLookup, secondLookup]);

    expect(first).toBe(second);
    project.abandonRepositoryForPath(first, rootPath);
    expect(second.isDestroyed()).toBe(false);
    project.commitRepositoryForPath(second, rootPath);
    registry.register(second);

    expect(provider.repositoryForPath).toHaveBeenCalledTimes(2);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
    expect(registry.getForPath(rootPath)).toBe(second);
  });

  it("preserves a replacement's path cache when the previous candidate is abandoned", async () => {
    const firstLookup = project.repositoryForPathFromProviders(rootPath, { refresh: true });
    await started.promise;
    finish.resolve();
    const first = await firstLookup;
    fs.renameSync(path.join(rootPath, ".git"), path.join(directory, "old-metadata.git"));
    fs.cpSync(
      path.join(__dirname, "fixtures", "git", "working-dir", "git.git"),
      path.join(rootPath, ".git"),
      {
        recursive: true,
      },
    );
    const replacement = await project.repositoryForPathFromProviders(rootPath, { refresh: true });

    project.abandonRepositoryForPath(first, rootPath);
    const cached = await project.repositoryForPathFromProviders(rootPath);
    project.abandonRepositoryForPath(cached, rootPath);
    project.commitRepositoryForPath(replacement, rootPath);
    registry.register(replacement);

    expect(replacement).not.toBe(first);
    expect(cached).toBe(replacement);
    expect(provider.repositoryForPath).toHaveBeenCalledTimes(2);
    expect(first.isDestroyed()).toBe(true);
    expect(replacement.isDestroyed()).toBe(false);
    expect(registry.getForPath(rootPath)).toBe(replacement);
  });

  it("releases a pending candidate through its original provider after that provider disappears", async () => {
    discovery = new RepositoryDiscovery({ registry, providers: [] });
    const registration = discovery.addProvider(provider);
    const lookup = project.repositoryForPathFromProviders(rootPath, { refresh: true });
    const repository = await started.promise;

    registration.dispose();
    finish.resolve();
    expect(await lookup).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));

    expect(repository.isDestroyed()).toBe(true);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
    expect(discovery.repositoryPromisesByPath.size).toBe(0);
  });

  it("discards a candidate destroyed while the scan awaits its final readiness guard", async () => {
    const guardStarted = deferred();
    const finishGuard = deferred();
    let checks = 0;
    spyOn(registry, "isFileMoveDestinationAsync").and.callFake(async () => {
      if (++checks === 2) {
        guardStarted.resolve();
        await finishGuard.promise;
      }
      return false;
    });
    registry.setProjectRoots(project.getDirectories(), { scan: false });
    const scan = registry.scanProjectRoots();
    const repository = await started.promise;
    finish.resolve();
    await guardStarted.promise;
    try {
      repository.destroy();
    } finally {
      finishGuard.resolve();
    }

    expect(await scan).toEqual([]);
    expect(registry.getForPath(rootPath)).toBeNull();
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
  });

  for (const state of ["current", "superseded", "destroyed"]) {
    it(`reports a background scan rejection only while its registry generation is current (${state})`, async () => {
      const scanStarted = deferred();
      const rejected = deferred();
      const failure = new Error("Repository provider failed");
      spyOn(registry, "scanProjectRoots").and.callFake(() => {
        scanStarted.resolve();
        return rejected.promise;
      });
      registry.setProjectRoots(project.getDirectories());
      await scanStarted.promise;
      if (state === "superseded") {
        registry.setProjectRoots(project.getDirectories(), { scan: false });
      } else if (state === "destroyed") {
        registry.destroy();
      }
      rejected.reject(failure);
      await new Promise((resolve) => setImmediate(resolve));

      if (state === "current") {
        expect(notifications.addWarning).toHaveBeenCalledOnceWith("Repository scan failed", {
          detail: failure.message,
          dismissable: true,
        });
      } else {
        expect(notifications.addWarning).not.toHaveBeenCalled();
      }
    });
  }
});
