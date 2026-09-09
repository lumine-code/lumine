const temp = require("@lumine-code/temp");
const fs = require("fs");
const path = require("path");
const { watchFile, watchDirectory } = require("../src/file-watch");
const { conditionPromise } = require("./helpers/async-spec-helpers");

temp.track();

// Exercise public handles through renderer IPC and the application-owned native worker.
describe("watchFile", function () {
  let handles;
  let unresolvedRoot;
  let root;

  beforeEach(function () {
    jasmine.useRealClock();
    handles = [];
    unresolvedRoot = temp.mkdirSync("watch-file-spec-");
    root = fs.realpathSync.native(unresolvedRoot);
    if (process.env.LUMINE_FILE_WATCH_TRACE) console.error("FILE_WATCH_SPEC_ROOT", root);
  });

  afterEach(async function () {
    for (const handle of handles) handle.dispose();
    await lumine.fileWatchClient.disposeAll();
  });

  // Records every notification rather than resolving on the first, so a spec
  // can assert about what arrived after it stopped waiting.
  function watching(filePath) {
    const handle = watchFile(filePath);
    const changes = [];
    handle.onDidChange(() => changes.push(handle.path));
    handles.push(handle);
    return { handle, changes };
  }

  function seed(filePath, contents = "{}\n") {
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it("rejects a missing path at the API boundary", function () {
    expect(() => watchFile(undefined)).toThrowError(TypeError);
  });

  it("reports an external write to a file named by its real path", async function () {
    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.ready;

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => changes.length > 0, "a change on the real path");
  });

  it("does not report a last-access update caused by reading the file", async function () {
    const file = seed(path.join(root, "target.json"));
    const stat = fs.statSync(file);
    fs.utimesSync(file, new Date(Date.now() - 48 * 60 * 60 * 1000), stat.mtime);
    const { handle, changes } = watching(file);
    await handle.ready;

    fs.readFileSync(file);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(changes).toEqual([]);
  });

  // The shape every consumer in the config directory has: `getConfigDirPath()`
  // hands back `LUMINE_HOME` verbatim, so on macOS the subscribed path keeps the
  // `/var` spelling while the worker and the OS both speak `/private/var`.
  it("reports an external write to a file named through a symlinked parent", async function () {
    const file = seed(path.join(unresolvedRoot, "target.json"));
    const { handle, changes } = watching(file);
    await handle.ready;

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => changes.length > 0, "a change on the symlinked path");
  });

  // Two watchers over one directory is the config directory's normal state:
  // `keymap.json`, `styles.css` and any package's own file share one physical
  // watch on the same parent while keeping independent logical subscriptions.
  it("reports writes to two files watched in the same directory", async function () {
    const first = seed(path.join(root, "first.json"));
    const second = seed(path.join(root, "second.json"));
    const a = watching(first);
    const b = watching(second);
    await Promise.all([a.handle.ready, b.handle.ready]);

    fs.writeFileSync(first, '{"a":1}');
    fs.writeFileSync(second, '{"b":2}');

    await conditionPromise(() => a.changes.length > 0, "a change on the first file");
    await conditionPromise(() => b.changes.length > 0, "a change on the second file");
  });

  // Every spec in a package suite tears the environment down and builds it
  // again, so a package that watches one file arms, releases and re-arms the
  // same path once per spec. The worker is terminated with the last watcher and
  // forked again for the next, which is the part no spec exercised.
  it("reports a write to a path that was watched, released and watched again", async function () {
    const file = seed(path.join(root, "target.json"));

    const first = watching(file);
    await first.handle.ready;
    first.handle.dispose();

    const second = watching(file);
    await second.handle.ready;

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => second.changes.length > 0, "a change on the re-armed watch");
  });

  // The config directory is where every long-lived single-file watch actually
  // lives — `keymap.json`, `styles.css`, and any package's own file — and it is
  // the one directory a suite never creates fresh.
  it("reports a write to a file in the config directory", async function () {
    const file = seed(path.join(lumine.getConfigDirPath(), "watch-file-spec.json"));
    const { handle, changes } = watching(file);
    await handle.ready;

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => changes.length > 0, "a change in the config directory");
    fs.rmSync(file, { force: true });
  });

  // The worker serves both kinds of watch, and a package suite nearly always
  // has a project open — so `@lumine-code/watcher` is subscribed alongside the
  // Node watches, and on macOS both backends drive FSEvents from one process.
  it("reports a write while a recursive watch is active in the same worker", async function () {
    const projectDir = fs.realpathSync.native(temp.mkdirSync("watch-file-spec-project-"));
    const recursive = watchDirectory(projectDir, { recursive: true });
    await recursive.ready;

    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.ready;

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => changes.length > 0, "a change beside a recursive watch");
    recursive.dispose();
  });

  // Unrelated subscriptions arming or closing must not swallow an active file change.
  it("reports a write while other watches arm and are released around it", async function () {
    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.ready;

    const churn = [];
    for (let i = 0; i < 4; i++) {
      const other = fs.realpathSync.native(temp.mkdirSync(`watch-file-spec-churn-${i}-`));
      churn.push(watchFile(seed(path.join(other, "other.json"))));
    }

    fs.writeFileSync(file, '{"external":true}');
    // Deliberately not awaited: the arms and releases have to land while the
    // write is still in flight, which is what a `beforeEach` does in practice.
    for (const other of churn) other.dispose();

    await conditionPromise(() => changes.length > 0, "a change that survives concurrent churn");
  });

  it("observes a file created below initially missing parents", async function () {
    const file = path.join(root, "missing", "nested", "target.json");
    const { handle, changes } = watching(file);
    await handle.ready;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "created");
    await conditionPromise(() => changes.length > 0, "creation below missing parents");
  });

  it("keeps its original path after an external rename and observes recreation", async function () {
    const file = seed(path.join(root, "original.json"));
    const target = path.join(root, "renamed.json");
    const handle = watchFile(file);
    handles.push(handle);
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    fs.renameSync(file, target);
    await conditionPromise(
      () => events.some((event) => event.action === "deleted"),
      "rename-away deletion",
    );
    expect(handle.path).toBe(file);
    fs.writeFileSync(file, "recreated");
    await conditionPromise(() => events.some((event) => event.action === "created"), "recreation");
  });

  it("continues after atomic replacement without reporting deletion", async function () {
    const file = seed(path.join(root, "atomic.json"));
    const handle = watchFile(file);
    handles.push(handle);
    const events = [];
    handle.onDidChange((batch) => events.push(...batch));
    await handle.ready;
    const replacement = seed(path.join(root, "replacement.tmp"), "replacement");
    fs.renameSync(replacement, file);
    await conditionPromise(
      () => events.some((event) => event.action === "updated"),
      "atomic replacement",
    );
    expect(events.some((event) => event.action === "deleted")).toBe(false);
    const count = events.length;
    fs.writeFileSync(file, "later external write");
    await conditionPromise(() => events.length > count, "post-replacement write");
  });

  it("keeps reporting writes after the first one", async function () {
    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.ready;

    fs.writeFileSync(file, '{"first":true}');
    await conditionPromise(() => changes.length > 0, "the first change");

    const seen = changes.length;
    fs.writeFileSync(file, '{"second":true}');
    await conditionPromise(() => changes.length > seen, "the second change");
  });
});
