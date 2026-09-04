const createGitHostOps = require("../src/git-host-ops");
const { GitHostOperations } = require("../src/git-host-protocol");

describe("git-host ops", () => {
  const descriptor = { gitDirectory: "/repo/.git", workingDirectory: "/repo" };
  let backend;
  let ops;

  function method(name, result) {
    return jasmine
      .createSpy(name)
      .and.callFake((...args) =>
        typeof result === "function" ? result(...args) : Promise.resolve(result),
      );
  }

  beforeEach(() => {
    backend = {
      snapshot: method("snapshot", { status: { fingerprint: "status", unchanged: true } }),
      diff: method("diff", { schemaVersion: 1, files: [] }),
      history: method("history", []),
      commit: method("commit", null),
      logFollow: method("logFollow", "log"),
      describe: method("describe", "main"),
      branchesContaining: method("branchesContaining", []),
      fileMode: method("fileMode", "100644"),
      submodulePaths: method("submodulePaths", []),
      readObjects: method("readObjects", []),
      blame: method("blame", []),
      readConfig: method("readConfig", {}),
      lineDiff: method("lineDiff", []),
      exec: method("exec", { exitCode: 0, stdout: "", stderr: "" }),
    };
    ops = createGitHostOps(null, { cliBackend: backend });
  });

  it("implements every operation in the shared protocol registry", () => {
    expect(Object.keys(ops).sort()).toEqual(Object.keys(GitHostOperations).sort());
  });

  it("passes a combined snapshot request and execution options to system Git", async () => {
    const controller = new AbortController();
    const request = {
      status: true,
      refs: true,
      includeIgnored: true,
      knownFingerprints: {},
      generations: { status: 7, refs: 4 },
    };
    const result = await ops.snapshot(
      { descriptor, request, options: { priority: "interactive" } },
      { signal: controller.signal },
    );

    expect(result.status.unchanged).toBe(true);
    expect(backend.snapshot).toHaveBeenCalledWith(descriptor, request, {
      priority: "interactive",
      signal: controller.signal,
    });
  });

  it("passes every repository read through the CLI adapter", async () => {
    const context = { signal: new AbortController().signal };
    const request = { revision: "HEAD" };
    const calls = [
      ["history", { descriptor, request }, [descriptor, request, context]],
      ["commit", { descriptor, revision: "HEAD" }, [descriptor, { revision: "HEAD" }, context]],
      [
        "logFollow",
        { descriptor, request, options: { priority: "interactive" } },
        [descriptor, request, { priority: "interactive", signal: context.signal }],
      ],
      ["describe", { descriptor }, [descriptor, context]],
      [
        "branchesContaining",
        { descriptor, request: { commit: "HEAD" } },
        [descriptor, { commit: "HEAD" }, context],
      ],
      ["fileMode", { descriptor, path: "a.txt" }, [descriptor, "a.txt", context]],
      ["submodulePaths", { descriptor }, [descriptor, context]],
      [
        "readObjects",
        { descriptor, requests: [{ revision: "HEAD", path: "a.txt" }] },
        [descriptor, [{ revision: "HEAD", path: "a.txt" }], context],
      ],
      [
        "blame",
        { descriptor, request: { path: "a.txt" } },
        [descriptor, { path: "a.txt" }, context],
      ],
      ["readConfig", { descriptor, keys: ["user.name"] }, [descriptor, ["user.name"], context]],
    ];

    for (const [operation, payload, expectedArgs] of calls) {
      await ops[operation](payload, context);
      expect(backend[operation]).toHaveBeenCalledWith(...expectedArgs);
    }
  });

  it("enforces the structured and patch size limit after a diff", async () => {
    backend.diff.and.resolveTo({
      schemaVersion: 1,
      files: [{ oldPath: "a", newPath: "a", hunks: [{ lines: [{ text: "changed" }] }] }],
    });
    const request = { format: "structured" };

    const result = await ops.diff({ descriptor, request, maxBytes: 1024 }, {});
    expect(result.files.length).toBe(1);
    expect(backend.diff).toHaveBeenCalledWith(descriptor, request, {
      maxBytes: 1024,
      signal: undefined,
    });

    await expectAsync(ops.diff({ descriptor, request, maxBytes: 4 }, {})).toBeRejectedWithError(
      /exceeded the 4 byte limit/,
    );
  });

  it("normalizes CLI read failures to stable operation codes", async () => {
    const failure = Object.assign(new Error("history failed"), {
      code: "ERR_GIT_COMMAND_FAILED",
    });
    backend.history.and.rejectWith(failure);

    let error;
    try {
      await ops.history({ descriptor, request: { revision: "HEAD" } }, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBe(failure);
    expect(error.code).toBe("ERR_GIT_HISTORY");
    expect(error.backend).toBe("cli");
    expect(error.backendCode).toBe("ERR_GIT_COMMAND_FAILED");
    expect(error.operation).toBe("history");
  });

  it("caches a HEAD blob and line-diffs subsequent buffer text", async () => {
    backend.readObjects.and.resolveTo([
      { oid: "blob", type: "blob", size: 4, content: Buffer.from("a\nb\n") },
    ]);
    backend.lineDiff.and.resolveTo([{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
    const payload = {
      descriptor,
      relativePosixPath: "f.txt",
      headOid: "abc",
      text: "a\nB\n",
      ignoreEolWhitespace: true,
    };

    expect(await ops.lineDiff(payload, {})).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    await ops.lineDiff({ ...payload, text: "a\nC\n" }, {});

    expect(backend.readObjects.calls.count()).toBe(1);
    expect(backend.lineDiff.calls.count()).toBe(2);
    expect(backend.lineDiff.calls.argsFor(1)[1]).toBe("a\nC\n");
  });

  it("keeps raw command results and errors intact", async () => {
    const payload = {
      workingDirectory: "/repo",
      args: ["commit", "--file=-"],
      options: { stdin: "message" },
    };
    expect(await ops.exec(payload, {})).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(backend.exec).toHaveBeenCalledWith(payload, {});

    const failure = Object.assign(new Error("commit failed"), {
      code: "ERR_GIT_COMMAND_FAILED",
      command: "commit",
    });
    backend.exec.and.rejectWith(failure);
    await expectAsync(ops.exec(payload, {})).toBeRejectedWith(failure);
  });
});
