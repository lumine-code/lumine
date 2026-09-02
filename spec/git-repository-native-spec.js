const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const GitRepository = require("../src/git-repository");

function copyRepository() {
  const workingDirectory = temp.mkdirSync("lumine-native-snapshot-spec");
  fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
  fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
  return workingDirectory;
}

const statusValue = (generation) => ({
  schemaVersion: 1,
  generation,
  initialized: true,
  includesIgnored: true,
  head: { oid: "a".repeat(40), name: "main", detached: false, unborn: false },
  upstream: null,
  files: [],
  counts: { total: 0, staged: 0, unstaged: 0, conflicted: 0, untracked: 0, ignored: 0 },
});

const refsValue = (generation) => ({
  schemaVersion: 1,
  generation,
  initialized: true,
  head: {
    oid: "a".repeat(40),
    ref: "refs/heads/main",
    name: "main",
    detached: false,
    unborn: false,
  },
  branches: [],
  remoteBranches: [],
  tags: [],
  remotes: [],
  worktrees: [],
});

describe("GitRepository native facade", () => {
  let repo;

  afterEach(() => {
    if (repo && !repo.isDestroyed()) repo.destroy();
  });

  it("combines status and refs requests and reuses native fingerprints", async () => {
    const calls = [];
    const snapshotProvider = {
      async getSnapshot(descriptor, request) {
        calls.push({ descriptor, request });
        const result = {};
        if (request.status) {
          result.status = request.knownFingerprints.status
            ? { fingerprint: "status-fingerprint", unchanged: true }
            : {
                fingerprint: "status-fingerprint",
                unchanged: false,
                value: statusValue(request.generations.status),
              };
        }
        if (request.refs) {
          result.refs = request.knownFingerprints.refs
            ? { fingerprint: "refs-fingerprint", unchanged: true }
            : {
                fingerprint: "refs-fingerprint",
                unchanged: false,
                value: refsValue(request.generations.refs),
              };
        }
        return result;
      },
    };
    repo = new GitRepository(copyRepository(), { snapshotProvider });
    const statusChanged = jasmine.createSpy("status changed");
    const refsChanged = jasmine.createSpy("refs changed");
    repo.onDidChangeStatusSnapshot(statusChanged);
    repo.onDidChangeRefsSnapshot(refsChanged);

    const [status, refs] = await Promise.all([
      repo.refreshStatusSnapshot(),
      repo.refreshRefsSnapshot(),
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].request.status).toBe(true);
    expect(calls[0].request.refs).toBe(true);
    expect(calls[0].descriptor).toEqual({
      gitDirectory: repo.getPath(),
      workingDirectory: repo.getWorkingDirectory(),
      hasSubmodules: false,
      submodulePaths: [],
    });
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(refs)).toBe(true);
    expect(statusChanged.calls.count()).toBe(1);
    expect(refsChanged.calls.count()).toBe(1);

    await Promise.all([repo.refreshStatusSnapshot(), repo.refreshRefsSnapshot()]);
    expect(calls.length).toBe(2);
    expect(calls[1].request.knownFingerprints).toEqual({
      status: "status-fingerprint",
      refs: "refs-fingerprint",
    });
    expect(statusChanged.calls.count()).toBe(1);
    expect(refsChanged.calls.count()).toBe(1);
  });

  it("exposes declared submodules in every RPC descriptor", () => {
    const workingDirectory = copyRepository();
    fs.writeFileSync(
      path.join(workingDirectory, ".gitmodules"),
      '[submodule "library"]\n\tpath = vendor/library\n\turl = ../library.git\n',
    );
    repo = new GitRepository(workingDirectory);

    expect(repo.getNativeDescriptor()).toEqual({
      gitDirectory: repo.getPath(),
      workingDirectory: repo.getWorkingDirectory(),
      hasSubmodules: true,
      submodulePaths: ["vendor/library"],
    });
  });

  it("batches config keys and fills omitted values with null", async () => {
    const getConfigValues = jasmine
      .createSpy("get config values")
      .and.resolveTo({ "user.name": "Lumine" });
    repo = new GitRepository(copyRepository(), { configProvider: { getConfigValues } });

    const values = await repo.getConfigValuesAsync(["user.name", "user.email"]);
    expect(values).toEqual({ "user.name": "Lumine", "user.email": null });
    expect(getConfigValues.calls.argsFor(0)[1]).toEqual(["user.name", "user.email"]);
  });

  it("reads an explicit stage-0 index object through the native history provider", async () => {
    const getIndexFile = jasmine.createSpy("get index file").and.resolveTo("staged contents\n");
    repo = new GitRepository(copyRepository(), { historyProvider: { getIndexFile } });

    expect(await repo.getIndexFile("nested/staged.txt")).toBe("staged contents\n");
    expect(getIndexFile.calls.argsFor(0)).toEqual([
      repo.getNativeDescriptor(),
      "nested/staged.txt",
      { encoding: "utf8", signal: undefined },
    ]);
  });

  it("forwards empty-to-index and empty-to-commit diffs in every result format", async () => {
    const requests = [];
    const diffProvider = {
      async getDiff(descriptor, request) {
        requests.push(request);
        return {
          schemaVersion: 1,
          files: request.format === "patch" ? [] : [],
          ...(request.format === "structured" ? {} : { rawPatch: "diff --git a/a b/a\n" }),
        };
      },
    };
    repo = new GitRepository(copyRepository(), { diffProvider });

    await repo.getDiff({ from: { type: "empty" }, to: { type: "index" } });
    await repo.getDiff({
      from: { type: "empty" },
      to: { type: "commit", revision: "HEAD" },
      format: "both",
    });
    const patch = await repo.getDiff({
      from: { type: "empty" },
      to: { type: "index" },
      format: "patch",
    });

    expect(requests.map(({ from, to, format }) => [from.type, to.type, format])).toEqual([
      ["empty", "index", "structured"],
      ["empty", "commit", "both"],
      ["empty", "index", "patch"],
    ]);
    expect(patch.files).toEqual([]);
    expect(patch.rawPatch).toContain("diff --git");
  });

  it("keeps the last good snapshots when a native refresh rejects", async () => {
    let fail = false;
    const snapshotProvider = {
      async getSnapshot(descriptor, request) {
        if (fail) {
          const error = new Error("index is corrupt");
          error.code = "ERR_GIT_NATIVE_SNAPSHOT";
          throw error;
        }
        return {
          status: {
            fingerprint: "good",
            unchanged: false,
            value: statusValue(request.generations.status),
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { snapshotProvider });
    const good = await repo.refreshStatusSnapshot();
    fail = true;

    await expectAsync(repo.refreshStatusSnapshot()).toBeRejected();
    expect(repo.getStatusSnapshot()).toBe(good);
  });

  it("shows at most one warning for repeated native snapshot failures", () => {
    repo = new GitRepository(copyRepository());
    const warning = spyOn(lumine.notifications, "addWarning");
    spyOn(console, "error");
    const error = new Error("native snapshot failed");
    error.code = "ERR_GIT_NATIVE_SNAPSHOT";

    repo.reportNativeSnapshotError(error);
    repo.reportNativeSnapshotError(error);

    expect(warning.calls.count()).toBe(1);
  });
});
