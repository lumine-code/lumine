const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");

/**
 * @public
 * @status extended
 *
 * History manager for remembering which projects have been opened.
 *
 * An instance of this class is always available as the `lumine.history` global.
 *
 * The project history is used to populate recent project lists.
 */
class HistoryManager {
  constructor({ project, commands, stateStore }) {
    this.stateStore = stateStore;
    this.emitter = new Emitter();
    this.projects = [];
    this.confirmedProjects = [];
    this.pendingMutations = [];
    this.operationPromise = Promise.resolve();
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      commands.add(
        "lumine-workspace",
        {
          "application:clear-project-history": {
            description: "Forget the projects offered by the Reopen Project menu.",
            actionScope: "list",
            didDispatch: this.clearProjects.bind(this),
          },
        },
        false,
      ),
    );
    this.disposables.add(
      project.onDidChangePaths((projectPaths) => {
        // This event has no caller to await the write. Observe its failure while
        // keeping direct history actions' rejection available to their callers.
        this.addProject(projectPaths).catch((error) => {
          console.warn("Unable to save recent project history", error);
        });
      }),
    );
  }

  destroy() {
    this.disposables.dispose();
  }

  /**
   * @public
   * @status public
   *
   * Obtain a list of previously opened projects.
   *
   * @returns {Array} of detached `HistoryProject` objects, most recent first. Their paths and dates can be changed without modifying history.
   */
  getProjects() {
    return this.projects.map((p) => new HistoryProject(p.paths, p.lastOpened));
  }

  /**
   * @public
   * @status public
   *
   * Clear all projects from the history.
   *
   * Note: This is not a privacy function - other traces will still exist,
   * e.g. window state.
   *
   * @returns {Promise} that resolves when the history has been successfully cleared.
   */
  clearProjects() {
    return this.mutateProjects({ type: "clear" });
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback when the list of projects changes.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeProjects(callback) {
    return this.emitter.on("did-change-projects", callback);
  }

  didChangeProjects(args = { reloaded: false }) {
    this.emitter.emit("did-change-projects", args);
  }

  async addProject(paths, lastOpened) {
    if (paths.length === 0) return;
    return this.mutateProjects({
      type: "add",
      paths: paths.slice(),
      lastOpened: new Date(lastOpened || Date.now()),
    });
  }

  async removeProject(paths) {
    if (paths.length === 0) return;

    return this.mutateProjects({ type: "remove", paths: paths.slice() });
  }

  getProject(paths) {
    for (let i = 0; i < this.projects.length; i++) {
      if (arrayEquivalent(paths, this.projects[i].paths)) {
        return this.projects[i];
      }
    }

    return null;
  }

  loadState() {
    return this.queueOperation(async () => {
      const history = await this.stateStore.load("history-manager");
      this.confirmedProjects = deserializeProjects(history);
      this.reapplyPendingMutations();
      this.didChangeProjects({ reloaded: true });
    });
  }

  saveState(mutation) {
    return this.stateStore.update("history-manager", (history) => ({
      projects: applyMutation(deserializeProjects(history), mutation).map((p) => ({
        paths: p.paths.slice(),
        lastOpened: new Date(p.lastOpened),
      })),
    }));
  }

  mutateProjects(mutation) {
    this.pendingMutations.push(mutation);
    // Project-path listeners observe their addition in the same call stack.
    this.projects = applyMutation(this.projects, mutation);
    // Capture this seam while the operation is requested: the spec runner
    // stubs saveState to protect real history, including deferred operations.
    const saveState = this.saveState.bind(this);
    return this.queueOperation(async () => {
      let history;
      try {
        history = await saveState(mutation);
      } catch (error) {
        this.pendingMutations.splice(this.pendingMutations.indexOf(mutation), 1);
        this.reapplyPendingMutations();
        this.didChangeProjects({ reloaded: true });
        throw error;
      }
      this.pendingMutations.splice(this.pendingMutations.indexOf(mutation), 1);
      this.confirmedProjects =
        history == null
          ? applyMutation(this.confirmedProjects, mutation)
          : deserializeProjects(history);
      this.reapplyPendingMutations();
      this.didChangeProjects();
    });
  }

  reapplyPendingMutations() {
    this.projects = this.pendingMutations.reduce(applyMutation, this.confirmedProjects);
  }

  queueOperation(operation) {
    const result = this.operationPromise.then(operation);
    this.operationPromise = result.catch(() => {});
    return result;
  }
}

function deserializeProjects(history) {
  return (Array.isArray(history?.projects) ? history.projects : [])
    .filter((p) => Array.isArray(p.paths) && p.paths.length > 0)
    .map((p) => new HistoryProject(p.paths, p.lastOpened));
}

function applyMutation(projects, mutation) {
  const updated = projects.map((p) => new HistoryProject(p.paths, p.lastOpened));
  if (!mutation) return updated;
  if (mutation.type === "clear") return [];
  const index = updated.findIndex((p) => arrayEquivalent(p.paths, mutation.paths));
  if (mutation.type === "remove") {
    if (index !== -1) updated.splice(index, 1);
  } else if (mutation.type === "add") {
    if (index !== -1) updated.splice(index, 1);
    updated.unshift(new HistoryProject(mutation.paths, mutation.lastOpened));
    updated.sort((a, b) => b.lastOpened - a.lastOpened);
  }
  return updated;
}

function arrayEquivalent(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

class HistoryProject {
  constructor(paths, lastOpened) {
    this.paths = paths;
    this.lastOpened = lastOpened || new Date();
  }

  set paths(paths) {
    this._paths = paths.slice();
  }
  get paths() {
    return this._paths;
  }

  set lastOpened(lastOpened) {
    this._lastOpened = new Date(lastOpened);
  }
  get lastOpened() {
    return this._lastOpened;
  }
}

module.exports = { HistoryManager, HistoryProject };
