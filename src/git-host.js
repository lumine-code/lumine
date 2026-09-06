const ChildProcess = require("child_process");
const {
  GIT_HOST_PROTOCOL_VERSION,
  GitHostMessageEvents,
  assertKnownOperation,
  reviveError,
} = require("./git-host-protocol");
const {
  appendReplyChunk,
  chunkLength,
  initializeReplyStream,
  nextReplyChunk,
  prepareRequestStream,
  streamManifest,
  validateStreamManifest,
} = require("./git-host-stream");
const { normalizeGitOperationError } = require("./git-error");

// Renderer-side transport for the git-host worker: one long-lived forked process
// per window that runs every Git `git` command and its output off the
// renderer main thread, VS Code-extension-host style. Requests are correlated by
// id to their replies; an AbortSignal is translated into an out-of-band cancel;
// a worker crash rejects all pending requests with a retriable error and the
// next request lazily re-forks.
//
// Modeled on the WorkerProcessWatcher pattern in path-watcher.js, improved with
// crash-restart and true cancellation.

function abortError() {
  const error = new Error("The git operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function restartError() {
  const error = new Error("git-host worker exited before the request completed");
  error.code = "ERR_GIT_HOST_RESTART";
  error.retriable = true;
  return error;
}

function protocolError(detail, operation = null) {
  const error = new Error(`Invalid git-host streaming reply: ${detail}`);
  error.code = "ERR_GIT_HOST_PROTOCOL";
  error.retriable = false;
  if (operation) error.operation = operation;
  return error;
}

// Once the window is unloading nothing can act on a settled request: the
// renderer context is being torn down and the environment has already dropped
// the registries its consumers read from, so settling only surfaces as an
// "Uncaught (in promise)" on the way out. Requests are abandoned instead, the
// same way Task and WatcherTask silently do nothing once this flag is set.
function isUnloading() {
  return Boolean(globalThis.window?.lumine?.unloading);
}

// A request that can no longer be answered because the window is going away.
function abandonedRequest() {
  return new Promise(() => {});
}

// Rebuild a real Error from the fields the worker serialized, preserving the
// `code`/`exitCode`/`stderr` that callers branch on (e.g. GitRepository.getDiff
// maps ERR_CHILD_PROCESS_STDIO_MAXBUFFER -> ERR_GIT_DIFF_TOO_LARGE).
let singleton = null;

// null = auto (fork in production, run in-process under specs so package tests
// do not spawn a worker per test); true/false force the mode. The dedicated
// git-host transport specs set this to true to exercise the forked path.
let forkModeOverride = null;

// Test seam: replaces ChildProcess.fork so the transport (correlation, crash,
// cancel) can be driven deterministically with a fake child.
let childFactoryOverride = null;

class GitHost {
  // Per-window singleton. GitHostClient always goes through here so every
  // repository shares one worker.
  static instance() {
    if (!singleton) singleton = new GitHost();
    return singleton;
  }

  // Tear down and drop the singleton. Used on window unload and by specs.
  static reset() {
    if (singleton) {
      singleton.terminate();
      singleton = null;
    }
  }

  // Test hook: force forking (true) or in-process execution (false); null
  // restores automatic selection.
  static setForkModeForTesting(mode) {
    forkModeOverride = mode;
  }

  // Test hook: inject a fake child factory `(bootstrapPath, argv, options) =>
  // child`; null restores ChildProcess.fork.
  static setChildFactoryForTesting(factory) {
    childFactoryOverride = factory;
  }

  constructor() {
    this.child = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.pending = new Map(); // id -> { resolve, reject, signal, onAbort }
    this.nextId = 0;
    this.inProcessOps = null; // op table when running without a forked worker
    this.fatalError = null;
    this.requestChunkLane = Promise.resolve();
  }

  shouldFork() {
    if (forkModeOverride !== null) return forkModeOverride;
    // Run in-process under the spec harness; fork in a real window.
    return !globalThis.lumine?.window?.isSpecMode?.();
  }

  // Whether to trust repositories owned by another user account
  // (`git.trustAllRepositories`, default true). Passed to the worker via
  // its fork environment and used directly by the in-process runner.
  trustAllRepositories() {
    const value = globalThis.lumine?.config?.get?.("git.trustAllRepositories");
    return value !== false;
  }

  // The configured git binary path (`git.path`), passed to the worker so
  // its runner resolves the same git the renderer would.
  gitPath() {
    return globalThis.lumine?.config?.get?.("git.path") || "";
  }

  childEnv() {
    const compileCachePath = require("./compile-cache").getCacheDirectory();
    return Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      LUMINE_COMPILE_CACHE_PATH: compileCachePath,
      LUMINE_GIT_TRUST_ALL: this.trustAllRepositories() ? "1" : "0",
      LUMINE_GIT_PATH: this.gitPath(),
    });
  }

  ensureStarted() {
    if (this.readyPromise) return this.readyPromise;

    if (!this.shouldFork()) {
      try {
        const GitRunner = require("./git-runner");
        const createGitHostOps = require("./git-host-ops");
        this.inProcessOps = createGitHostOps(
          new GitRunner({ trustAllRepositories: this.trustAllRepositories() }),
        );
        this.readyPromise = Promise.resolve();
      } catch (error) {
        this.fatalError = error;
        this.readyPromise = Promise.reject(error);
      }
      return this.readyPromise;
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;

      const fork = childFactoryOverride || ((p, argv, opts) => ChildProcess.fork(p, argv, opts));
      const child = fork(require.resolve("./git-host-bootstrap"), ["--no-deprecation"], {
        env: this.childEnv(),
        silent: true,
        windowsHide: true,
        serialization: "advanced",
      });
      this.child = child;

      child.on("message", (message) => this.handleMessage(message, child));
      child.on("exit", () => this.handleExit(child));
      child.on("error", () => this.handleExit(child, { kill: true }));
      child.stdout?.on("data", (data) => console.log(String(data)));
      child.stderr?.on("data", (data) => console.error(String(data)));
    });

    return this.readyPromise;
  }

  handleMessage(message, sourceChild = this.child) {
    if (!message || sourceChild !== this.child) return;
    switch (message.event) {
      case GitHostMessageEvents.READY:
        if (message.protocolVersion !== GIT_HOST_PROTOCOL_VERSION) {
          const error = new Error(
            `git-host protocol mismatch: expected ${GIT_HOST_PROTOCOL_VERSION}, received ${message.protocolVersion ?? "unknown"}`,
          );
          error.code = "ERR_GIT_HOST_PROTOCOL";
          error.retriable = false;
          this.fatalError = error;
          this.rejectReady?.(error);
          this.resolveReady = null;
          this.rejectReady = null;
          this.handleExit(sourceChild, { kill: true });
          return;
        }
        this.resolveReady?.();
        this.resolveReady = null;
        this.rejectReady = null;
        return;
      case GitHostMessageEvents.REPLY: {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        if (entry.outboundStream) {
          if (!message.error) {
            this.failOutboundRequest(
              message.id,
              entry,
              "received a reply before request streaming completed",
            );
            return;
          }
          this.clearOutboundStream(entry);
        }
        if (entry.stream && !message.error) {
          this.failStreamingReply(message.id, entry, "received a full reply after reply-start");
          return;
        }
        this.pending.delete(message.id);
        this.detachAbort(entry);
        entry.stream = null;
        if (message.error) entry.reject(normalizeGitOperationError(reviveError(message.error)));
        else entry.resolve(message.result);
        return;
      }
      case GitHostMessageEvents.REPLY_START:
        this.startStreamingReply(message);
        return;
      case GitHostMessageEvents.REPLY_CHUNK:
        this.appendStreamingReply(message, sourceChild);
        return;
      case GitHostMessageEvents.REPLY_END:
        this.finishStreamingReply(message);
        return;
      case GitHostMessageEvents.REQUEST_CHUNK_ACK:
        this.acknowledgeRequestChunk(message, sourceChild);
        return;
      case "console:log":
        console.log(...(message.args || []));
        return;
      case "console:warn":
        console.warn(...(message.args || []));
        return;
      case "console:error":
        console.error(...(message.args || []));
        return;
    }
  }

  startStreamingReply(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (entry.outboundStream) {
      this.failOutboundRequest(
        message.id,
        entry,
        "received reply-start before request streaming completed",
      );
      return;
    }
    if (entry.stream) {
      this.failStreamingReply(message.id, entry, "received duplicate reply-start");
      return;
    }
    if (
      !Object.hasOwn(message, "result") ||
      !Array.isArray(message.streams) ||
      message.streams.length === 0
    ) {
      this.failStreamingReply(message.id, entry, "reply-start has no stream manifest");
      return;
    }

    const descriptors = new Map();
    const paths = new Set();
    const arrayPaths = new Set();
    let result = message.result;
    try {
      for (const descriptor of message.streams) {
        const pathKey = JSON.stringify(descriptor?.path);
        if (
          !validateStreamManifest(descriptor) ||
          descriptors.has(descriptor.name) ||
          paths.has(pathKey)
        ) {
          throw protocolError("reply-start has an invalid stream manifest");
        }
        const initialized = initializeReplyStream(result, descriptor);
        result = initialized.result;
        if (!initialized.initialized) {
          let hasArrayParent = false;
          for (let length = descriptor.path.length - 1; length >= 0; length--) {
            if (arrayPaths.has(JSON.stringify(descriptor.path.slice(0, length)))) {
              hasArrayParent = true;
              break;
            }
          }
          if (!hasArrayParent) {
            throw protocolError(`reply-start is missing the ${descriptor.name} target`);
          }
        }
        descriptors.set(descriptor.name, { ...descriptor, initialized: initialized.initialized });
        paths.add(pathKey);
        if (descriptor.kind === "array") arrayPaths.add(pathKey);
      }
    } catch (error) {
      this.failStreamingReply(message.id, entry, error);
      return;
    }

    entry.stream = {
      result,
      descriptors,
      received: new Map([...descriptors.keys()].map((name) => [name, 0])),
      nextSequence: 0,
      awaitingAck: false,
      completionScheduled: false,
    };
  }

  appendStreamingReply(message, sourceChild = this.child) {
    const id = message.id;
    const sequence = message.sequence;
    // Do not ACK from the IPC callback's microtask checkpoint. One full event
    // loop turn between chunks lets Chromium render and bounds deserialization
    // plus collection assembly to one small batch per turn.
    if (Number.isSafeInteger(sequence)) {
      this.scheduleChunkAck(sourceChild, id, sequence, () => {
        const activeStream = this.pending.get(id)?.stream;
        if (activeStream?.nextSequence === sequence + 1) activeStream.awaitingAck = false;
      });
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    const stream = entry.stream;
    if (!stream) {
      this.failStreamingReply(message.id, entry, "received a chunk before reply-start");
      return;
    }
    if (stream.completionScheduled || stream.awaitingAck) {
      this.failStreamingReply(
        message.id,
        entry,
        "received a chunk before acknowledging its predecessor",
      );
      return;
    }
    if (
      !Number.isSafeInteger(message.sequence) ||
      message.sequence !== stream.nextSequence ||
      !stream.descriptors.has(message.stream) ||
      !Number.isSafeInteger(message.offset) ||
      !Object.hasOwn(message, "items")
    ) {
      this.failStreamingReply(message.id, entry, "received an invalid or out-of-order chunk");
      return;
    }

    const descriptor = stream.descriptors.get(message.stream);
    const itemCount = chunkLength(descriptor, message.items);
    if (itemCount <= 0) {
      this.failStreamingReply(message.id, entry, "received a chunk with invalid contents");
      return;
    }
    const received = stream.received.get(message.stream);
    if (message.offset !== received) {
      this.failStreamingReply(message.id, entry, "received a chunk at an invalid offset");
      return;
    }
    if (received + itemCount > descriptor.length) {
      this.failStreamingReply(message.id, entry, "received more records than declared");
      return;
    }
    try {
      if (!descriptor.initialized) {
        const initialized = initializeReplyStream(stream.result, descriptor);
        if (!initialized.initialized) {
          throw new Error(`git-host stream target ${descriptor.name} is missing`);
        }
        stream.result = initialized.result;
        descriptor.initialized = true;
      }
      stream.result = appendReplyChunk(stream.result, descriptor, message.offset, message.items);
    } catch (error) {
      this.failStreamingReply(message.id, entry, error);
      return;
    }
    stream.received.set(message.stream, received + itemCount);
    stream.nextSequence++;
    stream.awaitingAck = true;
  }

  scheduleChunkAck(sourceChild, id, sequence, beforeSend = null) {
    setImmediate(() => {
      beforeSend?.();
      // A cancelled request still ACKs the chunk that was already in the pipe,
      // releasing the worker's global chunk lane. A retired worker never gets
      // an ACK intended for its replacement (or vice versa).
      if (!sourceChild || this.child !== sourceChild || sourceChild.connected === false) return;
      try {
        sourceChild.send({ event: GitHostMessageEvents.CHUNK_ACK, id, sequence });
      } catch {
        this.handleExit(sourceChild, { kill: true });
      }
    });
  }

  finishStreamingReply(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    const stream = entry.stream;
    if (!stream || stream.awaitingAck || stream.completionScheduled) {
      this.failStreamingReply(message.id, entry, "received reply-end at an invalid time");
      return;
    }
    for (const [name, descriptor] of stream.descriptors) {
      if (stream.received.get(name) !== descriptor.length) {
        this.failStreamingReply(message.id, entry, `reply-end omitted records from ${name}`);
        return;
      }
    }
    stream.completionScheduled = true;

    const id = message.id;
    // Keep the final chunk's IPC turn separate from the first consumer work
    // (notably GitRepository snapshot indexing/freezing).
    setImmediate(() => {
      const current = this.pending.get(id);
      if (current !== entry || this.child !== entry.child || current.stream !== stream) return;
      this.pending.delete(id);
      this.detachAbort(entry);
      const result = stream.result;
      entry.stream = null;
      entry.resolve(result);
    });
  }

  failStreamingReply(id, entry, detail) {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    this.detachAbort(entry);
    entry.stream = null;
    this.sendCancel(id, entry.child);
    const error =
      detail instanceof Error && detail.code
        ? detail
        : protocolError(detail instanceof Error ? detail.message : detail, entry.operation);
    if (!error.operation) error.operation = entry.operation;
    entry.reject(error);
    // A malformed chunk may carry the wrong sequence, so an ACK cannot safely
    // release the worker's pending send. Retire that worker instead of leaving
    // its global chunk lane wedged for every later large response.
    if (entry.child === this.child) this.terminate();
  }

  handleExit(sourceChild = this.child, { kill = false } = {}) {
    if (sourceChild !== this.child) return;
    // Reject a start that never reached readiness, then fail every pending
    // request with a retriable error and drop state so the next request forks a
    // fresh worker. Background refreshes already swallow rejections; while the
    // window unloads nothing is settled at all (see isUnloading).
    if (!isUnloading() && !this.fatalError) this.rejectReady?.(restartError());
    this.resolveReady = null;
    this.rejectReady = null;

    this.clearPending();

    if (this.child) {
      this.child.removeAllListeners();
      this.child.stdout?.removeAllListeners();
      this.child.stderr?.removeAllListeners();
      if (kill) {
        try {
          this.child.kill();
        } catch {
          // The process may already have completed between error and cleanup.
        }
      }
      this.child = null;
    }
    if (!this.fatalError) this.readyPromise = null;
  }

  // Drop every pending request, failing it as retriable so the caller can retry
  // against the next worker — unless the window is unloading, where the request
  // is abandoned instead (see isUnloading).
  clearPending() {
    const abandon = isUnloading();
    for (const entry of this.pending.values()) {
      this.detachAbort(entry);
      entry.stream = null;
      this.clearOutboundStream(entry);
      if (!abandon) entry.reject(restartError());
    }
    this.pending.clear();
  }

  detachAbort(entry) {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
  }

  async withRequestChunkLane(callback) {
    const previous = this.requestChunkLane;
    let release;
    this.requestChunkLane = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  assertActiveOutboundRequest(id, entry, stream) {
    if (
      this.pending.get(id) !== entry ||
      entry.outboundStream !== stream ||
      this.child !== entry.child ||
      entry.child?.connected === false
    ) {
      throw abortError();
    }
  }

  sendRequestMessage(entry, message, onError = null) {
    this.assertActiveOutboundRequest(message.id, entry, entry.outboundStream);
    try {
      entry.child.send(message, (error) => {
        if (error) onError?.(error);
      });
      return true;
    } catch (error) {
      if (!onError) throw error;
      onError(error);
      return false;
    }
  }

  clearOutboundStream(entry, error = abortError()) {
    const stream = entry.outboundStream;
    if (!stream) return;
    stream.pendingAck?.reject(error);
    stream.pendingAck = null;
    if (stream.plan) {
      for (const descriptor of stream.plan.streams) descriptor.value = null;
      stream.plan = null;
    }
    entry.outboundStream = null;
  }

  async sendStreamingRequest(id, op, plan, entry) {
    const streamState = entry.outboundStream;
    await this.withRequestChunkLane(async () => {
      this.assertActiveOutboundRequest(id, entry, streamState);
      await new Promise((resolve) => setImmediate(resolve));
      this.assertActiveOutboundRequest(id, entry, streamState);
      if (
        !this.sendRequestMessage(
          entry,
          {
            event: GitHostMessageEvents.REQUEST_START,
            id,
            op,
            payload: plan.payload,
            streams: plan.streams.map(streamManifest),
          },
          () => this.handleExit(entry.child, { kill: true }),
        )
      ) {
        return;
      }

      let sequence = 0;
      for (const stream of plan.streams) {
        for (let offset = 0; offset < stream.length;) {
          // A complete renderer turn between bounded chunks gives Chromium a
          // chance to paint and keeps several concurrent large requests from
          // serializing in one frame.
          await new Promise((resolve) => setImmediate(resolve));
          this.assertActiveOutboundRequest(id, entry, streamState);
          const chunk = nextReplyChunk(stream, offset);
          const acknowledged = new Promise((resolve, reject) => {
            streamState.pendingAck = { sequence, resolve, reject };
          });
          this.sendRequestMessage(
            entry,
            {
              event: GitHostMessageEvents.REQUEST_CHUNK,
              id,
              sequence,
              stream: stream.name,
              offset,
              items: chunk,
            },
            () => this.handleExit(entry.child, { kill: true }),
          );
          await acknowledged;
          offset += chunk.length;
          sequence++;
        }
      }

      await new Promise((resolve) => setImmediate(resolve));
      this.assertActiveOutboundRequest(id, entry, streamState);
      if (
        !this.sendRequestMessage(entry, { event: GitHostMessageEvents.REQUEST_END, id }, () =>
          this.handleExit(entry.child, { kill: true }),
        )
      ) {
        return;
      }
      this.clearOutboundStream(entry, null);
    });
  }

  acknowledgeRequestChunk(message, sourceChild = this.child) {
    const entry = this.pending.get(message.id);
    if (!entry || entry.child !== sourceChild) return;
    const stream = entry.outboundStream;
    if (
      !stream ||
      !stream.pendingAck ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence !== stream.pendingAck.sequence
    ) {
      this.failOutboundRequest(message.id, entry, "received an invalid request chunk ACK");
      return;
    }
    const { resolve } = stream.pendingAck;
    stream.pendingAck = null;
    resolve();
  }

  failOutboundRequest(id, entry, detail) {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    this.detachAbort(entry);
    this.clearOutboundStream(entry);
    this.sendCancel(id, entry.child);
    const error =
      detail instanceof Error && detail.code
        ? detail
        : protocolError(detail instanceof Error ? detail.message : detail, entry.operation);
    if (!error.operation) error.operation = entry.operation;
    entry.reject(error);
    if (entry.child === this.child) this.terminate();
  }

  async request(op, payload, { signal } = {}) {
    assertKnownOperation(op);
    if (signal?.aborted) throw abortError();
    if (isUnloading()) return abandonedRequest();

    await this.ensureStarted();
    // AbortSignal does not replay an abort event to a listener attached after
    // it fired. Recheck after startup so cancellation during the ready
    // handshake cannot accidentally execute the operation.
    if (signal?.aborted) throw abortError();
    if (isUnloading()) return abandonedRequest();
    if (this.fatalError) throw this.fatalError;

    // In-process mode (spec harness): run the op directly, translating the
    // caller's AbortSignal to a local controller so cancellation still works.
    if (this.inProcessOps) {
      const run = this.inProcessOps[op];
      if (!run) {
        const error = new Error(`Unknown git-host op: ${op}`);
        error.code = "ERR_GIT_HOST_UNKNOWN_OP";
        throw error;
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await run(payload, { signal: controller.signal });
      } catch (error) {
        throw normalizeGitOperationError(error);
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }

    // A crash during startup nulls the child; surface it as retriable.
    if (!this.child) throw restartError();

    let requestStream;
    try {
      requestStream = prepareRequestStream(op, payload);
    } catch (error) {
      if (!error.operation) error.operation = op;
      throw error;
    }

    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        onAbort: null,
        child: this.child,
        operation: op,
        stream: null,
        outboundStream: requestStream ? { pendingAck: null, plan: requestStream } : null,
      };
      if (signal) {
        entry.onAbort = () => {
          if (this.pending.get(id) !== entry) return;
          this.pending.delete(id);
          this.detachAbort(entry);
          entry.stream = null;
          this.clearOutboundStream(entry);
          reject(abortError());
          this.sendCancel(id, entry.child);
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      // Only an explicit `connected: false` means the channel closed; test
      // doubles without the property must keep the plain send path.
      if (this.child.connected === false) {
        // The channel closed before the exit handler ran; fail this request
        // (and any others) as retriable instead of throwing out of send.
        this.handleExit();
      } else {
        if (requestStream) {
          this.sendStreamingRequest(id, op, requestStream, entry).catch((error) => {
            if (error?.name === "AbortError" && this.pending.get(id) !== entry) return;
            this.failOutboundRequest(id, entry, error);
          });
        } else {
          try {
            this.child.send({ event: GitHostMessageEvents.REQUEST, id, op, payload });
          } catch {
            this.handleExit(this.child, { kill: true });
          }
        }
      }
    });
  }

  sendCancel(id, child = this.child) {
    if (child && child.connected !== false) {
      try {
        child.send({ event: GitHostMessageEvents.CANCEL, id });
      } catch {
        this.handleExit(child, { kill: true });
      }
    }
  }

  terminate() {
    // Requests waiting for the initial ready handshake are not in `pending`
    // yet. A settings-driven reset must settle them before dropping the
    // resolver; unload remains intentionally silent because its renderer is
    // disappearing.
    if (!isUnloading()) this.rejectReady?.(restartError());
    this.clearPending();

    if (this.child) {
      this.child.removeAllListeners();
      this.child.stdout?.removeAllListeners();
      this.child.stderr?.removeAllListeners();
      this.child.kill();
      this.child = null;
    }
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.inProcessOps = null;
    this.fatalError = null;
  }
}

module.exports = GitHost;
