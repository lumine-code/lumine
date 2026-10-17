const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/fs-temp").track();
const createGitHostOps = require("../src/git-host-ops");
const GitRunner = require("../src/git-runner");
const { discoverRepositoryDescriptorAsync } = require("../src/git-repository-descriptor");

async function hostDescriptorForPath(filePath) {
  const descriptor = await discoverRepositoryDescriptorAsync(filePath);
  return {
    gitDirectory: descriptor.getPath(),
    workingDirectory: descriptor.getWorkingDirectory(),
    worktreeGitMarker: descriptor.getWorktreeGitMarker(),
    gitDirectoryIdentity: descriptor.getGitDirectoryIdentity(),
    workingDirectoryIdentity: descriptor.getWorkingDirectoryIdentity(),
    commonDirectory: descriptor.getCommonDirectory(),
    commonDirectoryIdentity: descriptor.getCommonDirectoryIdentity(),
  };
}

async function copyRepository() {
  const workingDirectory = temp.mkdirSync("git-host-cli-contract-");
  fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
  fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
  return await hostDescriptorForPath(workingDirectory);
}

describe("git-host system Git contract", () => {
  let descriptor;
  let ops;

  beforeEach(async () => {
    descriptor = await copyRepository();
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
      await ops.history(
        {
          descriptor,
          request: { revision: "HEAD", path: "a.txt", limit: 10, skip: 0 },
        },
        {},
      ),
    ).toEqual(jasmine.any(Array));
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

  it("can omit missing baselines while retaining additions to a committed empty file", async () => {
    const { stdout } = await ops.execRepository(
      { descriptor, args: ["rev-parse", "HEAD"], options: {} },
      {},
    );
    const payload = { descriptor, headOid: stdout.trim(), text: "new\n" };
    const addition = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 };

    expect(
      await ops.lineDiff(
        { ...payload, relativePosixPath: "missing.txt", skipMissingBaseline: true },
        {},
      ),
    ).toEqual([]);
    expect(await ops.lineDiff({ ...payload, relativePosixPath: "missing.txt" }, {})).toEqual([
      addition,
    ]);
    expect(
      await ops.lineDiff({ ...payload, relativePosixPath: "a.txt", skipMissingBaseline: true }, {}),
    ).toEqual([addition]);
  });

  it("reads refs and an empty status from a bare repository", async () => {
    const gitDirectory = temp.mkdirSync("git-host-bare-");
    const runner = new GitRunner({ trustAllRepositories: true });
    await runner.run(["init", "--bare", "--initial-branch=main"], gitDirectory);
    const bareOps = createGitHostOps(runner);
    const bareDescriptor = await hostDescriptorForPath(gitDirectory);

    const snapshot = await bareOps.snapshot(
      {
        descriptor: bareDescriptor,
        request: {
          status: true,
          refs: true,
          generations: { status: 3, refs: 4 },
        },
      },
      {},
    );

    expect(snapshot.status.value).toEqual(
      jasmine.objectContaining({
        generation: 3,
        initialized: true,
        files: [],
        head: jasmine.objectContaining({ name: "main", unborn: true }),
      }),
    );
    expect(snapshot.refs.value).toEqual(
      jasmine.objectContaining({
        generation: 4,
        initialized: true,
        head: jasmine.objectContaining({ name: "main", unborn: true }),
      }),
    );
  });

  it("compares both baselines through real Git while the index changes with the same status", async () => {
    const filePath = path.join(descriptor.workingDirectory, "a.txt");
    const run = (args) => ops.execRepository({ descriptor, args, options: {} }, {});
    const snapshot = (knownFingerprint) =>
      ops.snapshot(
        {
          descriptor,
          request: {
            status: true,
            refs: false,
            knownFingerprints: { status: knownFingerprint },
          },
        },
        {},
      );
    await run(["add", "--", "a.txt"]);
    fs.writeFileSync(filePath, "working\n");
    const first = await snapshot();
    const entry = first.status.value.files.find(({ path: filePath }) => filePath === "a.txt");
    expect(entry.indexStatus).toBe("M");
    expect(entry.worktreeStatus).toBe("M");
    const payload = { descriptor, relativePosixPath: "a.txt", text: "changed\nunsaved\n" };

    expect(
      await ops.lineDiff({ ...payload, base: "index", baselineOid: entry.indexBlobOid }, {}),
    ).toEqual([{ oldStart: 2, oldLines: 0, newStart: 2, newLines: 1 }]);
    expect(
      await ops.lineDiff({ ...payload, base: "head", baselineOid: entry.headBlobOid }, {}),
    ).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }]);

    fs.writeFileSync(filePath, "new staged\n");
    await run(["add", "--", "a.txt"]);
    fs.writeFileSync(filePath, "working\n");
    const second = await snapshot(first.status.fingerprint);
    expect(second.status.unchanged).toBe(false);
    const nextEntry = second.status.value.files.find(({ path: filePath }) => filePath === "a.txt");
    expect(nextEntry.indexStatus).toBe("M");
    expect(nextEntry.worktreeStatus).toBe("M");
    expect(nextEntry.indexBlobOid).not.toBe(entry.indexBlobOid);
    expect(
      await ops.lineDiff({ ...payload, base: "index", baselineOid: nextEntry.indexBlobOid }, {}),
    ).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }]);
  });
});
