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
const { createFileWatchTrace, summarizeFileWatchPayload } = require("./file-watch-trace");

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function fingerprint(stat) {
  return stat ? `${identity(stat)}:${stat.size}:${stat.mtimeNs ?? stat.mtimeMs}` : null;
}

function sourceKey(directory, recursive, guard) {
  return `${directory}\0${recursive ? 1 : 0}\0${guard ? 1 : 0}`;
}

/** Logical fixed-path subscriptions and canonical directory source pooling. */
class FileWatchWorker {
  constructor({
    engine,
    sendEvent,
    filesystem = fs.promises,
    platform = process.platform,
    settleDelay = 35,
    retryDelay = 30000,
  }) {
    this.engine = engine;
    this.sendEvent = sendEvent;
    this.fs = filesystem;
    this.platform = platform;
    this.settleDelay = settleDelay;
    this.retryDelay = retryDelay;
    this.sources = new Map();
    this.subscriptions = new Map();
    this.nextIncident = 0;
    this.pendingIncidents = new Map();
    this.planningReads = new Map();
    this.closed = false;
    this.trace = createFileWatchTrace("worker");
  }

  planningFilesystem() {
    const filesystem = {};
    for (const method of ["stat", "lstat", "realpath", "readlink"]) {
      filesystem[method] = (targetPath, ...options) => {
        const key = `${method}\0${targetPath}`;
        let pending = this.planningReads.get(key);
        if (!pending) {
          pending = Promise.resolve().then(() => this.fs[method](targetPath, ...options));
          this.planningReads.set(key, pending);
          const forget = () => {
            if (this.planningReads.get(key) === pending) this.planningReads.delete(key);
          };
          pending.then(forget, forget);
        }
        return pending;
      };
    }
    return filesystem;
  }

  async stat(targetPath, filesystem = this.fs) {
    try {
      return await filesystem.stat(targetPath, { bigint: true });
    } catch (error) {
      if (MISSING_CODES.has(error.code)) return null;
      throw error;
    }
  }

