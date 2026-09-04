const GitRunner = require("./git-runner");

module.exports = class GitRepositoryStatusProvider {
  constructor({ runner, execute } = {}) {
    this.runner = runner || new GitRunner({ execute });
  }

  getStatus(workingDirectory, options = {}) {
    const args = [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--renames",
    ];
    if (options.includeIgnored) args.push("--ignored=matching");
    return this.runner.run(args, workingDirectory, options);
  }

  // The index mode of a path (`git ls-files --stage`); returns the first stage's
  // mode, or null when the path is not tracked. Callers fall back to the
  // working-tree mode for untracked paths.
  async getFileMode(workingDirectory, relativePosixPath, options = {}) {
    const output = await this.runner.run(
      ["ls-files", "--stage", "--", relativePosixPath],
      workingDirectory,
      options,
    );
    if (!output) return null;
    const space = output.indexOf(" ");
    return space === -1 ? null : output.slice(0, space);
  }

  // Read declared paths through Git's config parser so quoted, escaped,
  // whitespace, and Unicode values round-trip without parsing display output.
  async getSubmodulePaths(workingDirectory, options = {}) {
    const result = await this.runner.runResult(
      ["config", "--null", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
      workingDirectory,
      { ...options, allowedExitCodes: [0, 1] },
    );
    if (result.exitCode === 1) return [];
    return String(result.stdout)
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const separator = record.indexOf("\n");
        return separator === -1 ? null : record.slice(separator + 1);
      })
      .filter(Boolean);
  }
};
