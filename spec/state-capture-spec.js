const Package = require("../src/package");

describe("workspace state capture", () => {
  it("awaits package payload preparation before serializing the layout", async () => {
    let finish;
    const ready = new Promise((resolve) => {
      finish = resolve;
    });
    const pack = { mainModule: { prepareToSerialize: () => ready } };
    spyOn(lumine.packages, "getActivePackages").and.returnValue([pack]);
    const serialize = spyOn(lumine, "serialize").and.returnValue({ prepared: true });
    const capture = lumine.captureState({ isUnloading: true });
    await Promise.resolve();
    expect(serialize).not.toHaveBeenCalled();
    finish();
    expect(await capture).toEqual({ prepared: true });
    expect(serialize).toHaveBeenCalledOnceWith({ isUnloading: true });
  });

  it("retries a payload invalidated by another prepared package", async () => {
    const prepare = jasmine.createSpy("prepare");
    spyOn(lumine.packages, "getActivePackages").and.returnValue([
      { mainModule: { prepareToSerialize: prepare } },
    ]);
    const changed = Object.assign(new Error("changed"), { code: "STATE_SNAPSHOT_CHANGED" });
    spyOn(lumine, "serialize").and.returnValues(undefined);
    lumine.serialize.and.callFake(() => {
      if (prepare.calls.count() === 1) throw changed;
      return { current: true };
    });
    expect(await lumine.captureState()).toEqual({ current: true });
    expect(prepare.calls.count()).toBe(2);
  });

  it("keeps the native window open when its durable state cannot be written", async () => {
    spyOn(lumine, "saveState").and.rejectWith(new Error("disk full"));
    const confirm = spyOn(lumine.workspace, "confirmClose");
    const report = spyOn(lumine.notifications, "addError");
    spyOn(console, "error");
    expect(await lumine.prepareToUnloadEditorWindow()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalled();
  });

  it("prepares an active package before capturing its unload state", async () => {
    const pack = await lumine.packages.activatePackage("package-with-serialization");
    let prepared = false;
    pack.mainModule.prepareToSerialize = async () => {
      await Promise.resolve();
      prepared = true;
    };
    spyOn(pack.mainModule, "serialize").and.callFake(() => ({ prepared }));
    await lumine.packages.deactivatePackage(pack.name);
    expect(lumine.packages.packageStates[pack.name]).toEqual({ prepared: true });
  });

  it("leaves transfer operations available after an ordinary snapshot", async () => {
    await lumine.captureState();
    expect(lumine.workspace.windowLifecycleChanging).toBeFalsy();
  });

  it("reinstalls project-history commands after the session command registry resets", async () => {
    await lumine.reset();
    const command = lumine.commands
      .findCommands({ target: lumine.workspace.getElement() })
      .find((entry) => entry.name === "application:clear-project-history");
    expect(command.description).toBe("Forget the projects offered by the Reopen Project menu.");
  });

  it("rejects asynchronous or failed package serialization instead of persisting an empty payload", () => {
    const pack = {
      name: "snapshot-test",
      mainActivated: true,
      mainModule: { serialize: () => Promise.resolve({ unsafe: true }) },
    };
    expect(() => Package.prototype.serialize.call(pack)).toThrowError(TypeError);
    pack.mainModule.serialize = () => {
      throw new Error("unavailable pixels");
    };
    expect(() => Package.prototype.serialize.call(pack)).toThrowError("unavailable pixels");
  });
});
