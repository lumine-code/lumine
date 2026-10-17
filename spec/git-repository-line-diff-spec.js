const path = require("path");
const GitRepository = require("../src/git-repository");
const { parseStatusSnapshot } = require("../src/repository-status-snapshot");

describe("GitRepository buffer line-diff baselines", () => {
  const head = "a".repeat(40);
  const headBlob = "b".repeat(40);
  const indexBlob = "c".repeat(40);
  const zero = "0".repeat(40);
  let repository;
  let client;

  beforeEach(() => {
    client = { getLineDiffs: jasmine.createSpy("getLineDiffs").and.resolveTo([]) };
    repository = new GitRepository(
      {
        getPath: () => path.resolve("line-diff-repository/.git"),
        getWorkingDirectory: () => path.resolve("line-diff-repository"),
      },
      { gitHostClient: client },
    );
  });

  afterEach(() => repository.destroy());

  async function setStatus(record = "", oid = head) {
    await repository.applyStatusSnapshotSection({
      fingerprint: "snapshot",
      value: parseStatusSnapshot(`# branch.oid ${oid}\0# branch.head main\0${record}\0`),
    });
  }

  function requestedBaseline() {
    return client.getLineDiffs.calls.mostRecent().args[1];
  }

  it("uses the immutable HEAD blob by default and the index blob on request", async () => {
    await setStatus(`1 MM N... 100644 100644 100644 ${headBlob} ${indexBlob} f.txt`);
    await repository.getLineDiffsAsync("f.txt", "buffer\n");
    expect(requestedBaseline()).toEqual(
      jasmine.objectContaining({
        base: "head",
        baselineOid: headBlob,
        baselineKnownMissing: false,
        skipMissingBaseline: false,
      }),
    );

    await repository.getLineDiffsAsync("f.txt", "buffer\n", { base: "index" });
    expect(requestedBaseline()).toEqual(
      jasmine.objectContaining({
        base: "index",
        baselineOid: indexBlob,
        baselineKnownMissing: false,
      }),
    );
  });

  it("passes the opt-in missing-baseline policy to the worker", async () => {
    await setStatus();
    await repository.getLineDiffsAsync("new.txt", "unsaved\n", {
      base: "index",
      skipMissingBaseline: true,
    });

    expect(requestedBaseline()).toEqual(
      jasmine.objectContaining({ base: "head", skipMissingBaseline: true }),
    );
  });

  it("uses HEAD for a clean path's immutable index baseline", async () => {
    await setStatus();
    await repository.getLineDiffsAsync("f.txt", "unsaved\n", { base: "index" });

    expect(requestedBaseline()).toEqual(
      jasmine.objectContaining({ base: "head", headOid: head, baselineKnownMissing: false }),
    );
  });

  it("reads the index directly before the first snapshot is initialized", async () => {
    await repository.getLineDiffsAsync("f.txt", "buffer\n", { base: "index" });

    expect(requestedBaseline()).toEqual(
      jasmine.objectContaining({ base: "index", baselineOid: null, baselineKnownMissing: false }),
    );
  });

  it("keeps a staged addition's index baseline usable with an unborn HEAD", async () => {
    await setStatus(`1 A. N... 000000 100644 100644 ${zero} ${indexBlob} f.txt`, "(initial)");
    await repository.getLineDiffsAsync("f.txt", "buffer\n");
    expect(requestedBaseline().baselineKnownMissing).toBe(true);

    await repository.getLineDiffsAsync("f.txt", "buffer\n", { base: "index" });
    expect(requestedBaseline()).toEqual(
      jasmine.objectContaining({ baselineOid: indexBlob, baselineKnownMissing: false }),
    );
  });

  it("marks a staged deletion's missing index baseline explicitly", async () => {
    await setStatus(`1 D. N... 100644 000000 000000 ${headBlob} ${zero} f.txt`);
    await repository.getLineDiffsAsync("f.txt", "recreated\n", { base: "index" });

    expect(requestedBaseline().baselineKnownMissing).toBe(true);
  });

  it("uses a rename's source path at HEAD and destination path in the index", async () => {
    await setStatus(
      `2 R. N... 100644 100644 100644 ${headBlob} ${indexBlob} R100 new.txt\0old.txt`,
    );
    await repository.getLineDiffsAsync("new.txt", "buffer\n");
    expect(requestedBaseline().baselinePath).toBe("old.txt");

    await repository.getLineDiffsAsync("new.txt", "buffer\n", { base: "index" });
    expect(requestedBaseline().baselinePath).toBe("new.txt");
  });

  it("rejects unsupported baselines before dispatch", () => {
    expect(() =>
      repository.getLineDiffsAsync("f.txt", "buffer\n", { base: "worktree" }),
    ).toThrowError(TypeError, "Unsupported line diff baseline: worktree");
    expect(client.getLineDiffs).not.toHaveBeenCalled();
  });

  it("rejects a cancelled result even if the client returns it", async () => {
    const controller = new AbortController();
    controller.abort();

    await expectAsync(
      repository.getLineDiffsAsync("f.txt", "buffer\n", {
        base: "index",
        signal: controller.signal,
      }),
    ).toBeRejected();
    expect(requestedBaseline().signal.aborted).toBe(true);
  });
});
