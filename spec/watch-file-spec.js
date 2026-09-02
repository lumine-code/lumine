const temp = require("@lumine-code/temp");
const fs = require("fs");
const path = require("path");
const { watchFile, watchPath } = require("../src/path-watcher");
const { conditionPromise } = require("./helpers/async-spec-helpers");

temp.track();

// `watchFile` and `watchPath(..., { recursive: false })` are served by the
// worker's non-recursive Node watcher rather than by `@lumine-code/watcher`.
// `nodejs-watcher-spec.js` covers that watcher directly, in the renderer,
// against a path it resolves up front — so until now nothing covered the round
// trip through the worker, and nothing covered the spellings a caller actually
// subscribes with. Both matter on macOS, where every temp directory (and so the
// spec harness's own config directory) descends from `/var`, a symlink to
// `/private/var`: the path the subscriber holds is not the path the OS reports
// events for, and the filter in `PathWatcher::onNativeEvents` compares the two.
describe("watchFile", function () {
  let handles;
  let unresolvedRoot;
  let root;

  beforeEach(function () {
    jasmine.useRealClock();
    handles = [];
    unresolvedRoot = temp.mkdirSync("watch-file-spec-");
    root = fs.realpathSync.native(unresolvedRoot);
  });

  afterEach(async function () {
    for (const handle of handles) handle.dispose();
    await watchPath.reset();
  });

  // Records every notification rather than resolving on the first, so a spec
  // can assert about what arrived after it stopped waiting.
  function watching(filePath) {
    const handle = watchFile(filePath);
    const changes = [];
    handle.onDidChange(() => changes.push(handle.getPath()));
    handles.push(handle);
    return { handle, changes };
  }

  function seed(filePath, contents = "{}\n") {
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it("rejects a missing path at the API boundary", function () {
    expect(() => watchFile(undefined)).toThrowError(
      TypeError,
      'The "filePath" argument to watchFile must be a non-empty string. Received undefined',
    );
  });

  it("reports an external write to a file named by its real path", async function () {
    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.getStartPromise();

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => changes.length > 0, "a change on the real path");
  });

  // The shape every consumer in the config directory has: `getConfigDirPath()`
  // hands back `LUMINE_HOME` verbatim, so on macOS the subscribed path keeps the
  // `/var` spelling while the worker and the OS both speak `/private/var`.
  it("reports an external write to a file named through a symlinked parent", async function () {
    const file = seed(path.join(unresolvedRoot, "target.json"));
    const { handle, changes } = watching(file);
    await handle.getStartPromise();

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
    await Promise.all([a.handle.getStartPromise(), b.handle.getStartPromise()]);

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
    await first.handle.getStartPromise();
    first.handle.dispose();

    const second = watching(file);
    await second.handle.getStartPromise();

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => second.changes.length > 0, "a change on the re-armed watch");
  });

  // The config directory is where every long-lived single-file watch actually
  // lives — `keymap.json`, `styles.css`, and any package's own file — and it is
  // the one directory a suite never creates fresh.
  it("reports a write to a file in the config directory", async function () {
    const file = seed(path.join(lumine.getConfigDirPath(), "watch-file-spec.json"));
    const { handle, changes } = watching(file);
    await handle.getStartPromise();

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => changes.length > 0, "a change in the config directory");
    fs.rmSync(file, { force: true });
  });

  // The worker serves both kinds of watch, and a package suite nearly always
  // has a project open — so `@lumine-code/watcher` is subscribed alongside the
  // Node watches, and on macOS both backends drive FSEvents from one process.
  it("reports a write while a recursive watch is active in the same worker", async function () {
    const projectDir = fs.realpathSync.native(temp.mkdirSync("watch-file-spec-project-"));
    const recursive = await watchPath(projectDir, {}, () => {});

    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.getStartPromise();

    fs.writeFileSync(file, '{"external":true}');

    await conditionPromise(() => changes.length > 0, "a change beside a recursive watch");
    recursive.dispose();
  });

  // On macOS every `fs.watch` handle in a process shares one FSEventStream, and
  // libuv rebuilds it — "since now" — whenever a handle is added or removed. A
  // rebuild discards whatever the old stream had accepted but not yet delivered,
  // and nothing replays it, so an unrelated watch arming or being released can
  // swallow another watcher's only event. `PathWatcher::getStopPromise` names
  // this hazard for the repoint path; nothing pinned it for watchers that merely
  // live side by side, which is every package suite's steady state.
  it("reports a write while other watches arm and are released around it", async function () {
    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.getStartPromise();

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

  // End to end, through the worker: a watch the OS refuses must reach the
  // subscriber as a rejection. It used to answer `watcher:watch` with success,
  // so `getStartPromise()` resolved on a watcher that would never emit.
  it("rejects the start promise when the watch cannot be armed", async function () {
    const file = path.join(root, "no-such-directory", "target.json");
    const handle = watchFile(file);
    handles.push(handle);

    let failure = null;
    try {
      await handle.getStartPromise();
    } catch (error) {
      failure = error;
    }

    expect(failure).not.toBeNull();
  });

  it("keeps reporting writes after the first one", async function () {
    const file = seed(path.join(root, "target.json"));
    const { handle, changes } = watching(file);
    await handle.getStartPromise();

    fs.writeFileSync(file, '{"first":true}');
    await conditionPromise(() => changes.length > 0, "the first change");

    const seen = changes.length;
    fs.writeFileSync(file, '{"second":true}');
    await conditionPromise(() => changes.length > seen, "the second change");
  });
});
