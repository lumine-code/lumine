// Non-recursive filesystem watcher built on Node's `fs.watch`, used inside the
// watcher worker (see parcel-watcher-worker.js) for single files and for
// non-recursive directory watches. Recursive tree watching is handled
// separately by `@lumine-code/watcher`.
//
// The design follows VS Code's non-recursive watcher, and exists because
// `fs.watch` pointed *directly* at a file is unreliable: editors save
// atomically (write a temp file, then rename it over the original), which swaps
// the file's inode and orphans a file-level watch handle so every later edit is
// missed.
//
//   * A *file* is watched via its containing directory on every platform (the
//     directory's inode is stable across atomic saves, so no events are lost)
//     and filtered down to the target basename. When the platform withholds the
//     changed child's name (possible on macOS), the event is reported anyway so
//     the change is never missed — at worst a sibling change causes a redundant
//     re-read, which every consumer already tolerates.
//   * A *directory* is watched directly and reports events for its direct
//     children only (non-recursive). Used for the config directory.
//
// The callback is invoked with `(eventType, eventPath, oldPath)` where
// `eventType` is one of `'change'`, `'create'`, `'delete'`, or `'rename'`.
//
// `watch()` returns only once the OS is genuinely watching, so a change made
// immediately afterwards is always reported. See `waitForArm` for why that
// needs help on macOS.

const fs = require("fs");
const path = require("path");

// Live watchers, for leak detection and global teardown.
const ACTIVE = new Set();

// Delay before deciding whether a vanished file was truly deleted or merely
// atomically replaced. VS Code uses ~100ms for the same purpose.
const RENAME_VERIFY_DELAY = 60;

// Block until the `fs.watch` handles created so far are actually armed.
//
// On Linux and Windows `uv_fs_event_start` arms the OS watch inline
// (`inotify_add_watch`, `ReadDirectoryChangesW`), so `fs.watch` returning means
// the watch is live. macOS is different: `uv_fs_event_start` only appends a
// request to a queue drained by libuv's CoreFoundation run-loop thread, which
// rebuilds one process-wide `FSEventStream` from the full handle list. That
// stream is created with `kFSEventStreamEventIdSinceNow`, so anything that
// happens before the run-loop thread gets to it is invisible — permanently,
// since nothing replays it. `fs.watch` returning therefore promises nothing,
// and every layer above it inherits the lie: the worker replies to
// `watcher:watch`, `PathWatcher::getStartPromise()` resolves, and
// `TextBuffer::getFileWatchStartPromise()` resolves, all while the OS may still
// not be watching. A write issued right after that await is then lost.
//
// Closing a handle, by contrast, is synchronous: `uv__fsevents_close` queues a
// "closing" request and blocks on a semaphore that the run-loop thread posts
// only after it has rebuilt *and started* the replacement stream. The request
// queue is drained in order, so opening a throwaway watch and closing it right
// away is a rendezvous — when `close()` returns, every handle registered before
// it, including the one we just created, is live in the current stream.
//
// The throwaway watch targets the path we just armed, so the stream's path set
// is unchanged and the barrier costs one round trip to the run-loop thread
// (sub-millisecond) rather than any filesystem access.
function waitForArm(watchRoot) {
  if (process.platform !== "darwin") return;
  let barrier;
  try {
    barrier = fs.watch(watchRoot, { persistent: false }, () => {});
  } catch {
    // Out of watch descriptors, or the root vanished between the two calls.
    // The real watcher reports its own failures; don't mask them with ours.
    return;
  }
  barrier.close();
}

// Re-read every other live watcher after the process-wide event stream has been
// rebuilt.
//
// `waitForArm` makes the handle *being* armed safe. It does nothing for the
// handles that were already watching: the rebuild it forces destroys the old
// stream, and with it everything that stream had accepted but not yet delivered.
// Releasing a handle rebuilds the stream the same way. So on macOS any watcher
// can lose an event because an unrelated part of the editor happened to start or
// stop watching something in the same moment — a project opening, a buffer
// closing — and FSEvents never replays it, so a single lost event is permanent
// rather than late. Linux and Windows have no shared stream and no rebuild.
//
// A rebuild is a known, bounded window, so close it by reconciling across it:
// compare each target against the signature it had before and report what moved.
function reconcileAfterRebuild(except) {
  if (process.platform !== "darwin") return;
  for (const watcher of Array.from(ACTIVE)) {
    if (watcher === except) continue;
    watcher.reconcile();
  }
}

