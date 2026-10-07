const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { randomUUID } = require("crypto");
const { Emitter } = require("@lumine-code/event-kit");
const { resolveGitPath, which } = require("./git-binary");

// The auth broker gives the system git that runs in the git-host worker a way to
// prompt the user for credentials and SSH/GPG passphrases from the editor GUI —
// the piece system git cannot supply itself because it would prompt on a tty.
//
// It is deliberately forge-agnostic and askpass-only, exactly like VS Code:
// because Lumine runs the user's system git, git's own credential helpers (Git
// Credential Manager, osxkeychain, libsecret, cache, ssh-agent) already run and
// remain the source of truth for storage and retrieval. This broker adds no
// credential helper and no editor-owned store — it only installs GIT_ASKPASS /
// SSH_ASKPASS, which git falls back to for SSH passphrases and for HTTPS
// username/password when no helper provides them, and a GPG passphrase wrapper.
//
// The helper script (a short-lived process spawned by git in the worker's
// subtree) connects back to a local socket owned here in the renderer and
// exchanges a JSON prompt for a JSON answer that a dialog produced.

const SCRIPT_DIRECTORY = __dirname;
const HELPER_SCRIPTS = ["askpass.js", "askpass.sh", "ssh-wrapper.sh", "gpg-wrapper.sh"];
const MAX_PROMPT_BYTES = 64 * 1024;

function stoppedError() {
  const error = new Error("Git credential broker has been terminated");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function resolveAskpassShell() {
  if (process.platform !== "win32") return "sh";
  const onPath = which("sh");
  if (onPath) return onPath;
  const gitDirectory = path.dirname(
    resolveGitPath(globalThis.lumine?.config?.get?.("git.path") || ""),
  );
  for (const relativePath of ["sh.exe", "../bin/sh.exe", "../usr/bin/sh.exe"]) {
    const candidate = path.resolve(gitDirectory, relativePath);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // A minimal Git install may omit the shell; dialog fallback still works.
    }
  }
  return "sh";
}

// Git's bundled sh on Windows (MSYS) wants forward slashes in the paths it
// receives through the environment.
function toHelperPath(candidate) {
  return process.platform === "win32" ? String(candidate).replace(/\\/g, "/") : String(candidate);
}

class GitAuthBroker {
  constructor({ promptForInput, filesystem = fs, createServer = net.createServer } = {}) {
    this.promptForInput =
      promptForInput || (() => Promise.reject(new Error("No credential prompt handler is set")));
    this.emitter = new Emitter();
    this.startPromise = null;
    this.tempDirectory = null;
    this.server = null;
    this.address = null;
    this.filesystem = filesystem;
    this.createServer = createServer;
    this.terminated = false;
    this.terminationPromise = null;
    this.connections = new Map();
    this.sessions = new Map();
    this.shellPath = null;
  }

  setPromptHandler(promptForInput) {
    this.promptForInput = promptForInput;
  }

  onDidCancel(callback) {
    return this.emitter.on("did-cancel", callback);
  }

  // Start (once) the helper temp directory and the prompt socket.
  ensureStarted() {
    if (this.terminated) return Promise.reject(stoppedError());
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    return this.startPromise;
  }

