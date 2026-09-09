const fs = require("fs");
const path = require("path");
const { absolutePath, containsPath, relativePath, ancestors } = require("./file-watch-paths");
const {
  MAX_QUEUED_EVENTS,
  deferred,
  abortError,
  serializeError,
  mergeChange,
} = require("./file-watch-protocol");

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function fingerprint(stat) {
  return stat ? `${identity(stat)}:${stat.size}:${stat.mtimeNs ?? stat.mtimeMs}` : null;
}

/** Logical fixed-path subscriptions and canonical directory source pooling. */
class FileWatchWorker {
  constructor({
    engine,
    sendEvent,
    filesystem = fs.promises,
    settleDelay = 35,
    retryDelay = 30000,
  }) {
    this.engine = engine;
    this.sendEvent = sendEvent;
    this.fs = filesystem;
    this.settleDelay = settleDelay;
    this.retryDelay = retryDelay;
    this.sources = new Map();
    this.subscriptions = new Map();
    this.nextIncident = 0;
    this.pendingIncidents = new Map();
    this.closed = false;
  }

  async stat(targetPath) {
    try {
      return await this.fs.stat(targetPath, { bigint: true });
    } catch (error) {
      if (MISSING_CODES.has(error.code)) return null;
      throw error;
    }
  }

  async plan(logical) {
    const targetStat = await this.stat(logical.path);
    if (targetStat && targetStat.isDirectory() !== (logical.kind === "directory")) {
      throw Object.assign(new Error(`Expected a ${logical.kind}: ${logical.path}`), {
        code: logical.kind === "directory" ? "ENOTDIR" : "EISDIR",
        path: logical.path,
      });
    }
    const canonicalTarget = targetStat ? await this.fs.realpath(logical.path) : null;
    const descriptors = new Map();
    const add = async (directoryPath, recursive, guardPath, main = false) => {
      const stat = await this.stat(directoryPath);
      if (!stat?.isDirectory()) return false;
      const canonical = await this.fs.realpath(directoryPath);
      const key = `${canonical}\0${recursive ? 1 : 0}`;
      let descriptor = descriptors.get(key);
      if (!descriptor) {
        descriptor = {
          key,
          directory: canonical,
          recursive,
          identity: identity(stat),
          guardPaths: new Set(),
          main: false,
        };
        descriptors.set(key, descriptor);
      }
      if (guardPath) descriptor.guardPaths.add(path.join(canonical, path.basename(guardPath)));
      if (main) descriptor.main = true;
      return true;
    };
    const addGuards = async (directoryPath, leafTarget = null) => {
      const chain = ancestors(directoryPath);
      for (let i = 0; i < chain.length; i++) {
        const child = chain[i + 1] || leafTarget;
        if (!child) break;
        if (!(await add(chain[i], false, child))) break;
      }
    };
    if (logical.kind === "file") {
      await addGuards(path.dirname(logical.path), logical.path);
      if (canonicalTarget) {
        await addGuards(path.dirname(canonicalTarget), canonicalTarget);
        await add(path.dirname(canonicalTarget), false, null, true);
      } else {
        // A missing file is still a file. Its parent may itself be missing;
        // the ancestor guards already cover that case without recursive scope.
        await add(path.dirname(logical.path), false, logical.path, true);
      }
    } else {
      await addGuards(logical.path);
      if (canonicalTarget) {
        await addGuards(canonicalTarget);
        await add(canonicalTarget, logical.recursive, null, true);
      }
    }
    const main = [...descriptors.values()].find((descriptor) => descriptor.main);
    const resolvedTarget =
      canonicalTarget ||
      (logical.kind === "file" && main
        ? path.join(main.directory, path.basename(logical.path))
        : null);
    const topology = [
      resolvedTarget,
      [...descriptors.values()].map((descriptor) => [
        descriptor.key,
        descriptor.identity,
        [...descriptor.guardPaths],
        descriptor.main,
      ]),
    ];
    return {
      descriptors,
      stat: targetStat,
      canonicalTarget: resolvedTarget,
      topology: JSON.stringify(topology),
      signature: JSON.stringify([topology, Boolean(targetStat)]),
    };
  }

  acquire(logical, descriptor) {
    let source = this.sources.get(descriptor.key);
    if (!source || source.invalid || source.identity !== descriptor.identity) {
      source = {
        key: descriptor.key,
        path: descriptor.directory,
        identity: descriptor.identity,
        members: new Map(),
        invalid: false,
      };
      source.handle = this.engine.watchDirectory(
        source.path,
        { recursive: descriptor.recursive },
        (message) => this.sourceEvent(source, message),
      );
      this.sources.set(source.key, source);
    }
    source.members.set(logical, descriptor);
    return source;
  }

  async release(logical, source) {
    source.members.delete(logical);
    if (source.members.size) return;
    if (this.sources.get(source.key) === source) this.sources.delete(source.key);
    source.handle.dispose();
    await source.handle.closed;
  }

