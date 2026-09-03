const { requireModule } = require("./module-utils");
const focusTestWindow = require("./focus-test-window");
const { stopAllWatchers } = require("./path-watcher");
const { setTimeout: delay } = require("node:timers/promises");

const HEADLESS_TEARDOWN_TIMEOUT_MS = 5000;

const waitForHeadlessTeardown = (promise) =>
  Promise.race([promise, delay(HEADLESS_TEARDOWN_TIMEOUT_MS, undefined, { ref: false })]);

function cloneObject(object) {
  const clone = {};
  for (const key in object) {
    clone[key] = object[key];
  }
  return clone;
}

module.exports = async function ({ blobStore }) {
  const getWindowLoadSettings = require("./get-window-load-settings");
  const { ipcRenderer } = require("electron");
  let flushOutputStreams = () => Promise.resolve();
  const writeTestOutput = (stream, output, callback) => {
    try {
      ipcRenderer.sendSync("lumine:test-output", stream, String(output));
      if (typeof callback === "function") callback();
    } catch (error) {
      if (typeof callback === "function") callback(error);
    }
    return true;
  };
  const exitWithStatusCode = async (status) => {
    try {
      await waitForHeadlessTeardown(flushOutputStreams());
    } catch {
      status = 1;
    }
    ipcRenderer.sendSync("lumine:test-exit", "exit", status);
  };

  try {
    const path = require("path");
    const Environment = require("../src/environment");
    const ApplicationDelegate = require("../src/application-delegate");
    const Clipboard = require("../src/clipboard");
    const TextEditor = require("../src/text-editor");
    const { updateProcessEnv } = require("./update-process-env");

    ipcRenderer.on("environment", (event, env) => updateProcessEnv(env));

    const { testRunnerPath, legacyTestRunnerPath, headless, offscreen, logFile, testPaths, env } =
      getWindowLoadSettings();
    if (headless) {
      // Install console functions that output to stdout and stderr.
      const util = require("util");
      const { Writable } = require("stream");
      const createTestOutputStream = (name, fd) => {
        const stream = new Writable({
          write(output, _encoding, callback) {
            writeTestOutput(name, output, callback);
          },
        });
        // Child processes accept writable streams for stdio only when they
        // expose a real file descriptor. Preserve the renderer-to-main IPC
        // writes while allowing callers such as update-process-env to inherit
        // the runner's standard output handles on every platform.
        stream.fd = fd;
        stream.isTTY = false;
        return stream;
      };

      Object.defineProperties(process, {
        stdout: {
          value: createTestOutputStream("stdout", 1),
        },
        stderr: {
          value: createTestOutputStream("stderr", 2),
        },
      });
      flushOutputStreams = () =>
        Promise.all(
          [process.stdout, process.stderr].map(
            (stream) =>
              new Promise((resolve, reject) =>
                stream.write("", (error) => (error ? reject(error) : resolve())),
              ),
          ),
        );

      console.log = (...args) => process.stdout.write(`${util.format(...args)}\n`);
      console.error = (...args) => process.stderr.write(`${util.format(...args)}\n`);

      // Electron's offscreen compositor keeps local Windows command-line specs
      // rendering without displaying a native window. CI deliberately stays on
      // the normal compositor and takes focus: since Electron 43.2 an inactive
      // window's document no longer reports itself focused, and without it
      // every focus-dependent spec fails on the Linux and Windows runners. The
      // interactive runner and other local platforms retain showInactive().
      if (!offscreen) {
        if (process.env.CI) {
          await ipcRenderer.invoke("lumine:window", "show");
          await focusTestWindow();
        } else {
          await ipcRenderer.invoke("lumine:window", "showInactive");
        }
      }
    } else {
      // Show window synchronously so a focusout doesn't fire on input elements
      // that are focused in the very first spec run.
      await ipcRenderer.invoke("lumine:window", "show");
    }

    const handleKeydown = function (event) {
      // Reload: cmd-r / ctrl-r
      if ((event.metaKey || event.ctrlKey) && event.keyCode === 82) {
        ipcRenderer.invoke("lumine:window", "reload");
      }

      // Toggle Dev Tools: cmd-alt-i (Mac) / ctrl-shift-i (Linux/Windows)
      if (
        event.keyCode === 73 &&
        ((process.platform === "darwin" && event.metaKey && event.altKey) ||
          (process.platform !== "darwin" && event.ctrlKey && event.shiftKey))
      ) {
        ipcRenderer.invoke("lumine:window", "toggleDevTools");
      }

      // Close: cmd-w / ctrl-w
      if ((event.metaKey || event.ctrlKey) && event.keyCode === 87) {
        ipcRenderer.invoke("lumine:window", "close");
      }

      // Copy: cmd-c / ctrl-c
      if ((event.metaKey || event.ctrlKey) && event.keyCode === 67) {
        lumine.clipboard.write(window.getSelection().toString());
      }
    };

    window.addEventListener("keydown", handleKeydown, { capture: true });

    // Expose the bundled `exports/` folder (the `lumine` module) to spawned task
    // child processes via NODE_PATH so `require('lumine')` resolves inside tasks.
    const exportsPath = path.join(getWindowLoadSettings().resourcePath, "exports");
    process.env.NODE_PATH = exportsPath;

    updateProcessEnv(env);

    // Set up optional transpilation for packages under test if any
    document.title = "Spec Suite";

    const clipboard = new Clipboard();
    TextEditor.setClipboard(clipboard);
    TextEditor.viewForItem = (item) => lumine.views.getView(item);

    const testRunner = requireModule(testRunnerPath);
    const legacyTestRunner = require(legacyTestRunnerPath);
    const buildDefaultApplicationDelegate = () => new ApplicationDelegate();
    const buildEnvironment = function (params) {
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
      const lumineEnvironment = new Environment(params);
      lumineEnvironment.initialize(params);
      TextEditor.setScheduler(lumineEnvironment.views);
      // The editor component has its own scheduler hook; etch consumers (the
      // dock and bundled packages) need the view registry installed separately
      // so their updates stay coordinated during specs.
      require("@lumine-code/etch").setScheduler(lumineEnvironment.views);
      return lumineEnvironment;
    };

    const statusCode = await testRunner({
      logFile,
      headless,
      testPaths,
      buildEnvironment,
      buildDefaultApplicationDelegate,
      legacyTestRunner,
    });

    if (getWindowLoadSettings().headless) {
      // Package specs may create native file watchers that outlive their
      // buffers briefly. Stop the shared manager before flushing output and
      // asking Electron to exit, or a macOS watcher worker can keep an
      // otherwise-complete headless suite alive indefinitely.
      await waitForHeadlessTeardown(stopAllWatchers());
      await exitWithStatusCode(statusCode);
    }
  } catch (error) {
    if (getWindowLoadSettings().headless) {
      console.error(error.stack || error);
      await exitWithStatusCode(1);
    } else {
      throw error;
    }
  }
};
