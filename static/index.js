(function () {
  // `util.setTraceSigInt` is a lazy getter whose module requires
  // `worker_threads`, and requiring `worker_threads` makes Node allocate a
  // SharedArrayBuffer — which Chromium reports in DevTools as a
  // cross-origin-isolation violation and a deprecation, once per window. The
  // getter fires whenever any ES module loaded through `require()` imports
  // `node:util`, because building the module facade snapshots every export
  // (@babel/core is such a module, so any cold transpile used to trip this).
  // Replace the getter with a function that defers the load to call time;
  // remove once Node loads `isMainThread` lazily in internal/util/trace_sigint.
  {
    const util = require("util");
    const descriptor = Object.getOwnPropertyDescriptor(util, "setTraceSigInt");
    if (descriptor?.get) {
      Object.defineProperty(util, "setTraceSigInt", {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: true,
        value: (...args) => descriptor.get.call(util)(...args),
      });
    }
  }

  // Define the window start time before the requires so we get a more accurate
  // window:start marker.
  const startWindowTime = Date.now();

  const electron = require("electron");
  const path = require("path");
  const getWindowLoadSettings = require("../src/get-window-load-settings");
  const StartupTime = require("../src/startup-time");
  const entryPointDirPath = __dirname;
  let blobStore = null;

  const bootstrapPromise = electron.ipcRenderer.invoke("lumine:window-bootstrap").then((data) => {
    getWindowLoadSettings.set(data.loadSettings);
    if (data.startupMarkers) StartupTime.importData(data.startupMarkers);
    StartupTime.addMarker("window:start", startWindowTime);
  });

  async function onWindowLoad() {
    try {
      await bootstrapPromise;
      StartupTime.addMarker("window:onload:start");
      const startTime = Date.now();
      await require("@lumine-code/second-mate").ready;

      process.on("unhandledRejection", function (error, promise) {
        console.error("Unhandled promise rejection %o with error: %o", promise, error);
      });

      // Normalize to make sure drive letter case is consistent on Windows
      process.resourcesPath = path.normalize(process.resourcesPath);

      setupLumineHome();

      // Persist V8 bytecode of compiled modules across launches to speed up
      // startup (supported replacement for the removed native-compile-cache).
      require("module").enableCompileCache?.(
        path.join(process.env.LUMINE_HOME, "compile-cache", "v8"),
      );

      const FileSystemBlobStore = require("../src/file-system-blob-store");
      blobStore = FileSystemBlobStore.load(path.join(process.env.LUMINE_HOME, "blob-store"));

      if (getWindowLoadSettings().profileStartup) {
        profileStartup(Date.now() - startTime);
      } else {
        const loadTime = Date.now() - startTime;
        StartupTime.addMarker("window:setup-window:start");
        await setupWindow();
        StartupTime.addMarker("window:setup-window:end");
        setLoadTime(loadTime);
      }
    } catch (error) {
      handleSetupError(error);
    }
    StartupTime.addMarker("window:onload:end");
  }

  if (document.readyState === "loading") {
    window.addEventListener("load", onWindowLoad, { once: true });
  } else {
    void onWindowLoad();
  }

  function setLoadTime(loadTime) {
    if (global.lumine) {
      global.lumine.setWindowLoadTime(loadTime);
    }
  }

  function handleSetupError(error) {
    electron.ipcRenderer
      .invoke("lumine:setup-error", error?.stack || String(error))
      .catch((ipcError) => console.error(ipcError));
    console.error(error.stack || error);
  }

  function setupWindow() {
    const CompileCache = require("../src/compile-cache");
    CompileCache.setLumineHomeDirectory(process.env.LUMINE_HOME);
    CompileCache.install(process.resourcesPath, require);

    const ModuleCache = require("../src/module-cache");
    ModuleCache.register(getWindowLoadSettings());

    const initScriptPath = path.relative(
      entryPointDirPath,
      getWindowLoadSettings().windowInitializationScript,
    );
    const initialize = require(initScriptPath);

    StartupTime.addMarker("window:initialize:start");

    return initialize({ blobStore: blobStore }).then(async function () {
      StartupTime.addMarker("window:initialize:end");
      await electron.ipcRenderer.invoke("lumine:window", "loaded");
    });
  }

  function profileStartup(initialTime) {
    function profile() {
      console.profile("startup");
      const startTime = Date.now();
      setupWindow()
        .then(function () {
          setLoadTime(Date.now() - startTime + initialTime);
          console.profileEnd("startup");
          console.log("Switch to the Profiles tab to view the created startup profile");
        })
        .catch(handleSetupError);
    }

    electron.ipcRenderer
      .invoke("lumine:profile-startup")
      .then(() => setTimeout(profile, 1000))
      .catch(handleSetupError);
  }

  function setupLumineHome() {
    if (process.env.LUMINE_HOME) {
      return;
    }

    // Ensure LUMINE_HOME is always set before anything else is required
    // This is because of a difference in Linux not inherited between browser and render processes
    if (getWindowLoadSettings() && getWindowLoadSettings().lumineHome) {
      process.env.LUMINE_HOME = getWindowLoadSettings().lumineHome;
    }
  }
})();
