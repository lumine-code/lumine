const { spawn } = require("child_process");
const fs = require("fs");

// Runs the system git binary via child_process for GitRunner. The exec contract
// keeps the rest of the git stack unchanged: `exec(args, workingDirectory,
// options)` resolves to `{exitCode, stdout, stderr}` and rejects with an
// `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`-coded error when stdout exceeds `maxBuffer`
// (GitRepository.getDiff maps that to ERR_GIT_DIFF_TOO_LARGE). Supported options:
// env, unsetEnv, stdin, encoding ("buffer" for a Buffer stdout), maxBuffer,
// signal, and killSignal.

const MAX_BUFFER_EXCEEDED_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

function abortError() {
  const error = new Error("The Git operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

async function pathIsMissing(filePath, { directory = false } = {}) {
  if (!filePath) return false;
  try {
    const stat = await fs.promises.stat(filePath);
    return directory && !stat.isDirectory();
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR";
  }
}

async function classifySpawnError(error, gitPath, workingDirectory) {
  if (error?.code !== "ENOENT") return error;

  if (await pathIsMissing(workingDirectory, { directory: true })) {
    error.code = "ERR_GIT_WORKING_DIRECTORY_NOT_FOUND";
    error.workingDirectory = workingDirectory;
    error.message = `Git working directory no longer exists: ${workingDirectory}`;
    return error;
  }

  // Node reports ENOENT for an absent command, a missing shebang interpreter,
  // and other failures to load the executable. Once cwd is known to exist,
  // all of them are actionable as an unusable Git executable; stat(gitPath)
  // cannot distinguish those cases.
  error.code = "ERR_GIT_EXECUTABLE_NOT_FOUND";
  error.gitPath = gitPath;
  error.message = `Git executable could not be started: ${gitPath || "git"}`;
  return error;
}

function childEnvironment(options) {
  if (!options.env && !options.unsetEnv) return process.env;

  const environment = { ...process.env };
  if (options.unsetEnv) {
    const canonicalName =
      process.platform === "win32" ? (name) => name.toUpperCase() : (name) => name;
    const namesToUnset = new Set(options.unsetEnv.map(canonicalName));
    for (const name of Object.keys(environment)) {
      if (namesToUnset.has(canonicalName(name))) delete environment[name];
    }
  }
  Object.assign(environment, options.env);
  return environment;
}

function createGitExec(gitPath) {
  return function exec(args, workingDirectory, options = {}) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const encoding = options.encoding === "buffer" ? "buffer" : "utf8";
      const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
      const killSignal = options.killSignal || "SIGTERM";

      let child;
      try {
        child = spawn(gitPath, args, {
          cwd: workingDirectory,
          env: childEnvironment(options),
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        classifySpawnError(error, gitPath, workingDirectory).then(reject, reject);
        return;
      }

      let settled = false;
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLength = 0;
      let stderrLength = 0;
      let maxBufferExceeded = false;
      let aborted = false;
      let terminating = false;
      let killTimer = null;

      const terminateTree = () => {
        if (terminating) return;
        terminating = true;
        if (process.platform === "win32" && child.pid) {
          try {
            const sweep = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            const finish = () => {
              try {
                child.kill(killSignal);
              } catch {
                /* already exited */
              }
            };
            sweep.once("close", finish);
            sweep.once("error", finish);
            return;
          } catch {
            /* fall back to the owned parent */
          }
        } else if (child.pid) {
          try {
            process.kill(-child.pid, killSignal);
            if (killSignal !== "SIGKILL") {
              killTimer = setTimeout(() => {
                if (settled) return;
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  /* group already gone */
                }
              }, 1000);
              killTimer.unref?.();
            }
            return;
          } catch {
            /* group already gone */
          }
        }
        child.kill(killSignal);
      };

      const onAbort = () => {
        aborted = true;
        terminateTree();
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
      };

      child.stdout.on("data", (chunk) => {
        stdoutLength += chunk.length;
        if (stdoutLength > maxBuffer) {
          maxBufferExceeded = true;
          terminateTree();
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrLength += chunk.length;
        if (stderrLength > maxBuffer) {
          maxBufferExceeded = true;
          terminateTree();
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (aborted) {
          reject(abortError());
          return;
        }
        classifySpawnError(error, gitPath, workingDirectory).then(reject, reject);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (aborted) {
          reject(abortError());
          return;
        }
        if (maxBufferExceeded) {
          const error = new Error(`git output exceeded the maxBuffer of ${maxBuffer} bytes`);
          error.code = MAX_BUFFER_EXCEEDED_CODE;
          reject(error);
          return;
        }
        const stdoutBuffer = Buffer.concat(stdoutChunks);
        resolve({
          exitCode: code == null ? 1 : code,
          stdout: encoding === "buffer" ? stdoutBuffer : stdoutBuffer.toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });

      // Feed stdin (commit messages, patches, `update-index --index-info`) then
      // close it. Ignore EPIPE if git exits before reading all of it.
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(options.stdin != null ? options.stdin : undefined);
      }
    });
  };
}

module.exports = { createGitExec };
