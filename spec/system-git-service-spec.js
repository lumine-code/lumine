const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const SystemGitService = require("../src/system-git-service");
const {
  assertRepositoryDescriptorAvailableAsync,
  ERR_GIT_REPOSITORY_UNAVAILABLE,
} = require("../src/git-repository-descriptor");
const { canonicalConfigKey, parseBatchObjects } = SystemGitService;

function createDirectoryMarkerDescriptor(workingDirectory = temp.mkdirSync("git-service-repo-")) {
  const gitDirectory = path.join(workingDirectory, ".git");
  fs.mkdirSync(gitDirectory, { recursive: true });
  return {
    gitDirectory,
    workingDirectory,
    worktreeGitMarker: { path: gitDirectory, kind: "directory" },
  };
}

function createGitfileDescriptor() {
  const rootDirectory = temp.mkdirSync("git-service-gitfile-");
  const workingDirectory = path.join(rootDirectory, "worktree");
  const gitDirectory = path.join(rootDirectory, "repository.git");
  const markerPath = path.join(workingDirectory, ".git");
  fs.mkdirSync(workingDirectory);
  fs.mkdirSync(gitDirectory);
  fs.writeFileSync(markerPath, `gitdir: ${path.relative(workingDirectory, gitDirectory)}\n`);
  return {
    descriptor: {
      gitDirectory,
      workingDirectory,
      worktreeGitMarker: { path: markerPath, kind: "gitfile" },
    },
    markerPath,
    rootDirectory,
  };
}

function createBareDescriptor() {
  return {
    gitDirectory: temp.mkdirSync("git-service-bare-"),
    workingDirectory: null,
    worktreeGitMarker: null,
  };
}

