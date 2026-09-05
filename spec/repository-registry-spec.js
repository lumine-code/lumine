const fs = require("fs");
const path = require("path");

const { Disposable, Emitter } = require("@lumine-code/event-kit");
const temp = require("@lumine-code/temp").track();

const RepositoryRegistry = require("../src/repository-registry");
const ServiceHub = require("../src/service-hub");

class FakeRepository {
  // A linked worktree's Git directory is not `<workdir>/.git` but a directory
  // under the main repository's, so it is passed in for those.
  constructor(workingDirectory, gitDirectory = path.join(workingDirectory, ".git")) {
    this.workingDirectory = workingDirectory;
    this.gitDirectory = gitDirectory;
    fs.mkdirSync(this.gitDirectory, { recursive: true });
    this.emitter = new Emitter();
    this.destroyed = false;
    this.operations = null;
    this.refreshIndexCount = 0;
    this.refreshStatusCount = 0;
    this.refreshStatusSnapshotCount = 0;
    this.refreshRefsSnapshotCount = 0;
    this.scheduledStatusSnapshotRefreshCount = 0;
    this.scheduledRefsSnapshotRefreshCount = 0;
    this.statusSnapshot = { initialized: true };
    this.refsSnapshot = { initialized: true };
    this.workingDirectoryAliases = new Set();
    this.extraGitDirectoryAliases = new Set();
  }

  getStatusSnapshot() {
    return this.statusSnapshot;
  }

  getRefsSnapshot() {
    return this.refsSnapshot;
  }

  async refreshStatusSnapshot() {
    this.refreshStatusSnapshotCount++;
  }

  async refreshRefsSnapshot() {
    this.refreshRefsSnapshotCount++;
  }

  scheduleStatusSnapshotRefresh() {
    this.scheduledStatusSnapshotRefreshCount++;
  }

  scheduleRefsSnapshotRefresh() {
    this.scheduledRefsSnapshotRefreshCount++;
  }

  getWorkingDirectory() {
    return this.workingDirectory;
  }

  addWorkingDirectoryAlias(directoryPath) {
    this.workingDirectoryAliases.add(directoryPath);
  }

  removeWorkingDirectoryAlias(directoryPath) {
    const normalized = normalize(directoryPath);
    for (const alias of this.workingDirectoryAliases) {
      if (normalize(alias) === normalized) this.workingDirectoryAliases.delete(alias);
    }
    if (
      this.openedWorkingDirectoryPath &&
      normalize(this.openedWorkingDirectoryPath) === normalized
    ) {
      this.openedWorkingDirectoryPath = null;
    }
  }

  getWorkingDirectoryAliases() {
    return [
      this.workingDirectory || this.gitDirectory,
      this.openedWorkingDirectoryPath,
      ...this.workingDirectoryAliases,
    ].filter(Boolean);
  }

  addGitDirectoryAlias(directoryPath) {
    this.extraGitDirectoryAliases.add(directoryPath);
  }

  removeGitDirectoryAlias(directoryPath) {
    const normalized = normalize(directoryPath);
    for (const alias of this.extraGitDirectoryAliases) {
      if (normalize(alias) === normalized) this.extraGitDirectoryAliases.delete(alias);
    }
  }

  getGitDirectoryAliases() {
    return [this.gitDirectory, ...this.extraGitDirectoryAliases];
  }

  getPath() {
    return this.gitDirectory;
  }

  isDestroyed() {
    return this.destroyed;
  }

  isPresent() {
    return fs.existsSync(this.gitDirectory);
  }

  setOperations(operations) {
    this.operations = operations;
  }

  getOperations() {
    return this.operations;
  }

  refreshIndex() {
    this.refreshIndexCount++;
  }

  async refreshStatus() {
    this.refreshStatusCount++;
  }

  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

class FakeProject {
  constructor(repositories) {
    this.repositories = repositories;
    this.directories = [];
    this.buffers = [];
    this.emitter = new Emitter();
  }

  getBuffers() {
    return this.buffers;
  }

  addBuffer(buffer) {
    this.buffers.push(buffer);
    this.emitter.emit("did-add-buffer", buffer);
  }

  onDidAddBuffer(callback) {
    return this.emitter.on("did-add-buffer", callback);
  }

  onDidChangeFiles(callback) {
    return this.emitter.on("did-change-files", callback);
  }

  emitFileChanges(events) {
    this.emitter.emit("did-change-files", events);
  }

  getDirectories() {
    return this.directories;
  }

  getDirectoryForProjectPath(filePath) {
    return directoryFor(filePath);
  }

  repositoryForPathFromProvidersCached(filePath) {
    return (
      this.repositories
        .filter((repository) => contains(repository.getWorkingDirectory(), filePath))
        .sort(
          (left, right) => right.getWorkingDirectory().length - left.getWorkingDirectory().length,
        )[0] || null
    );
  }

