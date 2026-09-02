const EventEmitter = require("events");
const GitHost = require("../src/git-host");

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

describe("GitHost transport", () => {
  let host;
  let children;
  const current = () => children[children.length - 1];

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
    const pending = host.request("status", { workingDirectory: "/repo", options: {} });
    expect(children.length).toBe(1);

    current().emit("message", { event: "git:ready" });
    await flush();

    expect(current().sent.length).toBe(1);
    const sent = current().sent[0];
    expect(sent.event).toBe("git:request");
    expect(sent.op).toBe("status");
    expect(sent.payload).toEqual({ workingDirectory: "/repo", options: {} });

    current().emit("message", { event: "git:reply", id: sent.id, result: "PORCELAIN" });
    expect(await pending).toBe("PORCELAIN");
  });

  it("revives a reply error with its code/exitCode/stderr", async () => {
    const pending = host.request("diffPatch", { workingDirectory: "/repo" });
    current().emit("message", { event: "git:ready" });
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

  it("preserves native libgit2 error metadata across IPC", async () => {
    const pending = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    current().emit("message", { event: "git:ready" });
    await flush();
    const { id } = current().sent[0];
    current().emit("message", {
      event: "git:reply",
      id,
      error: {
        message: "cannot read index",
        code: "ERR_GIT_NATIVE_SNAPSHOT",
        operation: "snapshot",
        libgit2Code: -1,
        libgit2Class: 10,
        libgit2Message: "index corrupt",
      },
    });

    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error.operation).toBe("snapshot");
    expect(error.libgit2Code).toBe(-1);
    expect(error.libgit2Class).toBe(10);
    expect(error.libgit2Message).toBe("index corrupt");
  });

  it("keeps native initialization failure non-retriable without re-forking", async () => {
    const first = host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    current().emit("message", {
      event: "git:init-error",
      error: {
        message: "wrong libgit2",
        code: "ERR_GIT_NATIVE_INIT",
        operation: "initialize",
        retriable: false,
      },
    });

    let firstError;
    try {
      await first;
    } catch (caught) {
      firstError = caught;
    }
    expect(firstError.code).toBe("ERR_GIT_NATIVE_INIT");
    expect(firstError.retriable).toBe(false);

    let secondError;
    try {
      await host.request("snapshot", { descriptor: { gitDirectory: "/repo/.git" } });
    } catch (caught) {
      secondError = caught;
    }
    expect(secondError).toBe(firstError);
    expect(children.length).toBe(1);
  });

  it("revives an exec GitOperationError with its command and stdout", async () => {
    const pending = host.request("exec", {
      workingDirectory: "/repo",
      args: ["checkout", "missing"],
    });
    current().emit("message", { event: "git:ready" });
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
    const first = host.request("status", { workingDirectory: "/repo", options: {} });
    current().emit("message", { event: "git:ready" });
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

    const second = host.request("status", { workingDirectory: "/repo", options: {} });
    expect(children.length).toBe(2);
    current().emit("message", { event: "git:ready" });
    await flush();
    const { id } = current().sent[0];
    current().emit("message", { event: "git:reply", id, result: "OK" });
    expect(await second).toBe("OK");
  });

  it("abandons requests instead of rejecting them while the window is unloading", async () => {
    // A reload tears the environment down without deactivating packages first,
    // so requests are still in flight when `unloadEditorWindow` resets the
    // host. Rejecting them there only lands as "Uncaught (in promise)" noise in
    // a context that is already gone.
    const pending = host.request("status", { workingDirectory: "/repo", options: {} });
    current().emit("message", { event: "git:ready" });
    await flush();

    const settled = jasmine.createSpy("settled");
    pending.then(settled, settled);

    lumine.unloading = true;
    try {
      host.terminate();
      await flush();
      expect(settled).not.toHaveBeenCalled();

      // A request started during unload is abandoned too, without forking.
      host.request("status", { workingDirectory: "/repo", options: {} }).then(settled, settled);
      await flush();
      expect(settled).not.toHaveBeenCalled();
      expect(children.length).toBe(1);
    } finally {
      lumine.unloading = false;
    }
  });

  it("abandons pending requests when the worker exits while the window is unloading", async () => {
    const pending = host.request("status", { workingDirectory: "/repo", options: {} });
    current().emit("message", { event: "git:ready" });
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
    current().emit("message", { event: "git:ready" });
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

  it("rejects immediately for an already-aborted signal without forking", async () => {
    const controller = new AbortController();
    controller.abort();
    let error;
    try {
      await host.request("status", { workingDirectory: "/repo" }, { signal: controller.signal });
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe("AbortError");
    expect(children.length).toBe(0);
  });
});
