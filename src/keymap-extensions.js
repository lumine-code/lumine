const fs = require("@lumine-code/fs-plus");
const path = require("path");
const KeymapManager = require("./keymap-manager");

const bundledKeymaps = require("../package.json").lumineMetadata?.keymaps;

KeymapManager.prototype.onDidLoadBundledKeymaps = function (callback) {
  return this.emitter.on("did-load-bundled-keymaps", callback);
};

KeymapManager.prototype.onDidLoadUserKeymap = function (callback) {
  return this.emitter.on("did-load-user-keymap", callback);
};

KeymapManager.prototype.canLoadBundledKeymapsFromMemory = function () {
  return bundledKeymaps != null;
};

KeymapManager.prototype.loadBundledKeymaps = function () {
  if (bundledKeymaps != null) {
    for (let keymapName in bundledKeymaps) {
      const keymap = bundledKeymaps[keymapName];
      const keymapPath = `core:${keymapName}`;
      this.add(keymapPath, keymap, 0, this.devMode != null ? this.devMode : false);
    }
  } else {
    const keymapsPath = path.join(this.resourcePath, "keymaps");
    this.loadKeymap(keymapsPath);
  }
  return this.emitter.emit("did-load-bundled-keymaps");
};

KeymapManager.prototype.getUserKeymapPath = function () {
  if (this.configDirPath == null) {
    return "";
  }
  // Joined rather than resolved: `fs.resolve` reports the real path, and on
  // macOS the config directory is usually reached through a symlinked temp or
  // home directory, so the answer would not be under `configDirPath`.
  for (const extension of ["json", "jsonc"]) {
    const candidate = path.join(this.configDirPath, `keymap.${extension}`);
    if (fs.isFileSync(candidate)) {
      return candidate;
    }
  }
  return path.join(this.configDirPath, "keymap.json");
};

KeymapManager.prototype.loadUserKeymap = function () {
  const userKeymapPath = this.getUserKeymapPath();
  if (!fs.isFileSync(userKeymapPath)) {
    return;
  }
  try {
    this.loadKeymap(userKeymapPath, { watch: true, suppressErrors: true, priority: 100 });
  } catch (error) {
    if (error.message.indexOf("Unable to watch path") > -1) {
      this.notificationManager.addError("Unable to watch the user keymap", {
        detail: `Path: ${userKeymapPath}\n${error.message}`,
        description:
          "Make sure you have permission to read the file. On Linux the per-user inotify watch limit is often too low. See the [troubleshooting guide](https://lumine-code.github.io/docs.html#troubleshooting/common-issues).",
        dismissable: true,
      });
    } else {
      const detail = `Path: ${error.path || userKeymapPath}\n${error.message}`;
      const stack = error.stack;
      this.notificationManager.addFatalError("Failed to load the user keymap", {
        detail,
        stack,
        reportTitle: error.message,
        sourcePath: error.path || userKeymapPath,
        dismissable: true,
      });
    }
  }
  return this.emitter.emit("did-load-user-keymap");
};

KeymapManager.prototype.subscribeToFileReadFailure = function () {
  return this.onDidFailToReadFile((failure) => {
    const error = failure.error ?? failure;
    const userKeymapPath = failure.path || this.getUserKeymapPath();
    const cause = error.location != null ? error.stack : error.message;
    this.notificationManager.addError("Failed to load the user keymap", {
      detail: `Path: ${userKeymapPath}\n${cause}`,
      dismissable: true,
    });
  });
};

module.exports = KeymapManager;
