const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  symbolicCode,
  recoverProgress,
  captureInputState,
  finalizeEvidence,
  stopApplication,
  createProtocolClient,
  protocolFailure,
  createStderrHints,
  connect,
} = require("./run-large-document-benchmark");

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "lumine-workflow-host-"));
  t.after(() => {
    const relative = path.relative(parent, fs.realpathSync(directory));
    assert(relative && !path.isAbsolute(relative) && !relative.startsWith(".."));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function report() {
  return {
    status: "failed",
    failure: { code: "BENCHMARK_PROTOCOL_CLOSED" },
    sources: [{ name: "core", revision: "abc", sourceSha256: "before" }],
  };
}
const locations = [{ directory: "unused", name: "core" }];
const sameSource = async () => ({ name: "core", revision: "abc", sourceSha256: "before" });

test("only explicitly warm workflows hash input before launch", async (t) => {
  const file = path.join(temporary(t), "input.txt");
  fs.writeFileSync(file, "alpha\r\n😀");
  const cold = await captureInputState(file);
  const warm = await captureInputState(file, true);
  assert.equal(cold.sha256, null);
  assert.equal(warm.sha256, createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  assert.equal(cold.stat.size, warm.stat.size);
});

test("truncated progress cannot replace the original crash status or leak path-bearing errors", (t) => {
  const file = path.join(temporary(t), "progress.json");
  fs.writeFileSync(file, '{"cases":[');
  const result = report();
  assert.doesNotThrow(() => recoverProgress(result, file));
  assert.deepEqual(result.failure, { code: "BENCHMARK_PROTOCOL_CLOSED" });
  assert.equal(result.status, "failed");
  assert.equal(result.measurements, undefined);
  assert.equal(result.progressReadFailure.code, "BENCHMARK_PROGRESS_UNREADABLE");
  assert.equal(JSON.stringify(result).includes(file), false);
  fs.writeFileSync(
    file,
    JSON.stringify({
      status: "running",
      cases: [{ name: "copy", status: "running", actions: [{ name: "select" }] }],
    }),
  );
  recoverProgress(result, file);
  assert.equal(result.measurements.cases[0].actions[0].name, "select");
});

test("failure finalization verifies raw bytes and sources even without renderer measurements", async (t) => {
  const file = path.join(temporary(t), "input.txt");
  fs.writeFileSync(file, "input");
  const before = await captureInputState(file, true);
  const result = report();
  await finalizeEvidence(
    result,
    { inputFile: file, inputBefore: before, sourceLocations: locations },
    sameSource,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.input.rawBytesUnchanged, true);
  assert.equal(result.input.statUnchanged, true);
  assert.equal(result.input.exactDecodedTextUnchanged, null);
  assert.equal(result.sourceStable, true);
  assert.equal(result.sourcesAfter.length, 1);
});

test("raw hashing detects same-size changes even when the timestamp is preserved", async (t) => {
  const file = path.join(temporary(t), "input.txt");
  fs.writeFileSync(file, "old");
  const time = new Date(1600000000000);
  fs.utimesSync(file, time, time);
  const before = await captureInputState(file, true);
  fs.writeFileSync(file, "new");
  fs.utimesSync(file, time, time);
  const result = report();
  await finalizeEvidence(
    result,
    { inputFile: file, inputBefore: before, sourceLocations: locations },
    sameSource,
  );
  assert.equal(result.input.statUnchanged, true);
  assert.equal(result.input.rawBytesUnchanged, false);
  assert.equal(result.failure.code, "BENCHMARK_PROTOCOL_CLOSED");
  assert(result.validationFailures.some((x) => x.code === "BENCHMARK_INPUT_CHANGED"));
  assert.equal(result.sourceStable, true);
});

test("missing input and changed sources both remain visible after a renderer failure", async (t) => {
  const file = path.join(temporary(t), "input.txt");
  fs.writeFileSync(file, "old");
  const before = await captureInputState(file, true);
  fs.unlinkSync(file);
  const result = report();
  await finalizeEvidence(
    result,
    { inputFile: file, inputBefore: before, sourceLocations: locations },
    async () => ({ name: "core", revision: "new", sourceSha256: "after" }),
  );
  assert.equal(result.input.verificationFailure.code, "ENOENT");
  assert.equal(result.input.rawBytesUnchanged, null);
  assert.equal(result.sourceStable, false);
  assert.equal(result.sourcesAfter[0].revision, "new");
  assert.equal(result.validationFailures.length, 2);
});

test("successful evidence checks decoded Unicode and mixed line endings without changing the file", async (t) => {
  const file = path.join(temporary(t), "input.txt");
  const text = "α\r\n😀\n";
  fs.writeFileSync(file, text);
  const before = await captureInputState(file, true);
  const result = {
    ...report(),
    status: "complete",
    failure: undefined,
    measurements: {
      settings: { encoding: "utf8" },
      input: {
        snapshotUtf16leSha256: createHash("sha256")
          .update(Buffer.from(text, "utf16le"))
          .digest("hex"),
      },
    },
  };
  await finalizeEvidence(
    result,
    { inputFile: file, inputBefore: before, sourceLocations: locations },
    sameSource,
  );
  assert.equal(result.status, "complete");
  assert.equal(result.input.rawBytesUnchanged, true);
  assert.equal(result.input.exactDecodedTextUnchanged, true);
});

test(
  "cleanup closes the socket and kills a hung application within independent short budgets",
  { timeout: 1000 },
  async () => {
    let exited = false,
      closed = false,
      killed;
    let release;
    const childExit = new Promise((resolve) => (release = resolve));
    const result = await stopApplication(
      {
        client: {
          evaluate: () => new Promise(() => {}),
          close() {
            closed = true;
          },
        },
        child: {
          kill(signal) {
            killed = signal;
            exited = true;
            release();
          },
        },
        childExit,
        isExited: () => exited,
      },
      { requestMs: 5, exitMs: 5, killMs: 5 },
    );
    assert.equal(closed, true);
    assert.equal(killed, "SIGKILL");
    assert.equal(result.closeAcknowledged, false);
    assert.equal(result.forced, true);
    assert.equal(result.exited, true);
  },
);

test(
  "cleanup records unsuccessful termination without waiting indefinitely",
  { timeout: 1000 },
  async () => {
    const result = await stopApplication(
      {
        child: {
          kill() {
            throw Object.assign(new Error("private/path"), { code: "EACCES" });
          },
        },
        childExit: new Promise(() => {}),
        isExited: () => false,
      },
      { requestMs: 5, exitMs: 5, killMs: 5 },
    );
    assert.equal(result.forced, true);
    assert.equal(result.exited, false);
    assert.equal(result.killFailure.code, "EACCES");
    assert.equal(
      symbolicCode({ code: "C:\\private\\file", message: "Failed at private file" }),
      "BENCHMARK_FAILED",
    );
  },
);

class ProtocolSocket extends EventTarget {
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  receive(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
}

test(
  "page crash immediately rejects every pending request and all future evaluation",
  { timeout: 1000 },
  async (t) => {
    const socket = new ProtocolSocket();
    const client = createProtocolClient(socket, { timeoutMs: 600000, targetId: "owned" });
    t.after(() => client.close());
    const first = client.evaluate("new Promise(()=>{})"),
      second = client.send("Profiler.enable");
    const rejected = Promise.all(
      [first, second].map((promise) =>
        assert.rejects(promise, { code: "BENCHMARK_RENDERER_CRASHED" }),
      ),
    );
    socket.receive({ method: "Inspector.targetCrashed", params: {} });
    await rejected;
    const count = socket.sent.length;
    await assert.rejects(client.evaluate("true"), { code: "BENCHMARK_RENDERER_CRASHED" });
    assert.equal(socket.sent.length, count);
    assert.deepEqual(client.getDiagnostics().failure, {
      code: "BENCHMARK_RENDERER_CRASHED",
      event: "Inspector.targetCrashed",
      reason: "CRASHED",
    });
  },
);

test(
  "browser target monitoring ignores unrelated crashes and interrupts the owned page",
  { timeout: 1000 },
  async (t) => {
    const pageSocket = new ProtocolSocket(),
      browserSocket = new ProtocolSocket();
    const page = createProtocolClient(pageSocket, { timeoutMs: 600000, targetId: "owned" });
    const browser = createProtocolClient(browserSocket, {
      timeoutMs: 600000,
      targetId: "owned",
      inspectorEvents: false,
      onFailure: (info) => page.abort(info),
    });
    t.after(() => {
      browser.close();
      page.close();
    });
    const pending = page.evaluate("new Promise(()=>{})");
    const rejected = assert.rejects(pending, { code: "BENCHMARK_RENDERER_CRASHED" });
    browserSocket.receive({
      method: "Target.targetCrashed",
      params: { targetId: "other", status: "crashed", errorCode: 9 },
    });
    assert.equal(page.getDiagnostics().failure, undefined);
    browserSocket.receive({
      method: "Target.targetCrashed",
      params: { targetId: "owned", status: "oom", errorCode: 9 },
    });
    await rejected;
    assert.equal(page.getDiagnostics().failure.reason, "OOM");
    assert.equal(page.getDiagnostics().failure.exitCode, 9);
  },
);

test(
  "detachment and target destruction have symbolic reasons without retaining protocol text",
  { timeout: 1000 },
  async (t) => {
    for (const message of [
      { method: "Inspector.detached", params: { reason: "private/user/path" } },
      { method: "Target.targetDestroyed", params: { targetId: "owned" } },
    ]) {
      const socket = new ProtocolSocket(),
        client = createProtocolClient(socket, { timeoutMs: 600000, targetId: "owned" });
      t.after(() => client.close());
      const expected = protocolFailure(message, "owned");
      const rejected = assert.rejects(client.evaluate("true"), { code: expected.code });
      socket.receive(message);
      await rejected;
      assert.equal(JSON.stringify(client.getDiagnostics()).includes("private/user/path"), false);
    }
  },
);

test(
  "late replies and target reload do not revive a crashed evaluation client",
  { timeout: 1000 },
  async (t) => {
    const socket = new ProtocolSocket(),
      client = createProtocolClient(socket, { timeoutMs: 600000, targetId: "owned" });
    t.after(() => client.close());
    const rejected = assert.rejects(client.evaluate("true"), {
      code: "BENCHMARK_RENDERER_CRASHED",
    });
    socket.receive({ method: "Inspector.targetCrashed", params: {} });
    socket.receive({ id: 1, result: { result: { value: true } } });
    socket.receive({ method: "Inspector.targetReloadedAfterCrash", params: {} });
    await rejected;
    await assert.rejects(client.evaluate("true"), { code: "BENCHMARK_RENDERER_CRASHED" });
  },
);

test(
  "normal shutdown rejects abandoned work without recording a renderer crash",
  { timeout: 1000 },
  async () => {
    const socket = new ProtocolSocket();
    let failures = 0;
    const client = createProtocolClient(socket, {
      timeoutMs: 600000,
      targetId: "owned",
      onFailure: () => failures++,
    });
    const pending = client.evaluate("true");
    const rejected = assert.rejects(pending, { code: "BENCHMARK_RENDERER_DETACHED" });
    client.beginShutdown();
    socket.receive({ method: "Inspector.detached", params: { reason: "target_closed" } });
    await rejected;
    client.close();
    assert.equal(client.getDiagnostics().failure, undefined);
    assert.equal(failures, 0);
  },
);

test("protocol response correlation survives ordinary events and does not disclose server errors", async (t) => {
  const socket = new ProtocolSocket(),
    client = createProtocolClient(socket, { timeoutMs: 1000, targetId: "owned" });
  t.after(() => client.close());
  const first = client.evaluate("42");
  socket.receive({ method: "Runtime.consoleAPICalled", params: {} });
  socket.receive({ id: 1, result: { result: { value: 42 } } });
  assert.equal(await first, 42);
  const rejected = assert.rejects(client.send("Unknown.method"), {
    message: "BENCHMARK_PROTOCOL_REQUEST_FAILED",
  });
  socket.receive({ id: 2, error: { code: -32601, message: "secret/path" } });
  await rejected;
  assert.equal(client.getDiagnostics().failure, undefined);
});

test(
  "malformed protocol frames reject pending evaluation instead of escaping the message handler",
  { timeout: 1000 },
  async (t) => {
    const socket = new ProtocolSocket(),
      client = createProtocolClient(socket, { timeoutMs: 600000, targetId: "owned" });
    t.after(() => client.close());
    const rejected = assert.rejects(client.evaluate("true"), {
      code: "BENCHMARK_PROTOCOL_INVALID_MESSAGE",
    });
    socket.dispatchEvent(new MessageEvent("message", { data: "not JSON private/path" }));
    await rejected;
    assert.equal(JSON.stringify(client.getDiagnostics()).includes("private/path"), false);
  },
);

test("stderr OOM hints are bounded symbolic diagnostics across chunk boundaries", () => {
  const hints = createStderrHints();
  hints.accept(Buffer.from("C:/private/user/file FATAL ERR"));
  hints.accept(
    Buffer.from("OR: Reached heap limit Allocation failed - JavaScript heap out of memory\n"),
  );
  hints.accept(Buffer.alloc(1024 * 1024, 120));
  hints.accept(Buffer.from("std::bad_alloc at private/path\n"));
  assert(hints.snapshot().includes("V8_HEAP_OUT_OF_MEMORY"));
  assert(hints.snapshot().includes("NATIVE_ALLOCATION_FAILURE"));
  assert(hints.snapshot().every((value) => /^[A-Z0-9_]+$/.test(value)));
  assert(hints.snapshot().length <= 3);
  assert.equal(JSON.stringify(hints.snapshot()).includes("private"), false);
});

function connectionFixture({ targetExists = true, inspectorResponds = true } = {}) {
  const page = new ProtocolSocket(),
    browser = new ProtocolSocket();
  for (const socket of [page, browser]) {
    const send = socket.send.bind(socket);
    socket.send = (text) => {
      send(text);
      const { id, method } = JSON.parse(text);
      if (method === "Inspector.enable" && inspectorResponds) socket.receive({ id, result: {} });
      if (method === "Target.setDiscoverTargets") socket.receive({ id, result: {} });
      if (method === "Target.getTargets")
        socket.receive({
          id,
          result: { targetInfos: [{ targetId: targetExists ? "owned" : "unrelated" }] },
        });
    };
  }
  return {
    page,
    browser,
    dependencies: {
      monitorTimeoutMs: 5,
      fetchImpl: async (url) => ({
        json: async () =>
          url.endsWith("/json/list")
            ? [
                {
                  id: "owned",
                  type: "page",
                  url: "file:///index.html",
                  webSocketDebuggerUrl: "page",
                },
              ]
            : { webSocketDebuggerUrl: "browser" },
      }),
      openSocket: async (url) => (url === "page" ? page : browser),
    },
  };
}

test(
  "an owned target destroyed before discovery is rejected before any long evaluation",
  { timeout: 1000 },
  async () => {
    const fixture = connectionFixture({ targetExists: false });
    await assert.rejects(connect(1, 600000, fixture.dependencies), (error) => {
      assert.equal(error.code, "BENCHMARK_RENDERER_DESTROYED");
      assert.equal(error.rendererDiagnostics.failure.reason, "MISSING_BEFORE_MONITOR_START");
      return true;
    });
    assert.equal(fixture.page.sent.length, 0);
  },
);

test(
  "a renderer already dead before event registration fails its short handshake",
  { timeout: 1000 },
  async () => {
    const fixture = connectionFixture({ inspectorResponds: false });
    await assert.rejects(connect(1, 600000, fixture.dependencies), {
      code: "BENCHMARK_RENDERER_UNAVAILABLE_DURING_MONITOR_START",
    });
    assert.deepEqual(
      fixture.page.sent.map((message) => message.method),
      ["Inspector.enable"],
    );
  },
);

test(
  "a fully armed connection uses both owned-target monitors and closes without reviving requests",
  { timeout: 1000 },
  async () => {
    const fixture = connectionFixture();
    const client = await connect(1, 600000, fixture.dependencies);
    assert.deepEqual(client.getDiagnostics().monitoring, { inspector: true, browserTargets: true });
    const rejected = assert.rejects(client.evaluate("new Promise(()=>{})"), {
      code: "BENCHMARK_RENDERER_DESTROYED",
    });
    fixture.browser.receive({ method: "Target.targetDestroyed", params: { targetId: "owned" } });
    await rejected;
    client.close();
    await assert.rejects(client.evaluate("true"), { code: "BENCHMARK_RENDERER_DESTROYED" });
  },
);
