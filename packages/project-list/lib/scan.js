/* global emit */

const { globSync } = require("tinyglobby");

// Lists the project directories under `dirPath`.
//
// This is a directory listing, not a file crawl, so it does not go through
// `atom.project.crawl()`: ripgrep only emits files. It stays a Task handler so
// a scan over a slow or deep root cannot stall the window.
module.exports = function (dirPath, scanList) {
  const entries = globSync(scanList, {
    cwd: dirPath,
    absolute: false,
    onlyDirectories: true,
    expandDirectories: false,
  });
  // A pattern ending in `/` matches with the separator still attached; the
  // caller joins these onto `dirPath`, so strip it. tinyglobby always reports
  // `/`, so only that is a separator here — a trailing backslash would be part
  // of a POSIX directory name.
  emit(
    "project-list:entries",
    entries.map((entry) => entry.replace(/\/+$/, "")),
  );
};
