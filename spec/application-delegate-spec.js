const ApplicationDelegate = require("../src/application-delegate");

describe("ApplicationDelegate", function () {
  describe("onWillReloadWindow", function () {
    it("observes committed reloads and removes the listener on disposal", function () {
      const { ipcRenderer } = require("electron");
      const delegate = new ApplicationDelegate();
      const callback = jasmine.createSpy("willReloadWindow");
      const existingListeners = new Set(ipcRenderer.listeners("will-reload-window"));
      const subscription = delegate.onWillReloadWindow(callback);
      const listener = ipcRenderer
        .listeners("will-reload-window")
        .find((candidate) => !existingListeners.has(candidate));
      try {
        listener({});
        expect(callback.calls.count()).toBe(1);

        subscription.dispose();
        expect(ipcRenderer.listeners("will-reload-window")).not.toContain(listener);
      } finally {
        subscription.dispose();
      }
    });
  });

  describe("openApplication", function () {
    it("routes GUI launches through the fixed application action and unwraps the PID", async function () {
      const delegate = new ApplicationDelegate();
      spyOn(delegate, "invokeApp").and.returnValue(
        Promise.resolve({ outcome: "success", result: 123 }),
      );
      const args = ["a file.gra", "&literal"];
      const options = { cwd: "/project" };

      expect(await delegate.openApplication("/applications/wingraf", args, options)).toBe(123);
      expect(delegate.invokeApp).toHaveBeenCalledWith(
        "openApplication",
        "/applications/wingraf",
        args,
        options,
      );
      await delegate.openApplication("/applications/wingraf");
      expect(delegate.invokeApp).toHaveBeenCalledWith(
        "openApplication",
        "/applications/wingraf",
        [],
        {},
      );
    });

    it("preserves the main-process startup error message and code", async function () {
      const delegate = new ApplicationDelegate();
      const error = { message: "Application does not exist", code: "ENOENT" };
      spyOn(delegate, "invokeApp").and.returnValue(Promise.resolve({ outcome: "failure", error }));

      await expectAsync(delegate.openApplication("/missing/application")).toBeRejectedWith(error);
    });
  });

  describe("setSheetOffset", function () {
    it("routes the offset through the fixed window action", async function () {
      const applicationDelegate = new ApplicationDelegate();
      spyOn(applicationDelegate, "invokeWindow").and.returnValue(Promise.resolve());

      await applicationDelegate.setSheetOffset(28);

      expect(applicationDelegate.invokeWindow).toHaveBeenCalledWith("setSheetOffset", 28);
    });
  });

  describe("project state adoption", function () {
    it("routes reservations and releases through fixed window actions", async function () {
      const applicationDelegate = new ApplicationDelegate();
      spyOn(applicationDelegate, "invokeWindow").and.returnValue(Promise.resolve());

      await applicationDelegate.reserveProjectStateAdoption(["/project"]);
      await applicationDelegate.releaseProjectStateAdoption("reservation-id");

      expect(applicationDelegate.invokeWindow.calls.allArgs()).toEqual([
        ["reserveProjectStateAdoption", ["/project"]],
        ["releaseProjectStateAdoption", "reservation-id"],
      ]);
    });
  });
});
