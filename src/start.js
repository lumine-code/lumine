const { app, crashReporter } = require("electron");
const path = require("path");
const temp = require("@lumine-code/temp");
const parseCommandLine = require("./parse-command-line");
const { getAppArguments } = require("./parse-command-line-options");
const { getReleaseChannel, getConfigFilePath } = require("./get-app-details.js");
const luminePaths = require("./lumine-paths");
const CSON = require("@lumine-code/season");
const Config = require("./config");
const StartupTime = require("./startup-time");

StartupTime.setStartTime();

module.exports = function start(resourcePath, devResourcePath, startTime) {
  global.shellStartTime = startTime;
  StartupTime.addMarker("main-process:start");

  process.on("uncaughtException", function (error = {}) {
    if (error.message != null) {
      console.log(error.message);
    }

    if (error.stack != null) {
      console.log(error.stack);
    }
  });

  process.on("unhandledRejection", function (error = {}) {
    if (error.message != null) {
      console.log(error.message);
    }

    if (error.stack != null) {
      console.log(error.stack);
    }
  });

  app.commandLine.appendSwitch("enable-experimental-web-platform-features");

  // Without this feature a page that is not cross-origin isolated gets legacy
  // SharedArrayBuffer treatment: the global is hidden and `postMessage`
  // refuses to transfer one, even though Node modules like `worker_threads`
  // still create SABs internally. The renderer runs trusted code with full
  // Node access, so isolation would buy nothing — enable SAB outright. Note
  // that no flag suppresses the DevTools issue a SAB construction files in a
  // non-isolated page (that gate is reserved for extension schemes); only not
  // constructing one does. Chromium honours only the last `enable-features`
  // switch, so future features must merge into this one.
  app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");

  const args = parseCommandLine(
    getAppArguments(process.argv, { defaultApp: process.defaultApp, appPath: app.getAppPath() }),
  );

  args.resourcePath = normalizeDriveLetterName(resourcePath);
  args.devResourcePath = normalizeDriveLetterName(devResourcePath);

  // Specs drive rendering through requestAnimationFrame promises. Chromium
  // treats an occluded or backgrounded window as invisible and stops
  // compositing it even with `backgroundThrottling: false`, stalling animation
  // frames for seconds and timing out whichever spec happens to be running.
  // (The former `CalculateNativeWinOcclusion` feature flag no longer exists in
  // this Chromium; these switches are its maintained replacements.)
  //
  // A headless CI machine has no GPU, and Chromium blocklists WebGL against the
  // software renderer it falls back to. A package that draws through WebGL then
  // gets a null context rather than a slow one, and every spec that renders
  // fails for a reason that has nothing to do with the package. Both switches
  // only lift that gate — neither forces software rendering, so a run on a
  // machine with a working GPU still uses it.
  if (args.test) {
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-background-timer-throttling");
    app.commandLine.appendSwitch("ignore-gpu-blocklist");
    app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  }

  const releaseChannel = getReleaseChannel(app.getVersion());
  process.env.LUMINE_CHANNEL ??= releaseChannel;
  luminePaths.setLumineHome(app.getPath("home"));
  luminePaths.setUserData(app);

  // Headless package-management commands (--install, --uninstall, --list,
  // --link, --unlink). Run the command and exit without opening a window.
  if (args.packageCommand) {
    const { runPackageCommand } = require("./package-cli");
    runPackageCommand(args.packageCommand).then((code) => process.exit(code));
    return;
  }

  // Seed a fresh `LUMINE_HOME` from the bundled default config template. This has
  // to happen before the compile cache and crash reporter below, since both
  // create `LUMINE_HOME` as a side effect and would otherwise leave a new install
  // unseeded.
  luminePaths.seedUserConfig(args.resourcePath);

  // Persist V8 bytecode of compiled modules across launches to speed up startup.
  require("module").enableCompileCache?.(
    path.resolve(process.env.LUMINE_HOME, "compile-cache", "v8"),
  );

  // Now that we can be sure `LUMINE_HOME` is set, we can set our custom crash
  // dump path.
  app.setPath("crashDumps", path.resolve(process.env.LUMINE_HOME, "crashdumps"));

  // By default, we're using the crash reporter on Windows and Linux, but not
  // macOS. That's because:
  //
  // * macOS already generates great crash reports with stacktraces
  //   (Console.app -> Crash Reports);
  // * if we enable crash reporting, thse crash reports stop being generated,
  //   even when `ignoreSystemCrashHandler` is `false`.
  //
  // Still, it's nice to have a way to opt into the crash reporter even on
  // macOS. Hence the `--crashdump` command-line switch.
  let shouldStartCrashReporter = args.useCrashReporter || process.platform !== "darwin";
  if (shouldStartCrashReporter) {
    console.log(
      "Starting crash reporter; crash reports will be saved to",
      app.getPath("crashDumps"),
    );
    crashReporter.start({
      productName: "Lumine",
      companyName: "lumine-code",
      submitURL: "",
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
      compress: false,
    });
  }

  const config = getConfig();
  const colorProfile = config.get("core.colorProfile");
  if (colorProfile && colorProfile !== "default") {
    app.commandLine.appendSwitch("force-color-profile", colorProfile);
  }

  if (args.test && args.mainProcess) {
    // Jasmine owns this process's lifetime: it reports, then calls
    // process.exit. Electron's default when the last window closes is to quit
    // the app, and the spec that exercises a real BrowserWindow closes it
    // mid-suite — without a subscriber that default quit races jasmine, and
    // when it wins the runner dies with Chromium's exit code and no report.
    // Subscribing makes closing the last window a non-event.
    app.on("window-all-closed", () => {});
    app.setPath("userData", temp.mkdirSync("lumine-user-data-dir-for-main-process-tests"));
    app.on("ready", function () {
      const testRunner = require(
        path.join(args.resourcePath, "spec/main-process/jasmine-test-runner"),
      );
      testRunner(args.pathsToOpen);
    });
    return;
  }

  let appUserModelId = "io.github.lumine-code.lumine." + process.arch;

  // If the release channel is not stable, we append it to the app user model id.
  // This allows having the different release channels as separate items in the taskbar.
  if (releaseChannel !== "stable") {
    appUserModelId += `-${releaseChannel}`;
  }

  // NB: This prevents Win10 from showing dupe items in the taskbar.
  app.setAppUserModelId(appUserModelId);

  // Lumine uses a custom mechanism for ensuring a single instance, so we don't
  // need `app.requestSingleInstanceLock()`. But we call this method on Windows
  // anyway in order to benefit from a side effect.
  //
  // Windows doesn't like it when applications try to move themselves to the
  // front unilaterally. There are certain escape hatches, though; one process
  // can give another process specific permission for the latter process to
  // foreground itself while the former process is active.
  //
  // This happens automatically as part of the `requestSingleInstanceLock`
  // machinery. Hence we ask for a single-instance lock on startup so that the
  // _second_ instance, when the request is denied, will trigger the side
  // effect that allows the original instance to foreground itself.
  //
  // The effects are not seen here, but rather in `lumine-application.js`, where
  // calls to `app.focus` will actually work instead of having no effect.
  if (process.platform === "win32") {
    app.requestSingleInstanceLock();
    // Add an explicit no-op listener here to ensure that this channel isn't
    // used for communication — we already have a way for the second instance
    // to communicate with the first.
    app.on("second-instance", () => {});
  }

  function addPathToOpen(event, pathToOpen) {
    event.preventDefault();
    args.pathsToOpen.push(pathToOpen);
  }

  function addUrlToOpen(event, urlToOpen) {
    event.preventDefault();
    args.urlsToOpen.push(urlToOpen);
  }

  app.on("open-file", addPathToOpen);
  app.on("open-url", addUrlToOpen);

  if (args.userDataDir != null) {
    app.setPath("userData", args.userDataDir);
  } else if (args.test) {
    app.setPath("userData", temp.mkdirSync("lumine-test-data"));
  }

  StartupTime.addMarker("main-process:electron-onready:start");
  app.on("ready", function () {
    StartupTime.addMarker("main-process:electron-onready:end");
    app.removeListener("open-file", addPathToOpen);
    app.removeListener("open-url", addUrlToOpen);
    StartupTime.addMarker("main-process:lumine-application:require:start");
    const LumineApplication = require(path.join(args.resourcePath, "src", "lumine-application"));
    StartupTime.addMarker("main-process:lumine-application:require:end");
    LumineApplication.open(args);
  });
};

function getConfig() {
  const config = new Config();

  let configFilePath = getConfigFilePath();

  if (configFilePath) {
    CSON.readFile(configFilePath, (error, data) => {
      // Duplicated from `./src/config-file.js`.reload()
      if (error) {
        console.log(error.message);
      } else {
        config.resetUserSettings(data);
      }
    });
  }

  return config;
}

function normalizeDriveLetterName(filePath) {
  if (process.platform === "win32" && filePath) {
    return filePath.replace(/^([a-z]):/, ([driveLetter]) => driveLetter.toUpperCase() + ":");
  } else {
    return filePath;
  }
}
