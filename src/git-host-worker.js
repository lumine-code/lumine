// The git-host worker's child-process entry logic. Runs under
// ELECTRON_RUN_AS_NODE (loaded by git-host-bootstrap.js). Owns a single shared
// GitRunner (whose concurrency limiter bounds the real `git` spawns here, off
// the renderer thread) and an op dispatch table. Every request is tracked by id
// so an out-of-band `git:cancel` can abort the matching in-flight git child.

const v8 = require("v8");
const GitRunner = require("./git-runner");
const createGitHostOps = require("./git-host-ops");
const { DEFER_REPOSITORY_READ_POSTFLIGHT } = require("./system-git-service");
const {
  GIT_HOST_PROTOCOL_VERSION,
  GitHostMessageEvents,
  assertKnownOperation,
  serializeError,
} = require("./git-host-protocol");
const {
  GIT_HOST_STREAM_MAX_BYTES,
  appendReplyChunk,
  chunkLength,
  initializeReplyStream,
  nextReplyChunk,
  prepareReplyStream,
  streamManifest,
  validateRequestStreamManifest,
} = require("./git-host-stream");
const { assertRepositoryDescriptorAvailableAsync } = require("./git-repository-descriptor");

const REPOSITORY_READS = new Set([
  "snapshot",
  "diff",
  "history",
  "commit",
  "describe",
  "branchesContaining",
  "fileMode",
  "submodulePaths",
  "readObjects",
  "blame",
  "readConfig",
]);

// git.trustAllRepositories is passed in the fork environment; trust unless
// it was explicitly disabled ("0").
const runner = new GitRunner({ trustAllRepositories: process.env.LUMINE_GIT_TRUST_ALL !== "0" });
const ops = createGitHostOps(runner);

// id -> request state for the in-flight request. Chunk acknowledgements live
// beside the AbortController so cancellation can release a worker that is
// waiting for renderer backpressure.
const inflight = new Map();

