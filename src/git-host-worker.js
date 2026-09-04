// The git-host worker's child-process entry logic. Runs under
// ELECTRON_RUN_AS_NODE (loaded by git-host-bootstrap.js). Owns a single shared
// GitRunner (whose concurrency limiter bounds the real `git` spawns here, off
// the renderer thread) and an op dispatch table. Every request is tracked by id
// so an out-of-band `git:cancel` can abort the matching in-flight git child.

const GitRunner = require("./git-runner");
const createGitHostOps = require("./git-host-ops");
const {
  GIT_HOST_PROTOCOL_VERSION,
  assertKnownOperation,
  serializeError,
} = require("./git-host-protocol");

// git.trustAllRepositories is passed in the fork environment; trust unless
// it was explicitly disabled ("0").
const runner = new GitRunner({ trustAllRepositories: process.env.LUMINE_GIT_TRUST_ALL !== "0" });
const ops = createGitHostOps(runner);

// id -> AbortController for the in-flight request, so git:cancel can abort it.
const inflight = new Map();

function reply(id, result) {
  // The renderer may have gone away while the request ran; sending on a
  // closed channel throws (or emits an uncaught `error`) instead of failing
  // quietly.
  if (process.connected) process.send({ event: "git:reply", id, result });
}

function replyError(id, error) {
  if (process.connected) process.send({ event: "git:reply", id, error: serializeError(error) });
}

async function handleRequest({ id, op, payload }) {
  let run;
  try {
    assertKnownOperation(op);
    run = ops[op];
  } catch (error) {
    replyError(id, error);
    return;
  }

  const controller = new AbortController();
  inflight.set(id, controller);
  try {
    const result = await run(payload, { signal: controller.signal });
    reply(id, result);
  } catch (error) {
    replyError(id, error);
  } finally {
    inflight.delete(id);
  }
}

process.on("message", (message) => {
  if (!message) return;
  if (message.event === "git:request") {
    handleRequest(message);
  } else if (message.event === "git:cancel") {
    inflight.get(message.id)?.abort();
  }
});

// Exit cleanly when the renderer goes away so no orphan worker lingers.
process.on("disconnect", () => process.exit(0));

process.send({
  event: "git:ready",
  protocolVersion: GIT_HOST_PROTOCOL_VERSION,
});
