const ipcHelpers = require("./ipc-helpers");
const { requireModule } = require("./module-utils");
const focusTestWindow = require("./focus-test-window");

function cloneObject(object) {
  const clone = {};
  for (const key in object) {
    clone[key] = object[key];
  }
  return clone;
}

module.exports = async function ({ blobStore }) {
  const remote = require("@electron/remote");
  const getWindowLoadSettings = require("./get-window-load-settings");

  const exitWithStatusCode = function (status) {
    remote.app.emit("will-quit");
    remote.process.exit(status);
  };

  try {
    const path = require("path");
    const { ipcRenderer } = require("electron");
    const CompileCache = require("./compile-cache");
    const AtomEnvironment = require("../src/atom-environment");
    const ApplicationDelegate = require("../src/application-delegate");
    const Clipboard = require("../src/clipboard");
    const TextEditor = require("../src/text-editor");
    const { updateProcessEnv } = require("./update-process-env");
    require("./electron-shims");

    ipcRenderer.on("environment", (event, env) => updateProcessEnv(env));

    const { testRunnerPath, legacyTestRunnerPath, headless, logFile, testPaths, env } =
      getWindowLoadSettings();

    if (headless) {
      // Install console functions that output to stdout and stderr.
      const util = require("util");

      Object.defineProperties(process, {
        stdout: { value: remote.process.stdout },
        stderr: { value: remote.process.stderr },
      });

      console.log = (...args) => process.stdout.write(`${util.format(...args)}\n`);
      console.error = (...args) => process.stderr.write(`${util.format(...args)}\n`);

      // The window must still be shown: this Chromium serves a natively hidden
      // window's requestAnimationFrame from a ~1 Hz synthetic tick source
      // (regardless of `backgroundThrottling: false`), which starves specs that
      // await real animation frames. On CI there is no user to disturb, so take
      // focus: since Electron 43.2 an inactive window's document no longer
      // reports itself focused, and without it every focus-dependent spec fails
      // on the Linux and Windows runners. Locally, show without stealing focus
      // from whatever the developer is doing; the specs that genuinely need it
      // are declared with `jasmine.itWithDocumentFocus`/`describeWithDocumentFocus`
      // and report themselves pending instead of failing (see
      // spec/helpers/document-focus.js).
      const currentWindow = remote.getCurrentWindow();
      if (process.env.CI) {
        currentWindow.show();
        await focusTestWindow();
      } else {
        currentWindow.showInactive();
      }
    } else {
      // Show window synchronously so a focusout doesn't fire on input elements
      // that are focused in the very first spec run.
      remote.getCurrentWindow().show();
    }

    const handleKeydown = function (event) {
      // Reload: cmd-r / ctrl-r
      if ((event.metaKey || event.ctrlKey) && event.keyCode === 82) {
        ipcHelpers.call("window-method", "reload");
      }

      // Toggle Dev Tools: cmd-alt-i (Mac) / ctrl-shift-i (Linux/Windows)
      if (
        event.keyCode === 73 &&
        ((process.platform === "darwin" && event.metaKey && event.altKey) ||
          (process.platform !== "darwin" && event.ctrlKey && event.shiftKey))
      ) {
        ipcHelpers.call("window-method", "toggleDevTools");
      }

      // Close: cmd-w / ctrl-w
      if ((event.metaKey || event.ctrlKey) && event.keyCode === 87) {
        ipcHelpers.call("window-method", "close");
      }

      // Copy: cmd-c / ctrl-c
      if ((event.metaKey || event.ctrlKey) && event.keyCode === 67) {
        atom.clipboard.write(window.getSelection().toString());
      }
    };

    window.addEventListener("keydown", handleKeydown, { capture: true });

    // Expose the bundled `exports/` folder (the `atom` module) to spawned task
    // child processes via NODE_PATH so `require('atom')` resolves inside tasks.
    const exportsPath = path.join(getWindowLoadSettings().resourcePath, "exports");
    process.env.NODE_PATH = exportsPath;

    updateProcessEnv(env);

    // Set up optional transpilation for packages under test if any
    const FindParentDir = require("./find-parent-dir");
    const packageRoot = FindParentDir.sync(testPaths[0], "package.json");
    if (packageRoot) {
      const packageMetadata = require(path.join(packageRoot, "package.json"));
      if (packageMetadata.atomTranspilers) {
        CompileCache.addTranspilerConfigForPath(
          packageRoot,
          packageMetadata.name,
          packageMetadata,
          packageMetadata.atomTranspilers,
        );
      }
    }

    document.title = "Spec Suite";

    const clipboard = new Clipboard();
    TextEditor.setClipboard(clipboard);
    TextEditor.viewForItem = (item) => atom.views.getView(item);

    const testRunner = requireModule(testRunnerPath);
    const legacyTestRunner = require(legacyTestRunnerPath);
    const buildDefaultApplicationDelegate = () => new ApplicationDelegate();
    const buildAtomEnvironment = function (params) {
      params = cloneObject(params);
      if (!Object.hasOwn(params, "clipboard")) {
        params.clipboard = clipboard;
      }
      if (!Object.hasOwn(params, "blobStore")) {
        params.blobStore = blobStore;
      }
      if (!Object.hasOwn(params, "onlyLoadBaseStyleSheets")) {
        params.onlyLoadBaseStyleSheets = true;
      }
      const atomEnvironment = new AtomEnvironment(params);
      atomEnvironment.initialize(params);
      TextEditor.setScheduler(atomEnvironment.views);
      // The editor component has its own scheduler hook; etch consumers (the
      // dock and bundled packages) need the view registry installed separately
      // so their updates stay coordinated during specs.
      require("@lumine-code/etch").setScheduler(atomEnvironment.views);
      return atomEnvironment;
    };

    const statusCode = await testRunner({
      logFile,
      headless,
      testPaths,
      buildAtomEnvironment,
      buildDefaultApplicationDelegate,
      legacyTestRunner,
    });

    if (getWindowLoadSettings().headless) {
      exitWithStatusCode(statusCode);
    }
  } catch (error) {
    if (getWindowLoadSettings().headless) {
      console.error(error.stack || error);
      exitWithStatusCode(1);
    } else {
      throw error;
    }
  }
};
