const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TreeSitterRuntime } = require("../../src/tree-sitter-runtime");
const {
  SyntaxResourcePolicy,
  SyntaxResourceLimitError,
} = require("../../src/syntax-resource-policy");

test("a cooperative resource stop leaves real WASM memory usable and the runtime healthy", () => {
  const runtime = new TreeSitterRuntime({ maximumPages: 8 });
  runtime.memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
  const events = [];
  runtime.onDidFail((failure) => events.push(failure));
  const slice = runtime.beginParseSlice({ session: 3, revision: 9, operation: "parse" });
  runtime.memory.grow(6);
  assert.equal(runtime.shouldStopParse(slice), true);
  assert.throws(
    () => runtime.endParseSlice(slice),
    (error) => {
      assert.ok(error instanceof SyntaxResourceLimitError);
      assert.equal(error.failure.code, "memory-pressure");
      assert.equal(error.failure.session, 3);
      assert.equal(error.failure.fatal, false);
      assert.equal(error.failure.allocatedMemoryBytes, 7 * 65536);
      return true;
    },
  );
  assert.equal(runtime.failure, null);
  assert.equal(events.length, 0);
  new Uint8Array(runtime.memory.buffer)[0] = 42;
  assert.equal(
    runtime.run({ operation: "inspect" }, () => new Uint8Array(runtime.memory.buffer)[0]),
    42,
  );
  assert.equal(runtime.resourceState().recycleRequested, true);
});

test("a hard WASM trap keeps its fatal diagnostic instead of being replaced by soft pressure", () => {
  const runtime = new TreeSitterRuntime({ maximumPages: 8 });
  runtime.memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
  const slice = runtime.beginParseSlice({ session: 1, revision: 2, operation: "parse" });
  const trap = new WebAssembly.RuntimeError("unreachable");
  runtime.run({ session: 1, revision: 2, operation: "parse" }, () => runtime.observe(trap));
  assert.equal(runtime.failure.code, "wasm-failure");
  assert.doesNotThrow(() => runtime.endParseSlice(slice));
  assert.equal(runtime.failure.message, "unreachable");
});

test("a fixed initial 32 MiB heap permits healthy parsing until the real allocation limit", () => {
  const runtime = new TreeSitterRuntime({ maximumPages: 512 });
  runtime.memory = new WebAssembly.Memory({ initial: 512, maximum: 512 });
  const slice = runtime.beginParseSlice({ session: 1, revision: 1 });
  assert.equal(runtime.shouldStopParse(slice), false);
  assert.doesNotThrow(() => runtime.endParseSlice(slice));
  assert.equal(runtime.resourceState().underMemoryPressure, false);
  assert.equal(runtime.resourceState().initialAllocatedMemoryBytes, 32 * 1024 * 1024);
});

test("resource accounting cannot mask an ordinary parser exception during cleanup", () => {
  const runtime = new TreeSitterRuntime({ maximumPages: 8 });
  runtime.memory = new WebAssembly.Memory({ initial: 7, maximum: 8 });
  const slice = runtime.beginParseSlice({ session: 1, revision: 2 });
  const error = new Error("grammar bug");
  assert.throws(
    () => {
      try {
        throw error;
      } finally {
        runtime.endParseSlice(slice, { throwOnLimit: false });
      }
    },
    (caught) => caught === error,
  );
  assert.equal(runtime.failure, null);
});

test("runtime diagnostics exclude asynchronous waiting and restore nested ownership", async () => {
  let time = 0;
  const now = () => time;
  const resources = new SyntaxResourcePolicy({ now });
  const runtime = new TreeSitterRuntime({ now, resourcePolicy: resources });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const result = runtime.run({ session: 1, operation: "analyze" }, async () => {
    time += 2;
    await gate;
    time += 3000;
  });
  assert.equal(runtime.context, null);
  release();
  await result;
  assert.deepEqual(runtime.resourceState().operations.analyze, {
    calls: 1,
    synchronousMs: 2,
    longestSynchronousMs: 2,
  });
});

test("parse budgets are recoverable resource errors rather than runtime poison", () => {
  let time = 0;
  const now = () => time;
  const resourcePolicy = new SyntaxResourcePolicy({ now, parseTimeLimitMs: 5 });
  const runtime = new TreeSitterRuntime({ now, resourcePolicy });
  const slice = runtime.beginParseSlice({ session: 1, revision: 1 });
  time = 5;
  assert.equal(runtime.shouldStopParse(slice), true);
  assert.throws(() => runtime.endParseSlice(slice), {
    name: "SyntaxResourceLimitError",
    code: "parse-budget",
  });
  assert.equal(runtime.failure, null);
  assert.equal(runtime.releaseSession(1), false);
  assert.equal(runtime.resourceState().trackedSessions, 0);
});
