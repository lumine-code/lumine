const path = require("path");

const fs = require("@lumine-code/fs-plus");
const picomatch = require("picomatch");
const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");

// ripgrep hands over 100 paths at a time, so a 100k-file crawl would fire a
// thousand callbacks. Deltas are coalesced into one emission per window. The
// window is armed by the first change and is NOT extended by later ones, so a
// continuous stream cannot starve delivery — the same contract as
// `GitRepository::scheduleStatusSnapshotRefresh`.
const EmitDebounceMs = 100;

// How long a root that needs re-crawling waits before it gets one. Long enough
// that an install or a checkout costs a handful of crawls rather than one per
// batch; short enough that the index is never stale for more than a couple of
// seconds after the writes stop.
const ReconcileDebounceMs = 2000;

// A batch that creates more paths than this under one root is a bulk operation —
// an install, a checkout, a clone, an extract. Deciding each one's fate in
// process is both expensive and wrong, so the whole burst is dropped and the
// root is re-crawled instead, which is cheaper AND exact. See `admitCreated`.
const CreatedBurstLimit = 100;

// Small bursts are admitted on the in-process predicate alone, which cannot see
// `.gitignore`. Each admission is therefore a guess, and the guesses are
// counted: a build in watch mode dribbling one file at a time would otherwise
// accumulate an unbounded amount of ignored output between crawls.
const BlindAdmissionLimit = 1000;

// A safety valve, not a policy. No real project reaches this; a root pointed at
// `C:\` or `/` does, and retaining that would take the window down.
const PathLimitPerRoot = 500000;

// Never indexed, whatever `core.ignoredNames` says — `RipgrepFileCrawler` passes
// `--glob !.git` / `--glob !.hg` unconditionally, so the in-process predicate
// must too, or a created path could enter the index that a crawl then removes.
const AlwaysIgnoredComponents = new Set([".git", ".hg"]);

// A root that is not a local absolute directory cannot be crawled: ripgrep would
// be spawned with a URI as its working directory. Custom directory providers
// supply these.
const UriScheme = /^[A-Za-z][A-Za-z0-9+\-.]*:\/\//;

const caseInsensitive = fs.isCaseInsensitive();
const fold = caseInsensitive ? (aPath) => aPath.toLowerCase() : (aPath) => aPath;

const toPosix = path.sep === "/" ? (aPath) => aPath : (aPath) => aPath.split(path.sep).join("/");

/**
 * @private
 *
 * A live index of every file under a project's root directories.
 *
 * One crawl, shared. Reached only through the file-path methods on
 * {@link Project} — this class is an implementation detail and has no stable
 * shape of its own.
 *
 * The index applies core policy only — `core.ignoredNames`,
 * `core.excludeVcsIgnoredPaths`, `core.followSymlinks` — so it is a superset of
 * what any one consumer wants, and package-specific exclusions stay cheap
 * read-time filters over it.
 */
