const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const gitUtils = require("@lumine-code/git-utils");
const GitCliBackend = require("../src/git-cli-backend");
const createGitHostOps = require("../src/git-host-ops");
const { ALL_CLI_BACKEND_OVERRIDES } = require("../src/git-host-protocol");
const GitRunner = require("../src/git-runner");
const GitUtilsBackend = require("../src/git-utils-backend");

function copyRepository() {
  const workingDirectory = temp.mkdirSync("git-backend-contract-");
  fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
  fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
  return {
    gitDirectory: fs.realpathSync(path.join(workingDirectory, ".git")),
    workingDirectory: fs.realpathSync(workingDirectory),
    hasSubmodules: false,
    submodulePaths: [],
  };
}

function withoutGeneration(section) {
  const { generation: _generation, ...value } = section.value;
  return value;
}

describe("Git backend contract", () => {
  let descriptor;
  let cli;
  let native;

  beforeEach(() => {
    descriptor = copyRepository();
    fs.writeFileSync(path.join(descriptor.workingDirectory, "a.txt"), "changed\n");
    gitUtils.configure({ validateOwnership: false });
    cli = new GitCliBackend({ runner: new GitRunner({ trustAllRepositories: true }) });
    native = new GitUtilsBackend({ nativeBackend: gitUtils });
  });

  it("returns the same snapshot, diff, and history domain values", async () => {
    const snapshotRequest = {
      status: true,
      refs: true,
      includeIgnored: true,
      generations: { status: 7, refs: 9 },
    };
    const [nativeSnapshot, cliSnapshot] = await Promise.all([
      native.snapshot(descriptor, snapshotRequest),
      cli.snapshot(descriptor, snapshotRequest),
    ]);
    expect(withoutGeneration(nativeSnapshot.status)).toEqual(withoutGeneration(cliSnapshot.status));
    expect(withoutGeneration(nativeSnapshot.refs)).toEqual(withoutGeneration(cliSnapshot.refs));

    const diffRequest = {
      from: { type: "commit", revision: "HEAD" },
      to: { type: "worktree" },
      format: "structured",
      maxBytes: 1024 * 1024,
    };
    const [nativeDiff, cliDiff] = await Promise.all([
      native.diff(descriptor, diffRequest),
      cli.diff(descriptor, diffRequest, { maxBytes: diffRequest.maxBytes }),
    ]);
    expect(nativeDiff).toEqual(cliDiff);

    const emptyIndexRequest = {
      from: { type: "empty" },
      to: { type: "index" },
      format: "structured",
      maxBytes: 1024 * 1024,
    };
    const [nativeEmptyIndex, cliEmptyIndex] = await Promise.all([
      native.diff(descriptor, emptyIndexRequest),
      cli.diff(descriptor, emptyIndexRequest, { maxBytes: emptyIndexRequest.maxBytes }),
    ]);
    expect(nativeEmptyIndex).toEqual(cliEmptyIndex);

    const historyRequest = { revision: "HEAD", limit: 10, skip: 0 };
    const [nativeHistory, cliHistory] = await Promise.all([
      native.history(descriptor, historyRequest),
      cli.history(descriptor, historyRequest),
    ]);
    expect(nativeHistory).toEqual(cliHistory);

    const head = nativeHistory[0].sha;
    const [nativeCommit, cliCommit] = await Promise.all([
      native.commit(descriptor, { revision: head }),
      cli.commit(descriptor, { revision: head }),
    ]);
    expect(nativeCommit).toEqual(cliCommit);
    expect(
      await Promise.all([
        native.commit(descriptor, { revision: "missing-ref" }),
        cli.commit(descriptor, { revision: "missing-ref" }),
      ]),
    ).toEqual([null, null]);

    const [nativeDescription, cliDescription] = await Promise.all([
      native.describe(descriptor),
      cli.describe(descriptor),
    ]);
    expect(nativeDescription).toBe(cliDescription);

    const branchRequest = { commit: head, showLocal: true, showRemote: true };
    const [nativeBranches, cliBranches] = await Promise.all([
      native.branchesContaining(descriptor, branchRequest),
      cli.branchesContaining(descriptor, branchRequest),
    ]);
    expect(nativeBranches).toEqual(cliBranches);

    const [nativeMode, cliMode, nativeSubmodules, cliSubmodules] = await Promise.all([
      native.fileMode(descriptor, "a.txt"),
      cli.fileMode(descriptor, "a.txt"),
      native.submodulePaths(descriptor),
      cli.submodulePaths(descriptor),
    ]);
    expect(nativeMode).toBe(cliMode);
    expect(nativeSubmodules).toEqual(cliSubmodules);

    const objectRequests = [
      { revision: "HEAD", path: "a.txt" },
      { source: "index", path: "a.txt" },
      { oid: "0".repeat(40) },
    ];
    const [nativeObjects, cliObjects] = await Promise.all([
      native.readObjects(descriptor, objectRequests),
      cli.readObjects(descriptor, objectRequests),
    ]);
    expect(nativeObjects).toEqual(cliObjects);

    const configKeys = ["core.repositoryformatversion", "core.bare", "missing.value"];
    const [nativeConfig, cliConfig] = await Promise.all([
      native.readConfig(descriptor, configKeys),
      cli.readConfig(descriptor, configKeys),
    ]);
    expect(nativeConfig).toEqual(cliConfig);
  });

  it("can run the complete host protocol without loading git-utils", async () => {
    const nativeLoad = jasmine.createSpy("native load").and.callFake(() => {
      throw new Error("git-utils must remain unused");
    });
    const ops = createGitHostOps(new GitRunner({ trustAllRepositories: true }), {
      backendOverrides: ALL_CLI_BACKEND_OVERRIDES,
      getNativeBackend: nativeLoad,
    });

    const snapshot = await ops.snapshot(
      {
        descriptor,
        request: {
          status: true,
          refs: true,
          generations: { status: 1, refs: 1 },
        },
      },
      {},
    );
    expect(snapshot.status.value.initialized).toBe(true);
    expect(snapshot.refs.value.initialized).toBe(true);

    const diff = await ops.diff(
      {
        descriptor,
        request: {
          from: { type: "commit", revision: "HEAD" },
          to: { type: "worktree" },
          format: "structured",
        },
        maxBytes: 1024 * 1024,
      },
      {},
    );
    expect(diff.files.length).toBeGreaterThan(0);

    const history = await ops.history(
      { descriptor, request: { revision: "HEAD", limit: 10, skip: 0 } },
      {},
    );
    const head = history[0].sha;
    expect(await ops.commit({ descriptor, revision: head }, {})).not.toBeNull();
    expect(await ops.describe({ descriptor }, {})).toEqual(jasmine.any(String));
    expect(
      await ops.branchesContaining(
        { descriptor, request: { commit: head, showLocal: true, showRemote: true } },
        {},
      ),
    ).toContain("refs/heads/master");
    expect(await ops.fileMode({ descriptor, path: "a.txt" }, {})).toBe("100644");
    expect(await ops.submodulePaths({ descriptor }, {})).toEqual([]);
    expect(
      await ops.readConfig({ descriptor, keys: ["core.repositoryformatversion"] }, {}),
    ).toEqual({ "core.repositoryformatversion": "0" });
    const [object] = await ops.readObjects(
      { descriptor, requests: [{ revision: "HEAD", path: "a.txt" }] },
      {},
    );
    expect(object.type).toBe("blob");
    expect(
      await ops.blame({ descriptor, request: { path: "a.txt", revision: "HEAD" } }, {}),
    ).toEqual([]);
    expect(
      await ops.logFollow(
        {
          descriptor,
          request: { revision: "HEAD", path: "a.txt", limit: 10, skip: 0 },
          options: {},
        },
        {},
      ),
    ).toEqual(jasmine.any(String));
    expect(
      await ops.lineDiff(
        {
          descriptor,
          relativePosixPath: "a.txt",
          headOid: head,
          text: "changed\n",
          ignoreEolWhitespace: false,
        },
        {},
      ),
    ).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 }]);
    const execution = await ops.exec(
      { workingDirectory: descriptor.workingDirectory, args: ["status"], options: {} },
      {},
    );
    expect(execution.exitCode).toBe(0);
    expect(nativeLoad).not.toHaveBeenCalled();
  });
});
