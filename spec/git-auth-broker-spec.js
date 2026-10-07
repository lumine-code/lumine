const net = require("net");
const fs = require("fs");

const GitAuthBroker = require("../src/git-auth-broker");

// Connect to the broker's prompt socket the way a helper script does, send a
// JSON query, and resolve with the JSON reply (or reject if the socket closes
// without one).
async function requestPrompt(broker, query, { session } = {}) {
  const ownedSession = session ? null : await broker.createSession();
  session ||= ownedSession;
  query = { ...query, session: session.env.LUMINE_GIT_AUTH_SESSION };
  const address = broker.getAddress();
  const tcp = /^tcp:(\d+)$/.exec(address);
  const options = tcp
    ? { port: Number(tcp[1]), host: "127.0.0.1", allowHalfOpen: true }
    : { path: /^unix:(.+)$/.exec(address)[1], allowHalfOpen: true };

  try {
    return await new Promise((resolve, reject) => {
      const socket = net.connect(options, () => {
        let payload = "";
        socket.on("data", (chunk) => {
          payload += chunk;
        });
        socket.on("end", () => {
          try {
            resolve(JSON.parse(payload));
          } catch (error) {
            reject(error);
          }
        });
        socket.end(JSON.stringify(query), "utf8");
      });
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("close", () => reject(new Error("Credential connection closed")));
    });
  } finally {
    ownedSession?.dispose();
  }
}

