const luminePaths = require("../src/lumine-paths");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const temp = require("@lumine-code/temp").track();

const appPathValues = new Map([
  ["home", lumine.application.getPath("home")],
  ["userData", lumine.application.getPath("userData")],
]);
const app = {
  getPath(name) {
    return appPathValues.get(name);
  },
  setPath(name, value) {
    appPathValues.set(name, value);
  },
};

describe("LuminePaths", () => {
  let appDirectory;
  let originalLumineHome;
  let portableLumineHomePath;

  beforeEach(() => {
    originalLumineHome = process.env.LUMINE_HOME;
    const appRoot = temp.mkdirSync("lumine-paths-spec-app");
    appDirectory = path.join(appRoot, "app");
    fs.mkdirSync(appDirectory);
    portableLumineHomePath = path.join(appRoot, ".lumine");
  });

  afterEach(() => {
    if (originalLumineHome === undefined) delete process.env.LUMINE_HOME;
    else process.env.LUMINE_HOME = originalLumineHome;
  });

  describe("SetLumineHomePath", () => {
    describe("when a portable .lumine folder exists", () => {
      beforeEach(() => {
        delete process.env.LUMINE_HOME;
        if (!fs.existsSync(portableLumineHomePath)) {
          fs.mkdirSync(portableLumineHomePath);
        }
      });

      afterEach(() => {
        delete process.env.LUMINE_HOME;
        fs.removeSync(portableLumineHomePath);
      });

      it("sets LUMINE_HOME to the portable .lumine folder if it has permission", () => {
        luminePaths.setLumineHome(app.getPath("home"), appDirectory);
        expect(process.env.LUMINE_HOME).toEqual(portableLumineHomePath);
      });

      if (process.platform !== "win32") {
        it("uses LUMINE_HOME if no write access to portable .lumine folder", () => {
          const readOnlyPath = temp.mkdirSync("lumine-path-spec-no-write-access");
          process.env.LUMINE_HOME = readOnlyPath;
          fs.chmodSync(portableLumineHomePath, 0o444);
          luminePaths.setLumineHome(app.getPath("home"), appDirectory);
          expect(process.env.LUMINE_HOME).toEqual(readOnlyPath);
        });
      }
    });

    describe("when a portable folder does not exist", () => {
      beforeEach(() => {
        delete process.env.LUMINE_HOME;
        fs.removeSync(portableLumineHomePath);
      });

      afterEach(() => {
        delete process.env.LUMINE_HOME;
      });

      it("leaves LUMINE_HOME unmodified if it was already set", () => {
        const temporaryHome = temp.mkdirSync("lumine-spec-setluminehomepath");
        process.env.LUMINE_HOME = temporaryHome;
        luminePaths.setLumineHome(app.getPath("home"), appDirectory);
        expect(process.env.LUMINE_HOME).toEqual(temporaryHome);
      });

      it("sets LUMINE_HOME to a default location if not yet set", () => {
        const expectedPath = path.join(app.getPath("home"), ".lumine");
        luminePaths.setLumineHome(app.getPath("home"), appDirectory);
        expect(process.env.LUMINE_HOME).toEqual(expectedPath);
      });
    });
  });

  describe("setUserData", () => {
    let tempLumineConfigPath = null;
    let tempLumineHomePath = null;
    let electronUserDataPath = null;
    let defaultElectronUserDataPath = null;

    beforeEach(() => {
      defaultElectronUserDataPath = app.getPath("userData");
      delete process.env.LUMINE_HOME;
      tempLumineHomePath = temp.mkdirSync("lumine-paths-specs-userdata-home");
      tempLumineConfigPath = path.join(tempLumineHomePath, ".lumine");
      fs.mkdirSync(tempLumineConfigPath);
      electronUserDataPath = path.join(tempLumineConfigPath, "electronUserData");
      luminePaths.setLumineHome(tempLumineHomePath, appDirectory);
    });

    afterEach(() => {
      delete process.env.LUMINE_HOME;
      fs.removeSync(electronUserDataPath);
      try {
        temp.cleanupSync();
      } catch {
        // Ignore
      }
      app.setPath("userData", defaultElectronUserDataPath);
    });

    describe("when an electronUserData folder exists", () => {
      it("sets userData path to the folder if it has permission", () => {
        fs.mkdirSync(electronUserDataPath);
        luminePaths.setUserData(app);
        expect(app.getPath("userData")).toEqual(electronUserDataPath);
      });

      if (process.platform !== "win32") {
        it("leaves userData unchanged if no write access to electronUserData folder", () => {
          fs.mkdirSync(electronUserDataPath);
          // Octal modes: the decimal literals used previously produced modes
          // without owner write/execute, so the folder could never be cleaned up.
          fs.chmodSync(electronUserDataPath, 0o444);
          luminePaths.setUserData(app);
          fs.chmodSync(electronUserDataPath, 0o755);
          expect(app.getPath("userData")).toEqual(defaultElectronUserDataPath);
        });
      }
    });

    describe("when an electronUserDataPath folder does not exist", () => {
      it("leaves userData app path unchanged", () => {
        luminePaths.setUserData(app);
        expect(app.getPath("userData")).toEqual(defaultElectronUserDataPath);
      });
    });
  });
});
