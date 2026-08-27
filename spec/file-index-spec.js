const fs = require("fs");
const path = require("path");

const { Emitter } = require("@lumine-code/event-kit");
const temp = require("@lumine-code/temp").track();

const fsPlus = require("@lumine-code/fs-plus");
const FileIndex = require("../src/file-index");
const ProjectDirectory = require("../src/project-directory");
const { stopAllWatchers } = require("../src/path-watcher");

// The index compares paths the way the filesystem does, so a spec that stands in
// for a symlinked root has to fold its stand-in the same way.
const fold = fsPlus.isCaseInsensitive() ? (p) => p.toLowerCase() : (p) => p;

// The index is reached through `Project` in production, but its state machine is
// almost all crawl bookkeeping and event classification — driving that through a
// real project, a real ripgrep and a real watcher would make thirty specs into
// thirty integration tests. This fake supplies the three things the index asks a
// project for, and hands back crawl handles the spec resolves by hand.
class FakeProject {
  constructor(config) {
    this.emitter = new Emitter();
    this.directories = [];
    this.crawls = [];
    this.config = config;
    this.repository = null;
    this.notificationManager = { warnings: [], addWarning: (m, o) => this.warn(m, o) };
  }

  warn(message, options) {
    this.notificationManager.warnings.push({ message, options });
  }

  setRoots(rootPaths) {
    this.directories = rootPaths.map((rootPath) => new ProjectDirectory(rootPath));
    this.emitter.emit("did-change-paths", rootPaths);
  }

  getDirectories() {
    return this.directories;
  }

  onDidChangePaths(callback) {
    return this.emitter.on("did-change-paths", callback);
  }

  onDidChangeFiles(callback) {
    return this.emitter.on("did-change-files", callback);
  }

  emitFileEvents(events) {
    this.emitter.emit("did-change-files", events);
  }

  crawl({ directoryPaths, didFindPaths }) {
    let resolve;
    let cancelled = false;
    const promise = new Promise((r) => (resolve = r));
    // `RipgrepFileCrawler` flushes its partial batch on close even after
    // `cancel()`, so the fake has to be able to as well — it is the only way to
    // prove the generation guard actually holds.
    promise.cancel = () => {
      cancelled = true;
    };
    this.crawls.push({
      directoryPaths,
      rootPath: directoryPaths[0],
      didFindPaths,
      resolve,
      isCancelled: () => cancelled,
    });
    return promise;
  }

  // The crawl started most recently for a root, which is the one a spec means
  // whenever it drives results in.
  crawlFor(rootPath) {
    for (let i = this.crawls.length - 1; i >= 0; i--) {
      if (this.crawls[i].rootPath === rootPath) return this.crawls[i];
    }
    return null;
  }

  repositoryForPath() {
    return Promise.resolve(this.repository);
  }
}

class FakeConfig {
  constructor(values = {}) {
    this.values = {
      "core.ignoredNames": [],
      "core.followSymlinks": true,
      "core.excludeVcsIgnoredPaths": true,
      ...values,
    };
    this.emitter = new Emitter();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
    this.emitter.emit(key, { newValue: value });
  }

  onDidChange(key, callback) {
    return this.emitter.on(key, callback);
  }
}

