const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const GitHost = require("../src/git-host");
const GitRepository = require("../src/git-repository");

describe("Git repository lifecycle through the real worker", () => {
  let repositories;

  beforeEach(() => {
    jasmine.useRealClock?.();
    repositories = [];
    GitHost.reset();
    GitHost.setForkModeForTesting(true);
    GitHost.setChildFactoryForTesting(null);
  });

  afterEach(() => {
    for (const repository of repositories) repository.destroy();
    GitHost.reset();
    GitHost.setForkModeForTesting(null);
  });

  function copyRepository(directory) {
    fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), directory);
    fs.renameSync(path.join(directory, "git.git"), path.join(directory, ".git"));
  }

  async function open(directory) {
    const repository = await GitRepository.open(directory);
    expect(repository).not.toBeNull();
    repositories.push(repository);
    return repository;
  }

  async function configure(repository, value) {
    await GitHost.instance().request("execRepository", {
      descriptor: repository.getHostDescriptor(),
      args: ["config", "lumine.lifecycle", value],
      options: {},
      raw: false,
    });
  }

  it("retires the old descriptor after a move and reads the new location independently", async () => {
    const root = temp.mkdirSync("git-lifecycle-move-");
    const original = path.join(root, "original");
    const moved = path.join(root, "moved");
    copyRepository(original);
    const repository = await open(original);
    await configure(repository, "original");
    const baseline = await repository.refreshStatusSnapshot();
    const unavailable = jasmine.createSpy("unavailable");
    repository.onDidBecomeUnavailable(unavailable);
    fs.renameSync(original, moved);

    await expectAsync(repository.getConfigValueAsync("lumine.lifecycle")).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_REPOSITORY_UNAVAILABLE" }),
    );
    await expectAsync(repository.refreshStatusSnapshot()).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_REPOSITORY_UNAVAILABLE" }),
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(repository.getStatusSnapshot()).toBe(baseline);

    const replacement = await open(moved);
    expect(await replacement.getConfigValueAsync("lumine.lifecycle")).toBe("original");
    expect((await replacement.refreshStatusSnapshot()).head.oid).toBe(baseline.head.oid);
  });

  it("rejects stale writes after metadata is replaced at the same working directory", async () => {
    const root = temp.mkdirSync("git-lifecycle-replace-");
    const workingDirectory = path.join(root, "repository");
    copyRepository(workingDirectory);
    const original = await open(workingDirectory);
    await configure(original, "original");
    const descriptor = original.getHostDescriptor();
    // Move the old metadata away to prevent filesystem inode reuse from
    // making two genuinely different repositories look like one identity.
    fs.renameSync(path.join(workingDirectory, ".git"), path.join(root, "old.git"));
    fs.copySync(
      path.join(__dirname, "fixtures", "git", "working-dir", "git.git"),
      path.join(workingDirectory, ".git"),
    );
    const replacement = await open(workingDirectory);
    await configure(replacement, "replacement");

    await expectAsync(
      GitHost.instance().request("execRepository", {
        descriptor,
        args: ["config", "lumine.lifecycle", "stale-write"],
        options: {},
        raw: false,
      }),
    ).toBeRejectedWith(jasmine.objectContaining({ code: "ERR_GIT_REPOSITORY_UNAVAILABLE" }));
    await expectAsync(original.getConfigValueAsync("lumine.lifecycle")).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_REPOSITORY_UNAVAILABLE" }),
    );
    expect(await replacement.getConfigValueAsync("lumine.lifecycle")).toBe("replacement");
  });

  it("reports missing Git structure without publishing another status snapshot", async () => {
    const root = temp.mkdirSync("git-lifecycle-delete-");
    copyRepository(root);
    const repository = await open(root);
    const baseline = await repository.refreshStatusSnapshot();
    fs.unlinkSync(path.join(root, ".git", "HEAD"));
    await expectAsync(repository.refreshStatusSnapshot()).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_REPOSITORY_UNAVAILABLE" }),
    );
    expect(repository.getStatusSnapshot()).toBe(baseline);
  });

  it("handles a case-only rename according to the filesystem's path semantics", async () => {
    const root = temp.mkdirSync("git-lifecycle-case-");
    const original = path.join(root, "repository");
    const renamed = path.join(root, "REPOSITORY");
    copyRepository(original);
    const repository = await open(original);
    await configure(repository, "case-rename");
    fs.renameSync(original, renamed);
    // Case-insensitive filesystems still resolve the subscriber's old spelling.
    if (fs.existsSync(original)) {
      expect(await repository.getConfigValueAsync("lumine.lifecycle")).toBe("case-rename");
    } else {
      await expectAsync(repository.getConfigValueAsync("lumine.lifecycle")).toBeRejectedWith(
        jasmine.objectContaining({ code: "ERR_GIT_REPOSITORY_UNAVAILABLE" }),
      );
    }
    const replacement = await open(renamed);
    expect(await replacement.getConfigValueAsync("lumine.lifecycle")).toBe("case-rename");
  });
});