  async repositoryForPathFromProviders(filePath) {
    const repository = this.repositoryForPathFromProvidersCached(filePath);
    return repository && fs.existsSync(repository.getPath()) ? repository : null;
  }
}

function normalize(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contains(parentPath, childPath) {
  const parent = normalize(parentPath);
  const child = normalize(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function directoryFor(directoryPath) {
  return {
    getPath() {
      return directoryPath;
    },
    getRealPathSync() {
      return directoryPath;
    },
  };
}

function config(values = {}) {
  return {
    get(key) {
      return values[key];
    },
  };
}

function bufferFor(filePath) {
  const emitter = new Emitter();
  let currentPath = filePath;
  return {
    getPath() {
      return currentPath;
    },
    onDidChangePath(callback) {
      return emitter.on("did-change-path", callback);
    },
    onDidSave(callback) {
      return emitter.on("did-save", callback);
    },
    onDidReload(callback) {
      return emitter.on("did-reload", callback);
    },
    onDidDestroy(callback) {
      return emitter.once("did-destroy", callback);
    },
    save() {
      emitter.emit("did-save");
    },
    reload() {
      emitter.emit("did-reload");
    },
    destroy() {
      emitter.emit("did-destroy");
      emitter.dispose();
    },
    setPath(nextPath) {
      currentPath = nextPath;
      emitter.emit("did-change-path");
    },
  };
}

describe("RepositoryRegistry", () => {
  let project;
  let registry;
  let repositories;

  beforeEach(() => {
    repositories = [];
    project = new FakeProject(repositories);
    registry = new RepositoryRegistry({ project, config: config() });
  });

  afterEach(() => registry.destroy());

  it("treats the filesystem root as containing its descendants", () => {
    const rootPath = path.parse(process.cwd()).root;
    expect(
      RepositoryRegistry.pathContains(rootPath, path.join(rootPath, "nested", "file.txt")),
    ).toBe(true);
  });

  it("finds a repository containing a project root", () => {
    const workdir = temp.mkdirSync("containing-repository");
    const rootPath = path.join(workdir, "packages", "editor");
    repositories.push(new FakeRepository(workdir));

    registry.setProjectRoots([directoryFor(rootPath)]);

    expect(registry.getRepositories()).toEqual(repositories);
    expect(registry.getForPath(path.join(rootPath, "src", "main.js"))).toBe(repositories[0]);
  });

  it("registers and routes a bare repository by its Git directory", () => {
    const gitDirectory = temp.mkdirSync("bare-repository");
    const repository = new FakeRepository(null, gitDirectory);

    const entry = registry.register(repository);

    expect(entry.workingDirectory).toBe(gitDirectory);
    expect(registry.getRepositories()).toEqual([repository]);
    expect(registry.getForPath(path.join(gitDirectory, "objects", "ab", "object"))).toBe(
      repository,
    );
  });

  it("routes a path to the nearest nested repository", () => {
    const outerPath = temp.mkdirSync("outer-repository");
    const nestedPath = path.join(outerPath, "packages", "nested");
    const outer = new FakeRepository(outerPath);
    const nested = new FakeRepository(nestedPath);
    repositories.push(outer, nested);

    registry.setProjectRoots([directoryFor(outerPath)]);
    registry.register(nested);

    expect(registry.getForPath(path.join(outerPath, "README.md"))).toBe(outer);
    expect(registry.getForPath(path.join(nestedPath, "src", "main.js"))).toBe(nested);
  });

  it("prefers a deeper registered repository over a stale provider cache result", async () => {
    const outerPath = temp.mkdirSync("cached-outer-repository");
    const nestedPath = path.join(outerPath, "nested");
    const outer = new FakeRepository(outerPath);
    const nested = new FakeRepository(nestedPath);
    registry.register(outer);
    registry.register(nested);
    project.repositoryForPathFromProviders = async () => outer;

    expect(
      await registry.resolveForPath(path.join(nestedPath, "src", "main.js"), {
        refresh: false,
      }),
    ).toBe(nested);
  });

  it("routes cached paths without filesystem calls", () => {
    const workdir = temp.mkdirSync("cached-routing-repository");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    spyOn(fs.realpathSync, "native").and.callThrough();

    for (let index = 0; index < 1000; index++) {
      registry.getForPath(path.join(workdir, "src", `file-${index}.js`));
    }

    expect(fs.realpathSync.native).not.toHaveBeenCalled();
  });

  it("reports every routing alias when a repository is added or removed", () => {
    const workdir = temp.mkdirSync("aliased-routing-repository");
    const repository = new FakeRepository(workdir);
    repository.openedWorkingDirectoryPath = path.join(
      path.dirname(workdir),
      "opened-through-alias",
    );
    repositories.push(repository);
    const changes = [];
    registry.onDidChange((change) => changes.push(change));

    const entry = registry.register(repository);
    expect(changes[0].routingChangedPrefixes).toEqual([
      ...entry.routingDirectories,
      ...entry.gitDirectoryAliases,
    ]);
    const normalizedAlias = path.resolve(repository.openedWorkingDirectoryPath);
    expect(entry.routingDirectories).toContain(
      process.platform === "win32" ? normalizedAlias.toLowerCase() : normalizedAlias,
    );

    repository.destroy();
    expect(changes.at(-1).routingChangedPrefixes).toEqual([
      ...entry.routingDirectories,
      ...entry.gitDirectoryAliases,
    ]);
  });

  it("does not remove and re-add a repository when roots are replaced inside it", () => {
    const workdir = temp.mkdirSync("reconciled-repository");
    const repository = new FakeRepository(workdir);
    const changes = [];
    repositories.push(repository);
    registry.onDidChange((change) => changes.push(change));

    registry.setProjectRoots([directoryFor(path.join(workdir, "frontend"))]);
    changes.length = 0;
    registry.setProjectRoots([directoryFor(path.join(workdir, "backend"))]);

    expect(registry.getRepositories()).toEqual([repository]);
    expect(repository.isDestroyed()).toBe(false);
    expect(changes.length).toBe(1);
    expect(changes[0].added).toEqual([]);
    expect(changes[0].removed).toEqual([]);
  });

  it("adds a newly discovered alias to an existing routing entry", () => {
    const workdir = temp.mkdirSync("late-routing-alias-repository");
    const aliasPath = path.join(path.dirname(workdir), "late-routing-alias");
    const repository = new FakeRepository(workdir);
    registry.register(repository);
    expect(registry.getForPath(path.join(aliasPath, "file.txt"))).toBeNull();

    repository.addWorkingDirectoryAlias(aliasPath);
    registry.register(repository);

    expect(registry.getForPath(path.join(aliasPath, "file.txt"))).toBe(repository);
  });

  it("classifies ref changes through a newly discovered Git-directory alias", () => {
    const workdir = temp.mkdirSync("late-git-directory-alias");
    const aliasPath = path.join(temp.mkdirSync("late-git-alias-parent"), "repository-link");
    const repository = new FakeRepository(workdir);
    registry.register(repository);
    repository.addWorkingDirectoryAlias(aliasPath);
    repository.addGitDirectoryAlias(path.join(aliasPath, ".git"));
    registry.register(repository);
    const changedPath = path.join(aliasPath, ".git", "refs", "heads", "main");

    expect(registry.changeContextsFor(changedPath, path.dirname(changedPath))).toEqual([
      { repository, gitRelativeDirectory: "refs/heads" },
    ]);
  });

  it("transfers a retargeted alias to its newly discovered repository", () => {
    const first = new FakeRepository(temp.mkdirSync("retargeted-alias-first"));
    const second = new FakeRepository(temp.mkdirSync("retargeted-alias-second"));
    const aliasPath = path.join(temp.mkdirSync("retargeted-alias-parent"), "repository-link");
    registry.register(first);
    registry.register(second);
    const firstHold = registry.retain(first);
    const secondHold = registry.retain(second);
    first.addWorkingDirectoryAlias(aliasPath);
    registry.register(first);
    expect(registry.getForPath(path.join(aliasPath, "file.txt"))).toBe(first);

    second.addWorkingDirectoryAlias(aliasPath);
    registry.register(second);

    expect(registry.getForPath(path.join(aliasPath, "file.txt"))).toBe(second);
    expect(first.getWorkingDirectoryAliases()).not.toContain(aliasPath);
    firstHold.dispose();
    secondHold.dispose();
  });

  it("keeps root ownership while an asynchronous scan resolves a replacement alias", async () => {
    const workdir = temp.mkdirSync("aliased-root-repository");
    const aliasParent = temp.mkdirSync("aliased-root-parent");
    const aliasPath = path.join(aliasParent, "repository-link");
    fs.symlinkSync(workdir, aliasPath, process.platform === "win32" ? "junction" : "dir");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    const changes = [];
    registry.onDidChange((change) => changes.push(change));
    project.repositoryForPathFromProviders = async (filePath) =>
      contains(aliasPath, filePath) ? repository : null;

    registry.setProjectRoots([directoryFor(aliasPath)]);
    expect(repository.isDestroyed()).toBe(false);
    expect(registry.getRepositories()).toEqual([repository]);

    project.directories = [directoryFor(aliasPath)];
    await registry.rescan();
    expect(repository.isDestroyed()).toBe(false);
    expect(registry.getRepositories()).toEqual([repository]);
    expect(changes.flatMap(({ added }) => added)).not.toContain(repository);
    expect(changes.flatMap(({ removed }) => removed)).not.toContain(repository);
  });

  it("releases a pending root reconciliation lease when the project detaches", () => {
    const workdir = temp.mkdirSync("detached-root-reconciliation");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);

    registry.setProjectRoots([directoryFor(temp.mkdirSync("replacement-root"))]);
    expect(registry.entryByRepository.get(repository).pendingRootReconciliation).toBe(true);
    registry.detachProject(project);

    expect(repository.isDestroyed()).toBe(true);
    expect(registry.getRepositories()).toEqual([]);
  });

  it("keeps a repository until its last root owner is removed", () => {
    const workdir = temp.mkdirSync("multi-root-repository");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);

    registry.setProjectRoots([
      directoryFor(path.join(workdir, "frontend")),
      directoryFor(path.join(workdir, "backend")),
    ]);
    registry.setProjectRoots([directoryFor(path.join(workdir, "backend"))]);

    expect(registry.getRepositories()).toEqual([repository]);
    expect(repository.isDestroyed()).toBe(false);

    registry.setProjectRoots([]);
    expect(registry.getRepositories()).toEqual([]);
    expect(repository.isDestroyed()).toBe(true);
  });

  it("reports repository aliases when a root change removes its last owner", () => {
    const workdir = temp.mkdirSync("removed-root-alias-repository");
    const repository = new FakeRepository(workdir);
    repository.openedWorkingDirectoryPath = path.join(path.dirname(workdir), "removed-root-alias");
    repositories.push(repository);
    const changes = [];
    registry.onDidChange((change) => changes.push(change));
    registry.setProjectRoots([directoryFor(path.join(workdir, "frontend"))]);
    const entry = registry.entryByRepository.get(repository);
    changes.length = 0;

    registry.setProjectRoots([]);
    expect(changes).toHaveSize(1);
    expect(changes[0].removed).toEqual([repository]);
    for (const prefix of entry.routingDirectories) {
      expect(changes[0].routingChangedPrefixes).toContain(prefix);
    }
  });

  it("keeps a pinned repository after its root is removed", () => {
    const workdir = temp.mkdirSync("pinned-repository");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);

    registry.setProjectRoots([directoryFor(workdir)]);
    const pin = registry.retain(repository);
    registry.setProjectRoots([]);

    expect(registry.getRepositories()).toEqual([repository]);
    expect(repository.isDestroyed()).toBe(false);

    pin.dispose();
    expect(registry.getRepositories()).toEqual([]);
    expect(repository.isDestroyed()).toBe(true);
  });

  it("keeps a repository alive until an operation completes", async () => {
    const workdir = temp.mkdirSync("operation-owned-repository");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);

    let completeOperation;
    const operation = registry.runOperation(
      repository,
      () => new Promise((resolve) => (completeOperation = resolve)),
    );
    registry.setProjectRoots([]);
    expect(repository.isDestroyed()).toBe(false);

    completeOperation("done");
    expect(await operation).toBe("done");
    expect(repository.isDestroyed()).toBe(true);
  });

  it("assigns a stable write facade when a repository is registered", () => {
    const workdir = temp.mkdirSync("repository-operations-facade");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);

    registry.setProjectRoots([directoryFor(workdir)]);

    expect(repository.getOperations()).toBe(registry.getOperations(repository));
    expect(repository.getOperations().isAvailable()).toBe(false);
  });

