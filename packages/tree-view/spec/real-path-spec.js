const os = require("os");
const path = require("path");

const Directory = require("../lib/directory");
const File = require("../lib/file");
const fs = require("../lib/fs-compat");

function realPathError(code) {
  return Object.assign(new Error(`${code}: realpath failed`), { code });
}

function createFile(fullPath) {
  return new File({ name: path.basename(fullPath), fullPath, useSyncFS: false, stats: {} });
}

function createDirectory(fullPath) {
  return new Directory({
    name: path.basename(fullPath),
    fullPath,
    expansionState: {},
    ignoredNames: { matches: () => false },
    useSyncFS: false,
    stats: {},
  });
}

describe("TreeView real-path resolution", () => {
  it("does not warn when a file or directory disappears during resolution", () => {
    const warn = spyOn(console, "warn");
    const entries = [];
    let errorCode;
    spyOn(fs, "realpath").and.callFake((entryPath, callback) => callback(realPathError(errorCode)));

    for (const code of ["ENOENT", "ENOTDIR"]) {
      errorCode = code;
      const missingPath = path.join(os.tmpdir(), `tree-view-missing-${code}`);
      entries.push(createFile(missingPath), createDirectory(missingPath));
    }

    expect(warn).not.toHaveBeenCalled();
    for (const entry of entries) entry.destroy();
  });

  it("still warns about real filesystem failures", () => {
    const warn = spyOn(console, "warn");
    spyOn(fs, "realpath").and.callFake((entryPath, callback) => callback(realPathError("EACCES")));
    const file = createFile(path.join(os.tmpdir(), "tree-view-inaccessible"));

    expect(warn).toHaveBeenCalled();
    expect(warn.calls.mostRecent().args[0]).toContain("EACCES");
    file.destroy();
  });

  it("settles directory real-path loading after a stale-path error", async () => {
    spyOn(console, "warn");
    spyOn(fs, "realpath").and.callFake((entryPath, callback) => callback(realPathError("ENOENT")));
    const directory = createDirectory(path.join(os.tmpdir(), "tree-view-removed-directory"));

    await directory.loadRealPathPromise();

    expect(fs.realpath.calls.count()).toBe(2);
    directory.destroy();
  });
});
