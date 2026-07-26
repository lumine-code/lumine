const temp = require("@lumine-code/temp");
const fs = require("fs");
const path = require("path");
const { watch, getWatchedPaths, closeAllNodejsWatchers } = require("../src/nodejs-watcher");
const { conditionPromise } = require("./helpers/async-spec-helpers");

temp.track();

// The non-recursive watcher backs single-file and non-recursive directory
// watching inside the watcher worker. The key property is that a file is
// watched via its containing directory so atomic saves (write-temp + rename)
// are reported as changes rather than a delete followed by a create.
//
// Nothing here waits for the watcher to settle before mutating the filesystem:
// `watch()` is required to return armed, so every spec below doubles as a check
// on that guarantee.
describe("NodejsWatcher", () => {
  let dir;
  let watchers;

  beforeEach(() => {
    jasmine.useRealClock();
    // Resolve the real path up front, mirroring the renderer.
    dir = fs.realpathSync.native(temp.mkdirSync("nodejs-watcher-spec"));
    watchers = [];
  });

  afterEach(() => {
    for (const w of watchers) w.close();
    closeAllNodejsWatchers();
  });

  function watchFor(target, events) {
    const w = watch(target, (type, eventPath, oldPath) =>
      events.push({ type, path: eventPath, oldPath }),
    );
    watchers.push(w);
    return w;
  }

  describe("watching a single file", () => {
    let file;
    let events;

    beforeEach(() => {
      file = path.join(dir, "target.txt");
      fs.writeFileSync(file, "one\n");
      events = [];
      watchFor(file, events);
    });

    it("reports content changes", async () => {
      fs.writeFileSync(file, "two\n");
      await conditionPromise(() => events.some((e) => e.type === "change"), "change event");
    });

    it("reports an atomic save (write-temp + rename) as a change, not a delete", async () => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, "three\n");
      fs.renameSync(tmp, file);
      await conditionPromise(() => events.some((e) => e.type === "change"), "change event");
      expect(events.some((e) => e.type === "delete")).toBe(false);
    });

    it("keeps tracking edits after an atomic save", async () => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, "three\n");
      fs.renameSync(tmp, file);
      await conditionPromise(() => events.some((e) => e.type === "change"), "post-save change");
      events.length = 0;
      fs.writeFileSync(file, "four\n");
      await conditionPromise(() => events.some((e) => e.type === "change"), "second change");
    });

    it("reports deletion", async () => {
      fs.rmSync(file);
      await conditionPromise(() => events.some((e) => e.type === "delete"), "delete event");
    });

    it("reports a rename to a sibling", async () => {
      const moved = path.join(dir, "moved.txt");
      fs.renameSync(file, moved);
      // Detected via inode match. On filesystems without stable inodes this
      // degrades to a delete (same limitation as VS Code's watcher).
      await conditionPromise(
        () => events.some((e) => e.type === "rename" || e.type === "delete"),
        "rename or delete",
      );
      const renamed = events.find((e) => e.type === "rename");
      if (renamed) {
        expect(renamed.path).toBe(moved);
        expect(renamed.oldPath).toBe(file);
      }
    });
  });

  describe("watching a directory (non-recursive)", () => {
    let events;

    beforeEach(() => {
      events = [];
      watchFor(dir, events);
    });

    it("reports a direct child being created", async () => {
      const child = path.join(dir, "child.cfg");
      fs.writeFileSync(child, "x");
      await conditionPromise(() => events.some((e) => e.path === child), "child create");
    });

    it("reports a direct child's content changing", async () => {
      const child = path.join(dir, "child.cfg");
      fs.writeFileSync(child, "x");
      await conditionPromise(() => events.length > 0, "child appears");
      events.length = 0;
      fs.writeFileSync(child, "y");
      await conditionPromise(
        () => events.some((e) => e.type === "change" && e.path === child),
        "child change",
      );
    });

    it("reports a direct child being deleted", async () => {
      const child = path.join(dir, "child.cfg");
      fs.writeFileSync(child, "x");
      await conditionPromise(() => events.length > 0, "child appears");
      events.length = 0;
      fs.rmSync(child);
      await conditionPromise(
        () => events.some((e) => e.type === "delete" && e.path === child),
        "child delete",
      );
    });
  });

  // Regression: macOS arms `fs.watch` on libuv's CoreFoundation run-loop
  // thread, so `watch()` used to return before the OS was watching and a write
  // issued in the same tick was dropped for good — nothing replays a missed
  // FSEvents notification. Repeat the race so a regression can't pass by luck.
  it("reports a change made in the same tick the watch is created", async () => {
    for (let i = 0; i < 10; i++) {
      const file = path.join(dir, `immediate-${i}.txt`);
      fs.writeFileSync(file, "one\n");
      const events = [];
      watchFor(file, events);
      fs.writeFileSync(file, "two\n");
      await conditionPromise(
        () => events.some((e) => e.type === "change"),
        `change event on attempt ${i + 1}`,
      );
    }
  });

  it("tracks and releases live watchers", () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "");
    watchFor(file, []);
    expect(getWatchedPaths().length).toBeGreaterThan(0);
    closeAllNodejsWatchers();
    expect(getWatchedPaths().length).toBe(0);
  });
});