function abortError() {
  const error = new Error("The git operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function protocolError(detail, operation = undefined) {
  const error = new Error(`Invalid git-host streaming request: ${detail}`);
  error.code = "ERR_GIT_HOST_PROTOCOL";
  error.retriable = false;
  if (operation) error.operation = operation;
  return error;
}

// Across all repositories, allow only one large reply chunk to wait for an ACK
// at a time. Without this lane, five concurrent snapshots can each stay below
// the per-message budget while still arriving in one renderer turn.
let chunkLane = Promise.resolve();
async function withChunkLane(callback) {
  const previous = chunkLane;
  let release;
  chunkLane = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function reply(id, result) {
  // The renderer may have gone away while the request ran; sending on a
  // closed channel throws (or emits an uncaught `error`) instead of failing
  // quietly.
  if (process.connected) process.send({ event: GitHostMessageEvents.REPLY, id, result });
}

function replyError(id, error) {
  if (process.connected) {
    process.send({ event: GitHostMessageEvents.REPLY, id, error: serializeError(error) });
  }
}

function isRepositoryRead(operation, payload) {
  return (
    REPOSITORY_READS.has(operation) ||
    (operation === "execRepository" && payload.options?.repositoryRead === true)
  );
}

async function postvalidateRepositoryRead(operation, payload, state) {
  if (!isRepositoryRead(operation, payload)) return;
  await assertRepositoryDescriptorAvailableAsync(payload.descriptor, {
    operation,
    signal: state.controller.signal,
  });
}

function sendReplyChunk(id, sequence, stream, offset, items, state) {
  return withChunkLane(async () => {
    if (state.controller.signal.aborted) throw abortError();
    if (!process.connected) throw new Error("git-host renderer disconnected");

    const acknowledged = new Promise((resolve, reject) => {
      state.pendingAck = { sequence, resolve, reject };
    });
    try {
      process.send(
        { event: GitHostMessageEvents.REPLY_CHUNK, id, sequence, stream, offset, items },
        (error) => {
          if (error && state.pendingAck?.sequence === sequence) {
            const { reject } = state.pendingAck;
            state.pendingAck = null;
            reject(error);
          }
        },
      );
    } catch (error) {
      state.pendingAck = null;
      throw error;
    }
    await acknowledged;
  });
}

async function replyResult(id, operation, payload, result, state) {
  const plan = prepareReplyStream(operation, result);
  if (!plan) {
    await postvalidateRepositoryRead(operation, payload, state);
    reply(id, result);
    return;
  }

  if (state.controller.signal.aborted || !process.connected) return;
  process.send({
    event: GitHostMessageEvents.REPLY_START,
    id,
    result: plan.result,
    streams: plan.streams.map(streamManifest),
  });

  let sequence = 0;
  for (const stream of plan.streams) {
    for (let offset = 0; offset < stream.length;) {
      const chunk = nextReplyChunk(stream, offset);
      await sendReplyChunk(id, sequence++, stream.name, offset, chunk, state);
      offset += chunk.length;
    }
  }

  if (!state.controller.signal.aborted && process.connected) {
    await postvalidateRepositoryRead(operation, payload, state);
    process.send({ event: GitHostMessageEvents.REPLY_END, id });
  }
}

function createRequestState(op, payload, run, requestStream = null) {
  return {
    controller: new AbortController(),
    pendingAck: null,
    op,
    payload,
    run,
    requestStream,
  };
}

async function executeRequest(id, state) {
  const { op, payload, run } = state;
  try {
    const repositoryRead = isRepositoryRead(op, payload);
    const result = await run(payload, {
      signal: state.controller.signal,
      [DEFER_REPOSITORY_READ_POSTFLIGHT]: repositoryRead,
    });
    if (state.controller.signal.aborted) return;
    await replyResult(id, op, payload, result, state);
  } catch (error) {
    // The renderer has already rejected and forgotten an explicitly cancelled
    // request. Do not follow it with a late error/result reply.
    if (!state.controller.signal.aborted) {
      if (error && typeof error === "object") error.operation ||= op;
      replyError(id, error);
    }
  } finally {
    if (state.pendingAck) {
      state.pendingAck.reject(abortError());
      state.pendingAck = null;
    }
    state.requestStream = null;
    if (inflight.get(id) === state) inflight.delete(id);
  }
}

function operationForRequest(op) {
  assertKnownOperation(op);
  const run = ops[op];
  if (typeof run !== "function") throw protocolError(`operation ${op} has no implementation`, op);
  return run;
}

function rejectDuplicateRequest(id) {
  const existing = inflight.get(id);
  if (existing) {
    existing.controller.abort();
    existing.pendingAck?.reject(abortError());
    existing.pendingAck = null;
    existing.requestStream = null;
    inflight.delete(id);
  }
  const error = protocolError(`duplicate request id: ${id}`);
  replyError(id, error);
}

async function handleRequest({ id, op, payload }) {
  if (inflight.has(id)) {
    rejectDuplicateRequest(id);
    return;
  }
  let run;
  try {
    run = operationForRequest(op);
  } catch (error) {
    replyError(id, error);
    return;
  }

  const state = createRequestState(op, payload, run);
  inflight.set(id, state);
  await executeRequest(id, state);
}

function failRequestStream(id, state, detail) {
  if (inflight.get(id) !== state) return;
  state.controller.abort();
  state.requestStream = null;
  inflight.delete(id);
  replyError(id, detail instanceof Error ? detail : protocolError(detail, state.op));
}

function handleRequestStart({ id, op, payload, streams }) {
  if (typeof id !== "string" || id.length === 0) {
    replyError(id, protocolError("request-start has an invalid id", op));
    return;
  }
  if (inflight.has(id)) {
    rejectDuplicateRequest(id);
    return;
  }

  let run;
  try {
    run = operationForRequest(op);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw protocolError("request-start has an invalid payload", op);
    }
    if (!Array.isArray(streams) || streams.length === 0 || streams.length > 2) {
      throw protocolError("request-start has an invalid stream manifest", op);
    }

    const descriptors = new Map();
    const paths = new Set();
    let assembledPayload = payload;
    for (const descriptor of streams) {
      const pathKey = JSON.stringify(descriptor?.path);
      if (
        !validateRequestStreamManifest(op, descriptor) ||
        descriptors.has(descriptor.name) ||
        paths.has(pathKey)
      ) {
        throw protocolError("request-start has an invalid stream manifest", op);
      }
      const initialized = initializeReplyStream(assembledPayload, descriptor);
      if (!initialized.initialized) {
        throw protocolError(`request-start is missing the ${descriptor.name} target`, op);
      }
      assembledPayload = initialized.result;
      descriptors.set(descriptor.name, descriptor);
      paths.add(pathKey);
    }

    const requestStream = {
      descriptors,
      received: new Map([...descriptors.keys()].map((name) => [name, 0])),
      nextSequence: 0,
    };
    const state = createRequestState(op, assembledPayload, run, requestStream);
    inflight.set(id, state);
  } catch (error) {
    replyError(id, error?.code ? error : protocolError(error?.message || String(error), op));
  }
}

function handleRequestChunk(message) {
  const { id, sequence, stream: streamName, offset, items } = message;
  const state = inflight.get(id);
  if (!state?.requestStream || state.controller.signal.aborted) {
    if (state) failRequestStream(id, state, "received a request chunk outside a request stream");
    return;
  }
  const requestStream = state.requestStream;
  if (
    !Number.isSafeInteger(sequence) ||
    sequence !== requestStream.nextSequence ||
    !requestStream.descriptors.has(streamName) ||
    !Number.isSafeInteger(offset) ||
    !Object.hasOwn(message, "items")
  ) {
    failRequestStream(id, state, "received an invalid or out-of-order request chunk");
    return;
  }

  const descriptor = requestStream.descriptors.get(streamName);
  const itemCount = chunkLength(descriptor, items);
  const received = requestStream.received.get(streamName);
  let wireBytes;
  try {
    wireBytes = v8.serialize(items).byteLength;
  } catch {
    wireBytes = Number.POSITIVE_INFINITY;
  }
  if (
    itemCount <= 0 ||
    wireBytes > GIT_HOST_STREAM_MAX_BYTES ||
    offset !== received ||
    received + itemCount > descriptor.length
  ) {
    failRequestStream(id, state, "received a request chunk with invalid contents or offset");
    return;
  }

  try {
    state.payload = appendReplyChunk(state.payload, descriptor, offset, items);
  } catch (error) {
    failRequestStream(id, state, error);
    return;
  }
  requestStream.received.set(streamName, received + itemCount);
  requestStream.nextSequence++;
  if (process.connected) {
    process.send({ event: GitHostMessageEvents.REQUEST_CHUNK_ACK, id, sequence });
  }
}

function handleRequestEnd({ id }) {
  const state = inflight.get(id);
  if (!state?.requestStream || state.controller.signal.aborted) {
    if (state) failRequestStream(id, state, "received request-end outside a request stream");
    return;
  }
  for (const [name, descriptor] of state.requestStream.descriptors) {
    if (state.requestStream.received.get(name) !== descriptor.length) {
      failRequestStream(id, state, `request-end omitted content from ${name}`);
      return;
    }
  }
  state.requestStream = null;
  void executeRequest(id, state);
}

process.on("message", (message) => {
  if (!message) return;
  if (message.event === GitHostMessageEvents.REQUEST) {
    handleRequest(message);
  } else if (message.event === GitHostMessageEvents.REQUEST_START) {
    handleRequestStart(message);
  } else if (message.event === GitHostMessageEvents.REQUEST_CHUNK) {
    handleRequestChunk(message);
  } else if (message.event === GitHostMessageEvents.REQUEST_END) {
    handleRequestEnd(message);
  } else if (message.event === GitHostMessageEvents.CANCEL) {
    const state = inflight.get(message.id);
    if (state) {
      state.controller.abort();
      if (state.requestStream) {
        state.requestStream = null;
        inflight.delete(message.id);
      }
    }
  } else if (message.event === GitHostMessageEvents.CHUNK_ACK) {
    const state = inflight.get(message.id);
    if (state?.pendingAck?.sequence === message.sequence) {
      const { resolve } = state.pendingAck;
      state.pendingAck = null;
      resolve();
    }
  }
});

// Exit cleanly when the renderer goes away so no orphan worker lingers.
process.on("disconnect", () => process.exit(0));

process.send({
  event: GitHostMessageEvents.READY,
  protocolVersion: GIT_HOST_PROTOCOL_VERSION,
});
