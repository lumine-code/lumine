const GIT_HOST_PROTOCOL_VERSION = 1;

const GitBackend = Object.freeze({
  CLI: "cli",
  GIT_UTILS: "git-utils",
  HYBRID: "hybrid",
});

const BOTH_BACKENDS = Object.freeze([GitBackend.CLI, GitBackend.GIT_UTILS]);
const CLI_ONLY = Object.freeze([GitBackend.CLI]);
// This is the single registry of operations accepted by git-host. `backend`
// names the default owner; routed operations make their static choice from the
// request before any work starts. A selected backend is never replaced in a
// catch handler.
const GitHostOperations = Object.freeze({
  snapshot: Object.freeze({ backend: "routed", supportedBackends: BOTH_BACKENDS }),
  diff: Object.freeze({ backend: "routed", supportedBackends: BOTH_BACKENDS }),
  history: Object.freeze({ backend: GitBackend.GIT_UTILS, supportedBackends: BOTH_BACKENDS }),
  commit: Object.freeze({ backend: GitBackend.GIT_UTILS, supportedBackends: BOTH_BACKENDS }),
  logFollow: Object.freeze({ backend: GitBackend.CLI, supportedBackends: CLI_ONLY }),
  describe: Object.freeze({ backend: GitBackend.GIT_UTILS, supportedBackends: BOTH_BACKENDS }),
  branchesContaining: Object.freeze({
    backend: GitBackend.GIT_UTILS,
    supportedBackends: BOTH_BACKENDS,
  }),
  fileMode: Object.freeze({ backend: GitBackend.GIT_UTILS, supportedBackends: BOTH_BACKENDS }),
  submodulePaths: Object.freeze({
    backend: GitBackend.GIT_UTILS,
    supportedBackends: BOTH_BACKENDS,
  }),
  readObjects: Object.freeze({
    backend: GitBackend.GIT_UTILS,
    supportedBackends: BOTH_BACKENDS,
  }),
  blame: Object.freeze({ backend: GitBackend.GIT_UTILS, supportedBackends: BOTH_BACKENDS }),
  readConfig: Object.freeze({
    backend: GitBackend.GIT_UTILS,
    supportedBackends: BOTH_BACKENDS,
  }),
  lineDiff: Object.freeze({
    backend: GitBackend.CLI,
    supportedBackends: CLI_ONLY,
  }),
  exec: Object.freeze({ backend: GitBackend.CLI, supportedBackends: CLI_ONLY }),
});

// A complete reference policy used by conformance tests and by a future
// git-utils removal. Selecting it is a startup decision, not an error fallback.
const ALL_CLI_BACKEND_OVERRIDES = Object.freeze(
  Object.fromEntries(
    Object.keys(GitHostOperations).map((operation) => [operation, GitBackend.CLI]),
  ),
);

const SERIALIZED_ERROR_FIELDS = Object.freeze([
  "name",
  "code",
  "stack",
  "exitCode",
  "stderr",
  "stdout",
  "command",
  "gitError",
  "operation",
  "libgit2Code",
  "libgit2Class",
  "libgit2Message",
  "retriable",
  "maxBytes",
  "structuredBytes",
  "patchBytes",
  "backend",
  "backendCode",
]);

function usesCliWorktreeDiff(request) {
  const from = request?.from?.type;
  const to = request?.to?.type;
  return to === "worktree" && (from === "index" || from === "commit");
}

function backendForOperation(operation, payload = {}, { backendOverrides = {} } = {}) {
  const definition = GitHostOperations[operation];
  if (!definition) return null;
  const override = backendOverrides[operation];
  if (override != null) {
    if (!definition.supportedBackends.includes(override)) {
      const error = new Error(`Git backend ${override} does not implement ${operation}`);
      error.code = "ERR_GIT_BACKEND_CAPABILITY";
      error.operation = operation;
      error.backend = override;
      throw error;
    }
    return override;
  }
  if (definition.backend !== "routed") return definition.backend;

  if (operation === "snapshot") {
    const usesCliStatus = payload.request?.status !== false;
    if (!usesCliStatus) return GitBackend.GIT_UTILS;
    return payload.request?.refs === false ? GitBackend.CLI : GitBackend.HYBRID;
  }

  if (operation === "diff") {
    return usesCliWorktreeDiff(payload.request) ? GitBackend.CLI : GitBackend.GIT_UTILS;
  }

  return null;
}

function unknownOperationError(operation) {
  const error = new Error(`Unknown git-host op: ${operation}`);
  error.code = "ERR_GIT_HOST_UNKNOWN_OP";
  error.operation = operation;
  return error;
}

function assertKnownOperation(operation) {
  if (!Object.hasOwn(GitHostOperations, operation)) throw unknownOperationError(operation);
  return operation;
}

function serializeError(error) {
  if (!error) return { message: "Unknown git-host error" };
  const serialized = { message: error.message ?? String(error) };
  for (const field of SERIALIZED_ERROR_FIELDS) {
    if (error[field] === undefined) continue;
    if (field === "stderr" || field === "stdout") serialized[field] = String(error[field]);
    else serialized[field] = error[field];
  }
  if (error.cause) serialized.cause = serializeError(error.cause);
  return serialized;
}

function reviveError(serialized) {
  if (!serialized) return new Error("Unknown git-host error");
  const error = new Error(serialized.message ?? String(serialized));
  for (const field of SERIALIZED_ERROR_FIELDS) {
    if (serialized[field] !== undefined) error[field] = serialized[field];
  }
  if (serialized.cause) error.cause = reviveError(serialized.cause);
  return error;
}

module.exports = {
  ALL_CLI_BACKEND_OVERRIDES,
  GIT_HOST_PROTOCOL_VERSION,
  GitBackend,
  GitHostOperations,
  assertKnownOperation,
  backendForOperation,
  reviveError,
  serializeError,
  unknownOperationError,
  usesCliWorktreeDiff,
};