describe("FileIndex", () => {
  // A real directory even though the crawl is faked: `admitCreated` stats every
  // path it is about to admit, and stubbing that would mean spying on fs-plus,
  // whose Proxy never gives a spy back.
  let ROOT;
  let index;
  let project;
  let config;

  const under = (...parts) => path.join(ROOT, ...parts);

  // Create a real file so a "created" event for it can be admitted.
  const touch = (...parts) => {
    const filePath = under(...parts);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
    return filePath;
  };

  beforeEach(() => {
    ROOT = fs.realpathSync.native(temp.mkdirSync("file-index-unit-"));
    config = new FakeConfig();
    project = new FakeProject(config);
    project.setRoots([ROOT]);
    index = new FileIndex({ config });
  });

  afterEach(() => {
    if (!index.destroyed) index.destroy();
  });

  // Resolve a root's crawl with the given paths, then let the emission window
  // elapse. Mirrors what one full ripgrep run does to the index.
  const completeCrawl = (paths, rootPath = ROOT) => {
    const crawl = project.crawlFor(rootPath);
    if (paths.length > 0) crawl.didFindPaths(paths);
    crawl.resolve();
    // The crawl promise's `.then` runs on a microtask.
    return Promise.resolve().then(() => Promise.resolve());
  };

  const attach = async (paths = []) => {
    index.attachProject(project);
    await completeCrawl(paths);
  };

  describe("arming and teardown", () => {
    it("starts one crawl per root when it is attached", () => {
      project.setRoots([ROOT, under("..", "other")]);
      index.attachProject(project);
      expect(project.crawls.length).toBe(2);
    });

    it("skips a root that is not a local directory", () => {
      // A `project.directory-provider` hands back its own directory class, which
      // reports the URI as given rather than putting it through `path.normalize`.
      project.directories = [
        new ProjectDirectory(ROOT),
        { getPath: () => "ssh://example.com/code" },
      ];
      index.attachProject(project);
      expect(project.crawls.length).toBe(1);
      expect(index.getRootPaths()).toEqual([ROOT]);
    });

    it("reports everything it holds as `added` to a new observer", async () => {
      await attach([under("a.js"), under("b.js")]);

      const batches = [];
      index.observe((change) => batches.push(change));

      expect(batches.length).toBe(1);
      expect(batches[0].added.sort()).toEqual([under("a.js"), under("b.js")]);
      expect(batches[0].removed).toEqual([]);
      expect(batches[0].indexing).toBe(false);
    });

    it("hands each observer its own array rather than the memoized one", async () => {
      await attach([under("a.js")]);
      let added;
      index.observe((change) => (added = change.added));
      expect(added).not.toBe(index.getPaths());
      expect(added).toEqual(index.getPaths());
    });

    it("releases everything on destroy", async () => {
      await attach([under("a.js")]);
      index.destroy();
      expect(index.getPaths()).toEqual([]);
      expect(index.getPathCount()).toBe(0);
      expect(index.isIndexing()).toBe(false);
    });

    it("cancels an in-flight crawl on destroy", () => {
      index.attachProject(project);
      const crawl = project.crawlFor(ROOT);
      index.destroy();
      expect(crawl.isCancelled()).toBe(true);
    });

    it("refuses to attach after being destroyed", () => {
      index.destroy();
      expect(() => index.attachProject(project)).toThrow();
    });
  });

  describe("crawling", () => {
    it("streams a first crawl into the index as batches arrive", () => {
      index.attachProject(project);
      const changes = [];
      index.observe((change) => changes.push(change));

      project.crawlFor(ROOT).didFindPaths([under("a.js")]);
      expect(index.isIndexing()).toBe(true);
      // Nothing is delivered until the coalescing window elapses.
      expect(changes.length).toBe(1);

      advanceClock(200);
      expect(changes.length).toBe(2);
      expect(changes[1].added).toEqual([under("a.js")]);
      expect(changes[1].indexing).toBe(true);
    });

    it("coalesces several batches into one emission", () => {
      index.attachProject(project);
      const changes = [];
      index.observe(() => changes.push(1));

      const crawl = project.crawlFor(ROOT);
      crawl.didFindPaths([under("a.js")]);
      crawl.didFindPaths([under("b.js")]);
      crawl.didFindPaths([under("c.js")]);
      advanceClock(200);

      expect(changes.length).toBe(2);
    });

    it("does not extend the coalescing window when more changes arrive", () => {
      index.attachProject(project);
      const changes = [];
      index.observe(() => changes.push(1));

      const crawl = project.crawlFor(ROOT);
      crawl.didFindPaths([under("a.js")]);
      advanceClock(60);
      crawl.didFindPaths([under("b.js")]);
      advanceClock(60);

      // A window that reset on every change would still be pending here, and a
      // continuous stream of events could starve delivery forever.
      expect(changes.length).toBe(2);
    });

    it("emits when indexing finishes even with nothing left to report", async () => {
      index.attachProject(project);
      const crawl = project.crawlFor(ROOT);
      crawl.didFindPaths([under("a.js")]);
      advanceClock(200);

      const changes = [];
      index.observe((change) => changes.push(change));
      crawl.resolve();
      await Promise.resolve().then(() => Promise.resolve());

      // Otherwise a consumer's spinner has nothing to clear on.
      expect(changes.length).toBe(2);
      expect(changes[1].added).toEqual([]);
      expect(changes[1].removed).toEqual([]);
      expect(changes[1].indexing).toBe(false);
    });

    it("ignores results from a crawl that has been superseded", async () => {
      await attach([under("a.js")]);
      const stale = project.crawlFor(ROOT);

      index.refresh();
      stale.didFindPaths([under("ghost.js")]);
      stale.resolve();
      await Promise.resolve().then(() => Promise.resolve());

      // A cancelled crawl still flushes its partial batch, so nothing but the
      // generation guard stops this landing.
      expect(index.has(under("ghost.js"))).toBe(false);
      expect(index.has(under("a.js"))).toBe(true);
    });

    it("keeps the old contents readable until a refresh completes", async () => {
      await attach([under("a.js"), under("b.js")]);
      index.refresh();

      expect(index.getPaths().sort()).toEqual([under("a.js"), under("b.js")]);
      expect(index.isIndexing()).toBe(true);

      await completeCrawl([under("b.js"), under("c.js")]);
      expect(index.getPaths().sort()).toEqual([under("b.js"), under("c.js")]);
    });

    it("reports only the difference after a refresh", async () => {
      await attach([under("a.js"), under("b.js")]);
      const changes = [];
      index.observe((change) => changes.push(change));

      index.refresh();
      await completeCrawl([under("b.js"), under("c.js")]);

      const last = changes[changes.length - 1];
      expect(last.added).toEqual([under("c.js")]);
      expect(last.removed).toEqual([under("a.js")]);
    });

    it("re-crawls when a policy setting changes", async () => {
      await attach([under("a.js")]);
      const before = project.crawls.length;
      config.set("core.ignoredNames", ["node_modules"]);
      expect(project.crawls.length).toBe(before + 1);
    });

    it("stops and warns once when a root exceeds the path limit", () => {
      index.attachProject(project);
      const crawl = project.crawlFor(ROOT);

      // Stand in for a root already holding half a million paths rather than
      // generating them: the valve reads `staging.size` and nothing else.
      index.entries.get(ROOT).staging = { size: 500000, add: () => {}, has: () => false };
      crawl.didFindPaths([under("one-too-many.js")]);
      crawl.didFindPaths([under("and-another.js")]);

      expect(crawl.isCancelled()).toBe(true);
      expect(project.notificationManager.warnings.length).toBe(1);
    });
  });

  describe("root changes", () => {
    it("indexes a root added later", async () => {
      await attach([under("a.js")]);
      const second = path.join(path.dirname(ROOT), "second");
      project.setRoots([ROOT, second]);

      expect(project.crawlFor(second)).not.toBe(null);
      await completeCrawl([path.join(second, "z.js")], second);
      expect(index.has(path.join(second, "z.js"))).toBe(true);
    });

    it("reports every path under a removed root as removed", async () => {
      await attach([under("a.js"), under("b.js")]);
      const changes = [];
      index.observe((change) => changes.push(change));

      project.setRoots([]);
      advanceClock(200);

      const last = changes[changes.length - 1];
      expect(last.removed.sort()).toEqual([under("a.js"), under("b.js")]);
      expect(index.getPaths()).toEqual([]);
    });

    it("cancels the crawl of a removed root", () => {
      index.attachProject(project);
      const crawl = project.crawlFor(ROOT);
      project.setRoots([]);
      expect(crawl.isCancelled()).toBe(true);
    });

    it("re-reads the project's directories rather than trusting the event argument", () => {
      index.attachProject(project);
      // `setPaths` emits the array it was handed, and a file path in it becomes
      // its parent directory — so the argument can name a root that does not
      // exist. Emit a bogus argument while the real roots are unchanged.
      project.emitter.emit("did-change-paths", [under("not-a-root.js")]);
      expect(index.getRootPaths()).toEqual([ROOT]);
    });

    it("lists a file under every root that contains it", async () => {
      const nested = under("packages");
      project.setRoots([ROOT, nested]);
      index.attachProject(project);

      const shared = path.join(nested, "a.js");
      await completeCrawl([shared], ROOT);
      await completeCrawl([shared], nested);

      expect(index.getPathsForRoot(ROOT)).toEqual([shared]);
      expect(index.getPathsForRoot(nested)).toEqual([shared]);
      // ...but the union counts it once.
      expect(index.getPathCount()).toBe(1);
    });

    it("keeps a file the other root still holds when one root drops it", async () => {
      const nested = under("packages");
      project.setRoots([ROOT, nested]);
      index.attachProject(project);
      const shared = path.join(nested, "a.js");
      await completeCrawl([shared], ROOT);
      await completeCrawl([shared], nested);

      const changes = [];
      index.observe((change) => changes.push(change));
      project.setRoots([ROOT]);
      advanceClock(200);

      expect(index.has(shared)).toBe(true);
      expect(changes.length).toBe(1);
    });
  });

  describe("filesystem events", () => {
    beforeEach(async () => {
      await attach([under("a.js")]);
    });

    const emit = async (events) => {
      project.emitFileEvents(events);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      advanceClock(200);
    };

    it("adds a created file", async () => {
      const created = touch("new.js");
      await emit([{ action: "created", path: created }]);
      expect(index.has(created)).toBe(true);
    });

    it("does not add a created directory", async () => {
      const subdir = under("subdir");
      fs.mkdirSync(subdir, { recursive: true });
      // The recursive backend reports no entry kind, so the index has to ask.
      await emit([{ action: "created", path: subdir }]);
      expect(index.has(subdir)).toBe(false);
    });

    it("does not add a created path that no longer exists", async () => {
      await emit([{ action: "created", path: under("gone-already.js") }]);
      expect(index.has(under("gone-already.js"))).toBe(false);
    });

    it("removes a deleted file", async () => {
      await emit([{ action: "deleted", path: under("a.js") }]);
      expect(index.has(under("a.js"))).toBe(false);
    });

    it("removes every indexed file under a deleted directory", async () => {
      index.refresh();
      await completeCrawl([under("src", "one.js"), under("src", "two.js"), under("keep.js")]);

      await emit([{ action: "deleted", path: under("src") }]);

      // A recursive delete arrives as one event for the directory, so an index
      // that only removed the exact path would keep both files forever.
      expect(index.has(under("src", "one.js"))).toBe(false);
      expect(index.has(under("src", "two.js"))).toBe(false);
      expect(index.has(under("keep.js"))).toBe(true);
    });

    it("ignores an updated event", async () => {
      const changes = [];
      index.observe((change) => changes.push(change));
      await emit([{ action: "updated", path: under("a.js") }]);
      expect(changes.length).toBe(1);
      expect(index.has(under("a.js"))).toBe(true);
    });

    it("ignores an event outside every root", async () => {
      const outside = path.join(path.dirname(ROOT), "elsewhere", "x.js");
      await emit([{ action: "created", path: outside }]);
      expect(index.has(outside)).toBe(false);
    });

    it("tolerates a renamed event, which recursive roots never send", async () => {
      const renamed = touch("b.js");
      await emit([{ action: "renamed", oldPath: under("a.js"), path: renamed }]);
      expect(index.has(under("a.js"))).toBe(false);
      expect(index.has(renamed)).toBe(true);
    });

    it("reports a path added and removed within one window in neither array", async () => {
      const blip = touch("blip.js");
      const changes = [];
      index.observe((change) => changes.push(change));

      project.emitFileEvents([{ action: "created", path: blip }]);
      project.emitFileEvents([{ action: "deleted", path: blip }]);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      advanceClock(200);

      for (const change of changes.slice(1)) {
        expect(change.added).not.toContain(blip);
        expect(change.removed).not.toContain(blip);
      }
    });

    it("does not admit a created file that core policy excludes", async () => {
      config.values["core.ignoredNames"] = ["node_modules"];
      index.ignoredNamesMatcher = null;
      index.ignoreSource = null;
      const ignored = touch("node_modules", "dep.js");
      await emit([{ action: "created", path: ignored }]);
      expect(index.has(ignored)).toBe(false);
    });

    it("does not consult VCS when its exclusions are disabled", async () => {
      config.values["core.excludeVcsIgnoredPaths"] = false;
      const refreshStatusSnapshot = jasmine.createSpy("refresh status").and.resolveTo();
      project.repository = {
        refreshStatusSnapshot,
        isPathIgnored: () => true,
      };
      const created = touch("ignored-by-vcs.js");

      await emit([{ action: "created", path: created }]);

      expect(refreshStatusSnapshot).not.toHaveBeenCalled();
      expect(index.has(created)).toBe(true);
    });
  });

  describe("created-file volume rules", () => {
    beforeEach(async () => {
      await attach([]);
    });

    it("admits nothing from a bulk burst and re-crawls the root instead", () => {
      const events = [];
      for (let i = 0; i < 150; i++) {
        events.push({ action: "created", path: touch("bulk", `f${i}.js`) });
      }
      const before = project.crawls.length;
      project.emitFileEvents(events);

      // Guessing 150 times is both slower and less accurate than one ripgrep run.
      expect(index.getPathCount()).toBe(0);
      expect(project.crawls.length).toBe(before);
      advanceClock(2500);
      expect(project.crawls.length).toBe(before + 1);
    });

    it("checks every small-batch file against VCS before admitting it", async () => {
      const refreshStatusSnapshot = jasmine.createSpy("refresh status").and.resolveTo();
      project.repository = {
        refreshStatusSnapshot,
        isPathIgnored: (filePath) => path.basename(filePath) === "ignored.js",
      };
      const visible = touch("out", "visible.js");
      const ignored = touch("out", "ignored.js");

      project.emitFileEvents([
        { action: "created", path: visible },
        { action: "created", path: ignored },
      ]);
      for (let i = 0; i < 20 && index.entries.get(ROOT).pendingAdmissions.size > 0; i++) {
        await Promise.resolve();
      }

      expect(refreshStatusSnapshot.calls.count()).toBe(1);
      expect(index.has(visible)).toBe(true);
      expect(index.has(ignored)).toBe(false);
    });

    it("defers to a recrawl when a non-VCS ignore file can affect the path", () => {
      fs.writeFileSync(under(".ignore"), "generated.js\n");
      const generated = touch("generated.js");
      const before = project.crawls.length;

      project.emitFileEvents([{ action: "created", path: generated }]);

      expect(index.has(generated)).toBe(false);
      advanceClock(2500);
      expect(project.crawls.length).toBe(before + 1);
    });

    it("re-crawls when an ignore file is written", () => {
      const before = project.crawls.length;
      project.emitFileEvents([{ action: "updated", path: under(".gitignore") }]);
      advanceClock(2500);
      expect(project.crawls.length).toBe(before + 1);
    });

    it("re-crawls when .git/info/exclude is written", () => {
      const before = project.crawls.length;
      project.emitFileEvents([{ action: "updated", path: under(".git", "info", "exclude") }]);
      advanceClock(2500);
      expect(project.crawls.length).toBe(before + 1);
    });
  });

  describe("the ignore predicate", () => {
    const ignoring = (names) => {
      config.values["core.ignoredNames"] = names;
      index.ignoredNamesMatcher = null;
      index.ignoreSource = null;
      return (relativePath) => index.isIgnoredRelativePath(relativePath.split("/").join(path.sep));
    };

    it("matches a slashless pattern against a basename at any depth", () => {
      const ignored = ignoring(["node_modules"]);
      expect(ignored("node_modules")).toBe(true);
      expect(ignored("a/node_modules")).toBe(true);
      expect(ignored("a/node_modules/b/c.js")).toBe(true);
      expect(ignored("a/not_node_modules/c.js")).toBe(false);
    });

    it("matches a wildcard basename pattern", () => {
      const ignored = ignoring(["._*", "*.pyc"]);
      expect(ignored("a/._hidden")).toBe(true);
      expect(ignored("a/b/mod.pyc")).toBe(true);
      expect(ignored("a/keep.py")).toBe(false);
    });

    it("anchors a pattern that contains a slash", () => {
      const ignored = ignoring(["build/output"]);
      expect(ignored("build/output")).toBe(true);
      expect(ignored("build/output/x.js")).toBe(true);
      // The point of anchoring: it does not match at an arbitrary depth.
      expect(ignored("a/build/output/y.js")).toBe(false);
    });

    it("treats a leading slash as anchored to the root", () => {
      const ignored = ignoring(["/dist"]);
      expect(ignored("dist/app.js")).toBe(true);
      expect(ignored("packages/dist/app.js")).toBe(false);
    });

    it("always excludes the VCS directories, whatever the setting says", () => {
      const ignored = ignoring([]);
      expect(ignored(".git/config")).toBe(true);
      expect(ignored(".hg/store")).toBe(true);
      expect(ignored(".svn/wc.db")).toBe(true);
      expect(ignored("src/app.js")).toBe(false);
    });
  });

  describe("path spelling", () => {
    it("indexes an event under the root's registered spelling", async () => {
      await attach([]);
      const entry = index.entries.get(ROOT);
      // Stand in for a symlinked root: the watcher's realpath differs from the
      // path the root was registered under.
      const realRoot = path.join(path.dirname(ROOT), "real-root");
      entry.foldedReal = fold(realRoot);
      entry.foldedRealPrefix = fold(realRoot + path.sep);
      // The file exists under the registered spelling, which is where the index
      // will look for it — as it would through a real symlinked root.
      touch("Deep", "File.JS");

      project.emitFileEvents([{ action: "created", path: path.join(realRoot, "Deep", "File.JS") }]);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      advanceClock(200);

      // Rewritten onto the registered root, and the tail keeps the case the
      // filesystem gave it.
      expect(index.has(under("Deep", "File.JS"))).toBe(true);
      expect(index.has(path.join(realRoot, "Deep", "File.JS"))).toBe(false);
    });
  });
});

