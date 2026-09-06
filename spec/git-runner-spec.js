const GitRunner = require("../src/git-runner");
const { Semaphore } = GitRunner;
const path = require("path");

// Flush enough microtask turns for the semaphore's async acquire() handoffs to
// settle before asserting on in-flight state.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// Records how many fake `git` executions are running at once and hands back a
// resolver per call so the test can drain them one at a time.
function trackingExecute() {
  const state = { active: 0, peak: 0, resolvers: [] };
  const execute = () =>
    new Promise((resolve) => {
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      state.resolvers.push(() => {
        state.active--;
        resolve({ exitCode: 0, stdout: "", stderr: "" });
      });
    });
  return { execute, state };
}

describe("GitRunner concurrency", () => {
  it("never runs more concurrent executions than the limiter allows", async () => {
    const { execute, state } = trackingExecute();
    const runner = new GitRunner({ execute, limiter: new Semaphore(2) });

    const all = Promise.all(Array.from({ length: 6 }, () => runner.run(["status"], "/repo")));

    await flush();
    expect(state.active).toBe(2);
    expect(state.peak).toBe(2);

    // Drain one execution at a time; each freed slot admits exactly one queued
    // execution, so the active count must never exceed the cap.
    for (let i = 0; i < 6; i++) {
      expect(state.active).toBeLessThanOrEqual(2);
      if (state.resolvers.length) state.resolvers.shift()();
      await flush();
    }

    await all;
    expect(state.peak).toBe(2);
  });

  it("bypasses the limiter for interactive (allowPrompt) operations", async () => {
    const { execute, state } = trackingExecute();
    const runner = new GitRunner({ execute, limiter: new Semaphore(2) });

    const all = Promise.all(
      Array.from({ length: 5 }, () => runner.run(["fetch"], "/repo", { allowPrompt: true })),
    );

    await flush();
    // All five run at once despite the cap of 2, because a hung credential
    // prompt must not starve the shared read budget.
    expect(state.peak).toBe(5);

    state.resolvers.forEach((release) => release());
    await all;
  });
});

describe("GitRunner priority lanes", () => {
  it("admits queued interactive commands before earlier background waiters", async () => {
    const starts = [];
    const resolvers = [];
    const execute = (args) =>
      new Promise((resolve) => {
        starts.push(args[args.length - 1]);
        resolvers.push(() => resolve({ exitCode: 0, stdout: "", stderr: "" }));
      });
    const runner = new GitRunner({ execute, limiter: new Semaphore(1) });

    const first = runner.run(["status", "bg-1"], "/repo");
    await flush();
    const second = runner.run(["status", "bg-2"], "/repo");
    const third = runner.run(["status", "int-1"], "/repo", { priority: "interactive" });
    await flush();
    expect(starts).toEqual(["bg-1"]);

    // The interactive command queued after bg-2 yet starts before it.
    resolvers.shift()();
    await flush();
    expect(starts).toEqual(["bg-1", "int-1"]);

    resolvers.shift()();
    await flush();
    expect(starts).toEqual(["bg-1", "int-1", "bg-2"]);

    resolvers.shift()();
    await Promise.all([first, second, third]);
  });

  it("keeps reserved slots off limits to background commands", async () => {
    const { execute, state } = trackingExecute();
    const runner = new GitRunner({
      execute,
      limiter: new Semaphore(2, { reservedInteractive: 1 }),
    });

    const background = Promise.all(
      Array.from({ length: 4 }, () => runner.run(["status"], "/repo")),
    );
    await flush();
    // Background work saturates only max - reserved slots...
    expect(state.active).toBe(1);

    const interactive = runner.run(["add"], "/repo", { priority: "interactive" });
    await flush();
    // ...so the reserved slot admits an interactive command immediately.
    expect(state.active).toBe(2);
    expect(state.peak).toBe(2);

    while (state.resolvers.length > 0) {
      state.resolvers.shift()();
      await flush();
      expect(state.active).toBeLessThanOrEqual(2);
    }
    await Promise.all([background, interactive]);
    expect(state.peak).toBe(2);
  });

  it("removes an aborted command from the queue before it can spawn", async () => {
    const { execute, state } = trackingExecute();
    const limiter = new Semaphore(1);
    const runner = new GitRunner({ execute, limiter });
    const first = runner.run(["status", "running"], "/repo");
    await flush();
    const controller = new AbortController();
    const cancelled = runner.run(["status", "cancelled"], "/repo", {
      signal: controller.signal,
    });
    await flush();

    controller.abort();
    await expectAsync(cancelled).toBeRejectedWithError(Error, /aborted/);
    state.resolvers.shift()();
    await first;
    await flush();

    expect(state.peak).toBe(1);
    expect(state.active).toBe(0);
    expect(state.resolvers).toEqual([]);
    expect(limiter.backgroundQueue).toEqual([]);
  });

  it("routes only priority 'interactive' into the interactive lane", async () => {
    const priorities = [];
    const limiter = {
      run: (fn, priority) => {
        priorities.push(priority);
        return fn();
      },
    };
    const execute = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const runner = new GitRunner({ execute, limiter });

    await runner.run(["status"], "/repo");
    await runner.run(["add"], "/repo", { priority: "interactive" });
    await runner.run(["status"], "/repo", { priority: "urgent" });

    expect(priorities).toEqual(["background", "interactive", "background"]);
  });
});

