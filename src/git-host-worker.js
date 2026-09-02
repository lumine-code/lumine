// The git-host worker's child-process entry logic. Runs under
// ELECTRON_RUN_AS_NODE (loaded by git-host-bootstrap.js). Owns a single shared
// GitRunner (whose concurrency limiter bounds the real `git` spawns here, off
// the renderer thread) and an op dispatch table. Every request is tracked by id
// so an out-of-band `git:cancel` can abort the matching in-flight git child.

const GitRunner = require("./git-runner");
const createGitHostOps = require("./git-host-ops");
const { configureNativeBackend, loadNativeBackend } = require("./git-native-backend");

// git.trustAllRepositories is passed in the fork environment; trust unless
// it was explicitly disabled ("0").
const runner = new GitRunner({ trustAllRepositories: process.env.LUMINE_GIT_TRUST_ALL !== "0" });
let ops = null;
let nativeVersions = null;
let initializationFailure = null;
try {
  const loaded = loadNativeBackend();
  configureNativeBackend(loaded, {
    trustAllRepositories: process.env.LUMINE_GIT_TRUST_ALL !== "0",
  });
  nativeVersions = loaded.versions;
  ops = createGitHostOps(runner, { nativeBackend: loaded.nativeBackend });
} catch (error) {
  initializationFailure = error;
}

// id -> AbortController for the in-flight request, so git:cancel can abort it.
const inflight = new Map();

function serializeError(error) {
  if (!error) return { message: "Unknown git-host error" };
  return {
    message: error.message ?? String(error),
    name: error.name,
    code: error.code,
    exitCode: error.exitCode,
    stderr: error.stderr != null ? String(error.stderr) : undefined,
    stdout: error.stdout != null ? String(error.stdout) : undefined,
    command: error.command,
    gitError: error.gitError,
    operation: error.operation,
    libgit2Code: error.libgit2Code,
    libgit2Class: error.libgit2Class,
    libgit2Message: error.libgit2Message,
    retriable: error.retriable,
    maxBytes: error.maxBytes,
    structuredBytes: error.structuredBytes,
    patchBytes: error.patchBytes,
  };
}

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
  if (initializationFailure) {
    replyError(id, initializationFailure);
    return;
  }
  const run = ops[op];
  if (!run) {
    const error = new Error(`Unknown git-host op: ${op}`);
    error.code = "ERR_GIT_HOST_UNKNOWN_OP";
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

// Signal readiness only after the native ABI/version gate has passed. A failed
// load is reported without exiting, so the renderer retains one stable,
// non-retriable initialization error instead of entering a fork/restart loop.
if (initializationFailure) {
  process.send({ event: "git:init-error", error: serializeError(initializationFailure) });
} else {
  process.send({ event: "git:ready", versions: nativeVersions });
}