function sameSignature(left, right) {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;
}

function isCaseInsensitive() {
  return process.platform === "win32" || process.platform === "darwin";
}

function normalizeName(name) {
  if (name == null) return name;
  // macOS delivers decomposed (NFD) filenames; normalize to the composed (NFC)
  // form callers use so comparisons match.
  return process.platform === "darwin" ? name.normalize("NFC") : name;
}

function namesEqual(a, b) {
  if (a == null || b == null) return false;
  a = normalizeName(a);
  b = normalizeName(b);
  return isCaseInsensitive() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

class NodejsWatcher {
  constructor(watchedPath) {
    this.path = path.resolve(watchedPath);

    // Resolve symlinks so we watch the real entry; fall back to the given path.
    // Prefer `realpathSync.native`: on Windows it expands 8.3 short names (e.g.
    // `ASILOI~1` in temp paths). `fs.watch` on a short-name path aborts the
    // process via a libuv assertion when the OS reports long-form event paths.
    try {
      this.realPath = fs.realpathSync.native(this.path);
    } catch {
      try {
        this.realPath = fs.realpathSync(this.path);
      } catch {
        this.realPath = this.path;
      }
    }

    let stat = null;
    try {
      stat = fs.statSync(this.realPath);
    } catch {
      // The target does not exist yet. Treat it as a file and watch its parent
      // so we can report its (re)creation.
    }

    this.isDirectory = stat ? stat.isDirectory() : false;
    this.exists = stat != null;
    // Remember the inode so a file that vanishes can be distinguished from one
    // that was moved (renamed) to a sibling path.
    this.ino = stat ? stat.ino : null;

    if (this.isDirectory) {
      // Non-recursive directory watch.
      this.mode = "dir";
      this.watchRoot = this.realPath;
      this.fileName = null;
      // macOS/Windows watch a file directly; watch the parent elsewhere.
      this.watchDirectly = true;
    } else {
      this.mode = "file";
      this.fileName = path.basename(this.realPath);
      // Always watch the (stable) parent directory and filter to our basename.
      // Watching a file directly is unreliable: atomic saves swap the file's
      // inode and orphan the handle, and macOS `fs.watch` pointed at a file
      // frequently drops in-place content events entirely. The directory's
      // inode is stable, so no events are lost. This matches VS Code's
      // non-recursive watcher, which also watches single files via their parent.
      this.watchDirectly = false;
      this.watchRoot = path.dirname(this.realPath);
    }

    this.callback = null;
    this.errorCallback = null;
    this.closed = false;
    this.handle = null;
    this.verifyTimer = null;
    // What the target looked like when we last spoke about it, so a rebuild of
    // the macOS event stream can be reconciled across. See `reconcileAfterRebuild`.
    this.signature = this.readSignature();

    ACTIVE.add(this);
  }

  onDidChange(callback, errorCallback = null) {
    this.callback = callback;
    this.errorCallback = errorCallback;
    this.startWatching();
    return this;
  }

  // Throws if the OS refuses the watch. The caller decides what that means:
  // `watch()` lets it out so the worker can answer the watch request with an
  // error, while a re-arm treats it as the end of the watch.
  startWatching() {
    if (this.closed || this.handle) return;
    this.handle = fs.watch(this.watchRoot, { persistent: true }, (eventType, fileName) => {
      this.handleRawEvent(eventType, fileName);
    });
    this.handle.on("error", (err) => this.handleError(err));
    waitForArm(this.watchRoot);
    // Arming rebuilt the shared stream, so everything else watching just lost
    // whatever was still in flight.
    reconcileAfterRebuild(this);
  }

  handleRawEvent(eventType, rawName) {
    if (this.closed) return;

    if (this.mode === "dir") {
      this.handleDirEvent(eventType, rawName);
      return;
    }

    const nameMatchesOrUnknown =
      this.watchDirectly || rawName == null || namesEqual(rawName, this.fileName);

    if (eventType === "change") {
      // A content change only matters when it names our file (or the platform
      // omitted the name); ignore edits to siblings in the parent directory.
      if (!nameMatchesOrUnknown) return;
      if (!this.exists) {
        // The file appeared (created). Capture its identity and report it.
        this.captureIdentity();
        this.emit(this.exists ? "create" : "change", this.path);
      } else {
        this.emit("change", this.path);
      }
      return;
    }

    // A `rename` may be our file being created, deleted, moved, or replaced —
    // and macOS reports ordinary in-place writes as `rename` too. Crucially,
    // when our file is *moved away* the event can surface under the file's NEW
    // basename (macOS especially), so we can't rely on the name to decide
    // relevance. Instead, look at whether our path still exists.
    let existsNow;
    try {
      fs.statSync(this.realPath);
      existsNow = true;
    } catch {
      existsNow = false;
    }
    if (existsNow) {
      // Still present: an in-place change or a completed atomic save. Report it
      // immediately rather than waiting out the rename-verify delay — but only
      // when the event concerns our file (a named sibling rename doesn't touch
      // our contents).
      if (!nameMatchesOrUnknown) return;
      const wasAbsent = !this.exists;
      this.captureIdentity();
      this.emit(wasAbsent ? "create" : "change", this.path);
      return;
    }
    // Gone from its path. If our file previously existed it was deleted or
    // moved (possibly reported under its new name) — defer to distinguish
    // delete vs. move. If it never existed, an unrelated sibling rename is
    // irrelevant.
    if (this.exists) {
      this.scheduleVerify();
    }
  }

  handleDirEvent(eventType, rawName) {
    // Report events for direct children only. `rename` fires on add/remove/move;
    // `change` fires on a child's content change (Linux/Windows). Consumers
    // filter by basename.
    // Report paths in the requested (`this.path`) form, but stat/access against
    // the real path so existence checks work.
    let childPath = rawName != null ? path.join(this.path, rawName) : this.path;
    let realChildPath = rawName != null ? path.join(this.realPath, rawName) : this.realPath;

    if (eventType === "change") {
      this.emit("change", childPath);
      return;
    }

    // `rename`: a child was added, removed, or moved. Decide by existence.
    if (rawName == null) {
      // Platform withheld the name (e.g. macOS). Report a generic change so the
      // consumer re-scans.
      this.emit("change", this.path);
      return;
    }
    fs.access(realChildPath, (err) => {
      if (this.closed) return;
      this.emit(err ? "delete" : "change", childPath);
    });
  }

  // A cheap fingerprint of the watched entry. For a directory `mtimeMs` moves
  // when a direct child is added, removed or renamed — which is what a
  // non-recursive directory watch reports as `rename`; a child's contents
  // changing under it is not visible here and is not recovered.
  readSignature() {
    try {
      const stat = fs.statSync(this.realPath);
      return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
    } catch {
      return { exists: false };
    }
  }

  // Report anything that moved while the event stream was being rebuilt.
  reconcile() {
    if (this.closed || !this.handle || !this.callback) return;

    const previous = this.signature;
    const current = this.readSignature();
    if (sameSignature(previous, current)) return;

    if (this.mode === "dir") {
      // Consumers of a directory watch filter by basename, and we cannot say
      // which child moved — report the root so they re-scan.
      this.emit("change", this.path);
      return;
    }

    if (!current.exists) {
      // Let the usual rename-versus-delete arbitration run rather than calling
      // it a deletion here: an atomic save is momentarily indistinguishable.
      if (previous.exists) this.scheduleVerify();
      return;
    }

    const wasAbsent = !previous.exists;
    this.captureIdentity();
    this.emit(wasAbsent ? "create" : "change", this.path);
  }

  captureIdentity() {
    try {
      const stat = fs.statSync(this.realPath);
      this.ino = stat.ino;
      this.exists = true;
    } catch {
      this.exists = false;
      this.ino = null;
    }
  }

  scheduleVerify() {
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null;
      if (this.closed) return;
      fs.access(this.realPath, (err) => {
        if (this.closed) return;
        if (err) {
          // Gone from its path. It may have been moved rather than deleted —
          // look for a sibling with the same inode and report a rename.
          const renamedTo = this.findRenameTarget();
          if (renamedTo) {
            const oldPath = this.path;
            this.emit("rename", renamedTo, oldPath);
          } else {
            this.exists = false;
            this.emit("delete", this.path);
          }
        } else {
          // Present again. On a direct file watch (macOS) an atomic save
          // replaced the inode and left the handle on the old one; re-arm.
          const wasAbsent = !this.exists;
          this.captureIdentity();
          if (this.watchDirectly) {
            this.stopHandle();
            try {
              this.startWatching();
            } catch (error) {
              // Nothing left to watch through, so end the watch loudly rather
              // than leaving a handle-less watcher that reports nothing.
              this.handleError(error);
              return;
            }
          }
          this.emit(wasAbsent ? "create" : "change", this.path);
        }
      });
    }, RENAME_VERIFY_DELAY);
  }

  // Find a sibling of the (now missing) watched file that has the same inode —
  // i.e. the file was moved there. Returns the new path, or null.
  findRenameTarget() {
    if (this.ino == null) return null;
    const realDir = path.dirname(this.realPath);
    const reportDir = path.dirname(this.path);
    let entries;
    try {
      entries = fs.readdirSync(realDir);
    } catch {
      return null;
    }
    for (const name of entries) {
      const candidate = path.join(realDir, name);
      if (candidate === this.realPath) continue;
      let st;
      try {
        st = fs.statSync(candidate);
      } catch {
        continue;
      }
      // Report the moved-to path in the requested (`this.path`) form.
      if (st.ino && st.ino === this.ino) return path.join(reportDir, name);
    }
    return null;
  }

  emit(eventType, eventPath, oldPath) {
    if (this.closed || !this.callback) return;
    // Anything reported now is accounted for, so a later rebuild must not
    // reconcile it a second time.
    if (process.platform === "darwin") this.signature = this.readSignature();
    this.callback(eventType, eventPath, oldPath);
  }

  // A runtime failure on a live handle. The watch is over either way — the
  // question this answers is whether anyone finds out.
  handleError(err) {
    // ENOENT means the watched root vanished. For a file watcher, the
    // containing directory is gone, so the file is gone too.
    if (this.mode === "file" && err && err.code === "ENOENT") {
      this.exists = false;
      this.emit("delete", this.path);
    }

    // Deliberately no re-arm. Everything that reaches here — the root gone, out
    // of descriptors, access denied — recurs immediately, so retrying would spin
    // instead of recovering, and a retry loop is worse than a watch that admits
    // it has stopped. Report instead, and let the owner decide whether to
    // re-establish it.
    const errorCallback = this.errorCallback;
    // Closing first keeps `ACTIVE` (and so the spec harness's leak check) honest
    // about what is really being watched.
    this.close();
    if (errorCallback) errorCallback(err);
  }

  stopHandle() {
    if (this.handle) {
      this.handle.removeAllListeners();
      this.handle.close();
      this.handle = null;
      // Releasing rebuilds the shared stream just as arming does.
      reconcileAfterRebuild(this);
    }
  }

  // Stop watching and release the underlying `fs.watch` handle.
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = null;
    }
    this.stopHandle();
    this.callback = null;
    this.errorCallback = null;
    ACTIVE.delete(this);
  }

  // Async alias so the worker can treat file and directory (parcel) handles
  // uniformly — parcel's handle exposes `unsubscribe()`.
  async unsubscribe() {
    this.close();
  }
}

