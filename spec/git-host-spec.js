const EventEmitter = require("events");
const GitHost = require("../src/git-host");
const { GIT_HOST_PROTOCOL_VERSION } = require("../src/git-host-protocol");

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
