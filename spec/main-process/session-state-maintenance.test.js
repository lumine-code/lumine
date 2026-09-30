const assert = require("node:assert/strict");
const ChildProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
// Electron and its Node-mode cleanup child both support SQLite.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { DatabaseSync } = require("node:sqlite");
const sinon = require("sinon");
const SessionStateMaintenance = require("../../src/session-state-maintenance");
const LumineApplication = require("../../src/lumine-application");

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.killCount = 0;
    this.closeOnKill = true;
    this.stderr = { resume: () => (this.stderrResumed = true) };
  }

  send(message) {
    this.messages.push(message);
  }

  kill() {
    this.killCount++;
    if (this.closeOnKill) queueMicrotask(() => this.emit("close", null, "SIGTERM"));
  }

  complete(result = { removed: 1 }) {
    this.emit("message", { type: "complete", result });
  }
}

describe("SessionStateMaintenance", function () {
  let sandbox, services, workers, directories;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    services = [];
    workers = [];
    directories = [];
  });

  afterEach(async function () {
    for (const worker of workers) worker.closeOnKill = true;
    await Promise.all(services.map((service) => service.close()));
    sandbox.restore();
    for (const directory of directories) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function fakeService(options = {}) {
    const service = new SessionStateMaintenance({
      storagePath: path.join(os.tmpdir(), "storage"),
      getProtectedWindowIds: () => [],
      delay: 50,
      timeout: 1000,
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      ...options,
    });
    services.push(service);
    return service;
  }

  it("sends the database path and refreshes window protection after enumeration", async function () {
    const liveIds = new Set(["already-open"]);
    const getProtectedWindowIds = sandbox.spy(() => liveIds);
    const service = fakeService({ getProtectedWindowIds });
    const job = service.run();
    const worker = workers[0];
    assert.deepEqual(worker.messages, [
      { type: "scan", databasePath: path.join(service.storagePath, "session-store.db") },
    ]);
    assert.equal(getProtectedWindowIds.callCount, 0);
    assert.equal(worker.stderrResumed, true);

    liveIds.add("opened-during-scan");
    worker.emit("message", { type: "candidates-ready" });
    assert.deepEqual(worker.messages[1], {
      type: "prune",
      protectedWindowIds: ["already-open", "opened-during-scan"],
    });
    worker.complete({ removed: 2 });
    worker.emit("close", 0, null);
    assert.deepEqual(await job, { removed: 2 });
    assert.equal(service.worker, null);
    assert.equal(service.job, null);
  });

  it("coalesces scheduled and running requests without overlapping workers", async function () {
    const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = fakeService();
    service.schedule();
    const timer = service.timer;
    service.schedule();
    service.schedule();
    assert.equal(service.timer, timer);
    await clock.tickAsync(49);
    assert.equal(workers.length, 0);
    await clock.tickAsync(1);
    assert.equal(workers.length, 1);
    const firstJob = service.job;
    assert.equal(service.run(), firstJob);

    service.schedule();
    service.schedule();
    workers[0].complete();
    await clock.tickAsync(100);
    assert.equal(workers.length, 1, "a result must not permit overlap before child close");
    assert.equal(service.job, firstJob);
    workers[0].emit("close", 0, null);
    await firstJob;
    await clock.tickAsync(49);
    assert.equal(workers.length, 1);
    await clock.tickAsync(1);
    assert.equal(workers.length, 2);
    const secondJob = service.job;
    workers[1].complete({ removed: 0 });
    workers[1].emit("close", 0, null);
    assert.deepEqual(await secondJob, { removed: 0 });
    await clock.tickAsync(2000);
    assert.equal(workers.length, 2);
    assert.equal(workers[0].killCount, 0);
    assert.equal(workers[1].killCount, 0);
  });

  it("cancels scheduled work and ignores requests after closing", async function () {
    const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = fakeService();
    service.schedule();
    await service.close();
    service.schedule();
    assert.equal(await service.run(), null);
    await clock.tickAsync(2000);
    assert.equal(workers.length, 0);
    assert.equal(service.timer, null);
  });

  it("kills a running child and waits for its close event during shutdown", async function () {
    const service = fakeService();
    const job = service.run();
    const worker = workers[0];
    worker.closeOnKill = false;
    service.schedule();
    let closed = false;
    const closing = service.close().then(() => (closed = true));
    await Promise.resolve();
    assert.equal(worker.killCount, 1);
    assert.equal(closed, false);
    worker.emit("message", { type: "candidates-ready" });
    assert.equal(worker.messages.length, 1, "closed maintenance must not authorize deletion");
    worker.emit("close", null, "SIGTERM");
    await closing;
    assert.equal(await job, null);
    assert.equal(closed, true);
    assert.equal(service.timer, null);
    assert.equal(service.reschedule, false);
  });

  it("rejects a synchronous spawn failure and allows a later retry", async function () {
    const failedSpawn = new Error("spawn denied");
    const service = fakeService({
      spawnWorker: () => {
        throw failedSpawn;
      },
    });
    await assert.rejects(service.run(), (error) => error === failedSpawn);
    assert.equal(service.worker, null);
    assert.equal(service.job, null);
    service.spawnWorker = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const retry = service.run();
    workers[0].complete({ removed: 0 });
    workers[0].emit("close", 0, null);
    assert.deepEqual(await retry, { removed: 0 });
  });

  it("waits for close after an asynchronous spawn error and clears its deadline", async function () {
    const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = fakeService();
    const job = service.run();
    const failure = new Error("spawn EAGAIN");
    const rejected = assert.rejects(job, (error) => error === failure);
    workers[0].emit("error", failure);
    assert.equal(service.run(), job);
    workers[0].emit("close", -1, null);
    await rejected;
    await clock.tickAsync(2000);
    assert.equal(workers[0].killCount, 0);
    assert.equal(service.job, null);
  });

  it("rejects an unexpected exit without accepting incomplete cleanup", async function () {
    const service = fakeService();
    const job = service.run();
    const rejected = assert.rejects(job, /exited before completing/);
    workers[0].emit("close", 7, null);
    await rejected;
    assert.equal(service.worker, null);
  });

  it("kills a timed-out child but waits for close before releasing the job", async function () {
    const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = fakeService();
    const job = service.run();
    const rejected = assert.rejects(job, /exceeded its time limit/);
    workers[0].closeOnKill = false;
    await clock.tickAsync(1000);
    assert.equal(workers[0].killCount, 1);
    assert.equal(service.job, job);
    workers[0].emit("close", null, "SIGTERM");
    await rejected;
    assert.equal(service.worker, null);
    assert.equal(service.job, null);
  });

  it("forks an isolated Node-mode child without changing the main process environment", async function () {
    const worker = new FakeWorker();
    workers.push(worker);
    const fork = sandbox.stub(ChildProcess, "fork").returns(worker);
    const oldNodeMode = process.env.ELECTRON_RUN_AS_NODE;
    const service = new SessionStateMaintenance({
      storagePath: os.tmpdir(),
      getProtectedWindowIds: () => [],
    });
    services.push(service);
    const job = service.run();
    const [bootstrap, args, options] = fork.firstCall.args;
    assert.equal(bootstrap, require.resolve("../../src/session-state-worker-bootstrap"));
    assert.deepEqual(args, []);
    assert.deepEqual(options.execArgv, []);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(options.env.ELECTRON_NO_ATTACH_CONSOLE, "1");
    assert.equal(options.windowsHide, true);
    assert.equal(options.silent, true);
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, oldNodeMode);
    worker.complete({ removed: 0 });
    worker.emit("close", 0, null);
    await job;
  });

  it("prunes a real temporary SQLite store in its forked worker", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-maintenance-"));
    directories.push(directory);
    const databasePath = path.join(directory, "session-store.db");
    const latestWindow = crypto.randomUUID();
    const retiredWindow = crypto.randomUUID();
    const liveWindow = crypto.randomUUID();
    const recoveryWindow = crypto.randomUUID();
    const projectHash = "a".repeat(40);
    const key = (window) => `editor-${window}-${projectHash}`;
    const clean = { version: 1, project: { buffers: [] }, workspace: {}, packageStates: {} };
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE Environments1 (key TEXT PRIMARY KEY, value JSON); CREATE TABLE ProjectStateIndex1 (key TEXT PRIMARY KEY, value JSON)",
      );
      const save = database.prepare("INSERT INTO Environments1 VALUES (?, ?)");
      for (const window of [latestWindow, retiredWindow, liveWindow])
        save.run(key(window), JSON.stringify({ value: clean, storedAt: new Date().toString() }));
      save.run(
        key(recoveryWindow),
        JSON.stringify({
          value: {
            ...clean,
            project: {
              buffers: [{ filePath: "/edited.txt", fileState: "modified", text: "unsaved" }],
            },
          },
        }),
      );
      save.run("history-manager", JSON.stringify({ value: { projects: [] } }));
      database
        .prepare("INSERT INTO ProjectStateIndex1 VALUES (?, ?)")
        .run(`editor-${projectHash}`, JSON.stringify({ value: key(latestWindow) }));
    } finally {
      database.close();
    }
    const service = new SessionStateMaintenance({
      storagePath: directory,
      getProtectedWindowIds: () => [liveWindow],
      timeout: 10000,
    });
    services.push(service);
    const result = await service.run();
    assert.equal(result.removed, 1);
    assert.equal(service.worker, null);
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const keys = restored
        .prepare("SELECT key FROM Environments1")
        .all()
        .map((row) => row.key);
      assert.equal(keys.includes(key(retiredWindow)), false);
      for (const keep of [
        key(latestWindow),
        key(liveWindow),
        key(recoveryWindow),
        "history-manager",
      ])
        assert.equal(keys.includes(keep), true);
    } finally {
      restored.close();
    }
  });

  it("protects pending startup and active window identities across every project", function () {
    const application = {
      pendingWindowStateIds: new Map([
        ["pending", 2],
        ["also-pending", 1],
      ]),
      getAllWindows: () => [
        { windowStateId: "first", projectRoots: ["/first"] },
        { windowStateId: "second", projectRoots: ["/other-project"] },
        { windowStateId: "first", projectRoots: ["/previous-project"] },
        { windowStateId: "test-window", isSpec: true },
        { windowStateId: undefined },
      ],
    };
    assert.deepEqual(
      LumineApplication.prototype.getSessionStateProtectedWindowIds.call(application),
      new Set(["pending", "also-pending", "first", "second"]),
    );
  });

  it("protects every startup window before the first asynchronous open finishes", async function () {
    let finishFirstOpen;
    const firstOpen = new Promise((resolve) => (finishFirstOpen = resolve));
    let beganFirstOpen;
    const began = new Promise((resolve) => (beganFirstOpen = resolve));
    const windows = [];
    const application = {
      configFilePromise: Promise.resolve(),
      config: { get: () => "always" },
      pendingWindowStateIds: new Map(),
      loadPreviousWindowOptions: async () => [
        { windowStateId: "first" },
        { windowStateId: "second" },
      ],
      openWithOptions: async (options) => {
        if (options.windowStateId === "first") {
          beganFirstOpen();
          await firstOpen;
        }
        const window = { windowStateId: options.windowStateId };
        windows.push(window);
        return window;
      },
      getAllWindows: () => windows,
    };
    const launch = LumineApplication.prototype.launch.call(application, {});
    await began;
    assert.deepEqual(
      LumineApplication.prototype.getSessionStateProtectedWindowIds.call(application),
      new Set(["first", "second"]),
    );
    finishFirstOpen();
    assert.equal((await launch).length, 2);
    assert.equal(application.pendingWindowStateIds.size, 0);
    assert.deepEqual(
      LumineApplication.prototype.getSessionStateProtectedWindowIds.call(application),
      new Set(["first", "second"]),
    );
  });
});
