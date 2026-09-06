const v8 = require("v8");

// Large advanced-serialization messages are decoded synchronously on the
// renderer's JavaScript thread. Chunks stay well below a 16 ms frame; the lower
// inline threshold also prevents several concurrent medium replies from
// arriving as an unpaced burst.
const GIT_HOST_STREAM_MAX_BYTES = 256 * 1024;
const GIT_HOST_STREAM_MAX_RECORDS = 1000;
const GIT_HOST_STREAM_INLINE_MAX_BYTES = 64 * 1024;
const GIT_HOST_STREAM_INLINE_MAX_RECORDS = 250;
const GIT_HOST_STREAM_MAX_STRING_BYTES = 16 * 1024 * 1024;
const GIT_HOST_REQUEST_STREAM_MAX_LENGTH = 128 * 1024 * 1024;

const StreamKind = Object.freeze({
  ARRAY: "array",
  BUFFER: "buffer",
  STRING: "string",
});

const SNAPSHOT_STREAMS = Object.freeze([
  ["status.files", ["status", "value", "files"]],
  ["status.submodulePaths", ["status", "value", "submodulePaths"]],
  ["refs.branches", ["refs", "value", "branches"]],
  ["refs.remoteBranches", ["refs", "value", "remoteBranches"]],
  ["refs.tags", ["refs", "value", "tags"]],
  ["refs.remotes", ["refs", "value", "remotes"]],
  ["refs.worktrees", ["refs", "value", "worktrees"]],
]);
const SNAPSHOT_REF_RECORD_STREAMS = new Set(["refs.branches", "refs.remoteBranches", "refs.tags"]);
const SNAPSHOT_COMMIT_STREAM_PATHS = Object.freeze([
  ["lastCommit", "subject"],
  ["lastCommit", "authorName"],
  ["lastCommit", "parents"],
]);

function serializedSize(value) {
  return v8.serialize(value).byteLength;
}

function scalarWireSize(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === "string") return Buffer.byteLength(value);
  return serializedSize(value);
}

function resultTooLargeError(bytes, maxBytes) {
  const error = new Error(`git-host result exceeded ${maxBytes} bytes for one renderer turn`);
  error.code = "ERR_GIT_HOST_RESULT_TOO_LARGE";
  error.maxBytes = maxBytes;
  error.resultBytes = bytes;
  return error;
}

function requestTooLargeError(length, maxLength) {
  const error = new Error(`git-host request stream exceeded ${maxLength} units`);
  error.code = "ERR_GIT_HOST_REQUEST_TOO_LARGE";
  error.maxBytes = maxLength;
  error.resultBytes = length;
  return error;
}

function streamKind(value) {
  if (Array.isArray(value)) return StreamKind.ARRAY;
  if (Buffer.isBuffer(value)) return StreamKind.BUFFER;
  if (typeof value === "string") return StreamKind.STRING;
  return null;
}

function isNonemptyStreamValue(value) {
  return streamKind(value) != null && value.length > 0;
}

function streamName(path) {
  return path.length === 0 ? "result" : `result.${path.join(".")}`;
}

function streamDescriptor(name, path, value) {
  const kind = streamKind(value);
  if (kind === StreamKind.STRING) {
    const bytes = scalarWireSize(value);
    if (bytes > GIT_HOST_STREAM_MAX_STRING_BYTES) {
      throw resultTooLargeError(bytes, GIT_HOST_STREAM_MAX_STRING_BYTES);
    }
  }
  return { name, path, kind, value, length: value.length };
}

function streamPlaceholder(kind) {
  if (kind === StreamKind.ARRAY) return [];
  if (kind === StreamKind.STRING) return "";
  return null;
}

function shouldStreamReply(result, streams) {
  if (streams.length === 0) return false;
  const recordCount = streams.reduce(
    (total, stream) => total + (stream.kind === StreamKind.ARRAY ? stream.length : 0),
    0,
  );
  if (recordCount > GIT_HOST_STREAM_INLINE_MAX_RECORDS) return true;
  if (
    streams.some(
      (stream) =>
        stream.kind !== StreamKind.ARRAY &&
        scalarWireSize(stream.value) > GIT_HOST_STREAM_INLINE_MAX_BYTES,
    )
  ) {
    return true;
  }
  return serializedSize(result) > GIT_HOST_STREAM_INLINE_MAX_BYTES;
}

