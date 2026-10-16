const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/fs-temp");
const path = require("path");
const resolveSpecPackagePaths = require("./spec-package-paths");
const getWindowLoadSettings = require("../../src/get-window-load-settings");

const userHome = process.env.LUMINE_HOME || path.join(fs.getHomeDirectory(), ".lumine");
const lumineHome = temp.mkdirSync({ prefix: "lumine-test-home-" });
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
