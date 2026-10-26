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
