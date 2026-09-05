const fs = require("fs");
const path = require("path");

const temp = require("@lumine-code/temp").track();

const { EMPTY_REFS_SNAPSHOT, parseRefsSnapshot } = require("../src/repository-refs-snapshot");
const GitRepositoryRefsProvider = require("../src/git-repository-refs-provider");
const GitRepositoryOperationProvider = require("../src/git-repository-operation-provider");

function refRecord({
  ref,
  shortName,
  oid = "1111111111111111111111111111111111111111",
  objectType = "commit",
  peeledOid = "",
  upstreamRef = "",
  upstreamShort = "",
  upstreamTrack = "",
  pushRef = "",
  pushShort = "",
  pushTrack = "",
  headMarker = "",
  symref = "",
  parents = "",
  peeledParents = "",
  authorName = "",
  peeledAuthorName = "",
  committerDate = "",
  peeledCommitterDate = "",
  subject = "",
  peeledSubject = "",
}) {
  return [
    ref,
    shortName,
    oid,
    objectType,
    peeledOid,
    upstreamRef,
    upstreamShort,
    upstreamTrack,
    pushRef,
    pushShort,
    pushTrack,
    headMarker,
    symref,
    parents,
    peeledParents,
    authorName,
    peeledAuthorName,
    committerDate,
    peeledCommitterDate,
    subject,
    peeledSubject,
  ].join("\0");
}

function rawBundle(overrides = {}) {
  return {
    forEachRef: "",
    remotes: "",
    worktrees: "",
    symbolicHead: "refs/heads/main\n",
    headOid: "1111111111111111111111111111111111111111\n",
    ...overrides,
  };
}

