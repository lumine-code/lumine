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

  // Never `git show <rev>:<path>` here. When the path is absent at the revision
  // *and* contains a glob metacharacter (`[`, `]`, `*`, `?`), Git fails to
  // resolve the argument as an object, decides it "looks like a pathspec"
  // instead, and falls back to a revision-less `git show` — printing the HEAD
  // commit message on stdout with exit 0. Every caller then treats that log text
  // as the file's contents at the revision, which shows an ignored or untracked
  // file as modified from its first line to its last. `cat-file blob` takes an
  // object name only and has no pathspec fallback, so an absent path always
  // reports as absent whatever characters it contains.
  async getFileAtRevision(workingDirectory, relativePosixPath, revision, options = {}) {
    const result = await this.runner.runResult(
      ["cat-file", "blob", `${revision}:${relativePosixPath}`],
      workingDirectory,
      { ...options, allowedExitCodes: [0, 128] },
    );
    if (result.exitCode === 0) return result.stdout;
    const stderr = String(result.stderr);
    if (
      /does not exist in|does not exist \(neither on disk nor in the index\)|exists on disk, but not in|invalid object name|bad revision|but not in the working tree/i.test(
        stderr,
      )
    ) {
      return null;
    }
    throw new GitOperationError("cat-file", result);
  }

  // Read a blob's contents by object id (`git cat-file -p <oid>`). Returns the
  // contents, or null when the oid does not name an object.
  async getBlob(workingDirectory, oid, options = {}) {
    const result = await this.runner.runResult(["cat-file", "-p", oid], workingDirectory, {
      ...options,
      allowedExitCodes: [0, 128],
    });
    if (result.exitCode === 0) return result.stdout;
    if (/Not a valid object name|bad file|could not get object info/.test(String(result.stderr))) {
      return null;
    }
    throw new GitOperationError("cat-file", result);
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
