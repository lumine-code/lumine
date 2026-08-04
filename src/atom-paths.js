const fs = require("@lumine-code/fs-plus");
const path = require("path");

const hasWriteAccess = (dir) => {
  const testFilePath = path.join(dir, "write.test");
  try {
    fs.writeFileSync(testFilePath, new Date().toISOString(), { flag: "w+" });
    fs.unlinkSync(testFilePath);
    return true;
  } catch {
    return false;
  }
};

const getAppDirectory = () => {
  switch (process.platform) {
    case "darwin":
      return process.execPath.substring(0, process.execPath.indexOf(".app") + 4);
    case "linux":
    case "win32":
      return path.join(process.execPath, "..");
  }
};

module.exports = {
  setAtomHome: (homePath) => {
    // When a read-writeable `.lumine` folder exists above the app directory,
    // use that. The portability means that we don't have to use a different
    // name to distinguish the release channel.
    const portableHomePath = path.join(getAppDirectory(), "..", ".lumine");
    if (fs.existsSync(portableHomePath)) {
      if (hasWriteAccess(portableHomePath)) {
        process.env.LUMINE_HOME = portableHomePath;
      } else {
        // A path exists so it was intended to be used but we didn't have rights, so warn.
        console.log(`Insufficient permission to portable Lumine home "${portableHomePath}".`);
      }
    }

    // Check the `LUMINE_HOME` environment variable next.
    if (process.env.LUMINE_HOME !== undefined) {
      return;
    }

    // We fall back to a `.lumine` folder in the user's home folder.
    //
    // On macOS and Linux, `LUMINE_HOME` gets set in `lumine.sh`, so we'd only get
    // this far if the user launched via a non-shell method. On Windows, we
    // don’t try to set `LUMINE_HOME` in `lumine.cmd`, so we'll always get this
    // far.
    //
    process.env.LUMINE_HOME = path.join(homePath, ".lumine");
  },

  setUserData: (app) => {
    const electronUserDataPath = path.join(process.env.LUMINE_HOME, "electronUserData");
    if (fs.existsSync(electronUserDataPath)) {
      if (hasWriteAccess(electronUserDataPath)) {
        app.setPath("userData", electronUserDataPath);
      } else {
        // A path exists so it was intended to be used but we didn't have rights, so warn.
        console.log(`Insufficient permission to Electron user data "${electronUserDataPath}".`);
      }
    }
  },

  // Seed a brand-new `LUMINE_HOME` with the bundled default config (`dot-lumine`:
  // init script, keymap, snippets, styles, packages README). This must run
  // before anything else — the compile cache and crash reporter both create
  // `LUMINE_HOME` as a side effect, which would otherwise defeat the "does the
  // config folder exist yet?" check and leave a fresh install unseeded.
  seedUserConfig: (resourcePath) => {
    const configDirPath = process.env.LUMINE_HOME;
    if (fs.existsSync(configDirPath)) {
      return;
    }

    const templateConfigDirPath = fs.resolve(resourcePath, "dot-lumine");
    if (templateConfigDirPath) {
      fs.copySync(templateConfigDirPath, configDirPath);
    }
  },

  getAppDirectory,
};