  sourceEvent(source, message) {
    if (message.type === "invalidate" || message.type === "error") {
      const reason = message.reason || "source-lost";
      const incident =
        message.incident == null
          ? `runtime:${this.incident(reason)}`
          : `native:${message.incident}`;
      source.invalid = true;
      if (this.sources.get(source.key) === source) this.sources.delete(source.key);
      for (const logical of source.members.keys()) {
        if (logical.cancelled) continue;
        if (message.type === "error") {
          this.emit(logical, "error", serializeError(message.error, logical.path));
        }
        logical.invalidation = { reason, incident };
        logical.rebind = true;
        this.schedule(logical);
      }
      return;
    }
    if (message.type !== "changes" || source.invalid) return;
    for (const [logical, descriptor] of source.members) {
      if (logical.cancelled) continue;
      for (const event of message.events) {
        if (
          event.action !== "updated" &&
          [...descriptor.guardPaths].some(
            (guardPath) =>
              guardPath === event.path || guardPath.toLowerCase() === event.path.toLowerCase(),
          )
        ) {
          logical.rebind = true;
          logical.checkFile = true;
        }
        if (!descriptor.main) continue;
        if (logical.kind === "file") {
          if (event.path === logical.plan?.canonicalTarget) {
            logical.checkFile = true;
            logical.contentChanged ||= event.contentChanged === true;
            if (event.action !== "updated") logical.rebind = true;
          }
        } else if (containsPath(descriptor.directory, event.path, logical.recursive)) {
          const relative = relativePath(descriptor.directory, event.path);
          const eventPath = relative ? path.join(logical.path, relative) : logical.path;
          mergeChange(logical.events, { action: event.action, path: eventPath });
          if (logical.events.size > MAX_QUEUED_EVENTS) {
            logical.events.clear();
            logical.invalidation = {
              reason: "subscription-queue-overflow",
              incident: this.incident("subscription-queue-overflow"),
            };
          }
          if (eventPath === logical.path) logical.rebind = true;
        }
      }
      if (logical.rebind || logical.checkFile || logical.events.size) this.schedule(logical);
    }
  }

  emit(logical, type, payload) {
    if (!logical.cancelled) this.sendEvent({ id: logical.id, type, payload });
  }

  incident(reason) {
    // One OS overflow can invalidate several native sources in the same turn.
    // Share the recovery identity so multi-root consumers restart only once.
    let incident = this.pendingIncidents.get(reason);
    if (!incident) {
      incident = ++this.nextIncident;
      this.pendingIncidents.set(reason, incident);
      setImmediate(() => this.pendingIncidents.delete(reason));
    }
    return incident;
  }

  schedule(logical, delay = this.settleDelay) {
    if (logical.cancelled || logical.timer || logical.initializing || logical.processing) return;
    logical.timer = setTimeout(() => {
      logical.timer = null;
      logical.processing = this.update(logical)
        .catch((error) => {
          if (logical.cancelled) return;
          this.emit(logical, "error", serializeError(error, logical.path));
          logical.invalidation = { reason: "source-lost", incident: this.incident("source-lost") };
          logical.rebind = true;
          logical.retry = true;
        })
        .finally(() => {
          logical.processing = null;
          if (!logical.cancelled && (logical.rebind || logical.checkFile || logical.events.size)) {
            const delay = logical.retry ? this.retryDelay : this.settleDelay;
            logical.retry = false;
            this.schedule(logical, delay);
          }
        });
    }, delay);
  }

  async rebind(logical, initial = false) {
    let attempts = 0;
    while (!logical.cancelled) {
      let next;
      const acquired = new Map();
      try {
        next = await this.plan(logical);
        for (const descriptor of next.descriptors.values()) {
          if (logical.cancelled) throw abortError(logical.path);
          const source = this.acquire(logical, descriptor);
          acquired.set(descriptor.key, source);
          // Ancestors arm before their descendants. A second plan after all
          // ready acknowledgements closes creation/rename races during setup.
          await Promise.race([source.handle.ready, logical.cancel.promise]);
        }
        if (logical.cancelled) throw abortError(logical.path);
        const verified = await this.plan(logical);
        if (verified.signature !== next.signature) {
          throw Object.assign(new Error("File watch target changed while arming"), {
            code: "ENOENT",
          });
        }
        const previous = logical.sources;
        logical.sources = acquired;
        const oldPlan = logical.plan;
        logical.plan = verified;
        if (!initial && oldPlan?.topology !== verified.topology) {
          logical.invalidation ||= {
            reason: "target-changed",
            incident: this.incident("target-changed"),
          };
          if (logical.kind === "directory" && Boolean(oldPlan?.stat) !== Boolean(verified.stat)) {
            mergeChange(logical.events, {
              path: logical.path,
              action: verified.stat ? "created" : "deleted",
            });
          }
        }
        await Promise.all(
          [...previous.values()]
            .filter((source) => acquired.get(source.key) !== source)
            .map((source) => this.release(logical, source)),
        );
        return;
      } catch (error) {
        await Promise.all(
          [...acquired.values()]
            .filter((source) => logical.sources.get(source.key) !== source)
            .map((source) => this.release(logical, source)),
        );
        // The filesystem may move between stat, realpath and native startup.
        // Retry its topology, but do not turn permission/resource errors into
        // an apparently armed watcher or spin indefinitely on a busy tree.
        if (!logical.cancelled && MISSING_CODES.has(error.code) && ++attempts < 8) continue;
        throw error;
      }
    }
    throw abortError(logical.path);
  }

