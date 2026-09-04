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
});
