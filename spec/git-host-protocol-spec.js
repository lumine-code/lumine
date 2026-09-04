const {
  GitHostOperations,
  assertKnownOperation,
  reviveError,
  serializeError,
} = require("../src/git-host-protocol");

describe("git-host protocol", () => {
  it("keeps one explicit registry of supported operations", () => {
    expect(Object.keys(GitHostOperations).sort()).toEqual(
      [
        "blame",
        "branchesContaining",
        "commit",
        "describe",
        "diff",
        "exec",
        "fileMode",
        "history",
        "lineDiff",
        "logFollow",
        "readConfig",
        "readObjects",
        "snapshot",
        "submodulePaths",
      ].sort(),
    );
    expect(assertKnownOperation("snapshot")).toBe("snapshot");
    expect(() => assertKnownOperation("obsolete")).toThrowError(/Unknown git-host op: obsolete/);
  });

  it("round-trips command errors and their causes", () => {
    const cause = Object.assign(new Error("spawn detail"), {
      code: "ENOENT",
      command: "git",
    });
    const error = Object.assign(new Error("Git diff failed"), {
      code: "ERR_GIT_DIFF",
      operation: "diff",
      backend: "cli",
      backendCode: "ERR_GIT_COMMAND_FAILED",
      cause,
    });

    const revived = reviveError(serializeError(error));
    expect(revived.message).toBe("Git diff failed");
    expect(revived.code).toBe("ERR_GIT_DIFF");
    expect(revived.backend).toBe("cli");
    expect(revived.backendCode).toBe("ERR_GIT_COMMAND_FAILED");
    expect(revived.cause.message).toBe("spawn detail");
    expect(revived.cause.command).toBe("git");
  });
});
