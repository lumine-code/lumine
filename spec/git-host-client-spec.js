const GitHost = require("../src/git-host");
const GitHostClient = require("../src/git-host-client");

describe("GitHostClient", () => {
  it("resolves the current GitHost singleton for every request", async () => {
    const firstHost = { request: jasmine.createSpy("first request").and.resolveTo("first") };
    const secondHost = { request: jasmine.createSpy("second request").and.resolveTo("second") };
    let currentHost = firstHost;
    spyOn(GitHost, "instance").and.callFake(() => currentHost);
    const client = new GitHostClient();
    const descriptor = { gitDirectory: "repo/.git", workingDirectory: "repo" };

    expect(await client.getDescription(descriptor)).toBe("first");
    currentHost = secondHost;
    expect(await client.getDescription(descriptor)).toBe("second");

    expect(GitHost.instance.calls.count()).toBe(2);
    expect(firstHost.request).toHaveBeenCalledWith(
      "describe",
      { descriptor },
      { signal: undefined },
    );
    expect(secondHost.request).toHaveBeenCalledWith(
      "describe",
      { descriptor },
      { signal: undefined },
    );
  });

  it("asks the worker to decode object contents", async () => {
    const host = {
      request: jasmine
        .createSpy("request")
        .and.resolveTo([{ oid: "abc", type: "blob", size: 4, content: "text" }]),
    };
    const client = new GitHostClient(host);
    const descriptor = { gitDirectory: "repo/.git", workingDirectory: "repo" };

    expect(await client.getBlob(descriptor, "abc", { encoding: "utf16le" })).toBe("text");
    expect(host.request).toHaveBeenCalledWith(
      "readObjects",
      { descriptor, requests: [{ oid: "abc" }], encoding: "utf16le" },
      { signal: undefined },
    );
  });

  it("sends output-to-file commands without a renderer buffer", async () => {
    const host = { request: jasmine.createSpy("request").and.resolveTo({ exitCode: 0 }) };
    const client = new GitHostClient(host);
    const descriptor = {
      gitDirectory: "/repo/.git",
      workingDirectory: "/repo",
      worktreeGitMarker: { path: "/repo/.git", kind: "directory" },
    };

    await client.writeRepositoryCommandOutput(
      descriptor,
      ["cat-file", "blob", "abc"],
      "/repo/file.txt",
      {
        signal: "signal",
        allowedExitCodes: [0, 1],
      },
    );

    expect(host.request).toHaveBeenCalledWith(
      "writeRepositoryCommandOutput",
      {
        descriptor,
        args: ["cat-file", "blob", "abc"],
        destinationPath: "/repo/file.txt",
        options: { allowedExitCodes: [0, 1] },
      },
      { signal: "signal" },
    );
  });

  it("sends repository commands with their exact descriptor", async () => {
    const host = {
      request: jasmine.createSpy("request").and.resolveTo({ exitCode: 0, stdout: "", stderr: "" }),
    };
    const client = new GitHostClient(host);
    const descriptor = {
      gitDirectory: "/storage/repo.git",
      workingDirectory: "/work/repo",
      worktreeGitMarker: { path: "/work/repo/.git", kind: "gitfile" },
    };

    await client.execRepository(descriptor, ["status"], {
      signal: "signal",
      env: { EXAMPLE: "1" },
    });

    expect(host.request).toHaveBeenCalledWith(
      "execRepository",
      { descriptor, args: ["status"], options: { env: { EXAMPLE: "1" } } },
      { signal: "signal" },
    );
  });
});