module.exports = class FileIndex {
  constructor({ config } = {}) {
    this.config = config;
    this.project = null;
    this.destroyed = false;

    this.emitter = new Emitter();
    this.projectSubscriptions = new CompositeDisposable();

    // Registered root path -> entry. The registered spelling is the index's
    // spelling, matching `Project::getPaths` and `Project::relativizePath`.
    this.entries = new Map();

    // Absolute path -> how many roots hold it. Nested roots are crawled
    // independently, so one file can belong to two of them; counting is what
    // keeps a removal from one root from reporting a file the other still has.
    // The map doubles as the global path set, so `getPaths` needs no union.
    this.refCounts = new Map();
    this.cachedPaths = null;

    this.pendingAdded = new Set();
    this.pendingRemoved = new Set();
    this.emitTimer = null;

    this.ignoreMatchers = null;
    this.ignoreSource = null;
  }

  /*
  Section: Lifecycle
  */

  attachProject(project) {
    if (this.destroyed) throw new Error("Cannot attach a destroyed FileIndex");
    this.project = project;

    this.projectSubscriptions.dispose();
    this.projectSubscriptions = new CompositeDisposable();
    this.projectSubscriptions.add(
      project.onDidChangePaths(() => this.reconcileRoots()),
      project.onDidChangeFiles((events) => this.handleFileEvents(events)),
    );

    const config = this.getConfig();
    if (config) {
      // These three are the whole of the index's policy, so a change to any of
      // them invalidates every root.
      for (const key of [
        "core.ignoredNames",
        "core.followSymlinks",
        "core.excludeVcsIgnoredPaths",
      ]) {
        this.projectSubscriptions.add(config.onDidChange(key, () => this.refreshForPolicyChange()));
      }
    }

    this.reconcileRoots();
  }

  destroy() {
    this.destroyed = true;
    this.projectSubscriptions.dispose();
    this.clearEmitTimer();
    for (const entry of this.entries.values()) this.teardownEntry(entry);
    this.entries.clear();
    this.refCounts.clear();
    this.cachedPaths = null;
    this.pendingAdded.clear();
    this.pendingRemoved.clear();
    this.emitter.dispose();
    this.project = null;
  }

  getConfig() {
    return this.config ?? global.lumine?.config ?? null;
  }

  /*
  Section: Reading
  */

  observe(callback) {
    // The whole index as one `added` batch, so a consumer has exactly one code
    // path: apply `removed`, then apply `added`. Copied rather than shared,
    // because the deltas are documented as the index's own arrays to keep.
    callback({ added: this.getPaths().slice(), removed: [], indexing: this.isIndexing() });
    return this.emitter.on("did-change", callback);
  }

  getPaths() {
    this.cachedPaths ??= Array.from(this.refCounts.keys());
    return this.cachedPaths;
  }

  getPathsForRoot(root) {
    const rootPath = typeof root === "string" ? root : root?.getPath?.();
    const entry = rootPath == null ? null : this.entries.get(rootPath);
    if (!entry) return [];
    entry.cachedPaths ??= Array.from(entry.paths);
    return entry.cachedPaths;
  }

  has(filePath) {
    return this.refCounts.has(filePath);
  }

  getPathCount() {
    return this.refCounts.size;
  }

  getRootPaths() {
    return Array.from(this.entries.keys());
  }

  isIndexing() {
    for (const entry of this.entries.values()) {
      if (entry.crawl) return true;
    }
    return false;
  }

  /*
  Section: Roots
  */

  reconcileRoots() {
    if (this.destroyed || !this.project) return;

    // Deliberately not reading the `did-change-paths` argument: `setPaths` emits
    // the array it was given while every other site emits `getPaths()`, and a
    // file path handed to `setPaths` becomes its parent directory, so the
    // argument can name a root that does not exist.
    const directories = this.project.getDirectories();
    const seen = new Set();

    for (const directory of directories) {
      const rootPath = directory.getPath();
      if (!this.isCrawlableRoot(rootPath)) continue;
      seen.add(rootPath);

      let entry = this.entries.get(rootPath);
      if (!entry) {
        entry = this.createEntry(directory);
        this.entries.set(rootPath, entry);
        this.startCrawl(entry);
      } else if (entry.directory !== directory) {
        // `setPaths` rebuilds its `ProjectDirectory` instances, and the realpath
        // memo lives on the instance. Rebind so it stays useful.
        entry.directory = directory;
      }
    }

    for (const [rootPath, entry] of Array.from(this.entries)) {
      if (seen.has(rootPath)) continue;
      this.dropEntry(entry);
      this.entries.delete(rootPath);
    }

    this.scheduleEmit();
  }

  // A root that is not a local absolute directory cannot be crawled. Both tests
  // earn their place: a directory provider hands back its URI untouched, while
  // one that has been through `path.normalize` arrives mangled into something
  // relative (`ssh://host/x` becomes `.\ssh:\host\x` on Windows).
  isCrawlableRoot(rootPath) {
    if (typeof rootPath !== "string" || rootPath.length === 0) return false;
    if (UriScheme.test(rootPath)) return false;
    return path.isAbsolute(rootPath);
  }

  createEntry(directory) {
    const rootPath = directory.getPath();
    const entry = {
      directory,
      rootPath,
      paths: new Set(),
      cachedPaths: null,
      seeded: false,
      truncated: false,
      crawl: null,
      generation: 0,
      staging: null,
      suppressed: null,
      blindAdmissions: 0,
      dirty: false,
      reconcileTimer: null,
    };
    this.resolveEntryPaths(entry);
    return entry;
  }

  // The realpath is re-read at every crawl: a root can be re-pointed at another
  // target while the window is open, and that is the right granularity to notice.
  // `getRealPathSync` returns the unresolved path when it cannot resolve, which
  // makes the reconciliation below the identity — no branch needed.
  resolveEntryPaths(entry) {
    const realPath = entry.directory.getRealPathSync?.() ?? entry.rootPath;
    entry.foldedRoot = fold(entry.rootPath);
    entry.foldedRootPrefix = fold(entry.rootPath + path.sep);
    entry.foldedReal = fold(realPath);
    entry.foldedRealPrefix = fold(realPath + path.sep);
  }

  dropEntry(entry) {
    this.teardownEntry(entry);
    for (const filePath of Array.from(entry.paths)) {
      this.removeFromRoot(entry, filePath);
    }
  }

  teardownEntry(entry) {
    entry.generation += 1;
    if (entry.crawl) entry.crawl.cancel();
    entry.crawl = null;
    entry.staging = null;
    entry.suppressed = null;
    if (entry.reconcileTimer != null) {
      clearTimeout(entry.reconcileTimer);
      entry.reconcileTimer = null;
    }
  }

  /*
  Section: Crawling
  */

  startCrawl(entry) {
    if (this.destroyed || !this.project) return;

    if (entry.crawl) entry.crawl.cancel();
    const generation = ++entry.generation;

    this.resolveEntryPaths(entry);
    entry.staging = new Set();
    entry.suppressed = new Set();
    entry.dirty = false;
    entry.blindAdmissions = 0;
    entry.truncated = false;

    // A first crawl streams into the index so a consumer can render as results
    // arrive. A re-crawl of a seeded root stages instead and swaps at the end,
    // so a list the user is looking at does not empty and refill.
    const streaming = !entry.seeded;

    // One crawl per root, never one call with several `directoryPaths`:
    // `RipgrepFileCrawler` dedupes across directories, so a file under two
    // nested roots would land in exactly one root's set, arbitrarily. It already
    // spawns a child per directory, so this costs nothing and buys per-root
    // cancellation.
    const crawl = this.project.crawl({
      directoryPaths: [entry.rootPath],
      didFindPaths: (paths) => {
        // A cancelled crawl still flushes its partial batch, so every handler
        // here has to be generation-guarded. This is a live path, not caution.
        if (entry.generation !== generation) return;
        for (const filePath of paths) {
          if (entry.suppressed.has(filePath)) continue;
          if (entry.staging.size >= PathLimitPerRoot) {
            this.truncate(entry);
            return;
          }
          entry.staging.add(filePath);
          if (streaming) this.addToRoot(entry, filePath);
        }
        if (streaming) this.scheduleEmit();
      },
    });

    entry.crawl = crawl;
    crawl.then(() => {
      if (entry.generation !== generation) return;
      this.finishCrawl(entry);
    });
  }

  finishCrawl(entry) {
    const staging = entry.staging ?? new Set();
    entry.crawl = null;
    entry.staging = null;
    entry.suppressed = null;
    entry.seeded = true;

    for (const filePath of Array.from(entry.paths)) {
      if (!staging.has(filePath)) this.removeFromRoot(entry, filePath);
    }
    for (const filePath of staging) {
      this.addToRoot(entry, filePath);
    }

    // Flush rather than schedule, so `indexing` going false always arrives with
    // an emission and a consumer's spinner clears in exactly one place.
    this.flushEmit();
  }

  truncate(entry) {
    if (entry.truncated) return;
    entry.truncated = true;
    if (entry.crawl) entry.crawl.cancel();
    const notifications = this.project?.notificationManager;
    notifications?.addWarning("Project is too large to index", {
      description:
        `\`${entry.rootPath}\` holds more than ${PathLimitPerRoot} files, so the file ` +
        "index stopped there. The file finder and path suggestions will not list them all. " +
        "This usually means a root was opened much higher up the filesystem than intended.",
      dismissable: true,
    });
  }

  refresh(options = {}) {
    if (this.destroyed || !this.project) return Promise.resolve();
    const entries = options.rootPaths
      ? options.rootPaths.map((rootPath) => this.entries.get(rootPath)).filter(Boolean)
      : Array.from(this.entries.values());
    for (const entry of entries) this.startCrawl(entry);
    return Promise.all(entries.map((entry) => entry.crawl).filter(Boolean)).then(() => undefined);
  }

  refreshForPolicyChange() {
    this.ignoreMatchers = null;
    this.ignoreSource = null;
    this.refresh();
  }

  markDirty(entry) {
    entry.dirty = true;
    if (entry.reconcileTimer != null) return;
    entry.reconcileTimer = setTimeout(() => {
      entry.reconcileTimer = null;
      if (this.destroyed || this.entries.get(entry.rootPath) !== entry) return;
      if (!entry.dirty) return;
      this.startCrawl(entry);
    }, ReconcileDebounceMs);
  }

  /*
  Section: Filesystem events
  */

  handleFileEvents(events) {
    if (this.destroyed || this.entries.size === 0) return;

    // Attribution and the ignore decision are both properties of the event's
    // directory, and a batch runs to thousands of events during an install or a
    // checkout — so classify each directory once and reuse it. This is what
    // keeps a burst under an ignored tree cheap: every path in it resolves
    // through one rejected directory.
    const directoryCache = new Map();
    const created = new Map();

    for (const event of events) {
      const eventPath = event.path;
      if (!eventPath) continue;

      if (this.isIgnoreRuleFile(eventPath)) {
        for (const match of this.attribute(eventPath, directoryCache) ?? []) {
          this.markDirty(match.entry);
        }
      }

      switch (event.action) {
        case "created":
          this.collectCreated(eventPath, directoryCache, created);
          break;
        case "deleted":
          this.handleDeleted(eventPath, directoryCache);
          break;
        case "renamed":
          // Never emitted for a recursive project root — a move arrives as a
          // delete and a create. A custom directory provider may still send one.
          if (event.oldPath) this.handleDeleted(event.oldPath, directoryCache);
          this.collectCreated(eventPath, directoryCache, created);
          break;
        default:
          // "updated" changes contents, never membership.
          break;
      }
    }

    this.admitCreated(created);
    this.scheduleEmit();
  }

  // Returns the matching roots for a path's *directory*, each with the index
  // spelling of that directory, or null when the path is under no root or under
  // an ignored one.
  attribute(eventPath, directoryCache) {
    const directoryPath = path.dirname(eventPath);
    let matches = directoryCache.get(directoryPath);
    if (matches === undefined) {
      matches = this.attributeDirectory(directoryPath);
      directoryCache.set(directoryPath, matches);
    }
    return matches;
  }

  attributeDirectory(directoryPath) {
    const matches = [];
    for (const entry of this.entries.values()) {
      const indexDirectory = this.toIndexPath(entry, directoryPath);
      if (indexDirectory == null) continue;

      const relativeDirectory =
        indexDirectory === entry.rootPath
          ? ""
          : indexDirectory.slice(entry.rootPath.length + path.sep.length);
      if (relativeDirectory && this.isIgnoredRelativePath(relativeDirectory)) continue;

      matches.push({
        entry,
        prefix: indexDirectory + path.sep,
        relativeDirectory: toPosix(relativeDirectory),
      });
    }
    return matches.length > 0 ? matches : null;
  }

  // Watcher events are spelled the way the root was registered, so the first
  // test wins for every ordinary root. The realpath is still tried, because a
  // custom directory provider's `onDidChangeFiles` reports whatever it likes.
  // Slice by the folded prefix rather than rejoining: folding preserves length,
  // so the tail keeps the case the filesystem gave it.
  toIndexPath(entry, absolutePath) {
    const folded = fold(absolutePath);
    if (folded === entry.foldedRoot || folded === entry.foldedReal) return entry.rootPath;
    if (folded.startsWith(entry.foldedRootPrefix)) {
      return entry.rootPath + path.sep + absolutePath.slice(entry.foldedRootPrefix.length);
    }
    if (
      entry.foldedRealPrefix !== entry.foldedRootPrefix &&
      folded.startsWith(entry.foldedRealPrefix)
    ) {
      return entry.rootPath + path.sep + absolutePath.slice(entry.foldedRealPrefix.length);
    }
    return null;
  }

  collectCreated(eventPath, directoryCache, created) {
    const matches = this.attribute(eventPath, directoryCache);
    if (!matches) return;
    const basename = path.basename(eventPath);
    for (const match of matches) {
      if (this.isIgnoredLeaf(basename, match.relativeDirectory)) continue;
      let batch = created.get(match.entry);
      if (!batch) {
        batch = [];
        created.set(match.entry, batch);
      }
      batch.push(match.prefix + basename);
    }
  }

  // The created-file problem: ripgrep did the `.gitignore` filtering out of
  // process and that cannot be replicated here, so every admission below is a
  // guess. Two rules keep the guessing bounded and cheap.
  admitCreated(created) {
    for (const [entry, batch] of created) {
      // A bulk operation is exactly where per-file guessing is most expensive
      // and most likely wrong — an install under an ignored `node_modules` is
      // tens of thousands of wrong guesses — and it is also where one ripgrep
      // run is cheaper than the guessing. Admit none of it and re-crawl.
      if (batch.length > CreatedBurstLimit) {
        this.markDirty(entry);
        continue;
      }

      let admitted = 0;
      for (const indexPath of batch) {
        // The recursive backend reports no entry kind, so a directory and a file
        // are indistinguishable without asking. Bounded by the burst limit
        // above, which is what keeps this off the renderer's critical path; a
        // created directory reports its own contents separately, so skipping it
        // loses nothing.
        let stats;
        try {
          stats = fs.lstatSync(indexPath);
        } catch {
          continue;
        }
        if (!stats.isFile()) continue;
        this.addToRoot(entry, indexPath);
        if (entry.staging) {
          entry.staging.add(indexPath);
          entry.suppressed.delete(indexPath);
        }
        admitted += 1;
      }

      // A build in watch mode dribbling ignored output one file at a time would
      // otherwise accumulate without bound between crawls.
      entry.blindAdmissions += admitted;
      if (entry.blindAdmissions > BlindAdmissionLimit) this.markDirty(entry);
    }
  }

  handleDeleted(eventPath, directoryCache) {
    const matches = this.attribute(eventPath, directoryCache);
    if (!matches) return;
    const basename = path.basename(eventPath);

    for (const match of matches) {
      const indexPath = match.prefix + basename;
      if (match.entry.paths.has(indexPath)) {
        this.removeFromRoot(match.entry, indexPath);
        match.entry.staging?.delete(indexPath);
        match.entry.suppressed?.add(indexPath);
        continue;
      }
      if (this.isIgnoredLeaf(basename, match.relativeDirectory)) continue;
      // Not an indexed file, so it may have been a directory — and a recursive
      // delete arrives as one event for the directory, not one per file.
      this.removeSubtree(match.entry, indexPath);
    }
  }

  removeSubtree(entry, indexPath) {
    const prefix = indexPath + path.sep;
    for (const filePath of Array.from(entry.paths)) {
      if (!filePath.startsWith(prefix)) continue;
      this.removeFromRoot(entry, filePath);
      entry.staging?.delete(filePath);
      entry.suppressed?.add(filePath);
    }
  }

  isIgnoreRuleFile(filePath) {
    const basename = path.basename(filePath);
    if (basename === ".gitignore" || basename === ".ignore" || basename === ".rgignore") {
      return true;
    }
    return filePath.endsWith(path.join(".git", "info", "exclude"));
  }

  /*
  Section: The ignore predicate
  */

  // `core.ignoredNames` are gitignore-style: a pattern with no `/` matches a
  // basename at any depth, and a pattern that matches a directory excludes
  // everything under it. Both fall out of testing each pattern against the parts
  // of a path rather than against the whole of it — components for a slashless
  // pattern, ancestor prefixes for an anchored one. Widening each pattern into
  // an `X` plus `**/X/**` pair approximates the same thing with two matchers, a
  // conditional `basename` flag, and a hole for anchored patterns.
  isIgnoredRelativePath(relativePath) {
    if (!relativePath) return false;
    const parts = relativePath.split(path.sep);
    for (const part of parts) {
      if (AlwaysIgnoredComponents.has(part)) return true;
    }

    const matchers = this.getIgnoreMatchers();
    if (matchers.length === 0) return false;

    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      for (const matcher of matchers) {
        if (matcher.anchored ? matcher.match(prefix) : matcher.match(part)) return true;
      }
    }
    return false;
  }

  // The leaf half of the same predicate, for a path whose directory has already
  // been cleared: every ancestor component has been tested, so only the basename
  // and an anchored pattern naming the file itself are left.
  isIgnoredLeaf(basename, relativeDirectory) {
    if (AlwaysIgnoredComponents.has(basename)) return true;

    const matchers = this.getIgnoreMatchers();
    if (matchers.length === 0) return false;

    const relativePath = relativeDirectory ? `${relativeDirectory}/${basename}` : basename;
    for (const matcher of matchers) {
      if (matcher.anchored ? matcher.match(relativePath) : matcher.match(basename)) return true;
    }
    return false;
  }

  getIgnoreMatchers() {
    const names = this.getConfig()?.get("core.ignoredNames") ?? [];
    const source = names.join("\n");
    if (this.ignoreMatchers && this.ignoreSource === source) return this.ignoreMatchers;

    this.ignoreSource = source;
    this.ignoreMatchers = [];
    for (const name of names) {
      if (!name) continue;
      try {
        this.ignoreMatchers.push({
          match: picomatch(name.replace(/^\/+/, ""), { dot: true }),
          anchored: name.includes("/"),
        });
      } catch {
        // An unparseable glob excludes nothing, which is what ripgrep does with
        // it too — it reports the bad pattern on stderr and carries on.
      }
    }
    return this.ignoreMatchers;
  }

  /*
  Section: Mutation and emission
  */

  addToRoot(entry, filePath) {
    if (entry.paths.has(filePath)) return;
    entry.paths.add(filePath);
    entry.cachedPaths = null;

    const count = this.refCounts.get(filePath);
    if (count === undefined) {
      this.refCounts.set(filePath, 1);
      this.cachedPaths = null;
      if (this.pendingRemoved.delete(filePath)) return;
      this.pendingAdded.add(filePath);
    } else {
      this.refCounts.set(filePath, count + 1);
    }
  }

  removeFromRoot(entry, filePath) {
    if (!entry.paths.delete(filePath)) return;
    entry.cachedPaths = null;

    const count = this.refCounts.get(filePath);
    if (count === undefined) return;
    if (count > 1) {
      this.refCounts.set(filePath, count - 1);
      return;
    }

    this.refCounts.delete(filePath);
    this.cachedPaths = null;
    if (this.pendingAdded.delete(filePath)) return;
    this.pendingRemoved.add(filePath);
  }

  scheduleEmit() {
    if (this.emitTimer != null) return;
    if (this.pendingAdded.size === 0 && this.pendingRemoved.size === 0) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, EmitDebounceMs);
  }

  flushEmit() {
    this.clearEmitTimer();
    this.emitNow();
  }

  clearEmitTimer() {
    if (this.emitTimer == null) return;
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }

  emitNow() {
    if (this.destroyed) return;
    const added = Array.from(this.pendingAdded);
    const removed = Array.from(this.pendingRemoved);
    this.pendingAdded.clear();
    this.pendingRemoved.clear();
    // Every mutation is already applied, so a handler that calls back into the
    // index — to refresh it, or to read it — sees a consistent one.
    this.emitter.emit("did-change", { added, removed, indexing: this.isIndexing() });
  }
};
