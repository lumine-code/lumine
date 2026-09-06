const fs = require("fs");
const path = require("path");

const temp = require("@lumine-code/temp").track();

const GitRepositoryOperationProvider = require("../src/git-repository-operation-provider");
const GitRepository = require("../src/git-repository");
const { discoverRepositoryDescriptor } = require("../src/git-repository-descriptor");

function repositoryContext(workingDirectory, overrides = {}) {
  const gitDirectory = overrides.gitDirectory || path.join(workingDirectory, ".git");
  const descriptor = Object.freeze({
    gitDirectory,
    workingDirectory,
    worktreeGitMarker:
      overrides.worktreeGitMarker === undefined
        ? { path: path.join(workingDirectory, ".git"), kind: "directory" }
        : overrides.worktreeGitMarker,
  });
  return {
    repository: { getHostDescriptor: () => descriptor },
    gitDirectory,
    workingDirectory,
  };
}

describe("GitRepositoryOperationProvider", () => {
  it("requires an exact descriptor even with an injected command transport", () => {
    const provider = new GitRepositoryOperationProvider({
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(() =>
      provider.createRepositoryOperations({
        gitDirectory: "/repo/.git",
        workingDirectory: "/repo",
      }),
    ).toThrowError(TypeError, "Repository operations require an exact repository descriptor");
  });

  it("routes commands and output files through one GitHostClient", async () => {
    const gitHostClient = {
      exec: jasmine.createSpy("exec").and.resolveTo({ exitCode: 0, stdout: "ok", stderr: "" }),
      execRepository: jasmine
        .createSpy("execRepository")
        .and.resolveTo({ exitCode: 0, stdout: "ok", stderr: "" }),
      writeRepositoryCommandOutput: jasmine
        .createSpy("writeRepositoryCommandOutput")
        .and.resolveTo({ exitCode: 0, stderr: "" }),
    };
    const provider = new GitRepositoryOperationProvider({ gitHostClient });
    const workingDirectory = temp.mkdirSync("git-client-transport");
    const context = repositoryContext(workingDirectory, {
      gitDirectory: path.join(workingDirectory, "storage.git"),
      worktreeGitMarker: { path: path.join(workingDirectory, ".git"), kind: "gitfile" },
    });

    await provider.executeGit(["status"], workingDirectory);
    const operations = provider.createRepositoryOperations(context);
    await operations.stageFiles(["one.txt"]);
    await operations.expandBlobToFile("output.txt", "abc");

    expect(gitHostClient.exec).toHaveBeenCalledWith(
      ["status"],
      workingDirectory,
      { priority: "interactive" },
      true,
    );
    expect(gitHostClient.execRepository).toHaveBeenCalledWith(
      context.repository.getHostDescriptor(),
      ["add", "--", "one.txt"],
      { priority: "interactive" },
    );
    const [descriptor, args, destinationPath, options] =
      gitHostClient.writeRepositoryCommandOutput.calls.mostRecent().args;
    expect(descriptor).toBe(context.repository.getHostDescriptor());
    expect(args).toEqual(["cat-file", "blob", "abc"]);
    expect(destinationPath).toBe(path.join(workingDirectory, "output.txt"));
    expect(options.priority).toBe("interactive");
  });

  it("marks read phases of composite mutations for postvalidation", async () => {
    const calls = [];
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ args, workingDirectory, options });
        return {
          exitCode: 0,
          stdout: args[0] === "ls-files" ? "100644 abc 0\tfile.txt\n" : "",
          stderr: "",
        };
      },
    });
    const workingDirectory = temp.mkdirSync("git-composite-read");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    await operations.stageFileModeChange("file.txt", "100755");

    expect(calls[0].options.repositoryRead).toBe(true);
    expect(calls[1].options.repositoryRead).toBeUndefined();
  });

  it("keeps executeGit, init, and clone on the unbound Git transport", async () => {
    const calls = [];
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options, raw) => {
        calls.push({ args, workingDirectory, options, raw });
        return { exitCode: 0, stdout: "git version test", stderr: "" };
      },
    });
    const workingDirectory = temp.mkdirSync("git-transport");
    const initializedDirectory = path.join(workingDirectory, "initialized");
    const clonedDirectory = path.join(workingDirectory, "cloned");

    const result = await provider.executeGit(["--version"], workingDirectory, { env: { A: "B" } });
    await provider.initializeRepository(initializedDirectory, { initialBranch: "main" });
    await provider.cloneRepository("https://example.test/repo.git", clonedDirectory);

    expect(result.stdout).toBe("git version test");
    expect(calls).toEqual([
      {
        args: ["--version"],
        workingDirectory,
        options: { priority: "interactive", env: { A: "B" } },
        raw: true,
      },
      {
        args: ["init", "--initial-branch=main", "."],
        workingDirectory: initializedDirectory,
        options: { priority: "interactive", initialBranch: "main" },
        raw: false,
      },
      {
        args: ["clone", "--", "https://example.test/repo.git", clonedDirectory],
        workingDirectory,
        options: { priority: "interactive" },
        raw: false,
      },
    ]);
  });

  it("injects the auth broker environment into remote operations only", async () => {
    const calls = [];
    const authBroker = {
      started: 0,
      ensureStarted() {
        this.started++;
        return Promise.resolve();
      },
      getEnvironment({ workingDirectory }) {
        return {
          env: { GIT_ASKPASS: "/tmp/askpass.sh", LUMINE_GIT_AUTH_WORKDIR: workingDirectory },
        };
      },
    };
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ command: args[0], options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      authBroker,
    });
    const workingDirectory = temp.mkdirSync("git-auth-env");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    await operations.fetch("origin", "main");
    await operations.push("origin", "refs/heads/main");
    await operations.pull("origin", "main");
    await operations.stageFiles(["a.txt"]);

    const envFor = (command) => calls.find((call) => call.command === command).options.env;
    expect(envFor("fetch").GIT_ASKPASS).toBe("/tmp/askpass.sh");
    expect(envFor("fetch").LUMINE_GIT_AUTH_WORKDIR).toBe(workingDirectory);
    expect(envFor("push").GIT_ASKPASS).toBe("/tmp/askpass.sh");
    expect(envFor("pull").GIT_ASKPASS).toBe("/tmp/askpass.sh");
    // A non-remote operation gets no auth environment.
    expect(envFor("add")).toBeUndefined();
    expect(authBroker.started).toBe(3);
  });

  it("injects the GPG signing environment into commit and merge when enabled", async () => {
    const calls = [];
    const authBroker = {
      started: 0,
      ensureStarted() {
        this.started++;
        return Promise.resolve();
      },
      getSigningEnvironment({ workingDirectory }) {
        return {
          env: {
            GIT_ASKPASS: "/tmp/askpass.sh",
            LUMINE_GIT_AUTH_GPG_PROMPT: "1",
            LUMINE_GIT_AUTH_WORKDIR: workingDirectory,
          },
          config: { "gpg.program": "/tmp/gpg-wrapper.sh" },
        };
      },
    };
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ command: args[0], options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      authBroker,
    });
    const workingDirectory = temp.mkdirSync("git-signing-env");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    lumine.config.set("git.promptForGpgPassphrase", true);
    try {
      await operations.commit("Subject");
      await operations.merge("topic");
      await operations.stageFiles(["a.txt"]);
    } finally {
      lumine.config.set("git.promptForGpgPassphrase", false);
    }

    const optionsFor = (command) => calls.find((call) => call.command === command).options;
    expect(optionsFor("commit").env.LUMINE_GIT_AUTH_GPG_PROMPT).toBe("1");
    expect(optionsFor("commit").env.GIT_ASKPASS).toBe("/tmp/askpass.sh");
    expect(optionsFor("commit").config["gpg.program"]).toBe("/tmp/gpg-wrapper.sh");
    expect(optionsFor("commit").allowPrompt).toBe(true);
    // The commit message still rides on stdin, not in the argument vector.
    expect(optionsFor("commit").stdin).toBe("Subject");
    expect(optionsFor("merge").config["gpg.program"]).toBe("/tmp/gpg-wrapper.sh");
    expect(optionsFor("merge").allowPrompt).toBe(true);
    // A non-signing operation gets no signing environment.
    expect(optionsFor("add").config).toBeUndefined();
    expect(authBroker.started).toBe(2);
  });

  it("leaves commit and merge on the gpg-agent path when the passphrase prompt is disabled", async () => {
    const calls = [];
    const authBroker = {
      ensureStarted() {
        throw new Error("ensureStarted must not run when the passphrase prompt is disabled");
      },
      getSigningEnvironment() {
        throw new Error(
          "getSigningEnvironment must not run when the passphrase prompt is disabled",
        );
      },
    };
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ command: args[0], options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      authBroker,
    });
    const workingDirectory = temp.mkdirSync("git-signing-off");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    lumine.config.set("git.promptForGpgPassphrase", false);
    await operations.commit("Subject");
    await operations.merge("topic");

    const optionsFor = (command) => calls.find((call) => call.command === command).options;
    expect(optionsFor("commit").config).toBeUndefined();
    expect(optionsFor("commit").allowPrompt).toBeUndefined();
    expect(optionsFor("merge").config).toBeUndefined();
  });

  it("layers auth and signing environments onto pull", async () => {
    const calls = [];
    const authBroker = {
      ensureStarted() {
        return Promise.resolve();
      },
      getEnvironment({ workingDirectory }) {
        return {
          env: { GIT_ASKPASS: "/tmp/askpass.sh", LUMINE_GIT_AUTH_WORKDIR: workingDirectory },
        };
      },
      getSigningEnvironment() {
        return {
          env: { GIT_ASKPASS: "/tmp/askpass.sh", LUMINE_GIT_AUTH_GPG_PROMPT: "1" },
          config: { "gpg.program": "/tmp/gpg-wrapper.sh" },
        };
      },
    };
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ command: args[0], options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      authBroker,
    });
    const workingDirectory = temp.mkdirSync("git-pull-signing");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    // A pull fetches (needs credentials) and may sign a merge/rebase commit.
    lumine.config.set("git.promptForGpgPassphrase", false);
    await operations.pull("origin", "main");
    lumine.config.set("git.promptForGpgPassphrase", true);
    try {
      await operations.pull("origin", "main");
    } finally {
      lumine.config.set("git.promptForGpgPassphrase", false);
    }

    const [disabled, enabled] = calls;
    // Disabled: the auth environment, but nothing GPG.
    expect(disabled.options.env.GIT_ASKPASS).toBe("/tmp/askpass.sh");
    expect(disabled.options.config).toBeUndefined();
    expect(disabled.options.allowPrompt).toBeUndefined();
    // Enabled: the auth environment plus the signing config.
    expect(enabled.options.env.GIT_ASKPASS).toBe("/tmp/askpass.sh");
    expect(enabled.options.env.LUMINE_GIT_AUTH_GPG_PROMPT).toBe("1");
    expect(enabled.options.config["gpg.program"]).toBe("/tmp/gpg-wrapper.sh");
    expect(enabled.options.allowPrompt).toBe(true);
  });

  it("maps repository operations to Git commands without placing commit messages in arguments", async () => {
    const calls = [];
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ args, workingDirectory, options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const workingDirectory = path.join(temp.mkdirSync("git-command-mapping"), "repo");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    await operations.stageFiles(["one.txt", "two.txt"]);
    await operations.commit("Subject", {
      amend: true,
      coAuthors: [{ name: "Example User", email: "user@example.com" }],
    });
    await operations.cherryPick("abc123", { noCommit: true });
    await operations.rebase("main", { autostash: true, rebaseMerges: true });
    await operations.stashPush({
      includeUntracked: true,
      keepIndex: true,
      message: "Work in progress",
      paths: ["one.txt"],
    });
    await operations.stashApply("stash@{2}", { index: true });
    await operations.stashPop("stash@{1}");
    await operations.stashDrop("stash@{0}");

    // The worker receives the bare argument vector; color/trust config and the
    // GIT_TERMINAL_PROMPT environment are applied by the worker's GitRunner.
    expect(calls[0].args).toEqual(["add", "--", "one.txt", "two.txt"]);
    expect(calls[0].workingDirectory).toBe(workingDirectory);
    expect(calls[1].args).toEqual(["commit", "--file=-", "--amend"]);
    expect(calls[1].options.stdin).toBe(
      "Subject\n\nCo-authored-by: Example User <user@example.com>",
    );
    expect(calls[2].args).toEqual(["cherry-pick", "--no-commit", "abc123"]);
    expect(calls[3].args).toEqual(["rebase", "--autostash", "--rebase-merges", "main"]);
    expect(calls[4].args).toEqual([
      "stash",
      "push",
      "--include-untracked",
      "--keep-index",
      "--message",
      "Work in progress",
      "--",
      "one.txt",
    ]);
    expect(calls[5].args).toEqual(["stash", "apply", "--index", "stash@{2}"]);
    expect(calls[6].args).toEqual(["stash", "pop", "stash@{1}"]);
    expect(calls[7].args).toEqual(["stash", "drop", "stash@{0}"]);
  });

  it("maps worktree operations to Git commands with the path last", async () => {
    const calls = [];
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ args, workingDirectory, options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const workingDirectory = path.join(temp.mkdirSync("git-worktree-mapping"), "repo");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    await operations.worktreeAdd("../feature");
    await operations.worktreeAdd("../feature", { branch: "feature", commitish: "origin/main" });
    await operations.worktreeAdd("../detached", { detach: true, commitish: "abc123" });
    await operations.worktreeAdd("../held", {
      force: true,
      checkout: false,
      lock: true,
      reason: "in use",
      forceBranch: true,
      branch: "feature",
      track: false,
    });
    await operations.worktreeRemove("../feature");
    await operations.worktreeRemove("../feature", { force: true });
    await operations.worktreeMove("../feature", "../renamed");
    await operations.worktreeLock("../feature", { reason: "on a slow disk" });
    await operations.worktreeUnlock("../feature");
    await operations.worktreePrune({ dryRun: true, expire: "3.days.ago" });

    expect(calls[0].args).toEqual(["worktree", "add", "../feature"]);
    expect(calls[0].workingDirectory).toBe(workingDirectory);
    // `-b <name>` precedes the path, and the commit-ish trails it.
    expect(calls[1].args).toEqual([
      "worktree",
      "add",
      "-b",
      "feature",
      "../feature",
      "origin/main",
    ]);
    expect(calls[2].args).toEqual(["worktree", "add", "--detach", "../detached", "abc123"]);
    // `--reason` is only meaningful directly after `--lock`.
    expect(calls[3].args).toEqual([
      "worktree",
      "add",
      "--force",
      "--no-checkout",
      "--lock",
      "--reason",
      "in use",
      "-B",
      "feature",
      "--no-track",
      "../held",
    ]);
    expect(calls[4].args).toEqual(["worktree", "remove", "../feature"]);
    expect(calls[5].args).toEqual(["worktree", "remove", "--force", "../feature"]);
    expect(calls[6].args).toEqual(["worktree", "move", "../feature", "../renamed"]);
    expect(calls[7].args).toEqual(["worktree", "lock", "--reason", "on a slow disk", "../feature"]);
    expect(calls[8].args).toEqual(["worktree", "unlock", "../feature"]);
    expect(calls[9].args).toEqual(["worktree", "prune", "--dry-run", "--expire", "3.days.ago"]);
  });

  it("orders `checkout -b <name>` before `--track` so the branch name survives", async () => {
    const calls = [];
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ args, workingDirectory, options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const workingDirectory = path.join(temp.mkdirSync("git-checkout-track"), "repo");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    await operations.checkout("pr-123/owner/feature", {
      createNew: true,
      track: true,
      startPoint: "refs/remotes/origin/feature",
    });

    // The new branch name must immediately follow `-b`; `--track` and the start
    // point come after. Emitting `--track` first made git read it as the branch
    // name ("fatal: '--track' is not a valid branch name").
    expect(calls[0].args).toEqual([
      "checkout",
      "-b",
      "pr-123/owner/feature",
      "--track",
      "refs/remotes/origin/feature",
    ]);
  });

  it("unstages with one reset whether or not HEAD exists", async () => {
    const calls = [];
    const provider = new GitRepositoryOperationProvider({
      exec: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const workingDirectory = path.join(temp.mkdirSync("git-unstage-shape"), "repo");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    await operations.unstageFiles(["one.txt"]);
    await operations.unstageFiles(["two.txt"], { reference: "HEAD~" });

    // Naming no reference already resets against HEAD, or against the empty
    // tree when there is none, so neither a snapshot lookup nor a `rev-parse`
    // probe is needed to tell the two apart.
    expect(calls).toEqual([
      ["reset", "--", "one.txt"],
      ["reset", "HEAD~", "--", "two.txt"],
    ]);
  });

  it("unstages a file rewritten after staging in a repository with no commits", async () => {
    const provider = new GitRepositoryOperationProvider();
    const workingDirectory = temp.mkdirSync("git-unstage-unborn");
    await provider.initializeRepository(workingDirectory, { initialBranch: "main" });
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));
    const filePath = path.join(workingDirectory, "report.log");

    fs.writeFileSync(filePath, "staged\n");
    await operations.stageFiles(["report.log"]);
    // Whatever generated the file writes it again, so the staged blob now
    // matches neither the working tree nor HEAD — and an unborn repository has
    // no HEAD for it to match. `rm --cached` refused exactly this.
    fs.writeFileSync(filePath, "rebuilt\n");

    await operations.unstageFiles(["report.log"]);

    expect((await provider.run(["diff", "--cached", "--name-only"], workingDirectory)).trim()).toBe(
      "",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe("rebuilt\n");
  });

  it("classifies operations by the snapshots they can invalidate", () => {
    const provider = new GitRepositoryOperationProvider({
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const workingDirectory = temp.mkdirSync("git-refresh-hints");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));
    const hint = (name, ...args) => operations.getOperationRefreshHint(name, args);

    expect(hint("stageFiles", ["a.txt"])).toBe("status");
    expect(hint("unstageFiles", ["a.txt"])).toBe("status");
    expect(hint("applyPatch", "patch")).toBe("status");
    expect(hint("checkoutFiles", ["a.txt"], "HEAD")).toBe("status");
    expect(hint("abortMerge")).toBe("status");
    expect(hint("stashPush")).toBe("status");
    expect(hint("stashApply")).toBe("status");
    expect(hint("stashPop")).toBe("status");
    expect(hint("stashDrop")).toBe("none");
    expect(hint("writeMergeConflictToIndex", "a.txt", null, "b", "c")).toBe("status");
    expect(hint("commit", "Subject")).toBe("both");
    expect(hint("cherryPick", "abc123")).toBe("both");
    expect(hint("rebase", "main")).toBe("both");
    expect(hint("checkout", "main")).toBe("both");
    expect(hint("reset", "soft", "HEAD~")).toBe("both");
    expect(hint("deleteRef", "HEAD")).toBe("both");
    expect(hint("fetch", "origin")).toBe("both");
    expect(hint("push", "origin", "main")).toBe("both");
    expect(hint("addRemote", "origin", "https://example.invalid/repo.git")).toBe("refs");
    expect(hint("setRemoteUrl", "origin", "https://example.invalid/repo.git")).toBe("refs");
    expect(hint("removeRemote", "origin")).toBe("both");
    expect(hint("createBlob", { stdin: "contents" })).toBe("none");
    // Worktree operations act on another checkout, so only the refs snapshot —
    // which carries the worktree list — can have gone stale.
    expect(hint("worktreeAdd", "../feature")).toBe("refs");
    expect(hint("worktreeRemove", "../feature")).toBe("refs");
    expect(hint("worktreeMove", "../feature", "../renamed")).toBe("refs");
    expect(hint("worktreeLock", "../feature")).toBe("refs");
    expect(hint("worktreeUnlock", "../feature")).toBe("refs");
    expect(hint("worktreePrune")).toBe("refs");
    // An operation this provider does not know about refreshes everything.
    expect(hint("someFutureOperation")).toBe("both");

    // Config writes matter only for the keys the snapshots actually read.
    expect(hint("setConfig", "user.name", "Someone")).toBe("none");
    expect(hint("setConfig", "lumineGithub.historySha", "abcdef")).toBe("none");
    expect(hint("setConfig", "branch.main.remote", "origin")).toBe("both");
    expect(hint("unsetConfig", "remote.origin.url")).toBe("both");

    // Object-database reads written to disk refresh status only when the file
    // lands inside the working tree.
    const inside = path.join(workingDirectory, "restored.txt");
    const outside = path.join(temp.mkdirSync("git-refresh-hints-out"), "restored.txt");
    expect(hint("expandBlobToFile", inside, "abcdef")).toBe("status");
    expect(hint("expandBlobToFile", outside, "abcdef")).toBe("none");
    expect(hint("mergeFile", "ours", "base", "theirs", "merged/result.txt")).toBe("status");
    expect(hint("mergeFile", "ours", "base", "theirs", outside)).toBe("none");
  });

  it("supports injected configuration, cleanup modes, and merge-file labels", async () => {
    const calls = [];
    const provider = new GitRepositoryOperationProvider({
      exec: async (args, workingDirectory, options) => {
        calls.push({ args, workingDirectory, options });
        if (args.includes("merge-file")) {
          return { exitCode: 1, stdout: "<<<<<<< current\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const workingDirectory = temp.mkdirSync("git-option-mapping");
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));

    await operations.commit("Subject", {
      cleanup: "strip",
      config: { "gpg.program": "/tmp/wrapper.sh" },
    });
    const conflictCode = await operations.mergeFile(
      "ours.txt",
      "base.txt",
      "theirs.txt",
      "out.txt",
      {
        labels: ["current", "after discard", "before discard"],
      },
    );
    await operations.stageFileSymlinkChange("link.txt");

    // The per-command `-c` config is passed through in options and applied by the
    // worker's GitRunner, not baked into the argument vector here.
    expect(calls[0].args).toEqual(["commit", "--file=-", "--cleanup=strip"]);
    expect(calls[0].options.config).toEqual({ "gpg.program": "/tmp/wrapper.sh" });
    expect(calls[1].args).toEqual([
      "merge-file",
      "--stdout",
      "-L",
      "current",
      "-L",
      "after discard",
      "-L",
      "before discard",
      "ours.txt",
      "base.txt",
      "theirs.txt",
    ]);
    expect(calls[1].options.encoding).toBe("buffer");
    expect(calls[2].args).toEqual(["rm", "--cached", "--force", "--", "link.txt"]);
    expect(conflictCode).toBe(1);
    expect(fs.readFileSync(path.join(workingDirectory, "out.txt"), "utf8")).toBe(
      "<<<<<<< current\n",
    );
  });

  it("maps only a missing createBlob source to the public race error", async () => {
    const missing = Object.assign(new Error("missing"), {
      code: "ERR_GIT_COMMAND_FAILED",
      exitCode: 128,
      stderr: "fatal: could not open 'gone.txt' for reading: No such file or directory",
    });
    const permission = Object.assign(new Error("denied"), {
      code: "ERR_GIT_COMMAND_FAILED",
      exitCode: 128,
      stderr: "fatal: unable to write object: Permission denied",
    });
    let failure = missing;
    const provider = new GitRepositoryOperationProvider({
      exec: async () => Promise.reject(failure),
    });
    const operations = provider.createRepositoryOperations(repositoryContext("/repo"));

    let missingResult;
    try {
      await operations.createBlob({ filePath: "gone.txt" });
    } catch (error) {
      missingResult = error;
    }
    expect(missingResult.code).toBe("ERR_GIT_CREATE_BLOB");
    expect(missingResult.gitCode).toBe("ERR_GIT_COMMAND_FAILED");

    failure = permission;
    await expectAsync(operations.createBlob({ filePath: "protected.txt" })).toBeRejectedWith(
      permission,
    );
  });

  it("writes merge conflict stages to the index for a tracked file", async () => {
    const provider = new GitRepositoryOperationProvider();
    const workingDirectory = temp.mkdirSync("git-conflict-index");
    await provider.initializeRepository(workingDirectory, { initialBranch: "main" });
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));
    await operations.setConfig("user.name", "Lumine Specs");
    await operations.setConfig("user.email", "specs@lumine.invalid");
    fs.writeFileSync(path.join(workingDirectory, "conflict.txt"), "committed\n");
    await operations.stageFiles(["conflict.txt"]);
    await operations.commit("Initial commit");

    const oursSha = await operations.createBlob({ stdin: "ours\n" });
    const theirsSha = await operations.createBlob({ stdin: "theirs\n" });
    await operations.writeMergeConflictToIndex("conflict.txt", null, oursSha, theirsSha);

    const stageLines = (
      await provider.run(["ls-files", "-s", "--", "conflict.txt"], workingDirectory)
    )
      .trim()
      .split("\n");
    expect(stageLines.map((line) => line.split(/\s+/)[2])).toEqual(["2", "3"]);
    expect(stageLines[0]).toContain(oursSha);
    expect(stageLines[1]).toContain(theirsSha);
  });

  it("initializes, writes, and commits through the embedded Git distribution", async () => {
    const provider = new GitRepositoryOperationProvider();
    const workingDirectory = temp.mkdirSync("git-real-repository");

    await provider.initializeRepository(workingDirectory, { initialBranch: "main" });
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));
    await operations.setConfig("user.name", "Lumine Specs");
    await operations.setConfig("user.email", "specs@lumine.invalid");
    fs.writeFileSync(path.join(workingDirectory, "README.md"), "# Test\n");
    await operations.stageFiles(["README.md"]);
    await operations.unstageFiles(["README.md"]);
    expect((await provider.run(["diff", "--cached", "--name-only"], workingDirectory)).trim()).toBe(
      "",
    );
    await operations.stageFiles(["README.md"]);
    await operations.commit("Initial commit");

    expect((await provider.run(["branch", "--show-current"], workingDirectory)).trim()).toBe(
      "main",
    );
    expect((await provider.run(["log", "-1", "--format=%s"], workingDirectory)).trim()).toBe(
      "Initial commit",
    );
  });

  it("adds, lists, removes, and prunes worktrees through the embedded Git distribution", async () => {
    const provider = new GitRepositoryOperationProvider();
    const workingDirectory = temp.mkdirSync("git-real-worktrees");
    const worktreePath = path.join(temp.mkdirSync("git-real-worktrees-linked"), "feature");

    await provider.initializeRepository(workingDirectory, { initialBranch: "main" });
    const operations = provider.createRepositoryOperations(repositoryContext(workingDirectory));
    await operations.setConfig("user.name", "Lumine Specs");
    await operations.setConfig("user.email", "specs@lumine.invalid");
    fs.writeFileSync(path.join(workingDirectory, "README.md"), "# Test\n");
    await operations.stageFiles(["README.md"]);
    await operations.commit("Initial commit");

    await operations.worktreeAdd(worktreePath, { branch: "feature" });
    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);
    expect((await provider.run(["branch", "--show-current"], worktreePath)).trim()).toBe("feature");
    const linkedGitDirectory = discoverRepositoryDescriptor(worktreePath).getPath();
    const linkedDescriptor = discoverRepositoryDescriptor(linkedGitDirectory);
    const linkedRepository = new GitRepository(linkedDescriptor);
    expect(linkedDescriptor.getWorkingDirectory()).toBe(
      fs.realpathSync.native(worktreePath).replace(/\\/g, "/"),
    );
    expect(linkedDescriptor.getWorktreeGitMarker().kind).toBe("gitfile");
    expect(await linkedRepository.getDescription()).toBe("feature");
    linkedRepository.destroy();

    const listed = await provider.run(["worktree", "list", "--porcelain"], workingDirectory);
    expect(listed).toContain("branch refs/heads/feature");

    // A branch held by another worktree cannot be checked out here — the very
    // failure the branch picker has to route around instead of attempting.
    let checkoutError;
    try {
      await operations.checkout("feature");
    } catch (caughtError) {
      checkoutError = caughtError;
    }
    expect(checkoutError.name).toBe("GitOperationError");

    await operations.worktreeLock(worktreePath, { reason: "spec" });
    expect(await provider.run(["worktree", "list", "--porcelain"], workingDirectory)).toContain(
      "locked spec",
    );
    await operations.worktreeUnlock(worktreePath);

    await operations.worktreeRemove(worktreePath);
    await operations.worktreePrune();
    expect(
      (await provider.run(["worktree", "list", "--porcelain"], workingDirectory)).trim(),
    ).not.toContain("refs/heads/feature");
  });

  it("uses a moved --separate-git-dir worktree through its exact descriptor", async () => {
    const provider = new GitRepositoryOperationProvider();
    const rootDirectory = temp.mkdirSync("git-real-separate-dir");
    const originalWorkingDirectory = path.join(rootDirectory, "original worktree");
    const movedWorkingDirectory = path.join(rootDirectory, "moved worktree");
    const gitDirectory = path.join(rootDirectory, "metadata.git");
    fs.mkdirSync(originalWorkingDirectory);

    const initialized = await provider.executeGit(
      ["init", "--initial-branch=main", `--separate-git-dir=${gitDirectory}`, "."],
      originalWorkingDirectory,
    );
    expect(initialized.exitCode).toBe(0);
    fs.renameSync(originalWorkingDirectory, movedWorkingDirectory);
    const descriptor = discoverRepositoryDescriptor(movedWorkingDirectory);
    const repository = new GitRepository(descriptor);
    const operations = provider.createRepositoryOperations({ repository });

    expect(descriptor.getWorkingDirectory()).toBe(
      fs.realpathSync.native(movedWorkingDirectory).replace(/\\/g, "/"),
    );
    expect(descriptor.getWorktreeGitMarker().kind).toBe("gitfile");
    await operations.setConfig("user.name", "Lumine Specs");
    await operations.setConfig("user.email", "specs@lumine.invalid");
    fs.writeFileSync(path.join(movedWorkingDirectory, "README.md"), "# Separate\n");
    await operations.stageFiles(["README.md"]);
    await operations.commit("Separate Git directory");

    expect(await repository.getDescription()).toBe("main");
    expect((await repository.getCommits({ limit: 1 })).commits[0].subject).toBe(
      "Separate Git directory",
    );
    repository.destroy();
  });

  it("clones a local repository through the embedded Git distribution", async () => {
    const provider = new GitRepositoryOperationProvider();
    const sourcePath = temp.mkdirSync("git-clone-source");
    const destinationPath = path.join(temp.mkdirSync("git-clone-parent"), "destination");

    await provider.initializeRepository(sourcePath, { initialBranch: "main" });
    const sourceOperations = provider.createRepositoryOperations(repositoryContext(sourcePath));
    await sourceOperations.setConfig("user.name", "Lumine Specs");
    await sourceOperations.setConfig("user.email", "specs@lumine.invalid");
    fs.writeFileSync(path.join(sourcePath, "file.txt"), "content\n");
    await sourceOperations.stageFiles(["file.txt"]);
    await sourceOperations.commit("Clone source");

    await provider.cloneRepository(sourcePath, destinationPath, { noLocal: true });

    expect(fs.readFileSync(path.join(destinationPath, "file.txt"), "utf8").trim()).toBe("content");
    expect((await provider.run(["log", "-1", "--format=%s"], destinationPath)).trim()).toBe(
      "Clone source",
    );
  });

  it("returns structured errors for failed Git commands", async () => {
    const provider = new GitRepositoryOperationProvider();
    const workingDirectory = temp.mkdirSync("git-error-repository");
    await provider.initializeRepository(workingDirectory);

    let error;
    try {
      await provider.run(["checkout", "missing-reference"], workingDirectory);
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error.name).toBe("GitOperationError");
    expect(error.code).toBe("ERR_GIT_COMMAND_FAILED");
    expect(error.command).toBe("checkout");
    expect(error.exitCode).not.toBe(0);
    expect(error.stderr.length).toBeGreaterThan(0);
  });

  it("drives the public repository API through git-host", async () => {
    const workingDirectory = temp.mkdirSync("git-public-repository-api");
    const repository = await lumine.repositories.initialize(workingDirectory, {
      initialBranch: "main",
    });

    try {
      expect(repository.getOperations().isAvailable("commit")).toBe(true);
      await repository.getOperations().setConfig("user.name", "Lumine Specs");
      await repository.getOperations().setConfig("user.email", "specs@lumine.invalid");
      fs.writeFileSync(path.join(workingDirectory, "public-api.txt"), "public api\n");

      const untrackedSnapshot = await repository.refreshStatusSnapshot();
      expect(repository.getStatusEntry("public-api.txt")).toBe(untrackedSnapshot.files[0]);
      expect(repository.getStatusEntry("public-api.txt").untracked).toBe(true);

      await repository.getOperations().stageFiles(["public-api.txt"]);
      expect(repository.getStatusEntry("public-api.txt").indexStatus).toBe("A");
      await repository.getOperations().commit("Public API commit");

      expect(repository.getShortHead()).toBe("main");
      expect(repository.isPathModified("public-api.txt")).toBe(false);
      expect(repository.getStatusSnapshot().files).toEqual([]);
    } finally {
      lumine.repositories.forget(repository);
    }
  });
});
