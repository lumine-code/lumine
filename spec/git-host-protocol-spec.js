const {
  ALL_CLI_BACKEND_OVERRIDES,
  GitBackend,
  GitHostOperations,
  backendForOperation,
  reviveError,
  serializeError,
} = require("../src/git-host-protocol");

describe("git-host protocol", () => {
  const descriptor = { gitDirectory: "/repo/.git", workingDirectory: "/repo" };

  it("selects every backend before execution without an error fallback", () => {
    expect(backendForOperation("history", { descriptor })).toBe(GitBackend.GIT_UTILS);
    expect(backendForOperation("logFollow", { descriptor })).toBe(GitBackend.CLI);
    expect(backendForOperation("exec", {})).toBe(GitBackend.CLI);

    expect(
      backendForOperation("snapshot", {
        descriptor,
        request: { status: true, refs: true },
      }),
    ).toBe(GitBackend.HYBRID);
    expect(
      backendForOperation("snapshot", {
        descriptor,
        request: { status: true, refs: false },
      }),
    ).toBe(GitBackend.CLI);
    expect(
      backendForOperation("snapshot", {
        descriptor,
        request: { status: false, refs: true },
      }),
    ).toBe(GitBackend.GIT_UTILS);
    expect(
      backendForOperation("diff", {
        descriptor,
        request: { from: { type: "index" }, to: { type: "worktree" } },
      }),
    ).toBe(GitBackend.CLI);
  });

  it("supports explicit static overrides only for implemented capabilities", () => {
    expect(
      backendForOperation("history", { descriptor }, { backendOverrides: { history: "cli" } }),
    ).toBe(GitBackend.CLI);
    expect(() =>
      backendForOperation("exec", { descriptor }, { backendOverrides: { exec: "git-utils" } }),
    ).toThrowError(/does not implement exec/);

    for (const operation of Object.keys(GitHostOperations)) {
      expect(
        backendForOperation(
          operation,
          { descriptor },
          {
            backendOverrides: ALL_CLI_BACKEND_OVERRIDES,
          },
        ),
      ).toBe(GitBackend.CLI);
    }
  });

  it("round-trips backend errors and their causes", () => {
    const cause = Object.assign(new Error("libgit2 detail"), {
      code: "ERR_GIT_NATIVE_DIFF",
      operation: "diff",
      libgit2Code: -1,
    });
    const error = Object.assign(new Error("Git diff failed"), {
      code: "ERR_GIT_DIFF",
      backend: "git-utils",
      backendCode: cause.code,
      cause,
    });

    const revived = reviveError(serializeError(error));
    expect(revived.message).toBe("Git diff failed");
    expect(revived.code).toBe("ERR_GIT_DIFF");
    expect(revived.backend).toBe("git-utils");
    expect(revived.backendCode).toBe("ERR_GIT_NATIVE_DIFF");
    expect(revived.cause.message).toBe("libgit2 detail");
    expect(revived.cause.libgit2Code).toBe(-1);
  });
});
