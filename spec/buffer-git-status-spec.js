const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

describe("Git status for buffers", () => {
  let root, repository;
  const git = (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        { cwd: root, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve(stdout);
        },
      );
      if (input !== undefined) child.stdin.end(input);
    });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "buffer-git-status-"));
    await git(["init", "--quiet"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "*.log\n!visible.log\ncache/\n");
    for (const name of [
      "tracked.txt",
      "tracked.log",
      "ignored.log",
      "visible.log",
      "new.txt",
      "private.txt",
      "global.txt",
    ])
      fs.writeFileSync(path.join(root, name), "original\n");
    fs.mkdirSync(path.join(root, "cache"));
    fs.writeFileSync(path.join(root, "cache", "nested.txt"), "ignored\n");
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "\nprivate.txt\n");
    fs.writeFileSync(path.join(root, ".git", "global-ignore"), "global.txt\n");
    await git(["config", "core.excludesFile", path.join(root, ".git", "global-ignore")]);
    await git(["add", "--force", "tracked.txt", "tracked.log", ".gitignore"]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Baseline",
    ]);
    repository = await lumine.repositories.resolveForPath(root);
    await repository.ensureStatusSnapshot();
  });

  afterEach(async () => {
    repository?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function status(name, options = {}) {
    return lumine.repositories.getBufferStatusSummary(path.join(root, name), {
      fileState: "modified",
      ...options,
    });
  }

  it("requires a real repository before applying a buffer modification", () => {
    expect(
      lumine.repositories.getBufferStatusSummary(path.join(os.tmpdir(), "outside.txt"), {
        fileState: "modified",
      }),
    ).toBeNull();
    expect(status("tracked.txt")).toEqual(
      jasmine.objectContaining({
        status: "modified",
        canDiff: true,
        bufferModified: true,
        staged: false,
        unstaged: true,
      }),
    );
    expect(status("tracked.txt", { fileState: "unmodified" })).toEqual(
      jasmine.objectContaining({ status: null, unstaged: false }),
    );
  });

  it("uses Git's ignore rules, directory exclusions, local excludes and global excludes", () => {
    for (const name of ["ignored.log", "cache/nested.txt", "private.txt", "global.txt"]) {
      expect(status(name))
        .withContext(name)
        .toEqual(
          jasmine.objectContaining({
            status: "ignored",
            ignored: true,
            canDiff: false,
            bufferModified: false,
          }),
        );
    }
  });

  it("preserves negations and the tracked-file exception to ignore patterns", () => {
    expect(status("visible.log")).toEqual(
      jasmine.objectContaining({
        status: "added",
        untracked: true,
        ignored: false,
        canDiff: false,
      }),
    );
    expect(status("tracked.log")).toEqual(
      jasmine.objectContaining({ status: "modified", ignored: false, canDiff: true }),
    );
    expect(status("new.txt")).toEqual(
      jasmine.objectContaining({ status: "added", canDiff: false, bufferModified: false }),
    );
  });

  it("does not color Git's own metadata as a working file", () => {
    expect(status(".git/config")).toBeNull();
  });

  it("distinguishes staged changes from an additional buffer edit", async () => {
    fs.writeFileSync(path.join(root, "tracked.txt"), "staged\n");
    await git(["add", "tracked.txt"]);
    await repository.refreshStatusSnapshot();
    expect(status("tracked.txt", { fileState: "unmodified" })).toEqual(
      jasmine.objectContaining({ staged: true, unstaged: false, status: "modified" }),
    );
    expect(status("tracked.txt")).toEqual(
      jasmine.objectContaining({ staged: true, unstaged: true, status: "modified" }),
    );
  });

  it("refreshes exclusions after Git's rules change", async () => {
    fs.appendFileSync(path.join(root, ".gitignore"), "new.txt\n");
    await repository.refreshStatusSnapshot();
    expect(status("new.txt")).toEqual(
      jasmine.objectContaining({ status: "ignored", canDiff: false }),
    );
  });

  it("preserves native Git conflicts instead of treating the buffer as an ordinary edit", async () => {
    const oid = (await git(["rev-parse", "HEAD:tracked.txt"])).trim();
    await git(
      ["update-index", "--index-info"],
      `0 ${"0".repeat(40)}\ttracked.txt\n100644 ${oid} 1\ttracked.txt\n100644 ${oid} 2\ttracked.txt\n100644 ${oid} 3\ttracked.txt\n`,
    );
    await repository.refreshStatusSnapshot();
    expect(status("tracked.txt")).toEqual(
      jasmine.objectContaining({ status: "conflicted", canDiff: false, bufferModified: false }),
    );
  });

  it("does not infer Git coloring from an incomplete status snapshot", () => {
    spyOn(repository, "getStatusSnapshot").and.returnValue({
      initialized: true,
      includesIgnored: false,
    });
    expect(status("tracked.txt")).toBeNull();
  });
});
