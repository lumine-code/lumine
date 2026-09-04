// The git-host worker's child-process entry logic. Runs under
// ELECTRON_RUN_AS_NODE (loaded by git-host-bootstrap.js). Owns a single shared
// GitRunner (whose concurrency limiter bounds the real `git` spawns here, off
// the renderer thread) and an op dispatch table. Every request is tracked by id
// so an out-of-band `git:cancel` can abort the matching in-flight git child.

const GitRunner = require("./git-runner");
const createGitHostOps = require("./git-host-ops");
const { createNativeBackendCapability } = require("./git-native-backend");
const {
  ALL_CLI_BACKEND_OVERRIDES,
  GIT_HOST_PROTOCOL_VERSION,
  assertKnownOperation,
  serializeError,
} = require("./git-host-protocol");

// git.trustAllRepositories is passed in the fork environment; trust unless
// it was explicitly disabled ("0").
const runner = new GitRunner({ trustAllRepositories: process.env.LUMINE_GIT_TRUST_ALL !== "0" });
const nativeCapability = createNativeBackendCapability({
  trustAllRepositories: process.env.LUMINE_GIT_TRUST_ALL !== "0",
});

function reportNativeStatus() {
  if (!process.connected) return;
  const status = nativeCapability.status();
  process.send({
    event: "git:backend-status",
    backend: "git-utils",
    state: status.state,
    versions: status.versions,
    error: status.error ? serializeError(status.error) : null,
  });
}

const ops = createGitHostOps(runner, {
  getNativeBackend: () => {
    try {
      return nativeCapability.get();
    } finally {
      reportNativeStatus();
    }
  },
  backendOverrides:
    process.env.LUMINE_TEST_GIT_BACKEND_POLICY === "cli" ? ALL_CLI_BACKEND_OVERRIDES : {},
});

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

// CLI is ready immediately. git-utils is initialized lazily only after the
// static router selects it, so an addon load/ABI failure cannot disable
// commands owned by system Git.
process.send({
  event: "git:ready",
  protocolVersion: GIT_HOST_PROTOCOL_VERSION,
  backends: {
    cli: { state: "ready" },
    "git-utils": { state: "uninitialized" },
  },
});
