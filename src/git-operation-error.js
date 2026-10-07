const { GitError } = require("./git-error");
const MAX_GIT_ERROR_DETAIL_BYTES = 64 * 1024;
const TRUNCATED_DIAGNOSTIC_SUFFIX = "\n… [truncated by git-host]";

function boundedErrorDetail(value) {
  const text = String(value).trim();
  if (Buffer.byteLength(text) <= MAX_GIT_ERROR_DETAIL_BYTES) return text;
  const suffixBytes = Buffer.byteLength(TRUNCATED_DIAGNOSTIC_SUFFIX);
  return (
    Buffer.from(text)
      .subarray(0, MAX_GIT_ERROR_DETAIL_BYTES - suffixBytes)
      .toString("utf8") + TRUNCATED_DIAGNOSTIC_SUFFIX
  );
}

class GitOperationError extends GitError {
  constructor(command, result) {
    const stderr = String(result.stderr);
    const stdout = String(result.stdout);
    const detail = boundedErrorDetail(
      stderr.trim() || stdout.trim() || `exit code ${result.exitCode}`,
    );
    super(`Git ${command} failed: ${detail}`);
    this.name = "GitOperationError";
    this.code = "ERR_GIT_COMMAND_FAILED";
    this.command = command;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.outcome = "failed";
    this.retriable = false;
  }
}

module.exports = GitOperationError;
