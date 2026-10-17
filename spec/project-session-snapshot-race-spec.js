const fs = require("node:fs");
const path = require("node:path");
const Environment = require("../src/environment");

const deferred = () => {
  let resolve;
  const promise = new Promise((callback) => (resolve = callback));
  return { promise, resolve };
};

describe("Actual outgoing project snapshot ordering", () => {
  let env, directory, roots, file, editor, releases, transition;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(lumine.getConfigDirPath(), "outgoing-snapshot-race-"));
    roots = [path.join(directory, "a"), path.join(directory, "b")];
    for (const root of roots) fs.mkdirSync(root);
    file = path.join(roots[0], "source.txt");
    fs.writeFileSync(file, "original disk text");
    env = new Environment({
      applicationDelegate: lumine.applicationDelegate,
      enablePersistence: true,
    });
    env.config.saveCallback = () => {};
    env.stateStore.initialize({ configDirPath: directory });
    env.projectStateIndex.initialize({ configDirPath: directory });
    env.workspace.initialize({ configDirPath: directory });
    expect(await env.stateStore.connect()).toBe(true);
    env.config.set("core.openEmptyEditorOnStart", false);
    env.project.setPaths([roots[0]]);
    editor = await env.workspace.open(file);
    releases = [];
  });

  afterEach(async () => {
    for (const release of releases) release();
    await transition?.catch(() => {});
    await env.stateStore.close();
    env.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  async function returnToAAndExpect(text) {
    expect(await transition).toBe(true);
    expect(editor.isDestroyed()).toBe(true);
    expect(await env.project.setState([roots[0]])).toBe(true);
    const restored = env.workspace.getActiveTextEditor();
    expect(restored.getPath()).toBe(file);
    expect(restored.getText()).toBe(text);
    expect(fs.readFileSync(file, "utf8")).toBe("original disk text");
  }

  it("retains an edit made while the target project snapshot is being read", async () => {
    const started = deferred(),
      finish = deferred();
    releases.push(finish.resolve);
    const load = env.loadProjectState.bind(env);
    let held = false;
    spyOn(env, "loadProjectState").and.callFake(async (paths) => {
      if (!held && paths[0] === roots[1]) {
        held = true;
        started.resolve();
        await finish.promise;
      }
      return load(paths);
    });
    const will = jasmine.createSpy("willChangeState");
    const observation = env.project.onWillChangeState(will);
    transition = env.project.setState([roots[1]]);
    await started.promise;
    expect(will).not.toHaveBeenCalled();
    const text = "late unsaved edit during target read";
    editor.setText(text);
    expect(editor.getText()).toBe(text);
    finish.resolve();
    try {
      await returnToAAndExpect(text);
    } finally {
      observation.dispose();
    }
  });

  it("retains an edit made after the outgoing capture while its final durable write is pending", async () => {
    const started = deferred(),
      finish = deferred();
    releases.push(finish.resolve);
    const persist = env.persistState.bind(env);
    let held = false;
    spyOn(env, "persistState").and.callFake(async (options, snapshot, assertCurrent) => {
      if (!held && snapshot?.project?.paths?.[0] === roots[0]) {
        held = true;
        started.resolve();
        await finish.promise;
      }
      return persist(options, snapshot, assertCurrent);
    });
    transition = env.project.setState([roots[1]]);
    await started.promise;
    const text = "late unsaved edit during final persistence";
    editor.setText(text);
    expect(editor.getText()).toBe(text);
    finish.resolve();
    await returnToAAndExpect(text);
  });

  it("already retains an edit made after close confirmation but before the final capture", async () => {
    const started = deferred(),
      finish = deferred();
    releases.push(finish.resolve);
    const confirm = env.workspace.confirmClose.bind(env.workspace);
    spyOn(env.workspace, "confirmClose").and.callFake(async (...args) => {
      const allowed = await confirm(...args);
      started.resolve();
      await finish.promise;
      return allowed;
    });
    transition = env.project.setState([roots[1]]);
    await started.promise;
    const text = "late unsaved edit before final capture";
    editor.setText(text);
    expect(editor.getText()).toBe(text);
    finish.resolve();
    await returnToAAndExpect(text);
  });

  it("keeps every outgoing editor alive through asynchronous close listeners and saves their final text", async () => {
    const otherFile = path.join(roots[0], "other.txt");
    fs.writeFileSync(otherFile, "other disk text");
    const other = await env.workspace.open(otherFile);
    const started = deferred(),
      finish = deferred();
    releases.push(finish.resolve);
    const listener = env.workspace.onWillDestroyPaneItem(async ({ item }) => {
      if (item !== other) return;
      started.resolve();
      await finish.promise;
    });
    transition = env.project.setState([roots[1]]);
    await started.promise;
    expect(editor.isDestroyed()).toBe(false);
    expect(other.isDestroyed()).toBe(false);
    editor.setText("first edit during close listener");
    other.setText("second edit during close listener");
    finish.resolve();
    await transition;
    listener.dispose();
    expect(await env.project.setState([roots[0]])).toBe(true);
    const restored = env.workspace.getTextEditors();
    expect(restored.find((item) => item.getPath() === file).getText()).toBe(
      "first edit during close listener",
    );
    expect(restored.find((item) => item.getPath() === otherFile).getText()).toBe(
      "second edit during close listener",
    );
  });

  it("refreshes an edit during the durable write immediately before teardown", async () => {
    const persist = env.persistState.bind(env);
    let writes = 0;
    spyOn(env, "persistState").and.callFake(async (options, snapshot, assertCurrent) => {
      await persist(options, snapshot, assertCurrent);
      if (snapshot?.project?.paths?.[0] === roots[0]) {
        writes++;
        if (!editor.isDestroyed()) editor.setText("latest edit before teardown");
      }
    });
    transition = env.project.setState([roots[1]]);
    await returnToAAndExpect("latest edit before teardown");
    expect(writes).toBe(2);
  });

  it("preserves the live outgoing session when its final write fails", async () => {
    const persist = env.persistState.bind(env);
    const failure = new Error("Final state write failed");
    spyOn(env, "persistState").and.callFake(async (options, snapshot, assertCurrent) => {
      if (snapshot) {
        editor.setText("edit before a failed final write");
        throw failure;
      }
      return persist(options, snapshot, assertCurrent);
    });
    transition = env.project.setState([roots[1]]);
    await expectAsync(transition).toBeRejectedWith(failure);
    expect(env.project.getPaths()).toEqual([roots[0]]);
    expect(editor.isDestroyed()).toBe(false);
    expect(editor.getText()).toBe("edit before a failed final write");
  });

  it("rolls back the latest detached text if the refreshed write fails after teardown", async () => {
    const persist = env.persistState.bind(env);
    const failure = new Error("Refreshed state write failed");
    let writes = 0;
    spyOn(env, "persistState").and.callFake(async (options, snapshot, assertCurrent) => {
      if (snapshot) {
        if (++writes === 2) {
          expect(editor.isDestroyed()).toBe(true);
          throw failure;
        }
        await persist(options, snapshot, assertCurrent);
        editor.setText("latest text retained for rollback");
        return;
      }
      return persist(options, snapshot, assertCurrent);
    });
    transition = env.project.setState([roots[1]]);
    await expectAsync(transition).toBeRejectedWith(failure);
    expect(env.project.getPaths()).toEqual([roots[0]]);
    const restored = env.workspace.getActiveTextEditor();
    expect(restored.isDestroyed()).toBe(false);
    expect(restored.getPath()).toBe(file);
    expect(restored.getText()).toBe("latest text retained for rollback");
  });

  it("allows a retained dock buffer to keep changing during the outgoing writes", async () => {
    const retainedFile = path.join(roots[0], "retained.txt");
    fs.writeFileSync(retainedFile, "retained disk text");
    const retained = await env.workspace.open(retainedFile);
    env.workspace.paneForItem(retained).removeItem(retained, true);
    env.textEditors.add(retained, { role: "document" });
    const element = document.createElement("div");
    element.append(retained.getElement());
    const dockItem = {
      getElement: () => element,
      getTitle: () => "Retained source",
      getAllowedLocations: () => ["right"],
      destroy: () => retained.destroy(),
    };
    env.workspace.getRightDock().getActivePane().addItem(dockItem);
    const persist = env.persistState.bind(env);
    let writes = 0;
    spyOn(env, "persistState").and.callFake(async (options, snapshot, assertCurrent) => {
      await persist(options, snapshot, assertCurrent);
      if (snapshot) retained.setText(`retained revision ${++writes}`);
    });
    transition = env.project.setState([roots[1]]);
    expect(await transition).toBe(true);
    expect(retained.isDestroyed()).toBe(false);
    expect(retained.getText()).toBe("retained revision 2");
    expect(env.workspace.paneForItem(dockItem).getContainer().getLocation()).toBe("right");
  });

  it("refuses unrelated opens during the refreshed write and releases the gate afterwards", async () => {
    const persist = env.persistState.bind(env);
    let writes = 0;
    spyOn(env, "persistState").and.callFake(async (options, snapshot, assertCurrent) => {
      if (snapshot && ++writes === 2) {
        expect(editor.isDestroyed()).toBe(true);
        expect(await env.workspace.open(null)).toBeUndefined();
        expect(env.workspace.getCenter().getPaneItems()).toEqual([]);
      }
      await persist(options, snapshot, assertCurrent);
      if (snapshot && !editor.isDestroyed()) editor.setText("late edit requiring refresh");
    });
    transition = env.project.setState([roots[1]]);
    expect(await transition).toBe(true);
    expect(await env.workspace.open(null)).toBeDefined();
  });

  it("drains every item close preparation before rejecting a failed transition", async () => {
    const otherFile = path.join(roots[0], "other.txt");
    fs.writeFileSync(otherFile, "other disk text");
    const other = await env.workspace.open(otherFile);
    const started = deferred(),
      finish = deferred();
    releases.push(finish.resolve);
    const failure = new Error("Close preparation failed");
    const listener = env.workspace.onWillDestroyPaneItem(async ({ item }) => {
      if (item === editor) throw failure;
      if (item === other) {
        started.resolve();
        await finish.promise;
      }
    });
    releases.push(() => listener.dispose());
    transition = env.project.setState([roots[1]]);
    let settled = false;
    const rejection = transition.catch((error) => {
      settled = true;
      return error;
    });
    await started.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(editor.isDestroyed()).toBe(false);
    expect(other.isDestroyed()).toBe(false);
    finish.resolve();
    expect(await rejection).toBe(failure);
    expect(env.project.getPaths()).toEqual([roots[0]]);
    expect(editor.isDestroyed()).toBe(false);
    expect(other.isDestroyed()).toBe(false);
  });

  it("refuses new center opens until incoming restoration has finished", async () => {
    const incomingFile = path.join(roots[1], "incoming.txt");
    fs.writeFileSync(incomingFile, "incoming disk text");
    await env.project.setState([roots[1]]);
    await env.workspace.open(incomingFile);
    await env.project.setState([roots[0]]);
    editor = env.workspace.getActiveTextEditor();
    editor.setText("outgoing edit before incoming restore");
    const started = deferred(),
      finish = deferred();
    releases.push(finish.resolve);
    const restore = env.restoreStateIntoThisEnvironment.bind(env);
    let held = false;
    spyOn(env, "restoreStateIntoThisEnvironment").and.callFake(async (...args) => {
      if (!held && args[0].project.paths[0] === roots[1]) {
        held = true;
        started.resolve();
        await finish.promise;
      }
      return restore(...args);
    });
    transition = env.project.setState([roots[1]]);
    await started.promise;
    expect(env.workspace.getCenter().getPaneItems()).toEqual([]);
    expect(await env.workspace.open(file)).toBeUndefined();
    finish.resolve();
    await returnToAAndExpect("outgoing edit before incoming restore");
    expect(await env.workspace.open(null)).toBeDefined();
  });

  it("permits only saved host restoration through the project gate and still respects cleanup", async () => {
    const workspace = env.workspace;
    const state = workspace.serialize();
    state.paneContainers.center.windows = [
      {
        id: "saved-auxiliary-window",
        bounds: { x: 40, y: 40, width: 700, height: 500 },
        container: structuredClone(state.paneContainers.center.main),
      },
    ];
    const host = { id: "restored-host" };
    const nativeOpen = spyOn(workspace.editorWindowHost, "open").and.resolveTo(host);
    const warning = spyOn(env.notifications, "addWarning");
    const gate = workspace.beginProjectStateChange();
    try {
      await expectAsync(workspace.openEditorWindow({ show: false })).toBeRejected();
      expect(nativeOpen).not.toHaveBeenCalled();
      const restored = await workspace.prepareEditorWindowRestore(state, { locations: ["center"] });
      expect(restored.windows.map(({ window }) => window)).toEqual([host]);
      expect(nativeOpen).toHaveBeenCalledTimes(1);
      expect(warning).not.toHaveBeenCalled();
      const cleanup = workspace.beginWindowCleanup();
      try {
        const refused = await workspace.prepareEditorWindowRestore(state, {
          locations: ["center"],
        });
        expect(refused.windows).toEqual([]);
        expect(nativeOpen).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledTimes(1);
      } finally {
        cleanup.dispose();
      }
    } finally {
      gate.dispose();
    }
  });
});
