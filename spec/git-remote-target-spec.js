const resolveRemoteTarget = require("../src/git-remote-target");

function snapshot({ upstream = null, push = null, remotes = ["origin"], head = true } = {}) {
  return {
    branches: [{ name: "feature/ui", isHead: head, upstream, push }],
    remotes: remotes.map((name) => ({ name })),
  };
}

describe("Git current-branch remote targets", () => {
  it("pulls from upstream and pushes to the distinct configured push target", () => {
    const refs = snapshot({
      upstream: { name: "origin/release/v2" },
      push: { name: "publish/team/main" },
      remotes: ["origin", "publish"],
    });
    expect(resolveRemoteTarget(refs, "pull")).toEqual({
      remote: "origin",
      reference: "release/v2",
      setUpstream: false,
    });
    expect(resolveRemoteTarget(refs, "push")).toEqual({
      remote: "publish",
      reference: "feature/ui:team/main",
      setUpstream: false,
    });
    expect(resolveRemoteTarget(refs, "fetch")).toEqual({
      remote: "origin",
      reference: null,
      setUpstream: false,
    });
  });

  it("uses the upstream as the push fallback while preserving nested branch names", () => {
    const refs = snapshot({ upstream: { name: "origin/feature/ui" } });
    expect(resolveRemoteTarget(refs, "push")).toEqual({
      remote: "origin",
      reference: "feature/ui",
      setUpstream: false,
    });
  });

  it("selects the only remote or origin for an untracked branch", () => {
    expect(resolveRemoteTarget(snapshot({ remotes: ["fork"] }), "push")).toEqual({
      remote: "fork",
      reference: "feature/ui",
      setUpstream: true,
    });
    expect(resolveRemoteTarget(snapshot({ remotes: ["upstream", "origin"] }), "fetch")).toEqual({
      remote: "origin",
      reference: null,
      setUpstream: false,
    });
    expect(() =>
      resolveRemoteTarget(snapshot({ remotes: ["first", "second"] }), "push"),
    ).toThrowError(/does not identify a remote/);
  });

  it("requires an upstream for pull even when a push target or origin exists", () => {
    expect(() =>
      resolveRemoteTarget(snapshot({ push: { name: "origin/main" } }), "pull"),
    ).toThrowError(/no upstream/);
  });

  it("refuses a detached HEAD or missing remote with a stable context error", () => {
    for (const operation of ["fetch", "pull", "push"]) {
      let failure;
      try {
        resolveRemoteTarget(snapshot({ head: false }), operation);
      } catch (error) {
        failure = error;
      }
      expect(failure.code).toBe("ERR_GIT_REMOTE_CONTEXT");
    }
    expect(() => resolveRemoteTarget(snapshot({ remotes: [] }), "fetch")).toThrowError(
      /does not identify a remote/,
    );
  });

  it("pulls from a local upstream using Git's dot remote", () => {
    const refs = snapshot({ upstream: { ref: "refs/heads/main", name: "main" } });
    expect(resolveRemoteTarget(refs, "pull")).toEqual({
      remote: ".",
      reference: "main",
      setUpstream: false,
    });
  });

  it("matches remote names containing slashes before extracting the branch", () => {
    const refs = snapshot({
      upstream: { ref: "refs/remotes/team/origin/release/v2", name: "team/origin/release/v2" },
      remotes: ["team", "team/origin"],
    });
    expect(resolveRemoteTarget(refs, "pull")).toEqual({
      remote: "team/origin",
      reference: "release/v2",
      setUpstream: false,
    });
  });
});