  it("consumes operation providers directly from the package service hub", async () => {
    registry.destroy();
    let consumeService;
    let consumeVersion;
    let consumeCallback;
    const packageManager = {
      serviceHub: {
        consume(service, version, callback) {
          consumeService = service;
          consumeVersion = version;
          consumeCallback = callback;
          return new Disposable();
        },
      },
    };
    registry = new RepositoryRegistry({ project, config: config(), packageManager });
    const workdir = temp.mkdirSync("operation-provider-service");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);

    consumeCallback({
      createRepositoryOperations() {
        return { commit: async () => "service-commit" };
      },
    });

    expect(consumeService).toBe("repositories.operations-provider");
    expect(consumeVersion).toBe("^1.0.0");
    expect(await repository.getOperations().commit("Subject")).toBe("service-commit");
  });

  it("fully releases a workspace-only provider when it is disposed", () => {
    const workdir = temp.mkdirSync("workspace-only-provider");
    const repository = new FakeRepository(workdir);
    const provider = { initializeRepository() {} };
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    const providerDisposable = registry.addOperationProvider(provider);

    expect(repository.getOperations().isAvailable("commit")).toBe(false);
    const entry = registry.entryByRepository.get(repository);
    expect(entry.operationImplementations.has(provider)).toBe(true);

    providerDisposable.dispose();
    expect(entry.operationImplementations.has(provider)).toBe(false);
  });

  it("dispatches writes through a provider that arrives after discovery", async () => {
    const workdir = temp.mkdirSync("late-operation-provider");
    const repository = new FakeRepository(workdir);
    const commits = [];
    let providerContext;
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    const operations = repository.getOperations();

    registry.addOperationProvider({
      createRepositoryOperations(context) {
        providerContext = context;
        return {
          async commit(message, options) {
            commits.push({ message, options });
            return "created-commit";
          },
        };
      },
    });

    expect(operations.isAvailable("commit")).toBe(true);
    expect(operations.getCapabilities()).toContain("commit");
    expect(await operations.commit("Subject", { amend: true })).toBe("created-commit");
    expect(providerContext).toEqual({
      repository,
      workingDirectory: workdir,
      gitDirectory: repository.getPath(),
    });
    expect(commits).toEqual([{ message: "Subject", options: { amend: true } }]);
    expect(repository.refreshStatusSnapshotCount).toBe(1);
    expect(repository.refreshRefsSnapshotCount).toBe(1);
  });

  it("right-sizes the post-operation refresh from the implementation's hint", async () => {
    const workdir = temp.mkdirSync("operation-refresh-hints");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    let hint;
    const hintCalls = [];
    registry.addOperationProvider({
      createRepositoryOperations() {
        return {
          commit: async () => "created-commit",
          getOperationRefreshHint(name, args) {
            hintCalls.push([name, args]);
            return hint;
          },
        };
      },
    });
    const operations = repository.getOperations();
    const counts = () => [
      repository.refreshStatusSnapshotCount,
      repository.refreshRefsSnapshotCount,
    ];

    hint = "none";
    await operations.commit("Subject");
    expect(counts()).toEqual([0, 0]);

    hint = "status";
    await operations.commit("Subject");
    expect(counts()).toEqual([1, 0]);

    hint = "refs";
    await operations.commit("Subject");
    expect(counts()).toEqual([1, 1]);

    hint = "both";
    await operations.commit("Subject");
    expect(counts()).toEqual([2, 2]);

    // Unknown hint values refresh both snapshots — the safe default.
    hint = "everything";
    await operations.commit("Subject");
    expect(counts()).toEqual([3, 3]);

    expect(hintCalls[0][0]).toBe("commit");
    expect(hintCalls[0][1][0]).toBe("Subject");
  });

  it("refreshes both snapshots when the refresh hint getter throws", async () => {
    const workdir = temp.mkdirSync("throwing-refresh-hint");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    registry.addOperationProvider({
      createRepositoryOperations() {
        return {
          commit: async () => "created-commit",
          getOperationRefreshHint() {
            throw new Error("broken hint");
          },
        };
      },
    });

    expect(await repository.getOperations().commit("Subject")).toBe("created-commit");
    expect(repository.refreshStatusSnapshotCount).toBe(1);
    expect(repository.refreshRefsSnapshotCount).toBe(1);
  });

  it("resolves an operation without waiting for the detached refs refresh", async () => {
    const workdir = temp.mkdirSync("detached-refs-refresh");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    let releaseRefs;
    let statusStarted = false;
    repository.refreshStatusSnapshot = () =>
      Promise.resolve().then(() => {
        statusStarted = true;
        repository.refreshStatusSnapshotCount++;
      });
    repository.refreshRefsSnapshot = () => {
      expect(statusStarted).toBe(true);
      return new Promise((resolve) => (releaseRefs = resolve));
    };
    registry.addOperationProvider({
      createRepositoryOperations() {
        return { commit: async () => "created-commit" };
      },
    });

    // The refs refresh is still hanging when the operation's promise resolves:
    // only the status refresh gates it.
    expect(await repository.getOperations().commit("Subject")).toBe("created-commit");
    expect(repository.refreshStatusSnapshotCount).toBe(1);
    expect(typeof releaseRefs).toBe("function");
    releaseRefs();
  });

  it("does not merge refs into a pending post-operation status refresh", async () => {
    const workdir = temp.mkdirSync("pending-status-refresh");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    let releaseStatus;
    repository.refreshStatusSnapshot = () =>
      new Promise((resolve) => {
        releaseStatus = resolve;
      });
    repository.refreshRefsSnapshot = jasmine.createSpy("refreshRefsSnapshot").and.resolveTo();
    registry.addOperationProvider({
      createRepositoryOperations() {
        return { commit: async () => "created-commit" };
      },
    });

    const operation = repository.getOperations().commit("Subject");
    await flushMicrotasks();
    expect(repository.refreshRefsSnapshot).not.toHaveBeenCalled();

    releaseStatus();
    expect(await operation).toBe("created-commit");
    expect(repository.refreshRefsSnapshot).toHaveBeenCalled();
  });

  it("warns when the detached refs refresh fails, unless the repository is gone", async () => {
    const warnings = [];
    const workdir = temp.mkdirSync("failed-refs-refresh");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    registry.notificationManager = { addWarning: (...args) => warnings.push(args) };
    let rejectRefs;
    repository.refreshRefsSnapshot = () => new Promise((_, reject) => (rejectRefs = reject));
    registry.addOperationProvider({
      createRepositoryOperations() {
        return { commit: async () => "created-commit" };
      },
    });

    await repository.getOperations().commit("Subject");
    rejectRefs(new Error("refs refresh failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings.length).toBe(1);
    expect(warnings[0][1].detail).toBe("refs refresh failed");

    // A failure surfacing after the repository was destroyed stays silent.
    await repository.getOperations().commit("Subject");
    repository.destroy();
    rejectRefs(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings.length).toBe(1);
  });

  it("routes post-operation refresh failures through the repository dedupe gate", async () => {
    const warnings = [];
    const reports = [];
    const workdir = temp.mkdirSync("failed-operation-refresh");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    registry.notificationManager = { addWarning: (...args) => warnings.push(args) };
    const refreshError = new Error("snapshot failed");
    refreshError.code = "ERR_GIT_COMMAND_FAILED";
    repository.refreshStatusSnapshot = async () => Promise.reject(refreshError);
    repository.refreshRefsSnapshot = async () => Promise.reject(refreshError);
    let reported = false;
    repository.reportBackgroundSnapshotError = (error) => {
      if (reported) return;
      reported = true;
      reports.push(error);
    };
    registry.addOperationProvider({
      createRepositoryOperations() {
        return { commit: async () => "created-commit" };
      },
    });

    expect(await repository.getOperations().commit("Subject")).toBe("created-commit");
    await Promise.resolve();
    await Promise.resolve();
    expect(reports).toEqual([refreshError]);
    expect(warnings).toEqual([]);
  });

  it("uses service providers before the built-in fallback provider", async () => {
    const workdir = temp.mkdirSync("fallback-operation-provider");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    registry.addOperationProvider(
      {
        createRepositoryOperations() {
          return { commit: async () => "fallback" };
        },
      },
      { fallback: true },
    );
    const override = registry.addOperationProvider({
      createRepositoryOperations() {
        return { commit: async () => "override" };
      },
    });

    expect(await repository.getOperations().commit("Subject")).toBe("override");
    override.dispose();
    expect(await repository.getOperations().commit("Subject")).toBe("fallback");
  });

  it("does not report a successful write as failed when cache refresh fails", async () => {
    const workdir = temp.mkdirSync("failed-operation-refresh");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    repository.refreshStatusSnapshot = async () => {
      throw new Error("refresh failed");
    };
    registry.addOperationProvider({
      createRepositoryOperations() {
        return { commit: async () => "created-commit" };
      },
    });

    expect(await repository.getOperations().commit("Subject")).toBe("created-commit");
  });

  it("reports an unavailable operation with a stable error code", async () => {
    const workdir = temp.mkdirSync("unavailable-operation");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);

    let error;
    try {
      await repository.getOperations().push("origin", "main");
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error.code).toBe("ERR_REPOSITORY_OPERATION_UNAVAILABLE");
    expect(error.operation).toBe("push");
  });

  it("only exposes explicitly declared provider extensions", async () => {
    const workdir = temp.mkdirSync("custom-operation-capability");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    registry.addOperationProvider({
      createRepositoryOperations() {
        return {
          customWrite: async () => "custom-result",
          internalHelper: async () => "must-not-be-public",
          getCapabilities: () => ["customWrite"],
        };
      },
    });

    const operations = repository.getOperations();
    expect(operations.getCapabilities()).toContain("customWrite");
    expect(await operations.execute("customWrite")).toBe("custom-result");
    expect(operations.isAvailable("internalHelper")).toBe(false);
  });

  it("keeps an active provider implementation alive until its write completes", async () => {
    const workdir = temp.mkdirSync("active-operation-provider");
    const repository = new FakeRepository(workdir);
    let finishCommit;
    let destroyCount = 0;
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    const providerDisposable = registry.addOperationProvider({
      createRepositoryOperations() {
        return {
          commit() {
            return new Promise((resolve) => (finishCommit = resolve));
          },
          destroy() {
            destroyCount++;
          },
        };
      },
    });

    const commit = repository.getOperations().commit("Subject");
    await Promise.resolve();
    registry.setProjectRoots([]);
    providerDisposable.dispose();
    expect(repository.isDestroyed()).toBe(false);
    expect(destroyCount).toBe(0);

    finishCommit("done");
    expect(await commit).toBe("done");
    expect(destroyCount).toBe(1);
    expect(repository.isDestroyed()).toBe(true);
  });

  it("serializes writes to one repository and emits operation lifecycle events", async () => {
    const workdir = temp.mkdirSync("serialized-repository-operations");
    const repository = new FakeRepository(workdir);
    const calls = [];
    const events = [];
    let finishFirst;
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    registry.addOperationProvider({
      createRepositoryOperations() {
        return {
          commit(message) {
            calls.push(message);
            if (message === "first") {
              return new Promise((resolve) => (finishFirst = resolve));
            }
            return Promise.resolve(message);
          },
        };
      },
    });
    const operations = repository.getOperations();
    operations.onDidQueueOperation((event) => events.push(`queued:${event.id}`));
    operations.onDidStartOperation((event) => events.push(`started:${event.id}`));
    operations.onDidFinishOperation((event) => events.push(`${event.status}:${event.id}`));

    const first = operations.commit("first");
    const second = operations.commit("second");
    await Promise.resolve();

    expect(calls).toEqual(["first"]);
    expect(operations.getPendingOperations().map((operation) => operation.status)).toEqual([
      "running",
      "queued",
    ]);

    finishFirst("first");
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(calls).toEqual(["first", "second"]);
    expect(events).toEqual([
      "queued:1",
      "queued:2",
      "started:1",
      "succeeded:1",
      "started:2",
      "succeeded:2",
    ]);
    expect(operations.getPendingOperations()).toEqual([]);
  });

  it("continues a repository queue after a failed write", async () => {
    const workdir = temp.mkdirSync("failed-queued-operation");
    const repository = new FakeRepository(workdir);
    let callCount = 0;
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(workdir)]);
    registry.addOperationProvider({
      createRepositoryOperations() {
        return {
          commit() {
            callCount++;
            if (callCount === 1) throw new Error("commit failed");
            return "second-commit";
          },
        };
      },
    });

    const first = repository
      .getOperations()
      .commit("first")
      .catch((error) => error.message);
    const second = repository.getOperations().commit("second");

    expect(await first).toBe("commit failed");
    expect(await second).toBe("second-commit");
  });

  it("runs writes to different repositories in parallel", async () => {
    const firstPath = temp.mkdirSync("parallel-repository-one");
    const secondPath = temp.mkdirSync("parallel-repository-two");
    const firstRepository = new FakeRepository(firstPath);
    const secondRepository = new FakeRepository(secondPath);
    const started = [];
    let finishWrites;
    const writes = new Promise((resolve) => (finishWrites = resolve));
    repositories.push(firstRepository, secondRepository);
    registry.setProjectRoots([directoryFor(firstPath), directoryFor(secondPath)]);
    registry.addOperationProvider({
      createRepositoryOperations({ workingDirectory }) {
        return {
          commit() {
            started.push(workingDirectory);
            return writes;
          },
        };
      },
    });

    const first = firstRepository.getOperations().commit("first");
    const second = secondRepository.getOperations().commit("second");
    await Promise.resolve();

    expect(started).toEqual([firstPath, secondPath]);
    finishWrites();
    await Promise.all([first, second]);
  });

  it("initializes and registers a repository through a workspace provider", async () => {
    const workdir = temp.mkdirSync("initialized-repository");
    let initializeOptions;
    registry.addOperationProvider({
      async initializeRepository(directoryPath, options) {
        initializeOptions = options;
        repositories.push(new FakeRepository(directoryPath));
      },
    });

    expect(registry.canPerformWorkspaceOperation("initialize")).toBe(true);
    expect(registry.getWorkspaceOperationCapabilities()).toEqual(["initialize"]);
    const repository = await registry.initialize(workdir, { initialBranch: "main" });

    expect(repository).toBe(repositories[0]);
    expect(initializeOptions).toEqual({ initialBranch: "main" });
    expect(registry.getRepositories()).toEqual([repository]);
    registry.setProjectRoots([]);
    expect(repository.isDestroyed()).toBe(false);
    registry.forget(repository);
    expect(repository.isDestroyed()).toBe(true);
  });

  it("clones and registers a repository through a workspace provider", async () => {
    const destinationPath = path.join(temp.mkdirSync("clone-parent"), "cloned");
    let cloneArguments;
    registry.addOperationProvider({
      async cloneRepository(remoteUrl, workdir, options) {
        cloneArguments = { remoteUrl, workdir, options };
        repositories.push(new FakeRepository(workdir));
      },
    });

    const repository = await registry.clone("https://example.com/repository.git", destinationPath, {
      branch: "main",
    });

    expect(cloneArguments).toEqual({
      remoteUrl: "https://example.com/repository.git",
      workdir: destinationPath,
      options: { branch: "main" },
    });
    expect(repository).toBe(repositories[0]);
    expect(registry.getForPath(path.join(destinationPath, "README.md"))).toBe(repository);
  });

  it("executes raw Git commands through the preferred transport provider", async () => {
    const calls = [];
    registry.addOperationProvider(
      {
        executeGit() {
          throw new Error("fallback provider should not be used");
        },
      },
      { fallback: true },
    );
    registry.addOperationProvider({
      executeGit(args, workingDirectory, options) {
        calls.push({ args, workingDirectory, options });
        return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
      },
    });
    const workingDirectory = temp.mkdirSync("raw-git-transport");

    expect(registry.canExecuteGitCommands()).toBe(true);
    expect(await registry.executeGit(["status"], workingDirectory, { stdin: "input" })).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(calls).toEqual([
      {
        args: ["status"],
        workingDirectory,
        options: { stdin: "input" },
      },
    ]);
  });

  describe("active repository", () => {
    class FakeWorkspace {
      constructor() {
        this.emitter = new Emitter();
        this.activeItem = null;
        this.center = {
          onDidChangeActivePaneItem: (callback) =>
            this.emitter.on("did-change-active-pane-item", callback),
          getActivePaneItem: () => this.activeItem,
        };
      }

      getCenter() {
        return this.center;
      }

      setActiveItem(item) {
        this.activeItem = item;
        this.emitter.emit("did-change-active-pane-item", item);
      }
    }

    function itemFor(filePath) {
      return { getPath: () => filePath };
    }

    async function flushMicrotasks() {
      // The harness fakes timers, so drain the microtask queue directly.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    }

    let workspace;
    let workdirA;
    let workdirB;
    let repoA;
    let repoB;

    beforeEach(() => {
      workspace = new FakeWorkspace();
      workdirA = temp.mkdirSync("active-repository-a");
      workdirB = temp.mkdirSync("active-repository-b");
      repoA = new FakeRepository(workdirA);
      repoB = new FakeRepository(workdirB);
      repositories.push(repoA, repoB);
      registry.setProjectRoots([directoryFor(workdirA), directoryFor(workdirB)]);
    });

    it("follows the active pane item, including paths outside every repository", () => {
      const events = [];
      registry.onDidChangeActiveRepository((event) => events.push(event));
      registry.attachWorkspace(workspace);

      // Registering the project roots already adopted the first repository.
      expect(registry.getActiveRepository()).toBe(repoA);
      expect(registry.isActiveRepositoryPinned()).toBe(false);
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(workdirA);

      workspace.setActiveItem(itemFor(path.join(workdirB, "file.txt")));
      expect(registry.getActiveRepository()).toBe(repoB);

      // Items without a path (settings tabs) keep the current selection.
      workspace.setActiveItem({});
      expect(registry.getActiveRepository()).toBe(repoB);

      // A path outside every repository clears the repository but keeps a
      // working directory, so consumers can offer initialize and clone.
      const outsideDir = temp.mkdirSync("active-outside");
      workspace.setActiveItem(itemFor(path.join(outsideDir, "loose.txt")));
      expect(registry.getActiveRepository()).toBeNull();
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(outsideDir);

      // Path-less items also keep a null-repository context.
      workspace.setActiveItem({});
      expect(registry.getActiveRepository()).toBeNull();
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(outsideDir);

      // Directory-backed items use their working directory as-is.
      const terminalDir = temp.mkdirSync("active-terminal");
      workspace.setActiveItem({ getWorkingDirectory: () => terminalDir });
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(terminalDir);

      workspace.setActiveItem(itemFor(path.join(workdirA, "back.txt")));
      expect(registry.getActiveRepository()).toBe(repoA);

      expect(events.map((event) => [event.repository, event.workingDirectory])).toEqual([
        [repoB, workdirB],
        [null, outsideDir],
        [null, terminalDir],
        [repoA, workdirA],
      ]);
    });

    it("anchors an out-of-repository path inside a project root to that root", () => {
      registry.attachWorkspace(workspace);
      const bareRoot = temp.mkdirSync("active-bare-root");
      registry.setProjectRoots([directoryFor(workdirA), directoryFor(bareRoot)]);

      workspace.setActiveItem(itemFor(path.join(bareRoot, "nested", "file.txt")));
      expect(registry.getActiveRepository()).toBeNull();
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(bareRoot);
    });

    it("pins a manual selection until it is cleared", () => {
      registry.attachWorkspace(workspace);
      workspace.setActiveItem(itemFor(path.join(workdirA, "file.txt")));

      registry.setActiveRepository(repoB, { pin: true });
      expect(registry.getActiveRepository()).toBe(repoB);
      expect(registry.isActiveRepositoryPinned()).toBe(true);

      workspace.setActiveItem(itemFor(path.join(workdirA, "other.txt")));
      expect(registry.getActiveRepository()).toBe(repoB);

      registry.setActiveRepository(null);
      expect(registry.isActiveRepositoryPinned()).toBe(false);
      // Recomputed from the workspace's current active item.
      expect(registry.getActiveRepository()).toBe(repoA);
    });

    it("allows an unpinned manual selection to be superseded by the next item change", () => {
      registry.attachWorkspace(workspace);

      registry.setActiveRepository(repoB);
      expect(registry.getActiveRepository()).toBe(repoB);
      expect(registry.isActiveRepositoryPinned()).toBe(false);

      workspace.setActiveItem(itemFor(path.join(workdirA, "file.txt")));
      expect(registry.getActiveRepository()).toBe(repoA);
    });

    it("moves the active context when a deeper repository is registered", () => {
      const nestedPath = path.join(workdirA, "nested");
      const nested = new FakeRepository(nestedPath);
      registry.attachWorkspace(workspace);
      workspace.setActiveItem(itemFor(path.join(nestedPath, "file.txt")));
      expect(registry.getActiveRepository()).toBe(repoA);

      repositories.push(nested);
      registry.register(nested);

      expect(registry.getActiveRepository()).toBe(nested);
    });

    it("ignores an asynchronous repository result for a stale active item", async () => {
      const firstPath = path.join(temp.mkdirSync("stale-active-first"), "file.txt");
      const secondPath = path.join(temp.mkdirSync("stale-active-second"), "file.txt");
      const firstRepository = new FakeRepository(path.dirname(firstPath));
      const secondRepository = new FakeRepository(path.dirname(secondPath));
      const resolvers = new Map();
      project.repositoryForPathFromProviders = (filePath) =>
        new Promise((resolve) => resolvers.set(filePath, resolve));
      registry.attachWorkspace(workspace);

      workspace.setActiveItem(itemFor(firstPath));
      workspace.setActiveItem(itemFor(secondPath));
      resolvers.get(firstPath)(firstRepository);
      await flushMicrotasks();

      expect(registry.getActiveRepository()).toBeNull();
      expect(registry.getRepositories()).not.toContain(firstRepository);

      resolvers.get(secondPath)(secondRepository);
      await flushMicrotasks();
      expect(registry.getActiveRepository()).toBe(secondRepository);
    });

    it("does not destroy a shared repository returned by stale and current discovery", async () => {
      const firstPath = path.join(temp.mkdirSync("shared-active-first"), "file.txt");
      const secondPath = path.join(temp.mkdirSync("shared-active-second"), "file.txt");
      const sharedRepository = new FakeRepository(path.dirname(secondPath));
      const resolvers = new Map();
      project.repositoryForPathFromProviders = (filePath) =>
        new Promise((resolve) => resolvers.set(filePath, resolve));
      registry.attachWorkspace(workspace);

      workspace.setActiveItem(itemFor(firstPath));
      workspace.setActiveItem(itemFor(secondPath));
      resolvers.get(firstPath)(sharedRepository);
      await flushMicrotasks();
      expect(sharedRepository.isDestroyed()).toBe(false);

      resolvers.get(secondPath)(sharedRepository);
      await flushMicrotasks();
      expect(registry.getActiveRepository()).toBe(sharedRepository);
      expect(sharedRepository.isDestroyed()).toBe(false);
    });

    it("ignores an asynchronous repository result after the project is detached", async () => {
      const filePath = path.join(temp.mkdirSync("detached-active-project"), "file.txt");
      const repository = new FakeRepository(path.dirname(filePath));
      let resolveRepository;
      project.repositoryForPathFromProviders = () =>
        new Promise((resolve) => (resolveRepository = resolve));
      registry.attachWorkspace(workspace);

      workspace.setActiveItem(itemFor(filePath));
      registry.detachProject(project);
      resolveRepository(repository);
      await flushMicrotasks();

      expect(registry.getRepositories()).toEqual([]);
      expect(registry.getActiveRepository()).toBeNull();
    });

    it("keeps a null-repository context on the focused item when its repository is removed", async () => {
      const events = [];
      registry.attachWorkspace(workspace);
      workspace.setActiveItem(itemFor(path.join(workdirB, "file.txt")));
      expect(registry.getActiveRepository()).toBe(repoB);
      registry.onDidChangeActiveRepository((event) => events.push(event));

      repositories.splice(repositories.indexOf(repoB), 1);
      repoB.destroy();
      await flushMicrotasks();

      // The focused file is still inside workdirB, so the context stays there
      // instead of jumping to an unrelated repository.
      expect(registry.getActiveRepository()).toBeNull();
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(workdirB);
      expect(events.at(-1).repository).toBeNull();
      expect(events.at(-1).workingDirectory).toBe(workdirB);
    });

    it("clears the active repository when the active one is removed and a path-less item is focused", async () => {
      registry.attachWorkspace(workspace);
      workspace.setActiveItem(itemFor(path.join(workdirB, "file.txt")));
      workspace.setActiveItem({});
      expect(registry.getActiveRepository()).toBe(repoB);

      repositories.splice(repositories.indexOf(repoB), 1);
      repoB.destroy();
      await flushMicrotasks();

      // A focused path-less item means the workspace center is not empty, so the
      // registry does not adopt an unrelated repository; it goes neutral. A
      // repository is only adopted as a default when the center is empty.
      expect(registry.getActiveRepository()).toBeNull();
      expect(registry.getActiveRepositoryContext().workingDirectory).toBeNull();
    });

    it("adopts a repository when the active one is removed and the center is empty", async () => {
      registry.attachWorkspace(workspace);
      workspace.setActiveItem(itemFor(path.join(workdirB, "file.txt")));
      workspace.setActiveItem(null);
      expect(registry.getActiveRepository()).toBe(repoB);

      repositories.splice(repositories.indexOf(repoB), 1);
      repoB.destroy();
      await flushMicrotasks();

      expect(registry.getActiveRepository()).toBe(repoA);
    });

    it("gives a window whose roots hold no repositories an initialize context", async () => {
      registry.attachWorkspace(workspace);
      const bareRoot = temp.mkdirSync("active-initialize-root");
      registry.setProjectRoots([directoryFor(bareRoot)]);
      await registry.scanProjectRoots({ depth: 0, generation: registry.scanGeneration });
      await flushMicrotasks();

      expect(registry.getActiveRepository()).toBeNull();
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(bareRoot);

      // A repository appearing at the context directory becomes active, as
      // after an initialize or clone operation completes there.
      const created = new FakeRepository(bareRoot);
      repositories.push(created);
      const registration = await registry.add(path.join(bareRoot, "file.txt"));
      await flushMicrotasks();

      expect(registration.repository).toBe(created);
      expect(registry.getActiveRepository()).toBe(created);
      expect(registry.getActiveRepositoryContext().workingDirectory).toBe(bareRoot);
    });

    it("keeps a pinned out-of-project repository alive until it is deactivated", () => {
      registry.attachWorkspace(workspace);
      const workdirC = temp.mkdirSync("active-repository-c");
      const repoC = new FakeRepository(workdirC);
      repositories.push(repoC);
      registry.register(repoC);

      registry.setActiveRepository(repoC, { pin: true });
      expect(registry.getRepositories()).toContain(repoC);

      registry.setActiveRepository(repoA);
      expect(repoC.isDestroyed()).toBe(true);
    });

    it("resolves and activates a repository by path", async () => {
      registry.attachWorkspace(workspace);
      const repository = await registry.setActiveRepositoryForPath(
        path.join(workdirB, "deep", "file.txt"),
        { pin: true },
      );
      expect(repository).toBe(repoB);
      expect(registry.getActiveRepository()).toBe(repoB);
      expect(registry.isActiveRepositoryPinned()).toBe(true);
    });
  });

  it("serializes initialize and clone operations targeting the same destination", async () => {
    const destinationPath = path.join(temp.mkdirSync("workspace-operation-parent"), "repository");
    const calls = [];
    let finishInitialize;
    registry.addOperationProvider({
      initializeRepository() {
        calls.push("initialize");
        return new Promise((resolve) => (finishInitialize = resolve));
      },
      cloneRepository() {
        calls.push("clone");
        repositories.push(new FakeRepository(destinationPath));
      },
    });

    const initialize = registry.initialize(destinationPath).catch((error) => error);
    const clone = registry.clone("https://example.com/repository.git", destinationPath);
    await Promise.resolve();
    expect(calls).toEqual(["initialize"]);

    finishInitialize();
    await initialize;
    await clone;
    expect(calls).toEqual(["initialize", "clone"]);
  });

  it("rejects workspace operations after the registry is destroyed", async () => {
    registry.addOperationProvider({ initializeRepository() {} });
    registry.destroy();

    let error;
    try {
      await registry.initialize(temp.mkdirSync("destroyed-registry-operation"));
    } catch (caughtError) {
      error = caughtError;
    }
    expect(error.message).toContain("destroyed RepositoryRegistry");
  });

  it("keeps a repository until its last open buffer is destroyed", async () => {
    const workdir = temp.mkdirSync("buffer-owned-repository");
    const repository = new FakeRepository(workdir);
    const buffer = bufferFor(path.join(workdir, "src", "main.js"));
    repositories.push(repository);

    registry.setProjectRoots([directoryFor(workdir)]);
    project.addBuffer(buffer);
    registry.setProjectRoots([]);

    expect(registry.getRepositories()).toEqual([repository]);
    expect(repository.isDestroyed()).toBe(false);

    buffer.destroy();
    await Promise.resolve();
    expect(registry.getRepositories()).toEqual([]);
    expect(repository.isDestroyed()).toBe(true);
  });

  it("subscribes once per buffer and refreshes only its current owner", async () => {
    const ownerPath = temp.mkdirSync("buffer-refresh-owner");
    const nextOwnerPath = temp.mkdirSync("buffer-refresh-next-owner");
    const ownerRepository = new FakeRepository(ownerPath);
    const nextOwnerRepository = new FakeRepository(nextOwnerPath);
    repositories.push(ownerRepository, nextOwnerRepository);

    // Registered repositories do not add listeners of their own. Listener
    // count stays constant as this collection grows; the registry alone owns
    // one subscription for each buffer event.
    for (let index = 0; index < 20; index++) {
      const unrelatedPath = temp.mkdirSync(`buffer-refresh-unrelated-${index}`);
      repositories.push(new FakeRepository(unrelatedPath));
    }
    for (const repository of repositories) registry.register(repository);

    const buffer = bufferFor(path.join(ownerPath, "file.txt"));
    spyOn(buffer, "onDidSave").and.callThrough();
    spyOn(buffer, "onDidReload").and.callThrough();
    spyOn(buffer, "onDidChangePath").and.callThrough();
    project.addBuffer(buffer);
    for (let index = 0; index < 8; index++) await Promise.resolve();

    expect(buffer.onDidSave.calls.count()).toBe(1);
    expect(buffer.onDidReload.calls.count()).toBe(1);
    expect(buffer.onDidChangePath.calls.count()).toBe(1);

    buffer.save();
    buffer.reload();
    expect(ownerRepository.scheduledStatusSnapshotRefreshCount).toBe(2);
    expect(nextOwnerRepository.scheduledStatusSnapshotRefreshCount).toBe(0);
    for (const repository of repositories.slice(2)) {
      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(0);
    }

    buffer.setPath(path.join(nextOwnerPath, "moved.txt"));
    for (let index = 0; index < 8; index++) await Promise.resolve();

    expect(ownerRepository.scheduledStatusSnapshotRefreshCount).toBe(2);
    expect(nextOwnerRepository.scheduledStatusSnapshotRefreshCount).toBe(1);
    for (const repository of repositories.slice(2)) {
      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(0);
    }
  });

  it("moves an existing buffer owner when a deeper repository is registered", async () => {
    const outerPath = temp.mkdirSync("buffer-routing-outer");
    const nestedPath = path.join(outerPath, "nested");
    const outer = new FakeRepository(outerPath);
    const nested = new FakeRepository(nestedPath);
    repositories.push(outer);
    registry.setProjectRoots([directoryFor(outerPath)]);
    const buffer = bufferFor(path.join(nestedPath, "file.txt"));
    project.addBuffer(buffer);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(registry.bufferOwners.get(buffer).entry.repository).toBe(outer);

    repositories.push(nested);
    registry.register(nested);
    expect(registry.bufferOwners.get(buffer).entry.repository).toBe(nested);

    buffer.save();
    expect(nested.scheduledStatusSnapshotRefreshCount).toBe(1);
    expect(outer.scheduledStatusSnapshotRefreshCount).toBe(0);
  });

  it("does not refresh a stale owner after rapid buffer path changes", async () => {
    const firstPath = temp.mkdirSync("stale-buffer-refresh-first");
    const secondPath = temp.mkdirSync("stale-buffer-refresh-second");
    const firstRepository = new FakeRepository(firstPath);
    const secondRepository = new FakeRepository(secondPath);
    registry.register(firstRepository);
    registry.register(secondRepository);

    const resolvers = new Map();
    project.repositoryForPathFromProviders = (filePath) =>
      new Promise((resolve) => resolvers.set(filePath, resolve));
    const firstFile = path.join(firstPath, "first.txt");
    const secondFile = path.join(secondPath, "second.txt");
    const buffer = bufferFor(firstFile);
    project.addBuffer(buffer);
    buffer.setPath(secondFile);

    resolvers.get(firstFile)(firstRepository);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(firstRepository.scheduledStatusSnapshotRefreshCount).toBe(0);
    expect(secondRepository.scheduledStatusSnapshotRefreshCount).toBe(0);

    resolvers.get(secondFile)(secondRepository);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(firstRepository.scheduledStatusSnapshotRefreshCount).toBe(0);
    expect(secondRepository.scheduledStatusSnapshotRefreshCount).toBe(1);
  });

  it("releases an old buffer repository after all path listeners run", async () => {
    const workdir = temp.mkdirSync("moved-buffer-repository");
    const repository = new FakeRepository(workdir);
    const buffer = bufferFor(path.join(workdir, "main.js"));
    repositories.push(repository);

    registry.setProjectRoots([directoryFor(workdir)]);
    project.addBuffer(buffer);
    registry.setProjectRoots([]);
    buffer.onDidChangePath(() => expect(repository.isDestroyed()).toBe(false));
    buffer.setPath(path.join(temp.mkdirSync("outside-repository"), "main.js"));

    await Promise.resolve();
    expect(repository.isDestroyed()).toBe(true);
  });

  it("discovers repositories below a project root to the requested depth", async () => {
    const rootPath = temp.mkdirSync("scanned-root");
    const nestedPath = path.join(rootPath, "packages", "nested");
    fs.mkdirSync(path.join(nestedPath, ".git"), { recursive: true });
    const nested = new FakeRepository(nestedPath);
    repositories.push(nested);

    registry.setProjectRoots([directoryFor(rootPath)]);
    await registry.scanProjectRoots({ depth: 2 });

    expect(registry.getRepositories()).toContain(nested);
  });

  it("treats a maximum repository count of zero as unlimited", async () => {
    registry.destroy();
    registry = new RepositoryRegistry({
      project,
      config: config({ "git.maxCount": 0 }),
    });
    const rootPath = temp.mkdirSync("unlimited-scanned-root");
    const repositoryPaths = [path.join(rootPath, "first"), path.join(rootPath, "second")];
    for (const repositoryPath of repositoryPaths) {
      repositories.push(new FakeRepository(repositoryPath));
    }

    registry.setProjectRoots([directoryFor(rootPath)], { scan: false });
    await registry.scanProjectRoots({ depth: 1 });

    expect(registry.getRepositories()).toEqual(repositories);
  });

  it("removes repositories that disappeared during a manual rescan", async () => {
    const workdir = temp.mkdirSync("removed-repository");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    project.directories = [directoryFor(workdir)];

    registry.setProjectRoots(project.directories);
    fs.rmSync(repository.getPath(), { recursive: true });
    await registry.rescan();

    expect(registry.getRepositories()).toEqual([]);
    expect(repository.isDestroyed()).toBe(true);
  });

  it("emits lifecycle events around a manual rescan", async () => {
    const events = [];
    registry.onDidStartRescan((event) => events.push({ phase: "start", event }));
    registry.onDidFinishRescan((event) => events.push({ phase: "finish", event }));

    const repositories = await registry.rescan();

    expect(events.map(({ phase }) => phase)).toEqual(["start", "finish"]);
    expect(events[1].event.id).toBe(events[0].event.id);
    expect(events[1].event.repositories).toEqual(repositories);
    expect(events[1].event.error).toBeNull();
  });

  it("rescans and refreshes every initialized repository cache on update", async () => {
    const workdir = temp.mkdirSync("updated-repository");
    const repository = new FakeRepository(workdir);
    repositories.push(repository);
    project.directories = [directoryFor(workdir)];

    const result = await registry.update();

    expect(result).toEqual([repository]);
    expect(repository.refreshIndexCount).toBe(1);
    expect(repository.refreshStatusCount).toBe(1);
    expect(repository.refreshStatusSnapshotCount).toBe(1);
    expect(repository.refreshRefsSnapshotCount).toBe(1);
  });

  it("keeps uninitialized repository snapshots lazy on update", async () => {
    const workdir = temp.mkdirSync("lazily-updated-repository");
    const repository = new FakeRepository(workdir);
    repository.statusSnapshot = { initialized: false };
    repository.refsSnapshot = { initialized: false };
    repositories.push(repository);
    project.directories = [directoryFor(workdir)];

    await registry.update();

    expect(repository.refreshIndexCount).toBe(1);
    expect(repository.refreshStatusCount).toBe(1);
    expect(repository.refreshStatusSnapshotCount).toBe(0);
    expect(repository.refreshRefsSnapshotCount).toBe(0);
  });

  it("optionally detects repositories added and removed below a root", async () => {
    registry.destroy();
    registry = new RepositoryRegistry({
      project,
      config: config({
        "git.watchDiscovery": true,
        "git.watchDepth": 1,
      }),
    });
    const rootPath = temp.mkdirSync("watched-root");
    const nestedPath = path.join(rootPath, "nested");
    fs.mkdirSync(nestedPath);
    registry.setProjectRoots([directoryFor(rootPath)]);

    const repository = new FakeRepository(nestedPath);
    repositories.push(repository);
    await registry.discoverRepositoriesForFileChanges([{ path: repository.getPath() }]);
    expect(registry.getForPath(nestedPath)).toBe(repository);

    fs.rmSync(repository.getPath(), { recursive: true });
    await registry.discoverRepositoriesForFileChanges([{ path: repository.getPath() }]);
    expect(registry.getForPath(nestedPath)).toBeNull();
    expect(repository.isDestroyed()).toBe(true);
  });

  // A watcher reports whichever spelling the OS handed it and a registered
  // repository knows its own — on Windows an 8.3 alias against a long name, on
  // macOS /var against /private/var. The removal branch compared the two
  // lexically and matched nothing, so a deleted `.git` left its repository
  // registered and neither the tree view nor the Git panel was ever told.
  it("removes a repository whose .git disappears under an aliased spelling", async () => {
    registry.destroy();
    registry = new RepositoryRegistry({
      project,
      config: config({ "git.watchDiscovery": true, "git.watchDepth": 1 }),
    });

    const rawPath = temp.mkdirSync("aliased-repository");
    const canonicalPath = fs.realpathSync.native(rawPath);
    const repository = new FakeRepository(canonicalPath);
    repositories.push(repository);
    registry.setProjectRoots([directoryFor(canonicalPath)]);
    expect(registry.getRepositories()).toEqual([repository]);

    fs.rmSync(repository.getPath(), { recursive: true, maxRetries: 10, retryDelay: 50 });
    await registry.discoverRepositoriesForFileChanges([
      { action: "deleted", path: path.join(rawPath, ".git") },
    ]);

    expect(registry.getRepositories()).toEqual([]);
    expect(repository.isDestroyed()).toBe(true);
  });

  // A repository refreshes on window focus, on a buffer save, and after its own
  // operations, so anything that changes the working tree from inside the window
  // without going through a buffer — a build, a `git` command in a terminal, a
  // package rewriting a file — used to leave every Git colour in the window as
  // it was until an unrelated event forced a refresh.
  describe("refreshing from watched file changes", () => {
    let repository, workingDirectory;

    beforeEach(() => {
      workingDirectory = temp.mkdirSync("watched-repository");
      repository = new FakeRepository(workingDirectory);
      repositories.push(repository);
      registry.setProjectRoots([directoryFor(workingDirectory)]);
      repository.scheduledStatusSnapshotRefreshCount = 0;
      repository.scheduledRefsSnapshotRefreshCount = 0;
    });

    it("refreshes the status once for a batch of working-tree changes", () => {
      project.emitFileChanges([
        { action: "modified", path: path.join(workingDirectory, "one.txt") },
        { action: "modified", path: path.join(workingDirectory, "nested", "two.txt") },
        {
          action: "renamed",
          path: path.join(workingDirectory, "four.txt"),
          oldPath: path.join(workingDirectory, "three.txt"),
        },
      ]);

      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(1);
      expect(repository.scheduledRefsSnapshotRefreshCount).toBe(0);
    });

    it("refreshes the status alone when the index moves", () => {
      project.emitFileChanges([
        { action: "created", path: path.join(repository.getPath(), "index.lock") },
        { action: "modified", path: path.join(repository.getPath(), "index") },
        { action: "deleted", path: path.join(repository.getPath(), "index.lock") },
      ]);

      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(1);
      expect(repository.scheduledRefsSnapshotRefreshCount).toBe(0);
    });

    it("refreshes the refs too when a ref moves", () => {
      project.emitFileChanges([
        { action: "modified", path: path.join(repository.getPath(), "HEAD") },
        { action: "modified", path: path.join(repository.getPath(), "refs", "heads", "master") },
      ]);

      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(1);
      expect(repository.scheduledRefsSnapshotRefreshCount).toBe(1);
    });

    // A fetch writes thousands of loose objects and every Git write pairs with
    // a lock file. Neither changes what a status or a ref reads.
    it("ignores loose objects and lock files", () => {
      project.emitFileChanges([
        { action: "created", path: path.join(repository.getPath(), "objects", "96", "7631210c04") },
        {
          action: "created",
          path: path.join(repository.getPath(), "objects", "pack", "pack-a.idx"),
        },
        {
          action: "created",
          path: path.join(repository.getPath(), "refs", "heads", "master.lock"),
        },
      ]);

      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(0);
      expect(repository.scheduledRefsSnapshotRefreshCount).toBe(0);
    });

    it("ignores changes outside every repository", () => {
      const outsidePath = temp.mkdirSync("outside-every-repository");
      project.emitFileChanges([{ action: "modified", path: path.join(outsidePath, "one.txt") }]);

      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(0);
      expect(repository.scheduledRefsSnapshotRefreshCount).toBe(0);
    });

    // A linked worktree's Git directory lives under its main repository's, so
    // routing by working tree hands every one of its HEAD moves to the main
    // repository and never tells the worktree's own entry at all.
    describe("with a linked worktree", () => {
      let worktree, worktreePath, worktreeGitDirectory;

      beforeEach(() => {
        worktreePath = temp.mkdirSync("watched-worktree");
        worktreeGitDirectory = path.join(repository.getPath(), "worktrees", "feature");
        worktree = new FakeRepository(worktreePath, worktreeGitDirectory);
        repositories.push(worktree);
        registry.setProjectRoots([directoryFor(workingDirectory), directoryFor(worktreePath)]);
        for (const each of [repository, worktree]) {
          each.scheduledStatusSnapshotRefreshCount = 0;
          each.scheduledRefsSnapshotRefreshCount = 0;
        }
      });

      it("routes a worktree HEAD move to the worktree, and its list to the main repository", () => {
        project.emitFileChanges([
          { action: "modified", path: path.join(worktreeGitDirectory, "HEAD") },
        ]);

        expect(worktree.scheduledStatusSnapshotRefreshCount).toBe(1);
        expect(worktree.scheduledRefsSnapshotRefreshCount).toBe(1);
        // The main repository's own working tree and index cannot have moved;
        // only the worktree list it reports carries that worktree's HEAD.
        expect(repository.scheduledStatusSnapshotRefreshCount).toBe(0);
        expect(repository.scheduledRefsSnapshotRefreshCount).toBe(1);
      });

      it("refreshes the main repository's refs when a worktree is created", () => {
        project.emitFileChanges([
          {
            action: "created",
            path: path.join(repository.getPath(), "worktrees", "unopened"),
          },
        ]);

        expect(repository.scheduledStatusSnapshotRefreshCount).toBe(0);
        expect(repository.scheduledRefsSnapshotRefreshCount).toBe(1);
        expect(worktree.scheduledRefsSnapshotRefreshCount).toBe(0);
      });

      it("still routes each working tree to its own repository", () => {
        project.emitFileChanges([
          { action: "modified", path: path.join(worktreePath, "one.txt") },
          { action: "modified", path: path.join(workingDirectory, "two.txt") },
        ]);

        expect(worktree.scheduledStatusSnapshotRefreshCount).toBe(1);
        expect(worktree.scheduledRefsSnapshotRefreshCount).toBe(0);
        expect(repository.scheduledStatusSnapshotRefreshCount).toBe(1);
        expect(repository.scheduledRefsSnapshotRefreshCount).toBe(0);
      });

      // The lock file every Git write pairs with is still noise, wherever it is.
      it("ignores lock files inside a worktree Git directory", () => {
        project.emitFileChanges([
          { action: "created", path: path.join(worktreeGitDirectory, "HEAD.lock") },
        ]);

        expect(worktree.scheduledStatusSnapshotRefreshCount).toBe(0);
        expect(worktree.scheduledRefsSnapshotRefreshCount).toBe(0);
        expect(repository.scheduledRefsSnapshotRefreshCount).toBe(0);
      });
    });

    // Discovery is opt-in and expensive; keeping a window's colours honest is
    // neither, so it must not ride on the same switch.
    it("does not depend on git.watchDiscovery", () => {
      expect(registry.config.get("git.watchDiscovery")).toBeFalsy();

      project.emitFileChanges([
        { action: "modified", path: path.join(workingDirectory, "one.txt") },
      ]);

      expect(repository.scheduledStatusSnapshotRefreshCount).toBe(1);
    });
  });

  // The project watcher reports changes whether or not the window is focused,
  // so focus refreshes only what the watcher cannot have kept fresh — plus the
  // active repository, whose staleness is the one on screen. Without this
  // targeting, every focus event ran a `git status` on every registered
  // repository: one hundred processes per alt-tab in a many-repository
  // workspace.
  describe("refreshing on window focus", () => {
    const resetCounts = (...repos) => {
      for (const repo of repos) {
        repo.scheduledStatusSnapshotRefreshCount = 0;
        repo.scheduledRefsSnapshotRefreshCount = 0;
      }
    };

    it("refreshes the active repository and leaves watcher-covered ones alone", () => {
      const rootPath = temp.mkdirSync("focus-root");
      const active = new FakeRepository(path.join(rootPath, "active"));
      const idle = new FakeRepository(path.join(rootPath, "idle"));
      repositories.push(active, idle);
      registry.setProjectRoots([directoryFor(rootPath)], { scan: false });
      registry.register(active);
      registry.register(idle);
      registry.setActiveRepository(active);
      resetCounts(active, idle);

      registry.handleWindowFocus();

      expect(active.scheduledStatusSnapshotRefreshCount).toBe(1);
      expect(active.scheduledRefsSnapshotRefreshCount).toBe(1);
      expect(idle.scheduledStatusSnapshotRefreshCount).toBe(0);
      expect(idle.scheduledRefsSnapshotRefreshCount).toBe(0);
    });

    it("refreshes a repository outside every project root even when not active", () => {
      const rootPath = temp.mkdirSync("focus-root");
      const covered = new FakeRepository(path.join(rootPath, "covered"));
      const outside = new FakeRepository(temp.mkdirSync("focus-outside"));
      repositories.push(covered, outside);
      registry.setProjectRoots([directoryFor(rootPath)], { scan: false });
      registry.register(covered);
      registry.register(outside);
      registry.setActiveRepository(covered);
      resetCounts(covered, outside);

      registry.handleWindowFocus();

      expect(outside.scheduledStatusSnapshotRefreshCount).toBe(1);
      expect(outside.scheduledRefsSnapshotRefreshCount).toBe(1);
    });

    // A linked worktree inside the roots can still commit through a Git
    // directory outside them, which the watcher never sees.
    it("refreshes a worktree whose Git directory lies outside every root", () => {
      const rootPath = temp.mkdirSync("focus-root");
      const covered = new FakeRepository(path.join(rootPath, "covered"));
      const mainPath = temp.mkdirSync("focus-worktree-main");
      const worktree = new FakeRepository(
        path.join(rootPath, "feature"),
        path.join(mainPath, ".git", "worktrees", "feature"),
      );
      repositories.push(covered, worktree);
      registry.setProjectRoots([directoryFor(rootPath)], { scan: false });
      registry.register(covered);
      registry.register(worktree);
      registry.setActiveRepository(covered);
      resetCounts(covered, worktree);

      registry.handleWindowFocus();

      expect(worktree.scheduledStatusSnapshotRefreshCount).toBe(1);
      expect(worktree.scheduledRefsSnapshotRefreshCount).toBe(1);
    });
  });

  // Resetting the window runs PackageManager#reset, which clears every consumer
  // off the service hub. A registry that subscribed only in its constructor
  // keeps that subscription in name alone afterwards, and no provider ever
  // reaches it again — silently, which is why this is pinned.
  describe("consumeServices", () => {
    const fakeProvider = () => ({ initializeRepository: async () => null });

    it("receives providers registered on the hub", () => {
      const serviceHub = new ServiceHub();
      const registry = new RepositoryRegistry({ packageManager: { serviceHub } });
      const before = registry.operationProviders.length;

      serviceHub.provide("repositories.operations-provider", "1.0.0", fakeProvider());
      expect(registry.operationProviders.length).toBe(before + 1);

      registry.destroy();
    });

    it("reconnects after the hub has been cleared", () => {
      const serviceHub = new ServiceHub();
      const registry = new RepositoryRegistry({ packageManager: { serviceHub } });
      const before = registry.operationProviders.length;

      serviceHub.clear();
      registry.consumeServices({ serviceHub });
      serviceHub.provide("repositories.operations-provider", "1.0.0", fakeProvider());

      expect(registry.operationProviders.length).toBe(before + 1);

      registry.destroy();
    });
  });
});
