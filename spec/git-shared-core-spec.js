const { GitError, LargeRepoError } = require("../src/git-error");
const { filterPatch, MAX_PATCH_CHARS } = require("../src/patch-filter");
const lumineModule = require("../exports/lumine");
const FileState = require("../src/file-state");

describe("shared git core", () => {
  describe("git-error", () => {
    it("exposes GitError and LargeRepoError as Error subclasses carrying the message", () => {
      const error = new GitError("boom");
      expect(error instanceof Error).toBe(true);
      expect(error.message).toBe("boom");
      expect(new LargeRepoError("too big") instanceof Error).toBe(true);
    });

    it("re-exports the same classes from the lumine module for packages to share", () => {
      expect(lumineModule.GitError).toBe(GitError);
      expect(lumineModule.LargeRepoError).toBe(LargeRepoError);
      expect(lumineModule.filterPatch).toBe(filterPatch);
      expect(lumineModule.FileState).toBe(FileState);
    });
  });

  describe("filterPatch", () => {
    it("returns a small diff unchanged with nothing removed", () => {
      const diff = "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
      const { filtered, removed } = filterPatch(diff);
      expect(filtered).toBe(diff);
      expect(removed.size).toBe(0);
    });

    it("drops whole file-patches that overflow the budget and reports their paths", () => {
      const big = "x".repeat(MAX_PATCH_CHARS);
      const diff =
        "diff --git a/small.txt b/small.txt\n@@ -1 +1 @@\n-a\n+b\n" +
        `diff --git a/big.txt b/big.txt\n@@ -1 +1 @@\n-${big}\n+${big}\n`;
      const { filtered, removed } = filterPatch(diff);
      expect(filtered).toContain("small.txt");
      expect(filtered).not.toContain("big.txt");
      expect(removed.has("big.txt")).toBe(true);
    });
  });
});