function valueAtPath(result, path) {
  let value = result;
  for (const part of path) {
    if (value == null || !Object.hasOwn(value, part)) return { found: false, value: undefined };
    value = value[part];
  }
  return { found: true, value };
}

function replaceValueAtPath(result, path, value) {
  if (path.length === 0) return value;
  let owner = result;
  for (let index = 0; index < path.length - 1; index++) owner = owner[path[index]];
  owner[path[path.length - 1]] = value;
  return result;
}

function prepareSnapshotRecordMetadata(name, path, records, dependentStreams) {
  if (!SNAPSHOT_REF_RECORD_STREAMS.has(name) || !Array.isArray(records)) return records;
  return records.map((record, recordIndex) => {
    if (!record || typeof record !== "object") return record;
    let metadata = record;
    for (const fieldPath of SNAPSHOT_COMMIT_STREAM_PATHS) {
      const located = valueAtPath(record, fieldPath);
      if (!located.found || !isNonemptyStreamValue(located.value)) continue;
      const targetPath = [...path, recordIndex, ...fieldPath];
      const stream = streamDescriptor(
        `${name}.${recordIndex}.${fieldPath.join(".")}`,
        targetPath,
        located.value,
      );
      if (!shouldStreamReply(located.value, [stream])) continue;
      dependentStreams.push(stream);
      metadata = cloneWithValueAtPath(metadata, fieldPath, streamPlaceholder(stream.kind));
    }
    return metadata;
  });
}

function prepareSnapshotStream(result) {
  const streams = [];
  const dependentStreams = [];
  for (const [name, path] of SNAPSHOT_STREAMS) {
    const located = valueAtPath(result, path);
    const unchangedSection =
      path[0] === "status" ? result?.status?.unchanged : result?.refs?.unchanged;
    if (!unchangedSection && located.found && isNonemptyStreamValue(located.value)) {
      streams.push(
        streamDescriptor(
          name,
          path,
          prepareSnapshotRecordMetadata(name, path, located.value, dependentStreams),
        ),
      );
    }
  }
  const rootStreamCount = streams.length;
  streams.push(...dependentStreams);
  if (!shouldStreamReply(result, streams)) return null;

  const skeleton = { ...result };
  if (result?.status?.value) {
    skeleton.status = { ...result.status, value: { ...result.status.value } };
  }
  if (result?.refs?.value) {
    skeleton.refs = { ...result.refs, value: { ...result.refs.value } };
  }
  for (const stream of streams.slice(0, rootStreamCount)) {
    replaceValueAtPath(skeleton, stream.path, streamPlaceholder(stream.kind));
  }
  return { result: skeleton, streams };
}

// readObjects returns an array whose content field can contain a blob up to
// 256 MiB. Stream the metadata array first, with placeholders for large
// contents, then fill each content field without ever cloning the whole blob in
// one IPC message.
function prepareObjectReadStream(result) {
  if (!Array.isArray(result)) return null;
  const contentStreams = [];
  const metadata = result.map((object, index) => {
    const content = object?.content;
    if (
      !isNonemptyStreamValue(content) ||
      scalarWireSize(content) <= GIT_HOST_STREAM_INLINE_MAX_BYTES
    ) {
      return object;
    }
    const path = [index, "content"];
    const stream = streamDescriptor(streamName(path), path, content);
    contentStreams.push(stream);
    return { ...object, content: streamPlaceholder(stream.kind) };
  });
  if (contentStreams.length === 0) return null;

  const metadataStream = streamDescriptor("result", [], metadata);
  return { result: [], streams: [metadataStream, ...contentStreams] };
}

