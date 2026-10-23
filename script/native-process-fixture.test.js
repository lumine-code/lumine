"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const vm = require("node:vm");
const { runNativeFixture } = require("./native-process-fixture");

const node = (source, options) => runNativeFixture(process.execPath, ["-e", source], options);
const assertExited = (pid) => {
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
};

test("native fixture captures success and reports the actual close before resolving", async () => {
  const phases = [];
  const result = await node(
    'process.stdout.write("ready żółć"); process.stderr.write("diagnostic");',
    {
      timeout: 5000,
      label: "success probe",
      diagnostic: (message) => phases.push(message),
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "ready żółć");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.closed, true);
  assert.ok(result.elapsedMs >= 0);
  assertExited(result.pid);
  assert.equal(phases.length, 2);
  assert.match(phases[0], /success probe: started \(timeout 5000 ms\)/);
  assert.match(phases[1], /success probe: closed after \d+ ms \(exit 0/);
});

test("native fixture preserves a nonzero exit and its output for caller assertions", async () => {
  const result = await node(
    'process.stdout.write("out"); process.stderr.write("failure"); process.exitCode = 17;',
    {
      timeout: 5000,
    },
  );
  assert.equal(result.status, 17);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "failure");
  assertExited(result.pid);
});

test("native fixture rejects a spawn error only after its close event", async () => {
  const missing = path.join(
    os.tmpdir(),
    `lumine-missing-fixture-${process.pid}-${Date.now()}`,
    "missing.exe",
  );
  await assert.rejects(runNativeFixture(missing, [], { timeout: 5000 }), (error) => {
    assert.equal(error.code, "ENOENT");
    assert.equal(error.nativeFixture.closed, true);
    assert.equal(error.nativeFixture.pid, undefined);
    return true;
  });
});

test("native fixture timeout kills the exact child before callers can clean up", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-native-timeout-"));
  let stopped;
  try {
    await assert.rejects(node("setInterval(() => {}, 1000);", { timeout: 1000 }), (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.equal(error.nativeFixture.closed, true);
      stopped = error.nativeFixture.pid;
      assertExited(stopped);
      return true;
    });
  } finally {
    // This is the same ordering required before deleting a compiled executable.
    assertExited(stopped);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(directory), false);
});

test("native fixture abort kills and closes a child that has signalled readiness", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-native-abort-"));
  const ready = path.join(directory, "ready");
  const controller = new AbortController();
  const reason = new Error("fixture owner stopped");
  const pending = node(
    `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`,
    {
      timeout: 5000,
      signal: controller.signal,
    },
  );
  // Observe rejection immediately even if readiness itself fails.
  const settled = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await delay(20);
    assert.equal(fs.existsSync(ready), true, "The real child must be running before abort.");
    controller.abort(reason);
    const { error } = await settled;
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.cause, reason);
    assert.equal(error.nativeFixture.closed, true);
    assertExited(error.nativeFixture.pid);
  } finally {
    controller.abort(reason);
    await settled;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native fixture rejects an already aborted owner without spawning", async () => {
  const controller = new AbortController();
  const phases = [];
  controller.abort(new Error("already stopped"));
  await assert.rejects(
    runNativeFixture("must-not-spawn.exe", [], {
      timeout: 5000,
      signal: controller.signal,
      diagnostic: (message) => phases.push(message),
    }),
    (error) => {
      assert.equal(error.code, "ABORT_ERR");
      assert.equal(error.nativeFixture, undefined);
      return true;
    },
  );
  assert.deepEqual(phases, [], "No phase may claim a child was started.");
});

test("native fixture charges synchronous OS creation time to the same deadline", async () => {
  const source = fs.readFileSync(path.join(__dirname, "native-process-fixture.js"), "utf8");
  for (const creationMs of [600, 1600]) {
    let elapsed = 0,
      requestedDelay;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let kills = 0;
    child.kill = () => {
      kills++;
      return true;
    };
    const module = { exports: {} };
    // This clock/transport control exercises the unmodified helper source;
    // native success, error, timeout and abort paths above use real Node children.
    vm.runInNewContext(source, {
      module,
      require: (name) =>
        name === "node:child_process"
          ? {
              spawn: () => {
                elapsed = creationMs;
                queueMicrotask(() => child.emit("close", 0, null));
                return child;
              },
            }
          : name === "node:perf_hooks"
            ? { performance: { now: () => elapsed } }
            : require(name),
      Buffer,
      AbortSignal,
      setTimeout: (_callback, milliseconds) => {
        requestedDelay = milliseconds;
        return 1;
      },
      clearTimeout: () => {},
    });
    const action = module.exports.runNativeFixture("clock-control-only", [], { timeout: 1000 });
    if (creationMs < 1000) {
      const result = await action;
      assert.equal(result.status, 0);
      assert.equal(kills, 0);
    } else {
      await assert.rejects(action, (error) => {
        assert.equal(error.code, "ETIMEDOUT");
        assert.equal(error.nativeFixture.closed, true);
        assert.equal(error.nativeFixture.elapsedMs, creationMs);
        return true;
      });
      assert.equal(kills, 1, "An already expired creation must terminate its owned child.");
    }
    assert.equal(requestedDelay, Math.max(1, 1000 - creationMs));
  }
});

test("native fixture bounds captured output and closes the child before rejecting", async () => {
  await assert.rejects(
    node('process.stdout.write("x".repeat(65536)); setInterval(() => {}, 1000);', {
      timeout: 5000,
      maxBuffer: 32,
    }),
    (error) => {
      assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      assert.ok(
        Buffer.byteLength(error.nativeFixture.stdout) +
          Buffer.byteLength(error.nativeFixture.stderr) <=
          32,
      );
      assert.equal(error.nativeFixture.closed, true);
      assertExited(error.nativeFixture.pid);
      return true;
    },
  );
});

test("native fixture rejects unbounded budgets before spawning", async () => {
  for (const timeout of [0, -1, Infinity, NaN]) {
    await assert.rejects(
      runNativeFixture("must-not-spawn.exe", [], { timeout }),
      /finite positive timeout/,
    );
  }
  await assert.rejects(
    runNativeFixture("must-not-spawn.exe", [], { maxBuffer: Infinity }),
    /finite positive output limit/,
  );
});
