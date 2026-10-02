// Repository-shaped fixtures exercise the installed addon in the application's
// real child worker; no native module is loaded into the renderer test runner.
const fs = require("fs");
const os = require("os");
const path = require("path");
const FileWatchService = require("../src/file-watch-service");
const FileWatchWorker = require("../src/file-watch-worker");
const { deferred } = require("../src/file-watch-protocol");
const { containsPath } = require("../src/file-watch-paths");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(condition, message) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await delay(10);
  }
}

describe("Repository filesystem watch lifecycle", () => {
  let fixture;
  let service;
  let client;
  let observations;

  beforeEach(() => {
    jasmine.useRealClock?.();
    fixture = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-repository-watch-")),
    );
    service = new FileWatchService({ retryDelays: [20, 40, 80], stableDelay: 1000 });
    client = service.createClient("repository-lifecycle");
    observations = [];
  });

  afterEach(async () => {
    await client.close();
    if (service.worker) {
      const diagnostics = await service.requestWorker("diagnostics");
      expect(diagnostics.subscriptions).toBe(0);
      expect(diagnostics.sources).toEqual([]);
    }
    await service.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function copyMetadata(directory) {
    fs.cpSync(path.join(__dirname, "fixtures", "git", "working-dir", "git.git"), directory, {
      recursive: true,
    });
    return path.join(directory, "HEAD");
  }

  function repository(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return copyMetadata(path.join(directory, ".git"));
  }

  function observe(kind, target, recursive = false) {
    const handle =
      kind === "file" ? client.watchFile(target) : client.watchDirectory(target, { recursive });
    const observation = { handle, changes: [], batches: 0, invalidations: [], errors: [] };
    handle.onDidChange((batch) => {
      observation.batches++;
      observation.changes.push(...batch);
    });
    handle.onDidInvalidate((event) => observation.invalidations.push(event));
    handle.onDidError((error) => observation.errors.push(error));
    observations.push(observation);
    return observation;
  }

  function has(observation, action, target = observation.handle.path) {
    return observation.changes.some((event) => event.action === action && event.path === target);
  }

  function clearChanges() {
    for (const observation of observations) observation.changes.length = 0;
  }

  it("keeps the original repository root after a move and observes its replacement", async () => {
    const root = path.join(fixture, "repository");
    const moved = path.join(fixture, "moved-repository");
    const head = repository(root);
    const source = path.join(root, "lib", "main.js");
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, "before");
    const headFile = observe("file", head);
    const sourceFile = observe("file", source);
    await Promise.all([headFile.handle.ready, sourceFile.handle.ready]);
    const tree = observe("directory", root, true);
    await tree.handle.ready;

    fs.renameSync(root, moved);
    await until(
      () => observations.every((observation) => has(observation, "deleted")),
      "the moved repository and descendant files leaving their fixed paths",
    );
    expect(tree.invalidations.length).toBeGreaterThan(0);
    expect(tree.handle.path).toBe(root);
    clearChanges();
    fs.writeFileSync(path.join(moved, ".git", "HEAD"), "ref: refs/heads/moved\n");
    await delay(150);
    expect(tree.changes).toEqual([]);

    repository(root);
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, "recreated");
    await until(
      () => observations.every((observation) => has(observation, "created")),
      "replacement repository and descendants at the original paths",
    );
    clearChanges();
    fs.writeFileSync(head, "ref: refs/heads/recreated\n");
    await until(
      () =>
        tree.changes.some((event) => event.path === head && event.action !== "deleted") &&
        has(headFile, "updated"),
      "replacement metadata activity and its fixed-file update",
    );
    expect(fs.readFileSync(head, "utf8")).toBe("ref: refs/heads/recreated\n");
    // A recursive FSEvents stream does not enumerate pre-existing children.
    // Its first HEAD activity may retain ItemCreated and coalesce this write
    // with the initial creation. Establish that child baseline before asking
    // for the subsequent update's exact action.
    clearChanges();
    fs.writeFileSync(head, "ref: refs/heads/recreated-again\n");
    await until(
      () => has(tree, "updated", head) && has(headFile, "updated"),
      "replacement repository metadata updates",
    );
    expect(fs.readFileSync(head, "utf8")).toBe("ref: refs/heads/recreated-again\n");
    expect(observations.flatMap(({ errors }) => errors)).toEqual([]);
  }, 20000);

  it("preserves the requested spelling across a case-only repository rename", async () => {
    const root = path.join(fixture, "case-repository");
    const renamed = path.join(fixture, "CASE-REPOSITORY");
    const head = repository(root);
    const headFile = observe("file", head);
    const tree = observe("directory", root, true);
    const workspace = observe("directory", fixture, true);
    await Promise.all(observations.map(({ handle }) => handle.ready));

    fs.renameSync(root, renamed);
    await until(
      () => has(workspace, "deleted", root) && has(workspace, "created", renamed),
      "the workspace's old and new repository spellings",
    );
    if (fs.existsSync(root)) {
      await until(
        () => tree.invalidations.length > 0 && headFile.invalidations.length > 0,
        "case-only root and file topology recovery",
      );
      expect(has(tree, "deleted")).toBe(false);
    } else {
      await until(() => has(tree, "deleted"), "the old spelling leaving a case-sensitive volume");
      repository(root);
      await until(() => has(tree, "created"), "the original spelling being recreated");
    }
    expect(tree.handle.path).toBe(root);
    clearChanges();
    fs.writeFileSync(head, "ref: refs/heads/case-recovery\n");
    await until(
      () => has(tree, "updated", head) && has(headFile, "updated"),
      "writes under the requested root spelling",
    );
    expect(
      tree.changes.every(
        (event) => event.path === root || event.path.startsWith(`${root}${path.sep}`),
      ),
    ).toBe(true);
    expect(headFile.changes.every((event) => event.path === head)).toBe(true);
    expect(workspace.errors).toEqual([]);
    expect(tree.errors).toEqual([]);
  }, 20000);

  it("recovers fixed repository and file paths after an ancestor moves within a watched workspace", async () => {
    const ancestor = path.join(fixture, "ancestor");
    const root = path.join(ancestor, "nested", "repository");
    const head = repository(root);
    const source = path.join(root, "lib", "main.js");
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, "before");
    const headFile = observe("file", head);
    const sourceFile = observe("file", source);
    const tree = observe("directory", root, true);
    await Promise.all(observations.map(({ handle }) => handle.ready));
    const workspace = observe("directory", fixture, true);
    await workspace.handle.ready;

    fs.renameSync(ancestor, path.join(fixture, "moved-ancestor"));
    await until(
      () => [headFile, sourceFile, tree].every((observation) => has(observation, "deleted")),
      "fixed descendant paths leaving with their ancestor",
    );
    clearChanges();
    fs.writeFileSync(
      path.join(fixture, "moved-ancestor", "nested", "repository", ".git", "HEAD"),
      "ref: refs/heads/moved-ancestor\n",
    );
    await delay(150);
    expect([headFile, sourceFile, tree].flatMap(({ changes }) => changes)).toEqual([]);

    repository(root);
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, "recreated");
    await until(
      () => [headFile, sourceFile, tree].every((observation) => has(observation, "created")),
      "repository descendants under the recreated ancestor",
    );
    clearChanges();
    fs.writeFileSync(head, "ref: refs/heads/recreated-ancestor\n");
    await until(
      () => has(headFile, "updated") && has(tree, "updated", head),
      "recreated ancestor content observation",
    );
    expect(observations.flatMap(({ errors }) => errors)).toEqual([]);
  }, 20000);

  it("observes copied, removed and restored .git directories through fixed metadata paths", async () => {
    const root = path.join(fixture, "working-directory");
    const metadata = path.join(root, ".git");
    const head = path.join(metadata, "HEAD");
    fs.mkdirSync(root);
    const tree = observe("directory", root, true);
    const git = observe("directory", metadata, true);
    const headFile = observe("file", head);
    await Promise.all(observations.map(({ handle }) => handle.ready));

    copyMetadata(metadata);
    await until(
      () => has(tree, "created", metadata) && has(git, "created") && has(headFile, "created"),
      "copied repository metadata appearing at its fixed paths",
    );
    clearChanges();
    fs.writeFileSync(head, "ref: refs/heads/copied\n");
    await until(() => has(headFile, "updated"), "copied HEAD contents");

    fs.rmSync(metadata, { recursive: true });
    await until(
      () => has(tree, "deleted", metadata) && has(git, "deleted") && has(headFile, "deleted"),
      "removed repository metadata",
    );
    clearChanges();
    copyMetadata(metadata);
    await until(
      () => has(tree, "created", metadata) && has(git, "created") && has(headFile, "created"),
      "restored metadata sources",
    );
    clearChanges();
    fs.writeFileSync(head, "ref: refs/heads/restored\n");
    await until(() => has(headFile, "updated"), "restored HEAD observation");
    expect(observations.flatMap(({ errors }) => errors)).toEqual([]);
  }, 20000);

  it("reports gitfile marker creation, replacement and deletion at one fixed path", async () => {
    const root = path.join(fixture, "worktree");
    const marker = path.join(root, ".git");
    const first = path.join(fixture, "first.git");
    const second = path.join(fixture, "second.git");
    fs.mkdirSync(root);
    copyMetadata(first);
    copyMetadata(second);
    const tree = observe("directory", root, true);
    const gitfile = observe("file", marker);
    await Promise.all(observations.map(({ handle }) => handle.ready));

    fs.writeFileSync(marker, "gitdir: ../first.git\n");
    await until(() => has(gitfile, "created") && has(tree, "created", marker), "gitfile creation");
    clearChanges();
    fs.writeFileSync(marker, "gitdir: ../second.git\n");
    await until(
      () => has(gitfile, "updated") && has(tree, "updated", marker),
      "gitfile retargeting",
    );
    clearChanges();
    fs.unlinkSync(marker);
    await until(() => has(gitfile, "deleted") && has(tree, "deleted", marker), "gitfile deletion");
    expect(gitfile.handle.path).toBe(marker);
    expect(observations.flatMap(({ errors }) => errors)).toEqual([]);
  }, 20000);

  it("pools repository sources during worktree and object bursts and releases every source", async () => {
    const root = path.join(fixture, "repository");
    const head = repository(root);
    const working = path.join(root, "generated");
    const objects = path.join(root, ".git", "objects", "generated");
    fs.mkdirSync(working);
    fs.mkdirSync(objects);
    const first = observe("directory", root, true);
    const second = observe("directory", root, true);
    const headFile = observe("file", head);
    await Promise.all(observations.map(({ handle }) => handle.ready));
    const armed = await service.requestWorker("diagnostics");
    const canonicalRoot = fs.realpathSync.native(root);
    const recursive = armed.sources.filter(
      (source) => source.path === canonicalRoot && source.recursive,
    );
    expect(recursive.length).toBe(1);
    expect(recursive[0].subscribers).toBe(3);
    expect(recursive[0].guard).toBe(false);

    const started = performance.now();
    const files = [];
    for (let index = 0; index < 300; index++) {
      for (const directory of [working, objects]) {
        const file = path.join(directory, String(index));
        fs.writeFileSync(file, `contents ${index}\n`);
        files.push(file);
      }
    }
    fs.writeFileSync(head, "ref: refs/heads/burst-recovery\n");
    await until(
      () =>
        files.every((file) => has(first, "created", file) && has(second, "created", file)) &&
        has(headFile, "updated"),
      "all worktree and metadata burst paths",
    );
    const deliveredMs = performance.now() - started;
    const settled = await service.requestWorker("diagnostics");
    expect(settled.sources).toEqual(armed.sources);
    expect(observations.flatMap(({ errors }) => errors)).toEqual([]);
    expect(observations.flatMap(({ invalidations }) => invalidations)).toEqual([]);
    if (process.env.LUMINE_FILE_WATCH_REPOSITORY_METRICS === "1") {
      console.log(
        "REPOSITORY_WATCH_METRICS",
        JSON.stringify({
          platform: process.platform,
          burstPaths: files.length,
          deliveredMs,
          directoryBatches: [first.batches, second.batches],
          headChanges: headFile.changes.length,
          logicalSubscriptions: settled.subscriptions,
          nativeSources: settled.sources.length,
        }),
      );
    }
    await client.close();
    const released = await service.requestWorker("diagnostics");
    expect(released.subscriptions).toBe(0);
    expect(released.sources).toEqual([]);
  }, 20000);
});

