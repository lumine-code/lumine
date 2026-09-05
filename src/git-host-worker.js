// The git-host worker's child-process entry logic. Runs under
// ELECTRON_RUN_AS_NODE (loaded by git-host-bootstrap.js). Owns a single shared
// GitRunner (whose concurrency limiter bounds the real `git` spawns here, off
// the renderer thread) and an op dispatch table. Every request is tracked by id
// so an out-of-band `git:cancel` can abort the matching in-flight git child.

const GitRunner = require("./git-runner");
const createGitHostOps = require("./git-host-ops");
const {
  GIT_HOST_PROTOCOL_VERSION,
  GitHostMessageEvents,
  assertKnownOperation,
  serializeError,
} = require("./git-host-protocol");
const { nextReplyChunk, prepareReplyStream, streamManifest } = require("./git-host-stream");

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

async function replyResult(id, operation, result, state) {
  const plan = prepareReplyStream(operation, result);
  if (!plan) {
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
    process.send({ event: GitHostMessageEvents.REPLY_END, id });
  }
}

async function handleRequest({ id, op, payload }) {
  if (inflight.has(id)) {
    const error = new Error(`Duplicate git-host request id: ${id}`);
    error.code = "ERR_GIT_HOST_PROTOCOL";
    replyError(id, error);
    return;
  }
  let run;
  try {
    assertKnownOperation(op);
    run = ops[op];
  } catch (error) {
    replyError(id, error);
    return;
  }

  const state = { controller: new AbortController(), pendingAck: null };
  inflight.set(id, state);
  try {
    const result = await run(payload, { signal: state.controller.signal });
    if (state.controller.signal.aborted) return;
    await replyResult(id, op, result, state);
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
    if (inflight.get(id) === state) inflight.delete(id);
  }
}

process.on("message", (message) => {
  if (!message) return;
  if (message.event === GitHostMessageEvents.REQUEST) {
    handleRequest(message);
  } else if (message.event === GitHostMessageEvents.CANCEL) {
    const state = inflight.get(message.id);
    if (state) {
      state.controller.abort();
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
