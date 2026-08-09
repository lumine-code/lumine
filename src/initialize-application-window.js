const LumineEnvironment = require("./lumine-environment");
const ApplicationDelegate = require("./application-delegate");
const Clipboard = require("./clipboard");
const TextEditor = require("./text-editor");

require("./text-editor-component");
require("./file-system-blob-store");
require("./compile-cache");
require("./module-cache");

const clipboard = new Clipboard();
TextEditor.setClipboard(clipboard);
TextEditor.viewForItem = (item) => lumine.views.getView(item);

global.lumine = new LumineEnvironment({
  clipboard,
  applicationDelegate: new ApplicationDelegate(),
  enablePersistence: true,
});

TextEditor.setScheduler(global.lumine.views);
// The editor component has its own scheduler hook; etch consumers (the dock
// and bundled packages) need the view registry installed separately so their
// updates stay coordinated with the editor's read/write batching.
require("@lumine-code/etch").setScheduler(global.lumine.views);

// Like sands through the hourglass, so are the days of our lives.
module.exports = function ({ blobStore }) {
  const { updateProcessEnv } = require("./update-process-env");
  const path = require("path");
  require("./window");
  const getWindowLoadSettings = require("./get-window-load-settings");
  const { ipcRenderer } = require("electron");
  const { resourcePath, devMode } = getWindowLoadSettings();

  // Expose the bundled `exports/` folder (the `lumine` module) to spawned task
  // child processes via NODE_PATH so `require('lumine')` resolves inside tasks.
  const exportsPath = path.join(resourcePath, "exports");
  process.env.NODE_PATH = exportsPath;

  // Make React faster
  if (!devMode && process.env.NODE_ENV == null) {
    process.env.NODE_ENV = "production";
  }

  global.lumine.initialize({
    window,
    document,
    blobStore,
    configDirPath: process.env.LUMINE_HOME,
    env: process.env,
  });

  return global.lumine.startEditorWindow().then(function () {
    // Workaround for focus getting cleared upon window creation
    const windowFocused = function () {
      window.removeEventListener("focus", windowFocused);
      setTimeout(() => document.querySelector("lumine-workspace").focus(), 0);
    };
    window.addEventListener("focus", windowFocused);

    ipcRenderer.on("environment", (event, env) => updateProcessEnv(env));
  });
};
