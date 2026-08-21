const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp");
const path = require("path");

const userHome = process.env.LUMINE_HOME || path.join(fs.getHomeDirectory(), ".lumine");
const lumineHome = temp.mkdirSync({ prefix: "lumine-test-home-" });
if (process.env.LUMINE_TEST_PACKAGES) {
  const testPackages = process.env.LUMINE_TEST_PACKAGES.split(/\s+/);
  fs.makeTreeSync(path.join(lumineHome, "packages"));
  for (let packName of Array.from(testPackages)) {
    const userPack = path.join(userHome, "packages", packName);
    const loadablePack = path.join(lumineHome, "packages", packName);

    try {
      fs.symlinkSync(userPack, loadablePack, "dir");
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
