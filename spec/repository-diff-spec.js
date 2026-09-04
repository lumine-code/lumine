const fs = require("fs");
const path = require("path");

const temp = require("@lumine-code/temp").track();

const { parseDiffPatch } = require("../src/repository-diff");
const GitRepositoryDiffProvider = require("../src/git-repository-diff-provider");
const GitRepositoryOperationProvider = require("../src/git-repository-operation-provider");
const GitRepository = require("../src/git-repository");

const COLOR_CONFIG_ARGUMENT_COUNT = 8;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

describe("repository diff", () => {
  describe("parseDiffPatch", () => {
    it("parses a modified file with hunk headings and classified lines", () => {
      const patch = [
        "diff --git a/src/app.js b/src/app.js",
        "index 1111111..2222222 100644",
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -10,7 +10,8 @@ function main() {",
        " context line",
        "-removed line",
        "+added line",
        "+another added",
        " more context",
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);

      expect(files.length).toBe(1);
      const file = files[0];
      expect(file.oldPath).toBe("src/app.js");
      expect(file.newPath).toBe("src/app.js");
      expect(file.status).toBe("modified");
      expect(file.oldMode).toBe("100644");
      expect(file.binary).toBe(false);
      expect(file.hunks.length).toBe(1);
      const hunk = file.hunks[0];
      expect(hunk.oldStart).toBe(10);
      expect(hunk.oldLines).toBe(7);
      expect(hunk.newStart).toBe(10);
      expect(hunk.newLines).toBe(8);
      expect(hunk.heading).toBe("function main() {");
      expect(hunk.lines.map((line) => line.kind)).toEqual([
        "context",
        "deleted",
        "added",
        "added",
        "context",
      ]);
      expect(hunk.lines[1].text).toBe("removed line");
      expect(Object.isFrozen(file)).toBe(true);
      expect(Object.isFrozen(hunk.lines)).toBe(true);
    });

    it("parses added and deleted files with null path sides", () => {
      const patch = [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..e69de29",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-goodbye",
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);

      expect(files[0].status).toBe("added");
      expect(files[0].oldPath).toBeNull();
      expect(files[0].newPath).toBe("new.txt");
      expect(files[0].newMode).toBe("100644");
      expect(files[1].status).toBe("deleted");
      expect(files[1].oldPath).toBe("gone.txt");
      expect(files[1].newPath).toBeNull();
    });

    it("retains diff-header paths for empty files without marker headers", () => {
      const patch = [
        "diff --git a/empty name.txt b/empty name.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);
      expect(files.length).toBe(1);
      expect(files[0].oldPath).toBe("empty name.txt");
      expect(files[0].newPath).toBeNull();
      expect(files[0].status).toBe("deleted");
      expect(files[0].oldMode).toBe("100644");
    });

    it("does not confuse delimiter-looking text inside ordinary paths", () => {
      const patch = [
        "diff --git a/x b/foo.bin b/x b/foo.bin",
        "index 1111111..2222222 100644",
        "Binary files a/x b/foo.bin and b/x b/foo.bin differ",
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);
      expect(files[0].oldPath).toBe("x b/foo.bin");
      expect(files[0].newPath).toBe("x b/foo.bin");
      expect(files[0].binary).toBe(true);
    });

    it("parses renames and copies including paths with spaces", () => {
      const patch = [
        "diff --git a/old name.txt b/new name.txt",
        "similarity index 95%",
        "rename from old name.txt",
        "rename to new name.txt",
        "index 1111111..2222222 100644",
        "--- a/old name.txt\t",
        "+++ b/new name.txt\t",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "diff --git a/base.txt b/copy.txt",
        "similarity index 100%",
        "copy from base.txt",
        "copy to copy.txt",
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);

      expect(files[0].status).toBe("renamed");
      expect(files[0].similarity).toBe(95);
      expect(files[0].oldPath).toBe("old name.txt");
      expect(files[0].newPath).toBe("new name.txt");
      expect(files[1].status).toBe("copied");
      expect(files[1].similarity).toBe(100);
      expect(files[1].hunks).toEqual([]);
    });

    it("unquotes C-quoted paths", () => {
      const patch = [
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        "similarity index 100%",
        'rename from "caf\\303\\251 \\"old\\".txt"',
        'rename to "caf\\303\\251.txt"',
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);

      expect(files[0].oldPath).toBe('café "old".txt');
      expect(files[0].newPath).toBe("café.txt");
    });

    it("flags binary files and mode-only changes", () => {
      const patch = [
        "diff --git a/img.png b/img.png",
        "index 1111111..2222222 100644",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/script.sh b/script.sh",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/link b/link",
        "old mode 100644",
        "new mode 120000",
        "index 1111111..2222222",
        "--- a/link",
        "+++ b/link",
        "@@ -1 +1 @@",
        "-content",
        "+target",
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);

      expect(files[0].binary).toBe(true);
      expect(files[0].hunks).toEqual([]);
      expect(files[1].status).toBe("modified");
      expect(files[1].oldMode).toBe("100644");
      expect(files[1].newMode).toBe("100755");
      expect(files[2].status).toBe("typechange");
    });

    it("records missing trailing newlines on both sides", () => {
      const patch = [
        "diff --git a/end.txt b/end.txt",
        "index 1111111..2222222 100644",
        "--- a/end.txt",
        "+++ b/end.txt",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
        "",
      ].join("\n");

      const { files } = parseDiffPatch(patch);

      expect(files[0].hunks[0].lines.map((line) => line.kind)).toEqual([
        "deleted",
        "nonewline",
        "added",
        "nonewline",
      ]);
    });
  });

  describe("GitRepositoryDiffProvider", () => {
    let calls, provider;

    beforeEach(() => {
      calls = [];
      provider = new GitRepositoryDiffProvider({
        execute: async (args, workingDirectory, options) => {
          calls.push({ args: args.slice(COLOR_CONFIG_ARGUMENT_COUNT), workingDirectory, options });
          return {
            exitCode: options.__exitCode ?? 0,
            stdout: args.includes("hash-object")
              ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"
              : "",
            stderr: "",
          };
        },
      });
    });

    it("maps endpoint pairs onto git diff invocations", async () => {
      await provider.getDiffPatch("/repo", { from: { type: "index" }, to: { type: "worktree" } });
      await provider.getDiffPatch("/repo", {
        from: { type: "commit", revision: "HEAD" },
        to: { type: "index" },
        context: 1,
      });
      await provider.getDiffPatch("/repo", {
        from: { type: "commit", revision: "abc" },
        to: { type: "commit", revision: "def" },
        paths: ["src"],
        ignoreWhitespace: true,
      });
      await provider.getDiffPatch("/repo", {
        from: { type: "empty" },
        to: { type: "file", path: "untracked.txt" },
      });
      await provider.getDiffPatch("/repo", {
        from: { type: "empty" },
        to: { type: "index" },
      });

      expect(calls[0].args.slice(2)).toEqual([
        "diff",
        "--patch",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--find-copies",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
      ]);
      expect(calls[1].args).toContain("--cached");
      expect(calls[1].args).toContain("HEAD");
      expect(calls[1].args).toContain("--unified=1");
      expect(calls[2].args.slice(-4)).toEqual(["abc", "def", "--", "src"]);
      expect(calls[2].args).toContain("--ignore-all-space");
      expect(calls[3].args.slice(-4)).toEqual(["--no-index", "--", NULL_DEVICE, "untracked.txt"]);
      expect(calls[4].args).toContain("rev-parse");
      expect(calls[5].args).toContain("hash-object");
      expect(calls[6].args).toContain("--cached");
      expect(calls[6].args).toContain("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      expect(calls[5].options.env.GIT_OBJECT_DIRECTORY).toBe(
        calls[6].options.env.GIT_OBJECT_DIRECTORY,
      );
      expect(fs.existsSync(calls[5].options.env.GIT_OBJECT_DIRECTORY)).toBe(false);
    });

    it("disables rename detection when detectRenames is false", async () => {
      await provider.getDiffPatch("/repo", {
        from: { type: "index" },
        to: { type: "worktree" },
        detectRenames: false,
      });
      expect(calls[0].args).toContain("--no-renames");
      expect(calls[0].args).not.toContain("--find-renames");
      expect(calls[0].args).not.toContain("--find-copies");
    });

    it("passes a diff filter through when requested", async () => {
      await provider.getDiffPatch("/repo", {
        from: { type: "index" },
        to: { type: "worktree" },
        diffFilter: "u",
      });
      expect(calls[0].args).toContain("--diff-filter=u");
    });

    it("supports reverse and identical endpoints and rejects invalid pairs", async () => {
      await provider.getDiffPatch("/repo", {
        from: { type: "worktree" },
        to: { type: "index" },
      });
      expect(calls[0].args).toContain("--reverse");
      expect(
        await provider.getDiffPatch("/repo", {
          from: { type: "empty" },
          to: { type: "empty" },
        }),
      ).toBe("");
      await expectAsyncTypeError(() =>
        provider.getDiffPatch("/repo", {
          from: { type: "file", path: "file.txt" },
          to: { type: "index" },
        }),
      );
      await expectAsyncTypeError(() =>
        provider.getDiffPatch("/repo", { from: { type: "commit" }, to: { type: "worktree" } }),
      );
      expect(calls.length).toBe(1);

      async function expectAsyncTypeError(operation) {
        let error = null;
        try {
          await operation();
        } catch (caughtError) {
          error = caughtError;
        }
        expect(error instanceof TypeError).toBe(true);
      }
    });

    it("keeps empty-tree reads out of the repository object database", async () => {
      const operationProvider = new GitRepositoryOperationProvider();
      const workingDirectory = temp.mkdirSync("empty-tree-read-only-diff");
      await operationProvider.initializeRepository(workingDirectory, { initialBranch: "main" });
      fs.writeFileSync(path.join(workingDirectory, "staged.txt"), "staged\n");
      const operations = operationProvider.createRepositoryOperations({ workingDirectory });
      await operations.stageFiles(["staged.txt"]);
      const emptyOid = (
        await operationProvider.run(["hash-object", "-t", "tree", "--stdin"], workingDirectory, {
          stdin: "",
        })
      ).trim();
      const repositoryObject = path.join(
        workingDirectory,
        ".git",
        "objects",
        emptyOid.slice(0, 2),
        emptyOid.slice(2),
      );
      expect(fs.existsSync(repositoryObject)).toBe(false);

      const realProvider = new GitRepositoryDiffProvider();
      const patch = await realProvider.getDiffPatch(workingDirectory, {
        from: { type: "empty" },
        to: { type: "index" },
      });
      expect(patch).toContain("staged.txt");
      expect(fs.existsSync(repositoryObject)).toBe(false);
    });

    it("does not replace a diff result when temporary ODB cleanup fails", async () => {
      const remove = fs.promises.rm.bind(fs.promises);
      const warning = spyOn(console, "warn");
      spyOn(fs.promises, "rm").and.rejectWith(new Error("temporary directory is locked"));

      expect(
        await provider.getDiffPatch("/repo", {
          from: { type: "empty" },
          to: { type: "index" },
        }),
      ).toBe("");
      expect(warning).toHaveBeenCalled();

      const temporaryObjects = calls.find((call) => call.args.includes("hash-object")).options.env
        .GIT_OBJECT_DIRECTORY;
      await remove(temporaryObjects, { recursive: true, force: true });
    });
  });

  describe("GitRepository.getDiff", () => {
    let repo, workingDirectory, operations, operationProvider;

    beforeEach(async () => {
      operationProvider = new GitRepositoryOperationProvider();
      workingDirectory = temp.mkdirSync("repository-diff-repo");
      await operationProvider.initializeRepository(workingDirectory, { initialBranch: "main" });
      operations = operationProvider.createRepositoryOperations({ workingDirectory });
      await operations.setConfig("user.name", "Lumine Specs");
      await operations.setConfig("user.email", "specs@lumine.invalid");

      fs.writeFileSync(path.join(workingDirectory, "file.txt"), "one\ntwo\n");
      await operations.stageFiles(["file.txt"]);
      await operations.commit("first");
      fs.writeFileSync(path.join(workingDirectory, "file.txt"), "one\nTWO\n");
      await operations.stageFiles(["file.txt"]);
      await operations.commit("second");

      fs.appendFileSync(path.join(workingDirectory, "file.txt"), "three\n");
      fs.writeFileSync(path.join(workingDirectory, "untracked.txt"), "hey\n");

      repo = new GitRepository(workingDirectory);
    });

    afterEach(() => {
      if (repo && !repo.isDestroyed()) repo.destroy();
    });

    it("diffs the supported endpoint pairs of a real repository", async () => {
      const indexToWorktree = await repo.getDiff();
      expect(indexToWorktree.files.length).toBe(1);
      expect(indexToWorktree.files[0].newPath).toBe("file.txt");
      expect(
        indexToWorktree.files[0].hunks[0].lines.some(
          (line) => line.kind === "added" && line.text === "three",
        ),
      ).toBe(true);
      expect(indexToWorktree.rawPatch).toBeUndefined();
      expect(Object.isFrozen(indexToWorktree)).toBe(true);

      const withPatch = await repo.getDiff({ format: "both" });
      expect(withPatch.rawPatch).toContain("+three");
      expect(withPatch.files.length).toBe(1);
      const patchOnly = await repo.getDiff({ format: "patch" });
      expect(patchOnly.rawPatch).toContain("+three");
      expect(patchOnly.files).toEqual([]);

      const commitToCommit = await repo.getDiff({
        from: { type: "commit", revision: "HEAD~1" },
        to: { type: "commit", revision: "HEAD" },
      });
      const commitLines = commitToCommit.files[0].hunks[0].lines;
      expect(commitLines.some((line) => line.kind === "deleted" && line.text === "two")).toBe(true);
      expect(commitLines.some((line) => line.kind === "added" && line.text === "TWO")).toBe(true);

      const commitToWorktree = await repo.getDiff({
        from: { type: "commit", revision: "HEAD" },
        to: { type: "worktree" },
      });
      expect(
        commitToWorktree.files[0].hunks[0].lines.some(
          (line) => line.kind === "added" && line.text === "three",
        ),
      ).toBe(true);

      const untracked = await repo.getDiff({
        from: { type: "empty" },
        to: { type: "file", path: "untracked.txt" },
      });
      expect(untracked.files.length).toBe(1);
      expect(untracked.files[0].status).toBe("added");
      expect(untracked.files[0].oldPath).toBeNull();
      expect(
        untracked.files[0].hunks[0].lines.some(
          (line) => line.kind === "added" && line.text === "hey",
        ),
      ).toBe(true);

      const filtered = await repo.getDiff({
        from: { type: "commit", revision: "HEAD~1" },
        to: { type: "commit", revision: "HEAD" },
        paths: ["nothing-here"],
      });
      expect(filtered.files).toEqual([]);
    });

    it("supports whitespace-insensitive diffs", async () => {
      fs.writeFileSync(path.join(workingDirectory, "file.txt"), "one\nTWO   \n");

      const sensitive = await repo.getDiff();
      expect(sensitive.files.length).toBe(1);
      const insensitive = await repo.getDiff({ ignoreWhitespace: true });
      expect(insensitive.files).toEqual([]);
    });

    it("detects renames between commits", async () => {
      await operationProvider.run(["mv", "file.txt", "moved.txt"], workingDirectory);
      await operations.commit("rename");

      const renamed = await repo.getDiff({
        from: { type: "commit", revision: "HEAD~1" },
        to: { type: "commit", revision: "HEAD" },
      });
      expect(renamed.files[0].status).toBe("renamed");
      expect(renamed.files[0].oldPath).toBe("file.txt");
      expect(renamed.files[0].newPath).toBe("moved.txt");
    });

    it("detects copies from changed source files", async () => {
      fs.copyFileSync(
        path.join(workingDirectory, "file.txt"),
        path.join(workingDirectory, "copy.txt"),
      );
      fs.appendFileSync(path.join(workingDirectory, "file.txt"), "source changed\n");
      await operations.stageFiles(["file.txt", "copy.txt"]);

      const result = await repo.getDiff({
        from: { type: "commit", revision: "HEAD" },
        to: { type: "index" },
      });
      const copied = result.files.find((file) => file.status === "copied");
      expect(copied).toBeDefined();
      expect(copied.oldPath).toBe("file.txt");
      expect(copied.newPath).toBe("copy.txt");
    });

    it("preserves binary paths containing the diff-header delimiter", async () => {
      const relativePath = "x b/foo.bin";
      fs.mkdirSync(path.join(workingDirectory, "x b"));
      fs.writeFileSync(path.join(workingDirectory, relativePath), Buffer.from([0, 1, 2]));
      await operations.stageFiles([relativePath]);
      await operations.commit("binary path");
      fs.writeFileSync(path.join(workingDirectory, relativePath), Buffer.from([0, 1, 3]));

      const result = await repo.getDiff();
      const binary = result.files.find((file) => file.newPath === relativePath);
      expect(binary).toBeDefined();
      expect(binary.oldPath).toBe(relativePath);
      expect(binary.binary).toBe(true);
    });

    it("rejects oversized diffs with ERR_GIT_DIFF_TOO_LARGE", async () => {
      let error = null;
      try {
        await repo.getDiff({ maxBytes: 16 });
      } catch (caughtError) {
        error = caughtError;
      }
      expect(error?.code).toBe("ERR_GIT_DIFF_TOO_LARGE");
    });

    it("rejects immediately when the abort signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      let error = null;
      try {
        await repo.getDiff({ signal: controller.signal });
      } catch (caughtError) {
        error = caughtError;
      }
      expect(error).not.toBeNull();
      expect(error.code === "ABORT_ERR" || error.name === "AbortError").toBe(true);
    });
  });
});
