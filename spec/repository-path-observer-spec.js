const { Disposable, Emitter } = require("@lumine-code/event-kit");
const RepositoryPathObserver = require("../src/repository-path-observer");
const { deferred } = require("../src/file-watch-protocol");

class FakeRepository {
  constructor({ initialized = true, statusReady, refsReady } = {}) {
    this.emitter = new Emitter();
    this.destroyed = false;
    this.status = { initialized };
    this.refs = { initialized };
    this.ensureStatusSnapshot = jasmine
      .createSpy("status readiness")
      .and.callFake(() => statusReady || Promise.resolve(this.status));
    this.ensureRefsSnapshot = jasmine
      .createSpy("refs readiness")
      .and.callFake(() => refsReady || Promise.resolve(this.refs));
  }
  isDestroyed() {
    return this.destroyed;
  }
  getStatusSnapshot() {
    return this.status;
  }
  getRefsSnapshot() {
    return this.refs;
  }
  onDidDestroy(callback) {
    return this.emitter.on("destroy", callback);
  }
  onDidChangeStatusSnapshot(callback) {
    return this.emitter.on("status", callback);
  }
  onDidChangeRefsSnapshot(callback) {
    return this.emitter.on("refs", callback);
  }
  destroy() {
    this.destroyed = true;
    this.emitter.emit("destroy");
  }
  readyStatus() {
    this.status = { initialized: true };
    this.emitter.emit("status", this.status);
  }
  readyRefs() {
    this.refs = { initialized: true };
    this.emitter.emit("refs", this.refs);
  }
}

class FakeRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.routes = new Map();
    this.held = new Map();
    this.releases = new Map();
    this.resolveForPath = jasmine
      .createSpy("resolve repository")
      .and.callFake(async (filePath) => this.getForPath(filePath));
  }
  getForPath(filePath) {
    const repository = this.routes.get(filePath);
    return repository?.isDestroyed() ? null : repository || null;
  }
  onDidChange(callback) {
    return this.emitter.on("change", callback);
  }
  changed() {
    this.emitter.emit("change");
  }
  retain(repository) {
    this.held.set(repository, (this.held.get(repository) || 0) + 1);
    return new Disposable(() => {
      this.held.set(repository, this.held.get(repository) - 1);
      this.releases.set(repository, (this.releases.get(repository) || 0) + 1);
    });
  }
}