describe("SystemGitService", () => {
  it("parses binary cat-file batches and missing objects", () => {
    const content = Buffer.from([0, 10, 255]);
    const output = Buffer.concat([
      Buffer.from("abc blob 3\n"),
      content,
      Buffer.from("\nmissing missing\n"),
    ]);

    const objects = parseBatchObjects(output, 2);
    expect(objects[0].oid).toBe("abc");
    expect(objects[0].type).toBe("blob");
    expect(Buffer.compare(objects[0].content, content)).toBe(0);
    expect(objects[1]).toBeNull();
  });

  it("normalizes section and variable case without folding subsection names", async () => {
    expect(canonicalConfigKey("Remote.Origin.URL")).toBe("remote.Origin.url");
    expect(canonicalConfigKey("remote.origin.url")).toBe("remote.origin.url");

    const service = new SystemGitService({
      runner: {
        run: async () => "remote.Origin.url\nupper\0remote.origin.url\nlower\0",
      },
    });
    const descriptor = createDirectoryMarkerDescriptor();
    expect(
      await service.readConfig(descriptor, [
        "REMOTE.Origin.URL",
        "remote.origin.url",
        "missing.value",
      ]),
    ).toEqual({
      "REMOTE.Origin.URL": "upper",
      "remote.origin.url": "lower",
      "missing.value": null,
    });
  });

  it("uses the resolved commit id when reading changed files", async () => {
    const resolved = "a".repeat(40);
    const parent = "b".repeat(40);
    const service = new SystemGitService({ runner: {} });
    service.historyProvider = {
      getLog: jasmine
        .createSpy("getLog")
        .and.resolveTo(
          [
            resolved,
            parent,
            "Author",
            "author@example.com",
            "2026-09-04T10:00:00Z",
            "Committer",
            "committer@example.com",
            "2026-09-04T10:00:00Z",
            "subject",
            "",
            "",
          ].join("\0"),
        ),
      getNameStatus: jasmine.createSpy("getNameStatus").and.resolveTo(""),
    };
    const descriptor = createDirectoryMarkerDescriptor();

    await service.commit(descriptor, { revision: "HEAD" }, {});

    const [workingDirectory, revision, options] =
      service.historyProvider.getNameStatus.calls.mostRecent().args;
    expect(workingDirectory).toBe(descriptor.workingDirectory);
    expect(revision).toBe(resolved);
    expect(options.parent).toBe(parent);
  });

  it("uses the portable line-delimited batch protocol", async () => {
    const runner = {
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 0,
        stdout: Buffer.from("abc blob 3\nraw\n"),
      }),
    };
    const service = new SystemGitService({ runner });

    const [object] = await service.readObjects(createBareDescriptor(), [{ oid: "abc" }], {});

    expect(object.content.toString()).toBe("raw");
    expect(runner.runResult.calls.mostRecent().args[0]).toEqual(["cat-file", "--batch"]);
    expect(runner.runResult.calls.mostRecent().args[2].stdin).toBe("abc\n");
  });

  it("spells stage zero explicitly for index paths", async () => {
    const runner = {
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 0,
        stdout: Buffer.from("abc blob 3\nraw\n"),
      }),
    };
    const service = new SystemGitService({ runner });

    await service.readObjects(
      createDirectoryMarkerDescriptor(),
      [{ source: "index", path: "1:file.txt" }],
      {},
    );

    expect(runner.runResult.calls.mostRecent().args[2].stdin).toBe(":0:1:file.txt\n");
  });

  it("adds cached submodule paths to status snapshots in the worker", async () => {
    const workingDirectory = temp.mkdirSync("git-status-submodules-");
    fs.writeFileSync(
      path.join(workingDirectory, ".gitmodules"),
      '[submodule "module"]\n\tpath = vendor/module\n\turl = ../module.git\n',
    );
    const runner = {
      run: jasmine.createSpy("run").and.resolveTo("# branch.oid abc\0# branch.head main\0"),
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 0,
        stdout: "submodule.module.path\nvendor/module\0",
      }),
    };
    const service = new SystemGitService({ runner });
    const descriptor = createDirectoryMarkerDescriptor(workingDirectory);

    const first = await service.snapshot(descriptor, {
      status: true,
      refs: false,
      generations: { status: 1 },
    });
    const second = await service.snapshot(descriptor, {
      status: true,
      refs: false,
      generations: { status: 2 },
    });

    expect(first.status.value.submodulePaths).toEqual(["vendor/module"]);
    expect(second.status.value.submodulePaths).toEqual(["vendor/module"]);
    expect(runner.runResult.calls.count()).toBe(1);
  });

  it("passes one exact validated descriptor to every command in a logical snapshot", async () => {
    const descriptor = createDirectoryMarkerDescriptor();
    fs.writeFileSync(
      path.join(descriptor.workingDirectory, ".gitmodules"),
      '[submodule "module"]\n\tpath = vendor/module\n',
    );
    const validatedDescriptor = Object.freeze({
      ...descriptor,
      worktreeGitMarker: Object.freeze({ ...descriptor.worktreeGitMarker }),
    });
    const assertRepositoryDescriptorAvailable = jasmine
      .createSpy("assertRepositoryDescriptorAvailable")
      .and.resolveTo(validatedDescriptor);
    const runner = {
      run: jasmine.createSpy("run").and.callFake(async (args) => {
        if (args[0] === "status") {
          return "# branch.oid (initial)\0# branch.head main\0";
        }
        if (args[0] === "symbolic-ref") return "refs/heads/main\n";
        return "";
      }),
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 1,
        stdout: "",
      }),
    };
    const service = new SystemGitService({
      runner,
      assertRepositoryDescriptorAvailable,
    });

    await service.snapshot(descriptor, {
      status: true,
      refs: true,
      generations: { status: 1, refs: 1 },
    });

    expect(assertRepositoryDescriptorAvailable.calls.count()).toBe(2);
    expect(
      assertRepositoryDescriptorAvailable.calls.allArgs().map(([, options]) => options.operation),
    ).toEqual(["snapshot", "snapshot"]);
    const commandCalls = [...runner.run.calls.allArgs(), ...runner.runResult.calls.allArgs()];
    expect(commandCalls.length).toBeGreaterThan(1);
    for (const [, workingDirectory, options] of commandCalls) {
      expect(workingDirectory).toBe(descriptor.workingDirectory);
      expect(options.repositoryDescriptor).toBe(validatedDescriptor);
    }
  });

  it("rejects a read when its gitfile is retargeted before publication", async () => {
    const { descriptor, markerPath, rootDirectory } = createGitfileDescriptor();
    const otherGitDirectory = path.join(rootDirectory, "other.git");
    fs.mkdirSync(otherGitDirectory);
    const assertRepositoryDescriptorAvailable = jasmine
      .createSpy("assertRepositoryDescriptorAvailable")
      .and.callFake(assertRepositoryDescriptorAvailableAsync);
    const runner = {
      run: jasmine.createSpy("run").and.callFake(async () => {
        fs.writeFileSync(
          markerPath,
          `gitdir: ${path.relative(descriptor.workingDirectory, otherGitDirectory)}\n`,
        );
        return "core.filemode\ntrue\0";
      }),
    };
    const service = new SystemGitService({
      runner,
      assertRepositoryDescriptorAvailable,
    });

    let error;
    try {
      await service.readConfig(descriptor, ["core.filemode"]);
    } catch (caughtError) {
      error = caughtError;
    }

    expect(runner.run).toHaveBeenCalled();
    expect(assertRepositoryDescriptorAvailable.calls.count()).toBe(2);
    expect(error.code).toBe(ERR_GIT_REPOSITORY_UNAVAILABLE);
    expect(error.reason).toBe("worktree-marker-mismatch");
    expect(error.operation).toBe("readConfig");
    expect(path.normalize(error.gitDirectory)).toBe(descriptor.gitDirectory);
    expect(path.normalize(error.workingDirectory)).toBe(descriptor.workingDirectory);
  });

  it("classifies a command failure as unavailable when the repository moved", async () => {
    const { descriptor, markerPath } = createGitfileDescriptor();
    const originalError = new Error("Git command failed");
    const assertRepositoryDescriptorAvailable = jasmine
      .createSpy("assertRepositoryDescriptorAvailable")
      .and.callFake(assertRepositoryDescriptorAvailableAsync);
    const runner = {
      run: jasmine.createSpy("run").and.callFake(async () => {
        fs.unlinkSync(markerPath);
        throw originalError;
      }),
    };
    const service = new SystemGitService({
      runner,
      assertRepositoryDescriptorAvailable,
    });

    let error;
    try {
      await service.readConfig(descriptor, ["core.filemode"]);
    } catch (caughtError) {
      error = caughtError;
    }

    expect(assertRepositoryDescriptorAvailable.calls.count()).toBe(2);
    expect(error).not.toBe(originalError);
    expect(error.code).toBe(ERR_GIT_REPOSITORY_UNAVAILABLE);
    expect(error.reason).toBe("worktree-marker-missing");
    expect(error.operation).toBe("readConfig");
  });

  it("does not turn a successful repository mutation into a later move failure", async () => {
    const { descriptor, markerPath } = createGitfileDescriptor();
    const assertRepositoryDescriptorAvailable = jasmine
      .createSpy("assertRepositoryDescriptorAvailable")
      .and.callFake(assertRepositoryDescriptorAvailableAsync);
    const result = { exitCode: 0, stdout: "", stderr: "" };
    const runner = {
      runResult: jasmine.createSpy("runResult").and.callFake(async () => {
        fs.unlinkSync(markerPath);
        return result;
      }),
    };
    const service = new SystemGitService({
      runner,
      assertRepositoryDescriptorAvailable,
    });

    await expectAsync(
      service.execRepository({ descriptor, args: ["config", "core.filemode", "true"] }),
    ).toBeResolvedTo(result);

    expect(assertRepositoryDescriptorAvailable.calls.count()).toBe(1);
  });

  it("postvalidates a repository read used inside a composite mutation", async () => {
    const { descriptor, markerPath } = createGitfileDescriptor();
    const result = { exitCode: 0, stdout: "100644 abc 0\tfile.txt\n", stderr: "" };
    const runner = {
      runResult: jasmine.createSpy("runResult").and.callFake(async () => {
        fs.unlinkSync(markerPath);
        return result;
      }),
    };
    const service = new SystemGitService({ runner });

    await expectAsync(
      service.execRepository({
        descriptor,
        args: ["ls-files", "-s", "--", "file.txt"],
        options: { repositoryRead: true },
      }),
    ).toBeRejectedWith(
      jasmine.objectContaining({
        code: ERR_GIT_REPOSITORY_UNAVAILABLE,
        operation: "repository-read-command",
      }),
    );
  });

  it("reinspects a failed repository mutation and reports a concurrent move", async () => {
    const { descriptor, markerPath } = createGitfileDescriptor();
    const assertRepositoryDescriptorAvailable = jasmine
      .createSpy("assertRepositoryDescriptorAvailable")
      .and.callFake(assertRepositoryDescriptorAvailableAsync);
    const commandError = new Error("Git command failed");
    const runner = {
      runResult: jasmine.createSpy("runResult").and.callFake(async () => {
        fs.unlinkSync(markerPath);
        throw commandError;
      }),
    };
    const service = new SystemGitService({ runner, assertRepositoryDescriptorAvailable });

    await expectAsync(
      service.execRepository({ descriptor, args: ["update-index", "--refresh"] }),
    ).toBeRejectedWith(
      jasmine.objectContaining({
        code: ERR_GIT_REPOSITORY_UNAVAILABLE,
        reason: "worktree-marker-missing",
        operation: "repository-command",
      }),
    );

    expect(assertRepositoryDescriptorAvailable.calls.count()).toBe(2);
  });

  it("does not invoke a mutation command when descriptor preflight fails", async () => {
    const { descriptor, markerPath } = createGitfileDescriptor();
    fs.unlinkSync(markerPath);
    const runner = {
      runResult: jasmine.createSpy("runResult"),
    };
    const service = new SystemGitService({ runner });

    await expectAsync(
      service.execRepository({ descriptor, args: ["update-index", "--refresh"] }),
    ).toBeRejectedWith(
      jasmine.objectContaining({
        code: ERR_GIT_REPOSITORY_UNAVAILABLE,
        reason: "worktree-marker-missing",
      }),
    );

    expect(runner.runResult).not.toHaveBeenCalled();
  });

  it("binds repository commands while keeping raw execution unbound", async () => {
    const descriptor = createDirectoryMarkerDescriptor();
    const validatedDescriptor = Object.freeze({ ...descriptor });
    const runner = {
      runResult: jasmine.createSpy("runResult").and.resolveTo({ exitCode: 0 }),
      runRawResult: jasmine.createSpy("runRawResult").and.resolveTo({ exitCode: 0 }),
    };
    const service = new SystemGitService({
      runner,
      assertRepositoryDescriptorAvailable: async () => validatedDescriptor,
    });

    await service.execRepository({ descriptor, args: ["update-index", "--refresh"] });
    await service.exec({
      workingDirectory: descriptor.workingDirectory,
      args: ["status"],
      raw: true,
    });

    expect(runner.runResult.calls.mostRecent().args[2].repositoryDescriptor).toBe(
      validatedDescriptor,
    );
    expect(runner.runRawResult.calls.mostRecent().args[2].repositoryDescriptor).toBeUndefined();
  });

  it("does not replace command output when repository postflight fails", async () => {
    const { descriptor, markerPath } = createGitfileDescriptor();
    const destinationDirectory = temp.mkdirSync("git-repository-output-");
    const destinationPath = path.join(destinationDirectory, "file.txt");
    fs.writeFileSync(destinationPath, "original");
    const runner = {
      runResult: jasmine.createSpy("runResult").and.callFake(async () => {
        fs.unlinkSync(markerPath);
        return {
          exitCode: 0,
          stdout: Buffer.from("replacement"),
          stderr: "",
        };
      }),
    };
    const service = new SystemGitService({ runner });

    await expectAsync(
      service.writeRepositoryCommandOutput({
        descriptor,
        args: ["cat-file", "blob", "abc"],
        destinationPath,
      }),
    ).toBeRejectedWith(
      jasmine.objectContaining({
        code: ERR_GIT_REPOSITORY_UNAVAILABLE,
        reason: "worktree-marker-missing",
      }),
    );

    expect(fs.readFileSync(destinationPath, "utf8")).toBe("original");
    expect(fs.readdirSync(destinationDirectory)).toEqual(["file.txt"]);
  });

  it("classifies an output write failure after a worktree move as unavailable", async () => {
    const descriptor = createDirectoryMarkerDescriptor();
    const movedDirectory = `${descriptor.workingDirectory}-moved`;
    const destinationPath = path.join(descriptor.workingDirectory, "file.txt");
    const runner = {
      runResult: jasmine.createSpy("runResult").and.callFake(async () => {
        fs.renameSync(descriptor.workingDirectory, movedDirectory);
        return {
          exitCode: 0,
          stdout: Buffer.from("replacement"),
          stderr: "",
        };
      }),
    };
    const service = new SystemGitService({ runner });

    try {
      await expectAsync(
        service.writeRepositoryCommandOutput({
          descriptor,
          args: ["cat-file", "blob", "abc"],
          destinationPath,
        }),
      ).toBeRejectedWith(
        jasmine.objectContaining({
          code: ERR_GIT_REPOSITORY_UNAVAILABLE,
          reason: "working-directory-missing",
        }),
      );
    } finally {
      if (fs.existsSync(movedDirectory)) {
        fs.renameSync(movedDirectory, descriptor.workingDirectory);
      }
    }
  });

  it("writes command output before returning across IPC", async () => {
    const runner = {
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 0,
        stdout: Buffer.from("contents"),
        stderr: "",
      }),
    };
    const service = new SystemGitService({ runner });
    const descriptor = createDirectoryMarkerDescriptor();
    const destinationPath = path.join(temp.mkdirSync("git-output-"), "file.txt");

    const result = await service.writeRepositoryCommandOutput(
      {
        descriptor,
        args: ["cat-file", "blob", "abc"],
        destinationPath,
      },
      {},
    );

    expect(result).toEqual({ exitCode: 0, stderr: "" });
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("contents");
  });

  it("keeps the previous destination when an output write is cancelled", async () => {
    const runner = {
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 0,
        stdout: Buffer.from("replacement"),
        stderr: "",
      }),
    };
    const service = new SystemGitService({ runner });
    const descriptor = createDirectoryMarkerDescriptor();
    const directoryPath = temp.mkdirSync("git-cancelled-output-");
    const destinationPath = path.join(directoryPath, "file.txt");
    fs.writeFileSync(destinationPath, "original");
    const controller = new AbortController();
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    spyOn(fs.promises, "writeFile").and.callFake(async (...args) => {
      await writeFile(...args);
      controller.abort();
    });

    await expectAsync(
      service.writeRepositoryCommandOutput(
        {
          descriptor,
          args: ["cat-file", "blob", "abc"],
          destinationPath,
        },
        { signal: controller.signal },
      ),
    ).toBeRejected();

    expect(fs.readFileSync(destinationPath, "utf8")).toBe("original");
    expect(fs.readdirSync(directoryPath)).toEqual(["file.txt"]);
  });

  it("uses a bounded temporary basename for a long destination name", async () => {
    const runner = {
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 0,
        stdout: Buffer.from("contents"),
        stderr: "",
      }),
    };
    const service = new SystemGitService({ runner });
    const descriptor = createDirectoryMarkerDescriptor();
    const directoryPath = temp.mkdirSync("git-long-output-name-");
    const destinationPath = path.join(directoryPath, `${"x".repeat(220)}.txt`);

    await service.writeRepositoryCommandOutput(
      {
        descriptor,
        args: ["cat-file", "blob", "abc"],
        destinationPath,
      },
      {},
    );

    expect(fs.readFileSync(destinationPath, "utf8")).toBe("contents");
    expect(fs.readdirSync(directoryPath)).toEqual([path.basename(destinationPath)]);
  });
});
