const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const FileWatchWorker = require("../src/file-watch-worker");
const FileWatchService = require("../src/file-watch-service");
const FileWatchClient = require("../src/file-watch-client");
const { containsPath, ancestors } = require("../src/file-watch-paths");
const { VERSION, deferred, MAX_QUEUED_EVENTS, mergeChange } = require("../src/file-watch-protocol");

async function until(condition, message = "condition") {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeEngine {
  constructor() {
    this.sources = new Set();
    this.created = [];
    this.holdReady = false;
  }

  watchDirectory(directory, { recursive }, callback) {
    const ready = deferred();
    const closed = deferred();
    const source = {
      directory,
      recursive,
      callback,
      ready: ready.promise,
      closed: closed.promise,
      arm: ready.resolve,
      dispose: () => {
        if (!this.sources.delete(source)) return;
        ready.reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
        closed.resolve();
      },
    };
    this.sources.add(source);
    this.created.push(source);
    if (!this.holdReady) ready.resolve();
    return source;
  }

  emit(event) {
    for (const source of this.sources) {
      if (containsPath(source.directory, event.path, source.recursive)) {
        source.callback({ type: "changes", events: [event] });
      }
    }
  }

  async close() {
    for (const source of this.sources) source.dispose();
  }
}

class FakeChild extends EventEmitter {
  constructor(generation) {
    super();
    this.generation = generation;
    this.connected = true;
    this.engine = new FakeEngine();
    this.runtime = new FileWatchWorker({
      engine: this.engine,
      settleDelay: 5,
      retryDelay: 10,
      sendEvent: ({ id, type, payload }) =>
        this.message({
          type: "event",
          id,
          eventType: type,
          payload,
        }),
    });
    setImmediate(() => this.message({ type: "ready" }));
  }

  message(message) {
    if (this.connected) {
      this.emit("message", { version: VERSION, generation: this.generation, ...message });
    }
  }

  send(message, callback) {
    callback?.(null);
    const operation =
      message.type === "subscribe"
        ? this.runtime.subscribe(message)
        : message.type === "unsubscribe"
          ? this.runtime.unsubscribe(message.id)
          : this.runtime.close();
    operation.then(
      (payload) => this.message({ type: "reply", requestId: message.requestId, payload }),
      (error) => this.message({ type: "reply", requestId: message.requestId, error }),
    );
  }

  kill() {
    if (!this.connected) return;
    this.connected = false;
    this.runtime.close();
    this.emit("exit", 1, null);
    this.emit("close", 1, null);
  }
}

describe("File watch runtime", () => {
  let directory;
  let engine;
  let worker;
  let events;
  let service;
  let children;

  beforeEach(() => {
    jasmine.useRealClock?.();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-watch-")));
    engine = new FakeEngine();
    events = [];
    worker = new FileWatchWorker({
      engine,
      sendEvent: (event) => events.push(event),
      settleDelay: 5,
      retryDelay: 10,
    });
    children = [];
    service = new FileWatchService({
      retryDelays: [5, 10, 15],
      stableDelay: 1000,
      spawnWorker: ({ generation }) => {
        const child = new FakeChild(generation);
        children.push(child);
        return child;
      },
    });
  });

  afterEach(async () => {
    await service.close();
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function changes(id) {
    return events
      .filter((event) => event.id === id && event.type === "changes")
      .flatMap((event) => event.payload);
  }

  function subscribe(id, kind, targetPath, recursive = false) {
    return worker.subscribe({ id, kind, path: targetPath, recursive });
  }

  it("preserves UNC roots and does not match sibling prefixes or case variants", () => {
    expect(ancestors("\\\\server\\share\\folder", path.win32)).toEqual([
      "\\\\server\\share\\",
      "\\\\server\\share\\folder",
    ]);
    expect(containsPath("C:\\foo", "C:\\foo-other\\file", true, path.win32)).toBe(false);
    expect(containsPath("C:\\foo", "C:\\Foo\\file", true, path.win32)).toBe(false);
    expect(containsPath("C:\\foo", "C:\\foo\\file", false, path.win32)).toBe(true);
    expect(containsPath("C:\\foo", "C:\\foo\\sub\\file", false, path.win32)).toBe(false);
  });

  it("preserves membership transitions in the coalescer shared by all three queues", () => {
    for (const [first, second, expected] of [
      ["created", "updated", "created"],
      ["created", "deleted", null],
      ["deleted", "created", "updated"],
      ["updated", "deleted", "deleted"],
    ]) {
      const queue = new Map();
      let count = mergeChange(queue, { action: first, path: directory });
      count += mergeChange(queue, { action: second, path: directory });
      expect(queue.get(directory)?.action || null).toBe(expected);
      expect(count).toBe(queue.size);
    }
  });

  it("retains a recursive create event while the new file is repeatedly rewritten", async () => {
    await subscribe(1, "directory", directory, true);
    const target = path.join(directory, "rapid-file");
    engine.emit({ action: "created", path: target });
    for (let i = 0; i < 20; i++) engine.emit({ action: "updated", path: target });
    await until(() => changes(1).length);
    expect(changes(1)).toEqual([{ action: "created", path: target }]);
  });

  it("retains membership changes while a renderer's previous event is awaiting acknowledgement", async () => {
    const delivered = [];
    await service.dispatch(
      "paused",
      { type: "subscribe", id: 1, kind: "directory", path: directory, recursive: true },
      (event) => delivered.push(event),
    );
    const id = service.owners.get("paused").subscriptions.get(1).id;
    const emit = (action, name) =>
      children[0].message({
        type: "event",
        id,
        eventType: "changes",
        payload: [{ action, path: path.join(directory, name) }],
      });
    emit("created", "blocker");
    emit("created", "new-file");
    emit("updated", "new-file");
    emit("created", "temporary");
    emit("deleted", "temporary");
    emit("deleted", "replacement");
    emit("created", "replacement");
    emit("updated", "removed");
    emit("deleted", "removed");
    await service.dispatch("paused", { type: "ack", sequence: delivered[0].sequence });
    expect(delivered[1].payload).toEqual([
      { action: "created", path: path.join(directory, "new-file") },
      { action: "updated", path: path.join(directory, "replacement") },
      { action: "deleted", path: path.join(directory, "removed") },
    ]);
    expect(service.owners.get("paused").queuedEvents).toBe(0);
    await service.closeOwner("paused");
  });

  it("pools identical directories without subsuming a nested file under a shallow watch", async () => {
    const nested = path.join(directory, "constructor", "__proto__");
    fs.mkdirSync(nested, { recursive: true });
    const target = path.join(nested, "file.txt");
    fs.writeFileSync(target, "before");
    await Promise.all([
      subscribe(1, "directory", directory),
      subscribe(2, "file", target),
      subscribe(3, "directory", directory, true),
    ]);
    fs.writeFileSync(target, "after modification");
    engine.emit({ action: "updated", path: target });
    await until(() => changes(2).length && changes(3).length);
    expect(changes(1)).toEqual([]);
    expect(changes(2)).toEqual([{ action: "updated", path: target }]);
    expect(worker.diagnostics().sources.filter((source) => source.path === directory).length).toBe(
      2,
    );
    await Promise.all([1, 2, 3].map((id) => worker.unsubscribe(id)));
    expect(worker.diagnostics().sources).toEqual([]);
    expect(engine.sources.size).toBe(0);
  });

  it("shares file parent sources and releases every listener after repeated arm/close", async () => {
    const first = path.join(directory, "one");
    const second = path.join(directory, "two");
    await Promise.all([subscribe(1, "file", first), subscribe(2, "file", second)]);
    expect([...engine.sources].filter((source) => source.directory === directory).length).toBe(1);
    await worker.unsubscribe(1);
    expect(engine.sources.size).toBeGreaterThan(0);
    await worker.unsubscribe(2);
    for (let i = 3; i < 23; i++) {
      await subscribe(i, "file", first);
      await worker.unsubscribe(i);
    }
    expect(worker.subscriptions.size).toBe(0);
    expect(engine.sources.size).toBe(0);
  });

  it("cancels a pending shared source without waiting for the other owner's ready", async () => {
    engine.holdReady = true;
    const first = subscribe(1, "file", path.join(directory, "first"));
    const second = subscribe(2, "file", path.join(directory, "second"));
    first.catch(() => {});
    second.catch(() => {});
    await until(() => [...worker.sources.values()].some((source) => source.members.size === 2));
    await worker.unsubscribe(1);
    await expectAsync(first).toBeRejected();
    expect(engine.sources.size).toBe(1);
    engine.holdReady = false;
    for (const source of engine.sources) source.arm();
    await second;
    await worker.unsubscribe(2);
    expect(engine.sources.size).toBe(0);
  });

  it("observes a missing directory chain as a file and notices its eventual creation", async () => {
    const parent = path.join(directory, "missing", "child");
    const target = path.join(parent, "file");
    await subscribe(1, "file", target);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(target, "created");
    engine.emit({ action: "created", path: path.join(directory, "missing") });
    await until(() => changes(1).some((event) => event.action === "created"));
    expect(changes(1)[0].path).toBe(target);
    fs.writeFileSync(target, "new contents");
    engine.emit({ action: "updated", path: target });
    await until(() => changes(1).some((event) => event.action === "updated"));
  });

  it("keeps directory watches fixed across ancestor rename and recreation", async () => {
    const parent = path.join(directory, "parent");
    const target = path.join(parent, "target");
    fs.mkdirSync(target, { recursive: true });
    await subscribe(1, "directory", target, true);
    fs.renameSync(parent, path.join(directory, "moved"));
    engine.emit({ action: "deleted", path: parent });
    await until(() => changes(1).some((event) => event.action === "deleted"));
    fs.mkdirSync(target, { recursive: true });
    engine.emit({ action: "created", path: parent });
    await until(() => changes(1).some((event) => event.action === "created"));
    const file = path.join(target, "new.txt");
    fs.writeFileSync(file, "new");
    engine.emit({ action: "created", path: file });
    await until(() => changes(1).some((event) => event.path === file));
    expect(changes(1).every((event) => containsPath(target, event.path))).toBe(true);
  });

  it("coalesces atomic saves, ignores access time and reports external rename as deletion", async () => {
    const target = path.join(directory, "document");
    fs.writeFileSync(target, "original");
    const oldStat = fs.statSync(target);
    fs.utimesSync(target, oldStat.atime, new Date(1600000000000));
    await subscribe(1, "file", target);
    fs.utimesSync(target, new Date(), new Date(1600000000000));
    engine.emit({ action: "updated", path: target });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changes(1)).toEqual([]);
    const temporary = path.join(directory, "temporary");
    fs.writeFileSync(temporary, "replacement");
    fs.renameSync(temporary, target);
    engine.emit({ action: "deleted", path: target });
    engine.emit({ action: "created", path: target });
    await until(() => changes(1).length);
    expect(changes(1)).toEqual([{ action: "updated", path: target }]);
    fs.renameSync(target, temporary);
    engine.emit({ action: "deleted", path: target });
    await until(() => changes(1).length === 2);
    expect(changes(1)[1]).toEqual({ action: "deleted", path: target });
  });

  it("arms replacement sources before closing invalidated sources and invalidates before changes", async () => {
    await subscribe(1, "directory", directory, true);
    const source = [...engine.sources].find(
      (item) => item.directory === directory && item.recursive,
    );
    engine.holdReady = true;
    source.callback({ type: "invalidate", reason: "overflow" });
    await until(
      () =>
        [...engine.sources].filter((item) => item.directory === directory && item.recursive)
          .length === 2,
    );
    expect(engine.sources.has(source)).toBe(true);
    engine.holdReady = false;
    for (const item of engine.sources) item.arm();
    await until(() => events.some((event) => event.type === "invalidate"));
    expect(engine.sources.has(source)).toBe(false);
    engine.emit({ action: "created", path: path.join(directory, "after") });
    await until(() => changes(1).length);
    expect(events.map((event) => event.type)).toEqual(["invalidate", "changes"]);
  });

  it("rejects the wrong target kind and cleans partial startup sources", async () => {
    const target = path.join(directory, "file");
    fs.writeFileSync(target, "file");
    await expectAsync(subscribe(1, "directory", target)).toBeRejectedWith(
      jasmine.objectContaining({ code: "ENOTDIR" }),
    );
    await expectAsync(subscribe(2, "file", directory)).toBeRejectedWith(
      jasmine.objectContaining({ code: "EISDIR" }),
    );
    expect(engine.sources.size).toBe(0);
    expect(worker.subscriptions.size).toBe(0);
  });

  it("preserves explicit native content changes when size and mtime remain equal", async () => {
    const target = path.join(directory, "same-metadata");
    fs.writeFileSync(target, "before");
    fs.utimesSync(target, new Date(1600000000000), new Date(1600000000000));
    await subscribe(1, "file", target);
    fs.writeFileSync(target, "after!");
    fs.utimesSync(target, new Date(1600000000000), new Date(1600000000000));
    engine.emit({ action: "updated", path: target, contentChanged: true });
    await until(() => changes(1).length);
    expect(changes(1)).toEqual([{ action: "updated", path: target }]);
  });

  it("assigns a new recovery generation to each overflow within one process", async () => {
    const client = service.createClient("overflow");
    const handle = client.watchDirectory(directory, { recursive: true });
    const invalidations = [];
    handle.onDidInvalidate((event) => invalidations.push(event));
    await handle.ready;
    const invalidate = () =>
      [...children[0].engine.sources]
        .find((source) => source.directory === directory && source.recursive)
        .callback({ type: "invalidate", reason: "overflow" });
    invalidate();
    await until(() => invalidations.length === 1);
    invalidate();
    await until(() => invalidations.length === 2);
    expect(invalidations[1].generation).toBeGreaterThan(invalidations[0].generation);
    expect(children.length).toBe(1);
    await client.close();
  });

  it("isolates clients and re-arms all surviving subscriptions after two fast worker crashes", async () => {
    const first = service.createClient("first-window");
    const second = service.createClient("second-window");
    const a = first.watchFile(path.join(directory, "a"));
    const b = second.watchFile(path.join(directory, "b"));
    const invalidations = [];
    const received = [];
    b.onDidInvalidate((event) => invalidations.push(event));
    b.onDidChange((batch) => received.push(...batch));
    await Promise.all([a.ready, b.ready]);
    children[0].kill();
    await until(() => children.length === 2);
    await until(() => service.diagnostics("second-window").subscriptions[0].active);
    children[1].kill();
    await until(() => children.length === 3);
    await until(() => invalidations.length === 2);
    expect(invalidations.map((event) => event.generation)).toEqual([1, 2]);
    await first.close();
    await service.closeOwner("first-window");
    expect(service.diagnostics("second-window").subscriptions.length).toBe(1);
    fs.writeFileSync(b.path, "alive");
    children[2].engine.emit({ action: "created", path: b.path });
    await until(() => received.length);
    expect(received[0].path).toBe(b.path);
    await second.close();
    expect(service.diagnostics().subscriptions).toEqual([]);
  });

  it("suppresses callbacks synchronously on dispose, rejects pending ready, and supports reuse after disposeAll", async () => {
    const client = service.createClient("test-window");
    const first = client.watchFile(path.join(directory, "first"));
    first.dispose();
    first.dispose();
    await expectAsync(first.ready).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
    await first.closed;
    const second = client.watchDirectory(directory);
    const callback = jasmine.createSpy("change");
    second.onDidChange(callback);
    await second.ready;
    children.at(-1).engine.emit({ action: "created", path: path.join(directory, "test") });
    second.dispose();
    await client.disposeAll();
    expect(callback).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);
    const third = client.watchFile(path.join(directory, "third"));
    await third.ready;
    await client.close();
    expect(client.isClosed).toBe(true);
    expect((await client.diagnostics()).subscriptions).toEqual([]);
    expect(service.owners.size).toBe(0);
  });

  it("rejects permanent worker startup errors instead of retrying unresolved ready forever", async () => {
    const client = service.createClient("broken-addon");
    const handle = client.watchFile(path.join(directory, "file"));
    children[0].message({
      type: "fatal",
      error: { message: "Addon unavailable", code: "MODULE_NOT_FOUND" },
    });
    await expectAsync(handle.ready).toBeRejectedWith(
      jasmine.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
    await handle.closed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(children.length).toBe(1);
    expect(service.diagnostics().subscriptions).toEqual([]);
    await client.close();
    expect(service.owners.size).toBe(0);
  });

  it("retains desired subscriptions when a recovered worker temporarily cannot rearm them", async () => {
    service.spawnWorker = ({ generation }) => {
      const child = new FakeChild(generation);
      children.push(child);
      if (generation === 2) {
        const plan = child.runtime.plan.bind(child.runtime);
        let reject = true;
        child.runtime.plan = (...args) => {
          if (reject) {
            reject = false;
            return Promise.reject(
              Object.assign(new Error("Temporarily denied"), { code: "EACCES" }),
            );
          }
          return plan(...args);
        };
      }
      return child;
    };
    const client = service.createClient("recovery-error");
    const handle = client.watchFile(path.join(directory, "file"));
    const errors = [];
    const invalidations = [];
    handle.onDidError((error) => errors.push(error));
    handle.onDidInvalidate((event) => invalidations.push(event));
    await handle.ready;
    children[0].kill();
    await until(() => invalidations.length);
    expect(errors.some((error) => error.code === "EACCES")).toBe(true);
    expect(service.diagnostics("recovery-error").subscriptions[0].active).toBe(true);
    await client.close();
  });

  it("bounds an unresponsive owner's queue without blocking another owner", async () => {
    const blocked = [];
    await service.dispatch(
      "blocked",
      { type: "subscribe", id: 1, kind: "directory", path: directory, recursive: true },
      (event) => blocked.push(event),
    );
    const client = service.createClient("responsive");
    const handle = client.watchDirectory(directory);
    const received = [];
    handle.onDidChange((batch) => received.push(...batch));
    await handle.ready;
    const blockedId = service.owners.get("blocked").subscriptions.get(1).id;
    children[0].message({
      type: "event",
      id: blockedId,
      eventType: "changes",
      payload: [{ action: "created", path: path.join(directory, "first") }],
    });
    children[0].message({
      type: "event",
      id: blockedId,
      eventType: "changes",
      payload: Array.from({ length: MAX_QUEUED_EVENTS + 1 }, (_, i) => ({
        action: "created",
        path: path.join(directory, String(i)),
      })),
    });
    expect(service.owners.get("blocked").queuedEvents).toBe(0);
    children[0].engine.emit({ action: "created", path: path.join(directory, "responsive") });
    await until(() => received.length);
    await service.dispatch("blocked", { type: "ack", sequence: blocked[0].sequence });
    expect(blocked[1].type).toBe("invalidate");
    expect(blocked[1].payload.reason).toBe("client-queue-overflow");
    await client.close();
    await service.closeOwner("blocked");
  });

  it("reports callback failures while still acknowledging delivery and running other callbacks", async () => {
    let emit;
    const requests = [];
    const errors = [];
    const client = new FileWatchClient({
      request: async (request) => requests.push(request),
      onEvent: (callback) => {
        emit = callback;
        return { dispose() {} };
      },
      reportError: (error) => errors.push(error),
    });
    const handle = client.watchFile(path.join(directory, "file"));
    await handle.ready;
    handle.onDidChange(() => {
      throw new Error("observer failed");
    });
    const callback = jasmine.createSpy("second listener");
    handle.onDidChange(callback);
    emit({ id: 1, type: "changes", payload: [], sequence: 7 });
    expect(errors.length).toBe(1);
    expect(callback).toHaveBeenCalled();
    await Promise.resolve();
    expect(requests.at(-1)).toEqual({ type: "ack", sequence: 7 });
    await client.close();
  });
});
