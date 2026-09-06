const GIT_HOST_PROTOCOL_VERSION = 1;
const GIT_HOST_ERROR_TEXT_MAX_BYTES = 64 * 1024;
const GIT_HOST_ERROR_TOTAL_MAX_BYTES = 64 * 1024;
const GIT_HOST_ERROR_MAX_CAUSE_DEPTH = 4;
const GIT_HOST_ERROR_STRUCTURE_RESERVE_BYTES = 8 * 1024;
const GIT_HOST_ERROR_FIELD_MAX_BYTES = 16 * 1024;
const TRUNCATED_ERROR_TEXT_SUFFIX = "\n… [truncated by git-host]";

// Message names are part of the internal v1 wire contract. Large requests and
// replies use START -> (CHUNK -> ACK)* -> END; ordinary values use REQUEST or
// REPLY. The two ACK events stay directional so simultaneous input and output
// streams for one request cannot release each other's backpressure.
const GitHostMessageEvents = Object.freeze({
  READY: "git:ready",
  REQUEST: "git:request",
  REQUEST_START: "git:request-start",
  REQUEST_CHUNK: "git:request-chunk",
  REQUEST_CHUNK_ACK: "git:request-chunk-ack",
  REQUEST_END: "git:request-end",
  CANCEL: "git:cancel",
  REPLY: "git:reply",
  REPLY_START: "git:reply-start",
  REPLY_CHUNK: "git:reply-chunk",
  CHUNK_ACK: "git:chunk-ack",
  REPLY_END: "git:reply-end",
});

// The single registry of operations accepted by git-host. Implementations live
// behind the worker boundary, so renderers and packages share one stable facade.
const GitHostOperations = Object.freeze({
  snapshot: true,
  diff: true,
  history: true,
  commit: true,
  describe: true,
  branchesContaining: true,
  fileMode: true,
  submodulePaths: true,
  readObjects: true,
  blame: true,
  readConfig: true,
  lineDiff: true,
  exec: true,
  execRepository: true,
  writeRepositoryCommandOutput: true,
});

const SERIALIZED_ERROR_FIELDS = Object.freeze([
  "name",
  "code",
  "command",
  "operation",
  "gitCode",
  "reason",
  "gitDirectory",
  "workingDirectory",
  "exitCode",
  "retriable",
  "maxBytes",
  "resultBytes",
  "structuredBytes",
  "patchBytes",
  "stack",
  "stderr",
  "stdout",
  "messageTruncated",
  "stackTruncated",
  "stderrTruncated",
  "stdoutTruncated",
  "causeTruncated",
  "nameTruncated",
  "codeTruncated",
  "commandTruncated",
  "operationTruncated",
  "gitCodeTruncated",
  "reasonTruncated",
  "gitDirectoryTruncated",
  "workingDirectoryTruncated",
]);

const SERIALIZED_ERROR_TEXT_FIELDS = new Set([
  "name",
  "code",
  "stack",
  "stderr",
  "stdout",
  "command",
  "operation",
  "gitCode",
  "reason",
  "gitDirectory",
  "workingDirectory",
]);

function boundedErrorText(value, maxBytes = GIT_HOST_ERROR_TEXT_MAX_BYTES) {
  let text;
  try {
    text = String(value);
  } catch {
    text = "[unprintable error detail]";
  }
  if (serializedTextCost(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const suffixBytes = serializedTextCost(TRUNCATED_ERROR_TEXT_SUFFIX);
  if (maxBytes <= suffixBytes) return { text: "", truncated: true };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedTextCost(text.slice(0, middle)) + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }

  // Avoid ending the preserved prefix halfway through a surrogate pair.
  if (/^[\uD800-\uDBFF]$/.test(text[low - 1]) && /^[\uDC00-\uDFFF]$/.test(text[low])) low--;
  const prefix = text.slice(0, low);
  return { text: prefix + TRUNCATED_ERROR_TEXT_SUFFIX, truncated: true };
}

// V8 may store strings as either one-byte or two-byte sequences. Charging the
// larger of UTF-8 size and two bytes per UTF-16 code unit is conservative for
// both encodings and prevents the structured-clone payload from exceeding the
// shared error budget.
function serializedTextCost(text) {
  return Math.max(Buffer.byteLength(text), text.length * 2);
}

function takeErrorText(value, state) {
  const maxBytes = Math.min(GIT_HOST_ERROR_FIELD_MAX_BYTES, Math.max(0, state.remainingBytes));
  const bounded = boundedErrorText(value, maxBytes);
  state.remainingBytes = Math.max(0, state.remainingBytes - serializedTextCost(bounded.text));
  return bounded;
}

function readErrorField(error, field) {
  try {
    return error[field];
  } catch {
    return undefined;
  }
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

function serializeError(error, state = null, depth = 0) {
  if (!error) return { message: "Unknown git-host error" };
  state ||= {
    remainingBytes: GIT_HOST_ERROR_TOTAL_MAX_BYTES - GIT_HOST_ERROR_STRUCTURE_RESERVE_BYTES,
    seen: new WeakSet(),
  };
  if (depth >= GIT_HOST_ERROR_MAX_CAUSE_DEPTH) {
    const message = takeErrorText("Error cause chain truncated", state);
    return { message: message.text, causeTruncated: true };
  }
  if (typeof error === "object" || typeof error === "function") {
    if (state.seen.has(error)) {
      const message = takeErrorText("Circular error cause omitted", state);
      return { message: message.text, causeTruncated: true };
    }
    state.seen.add(error);
  }

  const errorMessage = readErrorField(error, "message");
  const message = takeErrorText(errorMessage ?? String(error), state);
  const serialized = { message: message.text };
  if (message.truncated) serialized.messageTruncated = true;
  for (const field of SERIALIZED_ERROR_FIELDS) {
    const value = readErrorField(error, field);
    if (value === undefined) continue;
    if (value === null) {
      serialized[field] = null;
      continue;
    }
    if (SERIALIZED_ERROR_TEXT_FIELDS.has(field)) {
      const bounded = takeErrorText(value, state);
      serialized[field] = bounded.text;
      if (bounded.truncated) serialized[`${field}Truncated`] = true;
    } else if (field.endsWith("Truncated")) {
      if (value === true && serialized[field] === undefined) serialized[field] = true;
    } else if (value === null || typeof value === "number" || typeof value === "boolean") {
      serialized[field] = value;
    }
  }
  const cause = readErrorField(error, "cause");
  if (cause) serialized.cause = serializeError(cause, state, depth + 1);
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
  GIT_HOST_ERROR_MAX_CAUSE_DEPTH,
  GIT_HOST_ERROR_TEXT_MAX_BYTES,
  GIT_HOST_ERROR_TOTAL_MAX_BYTES,
  GIT_HOST_PROTOCOL_VERSION,
  GitHostMessageEvents,
  GitHostOperations,
  assertKnownOperation,
  reviveError,
  serializeError,
};