describe("repository refs snapshot", () => {
  describe("parseRefsSnapshot", () => {
    it("starts from an immutable uninitialized snapshot", () => {
      expect(EMPTY_REFS_SNAPSHOT.initialized).toBe(false);
      expect(EMPTY_REFS_SNAPSHOT.generation).toBe(0);
      expect(Object.isFrozen(EMPTY_REFS_SNAPSHOT)).toBe(true);
      expect(Object.isFrozen(EMPTY_REFS_SNAPSHOT.branches)).toBe(true);
    });

    it("parses a named head and freezes the result", () => {
      const snapshot = parseRefsSnapshot(rawBundle(), { generation: 3 });

      expect(snapshot.initialized).toBe(true);
      expect(snapshot.generation).toBe(3);
      expect(snapshot.head.name).toBe("main");
      expect(snapshot.head.ref).toBe("refs/heads/main");
      expect(snapshot.head.oid).toBe("1111111111111111111111111111111111111111");
      expect(snapshot.head.detached).toBe(false);
      expect(snapshot.head.unborn).toBe(false);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.head)).toBe(true);
      expect(Object.isFrozen(snapshot.branches)).toBe(true);
    });

    it("recognizes detached and unborn heads exactly", () => {
      const detached = parseRefsSnapshot(rawBundle({ symbolicHead: "" }));
      expect(detached.head.detached).toBe(true);
      expect(detached.head.name).toBeNull();
      expect(detached.head.unborn).toBe(false);

      const unborn = parseRefsSnapshot(rawBundle({ headOid: "" }));
      expect(unborn.head.unborn).toBe(true);
      expect(unborn.head.oid).toBeNull();
      expect(unborn.head.name).toBe("main");
      expect(unborn.head.detached).toBe(false);
    });

    it("classifies branches with every upstream tracking state", () => {
      const forEachRef = [
        refRecord({
          ref: "refs/heads/main",
          shortName: "main",
          upstreamRef: "refs/remotes/origin/main",
          upstreamShort: "origin/main",
          upstreamTrack: "",
          headMarker: "*",
        }),
        refRecord({
          ref: "refs/heads/feature",
          shortName: "feature",
          upstreamRef: "refs/remotes/origin/feature",
          upstreamShort: "origin/feature",
          upstreamTrack: "ahead 2, behind 1",
          pushRef: "refs/remotes/fork/feature",
          pushShort: "fork/feature",
          pushTrack: "ahead 3",
        }),
        refRecord({
          ref: "refs/heads/orphaned",
          shortName: "orphaned",
          upstreamRef: "refs/remotes/origin/gone-branch",
          upstreamShort: "origin/gone-branch",
          upstreamTrack: "gone",
        }),
        refRecord({ ref: "refs/heads/local-only", shortName: "local-only" }),
      ].join("\n");

      const { branches } = parseRefsSnapshot(rawBundle({ forEachRef }));

      expect(branches.map((branch) => branch.name)).toEqual([
        "main",
        "feature",
        "orphaned",
        "local-only",
      ]);
      expect(branches[0].isHead).toBe(true);
      expect(branches[0].upstream).toEqual(
        jasmine.objectContaining({ name: "origin/main", ahead: 0, behind: 0, gone: false }),
      );
      expect(branches[1].isHead).toBe(false);
      expect(branches[1].upstream).toEqual(
        jasmine.objectContaining({ ahead: 2, behind: 1, gone: false }),
      );
      expect(branches[2].upstream.gone).toBe(true);
      expect(branches[3].upstream).toBeNull();

      // Push tracking is parsed independently of upstream.
      expect(branches[0].push).toBeNull();
      expect(branches[1].push).toEqual(
        jasmine.objectContaining({
          ref: "refs/remotes/fork/feature",
          name: "fork/feature",
        }),
      );
      expect(branches[1].push.ahead).toBeUndefined();
      expect(branches[3].push).toBeNull();
    });

    it("derives auxiliary ref names with Git lstrip semantics", () => {
      const forEachRef = refRecord({
        ref: "refs/heads/main",
        shortName: "main",
        headMarker: "*",
      });
      const upstreamRefs = [
        "refs/heads/main",
        "1111111111111111111111111111111111111111",
        "refs/custom",
        "",
      ].join("\0");
      const pushRefs = [
        "refs/heads/main",
        "1111111111111111111111111111111111111111",
        "refs/remotes/origin/main",
      ].join("\0");

      const { branches } = parseRefsSnapshot(rawBundle({ forEachRef, upstreamRefs, pushRefs }));

      expect(branches[0].upstream.name).toBe("");
      expect(branches[0].push.name).toBe("origin/main");

      const staleUpstreamRefs = upstreamRefs.replace(
        "1111111111111111111111111111111111111111",
        "2222222222222222222222222222222222222222",
      );
      const stale = parseRefsSnapshot(
        rawBundle({ forEachRef, upstreamRefs: staleUpstreamRefs, pushRefs }),
      );
      expect(stale.branches[0].upstream).toBeNull();
      const stalePushRefs = pushRefs.replace(
        "1111111111111111111111111111111111111111",
        "2222222222222222222222222222222222222222",
      );
      const stalePush = parseRefsSnapshot(
        rawBundle({ forEachRef, upstreamRefs, pushRefs: stalePushRefs }),
      );
      expect(stalePush.branches[0].push).toBeNull();
    });

    it("distinguishes annotated tags from lightweight tags", () => {
      const forEachRef = [
        refRecord({
          ref: "refs/tags/v1",
          shortName: "v1",
          oid: "2222222222222222222222222222222222222222",
        }),
        refRecord({
          ref: "refs/tags/lightweight",
          shortName: "lightweight",
          oid: "4444444444444444444444444444444444444444",
        }),
      ].join("\n");
      const tagObjects = [
        [
          "2222222222222222222222222222222222222222",
          "tag",
          "raw:2222222222222222222222222222222222222222",
        ].join("\t"),
        [
          "3333333333333333333333333333333333333333",
          "commit",
          "peeled:2222222222222222222222222222222222222222",
        ].join("\t"),
        [
          "4444444444444444444444444444444444444444",
          "commit",
          "raw:4444444444444444444444444444444444444444",
        ].join("\t"),
        [
          "4444444444444444444444444444444444444444",
          "commit",
          "peeled:4444444444444444444444444444444444444444",
        ].join("\t"),
      ].join("\n");
      const commitMetadata = [
        [
          "3333333333333333333333333333333333333333",
          "1111111111111111111111111111111111111111",
          "Commit Author",
          "1710000000",
          "Release commit",
        ].join("\0"),
        [
          "4444444444444444444444444444444444444444",
          "",
          "Commit Author",
          "1720000000",
          "Lightweight release commit",
        ].join("\0"),
      ].join("\n");

      const { tags } = parseRefsSnapshot(rawBundle({ forEachRef, tagObjects, commitMetadata }));

      expect(tags[0].annotated).toBe(true);
      expect(tags[0].targetOid).toBe("3333333333333333333333333333333333333333");
      expect(tags[0].lastCommit).toEqual({
        oid: "3333333333333333333333333333333333333333",
        parents: ["1111111111111111111111111111111111111111"],
        authorName: "Commit Author",
        committerDate: new Date(1710000000 * 1000),
        subject: "Release commit",
      });
      expect(tags[1].annotated).toBe(false);
      expect(tags[1].targetOid).toBe("4444444444444444444444444444444444444444");
      expect(tags[1].lastCommit.authorName).toBe("Commit Author");
      expect(Object.isFrozen(tags[0].lastCommit)).toBe(true);
      expect(Object.isFrozen(tags[0].lastCommit.parents)).toBe(true);
    });

    it("classifies remote branches and the origin/HEAD symref", () => {
      const forEachRef = [
        refRecord({
          ref: "refs/remotes/origin/HEAD",
          shortName: "origin/HEAD",
          symref: "refs/remotes/origin/main",
        }),
        refRecord({ ref: "refs/remotes/origin/main", shortName: "origin/main" }),
        refRecord({ ref: "refs/remotes/fork/topic", shortName: "fork/topic" }),
      ].join("\n");

      const { remoteBranches } = parseRefsSnapshot(rawBundle({ forEachRef }));

      expect(remoteBranches[0].symrefTarget).toBe("refs/remotes/origin/main");
      expect(remoteBranches[0].remoteName).toBe("origin");
      expect(remoteBranches[1].symrefTarget).toBeNull();
      expect(remoteBranches[2].remoteName).toBe("fork");
    });

    it("merges fetch and push URLs per remote", () => {
      const remotes = [
        "origin\thttps://example.com/fetch.git (fetch)",
        "origin\thttps://example.com/push.git (push)",
        "upstream\tgit@example.com:c.git (fetch)",
        "upstream\tgit@example.com:c.git (push)",
        "",
      ].join("\n");

      const snapshot = parseRefsSnapshot(rawBundle({ remotes }));

      expect(snapshot.remotes).toEqual([
        {
          name: "origin",
          fetchUrl: "https://example.com/fetch.git",
          pushUrl: "https://example.com/push.git",
        },
        { name: "upstream", fetchUrl: "git@example.com:c.git", pushUrl: "git@example.com:c.git" },
      ]);
    });

    it("parses worktrees including bare, detached, and locked entries", () => {
      const worktrees = [
        "worktree /repos/main",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /repos/hotfix",
        "HEAD 2222222222222222222222222222222222222222",
        "detached",
        "locked being repaired",
        "",
        "worktree /repos/bare",
        "bare",
        "",
        "",
      ].join("\0");

      const snapshot = parseRefsSnapshot(rawBundle({ worktrees }));

      expect(snapshot.worktrees.length).toBe(3);
      expect(snapshot.worktrees[0]).toEqual(
        jasmine.objectContaining({ path: "/repos/main", branch: "refs/heads/main" }),
      );
      expect(snapshot.worktrees[1]).toEqual(
        jasmine.objectContaining({ detached: true, locked: true, lockedReason: "being repaired" }),
      );
      expect(snapshot.worktrees[2].bare).toBe(true);
    });

    it("rejects malformed for-each-ref records", () => {
      expect(() => parseRefsSnapshot(rawBundle({ forEachRef: "refs/heads/main\0main" }))).toThrow();
    });
  });

  describe("GitRepositoryRefsProvider", () => {
    it("keeps branch routing atoms out of the all-ref metadata scan", async () => {
      const calls = [];
      const refsProvider = new GitRepositoryRefsProvider({
        execute: async (args) => {
          calls.push(args);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      await refsProvider.getRefs("repository");

      const forEachRefArgs = calls.find((args) => args.includes("for-each-ref"));
      const format = forEachRefArgs.find((argument) => argument.startsWith("--format="));
      expect(format).toContain("%(refname)");
      expect(format).not.toContain("%(upstream)");
      expect(format).not.toContain("%(push)");
      expect(format).not.toContain(":short)");
      const refCalls = calls.filter((args) => args.includes("for-each-ref"));
      expect(refCalls.length).toBe(1);
      expect(format).not.toContain("%(objecttype)");
      expect(format).not.toContain("%(parent)");
    });

    it("batches commit metadata and tag peeling by unique object id", async () => {
      const oid = "1111111111111111111111111111111111111111";
      const baseOutput = [
        refRecord({ ref: "refs/heads/main", oid }),
        refRecord({ ref: "refs/tags/v1", oid }),
      ].join("\n");
      const calls = [];
      const refsProvider = new GitRepositoryRefsProvider({
        execute: async (args, _workingDirectory, options) => {
          calls.push({ args, stdin: options.stdin });
          const format = args.find((argument) => argument.startsWith("--format=")) || "";
          const isBaseScan =
            args.includes("for-each-ref") &&
            format.includes("%(HEAD)") &&
            args.includes("refs/remotes");
          return { exitCode: 0, stdout: isBaseScan ? baseOutput : "", stderr: "" };
        },
      });

      await refsProvider.getRefs("repository");

      const logCall = calls.find(({ args }) => args.includes("log"));
      expect(logCall.stdin).toBe(`${oid}\n`);
      expect(logCall.args).toContain("--ignore-missing");
      expect(logCall.args).toContain("--no-show-signature");
      expect(logCall.args).toContain("--no-decorate");
      expect(logCall.args).toContain("--no-use-mailmap");
      expect(logCall.args).toContain("--encoding=UTF-8");
      const catFileCall = calls.find(({ args }) => args.includes("cat-file"));
      expect(catFileCall.stdin).toBe(`${oid} raw:${oid}\n${oid}^{} peeled:${oid}\n`);
    });

    it("queries configured upstreams and possible push targets separately", async () => {
      const calls = [];
      const refsProvider = new GitRepositoryRefsProvider({
        execute: async (args, _workingDirectory, options) => {
          calls.push({ args, stdin: options.stdin });
          const command = args.find((argument) =>
            ["config", "remote", "for-each-ref"].includes(argument),
          );
          if (command === "config") {
            return {
              exitCode: 0,
              stdout:
                "branch.topic.with.dots.remote\0branch.topic.with.dots.merge\0" +
                "remote.origin.url\0",
              stderr: "",
            };
          }
          if (command === "remote") {
            return {
              exitCode: 0,
              stdout: "origin\thttps://example.test/repo.git (push)\n",
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      await refsProvider.getRefs("repository");

      const refCalls = calls.filter(({ args }) => args.includes("for-each-ref"));
      expect(refCalls.length).toBe(3);
      const upstreamCall = refCalls.find(({ args }) =>
        args.some(
          (argument) =>
            argument.startsWith("--format=") && argument.includes("%(upstream:track,nobracket)"),
        ),
      );
      expect(upstreamCall.stdin).toBeUndefined();
      expect(upstreamCall.args).toContain("refs/heads/topic.with.dots");
      expect(upstreamCall.args).not.toContain("--stdin");
      expect(upstreamCall.args.join(" ")).toContain("%(upstream:track,nobracket)");
      const pushCall = refCalls.find(({ args }) =>
        args.some((argument) => argument.startsWith("--format=") && argument.includes("%(push)")),
      );
      expect(pushCall.args.join(" ")).toContain("%(push)");
      expect(pushCall.args.join(" ")).not.toContain("%(push:track");
    });

    it("skips all-branch push resolution when push.default is nothing", async () => {
      const calls = [];
      const refsProvider = new GitRepositoryRefsProvider({
        execute: async (args) => {
          calls.push(args);
          if (args.includes("config")) {
            return {
              exitCode: 0,
              stdout: "push.default\nnothing\0remote.origin.url\nhttps://example.test/repo.git\0",
              stderr: "",
            };
          }
          if (args.includes("remote")) {
            return {
              exitCode: 0,
              stdout: "origin\thttps://example.test/repo.git (push)\n",
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      await refsProvider.getRefs("repository");

      expect(
        calls.some(
          (args) =>
            args.includes("for-each-ref") &&
            args.some(
              (argument) => argument.startsWith("--format=") && argument.includes("%(push)"),
            ),
        ),
      ).toBe(false);
    });

    it("falls back to one heads scan before configured upstream arguments grow too large", async () => {
      const branchNames = Array.from(
        { length: 400 },
        (_, index) => `branch-${index}-${"x".repeat(32)}`,
      );
      const configuration = branchNames
        .flatMap((branch) => [`branch.${branch}.remote`, `branch.${branch}.merge`])
        .join("\0");
      const calls = [];
      const refsProvider = new GitRepositoryRefsProvider({
        execute: async (args) => {
          calls.push(args);
          return {
            exitCode: 0,
            stdout: args.includes("config") ? `${configuration}\0` : "",
            stderr: "",
          };
        },
      });

      await refsProvider.getRefs("repository");

      const upstreamCall = calls.find(
        (args) =>
          args.includes("for-each-ref") &&
          args.some(
            (argument) =>
              argument.startsWith("--format=") && argument.includes("%(upstream:track,nobracket)"),
          ),
      );
      expect(upstreamCall.filter((argument) => argument === "refs/heads")).toEqual(["refs/heads"]);
      expect(upstreamCall).not.toContain(`refs/heads/${branchNames[0]}`);
    });

    it("reads refs, remotes, worktrees, and head state from a real repository", async () => {
      const operationProvider = new GitRepositoryOperationProvider();
      const workingDirectory = temp.mkdirSync("refs-provider-repo");
      const worktreePath = path.join(temp.mkdirSync("refs-provider-worktrees"), "feature");

      await operationProvider.initializeRepository(workingDirectory, { initialBranch: "main" });
      const operations = operationProvider.createRepositoryOperations({ workingDirectory });
      await operations.setConfig("user.name", "Lumine Specs");
      await operations.setConfig("user.email", "specs@lumine.invalid");
      fs.writeFileSync(path.join(workingDirectory, "file.txt"), "content\n");
      await operations.stageFiles(["file.txt"]);
      await operations.commit("Initial café");
      await operations.setConfig("i18n.logOutputEncoding", "ISO-8859-1");
      await operations.setConfig("log.showSignature", "true");
      const blobOid = (
        await operationProvider.run(["rev-parse", "HEAD:file.txt"], workingDirectory)
      ).trim();
      await operationProvider.run(["branch", "feature"], workingDirectory);
      await operationProvider.run(["tag", "-a", "v1", "-m", "release"], workingDirectory);
      await operationProvider.run(
        ["tag", "-a", "blob-v1", blobOid, "-m", "blob release"],
        workingDirectory,
      );
      await operationProvider.run(["tag", "lightweight"], workingDirectory);
      await operationProvider.run(["tag", "feature"], workingDirectory);
      await operations.addRemote("origin", "https://example.com/repo.git");
      await operationProvider.run(
        ["update-ref", "refs/remotes/origin/main", "HEAD"],
        workingDirectory,
      );
      await operations.setConfig("branch.main.remote", "origin");
      await operations.setConfig("branch.main.merge", "refs/heads/main");
      await operations.setConfig("branch.feature.remote", ".");
      await operations.setConfig("branch.feature.merge", "refs/heads/main");
      await operations.setConfig("branch.feature.pushRemote", "origin");
      await operations.setConfig("push.default", "current");
      await operationProvider.run(["worktree", "add", worktreePath, "feature"], workingDirectory);

      const refsProvider = new GitRepositoryRefsProvider();
      const snapshot = parseRefsSnapshot(await refsProvider.getRefs(workingDirectory));

      expect(snapshot.head.name).toBe("main");
      expect(snapshot.head.detached).toBe(false);
      expect(snapshot.head.unborn).toBe(false);
      expect(snapshot.head.oid).toMatch(/^[0-9a-f]{40}$/);

      const branchNames = snapshot.branches.map((branch) => branch.name).sort();
      expect(branchNames).toEqual(["feature", "main"]);
      const mainBranch = snapshot.branches.find((branch) => branch.ref === "refs/heads/main");
      const featureBranch = snapshot.branches.find((branch) => branch.ref === "refs/heads/feature");
      expect(mainBranch.isHead).toBe(true);
      expect(mainBranch.upstream).toEqual(
        jasmine.objectContaining({
          ref: "refs/remotes/origin/main",
          name: "origin/main",
          ahead: 0,
          behind: 0,
          gone: false,
        }),
      );
      expect(mainBranch.push).toEqual(
        jasmine.objectContaining({ ref: "refs/remotes/origin/main", name: "origin/main" }),
      );
      expect(featureBranch.upstream).toEqual(
        jasmine.objectContaining({
          ref: "refs/heads/main",
          name: "main",
          ahead: 0,
          behind: 0,
          gone: false,
        }),
      );
      expect(featureBranch.push).toEqual(
        jasmine.objectContaining({
          ref: "refs/remotes/origin/feature",
          name: "origin/feature",
        }),
      );
      expect(featureBranch.push.gone).toBeUndefined();

      // The full ref is the stable identity. A branch and tag with the same
      // display name remain distinct without Git's quadratic ambiguity scan.
      const featureTag = snapshot.tags.find((tag) => tag.ref === "refs/tags/feature");
      expect(featureBranch.name).toBe("feature");
      expect(featureTag.name).toBe("feature");
      expect(featureBranch.ref).not.toBe(featureTag.ref);

      const annotated = snapshot.tags.find((tag) => tag.name === "v1");
      expect(annotated.annotated).toBe(true);
      expect(annotated.targetOid).toBe(snapshot.head.oid);
      expect(annotated.oid).not.toBe(annotated.targetOid);
      expect(annotated.lastCommit.oid).toBe(snapshot.head.oid);
      expect(annotated.lastCommit.authorName).toBe("Lumine Specs");
      expect(annotated.lastCommit.subject).toBe("Initial café");
      expect(annotated.lastCommit.committerDate instanceof Date).toBe(true);
      const lightweight = snapshot.tags.find((tag) => tag.name === "lightweight");
      expect(lightweight.annotated).toBe(false);
      expect(lightweight.targetOid).toBe(snapshot.head.oid);
      expect(lightweight.lastCommit.oid).toBe(snapshot.head.oid);
      const blobTag = snapshot.tags.find((tag) => tag.name === "blob-v1");
      expect(blobTag.annotated).toBe(true);
      expect(blobTag.targetOid).toBe(blobOid);
      expect(blobTag.lastCommit).toBeNull();

      expect(mainBranch.lastCommit.subject).toBe("Initial café");

      expect(snapshot.remotes).toEqual([
        {
          name: "origin",
          fetchUrl: "https://example.com/repo.git",
          pushUrl: "https://example.com/repo.git",
        },
      ]);

      expect(snapshot.worktrees.length).toBe(2);
      const featureWorktree = snapshot.worktrees.find(
        (worktree) => worktree.branch === "refs/heads/feature",
      );
      expect(featureWorktree).toBeDefined();

      // A user-supplied branch pattern is an operand even when it resembles a
      // command-line option.
      expect(
        await refsProvider.getBranchesContaining(workingDirectory, snapshot.head.oid, {
          pattern: "--format=oops",
        }),
      ).toEqual([]);

      // A detached checkout is reported as detached, not as a branch head.
      await operationProvider.run(["checkout", "--detach"], workingDirectory);
      const detachedSnapshot = parseRefsSnapshot(await refsProvider.getRefs(workingDirectory));
      expect(detachedSnapshot.head.detached).toBe(true);
      expect(detachedSnapshot.head.name).toBeNull();
      expect(detachedSnapshot.head.oid).toBe(snapshot.head.oid);
    });

    it("reports an unborn branch in a freshly initialized repository", async () => {
      const operationProvider = new GitRepositoryOperationProvider();
      const workingDirectory = temp.mkdirSync("refs-provider-unborn");
      await operationProvider.initializeRepository(workingDirectory, { initialBranch: "main" });

      const refsProvider = new GitRepositoryRefsProvider();
      const snapshot = parseRefsSnapshot(await refsProvider.getRefs(workingDirectory));

      expect(snapshot.head.unborn).toBe(true);
      expect(snapshot.head.oid).toBeNull();
      expect(snapshot.head.name).toBe("main");
      expect(snapshot.branches).toEqual([]);
    });
  });
});
