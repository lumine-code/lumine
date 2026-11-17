const temp = require("@lumine-code/fs-temp").track();
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const KeymapManager = require("../src/keymap-extensions");

describe("keymap-extensions", function () {
  beforeEach(function () {
    lumine.keymaps.configDirPath = temp.path("lumine-spec-keymap-ext");
    fs.writeFileSync(lumine.keymaps.getUserKeymapPath(), "// User keymap\n{}");
    this.userKeymapLoaded = function () {};
    lumine.keymaps.onDidLoadUserKeymap(() => this.userKeymapLoaded());
  });

  afterEach(function () {
    fs.removeSync(lumine.keymaps.configDirPath);
    lumine.keymaps.destroy();
  });

  describe("did-load-user-keymap", () =>
    it("fires when user keymap is loaded", function () {
      spyOn(this, "userKeymapLoaded");
      lumine.keymaps.loadUserKeymap();
      expect(this.userKeymapLoaded).toHaveBeenCalled();
    }));

  it("uses keymap.json as the default path", () => {
    expect(lumine.keymaps.getUserKeymapPath()).toBe(
      path.join(lumine.keymaps.configDirPath, "keymap.json"),
    );
  });

  it("keeps fatal keymap diagnostics and reporting identity below the summary", () => {
    const userKeymapPath = lumine.keymaps.getUserKeymapPath();
    const error = new Error("Invalid [keymap] entry with `backticks`");
    error.path = userKeymapPath;
    const notificationManager = { addFatalError: jasmine.createSpy("addFatalError") };
    const keymaps = new KeymapManager({
      configDirPath: lumine.keymaps.configDirPath,
      notificationManager,
    });
    spyOn(keymaps, "loadKeymap").and.callFake(() => {
      throw error;
    });

    keymaps.loadUserKeymap();

    expect(notificationManager.addFatalError).toHaveBeenCalledOnceWith(
      "Failed to load the user keymap",
      {
        detail: `Path: ${userKeymapPath}\n${error.message}`,
        stack: error.stack,
        reportTitle: error.message,
        sourcePath: userKeymapPath,
        dismissable: true,
      },
    );
    keymaps.destroy();
  });

  it("preserves wrapped watcher errors as literal details", () => {
    const filePath = "C:\\Projects\\[settings]\\keymap.json";
    const error = new Error("Unable to read _cache with `backticks`");
    spyOn(lumine.keymaps.notificationManager, "addError");
    const subscription = lumine.keymaps.subscribeToFileReadFailure();

    try {
      lumine.keymaps.emitter.emit("did-fail-to-read-file", { path: filePath, error });

      expect(lumine.keymaps.notificationManager.addError).toHaveBeenCalledOnceWith(
        "Failed to load the user keymap",
        { detail: `Path: ${filePath}\n${error.message}`, dismissable: true },
      );
    } finally {
      subscription.dispose();
    }
  });
});
