const { CompositeDisposable } = require("@lumine-code/event-kit");

// One owner for path rebinding, discovery, retention and initial readiness.
// Rendering subscribers keep their own snapshot fanout and scheduling.
module.exports = class RepositoryPathObserver {
  constructor(registry, getPath, callback, { onDidChangePath, snapshots = "none" } = {}) {
    if (typeof getPath !== "function" || typeof callback !== "function") {
      throw new TypeError("Path observation requires a path getter and callback");
    }
    if (!["none", "status", "refs", "both"].includes(snapshots)) {
      throw new TypeError("Unknown repository snapshot selection");
    }
    this.registry = registry;
    this.getPath = getPath;
    this.callback = callback;
    this.snapshots = snapshots;
    this.generation = 0;
    this.disposed = false;
    this.current = null;
    this.path = undefined;
    this.ready = false;
    this.edge = new CompositeDisposable();
    this.subscriptions = new CompositeDisposable(registry.onDidChange(() => this.update(false)));
    if (onDidChangePath) this.subscriptions.add(onDidChangePath(() => this.update(true)));
    this.update(true);
  }

  update(discover) {
    if (this.disposed || this.registry.destroyed) return;
    const filePath = this.getPath() || null;
    const changedPath = filePath !== this.path;
    const cached = filePath ? this.registry.getForPath(filePath) : null;
    if (
      !discover &&
      !changedPath &&
      cached === this.current &&
      this.ready &&
      !cached?.isDestroyed?.()
    )
      return;
    const generation = ++this.generation;
    this.bind(cached, filePath, generation, !filePath || Boolean(cached));
    if (!filePath || (!discover && cached)) return;
    void this.registry.resolveForPath(filePath, { refresh: false }).then(
      (repository) => {
        if (!this.isCurrent(generation, filePath)) return;
        this.bind(repository, filePath, generation, true);
      },
      (error) => {
        if (this.isCurrent(generation, filePath))
          this.notify(this.current, { path: filePath, ready: false, error });
      },
    );
  }

  isCurrent(generation, filePath) {
    return (
      !this.disposed && generation === this.generation && filePath === (this.getPath() || null)
    );
  }

  bind(repository, filePath, generation, resolved) {
    if (!this.isCurrent(generation, filePath)) return;
    if (repository?.isDestroyed?.()) repository = null;
    const same = repository === this.current && filePath === this.path;
    if (same && this.ready) return;
    if (!same) {
      const previous = this.edge;
      this.readinessSubscriptions = null;
      const next = new CompositeDisposable();
      this.edge = next;
      this.current = repository;
      this.path = filePath;
      this.ready = false;
      if (repository) {
        next.add(this.registry.retain(repository, "path-observer"));
        next.add(repository.onDidDestroy(() => this.update(true)));
      }
      previous.dispose();
    }
    if (!this.isCurrent(generation, filePath) || this.current !== repository) return;
    const needsStatus = this.snapshots === "status" || this.snapshots === "both";
    const needsRefs = this.snapshots === "refs" || this.snapshots === "both";
    const initialized =
      (!repository && resolved) ||
      Boolean(
        repository &&
        (!needsStatus || repository.getStatusSnapshot?.().initialized) &&
        (!needsRefs || repository.getRefsSnapshot?.().initialized),
      );
    if (!same || initialized !== this.ready) {
      this.ready = Boolean(initialized);
      this.notify(repository, { path: filePath, ready: this.ready });
    }
    if (!this.isCurrent(generation, filePath) || this.current !== repository) return;
    if (!repository || initialized) {
      this.readinessSubscriptions?.dispose();
      this.readinessSubscriptions = null;
      return;
    }
    if (!this.readinessSubscriptions) {
      this.readinessSubscriptions = new CompositeDisposable();
      const reconsider = () => {
        if (!this.disposed && this.current === repository && !this.ready) {
          this.bind(repository, this.path, this.generation, true);
        }
      };
      if (needsStatus && repository.onDidChangeStatusSnapshot)
        this.readinessSubscriptions.add(repository.onDidChangeStatusSnapshot(reconsider));
      if (needsRefs && repository.onDidChangeRefsSnapshot)
        this.readinessSubscriptions.add(repository.onDidChangeRefsSnapshot(reconsider));
      this.edge.add(this.readinessSubscriptions);
    }
    const waiters = [];
    if (needsStatus) waiters.push(repository.ensureStatusSnapshot());
    if (needsRefs) waiters.push(repository.ensureRefsSnapshot());
    void Promise.all(waiters).then(
      () => {
        if (!this.isCurrent(generation, filePath) || this.current !== repository || this.ready)
          return;
        this.ready = true;
        this.readinessSubscriptions?.dispose();
        this.readinessSubscriptions = null;
        this.notify(repository, { path: filePath, ready: true });
      },
      (error) => {
        if (this.isCurrent(generation, filePath) && this.current === repository) {
          this.notify(repository, { path: filePath, ready: false, error });
        }
      },
    );
  }

  notify(repository, context) {
    try {
      this.callback(repository, Object.freeze(context));
    } catch (error) {
      console.error("Repository path observer failed", error);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.subscriptions.dispose();
    this.edge.dispose();
    this.readinessSubscriptions = null;
    this.current = null;
  }
};
