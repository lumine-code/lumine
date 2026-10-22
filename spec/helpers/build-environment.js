const fs = require("@lumine-code/fs-plus");
const os = require("node:os");
const path = require("path");
const resolveSpecPackagePaths = require("./spec-package-paths");
const getWindowLoadSettings = require("../../src/get-window-load-settings");

const userHome = process.env.LUMINE_HOME || path.join(fs.getHomeDirectory(), ".lumine");
// This home belongs to the entire spec window. Per-spec temp.cleanupSync()
// must not remove the provisioned package links from underneath later specs.
const lumineHome = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-test-home-"));
const { testPaths, resourcePath } = getWindowLoadSettings();
const specPackages = resolveSpecPackagePaths({
  testPaths,
  userHome,
  resourcePath,
  extraNames: (process.env.LUMINE_TEST_PACKAGES || "").split(/\s+/).filter(Boolean),
});
if (specPackages.packages.size) {
  fs.makeTreeSync(path.join(lumineHome, "packages"));
  for (const [packName, userPack] of specPackages.packages) {
    const loadablePack = path.join(lumineHome, "packages", packName);

    try {
      fs.symlinkSync(userPack, loadablePack, process.platform === "win32" ? "junction" : "dir");
    } catch {
      fs.copySync(userPack, loadablePack);
    }
  }
}

const ApplicationDelegate = require("../../src/application-delegate");
const applicationDelegate = new ApplicationDelegate();
applicationDelegate.setRepresentedFilename = function () {};
applicationDelegate.setWindowDocumentEdited = function () {};

exports.lumineHome = lumineHome;
exports.applicationDelegate = applicationDelegate;
exports.specPackages = specPackages;
