// Error types for Git command failures surfaced to the Git UI packages. They
// live in core and are re-exported from the `lumine` module so that git-panel and
// github-panel share a single class identity: a github-panel
// `catch (e) { if (e instanceof GitError) ... }` must match the error git-panel
// throws, which only holds when both import the same class.
class GitError extends Error {
  constructor(message) {
    super(message);
    this.message = message;
    this.stack = new Error().stack;
  }
}

class LargeRepoError extends Error {
  constructor(message) {
    super(message);
    this.message = message;
    this.stack = new Error().stack;
  }
}

// GitRunner error codes are useful inside git-host, but packages consume the
// operation-level repository facade. Preserve the original code as diagnostic
// metadata while exposing a stable code for each public operation.
function operationErrorCode(operation) {
  return `ERR_GIT_${String(operation)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()}`;
}

function normalizeGitOperationError(error, { operation = null } = {}) {
  if (!error || typeof error !== "object") return error;
  const originalCode = String(error.code || "");

  if (error.name === "AbortError" || originalCode === "ABORT_ERR") return error;

  if (!operation) return error;

  if (
    originalCode === "ERR_GIT_DIFF_TOO_LARGE" ||
    originalCode === "ERR_GIT_CREATE_BLOB" ||
    originalCode.startsWith("ERR_GIT_HOST_")
  ) {
    return error;
  }

  if (operation === "diff" && originalCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    error.gitCode ||= originalCode;
    error.code = "ERR_GIT_DIFF_TOO_LARGE";
    error.operation ||= "diff";
    return error;
  }

  const code = operationErrorCode(operation);
  if (originalCode && originalCode !== code) error.gitCode ||= originalCode;
  error.code = code;
  error.operation ||= operation;
  return error;
}

module.exports = {
  GitError,
  LargeRepoError,
  normalizeGitOperationError,
  operationErrorCode,
};
