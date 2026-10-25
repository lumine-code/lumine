const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();

const GitRunner = require("../src/git-runner");
const GitRepositoryStatusProvider = require("../src/git-repository-status-provider");
const { parseStatusSnapshot } = require("../src/repository-status-snapshot");

describe("Git status content verification", () => {
  async function fixture(names = ["LICENSE"], { attributes, autocrlf = "true" } = {}) {
    const workingDirectory = temp.mkdirSync("git-status-content-");
    const gitDirectory = path.join(workingDirectory, ".git");
    const runner = new GitRunner();
    const options = { repositoryDescriptor: { workingDirectory, gitDirectory } };
    const git = (args, extra = {}) => runner.run(args, workingDirectory, { ...options, ...extra });

    await runner.run(["init", "--quiet", workingDirectory], workingDirectory);
    await git(["config", "core.autocrlf", autocrlf]);
    await git(["config", "core.safecrlf", "false"]);
    if (attributes) fs.writeFileSync(path.join(workingDirectory, ".gitattributes"), attributes);
    for (const name of names)
      fs.writeFileSync(path.join(workingDirectory, name), "first\r\nsecond\r\n");
    await git(["add", "--all"]);
    await git([
      "-c",
      "user.name=Git Status Specs",
      "-c",
      "user.email=git-status@lumine.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${path.join(workingDirectory, "no-hooks")}`,
      "commit",
      "--quiet",
      "-m",
      "Baseline",
    ]);
    for (const name of names)
      fs.writeFileSync(path.join(workingDirectory, name), "first\nsecond\n");

    return {
      workingDirectory,
      gitDirectory,
      runner,
      options,
      git,
      rawStatus: () => git(["status", "--porcelain=v2", "-z"]),
      provider: (run = runner.run.bind(runner)) =>
        new GitRepositoryStatusProvider({ runner: { run } }),
    };
  }

  it("removes normalized-only changes repeatedly without writing the index or taking its lock", async () => {
    const context = await fixture();
    expect(await context.rawStatus()).toContain("1 .M ");
    const indexPath = path.join(context.gitDirectory, "index");
    const before = fs.readFileSync(indexPath);
    const lockPath = `${indexPath}.lock`;
    const lock = "another Git operation owns this lock\n";
    fs.writeFileSync(lockPath, lock);

    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await context.provider().getStatus(context.workingDirectory, context.options);
      expect(parseStatusSnapshot(output).files).toEqual([]);
      expect(parseStatusSnapshot(output).counts.unstaged).toBe(0);
      expect(fs.readFileSync(indexPath).equals(before)).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(lock);
    }
    expect(await context.rawStatus()).toContain("1 .M ");
  });

  it("uses attributes when line endings are normalized without core.autocrlf", async () => {
    const context = await fixture(["example.txt"], {
      autocrlf: "false",
      attributes: "*.txt text eol=crlf\n",
    });
    expect(await context.rawStatus()).toContain("1 .M ");
    const output = await context.provider().getStatus(context.workingDirectory, context.options);
    expect(parseStatusSnapshot(output).files).toEqual([]);
  });

  it("retains real content changes alongside normalized-only changes", async () => {
    const context = await fixture(["LICENSE", "changed.txt"]);
    fs.writeFileSync(path.join(context.workingDirectory, "changed.txt"), "different\nsecond\n");
    const output = await context.provider().getStatus(context.workingDirectory, context.options);
    expect(
      parseStatusSnapshot(output).files.map(({ path: name, worktreeStatus, unstaged }) => [
        name,
        worktreeStatus,
        unstaged,
      ]),
    ).toEqual([["changed.txt", "M", true]]);
  });

  it("hashes literal filenames containing spaces, Unicode, leading dashes, and supported controls", async () => {
    const names = ["space in name.txt", "zażółć.txt", "-leading.txt"];
    if (process.platform !== "win32")
      names.push('quote"name.txt', "line\nbreak.txt", "tab\tname.txt", "back\\slash.txt");
    const context = await fixture(names);
    expect(parseStatusSnapshot(await context.rawStatus()).files.length).toBe(names.length);
    const output = await context.provider().getStatus(context.workingDirectory, context.options);
    expect(parseStatusSnapshot(output).files).toEqual([]);
  });

  it("clears only verified worktree content while retaining staging, renames, modes, and conflicts", async () => {
    const names = ["ordinary.txt", "staged.txt", "added.txt", "renamed.txt", "copied.txt"];
    const context = await fixture(names);
    const oid = (await context.git(["rev-parse", "HEAD:ordinary.txt"])).trim();
    const ordinary = (
      xy,
      name,
      indexMode = "100644",
      worktreeMode = "100644",
      submodule = "N...",
    ) => `1 ${xy} ${submodule} 100644 ${indexMode} ${worktreeMode} ${oid} ${oid} ${name}`;
    const fakeOriginal = ordinary(".M", "ordinary.txt");
    const records = [
      ordinary(".M", "ordinary.txt"),
      ordinary("MM", "staged.txt"),
      ordinary("AM", "added.txt"),
      `2 RM N... 100644 100644 100644 ${oid} ${oid} R100 renamed.txt`,
      fakeOriginal,
      `2 CM N... 100644 100644 100644 ${oid} ${oid} C100 copied.txt`,
      "original copy.txt",
      ordinary(".M", "mode.txt", "100644", "100755"),
      ordinary(".M", "link.txt", "120000", "120000"),
      ordinary(".M", "module", "160000", "160000", "SCMU"),
      `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt`,
      ordinary(".D", "deleted.txt", "100644", "000000"),
      "? untracked.txt",
      "! ignored.txt",
      "",
    ];
    const raw = records.join("\0");
    const provider = context.provider((args, cwd, options) =>
      args.includes("status") ? Promise.resolve(raw) : context.runner.run(args, cwd, options),
    );
    const output = await provider.getStatus(context.workingDirectory, context.options);
    const snapshot = parseStatusSnapshot(output);
    expect(output).toContain(`\0${fakeOriginal}\0`);
    expect(
      snapshot.files.map(({ path: name, indexStatus, worktreeStatus }) => [
        name,
        indexStatus,
        worktreeStatus,
      ]),
    ).toEqual([
      ["staged.txt", "M", null],
      ["added.txt", "A", null],
      ["renamed.txt", "R", null],
      ["copied.txt", "C", null],
      ["mode.txt", null, "M"],
      ["link.txt", null, "M"],
      ["module", null, "M"],
      ["conflict.txt", "U", "U"],
      ["deleted.txt", null, "D"],
      ["untracked.txt", null, null],
      ["ignored.txt", null, null],
    ]);
  });

  it("preserves byte-significant EOL differences and binary edits", async () => {
    const context = await fixture(["LICENSE", "raw.txt", "data.bin"], {
      attributes: "*.txt -text\n*.bin binary\n",
    });
    fs.writeFileSync(path.join(context.workingDirectory, "data.bin"), Buffer.from([0, 1, 2, 3]));
    const output = await context.provider().getStatus(context.workingDirectory, context.options);
    expect(
      parseStatusSnapshot(output).files.map((file) => [file.path, file.worktreeStatus]),
    ).toEqual([
      ["data.bin", "M"],
      ["raw.txt", "M"],
    ]);
  });

  it("retains a candidate whose content changes after hashing", async () => {
    const context = await fixture();
    const provider = context.provider(async (args, cwd, options) => {
      const output = await context.runner.run(args, cwd, options);
      if (args.includes("hash-object"))
        fs.writeFileSync(path.join(cwd, "LICENSE"), "new content after verification\n");
      return output;
    });
    const output = await provider.getStatus(context.workingDirectory, context.options);
    expect(
      parseStatusSnapshot(output).files.map(({ path: name, worktreeStatus }) => [
        name,
        worktreeStatus,
      ]),
    ).toEqual([["LICENSE", "M"]]);
  });

  it("retains candidates if the index changes during content verification", async () => {
    const context = await fixture();
    const provider = context.provider(async (args, cwd, options) => {
      const output = await context.runner.run(args, cwd, options);
      if (args.includes("hash-object"))
        fs.utimesSync(path.join(context.gitDirectory, "index"), new Date(1000), new Date(1000));
      return output;
    });
    const output = await provider.getStatus(context.workingDirectory, context.options);
    expect(
      parseStatusSnapshot(output).files.map(({ path: name, worktreeStatus }) => [
        name,
        worktreeStatus,
      ]),
    ).toEqual([["LICENSE", "M"]]);
  });

  it("preserves the original status when content verification fails or returns invalid hashes", async () => {
    const context = await fixture();
    const raw = await context.rawStatus();
    for (const result of [new Error("clean filter failed"), "", "invalid hash\n", "a\nb\n"]) {
      const provider = context.provider((args, cwd, options) => {
        if (args.includes("status")) return Promise.resolve(raw);
        if (args.includes("hash-object"))
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        return context.runner.run(args, cwd, options);
      });
      expect(await provider.getStatus(context.workingDirectory, context.options)).toBe(raw);
    }
  });

  it("propagates cancellation during content verification", async () => {
    const context = await fixture();
    const controller = new AbortController();
    const provider = context.provider((args, cwd, options) => {
      if (args.includes("hash-object")) controller.abort();
      return context.runner.run(args, cwd, options);
    });
    await expectAsync(
      provider.getStatus(context.workingDirectory, {
        ...context.options,
        signal: controller.signal,
      }),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
  });
});
