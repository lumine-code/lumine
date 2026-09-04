const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const createGitHostOps = require("../src/git-host-ops");
const GitRunner = require("../src/git-runner");

function copyRepository() {
  const workingDirectory = temp.mkdirSync("git-host-cli-contract-");
  fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
  fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
  return {
    gitDirectory: fs.realpathSync(path.join(workingDirectory, ".git")),
    workingDirectory: fs.realpathSync(workingDirectory),
  };
}

describe("git-host CLI contract", () => {
  let descriptor;
  let ops;

  beforeEach(() => {
    descriptor = copyRepository();
    fs.writeFileSync(path.join(descriptor.workingDirectory, "a.txt"), "changed\n");
    ops = createGitHostOps(new GitRunner({ trustAllRepositories: true }));
  });

  it("runs the complete repository facade through system Git", async () => {
    const snapshot = await ops.snapshot(
      {
        descriptor,
        request: {
          status: true,
          refs: true,
          includeIgnored: true,
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

    const emptyIndexDiff = await ops.diff(
      {
        descriptor,
        request: { from: { type: "empty" }, to: { type: "index" }, format: "structured" },
        maxBytes: 1024 * 1024,
      },
      {},
    );
    expect(emptyIndexDiff.files.length).toBeGreaterThan(0);

    const history = await ops.history(
      { descriptor, request: { revision: "HEAD", limit: 10, skip: 0 } },
      {},
    );
    const head = history[0].sha;
    expect(await ops.commit({ descriptor, revision: head }, {})).not.toBeNull();
    expect(await ops.commit({ descriptor, revision: "missing-ref" }, {})).toBeNull();
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
    expect(Buffer.isBuffer(object.content)).toBe(true);
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
  });
});
