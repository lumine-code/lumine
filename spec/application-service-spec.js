const ApplicationService = require("../src/application-service");
const getWindowLoadSettings = require("../src/get-window-load-settings");

describe("ApplicationService", () => {
  const bootstrapSettings = getWindowLoadSettings();
  let delegate;
  let service;

  beforeEach(() => {
    getWindowLoadSettings.set({
      appPaths: { userData: "C:\\Lumine", temp: "C:\\Temp" },
      appLocale: "pl-PL",
    });
    delegate = { invokeApp: jasmine.createSpy("invokeApp").and.returnValue(Promise.resolve()) };
    service = new ApplicationService(delegate);
  });

  afterEach(() => getWindowLoadSettings.set(bootstrapSettings));

  it("reads application paths and locale synchronously from bootstrap state", () => {
    expect(service.getPath("userData")).toBe("C:\\Lumine");
    expect(service.getLocale()).toBe("pl-PL");
    expect(() => service.getPath("not-supported")).toThrowError(/Unsupported application path/);
  });

  it("maps asynchronous application operations to fixed actions", async () => {
    await service.getUserDefault("AppleActionOnDoubleClick", "string");
    await service.isDefaultProtocolClient("lumine", "lumine.exe", ["--open"]);
    await service.setAsDefaultProtocolClient("lumine", "lumine.exe", ["--open"]);
    await service.getFileIcon("C:\\file.txt", { size: "normal" });
    await service.getAccentColor();
    await service.printToPDF("<html></html>", "C:\\out.pdf", { landscape: true });
    await service.printToPDF("<html></html>", "C:\\out.pdf");
    await service.restart();

    expect(delegate.invokeApp.calls.allArgs()).toEqual([
      ["getUserDefault", "AppleActionOnDoubleClick", "string"],
      ["isDefaultProtocolClient", "lumine", "lumine.exe", ["--open"]],
      ["setAsDefaultProtocolClient", "lumine", "lumine.exe", ["--open"]],
      ["getFileIcon", "C:\\file.txt", { size: "normal" }],
      ["getAccentColor"],
      ["printToPDF", "<html></html>", "C:\\out.pdf", { landscape: true }],
      // Options are optional, and the main process is never handed `undefined`
      // where it validates an object.
      ["printToPDF", "<html></html>", "C:\\out.pdf", {}],
      ["restart"],
    ]);
  });
});
