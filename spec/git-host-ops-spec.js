const GitRunner = require("../src/git-runner");
const createGitHostOps = require("../src/git-host-ops");
const { GitHostOperations } = require("../src/git-host-protocol");

describe("git-host ops", () => {
  let cliCalls;
  let nativeCalls;

  function nativeBackend(overrides = {}) {
    const record =
      (operation, result) =>
      (...args) => {
        nativeCalls.push({ operation, args });
        return typeof result === "function" ? result(...args) : Promise.resolve(result);
      };
    return {
      versions: () => ({ gitUtils: "10.0.0", napi: 10, libgit2: "1.9.6" }),
      configure: (options) => options,
      snapshot: record("snapshot", {}),
      diff: record("diff", { schemaVersion: 1, files: [] }),
      history: record("history", []),
      commit: record("commit", null),
      blame: record("blame", []),
      describe: record("describe", "main"),
      branchesContaining: record("branchesContaining", []),
      readObjects: record("readObjects", []),
      readConfig: record("readConfig", {}),
      fileMode: record("fileMode", null),
      submodulePaths: record("submodulePaths", []),
      ...overrides,
    };
  }

  function createOps({ native = {}, cliResult = {} } = {}) {
    cliCalls = [];
    nativeCalls = [];
    const execute = (args, cwd, options) => {
      cliCalls.push({ args, cwd, options });
      return Promise.resolve({ exitCode: 0, stdout: "OUT", stderr: "", ...cliResult });
    };
    return createGitHostOps(new GitRunner({ execute }), {
      nativeBackend: nativeBackend(native),
    });
  }

  const descriptor = { gitDirectory: "/repo/.git", workingDirectory: "/repo" };

  it("implements every operation in the shared protocol registry", () => {
    expect(Object.keys(createOps()).sort()).toEqual(Object.keys(GitHostOperations).sort());
  });

  it("routes refs-only snapshots to git-utils without spawning Git", async () => {
    const value = {
      refs: { fingerprint: "def", unchanged: true },
    };
    const ops = createOps({ native: { snapshot: async () => value } });
    const controller = new AbortController();
    const result = await ops.snapshot(
      { descriptor, request: { status: false, refs: true } },
      { signal: controller.signal },
    );

    expect(result).toEqual(value);
    expect(cliCalls).toEqual([]);
  });

  it("routes status to CLI while reading refs natively in parallel", async () => {
    const oid = "a".repeat(40);
    const statusOutput = `# branch.oid ${oid}\0# branch.head main\0? untracked.txt\0`;
    let nativeRequest;
    const refs = { fingerprint: "refs", unchanged: true };
    const ops = createOps({
      cliResult: { stdout: statusOutput },
      native: {
        snapshot: async (receivedDescriptor, request) => {
          expect(receivedDescriptor).toEqual(descriptor);
          nativeRequest = request;
          return { refs };
        },
      },
    });
    const controller = new AbortController();
    const result = await ops.snapshot(
      {
        descriptor,
        request: {
          status: true,
          refs: true,
          includeIgnored: true,
          knownFingerprints: {},
          generations: { status: 7, refs: 4 },
        },
        options: { priority: "interactive" },
      },
      { signal: controller.signal },
    );

    expect(nativeRequest.status).toBe(false);
    expect(nativeRequest.refs).toBe(true);
    expect(result.refs).toBe(refs);
    expect(result.status.unchanged).toBe(false);
    expect(result.status.value.generation).toBe(7);
    expect(result.status.value.files[0].path).toBe("untracked.txt");
    expect(cliCalls.length).toBe(1);
    expect(cliCalls[0].args).toContain("status");
    expect(cliCalls[0].args).toContain("--ignored=matching");
    expect(cliCalls[0].options.env.GIT_OPTIONAL_LOCKS).toBeUndefined();
    expect(cliCalls[0].options.signal).toBe(controller.signal);

    const unchanged = await ops.snapshot(
      {
        descriptor,
        request: {
          status: true,
          refs: false,
          includeIgnored: true,
          knownFingerprints: { status: result.status.fingerprint },
          generations: { status: 8 },
        },
      },
      {},
    );
    expect(unchanged.status).toEqual({
      fingerprint: result.status.fingerprint,
      unchanged: true,
    });
  });

  it("returns a successful CLI status section when native refs fail", async () => {
    const oid = "a".repeat(40);
    const nativeError = Object.assign(new Error("refs failed"), {
      code: "ERR_GIT_NATIVE_SNAPSHOT",
    });
    const ops = createOps({
      cliResult: {
        stdout: `# branch.oid ${oid}\0# branch.head main\0? untracked.txt\0`,
      },
      native: { snapshot: async () => Promise.reject(nativeError) },
    });

    const result = await ops.snapshot(
      {
        descriptor,
        request: { status: true, refs: true, generations: { status: 1, refs: 1 } },
      },
      {},
    );

    expect(result.status.value.files[0].path).toBe("untracked.txt");
    expect(result.refs).toBeUndefined();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].section).toBe("refs");
    expect(result.errors[0].backend).toBe("git-utils");
    expect(result.errors[0].error.code).toBe("ERR_GIT_SNAPSHOT");
    expect(result.errors[0].error.backendCode).toBe("ERR_GIT_NATIVE_SNAPSHOT");
  });

  it("returns successful native refs when CLI status fails", async () => {
    cliCalls = [];
    nativeCalls = [];
    const cliError = Object.assign(new Error("status failed"), {
      code: "ERR_GIT_COMMAND_FAILED",
    });
    const refs = { fingerprint: "refs", unchanged: true };
    const ops = createGitHostOps(new GitRunner({ execute: () => Promise.reject(cliError) }), {
      nativeBackend: nativeBackend({ snapshot: async () => ({ refs }) }),
    });

    const result = await ops.snapshot(
      {
        descriptor,
        request: { status: true, refs: true },
      },
      {},
    );

    expect(result.refs).toBe(refs);
    expect(result.status).toBeUndefined();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].section).toBe("status");
    expect(result.errors[0].backend).toBe("cli");
    expect(result.errors[0].error.code).toBe("ERR_GIT_SNAPSHOT");
    expect(result.errors[0].error.backendCode).toBe("ERR_GIT_COMMAND_FAILED");
  });

  it("routes structured diffs to git-utils and enforces maxBytes", async () => {
    const ops = createOps({
      native: {
        diff: async () => ({
          schemaVersion: 1,
          files: [{ oldPath: "a", newPath: "a", hunks: [{ lines: [{ text: "changed" }] }] }],
        }),
      },
    });

    const result = await ops.diff(
      { descriptor, request: { format: "structured" }, maxBytes: 1024 },
      {},
    );
    expect(result.files.length).toBe(1);
    expect(cliCalls).toEqual([]);

    let error;
    try {
      await ops.diff({ descriptor, request: { format: "structured" }, maxBytes: 4 }, {});
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_DIFF_TOO_LARGE");
  });

  it("routes worktree diffs to CLI with requested formatting", async () => {
    const rawPatch = [
      "diff --git a/file.txt b/file.txt",
      "index 1111111..2222222 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const ops = createOps({
      cliResult: { stdout: rawPatch },
      native: {
        diff: async () => {
          throw new Error("native diff must not run for this static route");
        },
      },
    });

    const structured = await ops.diff(
      {
        descriptor,
        request: {
          from: { type: "index" },
          to: { type: "worktree" },
          format: "structured",
        },
      },
      {},
    );
    const patch = await ops.diff(
      {
        descriptor,
        request: {
          from: { type: "commit", revision: "HEAD" },
          to: { type: "worktree" },
          format: "patch",
        },
      },
      {},
    );
    const both = await ops.diff(
      {
        descriptor,
        request: {
          from: { type: "index" },
          to: { type: "worktree" },
          format: "both",
        },
      },
      {},
    );

    expect(structured.files.length).toBe(1);
    expect(structured.rawPatch).toBeUndefined();
    expect(patch.files).toEqual([]);
    expect(patch.rawPatch).toBe(rawPatch);
    expect(both.files.length).toBe(1);
    expect(both.rawPatch).toBe(rawPatch);
    expect(cliCalls.length).toBe(3);
    expect(cliCalls.every((call) => call.args.includes("diff"))).toBe(true);
  });

  it("never broadens the CLI worktree route after a native diff failure", async () => {
    const nativeError = new Error("native commit diff failed");
    nativeError.code = "ERR_GIT_NATIVE_DIFF";
    const ops = createOps({
      native: { diff: async () => Promise.reject(nativeError) },
    });

    let error;
    try {
      await ops.diff(
        {
          descriptor,
          request: {
            from: { type: "commit", revision: "HEAD~1" },
            to: { type: "commit", revision: "HEAD" },
            format: "structured",
          },
        },
        {},
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(nativeError);
    expect(cliCalls).toEqual([]);
  });

  it("keeps statically CLI-routed operations independent from native initialization", async () => {
    const oid = "a".repeat(40);
    const execute = jasmine.createSpy("execute").and.callFake((args) =>
      Promise.resolve({
        exitCode: 0,
        stdout: args.includes("status")
          ? `# branch.oid ${oid}\0# branch.head main\0? untracked.txt\0`
          : "CLI",
        stderr: "",
      }),
    );
    const nativeError = Object.assign(new Error("native unavailable"), {
      code: "ERR_GIT_NATIVE_INIT",
      retriable: false,
    });
    const getNativeBackend = jasmine.createSpy("get native backend").and.callFake(() => {
      throw nativeError;
    });
    const ops = createGitHostOps(new GitRunner({ execute }), { getNativeBackend });

    expect(
      await ops.exec({ workingDirectory: "/repo", args: ["version"], options: {} }, {}),
    ).toEqual({ exitCode: 0, stdout: "CLI", stderr: "" });
    const snapshot = await ops.snapshot(
      {
        descriptor,
        request: { status: true, refs: false, generations: { status: 1 } },
      },
      {},
    );
    expect(snapshot.status.value.files[0].path).toBe("untracked.txt");
    expect(getNativeBackend).not.toHaveBeenCalled();

    let historyError;
    try {
      await ops.history({ descriptor, request: { revision: "HEAD" } }, {});
    } catch (error) {
      historyError = error;
    }
    expect(historyError).toBe(nativeError);
    expect(getNativeBackend.calls.count()).toBe(1);
  });

  it("never falls back to Git when a native operation fails", async () => {
    const nativeError = new Error("native failed");
    nativeError.code = "ERR_GIT_NATIVE_SNAPSHOT";
    const ops = createOps({ native: { snapshot: async () => Promise.reject(nativeError) } });

    let error;
    try {
      await ops.snapshot({ descriptor, request: { status: false, refs: true } }, {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(nativeError);
    expect(cliCalls).toEqual([]);
  });

  it("does not fall back across native read, diff, config, or blame categories", async () => {
    const categories = [
      {
        nativeName: "diff",
        op: "diff",
        run: (ops) => ops.diff({ descriptor, request: { format: "structured" } }, {}),
      },
      {
        nativeName: "history",
        op: "history",
        run: (ops) => ops.history({ descriptor, request: { revision: "HEAD" } }, {}),
      },
      {
        nativeName: "readConfig",
        op: "readConfig",
        run: (ops) => ops.readConfig({ descriptor, keys: ["user.name"] }, {}),
      },
      {
        nativeName: "readObjects",
        op: "readObjects",
        run: (ops) => ops.readObjects({ descriptor, requests: [{ oid: "a".repeat(40) }] }, {}),
      },
      {
        nativeName: "blame",
        op: "blame",
        run: (ops) => ops.blame({ descriptor, request: { path: "a.txt" } }, {}),
      },
    ];

    for (const category of categories) {
      const nativeError = new Error(`${category.op} failed`);
      nativeError.code = `ERR_GIT_NATIVE_${category.op.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
      const ops = createOps({
        native: { [category.nativeName]: async () => Promise.reject(nativeError) },
      });
      let error;
      try {
        await category.run(ops);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBe(nativeError);
      expect(cliCalls).toEqual([]);
    }
  });

  it("normalizes native and CLI failures to the same operation code", async () => {
    const nativeFailure = Object.assign(new Error("native history failed"), {
      code: "ERR_GIT_NATIVE_HISTORY",
    });
    const nativeOps = createOps({
      native: { history: async () => Promise.reject(nativeFailure) },
    });
    let nativeResult;
    try {
      await nativeOps.history({ descriptor, request: { revision: "HEAD" } }, {});
    } catch (error) {
      nativeResult = error;
    }

    const cliOps = createGitHostOps(
      new GitRunner({
        execute: async () => ({
          exitCode: 128,
          stdout: "",
          stderr: "fatal: bad object HEAD",
        }),
      }),
      { backendOverrides: { history: "cli" } },
    );
    let cliResult;
    try {
      await cliOps.history({ descriptor, request: { revision: "HEAD" } }, {});
    } catch (error) {
      cliResult = error;
    }

    expect(nativeResult.code).toBe("ERR_GIT_HISTORY");
    expect(nativeResult.backend).toBe("git-utils");
    expect(nativeResult.backendCode).toBe("ERR_GIT_NATIVE_HISTORY");
    expect(cliResult.code).toBe("ERR_GIT_HISTORY");
    expect(cliResult.backend).toBe("cli");
    expect(cliResult.backendCode).toBe("ERR_GIT_COMMAND_FAILED");
  });

  it("passes readObjects cancellation as the third options argument", async () => {
    let received;
    const ops = createOps({
      native: {
        readObjects: async (...args) => {
          received = args;
          return [];
        },
      },
    });
    const controller = new AbortController();
    const requests = [{ source: "index", path: "staged.txt" }];
    await ops.readObjects({ descriptor, requests }, { signal: controller.signal });

    expect(received[0]).toEqual(descriptor);
    expect(received[1]).toEqual(requests);
    expect(received[1][0].signal).toBeUndefined();
    expect(received[2].signal).toBe(controller.signal);
    expect(cliCalls).toEqual([]);
  });

  it("batches native config reads", async () => {
    const config = { "remote.origin.url": "https://example.invalid/repo.git" };
    const ops = createOps({
      native: {
        readConfig: async () => config,
      },
    });

    expect(await ops.readConfig({ descriptor, keys: ["remote.origin.url"] }, {})).toEqual(config);
    expect(cliCalls).toEqual([]);
  });

  it("caches a native HEAD blob and line-diffs subsequent buffer text in JS", async () => {
    let objectReads = 0;
    const ops = createOps({
      native: {
        readObjects: async () => {
          objectReads++;
          return [{ oid: "blob", type: "blob", size: 4, content: Buffer.from("a\nb\n") }];
        },
      },
    });
    const payload = {
      descriptor,
      relativePosixPath: "f.txt",
      headOid: "abc",
      text: "a\nB\n",
    };

    expect(await ops.lineDiff(payload, {})).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    await ops.lineDiff({ ...payload, text: "a\nC\n" }, {});
    expect(objectReads).toBe(1);
    expect(cliCalls).toEqual([]);
  });

  it("uses system Git only for path-follow history", async () => {
    const ops = createOps({ cliResult: { stdout: "LOG" } });
    const output = await ops.logFollow(
      {
        descriptor,
        request: { revision: "HEAD", path: "renamed.txt", limit: 10, skip: 0 },
        options: {},
      },
      {},
    );
    expect(output).toBe("LOG");
    expect(cliCalls.length).toBe(1);
    expect(cliCalls[0].args).toContain("--follow");
    expect(cliCalls[0].args).toContain("renamed.txt");
  });

  it("keeps CLI-designated writes on exec", async () => {
    const ops = createOps({ cliResult: { stdout: "done\n" } });
    const result = await ops.exec(
      { workingDirectory: "/repo", args: ["commit", "--file=-"], options: { stdin: "msg" } },
      {},
    );
    expect(result.stdout).toBe("done\n");
    expect(cliCalls[0].args.slice(-2)).toEqual(["commit", "--file=-"]);
    expect(cliCalls[0].options.stdin).toBe("msg");
  });
});
