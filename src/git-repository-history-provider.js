const GitRunner = require("./git-runner");
const { GitOperationError } = GitRunner;

const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b";

function isUnbornOrEmptyHistory(stderr, revision) {
  const message = String(stderr);
  if (/does not have any commits yet|bad default revision|unknown revision/.test(message)) {
    return true;
  }
  const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(revision));
  return fullOid && /\bbad object\b/i.test(message);
}

// Read-side history commands. Every format is machine-stable: NUL-delimited
// log fields, -z name-status records, and blame porcelain — never
// human-formatted output.
module.exports = class GitRepositoryHistoryProvider {
  constructor({ runner, execute } = {}) {
    this.runner = runner || new GitRunner({ execute });
  }

  async getLog(
    workingDirectory,
    { revision = "HEAD", allRefs = false, path = null, limit, skip = 0 },
    options = {},
  ) {
    const args = ["log", "-z", `--format=${LOG_FORMAT}`];
    if (limit != null) args.push(`--max-count=${limit}`);
    if (skip > 0) args.push(`--skip=${skip}`);
    args.push(allRefs ? "--all" : revision);
    if (path) args.push("--follow", "--", path);

    const result = await this.runner.runResult(args, workingDirectory, {
      ...options,
      allowedExitCodes: [0, 128],
    });
    if (result.exitCode === 0) return result.stdout;
    if (isUnbornOrEmptyHistory(result.stderr, revision)) return "";
    throw new GitOperationError("log", result);
  }

  getNameStatus(workingDirectory, sha, { parent = null, ...options } = {}) {
    const endpoints = parent ? [parent, sha] : ["--root", sha];
    return this.runner.run(
      [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-z",
        "-r",
        "--find-renames",
        "--find-copies",
        ...endpoints,
      ],
      workingDirectory,
      options,
    );
  }

  getBlame(
    workingDirectory,
    relativePosixPath,
    { revision = null, ignoreWhitespace = false } = {},
    options = {},
  ) {
    const args = ["blame", "--porcelain"];
    if (ignoreWhitespace) args.push("-w");
    if (revision) args.push(revision);
    args.push("--", relativePosixPath);
    return this.runner.run(args, workingDirectory, options);
  }
};
