const EventEmitter = require("events");
const Timers = require("timers");
const v8 = require("v8");
const GitHost = require("../src/git-host");
const { GIT_HOST_PROTOCOL_VERSION } = require("../src/git-host-protocol");
const { GIT_HOST_STREAM_MAX_BYTES } = require("../src/git-host-stream");

// A stand-in for the forked child process so the transport (id correlation,
// crash-restart, cancellation, error revival) can be driven deterministically
// without spawning a worker or running real git.
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.killed = false;
    this.stdout = null;
    this.stderr = null;
  }
  send(message) {
    this.sent.push(message);
  }
  kill() {
    this.killed = true;
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForSent(child, predicate) {
  for (let turn = 0; turn < 20; turn++) {
    const message = child.sent.find(predicate);
    if (message) return message;
    await nextImmediate();
  }
  throw new Error("Timed out waiting for a git-host test message");
}

describe("GitHost transport", () => {
  let host;
  let children;
  const current = () => children[children.length - 1];
  const ready = () =>
    current().emit("message", {
      event: "git:ready",
      protocolVersion: GIT_HOST_PROTOCOL_VERSION,
    });

  beforeEach(() => {
    GitHost.reset();
    children = [];
    GitHost.setForkModeForTesting(true);
    GitHost.setChildFactoryForTesting(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    host = GitHost.instance();
  });

  afterEach(() => {
    GitHost.setForkModeForTesting(null);
    GitHost.setChildFactoryForTesting(null);
    GitHost.reset();
  });

  it("forks lazily, awaits git:ready, and correlates a reply to its request", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    expect(children.length).toBe(1);

    ready();
    await flush();

    expect(current().sent.length).toBe(1);
    const sent = current().sent[0];
    expect(sent.event).toBe("git:request");
    expect(sent.op).toBe("snapshot");
    expect(sent.payload).toEqual({ descriptor: { gitDirectory: "/repo/.git" } });

    current().emit("message", { event: "git:reply", id: sent.id, result: "PORCELAIN" });
    expect(await pending).toBe("PORCELAIN");
  });

  it("streams large renderer requests with bounded chunks and worker backpressure", async () => {
    const text = `header\n${"x".repeat(GIT_HOST_STREAM_MAX_BYTES * 2 + 137)}`;
    const payload = {
      descriptor: { gitDirectory: "/repo/.git", workingDirectory: "/repo" },
      relativePosixPath: "large.txt",
      headOid: "a".repeat(40),
      text,
    };
    const pending = host.request("lineDiff", payload);
    ready();
    await flush();

    const start = await waitForSent(current(), ({ event }) => event === "git:request-start");
    expect(start.op).toBe("lineDiff");
    expect(start.payload.text).toBe("");
    expect(start.streams).toHaveSize(1);
    expect(start.streams[0]).toEqual(
      jasmine.objectContaining({
        name: "lineDiff.text",
        path: ["text"],
        kind: "string",
        length: text.length,
      }),
    );
    expect(current().sent.some(({ event }) => event === "git:request")).toBe(false);
    expect(payload.text).toBe(text);

    let received = 0;
    let sequence = 0;
    while (received < text.length) {
      const chunk = await waitForSent(
        current(),
        (message) => message.event === "git:request-chunk" && message.sequence === sequence,
      );
      expect(chunk.offset).toBe(received);
      expect(v8.serialize(chunk.items).byteLength).toBeLessThanOrEqual(GIT_HOST_STREAM_MAX_BYTES);
      expect(
        current().sent.some(
          (message) => message.event === "git:request-chunk" && message.sequence === sequence + 1,
        ),
      ).toBe(false);
      received += chunk.items.length;
      current().emit("message", {
        event: "git:request-chunk-ack",
        id: start.id,
        sequence,
      });
      sequence++;
    }
    await waitForSent(current(), ({ event }) => event === "git:request-end");
    expect(sequence).toBeGreaterThan(1);

    current().emit("message", { event: "git:reply", id: start.id, result: ["complete"] });
    expect(await pending).toEqual(["complete"]);
  });

  it("cancels and cleans up a partially streamed renderer request", async () => {
    const controller = new AbortController();
    const pending = host.request(
      "exec",
      {
        workingDirectory: "/repo",
        args: ["hash-object", "--stdin"],
        options: { stdin: Buffer.alloc(GIT_HOST_STREAM_MAX_BYTES * 2, 0xab) },
      },
      { signal: controller.signal },
    );
    ready();
    await flush();
    const start = await waitForSent(current(), ({ event }) => event === "git:request-start");
    await waitForSent(current(), ({ event }) => event === "git:request-chunk");

    controller.abort();
    await expectAsync(pending).toBeRejectedWithError(Error, /aborted/);
    expect(current().sent).toContain({ event: "git:cancel", id: start.id });
    await nextImmediate();
    expect(current().sent.some(({ event }) => event === "git:request-end")).toBe(false);
    expect(host.pending.size).toBe(0);
  });

  it("retires a worker that acknowledges an outbound request out of order", async () => {
    const pending = host.request("lineDiff", {
      text: "x".repeat(GIT_HOST_STREAM_MAX_BYTES),
    });
    ready();
    await flush();
    const start = await waitForSent(current(), ({ event }) => event === "git:request-start");
    await waitForSent(current(), ({ event }) => event === "git:request-chunk");

    current().emit("message", {
      event: "git:request-chunk-ack",
      id: start.id,
      sequence: 99,
    });

    await expectAsync(pending).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_HOST_PROTOCOL", retriable: false }),
    );
    expect(current().killed).toBe(true);
  });

  it("rejects instead of hanging when request-end fails asynchronously", async () => {
    const pending = host.request("lineDiff", {
      text: "x".repeat(Math.floor(GIT_HOST_STREAM_MAX_BYTES / 4)),
    });
    ready();
    await flush();
    const child = current();
    const start = await waitForSent(child, ({ event }) => event === "git:request-start");
    const chunk = await waitForSent(child, ({ event }) => event === "git:request-chunk");
    const send = child.send.bind(child);
    child.send = (message, callback) => {
      send(message);
      if (message.event === "git:request-end") {
        setImmediate(() => callback?.(new Error("request-end IPC failed")));
      }
    };
    child.emit("message", {
      event: "git:request-chunk-ack",
      id: start.id,
      sequence: chunk.sequence,
    });

    await expectAsync(pending).toBeRejectedWithError(/exited before the request completed/);
    expect(child.killed).toBe(true);
  });

  it("rejects reply-start received before request streaming completes", async () => {
    const pending = host.request("lineDiff", {
      text: "x".repeat(GIT_HOST_STREAM_MAX_BYTES),
    });
    ready();
    await flush();
    const start = await waitForSent(current(), ({ event }) => event === "git:request-start");

    current().emit("message", {
      event: "git:reply-start",
      id: start.id,
      result: [],
      streams: [{ name: "result", path: [], kind: "array", length: 1 }],
    });

    await expectAsync(pending).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_HOST_PROTOCOL", retriable: false }),
    );
    expect(current().killed).toBe(true);
  });

  it("revives a reply error with its code/exitCode/stderr", async () => {
    const pending = host.request("diff", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", {
      event: "git:reply",
      id,
      error: { message: "boom", code: "ERR_X", exitCode: 1, stderr: "bad" },
    });

    let error;
    try {
      await pending;
    } catch (e) {
      error = e;
    }
    expect(error.message).toBe("boom");
    expect(error.code).toBe("ERR_X");
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toBe("bad");
  });

  it("assembles chunked snapshots and applies backpressure between renderer turns", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();
    const { id } = current().sent[0];
    const result = {
      status: { fingerprint: "status", unchanged: false, value: { files: [] } },
      refs: {
        fingerprint: "refs",
        unchanged: false,
        value: { branches: [], remoteBranches: [], tags: [], remotes: [], worktrees: [] },
      },
    };

    current().emit("message", {
      event: "git:reply-start",
      id,
      result,
      streams: [
        {
          name: "status.files",
          path: ["status", "value", "files"],
          kind: "array",
          length: 2,
        },
        {
          name: "refs.branches",
          path: ["refs", "value", "branches"],
          kind: "array",
          length: 1,
        },
      ],
    });
    current().emit("message", {
      event: "git:reply-chunk",
      id,
      sequence: 0,
      stream: "status.files",
      offset: 0,
      items: [{ path: "a.txt" }, { path: "b.txt" }],
    });

    expect(current().sent.filter(({ event }) => event === "git:chunk-ack")).toEqual([]);
    await nextImmediate();
    expect(current().sent.filter(({ event }) => event === "git:chunk-ack")).toEqual([
      { event: "git:chunk-ack", id, sequence: 0 },
    ]);

    current().emit("message", {
      event: "git:reply-chunk",
      id,
      sequence: 1,
      stream: "refs.branches",
      offset: 0,
      items: [{ name: "main" }],
    });
    await nextImmediate();

    const settled = jasmine.createSpy("settled");
    pending.then(settled);
    current().emit("message", { event: "git:reply-end", id });
    await flush();
    expect(settled).not.toHaveBeenCalled();
    await nextImmediate();

    expect(await pending).toBe(result);
    expect(result.status.value.files).toEqual([{ path: "a.txt" }, { path: "b.txt" }]);
    expect(result.refs.value.branches).toEqual([{ name: "main" }]);
    expect(settled).toHaveBeenCalledWith(result);
  });

  it("drops a streamed accumulator but ACKs its in-pipe chunk after cancellation", async () => {
    const controller = new AbortController();
    const pending = host.request(
      "snapshot",
      { descriptor: { gitDirectory: "/repo/.git" } },
      { signal: controller.signal },
    );
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", {
      event: "git:reply-start",
      id,
      result: {
        status: { fingerprint: "status", unchanged: false, value: { files: [] } },
      },
      streams: [
        {
          name: "status.files",
          path: ["status", "value", "files"],
          kind: "array",
          length: 1,
        },
      ],
    });
    current().emit("message", {
      event: "git:reply-chunk",
      id,
      sequence: 0,
      stream: "status.files",
      offset: 0,
      items: [{ path: "late.txt" }],
    });

    controller.abort();
    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.name).toBe("AbortError");
    expect(current().sent).toContain({ event: "git:cancel", id });

    await nextImmediate();
    expect(current().sent).toContain({ event: "git:chunk-ack", id, sequence: 0 });
    current().emit("message", { event: "git:reply-end", id });
    expect(host.pending.size).toBe(0);
  });

  it("does not send a delayed stream ACK to a replacement worker after termination", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();
    const retiredChild = current();
    const { id } = retiredChild.sent[0];
    retiredChild.emit("message", {
      event: "git:reply-start",
      id,
      result: {
        status: { fingerprint: "status", unchanged: false, value: { files: [] } },
      },
      streams: [
        {
          name: "status.files",
          path: ["status", "value", "files"],
          kind: "array",
          length: 1,
        },
      ],
    });
    retiredChild.emit("message", {
      event: "git:reply-chunk",
      id,
      sequence: 0,
      stream: "status.files",
      offset: 0,
      items: [{ path: "retired.txt" }],
    });

    host.terminate();
    await expectAsync(pending).toBeRejected();
    const replacement = host.request("snapshot", {
      descriptor: { gitDirectory: "/replacement/.git" },
    });
    ready();
    await flush();
    await nextImmediate();
    expect(current().sent.filter(({ event }) => event === "git:chunk-ack")).toEqual([]);

    const replacementRequest = current().sent.find(({ event }) => event === "git:request");
    current().emit("message", {
      event: "git:reply",
      id: replacementRequest.id,
      result: "replacement",
    });
    expect(await replacement).toBe("replacement");
  });

  it("rejects an incomplete streamed reply as a protocol error", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", {
      event: "git:reply-start",
      id,
      result: {
        status: { fingerprint: "status", unchanged: false, value: { files: [] } },
      },
      streams: [
        {
          name: "status.files",
          path: ["status", "value", "files"],
          kind: "array",
          length: 2,
        },
      ],
    });
    current().emit("message", { event: "git:reply-end", id });

    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_HOST_PROTOCOL");
    expect(error.retriable).toBe(false);
    expect(current().sent).toContain({ event: "git:cancel", id });
  });

  it("rejects a nonempty stream skeleton", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", {
      event: "git:reply-start",
      id,
      result: {
        status: {
          fingerprint: "status",
          unchanged: false,
          value: { files: [{ path: "already-present.txt" }] },
        },
      },
      streams: [
        {
          name: "status.files",
          path: ["status", "value", "files"],
          kind: "array",
          length: 1,
        },
      ],
    });

    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_HOST_PROTOCOL");
  });

  it("retires the worker after a malformed stream chunk", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", {
      event: "git:reply-start",
      id,
      result: {
        status: { fingerprint: "status", unchanged: false, value: { files: [] } },
      },
      streams: [
        {
          name: "status.files",
          path: ["status", "value", "files"],
          kind: "array",
          length: 1,
        },
      ],
    });
    current().emit("message", {
      event: "git:reply-chunk",
      id,
      sequence: 0,
      stream: "status.files",
      offset: 1,
      items: [{ path: "wrong-offset.txt" }],
    });

    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_HOST_PROTOCOL");
    await nextImmediate();
    expect(children[0].sent).toContain({ event: "git:cancel", id });
    expect(children[0].killed).toBe(true);
    expect(children[0].sent).not.toContain({ event: "git:chunk-ack", id, sequence: 0 });
  });

  it("revives an exec GitOperationError with its command and stdout", async () => {
    const pending = host.request("exec", {
      workingDirectory: "/repo",
      args: ["checkout", "missing"],
    });
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", {
      event: "git:reply",
      id,
      error: {
        message: "Git checkout failed",
        name: "GitOperationError",
        code: "ERR_GIT_COMMAND_FAILED",
        command: "checkout",
        exitCode: 1,
        stdout: "partial",
        stderr: "bad ref",
      },
    });

    let error;
    try {
      await pending;
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe("GitOperationError");
    expect(error.command).toBe("checkout");
    expect(error.stdout).toBe("partial");
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toBe("bad ref");
  });

  it("rejects pending requests with a retriable error on crash and re-forks on the next request", async () => {
    const first = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();

    current().emit("exit");
    let error;
    try {
      await first;
    } catch (e) {
      error = e;
    }
    expect(error.code).toBe("ERR_GIT_HOST_RESTART");
    expect(error.retriable).toBe(true);

    const second = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    expect(children.length).toBe(2);
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", { event: "git:reply", id, result: "OK" });
    expect(await second).toBe("OK");
  });

  it("kills a still-live worker after an IPC error", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();
    const failedChild = current();

    failedChild.emit("error", new Error("IPC failed"));

    await expectAsync(pending).toBeRejectedWithError(/exited/);
    expect(failedChild.killed).toBe(true);
    const replacement = host.request("snapshot", {
      descriptor: { gitDirectory: "/replacement/.git" },
    });
    expect(children.length).toBe(2);
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", { event: "git:reply", id, result: "OK" });
    expect(await replacement).toBe("OK");
  });

  it("settles pending reads when a live worker disconnects without exiting", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    const failure = pending.catch((error) => error);
    ready();
    await flush();
    const disconnectedChild = current();

    disconnectedChild.connected = false;
    disconnectedChild.emit("disconnect");
    await flush();

    expect(host.pending.size).toBe(0);
    expect(disconnectedChild.killed).toBe(true);
    expect(host.child).toBeNull();
    host.terminate();
    expect(await failure).toEqual(
      jasmine.objectContaining({ code: "ERR_GIT_HOST_RESTART", retriable: true }),
    );

    const replacement = host.request("exec", { args: ["--version"] });
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", { event: "git:reply", id, result: "recovered" });
    expect(await replacement).toBe("recovered");
  });

  it("retires the worker when a plain request send fails asynchronously", async () => {
    const started = host.ensureStarted();
    ready();
    await started;
    const failedChild = current();
    failedChild.send = (message, callback) => {
      failedChild.sent.push(message);
      setImmediate(() => callback?.(new Error("IPC write failed")));
    };
    const failure = host.request("exec", { args: ["--version"] }).catch((error) => error);
    await nextImmediate();
    await nextImmediate();

    expect(host.pending.size).toBe(0);
    expect(failedChild.killed).toBe(true);
    host.terminate();
    expect(await failure).toEqual(
      jasmine.objectContaining({ code: "ERR_GIT_HOST_RESTART", retriable: true }),
    );
  });

  it("rejects other pending reads when a cancellation send fails asynchronously", async () => {
    const controller = new AbortController();
    const cancelled = host
      .request("snapshot", {}, { signal: controller.signal })
      .catch((error) => error);
    const other = host.request("exec", { args: ["--version"] }).catch((error) => error);
    ready();
    await flush();
    const failedChild = current();
    const send = failedChild.send.bind(failedChild);
    failedChild.send = (message, callback) => {
      send(message);
      if (message.event === "git:cancel") {
        setImmediate(() => callback?.(new Error("cancel IPC write failed")));
      }
    };

    controller.abort();
    await nextImmediate();
    await nextImmediate();

    expect((await cancelled).name).toBe("AbortError");
    expect(host.pending.size).toBe(0);
    expect(failedChild.killed).toBe(true);
    host.terminate();
    expect((await other).code).toBe("ERR_GIT_HOST_RESTART");
  });

  it("retires the worker when a streamed reply ACK fails asynchronously", async () => {
    const failure = host.request("readObjects", {}).catch((error) => error);
    ready();
    await flush();
    const failedChild = current();
    const { id } = failedChild.sent[0];
    const send = failedChild.send.bind(failedChild);
    failedChild.send = (message, callback) => {
      send(message);
      if (message.event === "git:chunk-ack") {
        setImmediate(() => callback?.(new Error("chunk ACK IPC write failed")));
      }
    };
    failedChild.emit("message", {
      event: "git:reply-start",
      id,
      result: [{ content: null }],
      streams: [
        {
          name: "readObjects.0.content",
          path: [0, "content"],
          kind: "buffer",
          length: 1,
        },
      ],
    });
    failedChild.emit("message", {
      event: "git:reply-chunk",
      id,
      sequence: 0,
      stream: "readObjects.0.content",
      offset: 0,
      items: Buffer.from("x"),
    });
    await nextImmediate();
    await nextImmediate();

    expect(host.pending.size).toBe(0);
    expect(failedChild.killed).toBe(true);
    host.terminate();
    expect((await failure).code).toBe("ERR_GIT_HOST_RESTART");
  });

  it("ignores a retired child's delayed send error after a replacement starts", async () => {
    const first = host.request("exec", { args: ["--version"] }).catch((error) => error);
    const retiredChild = current();
    let finishSend;
    retiredChild.send = (message, callback) => {
      retiredChild.sent.push(message);
      finishSend = callback;
    };
    ready();
    await flush();
    retiredChild.emit("exit");
    expect((await first).code).toBe("ERR_GIT_HOST_RESTART");

    const replacement = host.request("exec", { args: ["--version"] });
    ready();
    await flush();
    finishSend?.(new Error("late IPC write failure"));

    expect(host.child).toBe(current());
    expect(current().killed).toBe(false);
    expect(host.pending.size).toBe(1);
    const { id } = current().sent[0];
    current().emit("message", { event: "git:reply", id, result: "still running" });
    expect(await replacement).toBe("still running");
  });

  it("retries startup after a synchronous fork failure", async () => {
    const forkFailure = Object.assign(new Error("temporary process limit"), { code: "EAGAIN" });
    GitHost.setChildFactoryForTesting(() => {
      throw forkFailure;
    });
    await expectAsync(host.request("exec", { args: ["--version"] })).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_HOST_RESTART", retriable: true }),
    );
    expect(host.readyPromise).toBeNull();

    GitHost.setChildFactoryForTesting(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const recovered = host.request("exec", { args: ["--version"] });
    await flush();
    expect(children).toHaveSize(1);
    if (children.length === 0) {
      await recovered.catch(() => {});
      return;
    }
    ready();
    await flush();
    const { id } = current().sent[0];
    current().emit("message", { event: "git:reply", id, result: "recovered" });
    expect(await recovered).toBe("recovered");
  });

  it("rejects a request when reset interrupts the ready handshake", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    expect(children.length).toBe(1);

    host.terminate();

    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_HOST_RESTART");
    expect(error.retriable).toBe(true);
    expect(current().killed).toBe(true);
  });

  it("never sends a resumed old request to a replacement worker before readiness", async () => {
    const failure = host.request("exec", { args: ["old"] }).catch((error) => error);
    ready();
    host.terminate();
    const replacement = host.request("exec", { args: ["new"] });
    await flush();

    expect(children).toHaveSize(2);
    expect(current().sent).toEqual([]);
    expect(host.pending.size).toBe(0);
    ready();
    await flush();
    // Reply to anything the broken transport sent so a failed regression can
    // finish without leaving either request or the Jasmine harness hanging.
    for (const { id, payload } of current().sent) {
      current().emit("message", { event: "git:reply", id, result: payload.args[0] });
    }
    expect((await failure).code).toBe("ERR_GIT_HOST_RESTART");
    expect(await replacement).toBe("new");
  });

  it("bounds a never-ready worker and allows the next request to recover", async () => {
    const timers = [];
    spyOn(Timers, "setTimeout").and.callFake((callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    });
    const clearTimeout = spyOn(Timers, "clearTimeout");
    const failure = host.request("exec", { args: ["old"] }).catch((error) => error);
    const stalledChild = current();

    expect(timers).toHaveSize(1);
    expect(timers[0].delay).toBe(30_000);
    timers[0].callback();
    const error = await failure;
    expect(error.code).toBe("ERR_GIT_HOST_RESTART");
    expect(error.retriable).toBe(true);
    expect(stalledChild.killed).toBe(true);
    expect(host.readyPromise).toBeNull();
    expect(host.startupTimeout).toBeNull();
    expect(clearTimeout).toHaveBeenCalledWith(timers[0]);

    const replacement = host.request("exec", { args: ["new"] });
    ready();
    await flush();
    // Even a previously queued timeout callback belongs to its old worker.
    timers[0].callback();
    expect(current().killed).toBe(false);
    const { id } = current().sent[0];
    current().emit("message", { event: "git:reply", id, result: "recovered" });
    expect(await replacement).toBe("recovered");
  });

  it("clears the startup deadline on readiness, exit and reset", async () => {
    const timers = [];
    spyOn(Timers, "setTimeout").and.callFake((callback) => {
      const timer = { callback };
      timers.push(timer);
      return timer;
    });
    const clearTimeout = spyOn(Timers, "clearTimeout");
    let started = host.ensureStarted();
    ready();
    await started;
    expect(clearTimeout).toHaveBeenCalledWith(timers[0]);
    expect(host.startupTimeout).toBeNull();

    host.terminate();
    started = host.ensureStarted().catch((error) => error);
    current().emit("exit");
    expect((await started).code).toBe("ERR_GIT_HOST_RESTART");
    expect(clearTimeout).toHaveBeenCalledWith(timers[1]);
    expect(host.startupTimeout).toBeNull();

    started = host.ensureStarted().catch((error) => error);
    host.terminate();
    expect((await started).code).toBe("ERR_GIT_HOST_RESTART");
    expect(clearTimeout).toHaveBeenCalledWith(timers[2]);
    expect(host.startupTimeout).toBeNull();
  });

  it("abandons requests instead of rejecting them while the window is unloading", async () => {
    // A reload tears the environment down without deactivating packages first,
    // so requests are still in flight when `unloadEditorWindow` resets the
    // host. Rejecting them there only lands as "Uncaught (in promise)" noise in
    // a context that is already gone.
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();

    const settled = jasmine.createSpy("settled");
    pending.then(settled, settled);

    lumine.unloading = true;
    try {
      host.terminate();
      await flush();
      expect(settled).not.toHaveBeenCalled();

      // A request started during unload is abandoned too, without forking.
      host
        .request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } })
        .then(settled, settled);
      await flush();
      expect(settled).not.toHaveBeenCalled();
      expect(children.length).toBe(1);
    } finally {
      lumine.unloading = false;
    }
  });

  it("abandons pending requests when the worker exits while the window is unloading", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    ready();
    await flush();

    const settled = jasmine.createSpy("settled");
    pending.then(settled, settled);

    lumine.unloading = true;
    try {
      current().emit("exit");
      await flush();
      expect(settled).not.toHaveBeenCalled();
    } finally {
      lumine.unloading = false;
    }
  });

  it("translates an AbortSignal into a cancel and rejects locally with AbortError", async () => {
    const controller = new AbortController();
    const pending = host.request(
      "blame",
      { workingDirectory: "/repo" },
      { signal: controller.signal },
    );
    ready();
    await flush();
    const request = current().sent[0];

    controller.abort();

    const cancel = current().sent.find((message) => message.event === "git:cancel");
    expect(cancel).toBeTruthy();
    expect(cancel.id).toBe(request.id);

    let error;
    try {
      await pending;
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe("AbortError");
  });

  it("does not dispatch a request aborted while the worker is starting", async () => {
    const controller = new AbortController();
    const pending = host.request(
      "blame",
      { descriptor: { gitDirectory: "/repo/.git" } },
      { signal: controller.signal },
    );

    controller.abort();
    ready();

    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.name).toBe("AbortError");
    expect(current().sent).toEqual([]);
  });

  it("cancels a read while the ready handshake remains stalled", async () => {
    const controller = new AbortController();
    const failure = host
      .request("snapshot", {}, { signal: controller.signal })
      .catch((error) => error);
    const settled = jasmine.createSpy("settled");
    failure.then(settled);

    controller.abort();
    await flush();

    expect(settled).toHaveBeenCalled();
    expect(host.pending.size).toBe(0);
    expect(current().sent).toEqual([]);
    ready();
    const error = await failure;
    expect(error.name).toBe("AbortError");
    expect(error.code).toBe("ABORT_ERR");
  });

  it("rejects a mismatched worker protocol before dispatching", async () => {
    const pending = host.request("exec", { workingDirectory: "/repo", args: ["status"] });
    current().emit("message", { event: "git:ready", protocolVersion: 999 });

    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_HOST_PROTOCOL");
    expect(error.retriable).toBe(false);
    expect(current().sent).toEqual([]);
    expect(current().killed).toBe(true);
  });

  it("rejects unknown protocol operations without starting a worker", async () => {
    await expectAsync(host.request("obsolete", {})).toBeRejectedWithError(
      Error,
      "Unknown git-host op: obsolete",
    );
    expect(children.length).toBe(0);
  });

  it("rejects immediately for an already-aborted signal without forking", async () => {
    const controller = new AbortController();
    controller.abort();
    let error;
    try {
      await host.request(
        "snapshot",
        { descriptor: { gitDirectory: "/repo/.git" } },
        { signal: controller.signal },
      );
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe("AbortError");
    expect(children.length).toBe(0);
  });
});
