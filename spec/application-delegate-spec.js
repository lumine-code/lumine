const ApplicationDelegate = require("../src/application-delegate");

describe("ApplicationDelegate", function () {
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
