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
  // `keymap.json`, `styles.css` and any package's own file each arm their own
  // watch on the same parent.
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