const RECORD_TEXT_PATHS = Object.freeze({
  history: Object.freeze([
    ["subject"],
    ["body"],
    ["author", "name"],
    ["author", "email"],
    ["committer", "name"],
    ["committer", "email"],
  ]),
  blame: Object.freeze([["summary"], ["author", "name"], ["author", "email"]]),
});

function cloneWithValueAtPath(source, path, value) {
  const clone = Array.isArray(source) ? [...source] : { ...source };
  let sourceOwner = source;
  let cloneOwner = clone;
  for (let index = 0; index < path.length - 1; index++) {
    sourceOwner = sourceOwner[path[index]];
    const childClone = Array.isArray(sourceOwner) ? [...sourceOwner] : { ...sourceOwner };
    cloneOwner[path[index]] = childClone;
    cloneOwner = childClone;
  }
  cloneOwner[path.at(-1)] = value;
  return clone;
}

// History and blame are top-level arrays, but one commit body/subject or blame
// summary can be larger than a whole IPC chunk. Send a metadata array with
// placeholders first, then fill only those exceptional strings. Ordinary
// records still use the single root-array stream and do not grow the manifest.
function prepareRecordTextStream(operation, result) {
  const textPaths = RECORD_TEXT_PATHS[operation];
  if (!textPaths || !Array.isArray(result)) return null;

  const textStreams = [];
  const metadata = result.map((record, recordIndex) => {
    if (!record || typeof record !== "object") return record;
    let recordMetadata = record;
    for (const fieldPath of textPaths) {
      const located = valueAtPath(record, fieldPath);
      if (
        !located.found ||
        typeof located.value !== "string" ||
        scalarWireSize(located.value) <= GIT_HOST_STREAM_INLINE_MAX_BYTES
      ) {
        continue;
      }
      const path = [recordIndex, ...fieldPath];
      textStreams.push(
        streamDescriptor(`${operation}.${recordIndex}.${fieldPath.join(".")}`, path, located.value),
      );
      recordMetadata = cloneWithValueAtPath(recordMetadata, fieldPath, "");
    }
    return recordMetadata;
  });
  if (textStreams.length === 0) return null;

  return {
    result: [],
    streams: [streamDescriptor("result", [], metadata), ...textStreams],
  };
}

// A structured diff can contain one file with megabytes of nested hunks and
// lines. Sending `files` as one array record would make that entire file
// indivisible, so transport the hierarchy breadth-first: file shells first,
// then hunk shells, then large line arrays and any large heading/line text.
// Each dependent target exists by the time its stream starts. rawPatch is an
// independent incremental string.
function prepareDiffStream(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.files)) return null;

  const streams = [];
  const lineStreams = [];
  const textStreams = [];
  const skeleton = { ...result, files: [] };
  if (result.files.length > 0) {
    const fileMetadata = result.files.map((file) => ({ ...file, hunks: [] }));
    streams.push(streamDescriptor("diff.files", ["files"], fileMetadata));

    for (let fileIndex = 0; fileIndex < result.files.length; fileIndex++) {
      const hunks = result.files[fileIndex].hunks;
      if (!Array.isArray(hunks) || hunks.length === 0) continue;
      const hunkPath = ["files", fileIndex, "hunks"];
      const hunkMetadata = hunks.map((hunk, hunkIndex) => {
        const metadata = { ...hunk };
        if (
          typeof hunk.heading === "string" &&
          scalarWireSize(hunk.heading) > GIT_HOST_STREAM_INLINE_MAX_BYTES
        ) {
          const headingPath = [...hunkPath, hunkIndex, "heading"];
          textStreams.push(
            streamDescriptor(
              `diff.files.${fileIndex}.hunks.${hunkIndex}.heading`,
              headingPath,
              hunk.heading,
            ),
          );
          metadata.heading = "";
        }

        const lines = hunk.lines;
        if (!Array.isArray(lines) || lines.length === 0) return metadata;
        const linePath = ["files", fileIndex, "hunks", hunkIndex, "lines"];
        const dependentTextStreams = [];
        const lineMetadata = lines.map((line, lineIndex) => {
          if (
            typeof line.text === "string" &&
            scalarWireSize(line.text) > GIT_HOST_STREAM_INLINE_MAX_BYTES
          ) {
            const textPath = [...linePath, lineIndex, "text"];
            dependentTextStreams.push(
              streamDescriptor(
                `diff.files.${fileIndex}.hunks.${hunkIndex}.lines.${lineIndex}.text`,
                textPath,
                line.text,
              ),
            );
            return { ...line, text: "" };
          }
          return line;
        });
        const lineStream = streamDescriptor(
          `diff.files.${fileIndex}.hunks.${hunkIndex}.lines`,
          linePath,
          lineMetadata,
        );
        if (dependentTextStreams.length > 0 || shouldStreamReply(lineMetadata, [lineStream])) {
          metadata.lines = [];
          lineStreams.push(lineStream);
          textStreams.push(...dependentTextStreams);
        } else {
          metadata.lines = lineMetadata;
        }
        return metadata;
      });
      streams.push(streamDescriptor(`diff.files.${fileIndex}.hunks`, hunkPath, hunkMetadata));
    }
    streams.push(...lineStreams, ...textStreams);
  }

  if (typeof result.rawPatch === "string" && result.rawPatch.length > 0) {
    const rawPatch = streamDescriptor("diff.rawPatch", ["rawPatch"], result.rawPatch);
    streams.push(rawPatch);
    skeleton.rawPatch = streamPlaceholder(rawPatch.kind);
  }

  return shouldStreamReply(result, streams) ? { result: skeleton, streams } : null;
}

