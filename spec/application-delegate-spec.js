const ApplicationDelegate = require("../src/application-delegate");

describe("ApplicationDelegate", function () {
  describe("window unload handshake", () => {
    it("forwards the unload request and identifies its completion reply", async () => {
      const { ipcRenderer } = require("electron");
      const delegate = new ApplicationDelegate();
      const request = { id: "unload-request", reason: "close" };
      const callback = jasmine.createSpy("prepare unload").and.resolveTo(true);
      const existing = new Set(ipcRenderer.listeners("prepare-to-unload"));
      const subscription = delegate.onDidRequestUnload(callback);
      const listener = ipcRenderer
        .listeners("prepare-to-unload")
        .find((candidate) => !existing.has(candidate));
      const send = spyOn(ipcRenderer, "send");
      try {
        await listener({}, request);
        expect(callback).toHaveBeenCalledOnceWith(request);
        expect(
          send.calls.allArgs().filter(([channel]) => channel === "did-prepare-to-unload"),
        ).toEqual([["did-prepare-to-unload", { id: request.id, approved: true }]]);
        subscription.dispose();
        expect(ipcRenderer.listeners("prepare-to-unload")).not.toContain(listener);
      } finally {
        subscription.dispose();
      }
    });

    it("refuses a failed preparation with the same request identity", async () => {
      const { ipcRenderer } = require("electron");
      const delegate = new ApplicationDelegate();
      const existing = new Set(ipcRenderer.listeners("prepare-to-unload"));
      const subscription = delegate.onDidRequestUnload(async () => {
        throw new Error("Preparation failed");
      });
      const listener = ipcRenderer
        .listeners("prepare-to-unload")
        .find((candidate) => !existing.has(candidate));
      const send = spyOn(ipcRenderer, "send");
      spyOn(console, "error");
      try {
        await listener({}, { id: "failed-request", reason: "reload" });
        expect(
          send.calls.allArgs().filter(([channel]) => channel === "did-prepare-to-unload"),
        ).toEqual([["did-prepare-to-unload", { id: "failed-request", approved: false }]]);
      } finally {
        subscription.dispose();
      }
    });

    it("commits the saved session through the fixed window action", async () => {
      const delegate = new ApplicationDelegate();
      const invoke = spyOn(delegate, "invokeWindow").and.resolveTo();
      await delegate.commitWindowUnload("unload-request");
      expect(invoke).toHaveBeenCalledOnceWith("commitUnload", "unload-request");
    });
  });

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
