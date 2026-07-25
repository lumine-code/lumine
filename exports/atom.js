const TextBuffer = require("../src/text-buffer");
const { Point, Range } = TextBuffer;
const { Emitter, Disposable, CompositeDisposable } = require("event-kit");
const BufferedNodeProcess = require("../src/buffered-node-process");
const BufferedProcess = require("../src/buffered-process");
const GitRepository = require("../src/git-repository");
const { GitError, LargeRepoError } = require("../src/git-error");
const { filterPatch } = require("../src/patch-filter");
const Notification = require("../src/notification");
const { watchPath, watchFile } = require("../src/path-watcher");

const atomExport = {
  BufferedNodeProcess,
  BufferedProcess,
  GitRepository,
  GitError,
  LargeRepoError,
  filterPatch,
  Notification,
  TextBuffer,
  Point,
  Range,
  Emitter,
  Disposable,
  CompositeDisposable,
  watchPath,
  watchFile,
};

// Absolute path to the bundled ripgrep binary, for packages that spawn their
// own searches or crawlers. Resolved lazily to stay snapshot-safe.
Object.defineProperty(atomExport, "ripgrepPath", {
  enumerable: true,
  get() {
    return require("../src/ripgrep").rgPath;
  },
});

// Shell integration is required by both Squirrel and Settings-View
if (process.platform === "win32") {
  Object.defineProperty(atomExport, "WinShell", {
    enumerable: true,
    get() {
      return require("../src/win-shell");
    },
  });
}

// The following classes can't be used from a Task handler and should therefore
// only be exported when not running as a child node process
if (process.type === "renderer") {
  atomExport.Task = require("../src/task");
  atomExport.TextEditor = require("../src/text-editor");
}

module.exports = atomExport;
