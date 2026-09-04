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

// Native error codes are useful inside git-host, but packages consume the
// backend-neutral repository facade. Preserve the original code and backend as
// diagnostic metadata while exposing the same operation code regardless of
// which implementation was selected.
function operationErrorCode(operation) {
  const publicOperation = operation === "logFollow" ? "history" : operation;
  return `ERR_GIT_${String(publicOperation)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()}`;
}

function normalizeGitBackendError(error, { operation = null, backend = null } = {}) {
  if (!error || typeof error !== "object") return error;
  const originalCode = String(error.code || "");
  if (!backend && originalCode.startsWith("ERR_GIT_NATIVE_")) backend = "git-utils";
  if (backend) error.backend ||= backend;

  if (error.name === "AbortError" || originalCode === "ABORT_ERR") return error;

  if (!operation) {
    if (!originalCode.startsWith("ERR_GIT_NATIVE_")) return error;
    error.backendCode ||= originalCode;
    error.code = `ERR_GIT_${originalCode.slice("ERR_GIT_NATIVE_".length)}`;
    return error;
  }

  if (
    originalCode === "ERR_GIT_DIFF_TOO_LARGE" ||
    originalCode === "ERR_GIT_NATIVE_DIFF_TOO_LARGE" ||
    originalCode === "ERR_GIT_CREATE_BLOB" ||
    originalCode.startsWith("ERR_GIT_HOST_") ||
    originalCode === "ERR_GIT_BACKEND_CAPABILITY"
  ) {
    if (originalCode.startsWith("ERR_GIT_NATIVE_")) {
      error.backendCode ||= originalCode;
      error.code = `ERR_GIT_${originalCode.slice("ERR_GIT_NATIVE_".length)}`;
    }
    return error;
  }

  if (operation === "diff" && originalCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    error.backendCode ||= originalCode;
    error.code = "ERR_GIT_DIFF_TOO_LARGE";
    error.operation ||= "diff";
    return error;
  }

  const code = operationErrorCode(operation);
  if (originalCode && originalCode !== code) error.backendCode ||= originalCode;
  error.code = code;
  error.operation ||= operation === "logFollow" ? "history" : operation;
  return error;
}

module.exports = {
  GitError,
  LargeRepoError,
  normalizeGitBackendError,
  operationErrorCode,
};