class ControlledEngine {
  constructor() {
    this.sources = new Set();
    this.created = [];
  }

  watchDirectory(directory, options, callback) {
    const ready = deferred();
    const closed = deferred();
    const source = {
      directory,
      ...options,
      callback,
      ready: ready.promise,
      closed: closed.promise,
      armed: false,
      disposed: false,
      arm: () => {
        source.armed = true;
        ready.resolve();
      },
      release: closed.resolve,
      dispose: () => {
        if (source.disposed) return;
        source.disposed = true;
        this.sources.delete(source);
        ready.reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
        this.onDispose?.(source);
        if (!this.holdClose?.(source)) closed.resolve();
      },
    };
    this.sources.add(source);
    this.created.push(source);
    if (!this.holdReady?.(source)) source.arm();
    return source;
  }

  emit(event) {
    for (const source of this.sources) {
      if (source.armed && containsPath(source.directory, event.path, source.recursive)) {
        source.callback(source.guard ? { type: "guard" } : { type: "changes", events: [event] });
      }
    }
  }

  async close() {
    for (const source of [...this.sources]) source.dispose();
  }
}

describe("Recursive source coverage handoffs", () => {
  let fixture;
  let nested;
  let target;
  let engine;
  let worker;
  let events;

  beforeEach(() => {
    jasmine.useRealClock?.();
    fixture = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-watch-coverage-")),
    );
    nested = path.join(fixture, "repository", "nested");
    target = path.join(nested, "file");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(target, "before");
    engine = new ControlledEngine();
    events = [];
    worker = new FileWatchWorker({
      engine,
      settleDelay: 5,
      retryDelay: 10,
      sendEvent: (event) => events.push(event),
    });
  });

  afterEach(async () => {
    for (const source of engine.created) source.release();
    await worker.close();
    expect(engine.sources.size).toBe(0);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function subscribe(id, kind, requested, recursive = false) {
    return worker.subscribe({ id, kind, path: requested, recursive });
  }

  function changes(id) {
    return events
      .filter((event) => event.id === id && event.type === "changes")
      .flatMap((event) => event.payload);
  }

  function insideSources() {
    return [...engine.sources].filter((source) => containsPath(fixture, source.directory, true));
  }

  it("covers nested files and filters shallow directory events under an existing recursive parent", async () => {
    await subscribe(1, "directory", fixture, true);
    await subscribe(2, "file", target);
    await subscribe(3, "directory", path.dirname(nested));
    expect(insideSources().length).toBe(1);
    expect(insideSources()[0].recursive).toBe(true);
    fs.writeFileSync(target, "after parent coverage");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length && changes(2).length, "covered file delivery");
    expect(changes(2)).toEqual([{ action: "updated", path: target }]);
    expect(changes(3)).toEqual([]);
    const child = path.join(path.dirname(nested), "direct-child");
    fs.writeFileSync(child, "direct");
    engine.emit({ action: "created", path: child });
    await until(() => changes(3).length, "shallow direct membership");
    expect(changes(3)).toEqual([{ action: "created", path: child }]);
  });

  it("migrates an already armed descendant after the parent's native readiness and closed barrier", async () => {
    await subscribe(1, "file", target);
    const previous = [...engine.sources].find((source) => source.directory === nested);
    engine.holdReady = (source) => source.directory === fixture && source.recursive;
    engine.holdClose = (source) => source === previous;
    let ready = false;
    const parent = subscribe(2, "directory", fixture, true).then(() => (ready = true));
    await until(
      () => engine.created.some((source) => source.directory === fixture && source.recursive),
      "pending recursive parent",
    );
    expect(previous.disposed).toBe(false);
    fs.writeFileSync(target, "write before parent ready");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length, "delivery before parent readiness");
    const recursive = engine.created.find(
      (source) => source.directory === fixture && source.recursive,
    );
    recursive.arm();
    await until(() => previous.disposed, "native descendant retirement");
    await delay(20);
    expect(ready).toBe(false);
    previous.callback({ type: "error", error: { code: "ABORT_ERR", message: "retired" } });
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    previous.release();
    await parent;
    expect(insideSources().length).toBe(1);
    events.length = 0;
    fs.writeFileSync(target, "write after parent readiness");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length, "delivery after migration");
    expect(changes(1)).toEqual([{ action: "updated", path: target }]);
  });

  it("transfers an in-flight descendant whose native ready would otherwise reject on cancellation", async () => {
    engine.holdReady = (source) => source.directory === nested;
    const child = subscribe(1, "file", target);
    child.catch(() => {});
    await until(
      () => engine.created.some((source) => source.directory === nested),
      "pending descendant source",
    );
    await subscribe(2, "directory", fixture, true);
    await child;
    expect(insideSources().length).toBe(1);
    expect(worker.subscriptions.get(1).sources.size).toBeGreaterThan(0);
    fs.writeFileSync(target, "after in-flight transfer");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length, "transferred pending descendant delivery");
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  it("cancels a migrated child while the parent waits for retired native cleanup", async () => {
    await subscribe(1, "file", target);
    const previous = [...engine.sources].find((source) => source.directory === nested);
    engine.holdClose = (source) => source === previous;
    const parent = subscribe(2, "directory", fixture, true);
    await until(() => previous.disposed, "migration awaiting closed");
    await worker.unsubscribe(1);
    fs.writeFileSync(target, "after child disposal");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await delay(20);
    expect(changes(1)).toEqual([]);
    previous.release();
    await parent;
    await until(() => changes(2).length, "surviving parent delivery");
    expect(worker.subscriptions.has(1)).toBe(false);
  });

  it("preserves migrated child ownership when the recursive parent subscriber is cancelled", async () => {
    await subscribe(1, "file", target);
    const previous = [...engine.sources].find((source) => source.directory === nested);
    engine.holdClose = (source) => source === previous;
    const parent = subscribe(2, "directory", fixture, true);
    parent.catch(() => {});
    await until(() => previous.disposed, "retiring descendant native source");
    await worker.unsubscribe(2);
    await expectAsync(parent).toBeRejectedWith(jasmine.objectContaining({ code: "ABORT_ERR" }));
    fs.writeFileSync(target, "after parent owner disposal");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length, "child ownership of the armed recursive source");
    expect(changes(2)).toEqual([]);
    previous.release();
    expect(insideSources().length).toBe(1);
  });

  it("does not borrow a recursive source whose directory identity was replaced at the same path", async () => {
    const root = path.join(fixture, "repository");
    await subscribe(1, "directory", root, true);
    const stale = [...worker.sources.values()].find(
      (source) => source.path === root && source.recursive,
    );
    fs.renameSync(root, path.join(fixture, "old-repository"));
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(target, "replacement identity");
    await subscribe(2, "file", target);
    expect([...worker.subscriptions.get(2).sources.values()]).not.toContain(stale);
    fs.writeFileSync(target, "new generation updated");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(2).length, "replacement root's file source");
    expect(changes(2)).toEqual([{ action: "updated", path: target }]);
  });

  it("retains directory creation when a covered timestamp event arrives during topology verification", async () => {
    await subscribe(1, "directory", fixture, true);
    const missing = path.join(fixture, "new-repository");
    await subscribe(2, "directory", missing, true);
    const plan = worker.plan.bind(worker);
    let injected = false;
    worker.plan = async (logical, coalesce) => {
      const result = await plan(logical, coalesce);
      if (logical.id === 2 && !coalesce && !injected) {
        injected = true;
        engine.emit({ action: "updated", path: missing });
      }
      return result;
    };
    fs.mkdirSync(missing);
    engine.emit({ action: "created", path: missing });
    await until(() => changes(2).length, "verified directory creation");
    expect(changes(2)).toEqual([{ action: "created", path: missing }]);
  });

  it("preserves macOS relocation guards when descendant streams are covered by a wider recursive source", async () => {
    worker.platform = "darwin";
    const root = path.dirname(nested);
    await subscribe(1, "file", target);
    await subscribe(2, "directory", root, true);
    await subscribe(3, "directory", fixture, true);
    expect(insideSources().length).toBe(1);
    fs.renameSync(root, path.join(fixture, "moved-repository"));
    // The wider stream receives only the containing directory's rename.
    // No descendant RootChanged signal or child filename notification exists.
    engine.emit({ action: "deleted", path: root });
    engine.emit({ action: "created", path: path.join(fixture, "moved-repository") });
    await until(
      () =>
        changes(1).some((event) => event.action === "deleted") &&
        changes(2).some((event) => event.action === "deleted"),
      "covered macOS descendant relocation",
    );
    expect(changes(1)).toEqual([{ action: "deleted", path: target }]);
    expect(changes(2)).toEqual([{ action: "deleted", path: root }]);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(target, "new ancestor contents");
    engine.emit({ action: "created", path: root });
    await until(
      () => changes(1).some((event) => event.action === "created"),
      "covered macOS descendant recreation",
    );
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  it("inherits the deepest native close barrier when two recursive parents migrate in succession", async () => {
    await subscribe(1, "file", target);
    const previous = [...engine.sources].find((source) => source.directory === nested);
    engine.holdClose = (source) => source === previous;
    const repositoryReady = subscribe(2, "directory", path.dirname(nested), true);
    await until(() => previous.disposed, "first recursive parent's descendant migration");
    let workspaceReady = false;
    const workspace = subscribe(3, "directory", fixture, true).then(() => (workspaceReady = true));
    await until(
      () => insideSources().length === 1 && insideSources()[0].directory === fixture,
      "wider recursive source ownership",
    );
    await delay(20);
    expect(workspaceReady).toBe(false);
    previous.release();
    await Promise.all([repositoryReady, workspace]);
    expect(workspaceReady).toBe(true);
    expect(insideSources().length).toBe(1);
    fs.writeFileSync(target, "after both parent handoffs");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length, "child after transitive migration");
  });

  it("awaits retired descendant cleanup when the last owner cancels a migrating parent", async () => {
    await subscribe(1, "file", target);
    const previous = [...engine.sources].find((source) => source.directory === nested);
    engine.holdClose = (source) => source === previous;
    const parent = subscribe(2, "directory", fixture, true);
    parent.catch(() => {});
    await until(() => previous.disposed, "migration before cancelling both owners");
    await worker.unsubscribe(1);
    let closed = false;
    const cancellation = worker.unsubscribe(2).then(() => (closed = true));
    await delay(20);
    expect(closed).toBe(false);
    previous.release();
    await cancellation;
    await parent.catch(() => {});
    expect(worker.subscriptions.size).toBe(0);
    expect(engine.sources.size).toBe(0);
  });

  it("adopts a descendant lookup that finishes after its recursive parent is already ready", async () => {
    const started = deferred();
    const finish = deferred();
    const coveringSource = worker.coveringSource.bind(worker);
    let held = false;
    worker.coveringSource = async (logical, descriptor, excluded) => {
      if (logical?.id === 1 && descriptor.directory === nested && !held) {
        held = true;
        started.resolve();
        await finish.promise;
        return null;
      }
      return coveringSource(logical, descriptor, excluded);
    };
    let ready = false;
    const child = subscribe(1, "file", target).then(() => (ready = true));
    await started.promise;
    await subscribe(2, "directory", fixture, true);
    engine.holdClose = (source) => source.directory === nested;
    finish.resolve();
    await until(
      () => engine.created.some((source) => source.directory === nested && source.disposed),
      "late descendant source being retired",
    );
    await delay(20);
    expect(ready).toBe(false);
    const previous = engine.created.find((source) => source.directory === nested);
    previous.release();
    await child;
    expect(insideSources().length).toBe(1);
    fs.writeFileSync(target, "after the stale acquisition lookup");
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length, "late descendant covered by its ready parent");
  });
});
