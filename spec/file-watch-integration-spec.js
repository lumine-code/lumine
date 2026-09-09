// These exercise the installed native addon through the real application
// service and child process. The test runner never loads the addon itself.
const fs = require("fs");
const os = require("os");
const path = require("path");
const FileWatchService = require("../src/file-watch-service");

async function until(condition, message = "filesystem event") {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Application file watcher integration", () => {
  let directory;
  let service;
  let client;

  beforeEach(() => {
    jasmine.useRealClock?.();
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-native-watch-")),
    );
    service = new FileWatchService({ retryDelays: [20, 40, 80], stableDelay: 1000 });
    client = service.createClient("integration");
  });

  afterEach(async () => {
    await client.close();
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reports writes and atomic saves through a fixed file handle", async () => {
    const target = path.join(directory, "document.txt");
    fs.writeFileSync(target, "original");
    const handle = client.watchFile(target);
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    fs.writeFileSync(target, "changed");
    await until(() => events.length);
    expect(events[0]).toEqual({ action: "updated", path: target });
    events.length = 0;
    const temporary = path.join(directory, "temporary.txt");
    fs.writeFileSync(temporary, "replacement");
    fs.renameSync(temporary, target);
    await until(() => events.length);
    expect(events.every((event) => event.action === "updated")).toBe(true);
    expect(handle.path).toBe(target);
  });

  it("keeps a nested file independent of a shallow directory and a recursive source", async () => {
    const nested = path.join(directory, "constructor", "__proto__");
    fs.mkdirSync(nested, { recursive: true });
    const target = path.join(nested, "zażółć.txt");
    fs.writeFileSync(target, "old");
    const shallow = client.watchDirectory(directory);
    const tree = client.watchDirectory(directory, { recursive: true });
    const file = client.watchFile(target);
    const shallowEvents = [];
    const treeEvents = [];
    const fileEvents = [];
    shallow.onDidChange((batch) => shallowEvents.push(...batch));
    tree.onDidChange((batch) => treeEvents.push(...batch));
    file.onDidChange((batch) => fileEvents.push(...batch));
    await Promise.all([shallow.ready, tree.ready, file.ready]);
    fs.writeFileSync(target, "new content");
    await until(() => treeEvents.some((event) => event.path === target) && fileEvents.length);
    expect(shallowEvents.some((event) => event.path === target)).toBe(false);
    expect(fileEvents[0]).toEqual({ action: "updated", path: target });
  });

  it("retains creation while a newly created file is rewritten before each batch", async () => {
    const handle = client.watchDirectory(directory, { recursive: true });
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    const target = path.join(directory, "probe");
    const interval = setInterval(() => fs.writeFileSync(target, String(Date.now())), 10);
    try {
      await until(() =>
        events.some((event) => event.path === target && event.action === "created"),
      );
    } finally {
      clearInterval(interval);
    }
  });

  it("observes missing parents and keeps the original name after an external rename", async () => {
    const parent = path.join(directory, "missing", "nested");
    const target = path.join(parent, "file.txt");
    const handle = client.watchFile(target);
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(target, "created");
    await until(() => events.some((event) => event.action === "created"));
    fs.renameSync(target, path.join(parent, "renamed.txt"));
    await until(() => events.some((event) => event.action === "deleted"));
    expect(handle.path).toBe(target);
    fs.writeFileSync(target, "recreated");
    await until(() => events.filter((event) => event.action === "created").length === 2);
    expect(events.every((event) => event.path === target)).toBe(true);
  });

  it("rebinds a symlink root and preserves the subscriber's path spelling", async () => {
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.symlinkSync(first, alias, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(alias, "file");
    const handle = client.watchFile(target);
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    fs.writeFileSync(path.join(first, "file"), "first");
    await until(() => events.length);
    expect(events[0].path).toBe(target);
    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias, process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(path.join(second, "file"), "second content");
    await until(() => events.some((event) => event.action === "updated"));
    expect(events.every((event) => event.path === target)).toBe(true);
  });

  it("observes a dangling link whose target and parents are created outside the alias directory", async () => {
    const aliases = path.join(directory, "aliases");
    const targets = path.join(directory, "targets");
    fs.mkdirSync(aliases);
    fs.mkdirSync(targets);
    const target = path.join(targets, "not-yet", "nested");
    const alias = path.join(aliases, "alias");
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    const requested = path.join(alias, "file");
    const handle = client.watchFile(requested);
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "file"), "created through target");
    await until(() => events.some((event) => event.action === "created"));
    expect(events.every((event) => event.path === requested)).toBe(true);
    fs.writeFileSync(path.join(target, "file"), "updated target contents");
    await until(() => events.some((event) => event.action === "updated"));
  });

  it("observes creation of a dangling directory target before recursive child updates", async () => {
    const aliases = path.join(directory, "aliases");
    const targets = path.join(directory, "targets");
    fs.mkdirSync(aliases);
    fs.mkdirSync(targets);
    const target = path.join(targets, "not-yet");
    const alias = path.join(aliases, "alias");
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    const handle = client.watchDirectory(alias, { recursive: true });
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    fs.mkdirSync(target);
    await until(() => events.some((event) => event.action === "created" && event.path === alias));
    fs.writeFileSync(path.join(target, "child"), "created child");
    await until(() => events.some((event) => event.path === path.join(alias, "child")));
  });

  it("invalidates surviving owners after repeated worker crashes and rereads changes in the gap", async () => {
    const target = path.join(directory, "file");
    fs.writeFileSync(target, "before");
    const handle = client.watchFile(target);
    const observed = [];
    handle.onDidInvalidate((event) =>
      observed.push({ ...event, text: fs.readFileSync(target, "utf8") }),
    );
    await handle.ready;
    service.worker.kill();
    fs.writeFileSync(target, "during first outage");
    await until(() => observed.length === 1);
    expect(observed[0].text).toBe("during first outage");
    service.worker.kill();
    fs.writeFileSync(target, "during second outage");
    await until(() => observed.length === 2);
    expect(observed[1].text).toBe("during second outage");
    expect(observed[1].generation).toBeGreaterThan(observed[0].generation);
    expect(service.diagnostics("integration").subscriptions[0].active).toBe(true);
  });

  it("releases a burst of handles, including cancellation before worker startup", async () => {
    const cancelled = client.watchFile(path.join(directory, "cancelled"));
    cancelled.dispose();
    await cancelled.closed;
    await expectAsync(cancelled.ready).toBeRejected();
    const handles = Array.from({ length: 100 }, (_, index) =>
      client.watchFile(path.join(directory, String(index))),
    );
    await Promise.all(handles.map((handle) => handle.ready));
    await client.disposeAll();
    expect(service.diagnostics().subscriptions).toEqual([]);
    expect(service.pending.size).toBe(0);
    const diagnostics = await service.requestWorker("diagnostics");
    expect(diagnostics.sources).toEqual([]);
    expect(diagnostics.subscriptions).toBe(0);
  });
});