describe("GitRunner optional locks", () => {
  function capturingExecute() {
    const calls = [];
    const execute = (args, cwd, options) => {
      calls.push({ args, options });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    return { execute, calls };
  }

  it("disables optional locks for background commands only", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute });

    await runner.run(["status"], "/repo");
    await runner.run(["add"], "/repo", { priority: "interactive" });
    await runner.run(["fetch"], "/repo", { allowPrompt: true });

    // A background status must never hold .git/index.lock against a
    // concurrent user-initiated write; interactive and prompting commands
    // keep git's default locking.
    expect(calls[0].options.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(calls[1].options.env.GIT_OPTIONAL_LOCKS).toBeUndefined();
    expect(calls[2].options.env.GIT_OPTIONAL_LOCKS).toBeUndefined();
  });

  it("lets a caller-provided env override the optional-locks default", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute });

    await runner.run(["status"], "/repo", { env: { GIT_OPTIONAL_LOCKS: "1" } });

    expect(calls[0].options.env.GIT_OPTIONAL_LOCKS).toBe("1");
  });
});

describe("GitRunner repository trust", () => {
  function capturingExecute() {
    const calls = [];
    const execute = (args) => {
      calls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    return { execute, calls };
  }

  it("adds -c safe.directory=* when trustAllRepositories is set", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute, trustAllRepositories: true });

    await runner.run(["status"], "/repo");

    const args = calls[0];
    const index = args.indexOf("safe.directory=*");
    expect(index).toBeGreaterThan(-1);
    expect(args[index - 1]).toBe("-c");
    // The bypass precedes the git subcommand.
    expect(index).toBeLessThan(args.indexOf("status"));
  });

  it("does not add safe.directory when trustAllRepositories is not set", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute });

    await runner.run(["status"], "/repo");

    expect(calls[0]).not.toContain("safe.directory=*");
  });

  it("applies trust, config, and environment to raw results without forcing success", async () => {
    const calls = [];
    const runner = new GitRunner({
      trustAllRepositories: true,
      execute: async (args, cwd, options) => {
        calls.push({ args, cwd, options });
        return { exitCode: 7, stdout: "raw", stderr: "failure" };
      },
    });

    const result = await runner.runRawResult(["status"], "/repo", {
      config: { "test.value": "yes" },
      env: { TEST_ENV: "present" },
      priority: "interactive",
    });

    expect(result.exitCode).toBe(7);
    expect(calls[0].args).toContain("safe.directory=*");
    expect(calls[0].args).toContain("test.value=yes");
    expect(calls[0].args).not.toContain("color.diff=false");
    expect(calls[0].options.env.TEST_ENV).toBe("present");
    expect(calls[0].options.env.GIT_EDITOR).toBe("true");
  });
});

