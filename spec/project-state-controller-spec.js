const ProjectStateController = require("../src/project-state-controller");

describe("ProjectStateController", () => {
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  const rejectionOf = (promise) =>
    promise.then(
      () => {
        throw new Error("Expected the project transition to reject");
      },
      (error) => error,
    );

  function buildController() {
    const project = {
      paths: ["project-a"],
      getPaths() {
        return this.paths.slice();
      },
      getProvidedDirectoryForProjectPath: (projectPath) => ({
        getPath: () => projectPath,
        existsSync: () => true,
      }),
      getDirectoryForProjectPath: (projectPath) => ({ getPath: () => projectPath }),
      defaultDirectoryProvider: { normalizePath: (projectPath) => projectPath },
      destroyUnretainedBuffers: jasmine.createSpy("destroyUnretainedBuffers"),
      restoredBufferAliases: new Map(),
    };
    project.setPaths = jasmine.createSpy("setPaths").and.callFake((paths) => {
      project.paths = paths.slice();
    });
    const workspace = {
      items: ["outgoing-editor"],
      confirmClose: jasmine.createSpy("confirmClose").and.returnValue(Promise.resolve(true)),
      open: jasmine.createSpy("open").and.returnValue(Promise.resolve()),
    };
    workspace.clear = jasmine.createSpy("clear").and.callFake(async () => {
      workspace.items = [];
    });
    const config = {
      projectFile: "project-a/project.json",
      projectSettings: { editor: { tabLength: 7 } },
      scopedSettings: { ".source.js": { editor: { tabLength: 5 } } },
      get: () => false,
    };
    config.scopedSettingsStore = {
      propertiesForSource: () => config.scopedSettings,
    };
    config.clearProjectSettings = jasmine.createSpy("clearProjectSettings").and.callFake(() => {
      config.projectFile = null;
      config.projectSettings = {};
      config.scopedSettings = {};
    });
    config.resetProjectSettings = jasmine
      .createSpy("resetProjectSettings")
      .and.callFake((settings, projectFile) => {
        config.projectFile = projectFile;
        config.projectSettings = settings["*"];
        config.scopedSettings = Object.fromEntries(
          Object.entries(settings).filter(([scope]) => scope !== "*"),
        );
      });
    const stateFor = (paths) => ({
      project: { paths: paths.slice() },
      workspace: { items: paths.map((projectPath) => `${projectPath}/editor`) },
      packageStates: {},
    });
    const applyState = (state) => {
      project.paths = state.project.paths.slice();
      workspace.items = state.workspace.items.slice();
    };
    const dependencies = {
      project,
      workspace,
      config,
      packages: {
        restoreActivePackageStates: jasmine
          .createSpy("restoreActivePackageStates")
          .and.returnValue(Promise.resolve()),
      },
      saveState: jasmine.createSpy("saveState").and.returnValue(Promise.resolve()),
      serialize: jasmine.createSpy("serialize").and.callFake(() => ({
        project: { paths: project.getPaths() },
        workspace: { items: workspace.items.slice() },
        packageStates: {},
      })),
      loadProjectState: jasmine.createSpy("loadProjectState").and.callFake(async (paths) => ({
        state: stateFor(paths),
        reservationId: "reservation",
      })),
      restoreState: jasmine
        .createSpy("restoreState")
        .and.callFake(async (state) => applyState(state)),
      releaseReservation: jasmine
        .createSpy("releaseReservation")
        .and.returnValue(Promise.resolve()),
      isAvailable: jasmine.createSpy("isAvailable").and.returnValue(true),
    };
    return {
      ...dependencies,
      applyState,
      stateFor,
      controller: new ProjectStateController(dependencies),
    };
  }

  function expectOutgoingConfig(config) {
    expect(config.projectFile).toBe("project-a/project.json");
    expect(config.projectSettings).toEqual({ editor: { tabLength: 7 } });
    expect(config.scopedSettings).toEqual({ ".source.js": { editor: { tabLength: 5 } } });
  }

  it("preserves the original restoration error when rollback and release succeed", async () => {
    const fixture = buildController();
    const original = new Error("Incoming restore failed");
    let restoration = 0;
    fixture.restoreState.and.callFake(async (state) => {
      if (++restoration === 1) throw original;
      fixture.applyState(state);
    });

    expect(await rejectionOf(fixture.controller.setState(["project-b"]))).toBe(original);
    expect(fixture.project.getPaths()).toEqual(["project-a"]);
    expect(fixture.workspace.items).toEqual(["outgoing-editor"]);
    expectOutgoingConfig(fixture.config);
  });

  for (const rollbackFailure of ["clear", "restore"]) {
    it(`restores configuration and preserves both errors when rollback ${rollbackFailure} fails`, async () => {
      const fixture = buildController();
      const original = new Error("Incoming restore failed");
      const rollback = new Error("Outgoing rollback failed");
      let restoration = 0;
      fixture.restoreState.and.callFake(async () => {
        if (++restoration === 1) throw original;
        throw rollback;
      });
      if (rollbackFailure === "clear") {
        let clearing = 0;
        fixture.workspace.clear.and.callFake(async () => {
          if (++clearing === 2) throw rollback;
          fixture.workspace.items = [];
        });
      }

      const error = await rejectionOf(fixture.controller.setState(["project-b"]));

      expect(error instanceof AggregateError).toBe(true);
      expect(error.errors).toEqual([original, rollback]);
      expect(error.cause).toBe(original);
      expect(fixture.config.resetProjectSettings).toHaveBeenCalledTimes(1);
      expectOutgoingConfig(fixture.config);
    });
  }

  it("retains an original AggregateError while combining rollback, config, and release failures", async () => {
    const fixture = buildController();
    const original = new AggregateError([new Error("Package restore failed")], "Incoming failed");
    const rollback = new Error("Rollback failed");
    const config = new Error("Config reset failed");
    const release = new Error("Reservation release failed");
    let restoration = 0;
    fixture.restoreState.and.callFake(async () => {
      throw ++restoration === 1 ? original : rollback;
    });
    fixture.config.resetProjectSettings.and.throwError(config);
    fixture.releaseReservation.and.callFake(async () => {
      throw release;
    });

    const error = await rejectionOf(fixture.controller.setState(["project-b"]));

    expect(error instanceof AggregateError).toBe(true);
    expect(error.errors).toEqual([original, rollback, config, release]);
    expect(error.errors[0]).toBe(original);
    expect(error.cause).toBe(original);
    expect(fixture.config.resetProjectSettings).toHaveBeenCalledTimes(1);
  });

  it("preserves the original restoration error alongside a reservation release failure", async () => {
    const fixture = buildController();
    const original = new Error("Incoming restore failed");
    const release = new Error("Reservation release failed");
    let restoration = 0;
    fixture.restoreState.and.callFake(async (state) => {
      if (++restoration === 1) throw original;
      fixture.applyState(state);
    });
    fixture.releaseReservation.and.callFake(async () => {
      throw release;
    });

    const error = await rejectionOf(fixture.controller.setState(["project-b"]));

    expect(error.errors).toEqual([original, release]);
    expect(error.cause).toBe(original);
    expectOutgoingConfig(fixture.config);
  });

  it("rejects a failed release after a successful transition without undoing the restored project", async () => {
    const fixture = buildController();
    const release = new Error("Reservation release failed");
    fixture.releaseReservation.and.callFake(async () => {
      throw release;
    });

    expect(await rejectionOf(fixture.controller.setState(["project-b"]))).toBe(release);
    expect(fixture.project.getPaths()).toEqual(["project-b"]);
    expect(fixture.workspace.items).toEqual(["project-b/editor"]);
    expect(fixture.restoreState).toHaveBeenCalledTimes(1);
  });

  it("keeps new requests behind an invalidated load, releases its late reservation, and skips old queued requests", async () => {
    const fixture = buildController();
    const loadStarted = deferred();
    const lateLoad = deferred();
    fixture.loadProjectState.and.callFake((paths) => {
      if (fixture.loadProjectState.calls.count() === 1) {
        loadStarted.resolve();
        return lateLoad.promise;
      }
      return Promise.resolve({ state: fixture.stateFor(paths), reservationId: null });
    });
    const first = rejectionOf(fixture.controller.setState(["project-b"]));
    await loadStarted.promise;
    const oldQueued = rejectionOf(fixture.controller.setState(["project-c"]));
    fixture.controller.reset();
    const requestedPaths = ["project-d"];
    const current = fixture.controller.setState(requestedPaths);
    requestedPaths[0] = "mutated-after-enqueue";
    await Promise.resolve();
    expect(fixture.loadProjectState).toHaveBeenCalledTimes(1);
    lateLoad.resolve({ state: fixture.stateFor(["project-b"]), reservationId: "late-reservation" });

    expect((await first).code).toBe("ABORT_ERR");
    expect((await oldQueued).code).toBe("ABORT_ERR");
    expect(await current).toBe(true);
    expect(fixture.releaseReservation).toHaveBeenCalledWith("late-reservation", ["project-b"]);
    expect(fixture.loadProjectState).toHaveBeenCalledTimes(2);
    expect(fixture.restoreState.calls.allArgs().map(([state]) => state.project.paths)).toEqual([
      ["project-d"],
    ]);
    expect(fixture.project.getPaths()).toEqual(["project-d"]);
  });

  it("rejects in-flight, queued, and future requests after destroy while releasing a late reservation", async () => {
    const fixture = buildController();
    const loadStarted = deferred();
    const lateLoad = deferred();
    fixture.loadProjectState.and.callFake(() => {
      loadStarted.resolve();
      return lateLoad.promise;
    });
    const first = rejectionOf(fixture.controller.setState(["project-b"]));
    await loadStarted.promise;
    const queued = rejectionOf(fixture.controller.setState(["project-c"]));
    fixture.controller.destroy();
    fixture.controller.reset();
    const future = rejectionOf(fixture.controller.setState(["project-d"]));
    lateLoad.resolve({ state: fixture.stateFor(["project-b"]), reservationId: "late-reservation" });

    for (const outcome of [first, queued, future]) expect((await outcome).code).toBe("ABORT_ERR");
    expect(fixture.releaseReservation).toHaveBeenCalledWith("late-reservation", ["project-b"]);
    expect(fixture.loadProjectState).toHaveBeenCalledTimes(1);
    expect(fixture.workspace.clear).not.toHaveBeenCalled();
    expect(fixture.restoreState).not.toHaveBeenCalled();
    expect(fixture.project.getPaths()).toEqual(["project-a"]);
    expectOutgoingConfig(fixture.config);
  });

  for (const stage of ["saveState", "confirmClose", "loadProjectState"]) {
    it(`reports cancellation when pending ${stage} rejects after reset`, async () => {
      const fixture = buildController();
      const stageStarted = deferred();
      const pendingStage = deferred();
      const operation = stage === "confirmClose" ? fixture.workspace.confirmClose : fixture[stage];
      operation.and.callFake(() => {
        stageStarted.resolve();
        return pendingStage.promise;
      });
      const transition = rejectionOf(fixture.controller.setState(["project-b"]));
      await stageStarted.promise;
      fixture.controller.reset();
      pendingStage.reject(new Error("Obsolete operation failed"));

      expect((await transition).code).toBe("ABORT_ERR");
      expect(fixture.workspace.clear).not.toHaveBeenCalled();
      expect(fixture.restoreState).not.toHaveBeenCalled();
      expect(fixture.project.getPaths()).toEqual(["project-a"]);
      expectOutgoingConfig(fixture.config);
    });
  }

  it("does not roll an old transition back into the new generation after reset during restore", async () => {
    const fixture = buildController();
    const restoreStarted = deferred();
    const restoring = deferred();
    fixture.restoreState.and.callFake(() => {
      restoreStarted.resolve();
      return restoring.promise;
    });
    const transition = rejectionOf(fixture.controller.setState(["project-b"]));
    await restoreStarted.promise;
    fixture.controller.reset();
    fixture.project.paths = ["project-c"];
    fixture.workspace.items = ["new-generation-editor"];
    fixture.config.projectFile = "project-c/project.json";
    fixture.config.projectSettings = { generation: "current" };
    restoring.reject(new Error("Obsolete restoration failed"));

    expect((await transition).code).toBe("ABORT_ERR");
    expect(fixture.workspace.clear).toHaveBeenCalledTimes(1);
    expect(fixture.restoreState).toHaveBeenCalledTimes(1);
    expect(fixture.config.resetProjectSettings).not.toHaveBeenCalled();
    expect(fixture.project.getPaths()).toEqual(["project-c"]);
    expect(fixture.workspace.items).toEqual(["new-generation-editor"]);
    expect(fixture.config.projectSettings).toEqual({ generation: "current" });
    expect(fixture.config.projectFile).toBe("project-c/project.json");
  });

  it("rejects an invalidated transition after its pending reservation release finishes", async () => {
    const fixture = buildController();
    const releaseStarted = deferred();
    const releasing = deferred();
    fixture.releaseReservation.and.callFake(() => {
      releaseStarted.resolve();
      return releasing.promise;
    });
    const transition = rejectionOf(fixture.controller.setState(["project-b"]));
    await releaseStarted.promise;
    fixture.controller.reset();
    fixture.project.paths = ["project-c"];
    fixture.workspace.items = ["new-generation-editor"];
    releasing.resolve();

    expect((await transition).code).toBe("ABORT_ERR");
    expect(fixture.releaseReservation).toHaveBeenCalledTimes(1);
    expect(fixture.restoreState).toHaveBeenCalledTimes(1);
    expect(fixture.config.resetProjectSettings).not.toHaveBeenCalled();
    expect(fixture.project.getPaths()).toEqual(["project-c"]);
    expect(fixture.workspace.items).toEqual(["new-generation-editor"]);
  });
});