describe("GitAuthBroker", () => {
  let broker;

  afterEach(async () => {
    if (broker) {
      await broker.terminate();
      broker = null;
    }
  });

  it("materializes askpass-only helper scripts and env, with no credential helper", async () => {
    broker = new GitAuthBroker();
    await broker.ensureStarted();

    for (const name of ["askpass.js", "askpass.sh", "ssh-wrapper.sh", "gpg-wrapper.sh"]) {
      expect(fs.existsSync(require("path").join(broker.tempDirectory, name))).toBe(true);
    }

    const { env, config } = broker.getEnvironment({ workingDirectory: "/repo" });
    expect(env.GIT_ASKPASS).toMatch(/askpass\.sh$/);
    expect(env.SSH_ASKPASS).toBe(env.GIT_ASKPASS);
    expect(env.LUMINE_GIT_AUTH_SOCK).toBe(broker.getAddress());
    // Storage is delegated to git's own helpers: the broker adds none.
    expect(config).toBeUndefined();
    expect(broker.getGpgConfig()["gpg.program"]).toMatch(/gpg-wrapper\.sh$/);
  });

  it("composes a signing environment that routes the passphrase through askpass", async () => {
    broker = new GitAuthBroker();
    await broker.ensureStarted();

    const { env, config } = broker.getSigningEnvironment({ workingDirectory: "/repo" });
    // The wrapper collects the passphrase with GIT_ASKPASS, so the askpass
    // environment must ride along with the gpg.program override.
    expect(env.GIT_ASKPASS).toMatch(/askpass\.sh$/);
    expect(env.LUMINE_GIT_AUTH_GPG_PROMPT).toBe("1");
    expect(config["gpg.program"]).toMatch(/gpg-wrapper\.sh$/);
  });

  it("answers a prompt with the value the handler produces", async () => {
    const prompts = [];
    broker = new GitAuthBroker({
      promptForInput: async (query) => {
        prompts.push(query);
        return { password: "hunter2" };
      },
    });
    await broker.ensureStarted();

    const reply = await requestPrompt(broker, { kind: "askpass", prompt: "Password:", pid: 123 });
    expect(reply.password).toBe("hunter2");
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt).toBe("Password:");
  });

  it("emits did-cancel with the helper pid when the handler rejects", async () => {
    broker = new GitAuthBroker({ promptForInput: () => Promise.reject(new Error("cancelled")) });
    await broker.ensureStarted();

    const cancelled = new Promise((resolve) => broker.onDidCancel((info) => resolve(info)));
    requestPrompt(broker, { prompt: "x", pid: 77 }).catch(() => {});

    expect((await cancelled).handlerPid).toBe(77);
  });

  it("removes the helper directory on terminate", async () => {
    broker = new GitAuthBroker();
    await broker.ensureStarted();
    const directory = broker.tempDirectory;
    expect(fs.existsSync(directory)).toBe(true);

    await broker.terminate();
    expect(fs.existsSync(directory)).toBe(false);
    broker = null;
  });

  it("rolls back failed startup and allows a clean retry", async () => {
    const failure = new Error("Cannot copy helper");
    const filesystem = {
      mkdtemp: jasmine
        .createSpy("create helper directory")
        .and.resolveTo("virtual-helper-directory"),
      copyFile: jasmine.createSpy("copy helper").and.rejectWith(failure),
      chmod: jasmine.createSpy("chmod helper").and.resolveTo(),
      rm: jasmine.createSpy("remove helper directory").and.resolveTo(),
    };
    broker = new GitAuthBroker({ filesystem });
    await expectAsync(broker.ensureStarted()).toBeRejectedWith(failure);
    expect(filesystem.rm).toHaveBeenCalledOnceWith("virtual-helper-directory", {
      recursive: true,
      force: true,
    });
    expect(broker.server).toBeNull();
    filesystem.copyFile.and.resolveTo();
    spyOn(broker, "listen").and.resolveTo({ address: () => ({ port: 1 }), listening: false });
    await broker.ensureStarted();
    expect(broker.getAddress()).toBe("tcp:1");
  });

  it("terminates a pending startup before publishing a socket", async () => {
    let completeDirectory;
    const filesystem = {
      mkdtemp: () =>
        new Promise((resolve) => {
          completeDirectory = resolve;
        }),
      rm: jasmine.createSpy("remove provisional directory").and.resolveTo(),
    };
    const createServer = jasmine.createSpy("create socket");
    broker = new GitAuthBroker({ filesystem, createServer });
    const starting = broker.ensureStarted().catch((error) => error);
    const stopped = broker.terminate();
    completeDirectory("provisional-helper-directory");
    expect((await starting).code).toBe("ABORT_ERR");
    await stopped;
    expect(createServer).not.toHaveBeenCalled();
    expect(filesystem.rm).toHaveBeenCalledOnceWith("provisional-helper-directory", {
      recursive: true,
      force: true,
    });
    await expectAsync(broker.ensureStarted()).toBeRejectedWith(
      jasmine.objectContaining({ code: "ABORT_ERR" }),
    );
  });

  it("rolls back a socket listen error", async () => {
    const failure = new Error("Socket unavailable");
    const server = new (require("events").EventEmitter)();
    server.listen = () => queueMicrotask(() => server.emit("error", failure));
    broker = new GitAuthBroker({ createServer: () => server });
    const remove = spyOn(broker.filesystem, "rm").and.callThrough();
    await expectAsync(broker.ensureStarted()).toBeRejectedWith(failure);
    expect(remove).toHaveBeenCalled();
    expect(broker.tempDirectory).toBeNull();
  });

  it("aborts the credential prompt when its operation is cancelled", async () => {
    let entered;
    const prompting = new Promise((resolve) => {
      entered = resolve;
    });
    let promptSignal;
    broker = new GitAuthBroker({
      promptForInput: (_query, { signal }) => {
        promptSignal = signal;
        entered();
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    const controller = new AbortController();
    const session = await broker.createSession({ signal: controller.signal });
    const request = requestPrompt(broker, { prompt: "Password:" }, { session }).catch(
      (error) => error,
    );
    await prompting;
    controller.abort();
    expect(await request).toEqual(jasmine.any(Error));
    expect(promptSignal.aborted).toBe(true);
    session.dispose();
    expect(broker.sessions.size).toBe(0);
  });

  it("terminates active prompts and rejects unknown sessions", async () => {
    let entered;
    const prompting = new Promise((resolve) => {
      entered = resolve;
    });
    const promptForInput = jasmine.createSpy("prompt").and.callFake((_query, { signal }) => {
      entered();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    broker = new GitAuthBroker({ promptForInput });
    const session = await broker.createSession();
    await expectAsync(
      requestPrompt(
        broker,
        { prompt: "Password:" },
        { session: { env: { LUMINE_GIT_AUTH_SESSION: "unknown" } } },
      ),
    ).toBeRejected();
    expect(promptForInput).not.toHaveBeenCalled();
    const request = requestPrompt(broker, { prompt: "Password:" }, { session }).catch(
      (error) => error,
    );
    await prompting;
    await broker.terminate();
    expect(await request).toEqual(jasmine.any(Error));
    expect(broker.connections.size).toBe(0);
    expect(broker.sessions.size).toBe(0);
  });
});