function prepareGenericStream(result) {
  if (isNonemptyStreamValue(result)) {
    const stream = streamDescriptor("result", [], result);
    return shouldStreamReply(result, [stream])
      ? { result: streamPlaceholder(stream.kind), streams: [stream] }
      : null;
  }
  if (!result || typeof result !== "object") return null;

  const streams = [];
  for (const [property, value] of Object.entries(result)) {
    if (isNonemptyStreamValue(value)) {
      streams.push(streamDescriptor(streamName([property]), [property], value));
    }
  }
  if (!shouldStreamReply(result, streams)) return null;

  const skeleton = { ...result };
  for (const stream of streams) skeleton[stream.path[0]] = streamPlaceholder(stream.kind);
  return { result: skeleton, streams };
}

function validateReplyPlan(plan) {
  if (!plan) return null;
  const startMessage = {
    event: "git:reply-start",
    id: "0000000000",
    result: plan.result,
    streams: plan.streams.map(streamManifest),
  };
  const bytes = serializedSize(startMessage);
  if (bytes > GIT_HOST_STREAM_INLINE_MAX_BYTES) {
    throw resultTooLargeError(bytes, GIT_HOST_STREAM_INLINE_MAX_BYTES);
  }
  return plan;
}

function prepareReplyStream(operation, result) {
  let plan = null;
  if (operation === "snapshot") plan = prepareSnapshotStream(result);
  if (!plan && (operation === "history" || operation === "blame")) {
    plan = prepareRecordTextStream(operation, result);
  }
  if (operation === "diff") {
    plan = prepareDiffStream(result);
  }
  if (!plan && operation === "readObjects") {
    plan = prepareObjectReadStream(result);
  }
  if (!plan) plan = prepareGenericStream(result);
  return validateReplyPlan(plan);
}

const REQUEST_STREAM_PATHS = Object.freeze({
  lineDiff: Object.freeze([["text"]]),
  exec: Object.freeze([["options", "stdin"]]),
  execRepository: Object.freeze([["options", "stdin"]]),
  writeRepositoryCommandOutput: Object.freeze([["options", "stdin"]]),
});

function requestStreamName(operation, path) {
  return `${operation}.${path.join(".")}`;
}

