"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

async function runNativeFixture(command, args, options = {}) {
  const {
    timeout = 30000,
    signal,
    diagnostic,
    label = "Native fixture",
    maxBuffer = 1024 * 1024,
    ...spawnOptions
  } = options;
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0, "A finite positive timeout is required.");
  assert.ok(
    Number.isSafeInteger(maxBuffer) && maxBuffer > 0,
    "A finite positive output limit is required.",
  );
  assert.ok(diagnostic === undefined || typeof diagnostic === "function");
  assert.ok(signal === undefined || signal instanceof AbortSignal);
  assert.ok(
    !spawnOptions.shell && !spawnOptions.detached,
    "Run only the directly owned native child.",
  );
  const abortError = () =>
    Object.assign(new Error(`${label} aborted.`, { cause: signal?.reason }), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
  if (signal?.aborted) throw abortError();
  const started = performance.now();
  diagnostic?.(`${label}: started (timeout ${timeout} ms).`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        ...spawnOptions,
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [],
      stderr = [];
    let outputBytes = 0,
      failure;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      try {
        child.kill("SIGKILL");
      } catch (killError) {
        failure.killError = killError;
      }
    };
    const capture = (parts, bytes) => {
      const remaining = Math.max(0, maxBuffer - outputBytes);
      if (remaining) parts.push(bytes.subarray(0, remaining));
      outputBytes += bytes.length;
      if (outputBytes > maxBuffer) {
        stop(
          Object.assign(new Error(`${label} exceeded ${maxBuffer} output bytes.`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
      }
    };
    child.stdout.on("data", (bytes) => capture(stdout, bytes));
    child.stderr.on("data", (bytes) => capture(stderr, bytes));
    child.stdout.once("error", stop);
    child.stderr.once("error", stop);
    // A spawn error is followed by close too. Never let cleanup race that event.
    child.once("error", (error) => {
      failure ||= error;
    });
    const onAbort = () => stop(abortError());
    const onTimeout = () =>
      stop(
        Object.assign(new Error(`${label} timed out after ${timeout} ms.`), {
          code: "ETIMEDOUT",
        }),
      );
    const timer = setTimeout(
      onTimeout,
      // spawn itself enters the OS synchronously. Charge that time to this
      // deadline; JavaScript cannot interrupt the OS call before it returns.
      Math.max(1, timeout - (performance.now() - started)),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", (status, closedSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const result = {
        pid: child.pid,
        status,
        signal: closedSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: performance.now() - started,
        closed: true,
      };
      try {
        diagnostic?.(
          `${label}: closed after ${Math.ceil(result.elapsedMs)} ms (exit ${status}, signal ${closedSignal || "none"}${failure ? `, ${failure.code || failure.name}` : ""}).`,
        );
      } catch (error) {
        failure ||= error;
      }
      if (failure) {
        failure.nativeFixture = result;
        reject(failure);
      } else resolve(result);
    });
    // Abort may have arrived while spawn was creating the process.
    if (signal?.aborted) onAbort();
    else if (performance.now() - started >= timeout) onTimeout();
  });
}

module.exports = { runNativeFixture };
