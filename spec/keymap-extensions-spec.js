const temp = require("@lumine-code/temp").track();
const fs = require("@lumine-code/fs-plus");
const path = require("path");

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
});