function shouldStreamRequestValue(value) {
  if (Buffer.isBuffer(value)) return value.length > GIT_HOST_STREAM_INLINE_MAX_BYTES;
  if (typeof value !== "string") return false;
  // Avoid scanning a many-megabyte string with Buffer.byteLength on the
  // renderer. UTF-16 structured clone can charge two bytes per code unit, so
  // only measure strings that are already too short to threaten a frame.
  if (value.length > Math.floor(GIT_HOST_STREAM_INLINE_MAX_BYTES / 2)) return true;
  return serializedSize(value) > GIT_HOST_STREAM_INLINE_MAX_BYTES;
}

function requestStreamDescriptor(operation, path, value) {
  const kind = streamKind(value);
  if (kind !== StreamKind.STRING && kind !== StreamKind.BUFFER) return null;
  if (value.length > GIT_HOST_REQUEST_STREAM_MAX_LENGTH) {
    throw requestTooLargeError(value.length, GIT_HOST_REQUEST_STREAM_MAX_LENGTH);
  }
  return {
    name: requestStreamName(operation, path),
    path,
    kind,
    value,
    length: value.length,
  };
}

function prepareRequestStream(operation, payload) {
  if (!payload || typeof payload !== "object") return null;
  const paths = REQUEST_STREAM_PATHS[operation];
  if (!paths) return null;

  let skeleton = payload;
  const streams = [];
  for (const path of paths) {
    const located = valueAtPath(payload, path);
    if (!located.found || !shouldStreamRequestValue(located.value)) continue;
    const stream = requestStreamDescriptor(operation, path, located.value);
    if (!stream) continue;
    streams.push(stream);
    skeleton = cloneWithValueAtPath(skeleton, path, streamPlaceholder(stream.kind));
  }
  if (streams.length === 0) return null;

  const plan = { payload: skeleton, streams };
  const startMessage = {
    event: "git:request-start",
    id: "0000000000",
    op: operation,
    payload: plan.payload,
    streams: plan.streams.map(streamManifest),
  };
  const bytes = serializedSize(startMessage);
  if (bytes > GIT_HOST_STREAM_INLINE_MAX_BYTES) {
    throw requestTooLargeError(bytes, GIT_HOST_STREAM_INLINE_MAX_BYTES);
  }
  return plan;
}

function validateRequestStreamManifest(operation, descriptor) {
  if (!validateStreamManifest(descriptor)) return false;
  if (descriptor.kind !== StreamKind.STRING && descriptor.kind !== StreamKind.BUFFER) return false;
  if (descriptor.length > GIT_HOST_REQUEST_STREAM_MAX_LENGTH) return false;
  const paths = REQUEST_STREAM_PATHS[operation];
  if (!paths) return false;
  return paths.some(
    (path) =>
      descriptor.name === requestStreamName(operation, path) &&
      path.length === descriptor.path.length &&
      path.every((part, index) => part === descriptor.path[index]),
  );
}

function streamManifest(stream) {
  return {
    name: stream.name,
    path: stream.path,
    kind: stream.kind,
    length: stream.length,
  };
}

// v8's wire size is the closest local approximation to advanced IPC
// serialization. Halving oversized candidates avoids a per-record serialize
// pass. One unusually large array record cannot be split and travels alone;
// byte and string streams are always splittable.
function nextReplyChunk(stream, offset) {
  if (stream.kind === StreamKind.BUFFER) {
    return stream.value.subarray(
      offset,
      Math.min(stream.value.length, offset + GIT_HOST_STREAM_MAX_BYTES - 1024),
    );
  }

  let count =
    stream.kind === StreamKind.ARRAY
      ? Math.min(GIT_HOST_STREAM_MAX_RECORDS, stream.value.length - offset)
      : Math.min(Math.floor(GIT_HOST_STREAM_MAX_BYTES / 2), stream.value.length - offset);
  let chunk = stream.value.slice(offset, offset + count);
  let bytes = serializedSize(chunk);
  while (
    (stream.kind !== StreamKind.ARRAY || chunk.length > 1) &&
    bytes > GIT_HOST_STREAM_MAX_BYTES
  ) {
    count = Math.max(1, Math.floor(count / 2));
    chunk = stream.value.slice(offset, offset + count);
    bytes = serializedSize(chunk);
  }
  if (bytes > GIT_HOST_STREAM_MAX_BYTES) {
    throw resultTooLargeError(bytes, GIT_HOST_STREAM_MAX_BYTES);
  }
  return chunk;
}

