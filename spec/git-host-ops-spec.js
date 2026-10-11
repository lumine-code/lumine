const createGitHostOps = require("../src/git-host-ops");
const { GitHostOperations } = require("../src/git-host-protocol");
const { DEFER_REPOSITORY_READ_POSTFLIGHT } = require("../src/system-git-service");

describe("git-host ops", () => {
  const descriptor = { gitDirectory: "/repo/.git", workingDirectory: "/repo" };
  let service;
  let ops;

  function method(name, result) {
    return jasmine
      .createSpy(name)
      .and.callFake((...args) =>
        typeof result === "function" ? result(...args) : Promise.resolve(result),
      );
  }

  beforeEach(() => {
    service = {
      snapshot: method("snapshot", { status: { fingerprint: "status", unchanged: true } }),
      diff: method("diff", { schemaVersion: 1, files: [] }),
      history: method("history", []),
      commit: method("commit", null),
      describe: method("describe", "main"),
      branchesContaining: method("branchesContaining", []),
      fileMode: method("fileMode", "100644"),
      submodulePaths: method("submodulePaths", []),
      readObjects: method("readObjects", []),
      blame: method("blame", []),
      readConfig: method("readConfig", {}),
      lineDiff: method("lineDiff", []),
      exec: method("exec", { exitCode: 0, stdout: "", stderr: "" }),
      execRepository: method("execRepository", { exitCode: 0, stdout: "", stderr: "" }),
      writeRepositoryCommandOutput: method("writeRepositoryCommandOutput", {
        exitCode: 0,
        stderr: "",
      }),
    };
    ops = createGitHostOps(null, { systemGitService: service });
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
    expect(service.snapshot).toHaveBeenCalledWith(descriptor, request, {
      priority: "interactive",
      signal: controller.signal,
      [DEFER_REPOSITORY_READ_POSTFLIGHT]: false,
    });
  });

  it("passes every repository read through the system Git service", async () => {
    const context = { signal: new AbortController().signal };
    const request = { revision: "HEAD" };
    const calls = [
      ["history", { descriptor, request }, [descriptor, request, context]],
      ["commit", { descriptor, revision: "HEAD" }, [descriptor, { revision: "HEAD" }, context]],
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
      expect(service[operation]).toHaveBeenCalledWith(...expectedArgs);
    }
  });

  it("passes the diff size limit to the system Git service", async () => {
    service.diff.and.resolveTo({
      schemaVersion: 1,
      files: [{ oldPath: "a", newPath: "a", hunks: [{ lines: [{ text: "changed" }] }] }],
    });
    const request = { format: "structured" };

    const result = await ops.diff({ descriptor, request, maxBytes: 1024 }, {});
    expect(result.files.length).toBe(1);
    expect(service.diff).toHaveBeenCalledWith(descriptor, request, {
      maxBytes: 1024,
      signal: undefined,
      [DEFER_REPOSITORY_READ_POSTFLIGHT]: false,
    });
  });

  it("normalizes CLI read failures to stable operation codes", async () => {
    const failure = Object.assign(new Error("history failed"), {
      code: "ERR_GIT_COMMAND_FAILED",
    });
    service.history.and.rejectWith(failure);

    let error;
    try {
      await ops.history({ descriptor, request: { revision: "HEAD" } }, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBe(failure);
    expect(error.code).toBe("ERR_GIT_HISTORY");
    expect(error.gitCode).toBe("ERR_GIT_COMMAND_FAILED");
    expect(error.operation).toBe("history");
  });

  it("caches a HEAD blob and line-diffs subsequent buffer text", async () => {
    service.readObjects.and.resolveTo([
      { oid: "blob", type: "blob", size: 4, content: Buffer.from("a\nb\n") },
    ]);
    service.lineDiff.and.resolveTo([{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
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

    expect(service.readObjects.calls.count()).toBe(1);
    expect(service.lineDiff.calls.count()).toBe(2);
    expect(service.lineDiff.calls.argsFor(1)[1]).toBe("a\nC\n");
  });

  it("caches index blobs by identity and reloads a changed staged version", async () => {
    service.readObjects.and.callFake(async (_descriptor, [{ oid }]) => [
      { oid, type: "blob", content: Buffer.from(`${oid}\n`) },
    ]);
    const payload = {
      descriptor,
      relativePosixPath: "f.txt",
      base: "index",
      baselineOid: "first-index",
      text: "buffer\n",
    };

    await ops.lineDiff(payload, {});
    await ops.lineDiff({ ...payload, text: "edited\n" }, {});
    await ops.lineDiff({ ...payload, baselineOid: "second-index" }, {});

    expect(service.readObjects.calls.count()).toBe(2);
    expect(service.readObjects.calls.argsFor(0)[1]).toEqual([{ oid: "first-index" }]);
    expect(service.readObjects.calls.argsFor(1)[1]).toEqual([{ oid: "second-index" }]);
    expect(service.lineDiff.calls.argsFor(1).slice(0, 2)).toEqual([
      Buffer.from("first-index\n"),
      "edited\n",
    ]);
  });

  it("shares one immutable blob between HEAD and index comparisons", async () => {
    service.readObjects.and.resolveTo([{ oid: "same", content: Buffer.from("baseline\n") }]);
    const payload = { descriptor, baselineOid: "same", text: "buffer\n" };

    await ops.lineDiff({ ...payload, base: "head" }, {});
    await ops.lineDiff({ ...payload, base: "index" }, {});

    expect(service.readObjects.calls.count()).toBe(1);
    expect(service.lineDiff.calls.count()).toBe(2);
  });

  it("uses the original HEAD path for a renamed file", async () => {
    await ops.lineDiff(
      {
        descriptor,
        relativePosixPath: "new.txt",
        baselinePath: "old.txt",
        headOid: "commit",
        text: "buffer\n",
      },
      {},
    );

    expect(service.readObjects.calls.argsFor(0)[1]).toEqual([
      { revision: "commit", path: "old.txt" },
    ]);
  });

  it("does not cache the mutable index fallback before a snapshot is available", async () => {
    const payload = { descriptor, relativePosixPath: "f.txt", base: "index", text: "buffer\n" };
    await ops.lineDiff(payload, {});
    await ops.lineDiff(payload, {});

    expect(service.readObjects.calls.count()).toBe(2);
    expect(service.readObjects.calls.argsFor(0)[1]).toEqual([{ source: "index", path: "f.txt" }]);
  });

  it("compares a known missing baseline as empty text without reading Git", async () => {
    await ops.lineDiff({ descriptor, base: "head", baselineKnownMissing: true, text: "new\n" }, {});

    expect(service.readObjects).not.toHaveBeenCalled();
    expect(service.lineDiff.calls.argsFor(0).slice(0, 2)).toEqual(["", "new\n"]);
  });

  it("checks cancellation even for a known missing baseline", async () => {
    const controller = new AbortController();
    controller.abort();

    await expectAsync(
      ops.lineDiff(
        { descriptor, baselineKnownMissing: true, text: "new\n" },
        { signal: controller.signal },
      ),
    ).toBeRejected();
    expect(service.lineDiff).not.toHaveBeenCalled();
  });

  it("decodes requested object contents before crossing IPC", async () => {
    service.readObjects.and.resolveTo([
      { oid: "blob", type: "blob", size: 5, content: Buffer.from("tekst") },
    ]);

    const [object] = await ops.readObjects(
      { descriptor, requests: [{ oid: "blob" }], encoding: "utf8" },
      {},
    );

    expect(object.content).toBe("tekst");
  });

  it("keeps raw command results and errors intact", async () => {
    const payload = {
      workingDirectory: "/repo",
      args: ["commit", "--file=-"],
      options: { stdin: "message" },
    };
    expect(await ops.exec(payload, {})).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(service.exec).toHaveBeenCalledWith(payload, {});

    const failure = Object.assign(new Error("commit failed"), {
      code: "ERR_GIT_COMMAND_FAILED",
      command: "commit",
    });
    service.exec.and.rejectWith(failure);
    await expectAsync(ops.exec(payload, {})).toBeRejectedWith(failure);
  });

  it("passes descriptor-bound command results and errors through intact", async () => {
    const context = { signal: new AbortController().signal };
    const payload = {
      descriptor,
      args: ["commit", "--file=-"],
      options: { stdin: "message" },
    };

    expect(await ops.execRepository(payload, context)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(service.execRepository).toHaveBeenCalledWith(payload, context);

    const failure = Object.assign(new Error("commit failed"), {
      code: "ERR_GIT_COMMAND_FAILED",
      command: "commit",
    });
    service.execRepository.and.rejectWith(failure);
    await expectAsync(ops.execRepository(payload, context)).toBeRejectedWith(failure);
  });

  it("writes command output inside the worker", async () => {
    const payload = {
      descriptor,
      args: ["cat-file", "blob", "abc"],
      destinationPath: "/repo/file.txt",
      options: {},
    };

    expect(await ops.writeRepositoryCommandOutput(payload, {})).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(service.writeRepositoryCommandOutput).toHaveBeenCalledWith(payload, {});
  });
});