// Watch a single file or a directory (non-recursively). The `callback` receives
// `(eventType, eventPath, oldPath)`; `errorCallback` receives an `Error` if the
// watch later fails, after which it delivers nothing more. Returns the watcher,
// which exposes `close()` and `unsubscribe()`.
//
// The OS watch is live by the time this returns (see `waitForArm`), so a change
// made immediately afterwards is reported; callers need no settling delay.
//
// **Throws if the watch cannot be armed.** It used to swallow that failure, so
// the worker answered the watch request with success and the subscriber was
// handed a watcher that would never emit — an EMFILE or a missing parent
// directory was indistinguishable from a file nobody was touching.
function watch(pathToWatch, callback, errorCallback = null) {
  const watcher = new NodejsWatcher(pathToWatch);
  try {
    watcher.onDidChange(callback, errorCallback);
  } catch (error) {
    // Nothing was armed, so leave no half-registered watcher behind.
    watcher.close();
    throw error;
  }
  return watcher;
}

// Return the distinct roots currently watched. Used for leak detection.
function getWatchedPaths() {
  const result = new Set();
  for (const w of ACTIVE) result.add(w.watchRoot);
  return Array.from(result);
}

// Close every live non-recursive watcher.
function closeAllNodejsWatchers() {
  for (const w of Array.from(ACTIVE)) w.close();
}

module.exports = { NodejsWatcher, watch, getWatchedPaths, closeAllNodejsWatchers };
