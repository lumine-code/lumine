const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TreeSitterRuntime } = require("../../src/tree-sitter-runtime");

test("a yielded fatal operation keeps its owner without inheriting another pending document", async () => {
  const runtime = new TreeSitterRuntime();
  const events = [];
  runtime.onDidFail((failure) => events.push(failure));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = runtime.run({ session: 1, operation: "analyze" }, async () => {
    await gate;
    // Emscripten calls onAbort before throwing the RuntimeError. No owner is
    // active across this await; its rejection boundary must supply the owner.
    runtime.fail(new Error("Aborted"), true);
    throw new WebAssembly.RuntimeError("unreachable");
  });
  const second = runtime.run({ session: 2 }, async () => {
    await gate;
    runtime.assertHealthy();
  });
  release();
  await Promise.all([
    assert.rejects(first, WebAssembly.RuntimeError),
    assert.rejects(second, { name: "SyntaxUnavailableError" }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].session, 1);
  assert.equal(events[0].operation, "analyze");
  assert.throws(() => runtime.run({ session: 2 }, () => assert.fail("poisoned runtime reused")), {
    name: "SyntaxUnavailableError",
  });
});

test("an unobserved abort reports unknown ownership once on the next task", async () => {
  const runtime = new TreeSitterRuntime();
  const events = [];
  runtime.onDidFail((failure) => events.push(failure));
  runtime.fail(new Error("background abort"), true);
  await new Promise(setImmediate);
  runtime.fail(new Error("secondary abort"), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].session, undefined);
  assert.equal(events[0].message, "background abort");
});

test("ordinary exceptions and nested calls restore synchronous ownership", () => {
  const runtime = new TreeSitterRuntime();
  const outer = { session: 1 };
  runtime.run(outer, () => {
    assert.throws(
      () =>
        runtime.run({ session: 2 }, () => {
          throw new Error("package bug");
        }),
      /package bug/,
    );
    assert.equal(runtime.context, outer);
    assert.equal(runtime.failure, null);
  });
  assert.equal(runtime.context, null);
});
