const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();
const { Disposable, Emitter } = require("@lumine-code/event-kit");
const { GitError } = require("lumine");
const GitRunner = require("../src/git-runner");
const GitRepositoryOperations = require("../src/git-repository-operations");
const GitWorkflowPolicy = require("../src/git-workflow-policy");
const RepositoryRegistry = require("../src/repository-registry");
const RepositoryPathObserver = require("../src/repository-path-observer");
const { serializeError, reviveError } = require("../src/git-host-protocol");
const { createGitExec } = require("../src/git-executor");

function deferred() {
  let resolve, reject;
  const promise = new Promise((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeRepository(directory) {
  const emitter = new Emitter();
  const snapshot = { initialized: true, head: { name: "main", oid: "a".repeat(40) } };
  let destroyed = false;
  return {
    snapshot,
    getWorkingDirectory: () => directory,
    getPath: () => path.join(directory, ".git"),
    getStatusSnapshot: () => snapshot,
    getRefsSnapshot: () => ({ initialized: false }),
    refreshStatusSnapshot: async () => snapshot,
    setOperations(operations) {
      this.operations = operations;
    },
    getOperations() {
      return this.operations;
    },
    isDestroyed: () => destroyed,
    onDidDestroy: (callback) => emitter.once("destroy", callback),
    destroy() {
      destroyed = true;
      emitter.emit("destroy");
      emitter.dispose();
    },
  };
}

describe("Git write boundaries", () => {
  const registries = new Set();
  afterEach(async () => {
    for (const registry of registries) registry.destroy();
    registries.clear();
    await temp.cleanup();
  });

  function registryFor(values = {}) {
    const registry = new RepositoryRegistry({
      config: { get: (key) => values[key] },
      notificationManager: { addWarning() {} },
    });
    registries.add(registry);
    return registry;
  }

  it("checks raw results from a provider that does not enforce exit codes", async () => {
    const registry = registryFor();
    const repository = fakeRepository(temp.mkdirSync("unchecked-provider-result"));
    registry.register(repository);
    const lease = registry.retain(repository, "test-owner");
    const result = { exitCode: 128, stdout: "probe output", stderr: "probe failed" };
    registry.addOperationProvider({
      createRepositoryOperations: () => ({ executeGit: async () => result }),
    });
    const failure = await repository
      .getOperations()
      .executeGit(["status"], { readOnly: true })
      .catch((error) => error);
    expect(failure.code).toBe("ERR_GIT_COMMAND_FAILED");
    expect(failure.stdout).toBe("probe output");
    expect(failure.outcome).toBe("failed");
    expect(registry.getPendingOperations()).toEqual([]);
    expect(
      await repository
        .getOperations()
        .executeGit(["status"], { readOnly: true, allowedExitCodes: [128] }),
    ).toBe(result);
    lease.dispose();
  });

  it("uses the shared confirmation for named and raw force-with-lease pushes", async () => {
    let confirmations = 0;
    const policy = new GitWorkflowPolicy({
      config: { get: (key) => key === "git.confirmForcePush" },
      confirm: async () => {
        confirmations++;
        return 1;
      },
    });
    const repository = {
      refreshStatusSnapshot: async () => ({ head: { name: "feature", oid: "abc" } }),
    };
    for (const [name, args] of [
      ["push", ["origin", "feature", { forceWithLease: true }]],
      ["executeGit", [["push", "--force-with-lease=feature:abc"], {}]],
    ]) {
      expect(policy.requiresCheck(name, args)).toBe(true);
      const failure = await policy.assertAllowed(repository, name, args).catch((error) => error);
      expect(failure.code).toBe("ERR_GIT_OPERATION_CANCELLED");
      expect(failure.outcome).toBe("not-started");
    }
    expect(confirmations).toBe(2);
  });

  it("rejects repository selectors in bound raw argv, including after config arguments", async () => {
    const runRepositoryRaw = jasmine.createSpy("raw backend").and.resolveTo({ exitCode: 0 });
    const operations = new GitRepositoryOperations(
      { runRepositoryRaw },
      { workingDirectory: process.cwd() },
    );
    for (const prefix of [[], ["-c", "color.ui=false"], ["--config-env", "color.ui=COLOR_UI"]]) {
      for (const selector of [
        "--git-dir=elsewhere",
        "--work-tree=elsewhere",
        "--namespace=other",
        "-Celsewhere",
      ]) {
        let failure;
        try {
          await operations.executeGit([...prefix, selector, "status"]);
        } catch (error) {
          failure = error;
        }
        expect(failure?.code)
          .withContext([...prefix, selector].join(" "))
          .toBe("ERR_GIT_REPOSITORY_SELECTOR");
      }
    }
    expect(runRepositoryRaw).not.toHaveBeenCalled();
    await operations.executeGit(["log", "--", "--git-dir=filename"]);
    expect(runRepositoryRaw).toHaveBeenCalledTimes(1);
  });

  it("checks bound raw exit codes by default and revives the shared GitError identity", async () => {
    const result = { exitCode: 128, stdout: "diagnostic output", stderr: "invalid revision" };
    const runner = new GitRunner({ execute: async () => result });
    const operations = new GitRepositoryOperations(
      {
        runRepositoryRaw: (args, descriptor, options) =>
          runner.runRawResult(args, descriptor.workingDirectory, options),
      },
      { workingDirectory: process.cwd() },
    );
    const failure = await operations.executeGit(["show", "missing"]).catch((error) => error);
    expect(failure instanceof GitError).toBe(true);
    expect(failure.exitCode).toBe(128);
    expect(failure.stdout).toBe(result.stdout);
    const revived = reviveError(serializeError(failure));
    expect(revived instanceof GitError).toBe(true);
    expect(revived.exitCode).toBe(128);
    expect(revived.stderr).toBe(result.stderr);
    expect(
      await operations.executeGit(["show", "missing"], { allowedExitCodes: [0, 128] }),
    ).toEqual(result);
    await expectAsync(
      operations.executeGit(["show", "missing"], { allowedExitCodes: [0, 1] }),
    ).toBeRejectedWithError(/invalid revision/);
  });

  it("discovers an uncached cwd and queues its raw command behind a named write", async () => {
    const directory = temp.mkdirSync("git-boundary-queue-");
    const repository = fakeRepository(directory);
    const registry = registryFor();
    const started = deferred(),
      finish = deferred();
    const calls = [];
    const unbound = jasmine.createSpy("unbound transport");
    const bound = jasmine.createSpy("bound transport").and.callFake(async () => {
      calls.push("raw");
      return { exitCode: 0 };
    });
    registry.addOperationProvider({
      executeGit: unbound,
      createRepositoryOperations: () => ({
        executeGit: bound,
        commit: async () => {
          calls.push("commit");
          started.resolve();
          await finish.promise;
          return "written";
        },
      }),
    });
    const discovery = spyOn(registry, "resolveForPath").and.callFake(async () => {
      registry.register(repository);
      registry.retain(repository, "boundary-test");
      return repository;
    });
    expect(registry.getForPath(directory)).toBeNull();
    await registry.resolveForPath(directory);
    const first = repository.getOperations().commit("Subject");
    await started.promise;
    // Force this command's path lookup through discovery while the named turn is held.
    spyOn(registry, "getForPath").and.returnValue(null);
    const next = registry.executeGit(["status"], directory, { readOnly: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(bound).not.toHaveBeenCalled();
    finish.resolve();
    expect(await first).toBe("written");
    expect((await next).exitCode).toBe(0);
    expect(calls).toEqual(["commit", "raw"]);
    expect(discovery).toHaveBeenCalledWith(directory, { refresh: false });
    expect(unbound).not.toHaveBeenCalled();
  });

  it("applies branch policy to a raw write after discovering its uncached cwd", async () => {
    const directory = temp.mkdirSync("git-boundary-policy-");
    const repository = fakeRepository(directory);
    const registry = registryFor({ "git.protectCommits": true, "git.protectedBranches": ["main"] });
    const transport = jasmine.createSpy("Git transport");
    registry.addOperationProvider({
      executeGit: transport,
      createRepositoryOperations: () => ({ executeGit: transport }),
    });
    spyOn(registry, "resolveForPath").and.callFake(async () => {
      registry.register(repository);
      return repository;
    });
    expect(registry.getForPath(directory)).toBeNull();
    const failure = await registry
      .executeGit(["commit", "-m", "Subject"], directory)
      .catch((error) => error);
    expect(failure.code).toBe("ERR_GIT_OPERATION_BLOCKED");
    expect(failure.outcome).toBe("not-started");
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a force push whose confirmation outlives a switch to a protected HEAD", async () => {
    let head = { name: "feature", oid: "a" };
    const values = {
      "git.protectPushes": true,
      "git.protectedBranches": ["main"],
      "git.confirmForcePush": true,
    };
    const refresh = jasmine.createSpy("refresh HEAD").and.callFake(async () => ({ head }));
    const confirm = jasmine.createSpy("confirm").and.callFake(async () => {
      head = { name: "main", oid: "b" };
      return 0;
    });
    const policy = new GitWorkflowPolicy({ config: { get: (key) => values[key] }, confirm });
    const failure = await policy
      .assertAllowed({ refreshStatusSnapshot: refresh }, "executeGit", [["push", "--force"], {}])
      .catch((error) => error);
    expect(failure.code).toBe("ERR_GIT_OPERATION_BLOCKED");
    expect(failure.outcome).toBe("not-started");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("preserves the newest readiness observer when its callback synchronously changes paths", async () => {
    const events = new Emitter(),
      paths = new Emitter(),
      statusEvents = new Emitter();
    const readiness = deferred();
    const first = {
      getStatusSnapshot: () => ({ initialized: true }),
      onDidDestroy: () => new Disposable(),
    };
    const status = { initialized: false };
    const second = {
      getStatusSnapshot: () => status,
      onDidDestroy: () => new Disposable(),
      onDidChangeStatusSnapshot: (callback) => statusEvents.on("status", callback),
      ensureStatusSnapshot: () => readiness.promise,
    };
    const routes = new Map([
      ["/first", first],
      ["/second", second],
    ]);
    let filePath = "/first";
    const callback = jasmine.createSpy("path observer").and.callFake((_repository, context) => {
      if (context.path === "/first") {
        filePath = "/second";
        paths.emit("path");
      }
    });
    const observer = new RepositoryPathObserver(
      {
        getForPath: (value) => routes.get(value),
        onDidChange: (handler) => events.on("routing", handler),
        retain: () => new Disposable(),
        resolveForPath: async (value) => routes.get(value),
      },
      () => filePath,
      callback,
      { snapshots: "status", onDidChangePath: (handler) => paths.on("path", handler) },
    );
    try {
      readiness.reject(new Error("initial load failed"));
      await Promise.resolve();
      await Promise.resolve();
      status.initialized = true;
      statusEvents.emit("status");
      expect(callback.calls.mostRecent().args).toEqual([second, { path: "/second", ready: true }]);
    } finally {
      observer.dispose();
      events.dispose();
      paths.dispose();
      statusEvents.dispose();
    }
  });

  it("drains a POSIX Git process group whose child ignores the first termination signal", async () => {
    if (process.platform === "win32") {
      pending("POSIX process-group escalation; Windows uses taskkill /T /F.");
      return;
    }
    jasmine.useRealClock();
    const directory = temp.mkdirSync("git-boundary-cancel-");
    const marker = path.join(directory, "pid");
    const controller = new AbortController();
    const code =
      "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);";
    const running = createGitExec(process.execPath)(["-e", code, marker], directory, {
      signal: controller.signal,
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }).catch((error) => error);
    try {
      await conditionPromise(() => fs.existsSync(marker));
      const pid = Number(fs.readFileSync(marker, "utf8"));
      controller.abort();
      const failure = await running;
      expect(failure.code).toBe("ABORT_ERR");
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await running;
    }
  }, 15000);
});
