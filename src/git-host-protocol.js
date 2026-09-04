// Version 2 is the system-Git-only protocol. Version 1 advertised and routed
// multiple backends and must not be paired with this worker implementation.
const GIT_HOST_PROTOCOL_VERSION = 2;

// The single registry of operations accepted by git-host. Implementations live
// behind the worker boundary, so renderers and packages share one stable facade.
const GitHostOperations = Object.freeze({
  snapshot: true,
  diff: true,
  history: true,
  commit: true,
  logFollow: true,
  describe: true,
  branchesContaining: true,
  fileMode: true,
  submodulePaths: true,
  readObjects: true,
  blame: true,
  readConfig: true,
  lineDiff: true,
  exec: true,
});

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
  "retriable",
  "maxBytes",
  "structuredBytes",
  "patchBytes",
  "backend",
  "backendCode",
]);

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
  GIT_HOST_PROTOCOL_VERSION,
  GitHostOperations,
  assertKnownOperation,
  reviveError,
  serializeError,
  unknownOperationError,
};
