const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const GitRepository = require("../src/git-repository");

function copyRepository() {
  const workingDirectory = temp.mkdirSync("lumine-host-facade-spec");
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

describe("GitRepository host facade", () => {
  let repo;

  afterEach(() => {
    if (repo && !repo.isDestroyed()) repo.destroy();
  });

  it("combines status and refs requests and reuses fingerprints", async () => {
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

  it("refreshes declared submodules without leaking routing data into RPC descriptors", () => {
    const workingDirectory = copyRepository();
    repo = new GitRepository(workingDirectory);
    expect(repo.isSubmodule("vendor/library")).toBe(false);

    fs.writeFileSync(
      path.join(workingDirectory, ".gitmodules"),
      '[submodule "library"]\n\tpath = vendor/library\n\turl = ../library.git\n',
    );
    expect(repo.isSubmodule("vendor/library")).toBe(true);
    expect(repo.getHostDescriptor()).toEqual({
      gitDirectory: repo.getPath(),
      workingDirectory: repo.getWorkingDirectory(),
    });

    fs.removeSync(path.join(workingDirectory, ".gitmodules"));
    expect(repo.isSubmodule("vendor/library")).toBe(false);
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

  it("reads an explicit stage-0 index object through the history provider", async () => {
    const getIndexFile = jasmine.createSpy("get index file").and.resolveTo("staged contents\n");
    repo = new GitRepository(copyRepository(), { historyProvider: { getIndexFile } });

    expect(await repo.getIndexFile("nested/staged.txt")).toBe("staged contents\n");
    expect(getIndexFile.calls.argsFor(0)).toEqual([
      repo.getHostDescriptor(),
      "nested/staged.txt",
      { encoding: "utf8", signal: undefined },
    ]);
  });

  it("expresses all-ref history without leaking a Git CLI flag", async () => {
    const getHistory = jasmine.createSpy("get history").and.resolveTo([]);
    repo = new GitRepository(copyRepository(), { historyProvider: { getHistory } });

    await repo.getCommits({ allRefs: true, limit: 25 });
    expect(getHistory.calls.argsFor(0)[1]).toEqual({
      revision: "HEAD",
      allRefs: true,
      limit: 26,
      skip: 0,
    });
    await expectAsync(repo.getCommits({ revision: "--all" })).toBeRejectedWithError(
      TypeError,
      "revision must be a non-empty Git revision, not a command-line option",
    );
  });

  it("rejects command-line options in every public revision position", async () => {
    repo = new GitRepository(copyRepository());

    await expectAsync(repo.getCommit("--all")).toBeRejectedWithError(TypeError);
    await expectAsync(
      repo.getDiff({
        from: { type: "commit", revision: "--stat" },
        to: { type: "worktree" },
      }),
    ).toBeRejectedWithError(TypeError);
    await expectAsync(repo.getBlame("a.txt", { revision: "--reverse" })).toBeRejectedWithError(
      TypeError,
    );
    expect(() => repo.getBranchesContaining("--all")).toThrowError(TypeError);
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

  it("keeps the last good snapshots when a refresh rejects", async () => {
    let fail = false;
    const snapshotProvider = {
      async getSnapshot(descriptor, request) {
        if (fail) {
          const error = new Error("index is corrupt");
          error.code = "ERR_GIT_SNAPSHOT";
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

  it("applies a valid combined snapshot section before rejecting its invalid sibling", async () => {
    for (const successfulKind of ["status", "refs"]) {
      const snapshotProvider = {
        async getSnapshot(descriptor, request) {
          return successfulKind === "status"
            ? {
                status: {
                  fingerprint: "valid-status",
                  unchanged: false,
                  value: statusValue(request.generations.status),
                },
              }
            : {
                refs: {
                  fingerprint: "valid-refs",
                  unchanged: false,
                  value: refsValue(request.generations.refs),
                },
              };
        },
      };
      repo = new GitRepository(copyRepository(), { snapshotProvider });

      await expectAsync(
        Promise.all([repo.refreshStatusSnapshot(), repo.refreshRefsSnapshot()]),
      ).toBeRejectedWithError(/omitted the requested/);
      expect(repo.getStatusSnapshot().initialized).toBe(successfulKind === "status");
      expect(repo.getRefsSnapshot().initialized).toBe(successfulKind === "refs");
      repo.destroy();
    }
  });

  it("reports background snapshot failures with at most one warning per repository", () => {
    const warning = spyOn(lumine.notifications, "addWarning");
    const diagnostic = spyOn(console, "error");
    const codes = ["ERR_GIT_SNAPSHOT", "ERR_GIT_COMMAND_FAILED", "ERR_GIT_HOST_RESTART"];

    for (const code of codes) {
      repo = new GitRepository(copyRepository());
      const error = new Error(`${code} snapshot failed`);
      error.code = code;
      repo.reportBackgroundSnapshotError(error);
      repo.reportBackgroundSnapshotError(error);
      repo.destroy();
    }

    expect(warning.calls.count()).toBe(codes.length);
    expect(diagnostic.calls.count()).toBe(codes.length * 2);
    expect(warning.calls.argsFor(0)[0]).toBe("Git repository data could not be refreshed");
  });
});
