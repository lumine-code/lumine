const path = require("path");
const { Emitter } = require("@lumine-code/event-kit");
const RepositoryRegistry = require("../src/repository-registry");
const { deferred } = require("../src/file-watch-protocol");

class ObservedRepository {
  constructor() {
    this.directory = path.resolve("observed-checkout");
    this.emitter = new Emitter();
    this.destroyed = false;
    this.status = { initialized: true };
  }
  getWorkingDirectory() {
    return this.directory;
  }
  getPath() {
    return path.join(this.directory, ".git");
  }
  getStatusSnapshot() {
    return this.status;
  }
  isDestroyed() {
    return this.destroyed;
  }
  onDidDestroy(callback) {
    return this.emitter.on("destroy", callback);
  }
  onDidChangeStatusSnapshot(callback) {
    return this.emitter.on("status", callback);
  }
  ensureStatusSnapshot() {
    return Promise.resolve(this.status);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emitter.emit("destroy");
    this.emitter.dispose();
  }
}

describe("RepositoryRegistry path observation", () => {
  let registry, repository, filePath, paths, observation;

  beforeEach(() => {
    registry = new RepositoryRegistry({});
    repository = new ObservedRepository();
    registry.register(repository, { emit: false });
    filePath = path.join(repository.directory, "file.txt");
    paths = new Emitter();
    spyOn(registry, "resolveForPath").and.resolveTo(repository);
  });

  afterEach(() => {
    observation?.dispose();
    paths.dispose();
    registry.destroy();
  });

  it("owns a real repository lease across path switches and releases it on disposal", async () => {
    const callback = jasmine.createSpy("binding");
    observation = registry.observeForPath(() => filePath, callback, {
      snapshots: "status",
      onDidChangePath: (listener) => paths.on("path", listener),
    });
    expect(callback).toHaveBeenCalledWith(repository, { path: filePath, ready: true });
    const entry = registry.entryByRepository.get(repository);
    expect(entry.pins.size).toBe(1);
    filePath = path.join(repository.directory, "renamed.txt");
    paths.emit("path");
    await flushMicrotasks();
    expect(repository.isDestroyed()).toBe(false);
    expect(entry.pins.size).toBe(1);
    expect(registry.resolveForPath).toHaveBeenCalledWith(filePath, { refresh: false });

    observation.dispose();
    const delivered = callback.calls.count();
    expect(repository.isDestroyed()).toBe(true);
    expect(registry.getForPath(filePath)).toBeNull();
    paths.emit("path");
    await flushMicrotasks();
    expect(callback.calls.count()).toBe(delivered);
  });

  it("cancels pending readiness when the registry is destroyed", async () => {
    const readiness = deferred();
    repository.status = { initialized: false };
    spyOn(repository, "ensureStatusSnapshot").and.returnValue(readiness.promise);
    const callback = jasmine.createSpy("binding");
    observation = registry.observeForPath(() => filePath, callback, { snapshots: "status" });
    await flushMicrotasks();
    expect(callback.calls.mostRecent().args).toEqual([
      repository,
      { path: filePath, ready: false },
    ]);
    registry.destroy();
    const delivered = callback.calls.count();
    readiness.resolve({ initialized: true });
    await flushMicrotasks();
    expect(callback.calls.count()).toBe(delivered);
    expect(repository.isDestroyed()).toBe(true);
  });

  it("removes the registry lifecycle edge when callers repeatedly dispose observations", () => {
    const callback = jasmine.createSpy("binding");
    // This manual owner lets multiple independent observers share the checkout.
    const retained = registry.retain(repository, "integration-test");
    const first = registry.observeForPath(() => filePath, callback);
    const second = registry.observeForPath(() => filePath, callback);
    const entry = registry.entryByRepository.get(repository);
    expect(entry.pins.size).toBe(3);
    first.dispose();
    first.dispose();
    expect(entry.pins.size).toBe(2);
    second.dispose();
    expect(entry.pins.size).toBe(1);
    retained.dispose();
    expect(repository.isDestroyed()).toBe(true);
    registry.destroy();
    expect(callback.calls.count()).toBe(2);
  });
});
