const AuxiliaryWindowHost = require("../src/auxiliary-window-host");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("auxiliary presentation cleanup ownership", () => {
  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
  });
  afterEach(async () => lumine.workspace.discardEditorWindows());

  it("closes the resolved native child when its workspace starts closing before service creation", async () => {
    const invoke = lumine.applicationDelegate.invokeAuxiliaryWindow.bind(
      lumine.applicationDelegate,
    );
    const alive = spyOn(lumine.workspace, "isAlive").and.callThrough();
    let descriptor, child;
    const open = lumine.domWindow.open.bind(lumine.domWindow);
    spyOn(lumine.domWindow, "open").and.callFake((...args) => (child = open(...args)));
    spyOn(lumine.applicationDelegate, "invokeAuxiliaryWindow").and.callFake(
      async (action, ...args) => {
        const result = await invoke(action, ...args);
        if (action === "resolve") {
          descriptor = result;
          alive.and.returnValue(false);
        }
        return result;
      },
    );
    try {
      await expectAsync(
        new AuxiliaryWindowHost(lumine).open({ show: false }),
      ).toBeRejectedWithError("The workspace is closing.");
      await conditionPromise(() => child.closed);
      expect(child.closed).toBeTrue();
    } finally {
      alive.and.callThrough();
      if (descriptor && !child.closed)
        await invoke("invoke", descriptor.id, "close").catch(() => {});
    }
  });

  it("releases the drop surface through its retained owner after the environment drops that field", async () => {
    const drops = lumine.workspaceDrops;
    const release = jasmine
      .createSpy("retained drop owner")
      .and.callFake((surface) => drops.releaseSurface(surface));
    lumine.workspaceDrops = {
      attachPresentation: (root) => drops.attachPresentation(root),
      releaseSurface: release,
    };
    let extra, root;
    try {
      extra = await lumine.workspace.openEditorWindow({ show: false });
      root = extra.getElement();
      lumine.workspaceDrops = null;
      expect(() => extra.destroy()).not.toThrow();
      expect(release).toHaveBeenCalledTimes(1);
      expect(drops.surfaces.has(root)).toBeFalse();
    } finally {
      lumine.workspaceDrops = drops;
      const surface = root && drops.surfaces.get(root);
      if (surface) drops.releaseSurface(surface);
      if (extra) await extra.windowService.close();
    }
  });

  it("closes the resolved child even if creating its service subscription throws", async () => {
    let child;
    const open = lumine.domWindow.open.bind(lumine.domWindow);
    spyOn(lumine.domWindow, "open").and.callFake((...args) => (child = open(...args)));
    spyOn(lumine.applicationDelegate, "onAuxiliaryWindowEvent").and.throwError(
      "Subscription failed",
    );
    await expectAsync(new AuxiliaryWindowHost(lumine).open({ show: false })).toBeRejectedWithError(
      "Subscription failed",
    );
    await conditionPromise(() => child.closed);
  });
});
