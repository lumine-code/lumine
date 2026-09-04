const GitCliBackend = require("../src/git-cli-backend");
const { canonicalConfigKey, parseBatchObjects } = GitCliBackend;

describe("GitCliBackend", () => {
  it("parses binary cat-file batches and missing objects", () => {
    const content = Buffer.from([0, 10, 255]);
    const output = Buffer.concat([
      Buffer.from("abc blob 3\0"),
      content,
      Buffer.from("\0missing missing\0"),
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

    const backend = new GitCliBackend({
      runner: {
        run: async () => "remote.Origin.url\nupper\0remote.origin.url\nlower\0",
      },
    });
    expect(
      await backend.readConfig({ gitDirectory: "/repo/.git", workingDirectory: "/repo" }, [
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
    const backend = new GitCliBackend({ runner: {} });
    backend.historyProvider = {
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

    await backend.commit(
      { gitDirectory: "/repo/.git", workingDirectory: "/repo" },
      { revision: "HEAD" },
      {},
    );

    const [workingDirectory, revision, options] =
      backend.historyProvider.getNameStatus.calls.mostRecent().args;
    expect(workingDirectory).toBe("/repo");
    expect(revision).toBe(resolved);
    expect(options.parent).toBe(parent);
  });
});