function validStreamPath(path) {
  return (
    Array.isArray(path) &&
    path.every(
      (part) =>
        (typeof part === "string" &&
          part !== "__proto__" &&
          part !== "prototype" &&
          part !== "constructor") ||
        (Number.isSafeInteger(part) && part >= 0),
    )
  );
}

function validateStreamManifest(descriptor) {
  return Boolean(
    descriptor &&
    typeof descriptor.name === "string" &&
    descriptor.name.length > 0 &&
    validStreamPath(descriptor.path) &&
    Object.values(StreamKind).includes(descriptor.kind) &&
    Number.isSafeInteger(descriptor.length) &&
    descriptor.length > 0,
  );
}

// Initialize immediately when the skeleton already contains the target. A
// nested readObjects content path appears only after its metadata-array stream,
// so callers retry initialization when that stream's first chunk arrives.
function initializeReplyStream(result, descriptor) {
  const located = valueAtPath(result, descriptor.path);
  if (!located.found) return { initialized: false, result };
  const expectedPlaceholder = streamPlaceholder(descriptor.kind);
  const validPlaceholder =
    descriptor.kind === StreamKind.ARRAY
      ? Array.isArray(located.value) && located.value.length === 0
      : located.value === expectedPlaceholder;
  if (!validPlaceholder) {
    throw new Error(`git-host stream target ${descriptor.name} is not an empty placeholder`);
  }
  const initializedValue =
    descriptor.kind === StreamKind.BUFFER
      ? Buffer.allocUnsafe(descriptor.length)
      : expectedPlaceholder;
  return {
    initialized: true,
    result: replaceValueAtPath(result, descriptor.path, initializedValue),
  };
}

function appendReplyChunk(result, descriptor, offset, chunk) {
  const located = valueAtPath(result, descriptor.path);
  if (!located.found) throw new Error(`git-host stream target ${descriptor.name} is missing`);
  if (descriptor.kind === StreamKind.ARRAY) {
    if (!Array.isArray(located.value) || !Array.isArray(chunk)) {
      throw new Error(`git-host stream ${descriptor.name} has an invalid array chunk`);
    }
    located.value.push(...chunk);
    return result;
  }
  if (descriptor.kind === StreamKind.BUFFER) {
    if (!Buffer.isBuffer(located.value) || !Buffer.isBuffer(chunk)) {
      throw new Error(`git-host stream ${descriptor.name} has an invalid buffer chunk`);
    }
    chunk.copy(located.value, offset);
    return result;
  }
  if (typeof located.value !== "string" || typeof chunk !== "string") {
    throw new Error(`git-host stream ${descriptor.name} has an invalid string chunk`);
  }
  return replaceValueAtPath(result, descriptor.path, located.value + chunk);
}

function chunkLength(descriptor, chunk) {
  if (descriptor.kind === StreamKind.ARRAY) return Array.isArray(chunk) ? chunk.length : -1;
  if (descriptor.kind === StreamKind.BUFFER) return Buffer.isBuffer(chunk) ? chunk.length : -1;
  return typeof chunk === "string" ? chunk.length : -1;
}

module.exports = {
  GIT_HOST_REQUEST_STREAM_MAX_LENGTH,
  GIT_HOST_STREAM_INLINE_MAX_BYTES,
  GIT_HOST_STREAM_INLINE_MAX_RECORDS,
  GIT_HOST_STREAM_MAX_BYTES,
  GIT_HOST_STREAM_MAX_RECORDS,
  GIT_HOST_STREAM_MAX_STRING_BYTES,
  StreamKind,
  appendReplyChunk,
  chunkLength,
  initializeReplyStream,
  nextReplyChunk,
  prepareRequestStream,
  prepareDiffStream,
  prepareReplyStream,
  prepareSnapshotStream,
  streamManifest,
  validateRequestStreamManifest,
  validateStreamManifest,
};
