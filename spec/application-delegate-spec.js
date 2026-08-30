const ApplicationDelegate = require("../src/application-delegate");
const { ipcRenderer } = require("electron");

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

  describe("onDidRequestApplicationMenuPopupSwitch", function () {
    it("subscribes to the dedicated renderer event and can unsubscribe", function () {
      const applicationDelegate = new ApplicationDelegate();
      const callback = jasmine.createSpy("callback");
      const detail = {
        from: "submenu:file",
        target: { key: "submenu:edit", kind: "submenu", id: "edit" },
      };
      const disposable = applicationDelegate.onDidRequestApplicationMenuPopupSwitch(callback);

      ipcRenderer.emit("application-menu-popup-switch", {}, detail);
      expect(callback).toHaveBeenCalledWith(detail);

      disposable.dispose();
      callback.calls.reset();
      ipcRenderer.emit("application-menu-popup-switch", {}, detail);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
