const ApplicationDelegate = require("../src/application-delegate");

describe("ApplicationDelegate", function () {
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

  describe("set/getTemporaryWindowState", function () {
    it("can serialize object trees containing redundant child object references", async function () {
      const applicationDelegate = new ApplicationDelegate();
      const childObject = { c: 1 };
      const sentObject = { a: childObject, b: childObject };

      await applicationDelegate.setTemporaryWindowState(sentObject);
      const receivedObject = await applicationDelegate.getTemporaryWindowState();

      expect(receivedObject).toEqual(sentObject);
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
