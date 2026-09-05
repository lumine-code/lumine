const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const CoreGitRepository = require("../src/git-repository");
const { discoverRepositoryDescriptor } = require("../src/git-repository-descriptor");

class GitRepository extends CoreGitRepository {
  constructor(filePath, options) {
    super(discoverRepositoryDescriptor(filePath), options);
  }
}

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
    const gitHostClient = {
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
    repo = new GitRepository(copyRepository(), { gitHostClient });
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

  it("queues a different snapshot kind behind an active request", async () => {
    const calls = [];
    const pending = [];
    const gitHostClient = {
      getSnapshot(descriptor, request) {
        calls.push(request);
        return new Promise((resolve) => pending.push({ request, resolve }));
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });

    const status = repo.refreshStatusSnapshot();
    await Promise.resolve();
    const refs = repo.refreshRefsSnapshot();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(jasmine.objectContaining({ status: true, refs: false }));

    pending[0].resolve({
      status: {
        fingerprint: "status",
        unchanged: false,
        value: statusValue(pending[0].request.generations.status),
      },
    });
    await status;
    for (let index = 0; index < 8; index++) await Promise.resolve();

    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(jasmine.objectContaining({ status: false, refs: true }));
    pending[1].resolve({
      refs: {
        fingerprint: "refs",
        unchanged: false,
        value: refsValue(pending[1].request.generations.refs),
      },
    });
    expect((await refs).initialized).toBe(true);
  });

  it("refreshes declared submodules in the worker without leaking routing data", async () => {
    const workingDirectory = copyRepository();
    repo = new GitRepository(workingDirectory);
    expect(repo.isSubmodule("vendor/library")).toBe(false);

    fs.writeFileSync(
      path.join(workingDirectory, ".gitmodules"),
      '[submodule "library"]\n\tpath = vendor/library\n\turl = ../library.git\n',
    );
    await repo.getSubmodulePaths();
    expect(repo.isSubmodule("vendor/library")).toBe(true);
    expect(repo.getHostDescriptor()).toEqual({
      gitDirectory: repo.getPath(),
      workingDirectory: repo.getWorkingDirectory(),
    });

    fs.removeSync(path.join(workingDirectory, ".gitmodules"));
    await repo.getSubmodulePaths();
    expect(repo.isSubmodule("vendor/library")).toBe(false);
  });

  it("batches config keys and fills omitted values with null", async () => {
    const getConfigValues = jasmine
      .createSpy("get config values")
      .and.resolveTo({ "user.name": "Lumine" });
    repo = new GitRepository(copyRepository(), { gitHostClient: { getConfigValues } });

    const values = await repo.getConfigValuesAsync(["user.name", "user.email"]);
    expect(values).toEqual({ "user.name": "Lumine", "user.email": null });
    expect(getConfigValues.calls.argsFor(0)[1]).toEqual(["user.name", "user.email"]);
  });

  it("reads an explicit stage-0 index object through the host client", async () => {
    const getIndexFile = jasmine.createSpy("get index file").and.resolveTo("staged contents\n");
    repo = new GitRepository(copyRepository(), { gitHostClient: { getIndexFile } });

    expect(await repo.getIndexFile("nested/staged.txt")).toBe("staged contents\n");
    expect(getIndexFile.calls.argsFor(0)).toEqual([
      repo.getHostDescriptor(),
      "nested/staged.txt",
      { encoding: "utf8", signal: undefined },
    ]);
  });

  it("expresses all-ref history without leaking a Git CLI flag", async () => {
    const getHistory = jasmine.createSpy("get history").and.resolveTo([]);
    repo = new GitRepository(copyRepository(), { gitHostClient: { getHistory } });

    await repo.getCommits({ allRefs: true, limit: 25 });
    expect(getHistory.calls.argsFor(0)[1]).toEqual({
      revision: "HEAD",
      allRefs: true,
      path: null,
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
    const gitHostClient = {
      async getDiff(descriptor, request) {
        requests.push(request);
        return {
          schemaVersion: 1,
          files: request.format === "patch" ? [] : [],
          ...(request.format === "structured" ? {} : { rawPatch: "diff --git a/a b/a\n" }),
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });

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
    const gitHostClient = {
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
    repo = new GitRepository(copyRepository(), { gitHostClient });
    const good = await repo.refreshStatusSnapshot();
    fail = true;

    await expectAsync(repo.refreshStatusSnapshot()).toBeRejected();
    expect(repo.getStatusSnapshot()).toBe(good);
  });

  it("yields and aborts while indexing a very large status snapshot", async () => {
    const files = Array.from({ length: 4001 }, (_, index) => ({
      path: `directory/file-${index}.txt`,
      originalPath: null,
      kind: "untracked",
      indexStatus: null,
      worktreeStatus: null,
      staged: false,
      unstaged: true,
      conflicted: false,
      untracked: true,
      ignored: false,
      similarity: null,
      submodule: {
        isSubmodule: false,
        commitChanged: false,
        modified: false,
        hasUntrackedChanges: false,
      },
    }));
    const gitHostClient = {
      async getSnapshot(descriptor, request) {
        return {
          status: {
            fingerprint: "large",
            unchanged: false,
            value: {
              ...statusValue(request.generations.status),
              files,
              counts: {
                total: files.length,
                staged: 0,
                unstaged: files.length,
                conflicted: 0,
                untracked: files.length,
                ignored: 0,
              },
            },
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });
    const controller = new AbortController();

    const pending = repo.refreshStatusSnapshot({ signal: controller.signal });
    setImmediate(() => controller.abort());

    await expectAsync(pending).toBeRejectedWithError(Error, /aborted/);
    expect(repo.getStatusSnapshot().initialized).toBe(false);
  });

  it("yields and aborts while indexing the ancestors of one deeply nested status path", async () => {
    const file = {
      path: `${Array.from({ length: 10000 }, () => "nested").join("/")}/file.txt`,
      originalPath: null,
      kind: "untracked",
      indexStatus: null,
      worktreeStatus: null,
      staged: false,
      unstaged: true,
      conflicted: false,
      untracked: true,
      ignored: false,
      similarity: null,
      submodule: {
        isSubmodule: false,
        commitChanged: false,
        modified: false,
        hasUntrackedChanges: false,
      },
    };
    const gitHostClient = {
      async getSnapshot(descriptor, request) {
        return {
          status: {
            fingerprint: "deep",
            unchanged: false,
            value: {
              ...statusValue(request.generations.status),
              files: [file],
              counts: {
                total: 1,
                staged: 0,
                unstaged: 1,
                conflicted: 0,
                untracked: 1,
                ignored: 0,
              },
            },
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });
    const controller = new AbortController();

    const pending = repo.refreshStatusSnapshot({ signal: controller.signal });
    setImmediate(() => controller.abort());

    await expectAsync(pending).toBeRejectedWithError(Error, /aborted/);
    expect(repo.getStatusSnapshot().initialized).toBe(false);
  });

  it("yields and aborts while freezing a very large refs snapshot", async () => {
    const branches = Array.from({ length: 20000 }, (_, index) => ({
      name: `branch-${index}`,
      ref: `refs/heads/branch-${index}`,
      oid: index.toString(16).padStart(40, "0"),
      isHead: index === 0,
      upstream: null,
      push: null,
      lastCommit: {
        oid: index.toString(16).padStart(40, "0"),
        parents: [],
        authorName: "Lumine",
        committerDate: new Date(0),
        subject: `Commit ${index}`,
      },
    }));
    const gitHostClient = {
      async getSnapshot(descriptor, request) {
        return {
          refs: {
            fingerprint: "large-refs",
            unchanged: false,
            value: { ...refsValue(request.generations.refs), branches },
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });
    const controller = new AbortController();

    const pending = repo.refreshRefsSnapshot({ signal: controller.signal });
    setImmediate(() => controller.abort());

    await expectAsync(pending).toBeRejectedWithError(Error, /aborted/);
    expect(repo.getRefsSnapshot().initialized).toBe(false);
  });

  it("publishes deeply frozen refs after time-sliced processing completes", async () => {
    const branch = {
      name: "main",
      ref: "refs/heads/main",
      oid: "a".repeat(40),
      isHead: true,
      upstream: {
        ref: "refs/remotes/origin/main",
        name: "origin/main",
        ahead: 0,
        behind: 0,
        gone: false,
      },
      push: null,
      lastCommit: {
        oid: "a".repeat(40),
        parents: ["b".repeat(40)],
        authorName: "Lumine",
        committerDate: new Date(0),
        subject: "Initial commit",
      },
    };
    const gitHostClient = {
      async getSnapshot(descriptor, request) {
        return {
          refs: {
            fingerprint: "frozen-refs",
            unchanged: false,
            value: { ...refsValue(request.generations.refs), branches: [branch] },
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });

    const snapshot = await repo.refreshRefsSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.branches)).toBe(true);
    expect(Object.isFrozen(snapshot.branches[0])).toBe(true);
    expect(Object.isFrozen(snapshot.branches[0].upstream)).toBe(true);
    expect(Object.isFrozen(snapshot.branches[0].lastCommit)).toBe(true);
    expect(Object.isFrozen(snapshot.branches[0].lastCommit.parents)).toBe(true);
  });

  it("does not apply refs after aborting a combined snapshot while status is indexing", async () => {
    const files = Array.from({ length: 4001 }, (_, index) => ({
      path: `directory/file-${index}.txt`,
      originalPath: null,
      kind: "untracked",
      indexStatus: null,
      worktreeStatus: null,
      staged: false,
      unstaged: true,
      conflicted: false,
      untracked: true,
      ignored: false,
      similarity: null,
      submodule: {
        isSubmodule: false,
        commitChanged: false,
        modified: false,
        hasUntrackedChanges: false,
      },
    }));
    const gitHostClient = {
      async getSnapshot(descriptor, request) {
        return {
          status: {
            fingerprint: "large",
            unchanged: false,
            value: { ...statusValue(request.generations.status), files },
          },
          refs: {
            fingerprint: "refs",
            unchanged: false,
            value: refsValue(request.generations.refs),
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });
    const controller = new AbortController();

    const status = repo.refreshStatusSnapshot({ signal: controller.signal });
    const refs = repo.refreshRefsSnapshot({ signal: controller.signal });
    setImmediate(() => controller.abort());

    const results = await Promise.allSettled([status, refs]);
    expect(results.map(({ status: resultStatus }) => resultStatus)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(repo.getStatusSnapshot().initialized).toBe(false);
    expect(repo.getRefsSnapshot().initialized).toBe(false);
  });

  it("does not apply status after aborting a combined snapshot while refs are indexing", async () => {
    const remoteBranches = Array.from({ length: 20000 }, (_, index) => ({
      name: `origin/branch-${index}`,
      ref: `refs/remotes/origin/branch-${index}`,
      oid: index.toString(16).padStart(40, "0"),
      remoteName: "origin",
      symrefTarget: null,
      lastCommit: null,
    }));
    const gitHostClient = {
      async getSnapshot(descriptor, request) {
        return {
          status: {
            fingerprint: "status",
            unchanged: false,
            value: statusValue(request.generations.status),
          },
          refs: {
            fingerprint: "large-refs",
            unchanged: false,
            value: { ...refsValue(request.generations.refs), remoteBranches },
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });
    const controller = new AbortController();

    const status = repo.refreshStatusSnapshot({ signal: controller.signal });
    const refs = repo.refreshRefsSnapshot({ signal: controller.signal });
    setImmediate(() => controller.abort());

    const results = await Promise.allSettled([status, refs]);
    expect(results.every(({ status: resultStatus }) => resultStatus === "rejected")).toBe(true);
    expect(repo.getStatusSnapshot().initialized).toBe(false);
    expect(repo.getRefsSnapshot().initialized).toBe(false);
  });

  it("applies a valid combined snapshot section before rejecting its invalid sibling", async () => {
    for (const successfulKind of ["status", "refs"]) {
      const gitHostClient = {
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
      repo = new GitRepository(copyRepository(), { gitHostClient });

      await expectAsync(
        Promise.all([repo.refreshStatusSnapshot(), repo.refreshRefsSnapshot()]),
      ).toBeRejectedWithError(/omitted the requested/);
      expect(repo.getStatusSnapshot().initialized).toBe(successfulKind === "status");
      expect(repo.getRefsSnapshot().initialized).toBe(successfulKind === "refs");
      repo.destroy();
    }
  });

  it("publishes both combined states before emitting either snapshot event", async () => {
    const gitHostClient = {
      async getSnapshot(descriptor, request) {
        return {
          status: {
            fingerprint: "status",
            unchanged: false,
            value: statusValue(request.generations.status),
          },
          refs: {
            fingerprint: "refs",
            unchanged: false,
            value: refsValue(request.generations.refs),
          },
        };
      },
    };
    repo = new GitRepository(copyRepository(), { gitHostClient });
    const refsChanged = jasmine.createSpy("refs changed");
    repo.onDidChangeStatusSnapshot(() => {
      expect(repo.getRefsSnapshot().initialized).toBe(true);
      throw new Error("status listener failed");
    });
    repo.onDidChangeRefsSnapshot(refsChanged);

    await expectAsync(
      Promise.all([repo.refreshStatusSnapshot(), repo.refreshRefsSnapshot()]),
    ).toBeRejectedWithError(/status listener failed/);
    expect(repo.getStatusSnapshot().initialized).toBe(true);
    expect(repo.getRefsSnapshot().initialized).toBe(true);
    expect(refsChanged).toHaveBeenCalled();
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
