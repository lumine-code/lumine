const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Project state transition notifications", () => {
  let directory, paths, state, subscription;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-transition-event-")));
    paths = [path.join(directory, "a"), path.join(directory, "b")];
    for (const root of paths) fs.mkdirSync(root);
    fs.writeFileSync(path.join(paths[0], "source.txt"), "source\n");
    state = lumine.packages.storage.forPackage("transition-event-spec").workspaceState;
    lumine.project.setPaths([paths[1]]);
    await state.update("owner", "B");
    lumine.project.setPaths([paths[0]]);
    await state.update("owner", "A");
    await lumine.workspace.open(path.join(paths[0], "source.txt"));
  });

  afterEach(async () => {
    subscription?.dispose();
    subscription = null;
    for (const editor of lumine.workspace.getTextEditors()) editor.destroy();
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    const resolved = fs.realpathSync(directory);
    if (
      path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith("lumine-transition-event-")
    )
      throw Error("Unsafe project transition fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("notifies against the outgoing document and storage before teardown and rebinding", async () => {
    const order = [];
    subscription = lumine.project.onWillChangeState((incoming) => {
      order.push("will");
      expect(incoming).toEqual([paths[1]]);
      expect(Object.isFrozen(incoming)).toBe(true);
      expect(lumine.project.getPaths()).toEqual([paths[0]]);
      expect(state.get("owner")).toBe("A");
      expect(lumine.workspace.getActiveTextEditor().getPath()).toBe(
        path.join(paths[0], "source.txt"),
      );
    });
    const clear = lumine.workspace.clear.bind(lumine.workspace);
    spyOn(lumine.workspace, "clear").and.callFake((...args) => {
      order.push("clear");
      return clear(...args);
    });
    const switchProject = lumine.packages.storage.switchProject.bind(lumine.packages.storage);
    spyOn(lumine.packages.storage, "switchProject").and.callFake((...args) => {
      order.push("storage");
      return switchProject(...args);
    });
    expect(await lumine.project.setState([paths[1]])).toBe(true);
    expect(order[0]).toBe("will");
    expect(order.indexOf("clear")).toBeLessThan(order.indexOf("storage"));
    expect(order.filter((item) => item === "will").length).toBe(1);
    expect(state.get("owner")).toBe("B");
  });

  it("does not announce an unchanged or declined project transition", async () => {
    const changing = jasmine.createSpy("changing");
    subscription = lumine.project.onWillChangeState(changing);
    expect(await lumine.project.setState([paths[0]])).toBe(false);
    spyOn(lumine.workspace, "confirmClose").and.resolveTo(false);
    expect(await lumine.project.setState([paths[1]])).toBe(false);
    expect(changing).not.toHaveBeenCalled();
    expect(state.get("owner")).toBe("A");
  });

  it("stops notifying a disposed project transition observer", async () => {
    const changing = jasmine.createSpy("changing");
    subscription = lumine.project.onWillChangeState(changing);
    subscription.dispose();
    expect(await lumine.project.setState([paths[1]])).toBe(true);
    expect(changing).not.toHaveBeenCalled();
  });
});
