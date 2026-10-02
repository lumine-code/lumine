const { HistoryManager, HistoryProject } = require("../src/history-manager");
const StateStore = require("../src/state-store");
const { conditionPromise, timeoutPromise: wait } = require("./helpers/async-spec-helpers");
// Capture the original before the global helper spies on the prototype. Only
// these managers write to the isolated test table; real window history stays
// protected by the global spy.
const saveHistoryState = HistoryManager.prototype.saveState;

describe("HistoryManager", () => {
  let historyManager, commandRegistry, project, stateStore;
  let commandDisposable, projectDisposable;
  let otherManagers, otherStores;

  beforeEach(async () => {
    jasmine.useRealClock();
    otherManagers = [];
    otherStores = [];
    commandDisposable = jasmine.createSpyObj("Disposable", ["dispose"]);
    commandRegistry = jasmine.createSpyObj("CommandRegistry", ["add"]);
    commandRegistry.add.and.returnValue(commandDisposable);

    stateStore = new StateStore("history-manager-test", 1);
    stateStore.initialize({ configDirPath: lumine.getConfigDirPath() });
    await stateStore.save("history-manager", {
      projects: [
        {
          paths: ["/1", "c:\\2"],
          lastOpened: new Date(2016, 9, 17, 17, 16, 23),
        },
        { paths: ["/test"], lastOpened: new Date(2016, 9, 17, 11, 12, 13) },
      ],
    });
    projectDisposable = jasmine.createSpyObj("Disposable", ["dispose"]);
    project = jasmine.createSpyObj("Project", ["onDidChangePaths"]);
    project.onDidChangePaths.and.callFake((f) => {
      project.didChangePathsListener = f;
      return projectDisposable;
    });

    historyManager = new HistoryManager({
      stateStore,
      project,
      commands: commandRegistry,
    });
    historyManager.saveState = saveHistoryState;
    await historyManager.loadState();
  });

  afterEach(async () => {
    await historyManager.operationPromise;
    for (const manager of otherManagers) {
      await manager.operationPromise;
      manager.destroy();
    }
    historyManager.destroy();
    await stateStore.clear();
    // Release the connection so its WAL lock on the shared session store is not
    // held across every spec in this file, which intermittently starved later
    // specs' connections on CI.
    stateStore.close();
    for (const store of otherStores) store.close();
  });

  const buildOtherManager = async () => {
    const store = new StateStore("history-manager-test", 1);
    store.initialize({ configDirPath: lumine.getConfigDirPath() });
    otherStores.push(store);
    const manager = new HistoryManager({ stateStore: store, project, commands: commandRegistry });
    manager.saveState = saveHistoryState;
    otherManagers.push(manager);
    await manager.loadState();
    return manager;
  };

  describe("constructor", () => {
    it("registers the 'clear-project-history' command with its description", () => {
      expect(commandRegistry.add).toHaveBeenCalled();
      const cmdCall = commandRegistry.add.calls.first();
      expect(cmdCall.args.length).toBe(3);
      expect(cmdCall.args[0]).toBe("lumine-workspace");
      const listener = cmdCall.args[1]["application:clear-project-history"];
      expect(typeof listener.didDispatch).toBe("function");
      expect(listener.description).toBe("Forget the projects offered by the Reopen Project menu.");
      expect(listener.actionScope).toBe("list");
    });

    describe("getProjects", () => {
      it("returns an array of HistoryProjects", () => {
        expect(historyManager.getProjects()).toEqual([
          new HistoryProject(["/1", "c:\\2"], new Date(2016, 9, 17, 17, 16, 23)),
          new HistoryProject(["/test"], new Date(2016, 9, 17, 11, 12, 13)),
        ]);
      });

      it("returns an array of HistoryProjects that is not mutable state", () => {
        const firstProjects = historyManager.getProjects();
        firstProjects.pop();
        firstProjects[0].path = "modified";
        firstProjects[0].paths[0] = "changed path";
        firstProjects[0].lastOpened.setFullYear(2000);

        const secondProjects = historyManager.getProjects();
        expect(secondProjects.length).toBe(2);
        expect(secondProjects[0].path).not.toBe("modified");
        expect(secondProjects[0].paths).toEqual(["/1", "c:\\2"]);
        expect(secondProjects[0].lastOpened.getFullYear()).toBe(2016);
      });
    });

    describe("clearProjects", () => {
      it("clears the list of projects", async () => {
        expect(historyManager.getProjects().length).not.toBe(0);
        await historyManager.clearProjects();
        expect(historyManager.getProjects().length).toBe(0);
      });

      it("saves the state", async () => {
        await historyManager.clearProjects();
        const historyManager2 = await buildOtherManager();
        expect(historyManager2.getProjects().length).toBe(0);
      });

      it("fires the onDidChangeProjects event", async () => {
        const didChangeSpy = jasmine.createSpy();
        historyManager.onDidChangeProjects(didChangeSpy);
        await historyManager.clearProjects();
        expect(historyManager.getProjects().length).toBe(0);
        expect(didChangeSpy).toHaveBeenCalled();
      });
    });

    it("listens to project.onDidChangePaths adding a new project", () => {
      const start = new Date();
      project.didChangePathsListener(["/a/new", "/path/or/two"]);
      const projects = historyManager.getProjects();
      expect(projects.length).toBe(3);
      expect(projects[0].paths).toEqual(["/a/new", "/path/or/two"]);
      expect(projects[0].lastOpened).not.toBeLessThan(start);
    });

    it("listens to project.onDidChangePaths updating an existing project", () => {
      const start = new Date();
      project.didChangePathsListener(["/test"]);
      const projects = historyManager.getProjects();
      expect(projects.length).toBe(2);
      expect(projects[0].paths).toEqual(["/test"]);
      expect(projects[0].lastOpened).not.toBeLessThan(start);
    });
  });

  describe("loadState", () => {
    it("defaults to an empty array if no state", async () => {
      await stateStore.clear();
      await historyManager.loadState();
      expect(historyManager.getProjects()).toEqual([]);
    });

    it("defaults to an empty array if no projects", async () => {
      await stateStore.save("history-manager", {});
      await historyManager.loadState();
      expect(historyManager.getProjects()).toEqual([]);
    });
  });

  describe("addProject", () => {
    it("adds a new project to the end", async () => {
      const date = new Date(2010, 10, 9, 8, 7, 6);
      await historyManager.addProject(["/a/b"], date);
      const projects = historyManager.getProjects();
      expect(projects.length).toBe(3);
      expect(projects[2].paths).toEqual(["/a/b"]);
      expect(projects[2].lastOpened).toEqual(date);
    });

    it("adds a new project to the start", async () => {
      const date = new Date();
      await historyManager.addProject(["/so/new"], date);
      const projects = historyManager.getProjects();
      expect(projects.length).toBe(3);
      expect(projects[0].paths).toEqual(["/so/new"]);
      expect(projects[0].lastOpened).toEqual(date);
    });

    it("updates an existing project and moves it to the start", async () => {
      const date = new Date();
      await historyManager.addProject(["/test"], date);
      const projects = historyManager.getProjects();
      expect(projects.length).toBe(2);
      expect(projects[0].paths).toEqual(["/test"]);
      expect(projects[0].lastOpened).toEqual(date);
    });

    it("orders the latest intent first when additions and reopens share a timestamp", async () => {
      const date = new Date(2030, 0, 1);
      await historyManager.addProject(["/tied-first"], date);
      await historyManager.addProject(["/tied-second"], date);
      expect(
        historyManager
          .getProjects()
          .slice(0, 2)
          .map((p) => p.paths),
      ).toEqual([["/tied-second"], ["/tied-first"]]);

      await historyManager.addProject(["/tied-first"], date);
      expect(
        historyManager
          .getProjects()
          .slice(0, 2)
          .map((p) => p.paths),
      ).toEqual([["/tied-first"], ["/tied-second"]]);

      await historyManager.addProject(["/tied-third"], date);
      expect(
        historyManager
          .getProjects()
          .slice(0, 3)
          .map((p) => p.paths),
      ).toEqual([["/tied-third"], ["/tied-first"], ["/tied-second"]]);
    });

    it("fires the onDidChangeProjects event when adding a project", async () => {
      const didChangeSpy = jasmine.createSpy();
      const beforeCount = historyManager.getProjects().length;
      historyManager.onDidChangeProjects(didChangeSpy);
      await historyManager.addProject(["/test-new"], new Date());
      expect(didChangeSpy).toHaveBeenCalled();
      expect(historyManager.getProjects().length).toBe(beforeCount + 1);
    });

    it("fires the onDidChangeProjects event when updating a project", async () => {
      const didChangeSpy = jasmine.createSpy();
      const beforeCount = historyManager.getProjects().length;
      historyManager.onDidChangeProjects(didChangeSpy);
      await historyManager.addProject(["/test"], new Date());
      expect(didChangeSpy).toHaveBeenCalled();
      expect(historyManager.getProjects().length).toBe(beforeCount);
    });
  });

  describe("getProject", () => {
    it("returns a project that matches the paths", () => {
      const project = historyManager.getProject(["/1", "c:\\2"]);
      expect(project).not.toBeNull();
      expect(project.paths).toEqual(["/1", "c:\\2"]);
    });

    it("returns null when it can't find the project", () => {
      const project = historyManager.getProject(["/1"]);
      expect(project).toBeNull();
    });
  });

  describe("saveState", () => {
    let savedHistory;
    beforeEach(() => {
      savedHistory = { projects: historyManager.getProjects() };
      spyOn(historyManager.stateStore, "update").and.callFake((_name, update) => {
        savedHistory = update(savedHistory);
        return Promise.resolve(savedHistory);
      });
    });

    it("saves the state", async () => {
      await historyManager.addProject(["/save/state"]);
      await historyManager.saveState();
      const historyManager2 = new HistoryManager({
        stateStore,
        project,
        commands: commandRegistry,
      });
      otherManagers.push(historyManager2);
      spyOn(historyManager2.stateStore, "load").and.callFake((_name) =>
        Promise.resolve(savedHistory),
      );
      await historyManager2.loadState();
      expect(historyManager2.getProjects()[0].paths).toEqual(["/save/state"]);
    });
  });

  describe("independent windows", () => {
    const paths = (manager) => manager.getProjects().map((entry) => entry.paths);

    it("keeps both additions from stale independent snapshots", async () => {
      const other = await buildOtherManager();
      await Promise.all([historyManager.addProject(["/new-a"]), other.addProject(["/new-b"])]);
      await historyManager.loadState();
      expect(paths(historyManager)).toContain(["/new-a"]);
      expect(paths(historyManager)).toContain(["/new-b"]);
      expect(historyManager.getProjects().length).toBe(4);
    });

    it("does not resurrect a removed project when another window adds one", async () => {
      const other = await buildOtherManager();
      await Promise.all([historyManager.removeProject(["/test"]), other.addProject(["/new"])]);
      await historyManager.loadState();
      expect(paths(historyManager)).not.toContain(["/test"]);
      expect(paths(historyManager)).toContain(["/new"]);
      expect(historyManager.getProjects().length).toBe(2);
    });

    it("keeps a later addition after a different window clears stale history", async () => {
      const other = await buildOtherManager();
      await Promise.all([historyManager.clearProjects(), other.addProject(["/after-clear"])]);
      await historyManager.loadState();
      expect(paths(historyManager)).toEqual([["/after-clear"]]);
    });

    it("removes a persisted project absent from this window's stale snapshot", async () => {
      const other = await buildOtherManager();
      await other.addProject(["/only-in-other-window"]);
      await historyManager.removeProject(["/only-in-other-window"]);
      await other.loadState();
      expect(paths(other)).not.toContain(["/only-in-other-window"]);
    });

    it("does not restore stale projects when saveState is called without a mutation", async () => {
      const other = await buildOtherManager();
      await other.removeProject(["/test"]);
      await historyManager.saveState();
      await historyManager.loadState();
      expect(paths(historyManager)).not.toContain(["/test"]);
    });

    it("keeps immediate input paths and dates independent from their callers", async () => {
      const inputPaths = ["/new"];
      const date = new Date(2026, 9, 2);
      const adding = historyManager.addProject(inputPaths, date);
      inputPaths[0] = "changed";
      date.setFullYear(2000);
      expect(paths(historyManager)).toContain(["/new"]);
      await adding;
      expect(paths(historyManager)).toContain(["/new"]);
      expect(historyManager.getProject(["/new"]).lastOpened.getFullYear()).toBe(2026);
    });
  });

  describe("pending local operations", () => {
    const paths = () => historyManager.getProjects().map((entry) => entry.paths);

    it("reapplies later additions while an earlier write result is pending", async () => {
      const update = stateStore.update.bind(stateStore);
      let release, started;
      const began = new Promise((resolve) => {
        started = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let first = true;
      spyOn(stateStore, "update").and.callFake(async (...args) => {
        const saved = await update(...args);
        if (first) {
          first = false;
          started();
          await gate;
        }
        return saved;
      });
      const a = historyManager.addProject(["/a"]);
      await began;
      const b = historyManager.addProject(["/b"]);
      const observed = [];
      historyManager.onDidChangeProjects(() => observed.push(paths()));
      release();
      await a;
      expect(observed[0]).toContain(["/b"]);
      await b;
      expect(paths()).toContain(["/a"]);
      expect(paths()).toContain(["/b"]);
    });

    it("does not let a pending reload hide an immediate local addition", async () => {
      const load = stateStore.load.bind(stateStore);
      let release, started;
      const began = new Promise((resolve) => {
        started = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      spyOn(stateStore, "load").and.callFake(async (...args) => {
        const loaded = await load(...args);
        started();
        await gate;
        return loaded;
      });
      const loading = historyManager.loadState();
      await began;
      const adding = historyManager.addProject(["/during-reload"]);
      expect(paths()).toContain(["/during-reload"]);
      release();
      await loading;
      expect(paths()).toContain(["/during-reload"]);
      await adding;
      expect(paths()).toContain(["/during-reload"]);
    });

    it("recovers from a rejected write without dropping a later local edit", async () => {
      const update = stateStore.update.bind(stateStore);
      let first = true;
      spyOn(stateStore, "update").and.callFake((...args) => {
        if (first) {
          first = false;
          return Promise.reject(new Error("Storage failed"));
        }
        return update(...args);
      });
      const rejected = historyManager.addProject(["/failed"]);
      const later = historyManager.addProject(["/later"]);
      await expectAsync(rejected).toBeRejectedWithError("Storage failed");
      expect(paths()).not.toContain(["/failed"]);
      expect(paths()).toContain(["/later"]);
      await later;
      expect(paths()).toContain(["/later"]);
    });

    it("observes an automatic write failure and recovers on the next project change", async () => {
      const update = stateStore.update.bind(stateStore);
      const failure = new Error("Storage failed");
      let first = true;
      spyOn(stateStore, "update").and.callFake((...args) => {
        if (first) {
          first = false;
          return Promise.reject(failure);
        }
        return update(...args);
      });
      const warning = spyOn(console, "warn");
      const unhandled = jasmine.createSpy("unhandled project-history rejection");
      window.addEventListener("unhandledrejection", unhandled);
      try {
        project.didChangePathsListener(["/failed-auto"]);
        await conditionPromise(() => warning.calls.count() > 0);
        await wait(0);
        expect(warning).toHaveBeenCalledOnceWith("Unable to save recent project history", failure);
        expect(unhandled).not.toHaveBeenCalled();
        expect(paths()).not.toContain(["/failed-auto"]);

        project.didChangePathsListener(["/recovered-auto"]);
        await historyManager.operationPromise;
        expect(paths()).toContain(["/recovered-auto"]);
        const saved = await stateStore.load("history-manager");
        expect(saved.projects.map((entry) => entry.paths)).toContain(["/recovered-auto"]);
        expect(saved.projects.map((entry) => entry.paths)).not.toContain(["/failed-auto"]);
      } finally {
        window.removeEventListener("unhandledrejection", unhandled);
      }
    });
  });
});