describe("GitRunner repository binding", () => {
  function capturingExecute() {
    const calls = [];
    const execute = (args, cwd, options) => {
      calls.push({ args, cwd, options });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    return { execute, calls };
  }

  it("adds an absolute git directory and work tree before the subcommand", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute });
    const cwd = path.join("relative", "caller-cwd");
    const descriptor = {
      gitDirectory: path.join("relative", "repository.git"),
      workingDirectory: path.join("relative", "worktree"),
      worktreeGitMarker: null,
    };

    await runner.run(["status", "--short"], cwd, { repositoryDescriptor: descriptor });

    const { args, cwd: actualCwd } = calls[0];
    const commandIndex = args.indexOf("status");
    const gitDirectoryIndex = args.indexOf("--git-dir");
    const workTreeIndex = args.indexOf("--work-tree");
    expect(args[gitDirectoryIndex + 1]).toBe(path.resolve(descriptor.gitDirectory));
    expect(args[workTreeIndex + 1]).toBe(path.resolve(descriptor.workingDirectory));
    expect(gitDirectoryIndex).toBeLessThan(commandIndex);
    expect(workTreeIndex).toBeLessThan(commandIndex);
    expect(actualCwd).toBe(cwd);
  });

  it("omits the work tree for a bare repository", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute });
    const descriptor = {
      gitDirectory: path.join("relative", "bare.git"),
      workingDirectory: null,
      worktreeGitMarker: null,
    };

    await runner.run(["show-ref"], descriptor.gitDirectory, {
      repositoryDescriptor: descriptor,
    });

    expect(calls[0].args).toContain("--git-dir");
    expect(calls[0].args).not.toContain("--work-tree");
  });

  it("removes repository-selection variables while preserving object overrides", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute });
    const descriptor = {
      gitDirectory: path.resolve("repository.git"),
      workingDirectory: path.resolve("worktree"),
      worktreeGitMarker: null,
    };

    await runner.run(["hash-object", "--stdin"], descriptor.workingDirectory, {
      repositoryDescriptor: descriptor,
      env: {
        GIT_DIR: "wrong-git-dir",
        GIT_WORK_TREE: "wrong-work-tree",
        GIT_COMMON_DIR: "wrong-common-dir",
        GIT_INDEX_FILE: "wrong-index",
        GIT_OBJECT_DIRECTORY: "temporary-objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "repository-objects",
      },
    });

    expect(calls[0].options.unsetEnv).toEqual([
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
    ]);
    expect(calls[0].options.env.GIT_DIR).toBeUndefined();
    expect(calls[0].options.env.GIT_WORK_TREE).toBeUndefined();
    expect(calls[0].options.env.GIT_COMMON_DIR).toBeUndefined();
    expect(calls[0].options.env.GIT_INDEX_FILE).toBeUndefined();
    expect(calls[0].options.env.GIT_OBJECT_DIRECTORY).toBe("temporary-objects");
    expect(calls[0].options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe("repository-objects");
  });

  it("leaves unbound raw execution arguments and environment behavior unchanged", async () => {
    const { execute, calls } = capturingExecute();
    const runner = new GitRunner({ execute });

    await runner.runRawResult(["init", "new-repository"], "caller-cwd", {
      env: { GIT_DIR: "intentional-unbound-value" },
    });

    expect(calls[0].args).toEqual(["init", "new-repository"]);
    expect(calls[0].cwd).toBe("caller-cwd");
    expect(calls[0].options.unsetEnv).toBeUndefined();
    expect(calls[0].options.env.GIT_DIR).toBe("intentional-unbound-value");
  });
});

describe("GitRunner errors", () => {
  it("bounds the diagnostic copied into an error message", async () => {
    const runner = new GitRunner({
      execute: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "failure".repeat(20000),
      }),
    });

    let error;
    try {
      await runner.run(["status"], "/repo");
    } catch (caught) {
      error = caught;
    }

    expect(Buffer.byteLength(error.message)).toBeLessThan(66 * 1024);
    expect(error.message).toContain("[truncated by git-host]");
  });
});
