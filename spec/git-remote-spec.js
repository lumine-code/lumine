const { parseGitRemote } = require("../src/git-remote");

describe("Git remote addresses", () => {
  it("normalizes URL and scp transports without retaining credentials", () => {
    for (const remote of [
      "git@github.com:team/repo.git",
      "github.com:team/repo.git",
      "ssh://alice@github.com/team/repo.git",
      "git://github.com/team/repo.git/",
      "https://alice:secret@github.com/team/repo.git",
    ]) {
      const parsed = parseGitRemote(remote);
      expect(parsed.host).toBe("github.com");
      expect(parsed.namespace).toBe("team");
      expect(parsed.repository).toBe("repo");
      expect(parsed.webURL).toBe("https://github.com/team/repo");
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(JSON.stringify(parsed)).not.toContain("secret");
    }
  });

  it("preserves nested namespaces and HTTP ports, while keeping SSH ports out of browser URLs", () => {
    expect(parseGitRemote("https://gitlab.example:8443/team/subgroup/repo.git")).toEqual({
      transport: "https",
      host: "gitlab.example",
      port: "8443",
      namespace: "team/subgroup",
      repository: "repo",
      path: "team/subgroup/repo",
      webURL: "https://gitlab.example:8443/team/subgroup/repo",
    });
    const ssh = parseGitRemote("ssh://alice@gitlab.example:2222/team/repo.git");
    expect(ssh.port).toBe("2222");
    expect(ssh.webURL).toBe("https://gitlab.example/team/repo");
    expect(parseGitRemote("http://forge.example/team/repo").webURL).toBe(
      "http://forge.example/team/repo",
    );
  });

  it("does not infer a different host from a substring", () => {
    expect(parseGitRemote("https://notgithub.com/team/repo.git").host).toBe("notgithub.com");
    expect(parseGitRemote("https://github.com.example/team/repo.git").host).toBe(
      "github.com.example",
    );
  });

  it("accepts a root repository such as a GitHub gist", () => {
    const gist = parseGitRemote("git@gist.github.com:abc123.git");
    expect(gist.namespace).toBe("");
    expect(gist.repository).toBe("abc123");
    expect(gist.webURL).toBe("https://gist.github.com/abc123");
  });

  it("rejects local paths, unsupported protocols and incomplete repository addresses", () => {
    for (const remote of [
      null,
      "",
      "../repo",
      "C:\\repos\\sample",
      "/repos/sample",
      "file:///team/repo",
      "ftp://host/team/repo",
      "https://host/",
      "git@host:team//repo",
      "git@invalid host:team/repo",
    ]) {
      expect(parseGitRemote(remote)).withContext(String(remote)).toBeNull();
    }
  });
});
