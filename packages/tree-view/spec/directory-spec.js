const { Disposable } = require("atom");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Directory = require("../lib/directory");

function repositoryFor({ directoryStatusSummary = null } = {}) {
  return {
    getDirectoryStatusSummary: jasmine
      .createSpy("getDirectoryStatusSummary")
      .andReturn(directoryStatusSummary),
    getPathStatusSummary: jasmine.createSpy("getPathStatusSummary").andReturn(null),
    isPathIgnoredCached: jasmine.createSpy("isPathIgnoredCached").andReturn(false),
    getWorkingDirectory() {
      return null;
    },
    isSubmodule() {
      return false;
    },
    onDidChangeStatus() {
      return new Disposable();
    },
    onDidChangeStatuses() {
      return new Disposable();
    },
    onDidChangeStatusSnapshot() {
      return new Disposable();
    },
  };
}

function createDirectory(fullPath, repository, { isRoot = false, ignoredNames } = {}) {
  spyOn(atom.repositories, "getForPath").andReturn(repository);
  return new Directory({
    name: "repository",
    fullPath,
    isRoot,
    ignoredNames: ignoredNames ?? { matches: () => false },
    useSyncFS: true,
  });
}

describe("TreeView Directory decorations and Git status", () => {
  let directory;
  let temporaryDirectories;

  beforeEach(() => {
    temporaryDirectories = [];
  });

  function makeTemporaryDirectory(name) {
    const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    temporaryDirectories.push(directoryPath);
    return directoryPath;
  }

  afterEach(() => {
    directory?.destroy();
    for (const directoryPath of temporaryDirectories) {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it("colors a directory from the repository's directory status summary", () => {
    const directoryPath = makeTemporaryDirectory("summary-modified-directory");
    const repository = repositoryFor({
      directoryStatusSummary: { source: "cache", conflicted: false, modified: true, added: false },
    });

    directory = createDirectory(directoryPath, repository);

    expect(directory.status).toBe("modified");
    expect(repository.getDirectoryStatusSummary).toHaveBeenCalledWith(directoryPath);
  });

  it("gives conflicts priority over other states", () => {
    const directoryPath = makeTemporaryDirectory("summary-conflicted-directory");
    const repository = repositoryFor({
      directoryStatusSummary: {
        source: "snapshot",
        conflicted: true,
        modified: true,
        added: true,
      },
    });

    directory = createDirectory(directoryPath, repository);

    expect(directory.status).toBe("conflicted");
  });

  it("stays uncolored when the summary reports nothing below the directory", () => {
    const directoryPath = makeTemporaryDirectory("summary-clean-directory");
    const repository = repositoryFor({ directoryStatusSummary: null });

    directory = createDirectory(directoryPath, repository, { isRoot: true });

    expect(directory.status).toBeNull();
    expect(repository.getDirectoryStatusSummary).toHaveBeenCalledWith(directoryPath);
  });

  it("tracks core.ignoredNames separately from Git status", () => {
    const directoryPath = makeTemporaryDirectory("ignored-name-directory");
    const repository = repositoryFor({ directoryStatusSummary: null });

    directory = createDirectory(directoryPath, repository, {
      ignoredNames: { matches: (candidate) => candidate === directoryPath },
    });

    expect(directory.ignoredByName).toBe(true);
    expect(directory.status).toBeNull();
  });

  it("keeps the Git status of a directory whose path matches core.ignoredNames", () => {
    const directoryPath = makeTemporaryDirectory("ignored-name-modified-directory");
    const repository = repositoryFor({
      directoryStatusSummary: { source: "cache", conflicted: false, modified: true, added: false },
    });

    directory = createDirectory(directoryPath, repository, {
      ignoredNames: { matches: (candidate) => candidate === directoryPath },
    });

    expect(directory.ignoredByName).toBe(true);
    expect(directory.status).toBe("modified");
  });

  it("marks a visible child file whose path matches core.ignoredNames", () => {
    const directoryPath = makeTemporaryDirectory("ignored-name-child");
    const ignoredPath = path.join(directoryPath, "debug.log");
    fs.writeFileSync(ignoredPath, "ignored");
    const repository = repositoryFor({ directoryStatusSummary: null });

    directory = createDirectory(directoryPath, repository, {
      ignoredNames: { matches: (candidate) => candidate === ignoredPath },
    });
    directory.reload();

    expect(directory.entries.get("debug.log").ignoredByName).toBe(true);
  });
});
