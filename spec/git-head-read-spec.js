const path = require("path");
const temp = require("@lumine-code/fs-temp").track();
const GitRepository = require("../src/git-repository");
const GitRepositoryOperationProvider = require("../src/git-repository-operation-provider");
const GitRepositoryRefsProvider = require("../src/git-repository-refs-provider");
const { discoverRepositoryDescriptorAsync } = require("../src/git-repository-descriptor");

describe("fresh Git HEAD reads", () => {
  it("queries just the symbolic ref and resolved object ID", async () => {
    const runner = { run: jasmine.createSpy("Git runner").and.resolveTo("") };
    const provider = new GitRepositoryRefsProvider({ runner });
    const signal = new AbortController().signal;
    await provider.readHead("repository", { priority: "interactive", signal });

    const options = { priority: "interactive", signal, allowedExitCodes: [0, 1] };
    expect(runner.run.calls.allArgs()).toEqual([
      [["symbolic-ref", "--quiet", "HEAD"], "repository", options],
      [["rev-parse", "--verify", "--quiet", "HEAD"], "repository", options],
    ]);
  });

  it("reads unborn and detached HEAD and resolves linked worktree HEAD independently", async () => {
    const provider = new GitRepositoryOperationProvider();
    const directory = temp.mkdirSync("fresh-git-head");
    await provider.initializeRepository(directory, { initialBranch: "main" });
    const repository = new GitRepository(await discoverRepositoryDescriptorAsync(directory));
    let linked;
    try {
      const operations = provider.createRepositoryOperations({ repository });
      const unborn = await repository.readHead();
      expect(unborn).toEqual({
        name: "main",
        ref: "refs/heads/main",
        oid: null,
        detached: false,
        unborn: true,
      });
      expect(Object.isFrozen(unborn)).toBeTrue();

      await operations.setConfig("user.name", "Lumine Specs");
      await operations.setConfig("user.email", "specs@lumine.invalid");
      await operations.commit("First", { allowEmpty: true });
      const original = await repository.readHead();
      expect(original.oid).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
      expect(original).toEqual({ ...unborn, oid: original.oid, unborn: false });

      const worktree = path.join(temp.mkdirSync("fresh-git-head-peer"), "linked");
      await operations.worktreeAdd(worktree, { branch: "feature" });
      linked = new GitRepository(await discoverRepositoryDescriptorAsync(worktree));
      await operations.checkout(original.oid, { detach: true });

      expect(await repository.readHead()).toEqual({
        oid: original.oid,
        name: null,
        ref: null,
        detached: true,
        unborn: false,
      });
      expect(await linked.readHead()).toEqual({
        ...original,
        name: "feature",
        ref: "refs/heads/feature",
      });
      expect(repository.getStatusSnapshot().initialized).toBeFalse();
      expect(repository.getRefsSnapshot().initialized).toBeFalse();
    } finally {
      linked?.destroy();
      repository.destroy();
    }
  });
});
