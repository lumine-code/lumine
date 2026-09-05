const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const SystemGitService = require("../src/system-git-service");
const { canonicalConfigKey, parseBatchObjects } = SystemGitService;

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
    expect(
      await service.readConfig({ gitDirectory: "/repo/.git", workingDirectory: "/repo" }, [
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

    await service.commit(
      { gitDirectory: "/repo/.git", workingDirectory: "/repo" },
      { revision: "HEAD" },
      {},
    );

    const [workingDirectory, revision, options] =
      service.historyProvider.getNameStatus.calls.mostRecent().args;
    expect(workingDirectory).toBe("/repo");
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

    const [object] = await service.readObjects(
      { gitDirectory: "/repo.git", workingDirectory: null },
      [{ oid: "abc" }],
      {},
    );

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
      { gitDirectory: "/repo.git", workingDirectory: "/repo" },
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
    const descriptor = {
      gitDirectory: path.join(workingDirectory, ".git"),
      workingDirectory,
    };

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

  it("writes command output before returning across IPC", async () => {
    const runner = {
      runResult: jasmine.createSpy("runResult").and.resolveTo({
        exitCode: 0,
        stdout: Buffer.from("contents"),
        stderr: "",
      }),
    };
    const service = new SystemGitService({ runner });
    const destinationPath = path.join(temp.mkdirSync("git-output-"), "file.txt");

    const result = await service.writeCommandOutput(
      {
        workingDirectory: "/repo",
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
      service.writeCommandOutput(
        {
          workingDirectory: "/repo",
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
    const directoryPath = temp.mkdirSync("git-long-output-name-");
    const destinationPath = path.join(directoryPath, `${"x".repeat(220)}.txt`);

    await service.writeCommandOutput(
      {
        workingDirectory: "/repo",
        args: ["cat-file", "blob", "abc"],
        destinationPath,
      },
      {},
    );

    expect(fs.readFileSync(destinationPath, "utf8")).toBe("contents");
    expect(fs.readdirSync(directoryPath)).toEqual([path.basename(destinationPath)]);
  });
});