describe("Repository path observation", () => {
  let registry, paths, filePath, callback, observer;
  beforeEach(() => {
    registry = new FakeRegistry();
    paths = new Emitter();
    filePath = null;
    callback = jasmine.createSpy("repository binding");
  });
  afterEach(() => {
    observer?.dispose();
    paths.dispose();
    registry.emitter.dispose();
  });
  function observe(snapshots = "none") {
    observer = new RepositoryPathObserver(registry, () => filePath, callback, {
      snapshots,
      onDidChangePath: (listener) => paths.on("path", listener),
    });
  }
  function moveTo(nextPath) {
    filePath = nextPath;
    paths.emit("path");
  }
  async function turn() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("rebinds an untitled buffer after Save As into an already known repository", async () => {
    const repository = new FakeRepository();
    registry.routes.set("/known/saved.txt", repository);
    observe();
    expect(callback.calls.mostRecent().args).toEqual([null, { path: null, ready: true }]);
    moveTo("/known/saved.txt");
    await turn();
    expect(callback.calls.mostRecent().args).toEqual([
      repository,
      { path: "/known/saved.txt", ready: true },
    ]);
    expect(callback.calls.count()).toBe(2);
    expect(registry.held.get(repository)).toBe(1);
  });

  it("reports unresolved absence until discovery confirms that no repository owns the path", async () => {
    filePath = "/outside/file.txt";
    const discovery = deferred();
    registry.resolveForPath.and.returnValue(discovery.promise);
    observe();
    expect(callback.calls.mostRecent().args).toEqual([null, { path: filePath, ready: false }]);
    discovery.resolve(null);
    await turn();
    expect(callback.calls.mostRecent().args).toEqual([null, { path: filePath, ready: true }]);
  });

  it("releases the previous owner on route replacement and destruction exactly once", async () => {
    filePath = "/repo/file.txt";
    const first = new FakeRepository();
    const replacement = new FakeRepository();
    registry.routes.set(filePath, first);
    observe();
    await turn();
    registry.routes.set(filePath, replacement);
    registry.changed();
    expect(callback.calls.mostRecent().args[0]).toBe(replacement);
    expect(registry.held.get(first)).toBe(0);
    expect(registry.releases.get(first)).toBe(1);
    replacement.destroy();
    await turn();
    expect(callback.calls.mostRecent().args).toEqual([null, { path: filePath, ready: true }]);
    expect(registry.releases.get(replacement)).toBe(1);
    observer.dispose();
    observer.dispose();
    expect(registry.releases.get(first)).toBe(1);
    expect(registry.releases.get(replacement)).toBe(1);
  });

  it("ignores late discovery after a path switch or disposal", async () => {
    filePath = "/first/file.txt";
    const first = deferred();
    const second = deferred();
    registry.resolveForPath.and.callFake((value) =>
      value.startsWith("/first/") ? first.promise : second.promise,
    );
    observe();
    moveTo("/second/file.txt");
    const current = new FakeRepository();
    second.resolve(current);
    await turn();
    const count = callback.calls.count();
    first.resolve(new FakeRepository());
    await turn();
    expect(callback.calls.count()).toBe(count);
    expect(callback.calls.mostRecent().args[0]).toBe(current);
    const third = deferred();
    registry.resolveForPath.and.returnValue(third.promise);
    moveTo("/third/file.txt");
    observer.dispose();
    const disposedCount = callback.calls.count();
    third.resolve(new FakeRepository());
    await turn();
    expect(callback.calls.count()).toBe(disposedCount);
    expect(registry.held.get(current)).toBe(0);
  });

  it("ignores stale snapshot readiness after rapid path switches", async () => {
    const firstReady = deferred();
    const secondReady = deferred();
    const first = new FakeRepository({ initialized: false, statusReady: firstReady.promise });
    const second = new FakeRepository({ initialized: false, statusReady: secondReady.promise });
    registry.routes.set("/first/file.txt", first);
    registry.routes.set("/second/file.txt", second);
    filePath = "/first/file.txt";
    observe("status");
    await turn();
    moveTo("/second/file.txt");
    await turn();
    const count = callback.calls.count();
    first.readyStatus();
    firstReady.resolve(first.status);
    await turn();
    expect(callback.calls.count()).toBe(count);
    expect(callback.calls.mostRecent().args).toEqual([second, { path: filePath, ready: false }]);
    observer.dispose();
    second.readyStatus();
    secondReady.resolve(second.status);
    await turn();
    expect(callback.calls.count()).toBe(count);
    expect(registry.releases.get(first)).toBe(1);
    expect(registry.releases.get(second)).toBe(1);
  });

  it("recovers readiness after an initial load failure when a later snapshot arrives", async () => {
    filePath = "/repo/file.txt";
    const readiness = deferred();
    const repository = new FakeRepository({ initialized: false, statusReady: readiness.promise });
    registry.routes.set(filePath, repository);
    observe("status");
    await turn();
    const failure = new Error("Initial status failed");
    readiness.reject(failure);
    await turn();
    expect(callback.calls.mostRecent().args).toEqual([
      repository,
      { path: filePath, ready: false, error: failure },
    ]);
    repository.readyStatus();
    expect(callback.calls.mostRecent().args).toEqual([repository, { path: filePath, ready: true }]);
    expect(registry.held.get(repository)).toBe(1);
  });

  it("waits for both requested snapshots and does not report ordinary metadata changes again", async () => {
    filePath = "/repo/file.txt";
    const statusReady = deferred();
    const refsReady = deferred();
    const repository = new FakeRepository({
      initialized: false,
      statusReady: statusReady.promise,
      refsReady: refsReady.promise,
    });
    registry.routes.set(filePath, repository);
    observe("both");
    await turn();
    repository.readyStatus();
    statusReady.resolve(repository.status);
    await turn();
    expect(callback.calls.mostRecent().args[1].ready).toBe(false);
    repository.readyRefs();
    refsReady.resolve(repository.refs);
    await turn();
    const count = callback.calls.count();
    registry.changed();
    repository.readyStatus();
    repository.readyRefs();
    expect(callback.calls.count()).toBe(count);
    expect(callback.calls.mostRecent().args).toEqual([repository, { path: filePath, ready: true }]);
  });
});