  async reconcileFile(logical, initial = false, contentChanged = false) {
    let stat = await this.stat(logical.path);
    if (!stat && logical.fingerprint !== null && !initial) {
      // Editors commonly replace a file via rename. A short second check keeps
      // the transient absence inside one update rather than closing its tab.
      await new Promise((resolve) => {
        logical.missingTimer = setTimeout(resolve, this.settleDelay);
        logical.finishMissing = resolve;
      });
      logical.missingTimer = null;
      logical.finishMissing = null;
      if (logical.cancelled) return;
      stat = await this.stat(logical.path);
    }
    const current = fingerprint(stat);
    if (!initial && (current !== logical.fingerprint || (current !== null && contentChanged))) {
      const action =
        current === null ? "deleted" : logical.fingerprint === null ? "created" : "updated";
      mergeChange(logical.events, { action, path: logical.path });
    }
    logical.fingerprint = current;
  }

  async update(logical) {
    const rebind = logical.rebind;
    const checkFile = logical.checkFile;
    const contentChanged = logical.contentChanged;
    logical.rebind = false;
    logical.checkFile = false;
    logical.contentChanged = false;
    if (rebind) await this.rebind(logical);
    if (logical.cancelled) return;
    if (logical.kind === "file" && (rebind || checkFile))
      await this.reconcileFile(logical, false, contentChanged);
    if (logical.cancelled) return;
    if (logical.invalidation) {
      const invalidation = logical.invalidation;
      logical.invalidation = null;
      this.emit(logical, "invalidate", { path: logical.path, ...invalidation });
    }
    if (logical.events.size) {
      const events = [...logical.events.values()];
      logical.events.clear();
      this.emit(logical, "changes", events);
    }
  }

  subscribe({ id, kind, path: targetPath, recursive = false }) {
    if (this.closed) return Promise.reject(new Error("The file watch worker is closed"));
    if (this.subscriptions.has(id)) return Promise.reject(new Error("Duplicate subscription id"));
    const logical = {
      id,
      kind,
      path: absolutePath(targetPath),
      recursive,
      sources: new Map(),
      events: new Map(),
      fingerprint: null,
      rebind: false,
      checkFile: false,
      invalidation: null,
      initializing: true,
      cancelled: false,
      cancel: deferred(),
    };
    this.subscriptions.set(id, logical);
    logical.ready = (async () => {
      try {
        await this.rebind(logical, true);
        if (kind === "file") await this.reconcileFile(logical, true);
        if (logical.cancelled) throw abortError(logical.path);
        logical.initializing = false;
        // Mutations arriving while we armed the last source still need to be
        // reconciled. Never reset these dirty flags at the end of startup.
        if (logical.rebind || logical.checkFile || logical.events.size || logical.invalidation) {
          this.schedule(logical);
        }
      } catch (error) {
        logical.cancelled = true;
        await this.releaseAll(logical);
        this.subscriptions.delete(id);
        throw error;
      }
    })();
    return logical.ready;
  }

  async releaseAll(logical) {
    clearTimeout(logical.timer);
    clearTimeout(logical.missingTimer);
    logical.finishMissing?.();
    const sources = [...logical.sources.values()];
    logical.sources.clear();
    await Promise.all(sources.map((source) => this.release(logical, source)));
  }

  unsubscribe(id) {
    const logical = this.subscriptions.get(id);
    if (!logical) return Promise.resolve();
    if (logical.closed) return logical.closed;
    logical.cancelled = true;
    logical.cancel.reject(abortError(logical.path));
    clearTimeout(logical.timer);
    clearTimeout(logical.missingTimer);
    logical.finishMissing?.();
    logical.events.clear();
    // Cancel pending native arms too; waiting for ready before cancelling
    // would deadlock dispose-before-ready on an unavailable native source.
    for (const source of this.sources.values()) {
      if (source.members.has(logical) && source.members.size === 1) source.handle.dispose();
    }
    logical.closed = (async () => {
      await logical.ready.catch(() => {});
      await logical.processing;
      await this.releaseAll(logical);
      this.subscriptions.delete(id);
    })();
    return logical.closed;
  }

  diagnostics() {
    return {
      rssBytes: process.memoryUsage().rss,
      subscriptions: this.subscriptions.size,
      sources: [...this.sources.values()].map((source) => ({
        path: source.path,
        subscribers: source.members.size,
        recursive: [...source.members.values()][0]?.recursive || false,
      })),
    };
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.all([...this.subscriptions.keys()].map((id) => this.unsubscribe(id)));
      await this.engine.close();
    })();
    return this.closing;
  }
}

module.exports = FileWatchWorker;
