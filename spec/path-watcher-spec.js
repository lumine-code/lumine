const temp = require("@lumine-code/temp");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const { promisify } = require("util");

const { CompositeDisposable } = require("@lumine-code/event-kit");
const {
  NativeWatcher,
  PathWatcherManager,
  watchPath,
  stopAllWatchers,
} = require("../src/path-watcher");
const { conditionPromise } = require("./helpers/async-spec-helpers");

temp.track();

describe("NativeWatcher", function () {
  it("finishes stopping when stop is requested during startup", async function () {
    let finishStart;
    let didStop = false;
    class DelayedNativeWatcher extends NativeWatcher {
      doStart() {
        return new Promise((resolve) => {
          finishStart = resolve;
        });
      }

      doStop() {
        didStop = true;
        return Promise.resolve();
      }
    }

    const watcher = new DelayedNativeWatcher("/delayed");
    watcher.start();
    const stopPromise = watcher.stop();

    expect(didStop).toBe(false);
    finishStart();
    await stopPromise;

    expect(didStop).toBe(true);
    expect(watcher.isRunning()).toBe(false);
  });

  it("completes teardown and reports the original error when startup fails", async function () {
    const startError = new Error("cannot watch path");
    let didCleanUp = false;
    class FailingNativeWatcher extends NativeWatcher {
      doStart() {
        return Promise.reject(startError);
      }

      doStop() {
        didCleanUp = true;
        return Promise.resolve();
      }
    }

    const watcher = new FailingNativeWatcher("/missing");
    const reportedErrors = [];
    const lifecycle = [];
    watcher.onDidError((error) => reportedErrors.push(error));
    watcher.onWillStop(() => lifecycle.push("will-stop"));
    watcher.onDidStop(() => lifecycle.push("did-stop"));

    let caughtError;
    try {
      await watcher.start();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(startError);
    expect(reportedErrors).toEqual([startError]);
    expect(lifecycle).toEqual(["will-stop", "did-stop"]);
    expect(didCleanUp).toBe(true);
    expect(watcher.isRunning()).toBe(false);
  });

  it("completes its stop lifecycle when backend cleanup fails", async function () {
    const stopError = new Error("cannot stop watcher");
    class StopFailingNativeWatcher extends NativeWatcher {
      doStart() {
        return Promise.resolve();
      }

      doStop() {
        return Promise.reject(stopError);
      }
    }

    const watcher = new StopFailingNativeWatcher("/stopping");
    let didStop = false;
    watcher.onDidStop(() => {
      didStop = true;
    });
    await watcher.start();

    let caughtError;
    try {
      await watcher.stop();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(stopError);
    expect(didStop).toBe(true);
    expect(watcher.isRunning()).toBe(false);
  });
});

describe("PathWatcherManager", function () {
  it("rejects and disposes a logical watcher when its native watcher cannot start", async function () {
    const startError = new Error("cannot watch path");
    class FailingNativeWatcher extends NativeWatcher {
      doStart() {
        return Promise.reject(startError);
      }
    }

    const native = new FailingNativeWatcher("/missing");
    let logicalWatcher;
    const registry = {
      attach(watcher) {
        logicalWatcher = watcher;
        watcher.attachToNative(native);
        return Promise.resolve();
      },
      detach: jasmine.createSpy("detach"),
    };
    const manager = new PathWatcherManager();
    manager.nativeRegistry = registry;

    let caughtError;
    try {
      await manager.createWatcher("/missing", () => {}, {});
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(startError);
    expect(registry.detach).toHaveBeenCalledWith(logicalWatcher);
  });
});

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const appendFile = promisify(fs.appendFile);
const realpath = promisify(fs.realpath);
const symlink = promisify(fs.symlink);

const tempMkdir = promisify(temp.mkdir);

describe("watchPath", function () {
  let subs;

  beforeEach(function () {
    subs = new CompositeDisposable();
  });

  afterEach(async function () {
    subs.dispose();
    await watchPath.reset();
  });

  function waitForChanges(watcher, ...fileNames) {
    const waiting = new Set(fileNames);
    let fired = false;
    const relevantEvents = [];

    return new Promise((resolve) => {
      const sub = watcher.onDidChange((events) => {
        for (const event of events) {
          if (waiting.delete(event.path)) {
            relevantEvents.push(event);
          }
        }

        if (!fired && waiting.size === 0) {
          fired = true;
          resolve(relevantEvents);
          sub.dispose();
        }
      });
    });
  }

  // `@lumine-code/watcher` is the only watcher backend.
  const WATCHER_IMPLEMENTATIONS = ["parcel"];

  for (let impl of WATCHER_IMPLEMENTATIONS) {
    describe(`watchPath() (${impl} implementation)`, function () {
      let disposables;
      beforeEach(async () => {
        jasmine.useRealClock();
        disposables = new CompositeDisposable();
      });

      afterEach(() => {
        disposables?.dispose();
      });

      it("resolves the returned promise when the watcher begins listening", async function () {
        const rootDir = await tempMkdir("lumine-fsmanager-test-");

        const watcher = await watchPath(rootDir, {}, () => {});
        expect(watcher.constructor.name).toBe("PathWatcher");
      });

      it("reuses an existing native watcher and resolves getStartPromise immediately if attached to a running watcher", async function () {
        const rootDir = await tempMkdir("lumine-fsmanager-test-");

        const watcher0 = await watchPath(rootDir, {}, () => {});
        const watcher1 = await watchPath(rootDir, {}, () => {});

        expect(watcher0.native).toBe(watcher1.native);
      });

      // `watchPath` deliberately reports every change under the watched root:
      // `core.ignoredNames` is a project-tree display filter, and a watcher
      // that honoured it would stop reporting edits to files the editor still
      // has open. This pins that, so the absence reads as a decision rather
      // than as an oversight.
      it("reports changes under a directory named by `core.ignoredNames`", async () => {
        jasmine.useRealClock();

        const existing = lumine.config.get("core.ignoredNames");
        lumine.config.set("core.ignoredNames", [...existing, "some-other-dir"]);

        // Real path throughout: on macOS the temp directory lives under a
        // symlinked `/var`, and the watcher reports the resolved path, so a
        // comparison against the unresolved one never matches.
        const rootDir = await realpath(await tempMkdir("lumine-fsmanager-test-"));
        const ignoredDir = path.join(rootDir, "some-other-dir");
        await mkdir(ignoredDir, { recursive: true });

        const changes = [];
        const watcher = await watchPath(rootDir, {}, (events) => changes.push(...events));
        disposables.add(watcher);

        const ignoredFile = path.join(ignoredDir, "foo.txt");
        await writeFile(ignoredFile, "something");

        await conditionPromise(
          () => changes.some((event) => event.path === ignoredFile),
          "the watcher to report the file under the ignored directory",
        );
      });

      it("resolves the returned promise when the watcher begins listening", async function () {
        const rootDir = await tempMkdir("lumine-fsmanager-test-");
        const watcher = await watchPath(rootDir, {}, () => {});
        disposables.add(watcher);
        expect(watcher.constructor.name).toBe("PathWatcher");
      });

      it("reuses an existing native watcher and resolves getStartPromise immediately if attached to a running watcher", async function () {
        const rootDir = await tempMkdir("lumine-fsmanager-test-");

        const watcher0 = await watchPath(rootDir, {}, () => {});
        const watcher1 = await watchPath(rootDir, {}, () => {});

        disposables.add(watcher0, watcher1);

        expect(watcher0.native).toBe(watcher1.native);
      });

      it("returns paths that appear to descend from the given path, even when symlinks are involved, when `realPaths` is `false`", async () => {
        jasmine.useRealClock();
        const rootDir = await tempMkdir("lumine-fsmanager-test-");
        const realRootDir = await realpath(rootDir);
        const symlinkedPath = temp.path({ suffix: "-symlinked" });
        await symlink(realRootDir, symlinkedPath);

        let events0 = [];
        let watcher0 = await watchPath(realRootDir, { realPaths: false }, (events) => {
          events0.push(...events);
        });
        let events1 = [];
        let watcher1 = await watchPath(symlinkedPath, { realPaths: false }, (events) => {
          events1.push(...events);
        });

        disposables.add(watcher0, watcher1);

        // Let the native watchers finish arming before triggering the change, so
        // slow CI runners (notably Windows) don't miss the event and hang.
        await wait(process.env.CI ? 2000 : 0);
        await writeFile(path.join(realRootDir, "foo.txt"), "!");
        await conditionPromise(() => {
          return events0.length > 0 && events1.length > 0 && events0.length === events1.length;
        });

        let [first0] = events0;
        let [first1] = events1;

        // Even though these two events describe the same filesystem action,
        // their `path` properties don't match one another; they correspond to
        // the paths given in their respective calls to `watchPath`.
        expect(first0.path).not.toBe(first1.path);
        expect(first0.path.startsWith(realRootDir)).toBe(true);
        expect(first1.path.startsWith(symlinkedPath)).toBe(true);
      });

      it("returns real paths for events when `realPaths` is `true`", async () => {
        jasmine.useRealClock();
        const rootDir = await tempMkdir("lumine-fsmanager-test-");
        const realRootDir = await realpath(rootDir);
        const symlinkedPath = temp.path({ suffix: "-symlinked" });
        await symlink(realRootDir, symlinkedPath);
        await realpath(symlinkedPath);

        let events0 = [];
        let watcher0 = await watchPath(realRootDir, { realPaths: true }, (events) => {
          events0.push(...events);
        });
        let events1 = [];
        let watcher1 = await watchPath(symlinkedPath, { realPaths: true }, (events) => {
          events1.push(...events);
        });

        disposables.add(watcher0, watcher1);

        // Let the native watchers finish arming before triggering the change, so
        // slow CI runners (notably Windows) don't miss the event and hang.
        await wait(process.env.CI ? 2000 : 0);
        await writeFile(path.join(realRootDir, "foo.txt"), "!");
        await conditionPromise(() => {
          return events0.length > 0 && events1.length > 0 && events0.length === events1.length;
        });

        let [first0] = events0;
        let [first1] = events1;

        // Because `realPaths` is `true`, these events will have identical `path`
        // properties that point to the file's true path on disk.
        expect(first0.path).toBe(first1.path);
        expect(first0.path.startsWith(realRootDir)).toBe(true);
        expect(first1.path.startsWith(symlinkedPath)).toBe(false);
      });

      it("normalizes a path without resolving symlinks when `realPaths` is `false`", async () => {
        jasmine.useRealClock();
        const rootDir = await tempMkdir("lumine-fsmanager-test-");
        const realRootDir = await realpath(rootDir);
        const symlinkedPath = temp.path({ suffix: "-symlinked" });
        await symlink(realRootDir, symlinkedPath);

        const relativizedPath = `${symlinkedPath}${path.sep}..${path.sep}${path.basename(symlinkedPath)}`;

        let events0 = [];
        let watcher0 = await watchPath(relativizedPath, { realPaths: false }, (events) => {
          events0.push(...events);
        });
        disposables.add(watcher0);

        // Let the native watcher finish arming before triggering the change.
        await wait(process.env.CI ? 2000 : 0);
        await writeFile(path.join(realRootDir, "foo.txt"), "!");
        await conditionPromise(() => events0.length > 0);

        let [first0] = events0;

        // We want to ensure that the weird relative path the user gave to
        // `watchPath` is resolved internally _without_ it pointing to the real
        // path on disk.
        expect(first0.path.startsWith(symlinkedPath)).toBe(true);
        expect(first0.path.startsWith(relativizedPath)).toBe(false);
      });

      it("recovers running watchers when the worker process dies", async function () {
        jasmine.useRealClock();
        const rootDir = await tempMkdir("lumine-fsmanager-test-").then(realpath);
        const target = path.join(rootDir, "recovery.txt");
        await writeFile(target, "start\n", { encoding: "utf8" });

        const received = [];
        const watcher = await watchPath(rootDir, {}, (events) => received.push(...events));
        disposables.add(watcher);

        // Kill the worker out from under a running watcher. The class must
        // respawn the worker and resubscribe the watcher on its own.
        const WatcherClass = watcher.native.constructor;
        const firstTask = WatcherClass.task;
        firstTask.childProcess.kill("SIGKILL");
        await conditionPromise(() => WatcherClass.task !== firstTask);

        // Nudge the file until the resubscribed watcher reports it; the
        // respawned worker needs a moment to arm.
        const deadline = Date.now() + 30000;
        while (received.length === 0 && Date.now() < deadline) {
          await appendFile(target, "change\n", { encoding: "utf8" });
          await wait(1000);
        }
        expect(received.length).toBeGreaterThan(0);
      }, 45000);

      it("resolves stopAllWatchers when the worker dies with an unwatch in flight", async function () {
        jasmine.useRealClock();
        const rootDir = await tempMkdir("lumine-fsmanager-test-").then(realpath);
        const watcher = await watchPath(rootDir, {}, () => {});
        disposables.add(watcher);

        // Swallow the outgoing unwatch so its reply can never arrive, keeping
        // the request pending until the worker dies.
        const WatcherClass = watcher.native.constructor;
        const task = WatcherClass.task;
        const realSend = task.send.bind(task);
        let droppedUnwatch = false;
        spyOn(task, "send").and.callFake((message) => {
          if (typeof message === "string" && message.includes('"watcher:unwatch"')) {
            droppedUnwatch = true;
            return;
          }
          realSend(message);
        });

        const stopPromise = stopAllWatchers();
        await conditionPromise(() => droppedUnwatch);
        task.childProcess.kill("SIGKILL");

        // The death rejects the pending unwatch with ERR_WATCHER_WORKER_EXITED.
        // A dead worker has already stopped watching, so the stop completes
        // instead of propagating the exit — which the spec harness's per-spec
        // teardown would otherwise attribute to whichever spec just ran.
        await stopPromise;
        WatcherClass.lastWorkerExit = null;
      });

      it("reuses existing native watchers even while they're still starting", async function () {
        const rootDir = await tempMkdir("lumine-fsmanager-test-");

        const [watcher0, watcher1] = await Promise.all([
          watchPath(rootDir, {}, () => {}),
          watchPath(rootDir, {}, () => {}),
        ]);
        expect(watcher0.native).toBe(watcher1.native);
      });

      it("doesn't attach new watchers to a native watcher that's stopping", async function () {
        const rootDir = await tempMkdir("lumine-fsmanager-test-");

        const watcher0 = await watchPath(rootDir, {}, () => {});
        const native0 = watcher0.native;

        watcher0.dispose();
        const watcher1 = await watchPath(rootDir, {}, () => {});

        expect(watcher1.native).not.toBe(native0);
      });

      it("reuses an existing native watcher on a parent directory and filters events", async function () {
        const rootDir = await tempMkdir("lumine-fsmanager-test-").then(realpath);
        const rootFile = path.join(rootDir, "rootfile.txt");
        const subDir = path.join(rootDir, "subdir");
        const subFile = path.join(subDir, "subfile.txt");

        await mkdir(subDir);

        // Keep the watchers alive with an undisposed subscription
        const rootWatcher = await watchPath(rootDir, {}, () => {});
        const childWatcher = await watchPath(subDir, {}, () => {});

        expect(rootWatcher.native).toBe(childWatcher.native);
        expect(rootWatcher.native.isRunning()).toBe(true);

        // Let the native watcher finish arming before triggering the change,
        // so slow CI runners (notably Windows) don't miss the event and hang.
        await wait(process.env.CI ? 2000 : 0);

        const firstChanges = Promise.all([
          waitForChanges(rootWatcher, subFile),
          waitForChanges(childWatcher, subFile),
        ]);
        await writeFile(subFile, "subfile\n", { encoding: "utf8" });
        await firstChanges;

        const nextRootEvent = waitForChanges(rootWatcher, rootFile);
        await writeFile(rootFile, "rootfile\n", { encoding: "utf8" });
        await nextRootEvent;
      });

      it("adopts existing child watchers and filters events appropriately to them", async function () {
        const parentDir = await tempMkdir("lumine-fsmanager-test-").then(realpath);

        // Create the directory tree
        const rootFile = path.join(parentDir, "rootfile.txt");
        const subDir0 = path.join(parentDir, "subdir0");
        const subFile0 = path.join(subDir0, "subfile0.txt");
        const subDir1 = path.join(parentDir, "subdir1");
        const subFile1 = path.join(subDir1, "subfile1.txt");

        await mkdir(subDir0);
        await mkdir(subDir1);
        await Promise.all([
          writeFile(rootFile, "rootfile\n", { encoding: "utf8" }),
          writeFile(subFile0, "subfile 0\n", { encoding: "utf8" }),
          writeFile(subFile1, "subfile 1\n", { encoding: "utf8" }),
        ]);

        // Begin the child watchers and keep them alive
        const subWatcher0 = await watchPath(subDir0, {}, () => {});
        const subWatcherChanges0 = waitForChanges(subWatcher0, subFile0);

        const subWatcher1 = await watchPath(subDir1, {}, () => {});
        const subWatcherChanges1 = waitForChanges(subWatcher1, subFile1);

        expect(subWatcher0.native).not.toBe(subWatcher1.native);

        // Create the parent watcher
        const parentWatcher = await watchPath(parentDir, {}, () => {});
        const parentWatcherChanges = waitForChanges(parentWatcher, rootFile, subFile0, subFile1);

        expect(subWatcher0.native).toBe(parentWatcher.native);
        expect(subWatcher1.native).toBe(parentWatcher.native);

        // Let the adopted native watcher finish arming before triggering changes,
        // so slow CI runners (notably Windows) don't drop events and hang.
        await wait(process.env.CI ? 2000 : 0);

        // Ensure events are filtered correctly
        await Promise.all([
          appendFile(rootFile, "change\n", { encoding: "utf8" }),
          appendFile(subFile0, "change\n", { encoding: "utf8" }),
          appendFile(subFile1, "change\n", { encoding: "utf8" }),
        ]);

        await Promise.all([subWatcherChanges0, subWatcherChanges1, parentWatcherChanges]);
      });
    });
  }
});
