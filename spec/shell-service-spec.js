const ShellService = require("../src/shell-service");
const path = require("path");

describe("ShellService", () => {
  it("routes an application executable and literal arguments through the delegate", async () => {
    const delegate = {
      openApplication: jasmine.createSpy("openApplication").and.returnValue(Promise.resolve(42)),
    };
    const service = new ShellService(delegate);
    const args = ["a file.gra", "&literal", ""];
    const options = { cwd: "/project" };

    expect(await service.openApplication("/applications/wingraf", args, options)).toBe(42);
    expect(delegate.openApplication).toHaveBeenCalledWith("/applications/wingraf", args, options);
    await service.openApplication("/applications/wingraf");
    expect(delegate.openApplication).toHaveBeenCalledWith("/applications/wingraf", [], {});
  });

  it("preserves application startup failures", async () => {
    const error = { message: "Application does not exist", code: "ENOENT" };
    const service = new ShellService({ openApplication: () => Promise.reject(error) });

    await expectAsync(service.openApplication("/missing/application")).toBeRejectedWith(error);
  });

  it("reports real main-process startup failures through the public shell service", async () => {
    const missingApplication = path.join(
      lumine.getConfigDirPath(),
      "missing-application-executable-not-present",
      "app.exe",
    );

    await expectAsync(lumine.shell.openApplication(missingApplication)).toBeRejectedWith(
      jasmine.objectContaining({ code: "ENOENT" }),
    );
    await expectAsync(lumine.shell.openApplication("relative.exe")).toBeRejectedWith(
      jasmine.objectContaining({ message: "executablePath must be an absolute path" }),
    );
  });
});