  async start() {
    let directory, server;
    try {
      directory = await this.filesystem.mkdtemp(path.join(os.tmpdir(), "lumine-git-auth-"));
      if (this.terminated) throw stoppedError();
      // Wait for every copy before removing a failed startup's directory.
      const copies = await Promise.allSettled(
        HELPER_SCRIPTS.map(async (name) => {
          const destination = path.join(directory, name);
          await this.filesystem.copyFile(path.join(SCRIPT_DIRECTORY, name), destination);
          if (name.endsWith(".sh")) await this.filesystem.chmod(destination, 0o700);
        }),
      );
      const failure = copies.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      if (this.terminated) throw stoppedError();
      this.shellPath = await resolveAskpassShell();
      if (this.terminated) throw stoppedError();
      server = await this.listen(directory);
      if (this.terminated) throw stoppedError();
      this.tempDirectory = directory;
      this.server = server;
      this.address = server.address();
    } catch (error) {
      const cleanup = await Promise.allSettled([
        closeServer(server),
        directory ? this.filesystem.rm(directory, { recursive: true, force: true }) : undefined,
      ]);
      const failures = cleanup
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "Git credential broker startup and cleanup failed",
          { cause: error },
        );
      throw error;
    }
  }

  socketOptions(directory) {
    if (process.platform === "win32") {
      return { port: 0, host: "127.0.0.1" };
    }
    return { path: path.join(directory, "auth.sock") };
  }

  listen(directory) {
    return new Promise((resolve, reject) => {
      const server = this.createServer({ allowHalfOpen: true }, (connection) => {
        if (this.terminated) {
          connection.destroy();
          return;
        }
        const controller = new AbortController();
        this.connections.set(connection, controller);
        connection.setEncoding("utf8");
        let payload = "";
        connection.on("data", (chunk) => {
          payload += chunk;
          if (Buffer.byteLength(payload) > MAX_PROMPT_BYTES) connection.destroy();
        });
        connection.on(
          "end",
          () => void this.handleConnection(connection, payload, controller.signal),
        );
        connection.on("close", () => {
          this.connections.delete(connection);
          controller.abort(stoppedError());
        });
        connection.on("error", () => {});
      });
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(this.socketOptions(directory), () => {
        server.removeListener("error", onError);
        resolve(server);
      });
    });
  }

  async handleConnection(connection, payload, signal) {
    let query;
    let authenticated = false;
    try {
      query = JSON.parse(payload);
      const session = this.sessions.get(query.session);
      if (!session) throw new Error("Unknown Git credential session");
      authenticated = true;
      signal = AbortSignal.any([signal, session.controller.signal]);
      signal.throwIfAborted();
      const answer = await this.promptForInput(query, { signal });
      signal.throwIfAborted();
      await new Promise((resolve) => connection.end(JSON.stringify(answer), "utf8", resolve));
    } catch {
      connection.destroy();
      if (authenticated && !this.terminated) {
        try {
          this.emitter.emit(
            "did-cancel",
            query && query.pid ? { handlerPid: query.pid } : undefined,
          );
        } catch (error) {
          console.error("Unable to report Git credential cancellation", error);
        }
      }
    }
  }

  // The address the helper scripts connect to, encoded the way they parse it:
  // `tcp:<port>` on Windows, `unix:<path>` elsewhere.
  getAddress() {
    if (!this.address) throw new Error("Auth broker is not listening");
    if (this.address.port) return `tcp:${this.address.port}`;
    return `unix:${toHelperPath(this.address)}`;
  }

  scriptPath(name) {
    return toHelperPath(path.join(this.tempDirectory, name));
  }

  // The environment that routes a git subprocess's askpass prompts to this
  // broker. Merged into the operation's options so it reaches the worker's git
  // child; harmless for commands that never prompt.
  getEnvironment({ workingDirectory, electronPath = process.execPath }) {
    const env = {
      LUMINE_GIT_AUTH_SOCK: this.getAddress(),
      LUMINE_GIT_AUTH_ELECTRON: toHelperPath(electronPath),
      LUMINE_GIT_AUTH_ASKPASS_JS: this.scriptPath("askpass.js"),
      LUMINE_GIT_AUTH_WORKDIR: workingDirectory || "",
      LUMINE_GIT_AUTH_ORIGINAL_ASKPASS: process.env.GIT_ASKPASS || process.env.SSH_ASKPASS || "",
      LUMINE_GIT_AUTH_SHELL: this.shellPath || "sh",
      GIT_ASKPASS: this.scriptPath("askpass.sh"),
      SSH_ASKPASS: this.scriptPath("askpass.sh"),
    };

    if (process.platform === "linux") {
      env.LUMINE_GIT_AUTH_ORIGINAL_SSH_COMMAND = process.env.GIT_SSH_COMMAND || "";
      env.GIT_SSH_COMMAND = this.scriptPath("ssh-wrapper.sh");
    }
    // ssh only honors SSH_ASKPASS when it has no controlling tty and DISPLAY is
    // set; macOS launches with DISPLAY unset.
    if (!process.env.DISPLAY || process.env.DISPLAY.length === 0) {
      env.DISPLAY = "lumine-git-auth";
    }

    return { env };
  }

  // The git config that routes GPG signing passphrase prompts here (used only
  // for signed commit/merge operations).
  getGpgConfig() {
    return { "gpg.program": this.scriptPath("gpg-wrapper.sh") };
  }

  // The environment and config that route a GPG signing passphrase prompt
  // through this broker. The gpg wrapper collects the passphrase with
  // GIT_ASKPASS, so the full askpass environment is required alongside the
  // `gpg.program` override; LUMINE_GIT_AUTH_GPG_PROMPT enables the wrapper's
  // passphrase step. Used only for signed commit/merge operations.
  getSigningEnvironment({ workingDirectory, electronPath } = {}) {
    const { env } = this.getEnvironment({ workingDirectory, electronPath });
    return {
      env: { ...env, LUMINE_GIT_AUTH_GPG_PROMPT: "1" },
      config: this.getGpgConfig(),
    };
  }

  async createSession({ workingDirectory, signal, signing = false, electronPath } = {}) {
    signal?.throwIfAborted();
    await this.ensureStarted();
    signal?.throwIfAborted();
    if (this.terminated) throw stoppedError();
    const token = randomUUID();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const session = { controller, dispose: null };
    session.dispose = () => {
      if (!this.sessions.delete(token)) return;
      signal?.removeEventListener("abort", abort);
      controller.abort(stoppedError());
    };
    this.sessions.set(token, session);
    const environment = signing
      ? this.getSigningEnvironment({ workingDirectory, electronPath })
      : this.getEnvironment({ workingDirectory, electronPath });
    return {
      ...environment,
      env: { ...environment.env, LUMINE_GIT_AUTH_SESSION: token },
      dispose: session.dispose,
    };
  }

  terminate() {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminated = true;
    for (const session of this.sessions.values()) session.dispose();
    for (const [connection, controller] of this.connections) {
      controller.abort(stoppedError());
      connection.destroy();
    }
    this.connections.clear();
    this.terminationPromise = this.completeTermination();
    return this.terminationPromise;
  }

  async completeTermination() {
    // Startup owns provisional resources; let it roll them back before closing
    // the published server and directory. A terminated broker cannot restart.
    await this.startPromise?.catch(() => {});
    const results = await Promise.allSettled([
      closeServer(this.server),
      this.tempDirectory
        ? this.filesystem.rm(this.tempDirectory, { recursive: true, force: true })
        : undefined,
    ]);
    this.server = null;
    this.tempDirectory = null;
    this.address = null;
    this.startPromise = null;
    this.emitter.dispose();
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Git credential broker cleanup failed");
  }
}

module.exports = GitAuthBroker;
