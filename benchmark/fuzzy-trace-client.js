const { setTimeout: delay } = require("node:timers/promises");

const CATEGORIES = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "blink.user_timing",
  "v8",
  "disabled-by-default-v8.gc",
];

// Connect only to the fresh Electron process whose loopback port the launcher owns.
async function connect(port, { timeoutMs = 30000, requestTimeoutMs = 60000 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new TypeError("A valid loopback debugging port is required");
  const deadline = Date.now() + timeoutMs;
  let target;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
      });
      if (!response.ok) throw new Error(`Target discovery returned HTTP ${response.status}`);
      const targets = await response.json();
      target = targets.find((candidate) => {
        if (candidate.type !== "page" || !candidate.webSocketDebuggerUrl) return false;
        try {
          return new URL(candidate.url).pathname.endsWith("/index.html");
        } catch {
          return false;
        }
      });
      if (target) break;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.max(1, Math.min(100, deadline - Date.now())));
  }
  if (!target) throw new Error("Timed out waiting for the Electron page", { cause: lastError });
  const endpoint = new URL(target.webSocketDebuggerUrl);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.port !== String(port)
  )
    throw new Error("The debugging target must use the launcher's loopback port");

  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let tracing = false;
  let events = [];
  let completeTrace = null;
  let stopPromise = null;

  function fail(error) {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    completeTrace?.reject(error);
    completeTrace = null;
  }

  socket.addEventListener("message", ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      fail(error);
      socket.close();
      return;
    }
    if (message.id != null) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        const error = new Error(`${request.method}: ${message.error.message}`);
        error.code = message.error.code;
        request.reject(error);
      } else request.resolve(message.result);
    } else if (message.method === "Tracing.dataCollected" && tracing) {
      // ReportEvents can deliver large batches; never spread them into push().
      for (const event of message.params.value) events.push(event);
    } else if (message.method === "Tracing.tracingComplete") {
      completeTrace?.resolve();
    }
  });
  socket.addEventListener("close", () => fail(new Error("The debugging connection closed")));
  socket.addEventListener("error", () => fail(new Error("The debugging connection failed")));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Timed out opening the debugging socket")),
      Math.max(1, deadline - Date.now()),
    );
    const opened = () => finish();
    const failed = () => finish(new Error("Unable to open the debugging socket"));
    function finish(error) {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      if (error) {
        socket.close();
        reject(error);
      } else resolve();
    }
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
  });

  function send(method, params = {}) {
    if (closed) return Promise.reject(new Error("The debugging connection is closed"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, requestTimeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    send,
    async evaluate(expression) {
      const response = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails)
        throw new Error(
          response.exceptionDetails.exception?.description || response.exceptionDetails.text,
        );
      return response.result.value;
    },
    async start({ cpuProfiler = false } = {}) {
      if (tracing) throw new Error("Tracing is already active");
      events = [];
      stopPromise = null;
      tracing = true;
      try {
        await send("Tracing.start", {
          categories: [
            ...CATEGORIES,
            ...(cpuProfiler ? ["disabled-by-default-v8.cpu_profiler"] : []),
          ].join(","),
          transferMode: "ReportEvents",
        });
      } catch (error) {
        tracing = false;
        events = [];
        throw error;
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      if (!tracing) return Promise.reject(new Error("Tracing is not active"));
      stopPromise = (async () => {
        let timer;
        const complete = new Promise((resolve, reject) => {
          completeTrace = { resolve, reject };
          timer = setTimeout(
            () => reject(new Error("Timed out completing the trace")),
            requestTimeoutMs,
          );
        });
        try {
          await Promise.all([send("Tracing.end"), complete]);
          const result = { traceEvents: events };
          events = [];
          return result;
        } finally {
          clearTimeout(timer);
          completeTrace = null;
          tracing = false;
        }
      })();
      return stopPromise;
    },
    close() {
      fail(new Error("The debugging client was closed"));
      events = [];
      socket.close();
    },
  };
}

module.exports = { connect };