describe("FileIndex with a real crawl and watcher", () => {
  let dir;

  // Built at runtime rather than committed, so a literal `.git`/`.gitignore`
  // never lands in the repository.
  const buildFixture = () => {
    const root = fs.realpathSync.native(temp.mkdirSync("file-index-"));
    fs.writeFileSync(path.join(root, "visible.txt"), "");
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "nested.txt"), "");
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(root, "ignored.txt"), "");
    fs.cpSync(
      path.join(__dirname, "fixtures", "git", "working-dir", "git.git"),
      path.join(root, ".git"),
      {
        recursive: true,
      },
    );
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "dep.js"), "");
    fs.mkdirSync(path.join(root, "build", "output"), { recursive: true });
    fs.writeFileSync(path.join(root, "build", "output", "bundle.js"), "");
    fs.mkdirSync(path.join(root, "a", "build", "output"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "build", "output", "other.js"), "");
    return root;
  };

  const relativize = (paths) =>
    new Set(paths.map((p) => path.relative(dir, p).split(path.sep).join("/")));

  beforeEach(() => {
    dir = buildFixture();
  });

  afterEach(async () => {
    lumine.project.setPaths([]);
    await stopAllWatchers();
  });

  const indexOnce = async () => {
    lumine.project.setPaths([dir]);
    await new Promise((resolve) => {
      const sub = lumine.project.observeFilePaths(({ indexing }) => {
        if (indexing) return;
        sub.dispose();
        resolve();
      });
    });
  };

  it("indexes what a crawl finds, honouring core policy", async () => {
    jasmine.useRealClock();
    lumine.config.set("core.ignoredNames", ["node_modules"]);
    await indexOnce();

    const relative = relativize(lumine.project.getFilePaths());
    expect(relative.has("visible.txt")).toBe(true);
    expect(relative.has("sub/nested.txt")).toBe(true);
    expect(relative.has("ignored.txt")).toBe(false);
    expect(relative.has("node_modules/dep.js")).toBe(false);
    expect([...relative].some((p) => p.startsWith(".git/"))).toBe(false);
  });

  // The differential spec: whatever ripgrep excludes for a given
  // `core.ignoredNames`, the in-process predicate must exclude too. The index
  // filters created files with the predicate and seeds itself with the crawl, so
  // any drift between them shows up as a file that appears and then vanishes.
  it("rejects in process exactly what ripgrep's globs reject", async () => {
    jasmine.useRealClock();
    const ignoredNames = ["node_modules", "build/output", "*.tmp"];

    const withoutNames = [];
    await lumine.project.crawl({
      directoryPaths: [dir],
      ignoredNames: [],
      didFindPaths: (paths) => withoutNames.push(...paths),
    });
    const withNames = [];
    await lumine.project.crawl({
      directoryPaths: [dir],
      ignoredNames,
      didFindPaths: (paths) => withNames.push(...paths),
    });

    const kept = new Set(withNames);
    const excludedByRipgrep = withoutNames.filter((p) => !kept.has(p));
    expect(excludedByRipgrep.length).toBeGreaterThan(0);

    const FileIndexClass = require("../src/file-index");
    const predicate = new FileIndexClass({
      config: { get: (key) => (key === "core.ignoredNames" ? ignoredNames : null) },
    });

    const rejects = (absolutePath) =>
      predicate.isIgnoredRelativePath(path.relative(dir, absolutePath));

    for (const excluded of excludedByRipgrep) {
      expect(`${path.relative(dir, excluded)} rejected: ${rejects(excluded)}`).toBe(
        `${path.relative(dir, excluded)} rejected: true`,
      );
    }
    for (const keptPath of withNames) {
      expect(`${path.relative(dir, keptPath)} rejected: ${rejects(keptPath)}`).toBe(
        `${path.relative(dir, keptPath)} rejected: false`,
      );
    }
    predicate.destroy();
  });

  it("follows the filesystem after the first crawl", async () => {
    jasmine.useRealClock();
    await stopAllWatchers();
    lumine.config.set("core.ignoredNames", ["node_modules"]);
    await indexOnce();
    await lumine.project.getWatcherPromise(dir);

    // The watcher promise confirms the subscription exists, but events can
    // still be dropped in its start-up window. Prove the watch is delivering
    // before the real writes.
    const probeFile = path.join(dir, "probe.txt");
    let probeCount = 0;
    await conditionPromise(() => {
      fs.writeFileSync(probeFile, `probe ${++probeCount}`);
      return lumine.project.hasFilePath(probeFile);
    }, "the watcher to start delivering events");

    const created = path.join(dir, "created-later.txt");
    fs.writeFileSync(created, "");
    await conditionPromise(
      () => lumine.project.hasFilePath(created),
      "the created file to be indexed",
    );

    fs.unlinkSync(created);
    await conditionPromise(
      () => !lumine.project.hasFilePath(created),
      "the deleted file to leave the index",
    );

    const ignored = path.join(dir, "node_modules", "added.js");
    fs.writeFileSync(ignored, "");
    // Nothing should ever admit this; give it a beat to prove it does not.
    await timeoutPromise(500);
    expect(lumine.project.hasFilePath(ignored)).toBe(false);
  }, 30000);

  it("never admits a newly created VCS-ignored file", async () => {
    jasmine.useRealClock();
    await stopAllWatchers();
    lumine.config.set("core.ignoredNames", []);
    await indexOnce();
    await lumine.project.getWatcherPromise(dir);

    const probeFile = path.join(dir, "watcher-probe.txt");
    let probeCount = 0;
    await conditionPromise(() => {
      fs.writeFileSync(probeFile, `probe ${++probeCount}`);
      return lumine.project.hasFilePath(probeFile);
    }, "the watcher to start delivering events");

    const ignored = path.join(dir, "ignored.txt");
    fs.rmSync(ignored, { force: true });
    await timeoutPromise(250);

    const added = [];
    const subscription = lumine.project.observeFilePaths((change) => added.push(...change.added));
    fs.writeFileSync(ignored, "ignored again\n");
    await timeoutPromise(1000);
    subscription.dispose();

    expect(lumine.project.hasFilePath(ignored)).toBe(false);
    expect(added).not.toContain(ignored);
  }, 30000);

  // POSIX only: creating a symlink on Windows needs elevation or Developer Mode,
  // so the fixture cannot be built there reliably.
  if (process.platform !== "win32") {
    it("lists files under a symlinked root using the registered spelling", async () => {
      jasmine.useRealClock();
      const linkDir = path.join(temp.mkdirSync("file-index-link-"), "link");
      fs.symlinkSync(dir, linkDir);

      lumine.project.setPaths([linkDir]);
      await new Promise((resolve) => {
        const sub = lumine.project.observeFilePaths(({ indexing }) => {
          if (indexing) return;
          sub.dispose();
          resolve();
        });
      });

      const paths = lumine.project.getFilePaths();
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p.startsWith(linkDir + path.sep))).toBe(true);
      expect(paths.some((p) => p.startsWith(dir + path.sep))).toBe(false);
    });
  }
});