  waitFor(logical, operation) {
    const { signal } = logical.cancel;
    let cancel;
    return new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve(operation).then(resolve, reject);
      if (signal.aborted) cancel();
    }).finally(() => signal.removeEventListener("abort", cancel));
  }

  async resolveTarget(targetPath, filesystem = this.fs) {
    const links = [];
    let current = path.parse(targetPath).root;
    let components = targetPath.slice(current.length).split(path.sep).filter(Boolean);
    let followed = 0;
    while (components.length) {
      const component = components.shift();
      if (component === ".") continue;
      if (component === "..") {
        current = path.dirname(current);
        continue;
      }
      const entry = path.join(current, component);
      let stat;
      try {
        stat = await filesystem.lstat(entry, { bigint: true });
      } catch (error) {
        if (!MISSING_CODES.has(error.code)) throw error;
        // realpath on the complete target cannot resolve a dangling link.
        // Keep the missing suffix after the last existing, resolved component.
        return {
          path: path.join(await filesystem.realpath(current), component, ...components),
          stat: null,
          links,
        };
      }
      if (stat.isSymbolicLink()) {
        if (++followed > 40) {
          throw Object.assign(new Error(`Too many symbolic links: ${targetPath}`), {
            code: "ELOOP",
            path: targetPath,
          });
        }
        const parent = await filesystem.realpath(current);
        const target = await filesystem.readlink(entry);
        links.push({
          path: path.join(parent, component),
          parent,
          target,
          identity: identity(stat),
        });
        const normalizedTarget = path.sep === "\\" ? target.replaceAll("/", "\\") : target;
        const root = path.parse(normalizedTarget).root;
        current = root ? path.resolve(parent, root) : parent;
        // Keep dot segments until traversal: a preceding symbolic component
        // may change what `..` means, so path.resolve(target) here is unsafe.
        components = normalizedTarget
          .slice(root.length)
          .split(path.sep)
          .filter(Boolean)
          .concat(components);
      } else {
        current = entry;
        if (components.length && !stat.isDirectory()) {
          const blockedPath = await filesystem.realpath(current);
          return { path: path.join(blockedPath, ...components), stat: null, links, blockedPath };
        }
        if (!components.length) {
          return { path: await filesystem.realpath(current), stat, links };
        }
      }
    }
    return {
      path: await filesystem.realpath(current),
      stat: await this.stat(current, filesystem),
      links,
    };
  }

  async nearestDirectory(targetPath, filesystem = this.fs) {
    let current = targetPath;
    while (true) {
      if ((await this.stat(current, filesystem))?.isDirectory())
        return filesystem.realpath(current);
      const parent = path.dirname(current);
      if (parent === current) {
        throw Object.assign(new Error(`No existing directory for ${targetPath}`), {
          code: "ENOENT",
          path: targetPath,
        });
      }
      current = parent;
    }
  }

  async plan(logical, coalesce = false) {
    const filesystem = coalesce ? this.planningFilesystem() : this.fs;
    const resolution = await this.resolveTarget(logical.path, filesystem);
    const targetStat = resolution.stat;
    if (targetStat && targetStat.isDirectory() !== (logical.kind === "directory")) {
      throw Object.assign(new Error(`Expected a ${logical.kind}: ${logical.path}`), {
        code: logical.kind === "directory" ? "ENOTDIR" : "EISDIR",
        path: logical.path,
      });
    }
    const canonicalTarget = resolution.path;
    const guardTarget = resolution.blockedPath || canonicalTarget;
    const descriptors = new Map();
    const add = async (directoryPath, recursive, guardPath, main = false, guard = false) => {
      const stat = await this.stat(directoryPath, filesystem);
      if (!stat?.isDirectory()) return false;
      const canonical = await filesystem.realpath(directoryPath);
      const key = sourceKey(canonical, recursive, guard);
      let descriptor = descriptors.get(key);
      if (!descriptor) {
        descriptor = {
          key,
          directory: canonical,
          recursive,
          guard,
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
    if (this.platform === "darwin") {
      // FSEvents WatchRoot detects relocation of an ordinary source. Watching
      // every ancestor would create a volume-wide FSEvents stream at `/`.
      // Only symbolic-link entries and missing-target anchors need separate
      // vnode guards, whose events describe directory membership, not content.
      for (const link of resolution.links) await add(link.parent, false, link.path, false, true);
      if (!targetStat) {
        const anchor = await this.nearestDirectory(path.dirname(guardTarget), filesystem);
        const relative = relativePath(anchor, guardTarget);
        const child = path.join(anchor, relative.split(path.sep)[0]);
        await add(anchor, false, child, false, true);
      }
    } else {
      // Every traversed link matters, including links in a target chain that
      // are outside both the original alias and the final resolved target.
      for (const link of resolution.links) await addGuards(link.parent, link.path);
      if (logical.kind === "file" || resolution.blockedPath)
        await addGuards(path.dirname(guardTarget), guardTarget);
      else await addGuards(guardTarget);
    }
    if (logical.kind === "file") {
      if (targetStat || (this.platform !== "darwin" && !resolution.blockedPath)) {
        await add(path.dirname(canonicalTarget), false, null, true);
      }
    } else if (targetStat) {
      await add(canonicalTarget, logical.recursive, null, true);
    }
    // A main shallow source already observes membership at its own root.
    // Reuse it for link-entry guards requested by this same subscription.
    for (const [key, descriptor] of descriptors) {
      if (!descriptor.guard) continue;
      const main = [...descriptors.values()].find(
        (candidate) =>
          candidate.main && !candidate.recursive && candidate.directory === descriptor.directory,
      );
      if (!main) continue;
      for (const guardedPath of descriptor.guardPaths) main.guardPaths.add(guardedPath);
      descriptors.delete(key);
    }
    const topology = [
      canonicalTarget,
      resolution.blockedPath || null,
      resolution.links.map(({ path: linkPath, target, identity }) => [linkPath, target, identity]),
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
      canonicalTarget,
      topology: JSON.stringify(topology),
      signature: JSON.stringify([topology, Boolean(targetStat)]),
    };
  }

  refreshMember(logical, source) {
    const descriptors = new Map([
      ...(logical.bindings.get(source) || []),
      ...(logical.acquiring?.bindings.get(source) || []),
    ]);
    const bindings = new Map();
    for (const [key, descriptor] of descriptors) {
      const guardPaths = new Set(descriptor.guardPaths);
      if (source.recursive && descriptor.directory !== source.path) {
        // The physical parent receives relocation events for descendant
        // ancestors instead of a descendant stream's RootChanged signal.
        let current = source.path;
        for (const component of relativePath(source.path, descriptor.directory).split(path.sep)) {
          current = path.join(current, component);
          guardPaths.add(current);
        }
      }
      bindings.set(key, { ...descriptor, guardPaths });
    }
    if (bindings.size) source.members.set(logical, bindings);
    else source.members.delete(logical);
  }

  async coveringSource(logical, descriptor, excluded) {
    // Canonical ancestor keys avoid scanning every native source for each
    // descriptor, including fleets of unrelated fixed-file subscriptions.
    const candidates = ancestors(descriptor.directory)
      .map((directory) => this.sources.get(sourceKey(directory, true, false)))
      .filter(
        (source) =>
          source?.recursive &&
          source !== excluded &&
          !source.guard &&
          !source.invalid &&
          containsPath(source.path, descriptor.directory, true) &&
          (source.path !== descriptor.directory || source.identity === descriptor.identity),
      );
    for (const source of candidates) {
      const read = this.stat(source.path, this.planningFilesystem());
      const stat = logical ? await this.waitFor(logical, read) : await read;
      if (
        stat?.isDirectory() &&
        identity(stat) === source.identity &&
        !source.invalid &&
        this.sources.get(source.key) === source
      )
        return source;
    }
    return null;
  }

  async acquire(logical, descriptor) {
    const covering = await this.coveringSource(logical, descriptor);
    let source = covering || this.sources.get(descriptor.key);
    if (logical.cancelled) throw abortError(logical.path);
    if (!source || source.invalid || (!covering && source.identity !== descriptor.identity)) {
      source = {
        key: descriptor.key,
        path: descriptor.directory,
        identity: descriptor.identity,
        recursive: descriptor.recursive,
        guard: descriptor.guard,
        members: new Map(),
        ready: deferred(),
        armed: false,
        invalid: false,
      };
      this.trace?.("source-open", { id: logical.id, path: logical.path, source: descriptor });
      source.handle = this.engine.watchDirectory(
        source.path,
        { recursive: descriptor.recursive, guard: descriptor.guard },
        (message) => this.sourceEvent(source, message),
      );
      this.sources.set(source.key, source);
      source.handle.ready
        .then(async () => {
          source.armed = true;
          // A parent can finish arming while an earlier descendant lookup is
          // still in flight. Recheck after native readiness to adopt that late
          // source before its logical subscribers are acknowledged as ready.
          const parent = await this.coveringSource(
            null,
            { directory: source.path, identity: source.identity },
            source,
          );
          if (parent?.armed && !source.invalid) await this.consolidate(parent);
          else await this.consolidate(source);
          if (!source.coveredBy) source.ready.resolve();
        })
        .catch((error) => {
          if (!source.coveredBy) source.ready.reject(error);
        });
    }
    this.addBinding(logical, source, descriptor);
    return source;
  }

  addBinding(logical, source, descriptor) {
    const attempt = logical.acquiring;
    let bindings = attempt.bindings.get(source);
    if (!bindings) attempt.bindings.set(source, (bindings = new Map()));
    bindings.set(descriptor.key, descriptor);
    attempt.sources.set(source.key, source);
    this.refreshMember(logical, source);
  }

  async consolidate(parent) {
    if (
      !parent.armed ||
      !parent.recursive ||
      parent.guard ||
      parent.invalid ||
      !parent.members.size ||
      this.sources.get(parent.key) !== parent
    )
      return;
    const stat = await this.stat(parent.path);
    if (!stat?.isDirectory() || identity(stat) !== parent.identity) {
      throw Object.assign(new Error("File watch covering root changed before migration"), {
        code: "ENOENT",
      });
    }
    if (parent.invalid || !parent.members.size || this.sources.get(parent.key) !== parent) return;
    const closing = [];
    for (const source of [...this.sources.values()]) {
      if (
        source === parent ||
        source.invalid ||
        !containsPath(parent.path, source.path, true) ||
        (source.path === parent.path && source.identity !== parent.identity)
      )
        continue;
      // The parent is armed before ownership moves. Retire the old generation
      // before cancellation can report ABORT_ERR or deliver a queued callback.
      source.invalid = true;
      source.coveredBy = parent;
      if (this.sources.get(source.key) === source) this.sources.delete(source.key);
      for (const logical of source.members.keys()) {
        for (const owner of [logical, logical.acquiring].filter(Boolean)) {
          if (owner.sources.get(source.key) !== source) continue;
          owner.sources.delete(source.key);
          owner.sources.set(parent.key, parent);
          const previous = owner.bindings.get(source);
          owner.bindings.delete(source);
          owner.bindings.set(
            parent,
            new Map([...(owner.bindings.get(parent) || []), ...(previous || [])]),
          );
        }
        this.refreshMember(logical, parent);
      }
      source.members.clear();
      // Pending descendants can become ready through this armed parent even
      // when cancellation rejects their original native readiness promise.
      source.handle.dispose();
      const retired = Promise.all([source.handle.closed, source.retiredClosed]);
      Promise.all([parent.ready.promise, retired]).then(source.ready.resolve, source.ready.reject);
      closing.push(retired);
    }
    // Awaiting the new parent's ready is also a relocation barrier on Windows:
    // no retired descendant directory handles remain open after it resolves.
    parent.retiredClosed = Promise.all([parent.retiredClosed, ...closing]);
    await parent.retiredClosed;
  }

  async release(logical, source) {
    source.members.delete(logical);
    if (source.members.size) return;
    this.trace?.("source-close-start", {
      id: logical.id,
      path: logical.path,
      sourcePath: source.path,
    });
    source.invalid = true;
    if (this.sources.get(source.key) === source) this.sources.delete(source.key);
    source.handle.dispose();
    await Promise.all([source.handle.closed, source.retiredClosed]);
    this.trace?.("source-close-done", {
      id: logical.id,
      path: logical.path,
      sourcePath: source.path,
    });
  }

  sourceEvent(source, message) {
    this.trace?.("native-event", {
      sourcePath: source.path,
      sourceKey: source.key,
      invalid: source.invalid,
      subscriptions: [...source.members].map(([logical, bindings]) => ({
        id: logical.id,
        path: logical.path,
        canonicalTarget: logical.plan?.canonicalTarget,
        bindings: [...bindings.values()].map((descriptor) => ({
          directory: descriptor.directory,
          main: descriptor.main,
          guard: descriptor.guard,
          recursive: descriptor.recursive,
          guardPaths: [...descriptor.guardPaths],
        })),
        cancelled: logical.cancelled,
      })),
      type: message.type,
      reason: message.reason,
      error: message.error,
      ...summarizeFileWatchPayload(message.events || []),
    });
    if (source.coveredBy) return;
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
    if (message.type === "guard" && !source.invalid) {
      for (const logical of source.members.keys()) {
        if (logical.cancelled) continue;
        logical.rebind = true;
        logical.checkFile = true;
        this.schedule(logical);
      }
      return;
    }
    if (message.type !== "changes" || source.invalid) return;
    for (const [logical, bindings] of source.members) {
      if (logical.cancelled) continue;
      const descriptors = [...bindings.values()];
      const main = descriptors.filter((descriptor) => descriptor.main);
      const guardPaths = descriptors.flatMap((descriptor) => [...descriptor.guardPaths]);
      for (const event of message.events) {
        if (
          event.action !== "updated" &&
          guardPaths.some(
            (guardPath) =>
              guardPath === event.path || guardPath.toLowerCase() === event.path.toLowerCase(),
          )
        ) {
          logical.rebind = true;
          logical.checkFile = true;
        }
        if (logical.kind === "file") {
          if (main.length && event.path === logical.plan?.canonicalTarget) {
            logical.checkFile = true;
            if (event.contentChanged === true) {
              logical.contentVersion = (logical.contentVersion || 0) + 1;
              logical.contentChanged = true;
            }
            if (event.action !== "updated") logical.rebind = true;
          }
        } else {
          const descriptor = main.find((binding) =>
            containsPath(binding.directory, event.path, logical.recursive),
          );
          if (!descriptor) continue;
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
      if (logical.rebind || logical.checkFile || logical.events.size || logical.invalidation)
        this.schedule(logical);
    }
  }

  emit(logical, type, payload) {
    this.trace?.("emit", {
      id: logical.id,
      path: logical.path,
      type,
      cancelled: logical.cancelled,
      payload: summarizeFileWatchPayload(payload),
    });
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
    this.trace?.("schedule", {
      id: logical.id,
      path: logical.path,
      delay,
      existingTimer: Boolean(logical.timer),
      processing: Boolean(logical.processing),
      initializing: logical.initializing,
      rebind: logical.rebind,
      checkFile: logical.checkFile,
      contentChanged: logical.contentChanged,
      invalidation: logical.invalidation,
      pending: [...logical.events.values()],
    });
    if (logical.timer && delay < logical.timerDelay) {
      // Fresh topology evidence should not wait out a previous permission or
      // broken-link retry backoff. Ordinary event coalescing keeps its timer.
      clearTimeout(logical.timer);
      logical.timer = null;
      this.trace?.("timer-fired", { id: logical.id, path: logical.path });
    }
    if (logical.cancelled || logical.timer || logical.initializing || logical.processing) return;
    logical.timerDelay = delay;
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
          if (
            !logical.cancelled &&
            (logical.rebind || logical.checkFile || logical.events.size || logical.invalidation)
          ) {
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
      const bindings = new Map();
      const attempt = { sources: acquired, bindings };
      logical.acquiring = attempt;
      try {
        // Share only concurrent preliminary reads. The verification below
        // must start fresh after every source is armed, so an earlier read
        // can never hide a topology change in the observation gap.
        next = await this.waitFor(logical, this.plan(logical, true));
        this.trace?.("rebind-plan", {
          id: logical.id,
          path: logical.path,
          initial,
          exists: Boolean(next.stat),
          canonicalTarget: next.canonicalTarget,
          sources: [...next.descriptors.values()].map((source) => ({
            ...source,
            guardPaths: [...source.guardPaths],
          })),
        });
        for (const descriptor of next.descriptors.values()) {
          if (logical.cancelled) throw abortError(logical.path);
          const source = await this.waitFor(logical, this.acquire(logical, descriptor));
          // Ancestors arm before their descendants. A second plan after all
          // ready acknowledgements closes creation/rename races during setup.
          await this.waitFor(logical, source.ready.promise);
        }
        if (logical.cancelled) throw abortError(logical.path);
        const verified = await this.waitFor(logical, this.plan(logical));
        this.trace?.("rebind-verified", {
          id: logical.id,
          path: logical.path,
          initial,
          exists: Boolean(verified.stat),
          canonicalTarget: verified.canonicalTarget,
          matches: verified.signature === next.signature,
          topologyChanged: logical.plan?.topology !== verified.topology,
        });
        if (verified.signature !== next.signature) {
          throw Object.assign(new Error("File watch target changed while arming"), {
            code: "ENOENT",
          });
        }
        for (const source of acquired.values()) {
          // A physical recursive ancestor need not occur in the logical plan.
          // Check its own root after arming, using a fresh metadata read.
          const verifiedRoot = [...verified.descriptors.values()].find(
            (descriptor) => descriptor.directory === source.path,
          );
          if (verifiedRoot?.identity === source.identity && !source.invalid) continue;
          const stat = await this.waitFor(logical, this.stat(source.path));
          if (!stat?.isDirectory() || identity(stat) !== source.identity || source.invalid) {
            throw Object.assign(new Error("File watch covering root changed while arming"), {
              code: "ENOENT",
            });
          }
        }
        const previous = logical.sources;
        logical.sources = acquired;
        logical.bindings = bindings;
        logical.acquiring = null;
        for (const source of acquired.values()) this.refreshMember(logical, source);
        const oldPlan = logical.plan;
        logical.plan = verified;
        if (!initial && oldPlan?.topology !== verified.topology) {
          logical.invalidation ||= {
            reason: "target-changed",
            incident: this.incident("target-changed"),
          };
          if (logical.kind === "directory" && Boolean(oldPlan?.stat) !== Boolean(verified.stat)) {
            // A covered directory can receive timestamp updates while its new
            // main binding is being verified. Its known missing/present state
            // determines the root transition before those incidental updates.
            logical.events.set(logical.path, {
              path: logical.path,
              action: verified.stat ? "created" : "deleted",
            });
          } else if (
            logical.kind === "directory" &&
            verified.stat &&
            logical.events.get(logical.path)?.action === "deleted"
          ) {
            // On a case-insensitive volume the old spelling still names the
            // directory after a rename. Report activity on that fixed path
            // without claiming that its still-present root was deleted.
            logical.events.set(logical.path, { path: logical.path, action: "updated" });
          }
        }
        await Promise.all(
          [...previous.values()]
            .filter((source) => acquired.get(source.key) !== source)
            .map((source) => this.release(logical, source)),
        );
        return;
      } catch (error) {
        if (logical.acquiring === attempt) logical.acquiring = null;
        this.trace?.("rebind-error", {
          id: logical.id,
          path: logical.path,
          initial,
          error: serializeError(error),
        });
        await Promise.all(
          [...acquired.values()].map((source) => {
            if (logical.sources.get(source.key) !== source) return this.release(logical, source);
            this.refreshMember(logical, source);
          }),
        );
        // The filesystem may move between stat, realpath and native startup.
        // Retry its topology, but do not turn permission/resource errors into
        // an apparently armed watcher or spin indefinitely on a busy tree.
        if (!logical.cancelled && MISSING_CODES.has(error.code) && ++attempts < 8) continue;
        throw error;
      } finally {
        if (logical.acquiring === attempt) logical.acquiring = null;
      }
    }
    throw abortError(logical.path);
  }

  async reconcileFile(logical, initial = false, contentChanged = false) {
    const contentVersion = logical.contentVersion || 0;
    let stat = await this.waitFor(logical, this.stat(logical.path));
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
      stat = await this.waitFor(logical, this.stat(logical.path));
    }
    const current = fingerprint(stat);
    this.trace?.("file-stat", {
      id: logical.id,
      path: logical.path,
      initial,
      before: logical.fingerprint,
      after: current,
      contentChanged,
      contentVersionBefore: contentVersion,
      contentVersionAfter: logical.contentVersion,
      plannedExists: Boolean(logical.plan?.stat),
    });
    if (initial && contentVersion === (logical.contentVersion || 0)) {
      // A content hint received before the baseline stat is already covered
      // by that initial read. Keep hints arriving during the stat operation:
      // their write may not be represented by its returned metadata.
      logical.contentChanged = false;
    }
    // Native backends distinguish reads from content activity. Trust their
    // content hints even when a write preserves size/mtime or also changes
    // atime; a second metadata heuristic here can discard genuine writes.
    if (!initial && (current !== logical.fingerprint || (current !== null && contentChanged))) {
      const action =
        current === null ? "deleted" : logical.fingerprint === null ? "created" : "updated";
      mergeChange(logical.events, { action, path: logical.path });
    }
    logical.fingerprint = current;
  }

  async update(logical) {
    this.trace?.("update-start", {
      id: logical.id,
      path: logical.path,
      rebind: logical.rebind,
      checkFile: logical.checkFile,
      contentChanged: logical.contentChanged,
      invalidation: logical.invalidation,
    });
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
    if (logical.kind === "file" && Boolean(logical.plan?.stat) !== (logical.fingerprint !== null)) {
      // Creation/deletion can race the verified topology while old sources
      // are draining. Publish its change only after the matching content or
      // missing-target source is armed; a second handoff invalidation must
      // not erase that change while the renderer is acknowledging the first.
      logical.rebind = true;
      this.trace?.("handoff-deferred", {
        id: logical.id,
        path: logical.path,
        plannedExists: Boolean(logical.plan?.stat),
        currentExists: logical.fingerprint !== null,
        pending: [...logical.events.values()],
      });
      return;
    }
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
      bindings: new Map(),
      events: new Map(),
      fingerprint: null,
      rebind: false,
      checkFile: false,
      invalidation: null,
      initializing: true,
      cancelled: false,
      cancel: new AbortController(),
    };
    this.subscriptions.set(id, logical);
    this.trace?.("subscribe", { id, path: logical.path, kind, recursive });
    logical.ready = (async () => {
      try {
        await this.rebind(logical, true);
        if (kind === "file") await this.reconcileFile(logical, true);
        if (logical.cancelled) throw abortError(logical.path);
        logical.initializing = false;
        this.trace?.("ready", {
          id,
          path: logical.path,
          rebind: logical.rebind,
          checkFile: logical.checkFile,
          fingerprint: logical.fingerprint,
          invalidation: logical.invalidation,
        });
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
    logical.bindings.clear();
    await Promise.all(sources.map((source) => this.release(logical, source)));
  }

  unsubscribe(id) {
    const logical = this.subscriptions.get(id);
    if (!logical) return Promise.resolve();
    this.trace?.("unsubscribe", { id, path: logical.path, cancelled: logical.cancelled });
    if (logical.closed) return logical.closed;
    logical.cancelled = true;
    logical.cancel.abort(abortError(logical.path));
    clearTimeout(logical.timer);
    clearTimeout(logical.missingTimer);
    logical.finishMissing?.();
    logical.events.clear();
    // Cancel pending native arms too; waiting for ready before cancelling
    // would deadlock dispose-before-ready on an unavailable native source.
    for (const source of this.sources.values()) {
      if (source.members.has(logical) && source.members.size === 1) {
        // ready stays fulfilled after a running source begins closing. Remove
        // it from the pool before cancellation so another logical subscriber
        // cannot borrow that promise and appear armed on the dying source.
        source.invalid = true;
        if (this.sources.get(source.key) === source) this.sources.delete(source.key);
        this.trace?.("source-retired", { id, path: logical.path, sourcePath: source.path });
        source.handle.dispose();
      }
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
        recursive: source.recursive,
        guard: source.guard,
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
